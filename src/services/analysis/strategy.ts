import { atr, ema, macd, rsi, type CandleData, type IndicatorPoint } from "../../lib/indicators.ts";
import type { MarketCandle, SpotInterval } from "../market-data/types.ts";

export const TREND_PULLBACK_V1 = Object.freeze({
  version: "trend-pullback-v1",
  emaPeriods: Object.freeze({ fast: 20, medium: 50, slow: 200 }),
  atrPeriod: 14,
  rsiPeriod: 14,
  macd: Object.freeze({ fast: 12, slow: 26, signal: 9 }),
  volumeSmaPeriod: 20,
  dailyEmaSlopeLookback: 5,
  fourHourEmaSlopeLookback: 3,
} as const);

export type StrategyVersion = typeof TREND_PULLBACK_V1.version;

export interface IntervalIndicatorSnapshot {
  interval: SpotInterval;
  candleCloseTimeMs: number;
  open: number;
  close: number;
  volume: number;
  ema20: number;
  ema50: number;
  ema200: number | null;
  ema20ThreeBarsAgo: number;
  ema50FiveBarsAgo: number | null;
  atr14: number;
  rsi14: number;
  previousRsi14: number;
  macdHistogram: number;
  previousMacdHistogram: number;
  volumeSma20: number;
}

export type AnalysisIndicatorSet = Record<SpotInterval, IntervalIndicatorSnapshot>;

export type TrendConditionId =
  | "1d-close-above-ema200"
  | "1d-ema50-above-ema200"
  | "1d-ema50-rising"
  | "4h-close-above-ema50"
  | "4h-ema20-above-ema50"
  | "4h-ema20-rising";

export interface TrendCondition {
  id: TrendConditionId;
  passed: boolean;
  actual: number;
  reference: number | null;
}

export interface TimeframeTrendAssessment {
  interval: "1d" | "4h";
  bullish: boolean;
  conditions: TrendCondition[];
}

export interface TrendGateResult {
  direction: "bullish" | "not-bullish";
  eligibleForPullback: boolean;
  daily: TimeframeTrendAssessment;
  fourHour: TimeframeTrendAssessment;
}

function assertClosedSeries(interval: SpotInterval, candles: readonly MarketCandle[]): void {
  for (let index = 0; index < candles.length; index += 1) {
    const row = candles[index]!;
    if (!row.isClosed || row.interval !== interval) {
      throw new Error("Indicator snapshots require validated closed candles from one interval");
    }
    if (index > 0 && row.openTimeMs <= candles[index - 1]!.openTimeMs) {
      throw new Error("Indicator snapshots require strictly ordered candles");
    }
  }
}

function toIndicatorCandles(candles: readonly MarketCandle[]): CandleData[] {
  return candles.map((row) => ({
    time: row.openTimeMs,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  }));
}

function latestValue(points: readonly IndicatorPoint[]): number | null {
  return points.at(-1)?.value ?? null;
}

function valueAtCandleOffset(
  points: readonly IndicatorPoint[],
  candles: readonly MarketCandle[],
  offset: number,
): number | null {
  const target = candles.at(-(offset + 1));
  if (!target) return null;
  return points.find((point) => point.time === target.openTimeMs)?.value ?? null;
}

function latestVolumeSma(candles: readonly MarketCandle[], period: number): number | null {
  if (candles.length < period) return null;
  return candles.slice(-period).reduce((sum, row) => sum + row.volume, 0) / period;
}

// crypto-ai-analysis.STRATEGY.2 crypto-ai-analysis.STRATEGY.3 crypto-ai-analysis.STRATEGY.12
export function buildIndicatorSnapshot(
  interval: SpotInterval,
  candles: readonly MarketCandle[],
): IntervalIndicatorSnapshot | null {
  assertClosedSeries(interval, candles);
  const latest = candles.at(-1);
  if (!latest) return null;

  const input = toIndicatorCandles(candles);
  const ema20Points = ema(input, TREND_PULLBACK_V1.emaPeriods.fast);
  const ema50Points = ema(input, TREND_PULLBACK_V1.emaPeriods.medium);
  const ema200Points = ema(input, TREND_PULLBACK_V1.emaPeriods.slow);
  const atrPoints = atr(input, TREND_PULLBACK_V1.atrPeriod);
  const rsiPoints = rsi(input, TREND_PULLBACK_V1.rsiPeriod);
  const macdPoints = macd(
    input,
    TREND_PULLBACK_V1.macd.fast,
    TREND_PULLBACK_V1.macd.slow,
    TREND_PULLBACK_V1.macd.signal,
  ).histogram;

  const ema20 = latestValue(ema20Points);
  const ema50 = latestValue(ema50Points);
  const ema20ThreeBarsAgo = valueAtCandleOffset(
    ema20Points, candles, TREND_PULLBACK_V1.fourHourEmaSlopeLookback,
  );
  const atr14 = latestValue(atrPoints);
  const rsi14 = latestValue(rsiPoints);
  const previousRsi14 = rsiPoints.at(-2)?.value ?? null;
  const macdHistogram = latestValue(macdPoints);
  const previousMacdHistogram = macdPoints.at(-2)?.value ?? null;
  const volumeSma20 = latestVolumeSma(candles, TREND_PULLBACK_V1.volumeSmaPeriod);

  if (ema20 == null || ema50 == null || ema20ThreeBarsAgo == null || atr14 == null ||
    rsi14 == null || previousRsi14 == null || macdHistogram == null ||
    previousMacdHistogram == null || volumeSma20 == null) return null;

  return {
    interval,
    candleCloseTimeMs: latest.closeTimeMs,
    open: latest.open,
    close: latest.close,
    volume: latest.volume,
    ema20,
    ema50,
    ema200: latestValue(ema200Points),
    ema20ThreeBarsAgo,
    ema50FiveBarsAgo: valueAtCandleOffset(
      ema50Points, candles, TREND_PULLBACK_V1.dailyEmaSlopeLookback,
    ),
    atr14,
    rsi14,
    previousRsi14,
    macdHistogram,
    previousMacdHistogram,
    volumeSma20,
  };
}

function condition(id: TrendConditionId, actual: number, reference: number | null): TrendCondition {
  return { id, actual, reference, passed: reference != null && actual > reference };
}

// crypto-ai-analysis.STRATEGY.2 crypto-ai-analysis.STRATEGY.3 crypto-ai-analysis.STRATEGY.4
export function evaluateTrendGate(indicators: AnalysisIndicatorSet): TrendGateResult {
  const daily = indicators["1d"];
  const fourHour = indicators["4h"];
  const dailyConditions = [
    condition("1d-close-above-ema200", daily.close, daily.ema200),
    condition("1d-ema50-above-ema200", daily.ema50, daily.ema200),
    condition("1d-ema50-rising", daily.ema50, daily.ema50FiveBarsAgo),
  ];
  const fourHourConditions = [
    condition("4h-close-above-ema50", fourHour.close, fourHour.ema50),
    condition("4h-ema20-above-ema50", fourHour.ema20, fourHour.ema50),
    condition("4h-ema20-rising", fourHour.ema20, fourHour.ema20ThreeBarsAgo),
  ];
  const dailyTrend: TimeframeTrendAssessment = {
    interval: "1d",
    bullish: dailyConditions.every((item) => item.passed),
    conditions: dailyConditions,
  };
  const fourHourTrend: TimeframeTrendAssessment = {
    interval: "4h",
    bullish: fourHourConditions.every((item) => item.passed),
    conditions: fourHourConditions,
  };
  const eligibleForPullback = dailyTrend.bullish && fourHourTrend.bullish;
  return {
    direction: eligibleForPullback ? "bullish" : "not-bullish",
    eligibleForPullback,
    daily: dailyTrend,
    fourHour: fourHourTrend,
  };
}
