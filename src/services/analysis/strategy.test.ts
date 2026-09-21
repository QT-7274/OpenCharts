import { describe, expect, it } from "vitest";
import { TREND_PULLBACK_V1, buildIndicatorSnapshot, evaluateTrendGate } from "./strategy.ts";
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

  it("crypto-ai-analysis.CANDLE_QUALITY.2 refuses partial candles at the strategy boundary", () => {
    const rows = trendCandles("1h", 50, 100, 1);
    rows[rows.length - 1] = { ...rows.at(-1)!, isClosed: false };
    expect(() => buildIndicatorSnapshot("1h", rows)).toThrow("closed candles");
  });
});
