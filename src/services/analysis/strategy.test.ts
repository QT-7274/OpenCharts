import { describe, expect, it } from "vitest";
import {
  TREND_PULLBACK_V1,
  buildIndicatorSnapshot,
  buildEntryPlan,
  evaluateHourlyConfirmation,
  evaluatePullback,
  evaluateStrategy,
  evaluateTrendGate,
  identifySupportResistance,
  updateEntryPlan,
} from "./strategy.ts";
import { BASE, MS } from "./fixtures.ts";
import type { MarketCandle, SpotInterval } from "../market-data/types.ts";

const QUANTITY_RULES = { minQty: 0.001, maxQty: 1_000_000, stepSize: 0.001 } as const;

function trendCandles(interval: SpotInterval, count: number, start: number, step: number): MarketCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = start + index * step;
    const openTimeMs = BASE + index * MS[interval];
    return {
      symbol: "BTCUSDT",
      interval,
      openTimeMs,
      closeTimeMs: openTimeMs + MS[interval] - 1,
      open: close,
      high: close + 2,
      low: close - 2,
      close,
      volume: 100,
      quoteVolume: close * 100,
      tradeCount: 10,
      isClosed: true,
      source: "rest",
    };
  });
}

function alignedTrendCandles(interval: SpotInterval, count: number, start: number, step: number): MarketCandle[] {
  const analysisTimeMs = BASE + 210 * MS["1d"] - 1;
  const latestOpen = Math.floor((analysisTimeMs + 1) / MS[interval]) * MS[interval] - MS[interval];
  const firstOpen = latestOpen - (count - 1) * MS[interval];
  return Array.from({ length: count }, (_, index) => {
    const close = start + index * step;
    const openTimeMs = firstOpen + index * MS[interval];
    return {
      symbol: "BTCUSDT",
      interval,
      openTimeMs,
      closeTimeMs: openTimeMs + MS[interval] - 1,
      open: close,
      high: close + 2,
      low: close - 2,
      close,
      volume: 100,
      quoteVolume: close * 100,
      tradeCount: 10,
      isClosed: true,
      source: "rest",
    };
  });
}

describe("trend-pullback-v1 indicator and trend gate", () => {
  it("crypto-ai-analysis.STRATEGY.12 crypto-ai-analysis.STRATEGY.12-1 exposes immutable versioned parameters", () => {
    expect(TREND_PULLBACK_V1).toEqual({
      version: "trend-pullback-v1",
      emaPeriods: { fast: 20, medium: 50, slow: 200 },
      atrPeriod: 14,
      rsiPeriod: 14,
      macd: { fast: 12, slow: 26, signal: 9 },
      volumeSmaPeriod: 20,
      dailyEmaSlopeLookback: 5,
      fourHourEmaSlopeLookback: 3,
    });
    expect(Object.isFrozen(TREND_PULLBACK_V1)).toBe(true);
    expect(Object.isFrozen(TREND_PULLBACK_V1.emaPeriods)).toBe(true);
    expect(Object.isFrozen(TREND_PULLBACK_V1.macd)).toBe(true);
  });

  it("crypto-ai-analysis.STRATEGY.2 crypto-ai-analysis.STRATEGY.3 calculates deterministic closed-candle indicators", () => {
    const snapshot = buildIndicatorSnapshot("1d", trendCandles("1d", 210, 100, 1));
    expect(snapshot).not.toBeNull();
    expect(snapshot).toMatchObject({
      interval: "1d",
      close: 309,
      atr14: 4,
      rsi14: 100,
      previousRsi14: 100,
      volumeSma20: 100,
    });
    expect(snapshot!.ema20).toBeCloseTo(299.5, 10);
    expect(snapshot!.ema50).toBeCloseTo(284.5, 10);
    expect(snapshot!.ema200).toBeCloseTo(209.5, 10);
    expect(snapshot!.ema20ThreeBarsAgo).toBeCloseTo(296.5, 10);
    expect(snapshot!.ema50FiveBarsAgo).toBeCloseTo(279.5, 10);
    expect(snapshot!.macdHistogram).toBeCloseTo(0, 10);
    expect(snapshot!.previousMacdHistogram).toBeCloseTo(0, 10);
  });

  it("crypto-ai-analysis.STRATEGY.2 crypto-ai-analysis.STRATEGY.3 crypto-ai-analysis.STRATEGY.4 qualifies only when both trend timeframes pass", () => {
    const daily = buildIndicatorSnapshot("1d", trendCandles("1d", 210, 100, 1));
    const fourHour = buildIndicatorSnapshot("4h", trendCandles("4h", 65, 100, 1));
    const hourly = buildIndicatorSnapshot("1h", trendCandles("1h", 50, 100, 1));
    expect(daily && fourHour && hourly).toBeTruthy();

    const qualified = evaluateTrendGate({ "1d": daily!, "4h": fourHour!, "1h": hourly! });
    expect(qualified.direction).toBe("bullish");
    expect(qualified.eligibleForPullback).toBe(true);
    expect(qualified.daily.conditions.every((condition) => condition.passed)).toBe(true);
    expect(qualified.fourHour.conditions.every((condition) => condition.passed)).toBe(true);

    const fallingDaily = buildIndicatorSnapshot("1d", trendCandles("1d", 210, 400, -1));
    const rejected = evaluateTrendGate({ "1d": fallingDaily!, "4h": fourHour!, "1h": hourly! });
    expect(rejected.direction).toBe("not-bullish");
    expect(rejected.eligibleForPullback).toBe(false);
    expect(rejected.daily.bullish).toBe(false);

    const fallingFourHour = buildIndicatorSnapshot("4h", trendCandles("4h", 65, 300, -1));
    const rejectedFourHour = evaluateTrendGate({ "1d": daily!, "4h": fallingFourHour!, "1h": hourly! });
    expect(rejectedFourHour.eligibleForPullback).toBe(false);
    expect(rejectedFourHour.fourHour.bullish).toBe(false);
  });

  it("crypto-ai-analysis.STRATEGY.8 crypto-ai-analysis.STRATEGY.9 crypto-ai-analysis.STRATEGY.13 crypto-ai-analysis.STRATEGY.18 exposes watch state and weighted evidence", () => {
    const dailyCandles = alignedTrendCandles("1d", 210, 100, 1);
    const fourHourCandles = alignedTrendCandles("4h", 65, 100, 1);
    const hourlyCandles = alignedTrendCandles("1h", 50, 100, 1);
    const daily = buildIndicatorSnapshot("1d", dailyCandles)!;
    const fourHour = buildIndicatorSnapshot("4h", fourHourCandles)!;
    const hourly = buildIndicatorSnapshot("1h", hourlyCandles)!;
    const trend = evaluateTrendGate({ "1d": daily, "4h": fourHour, "1h": hourly });

    const evaluation = evaluateStrategy({
      indicators: { "1d": daily, "4h": fourHour, "1h": hourly },
      trend,
      fourHourCandles,
      oneHourCandles: hourlyCandles,
      analysisTimeMs: BASE + 210 * MS["1d"] - 1,
      riskReward: null,
    });

    expect(evaluation.state).toBe("watch");
    expect(evaluation.avoidReason).toBeNull();
    expect(evaluation.score).toBeGreaterThanOrEqual(0);
    expect(evaluation.score).toBeLessThanOrEqual(100);
    expect(evaluation.scoreBreakdown.trendQuality).toBe(30);
    expect(evaluation.scoreBreakdown.volatilityAndFreshness).toBe(5);
    expect(evaluation.pullback.enteredZone).toBe(false);
  });

  it("crypto-ai-analysis.STRATEGY.11 crypto-ai-analysis.STRATEGY.11-1 applies trend failure before setup", () => {
    const dailyCandles = alignedTrendCandles("1d", 210, 400, -1);
    const fourHourCandles = alignedTrendCandles("4h", 65, 100, 1);
    const hourlyCandles = alignedTrendCandles("1h", 50, 100, 1);
    const daily = buildIndicatorSnapshot("1d", dailyCandles)!;
    const fourHour = buildIndicatorSnapshot("4h", fourHourCandles)!;
    const hourly = buildIndicatorSnapshot("1h", hourlyCandles)!;
    const trend = evaluateTrendGate({ "1d": daily, "4h": fourHour, "1h": hourly });
    const evaluation = evaluateStrategy({
      indicators: { "1d": daily, "4h": fourHour, "1h": hourly },
      trend,
      fourHourCandles,
      oneHourCandles: hourlyCandles,
      analysisTimeMs: BASE + 210 * MS["1d"] - 1,
      riskReward: null,
    });

    expect(evaluation.state).toBe("avoid");
    expect(evaluation.avoidReason).toBe("trend-not-qualified");
  });

  it("crypto-ai-analysis.STRATEGY.5 crypto-ai-analysis.STRATEGY.5-1 crypto-ai-analysis.STRATEGY.5-2 accepts a recent pullback only while its invalidation line holds", () => {
    const candles = alignedTrendCandles("4h", 65, 100, 1);
    const closes = [149, 147, 148, 150, 152, 154];
    for (let offset = 0; offset < closes.length; offset += 1) {
      const index = candles.length - closes.length + offset;
      const close = closes[offset]!;
      candles[index] = { ...candles[index]!, open: close - 1, high: close + 2, low: close - 3, close };
    }
    const snapshot = buildIndicatorSnapshot("4h", candles)!;
    const pullback = evaluatePullback(candles, snapshot);

    expect(pullback.enteredZone).toBe(true);
    expect(pullback.heldInvalidation).toBe(true);
    expect(pullback.valid).toBe(true);
    expect(pullback.touchIndex).toBeGreaterThanOrEqual(candles.length - 6);

    const invalidated = candles.map((candle, index) =>
      index === candles.length - 1 ? { ...candle, low: (snapshot.ema50 - 0.5 * snapshot.atr14) - 1 } : candle);
    expect(evaluatePullback(invalidated, buildIndicatorSnapshot("4h", invalidated)!).heldInvalidation).toBe(false);
  });

  it("crypto-ai-analysis.STRATEGY.6 crypto-ai-analysis.STRATEGY.7 requires closed-candle price confirmation and treats momentum extras as independent", () => {
    const candles = alignedTrendCandles("1h", 50, 100, 1);
    const closes = [145, 125, 118, 150];
    for (let offset = 0; offset < closes.length; offset += 1) {
      const index = candles.length - closes.length + offset;
      const close = closes[offset]!;
      candles[index] = { ...candles[index]!, open: close - 1, high: close + 2, low: close - 2, close };
    }
    const snapshot = buildIndicatorSnapshot("1h", candles)!;
    const confirmation = evaluateHourlyConfirmation(candles, snapshot);

    expect(confirmation.ema20Reclaim).toBe(true);
    expect(confirmation.breakoutAbovePriorThreeHigh).toBe(true);
    expect(confirmation.bothPriceTriggers).toBe(true);
    expect(confirmation.bullishCandle).toBe(true);
    expect(confirmation.rsiAtLeast50).toBe(true);
    expect(confirmation.rsiRising).toBe(true);
    expect(confirmation.passed).toBe(true);
  });

  it("crypto-ai-analysis.ENTRY_PLAN.1 crypto-ai-analysis.ENTRY_PLAN.1-1 crypto-ai-analysis.ENTRY_PLAN.1-2 confirms pivots after two bars and merges nearby zones", () => {
    const candles = Array.from({ length: 60 }, (_, index) => {
      const openTimeMs = BASE + index * MS["4h"];
      return {
        ...trendCandles("4h", 1, 100, 0)[0]!,
        openTimeMs,
        closeTimeMs: openTimeMs + MS["4h"] - 1,
        high: 102,
        low: 98,
      };
    });
    candles[18] = { ...candles[18]!, low: 90 };
    candles[24] = { ...candles[24]!, low: 90.5 };
    candles[38] = { ...candles[38]!, high: 110 };
    candles[44] = { ...candles[44]!, high: 110.4 };
    candles[57] = { ...candles[57]!, low: 80 };

    const levels = identifySupportResistance(candles, 100, 2);

    expect(levels.support).toEqual(expect.objectContaining({
      price: 90.25,
      touches: 2,
      lastTouchedAtMs: candles[24]!.openTimeMs,
    }));
    expect(levels.resistance).toEqual(expect.objectContaining({ price: 110.2, touches: 2 }));
    expect(levels.support?.price).not.toBe(80);

    const asOfBeforeConfirmation = identifySupportResistance(
      candles, 100, 2, candles[58]!.closeTimeMs,
    );
    expect(asOfBeforeConfirmation.support?.price).not.toBe(80);
  });

  it("crypto-ai-analysis.ENTRY_PLAN.2 crypto-ai-analysis.ENTRY_PLAN.3 crypto-ai-analysis.ENTRY_PLAN.4 crypto-ai-analysis.ENTRY_PLAN.4-1 crypto-ai-analysis.VALIDATION.6 delays plan activation until the next hourly candle", () => {
    const confirmationCloseTimeMs = BASE + 100 * MS["1h"];
    const result = buildEntryPlan({
      referencePrice: 100,
      ema20: 99,
      atr1h: 2,
      atr4h: 4,
      pullbackLow: 90,
      latestOneHourClose: 100,
      confirmationCloseTimeMs,
      analysisTimeMs: confirmationCloseTimeMs,
      currentPrice: 100.1,
      currentPriceObservedAtMs: confirmationCloseTimeMs,
      quoteServerTimeMs: confirmationCloseTimeMs,
      quantityRules: QUANTITY_RULES,
      nearestResistance: null,
      riskContext: { accountEquity: 100_000, availableQuoteBalance: 100_000 },
    });

    expect(result.failure).toBeNull();
    expect(result.plan).toMatchObject({
      referencePrice: 100,
      entryLower: 99.5,
      entryUpper: 100.2,
      structureStop: 89,
      volatilityStop: 97,
      stop: 89,
      riskPerUnit: 11,
      takeProfit1: 122,
      takeProfit2: 133,
      riskReward: 2,
      riskBudgetAmount: 1_000,
      suggestedQuantity: 89.285,
      suggestedNotional: expect.closeTo(8_946.357, 6),
      estimatedStopRisk: expect.closeTo(999.992, 6),
      validFromMs: confirmationCloseTimeMs + 1,
      expiresAtMs: confirmationCloseTimeMs + 3 * MS["1h"],
      status: "waiting-for-price",
    });
    expect(updateEntryPlan(result.plan!, {
      analysisTimeMs: result.plan!.validFromMs,
      dataComplete: true,
      trendQualified: true,
      pullbackValid: true,
      latestOneHourClose: 100,
      currentPrice: 100.1,
      currentPriceObservedAtMs: result.plan!.validFromMs,
      quoteServerTimeMs: result.plan!.validFromMs,
    })).toMatchObject({ status: "active", failure: null });
  });

  it("crypto-ai-analysis.ENTRY_PLAN.3-1 caps spot sizing at one percent of equity and available quote balance", () => {
    const confirmationCloseTimeMs = BASE + 100 * MS["1h"];
    const input = {
      referencePrice: 100,
      ema20: 99,
      atr1h: 2,
      atr4h: 4,
      pullbackLow: 90,
      latestOneHourClose: 100,
      confirmationCloseTimeMs,
      analysisTimeMs: confirmationCloseTimeMs,
      currentPrice: 100,
      currentPriceObservedAtMs: confirmationCloseTimeMs,
      quoteServerTimeMs: confirmationCloseTimeMs,
      quantityRules: QUANTITY_RULES,
      nearestResistance: null,
      riskContext: { accountEquity: 100_000, availableQuoteBalance: 50 },
    };
    const sized = buildEntryPlan(input);
    expect(sized.plan).toMatchObject({
      riskBudgetAmount: 1_000,
      suggestedQuantity: 0.499,
      suggestedNotional: expect.closeTo(49.9998, 6),
      estimatedStopRisk: expect.closeTo(5.5888, 6),
    });
    expect(sized.plan?.suggestedQuantity).toBeGreaterThanOrEqual(QUANTITY_RULES.minQty);
    expect(sized.plan?.suggestedQuantity! / QUANTITY_RULES.stepSize).toBeCloseTo(
      Math.floor(sized.plan!.suggestedQuantity / QUANTITY_RULES.stepSize), 8,
    );
    expect(sized.plan?.estimatedStopRisk).toBeLessThanOrEqual(1_000);
    expect(buildEntryPlan({
      ...input,
      riskContext: { ...input.riskContext, availableQuoteBalance: 0.05 },
      quantityRules: { ...QUANTITY_RULES, minQty: 0.01 },
    }).failure).toBe("quantity-below-minimum");
    expect(buildEntryPlan({
      ...input,
      riskContext: { ...input.riskContext, accountEquity: null },
    }).failure).toBe("risk-budget-unavailable");
  });

  it("crypto-ai-analysis.MARKET_DATA.7 rejects stale exchange quotes for entry plans", () => {
    const confirmationCloseTimeMs = BASE + 100 * MS["1h"];
    const result = buildEntryPlan({
      referencePrice: 100,
      ema20: 99,
      atr1h: 2,
      atr4h: 4,
      pullbackLow: 90,
      latestOneHourClose: 100,
      confirmationCloseTimeMs,
      analysisTimeMs: confirmationCloseTimeMs,
      currentPrice: 100,
      currentPriceObservedAtMs: confirmationCloseTimeMs,
      quoteServerTimeMs: confirmationCloseTimeMs + 30_001,
      quantityRules: QUANTITY_RULES,
      nearestResistance: null,
      riskContext: { accountEquity: 100_000, availableQuoteBalance: 100_000 },
    });

    expect(result).toEqual({ plan: null, failure: "spot-price-stale" });
  });

  it("crypto-ai-analysis.ENTRY_PLAN.2-1 crypto-ai-analysis.ENTRY_PLAN.5-1 waits above the entry range without cancelling the plan", () => {
    const confirmationCloseTimeMs = BASE + 100 * MS["1h"];
    const result = buildEntryPlan({
      referencePrice: 100,
      ema20: 99,
      atr1h: 2,
      atr4h: 4,
      pullbackLow: 90,
      latestOneHourClose: 100,
      confirmationCloseTimeMs,
      analysisTimeMs: confirmationCloseTimeMs,
      currentPrice: 101,
      currentPriceObservedAtMs: confirmationCloseTimeMs,
      quoteServerTimeMs: confirmationCloseTimeMs,
      quantityRules: QUANTITY_RULES,
      nearestResistance: null,
      riskContext: { accountEquity: 100_000, availableQuoteBalance: 100_000 },
    });

    expect(result.failure).toBeNull();
    expect(result.plan?.status).toBe("waiting-for-price");
    expect(result.plan?.expiresAtMs).toBe(confirmationCloseTimeMs + 3 * MS["1h"]);
  });

  it("crypto-ai-analysis.ENTRY_PLAN.3 crypto-ai-analysis.ENTRY_PLAN.4-1 rejects broken structure and resistance below TP1", () => {
    const confirmationCloseTimeMs = BASE + 100 * MS["1h"];
    const baseInput = {
      referencePrice: 100,
      ema20: 99,
      atr1h: 2,
      atr4h: 4,
      pullbackLow: 90,
      latestOneHourClose: 100,
      confirmationCloseTimeMs,
      analysisTimeMs: confirmationCloseTimeMs,
      currentPrice: 100,
      currentPriceObservedAtMs: confirmationCloseTimeMs,
      quoteServerTimeMs: confirmationCloseTimeMs,
      quantityRules: QUANTITY_RULES,
      nearestResistance: null,
      riskContext: { accountEquity: 100_000, availableQuoteBalance: 100_000 },
    };

    expect(buildEntryPlan({ ...baseInput, latestOneHourClose: 89 }).failure).toBe("structure-invalidated");
    expect(buildEntryPlan({
      ...baseInput,
      nearestResistance: {
        price: 110,
        lower: 109,
        upper: 111,
        touches: 2,
        lastTouchedAtMs: confirmationCloseTimeMs,
      },
    }).failure).toBe("resistance-before-tp1");

    const validResistance = buildEntryPlan({
      ...baseInput,
      nearestResistance: {
        price: 130,
        lower: 129,
        upper: 131,
        touches: 1,
        lastTouchedAtMs: confirmationCloseTimeMs,
      },
    });
    expect(validResistance.plan?.takeProfit2).toBe(130);
  });

  it("crypto-ai-analysis.ENTRY_PLAN.5 crypto-ai-analysis.ENTRY_PLAN.5-1 expires after three hourly bars and cancels on invalidation", () => {
    const confirmationCloseTimeMs = BASE + 100 * MS["1h"];
    const built = buildEntryPlan({
      referencePrice: 100,
      ema20: 99,
      atr1h: 2,
      atr4h: 4,
      pullbackLow: 90,
      latestOneHourClose: 100,
      confirmationCloseTimeMs,
      analysisTimeMs: confirmationCloseTimeMs,
      currentPrice: 100,
      currentPriceObservedAtMs: confirmationCloseTimeMs,
      quoteServerTimeMs: confirmationCloseTimeMs,
      quantityRules: QUANTITY_RULES,
      nearestResistance: null,
      riskContext: { accountEquity: 100_000, availableQuoteBalance: 100_000 },
    });
    expect(built.plan).not.toBeNull();
    const plan = built.plan!;

    expect(updateEntryPlan(plan, {
      analysisTimeMs: plan.expiresAtMs - 1,
      dataComplete: true,
      trendQualified: true,
      pullbackValid: true,
      latestOneHourClose: 100,
      currentPrice: 101,
      currentPriceObservedAtMs: plan.expiresAtMs - 1,
    })).toMatchObject({ status: "waiting-for-price", failure: null });
    expect(updateEntryPlan(plan, {
      analysisTimeMs: plan.expiresAtMs,
      dataComplete: true,
      trendQualified: true,
      pullbackValid: true,
      latestOneHourClose: 100,
      currentPrice: 100,
      currentPriceObservedAtMs: plan.expiresAtMs,
    })).toMatchObject({ status: "expired", failure: "expired" });
    expect(updateEntryPlan(plan, {
      analysisTimeMs: plan.validFromMs,
      dataComplete: true,
      trendQualified: true,
      pullbackValid: true,
      latestOneHourClose: 89,
      currentPrice: 100,
      currentPriceObservedAtMs: plan.validFromMs,
    })).toMatchObject({ status: "invalidated", failure: "hourly-close-below-pullback-low" });
    expect(updateEntryPlan(plan, {
      analysisTimeMs: plan.validFromMs,
      dataComplete: false,
      trendQualified: true,
      pullbackValid: true,
      latestOneHourClose: 100,
      currentPrice: 100,
      currentPriceObservedAtMs: plan.validFromMs,
    })).toMatchObject({ status: "invalidated", failure: "insufficient-data" });
    expect(updateEntryPlan(plan, {
      analysisTimeMs: plan.validFromMs,
      dataComplete: true,
      trendQualified: false,
      pullbackValid: true,
      latestOneHourClose: 100,
      currentPrice: 100,
      currentPriceObservedAtMs: plan.validFromMs,
    })).toMatchObject({ status: "invalidated", failure: "trend-invalidated" });
    expect(updateEntryPlan(plan, {
      analysisTimeMs: plan.validFromMs,
      dataComplete: true,
      trendQualified: true,
      pullbackValid: false,
      latestOneHourClose: 100,
      currentPrice: 100,
      currentPriceObservedAtMs: plan.validFromMs,
    })).toMatchObject({ status: "invalidated", failure: "pullback-invalidated" });
    expect(updateEntryPlan(plan, {
      analysisTimeMs: plan.validFromMs,
      dataComplete: true,
      trendQualified: true,
      pullbackValid: true,
      latestOneHourClose: 100,
      currentPrice: 100,
      currentPriceObservedAtMs: plan.validFromMs,
      nearestResistance: {
        price: 110,
        lower: 109,
        upper: 111,
        touches: 1,
        lastTouchedAtMs: plan.validFromMs,
      },
    })).toMatchObject({ status: "invalidated", failure: "resistance-before-tp1" });
    expect(updateEntryPlan(plan, {
      analysisTimeMs: plan.validFromMs,
      dataComplete: true,
      trendQualified: true,
      pullbackValid: true,
      latestOneHourClose: 100,
      currentPrice: 100,
      currentPriceObservedAtMs: plan.validFromMs,
      nearestResistance: {
        price: 130,
        lower: 129,
        upper: 131,
        touches: 1,
        lastTouchedAtMs: plan.validFromMs,
      },
    })).toMatchObject({ status: "active", takeProfit2: 130 });
    expect(updateEntryPlan(plan, {
      analysisTimeMs: plan.validFromMs,
      dataComplete: true,
      trendQualified: true,
      pullbackValid: true,
      latestOneHourClose: 100,
      currentPrice: null,
      currentPriceObservedAtMs: null,
    })).toMatchObject({ status: "waiting-for-price", failure: "spot-price-unavailable" });
    expect(updateEntryPlan(plan, {
      analysisTimeMs: plan.validFromMs,
      dataComplete: true,
      trendQualified: true,
      pullbackValid: true,
      latestOneHourClose: 100,
      currentPrice: 100,
      currentPriceObservedAtMs: plan.validFromMs - 30_001,
      quoteServerTimeMs: plan.validFromMs,
    })).toMatchObject({ status: "waiting-for-price", failure: "spot-price-stale" });
    const resized = updateEntryPlan(plan, {
      analysisTimeMs: plan.validFromMs,
      dataComplete: true,
      trendQualified: true,
      pullbackValid: true,
      latestOneHourClose: 100,
      currentPrice: 100,
      currentPriceObservedAtMs: plan.validFromMs,
      riskContext: { accountEquity: 10_000, availableQuoteBalance: 50_000 },
    });
    expect(resized).toMatchObject({
      status: "active",
      riskBudgetAmount: 100,
    });
    expect(resized.estimatedStopRisk).toBeLessThanOrEqual(100);
    expect(updateEntryPlan(plan, {
      analysisTimeMs: plan.validFromMs,
      dataComplete: true,
      trendQualified: true,
      pullbackValid: true,
      latestOneHourClose: 100,
      currentPrice: 100,
      currentPriceObservedAtMs: plan.validFromMs,
      riskContext: null,
    })).toMatchObject({ status: "invalidated", failure: "risk-budget-unavailable" });
  });

  it("crypto-ai-analysis.CANDLE_QUALITY.2 refuses partial candles at the strategy boundary", () => {
    const rows = trendCandles("1h", 50, 100, 1);
    rows[rows.length - 1] = { ...rows.at(-1)!, isClosed: false };
    expect(() => buildIndicatorSnapshot("1h", rows)).toThrow("closed candles");
  });
});
