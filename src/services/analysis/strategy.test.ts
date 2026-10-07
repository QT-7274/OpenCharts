import { describe, expect, it } from "vitest";
import {
  TREND_PULLBACK_V1,
  buildIndicatorSnapshot,
  evaluateHourlyConfirmation,
  evaluatePullback,
  evaluateStrategy,
  evaluateTrendGate,
} from "./strategy.ts";
import { BASE, MS } from "./fixtures.ts";
import type { MarketCandle, SpotInterval } from "../market-data/types.ts";

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

  it("crypto-ai-analysis.CANDLE_QUALITY.2 refuses partial candles at the strategy boundary", () => {
    const rows = trendCandles("1h", 50, 100, 1);
    rows[rows.length - 1] = { ...rows.at(-1)!, isClosed: false };
    expect(() => buildIndicatorSnapshot("1h", rows)).toThrow("closed candles");
  });
});
