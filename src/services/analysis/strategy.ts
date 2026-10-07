import { atr, ema, macd, rsi, type CandleData, type IndicatorPoint } from "../../lib/indicators.ts";
import { intervalToMs, type MarketCandle, type SpotInterval } from "../market-data/types.ts";

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

export type StrategyState = "watch" | "setup" | "enter" | "avoid";

export type StrategyAvoidReason =
  | "data-incomplete"
  | "trend-not-qualified"
  | "pullback-invalidated"
  | "confirmation-score-insufficient"
  | "risk-reward-insufficient";

export interface PullbackAssessment {
  enteredZone: boolean;
  heldInvalidation: boolean;
  latestCloseAtOrAboveEma20: boolean;
  valid: boolean;
  touchIndex: number | null;
  barsSinceTouch: number | null;
  zoneLower: number | null;
  zoneUpper: number | null;
  invalidationLine: number | null;
  lowestLow: number | null;
}

export interface HourlyConfirmation {
  ema20Reclaim: boolean;
  breakoutAbovePriorThreeHigh: boolean;
  priceTrigger: boolean;
  bothPriceTriggers: boolean;
  bullishCandle: boolean;
  rsiAtLeast50: boolean;
  rsiRising: boolean;
  passed: boolean;
  priorThreeHigh: number | null;
}

export interface EvidenceScoreBreakdown {
  trendQuality: number;
  pullbackQuality: number;
  priceConfirmation: number;
  momentum: number;
  volume: number;
  volatilityAndFreshness: number;
  total: number;
}

export interface StrategyEvaluation {
  state: StrategyState;
  avoidReason: StrategyAvoidReason | null;
  score: number;
  scoreBreakdown: EvidenceScoreBreakdown;
  dataTimely: boolean;
  volatilityQualified: boolean;
  pullback: PullbackAssessment;
  confirmation: HourlyConfirmation;
  riskReward: number | null;
}

export interface StrategyEvaluationInput {
  indicators: AnalysisIndicatorSet;
  trend: TrendGateResult;
  fourHourCandles: readonly MarketCandle[];
  oneHourCandles: readonly MarketCandle[];
  analysisTimeMs: number;
  dataComplete?: boolean;
  riskReward?: number | null;
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

function valueAtTime(points: readonly IndicatorPoint[], time: number): number | null {
  return points.find((point) => point.time === time)?.value ?? null;
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

// crypto-ai-analysis.STRATEGY.5 crypto-ai-analysis.STRATEGY.5-1 crypto-ai-analysis.STRATEGY.5-2
export function evaluatePullback(
  candles: readonly MarketCandle[],
  latest: IntervalIndicatorSnapshot,
): PullbackAssessment {
  assertClosedSeries("4h", candles);
  const input = toIndicatorCandles(candles);
  const ema20Points = ema(input, TREND_PULLBACK_V1.emaPeriods.fast);
  const ema50Points = ema(input, TREND_PULLBACK_V1.emaPeriods.medium);
  const atrPoints = atr(input, TREND_PULLBACK_V1.atrPeriod);
  const firstIndex = Math.max(0, candles.length - 6);
  let touchIndex: number | null = null;
  let zoneLower: number | null = null;
  let zoneUpper: number | null = null;

  for (let index = firstIndex; index < candles.length; index += 1) {
    const candle = candles[index]!;
    const ema20 = valueAtTime(ema20Points, candle.openTimeMs);
    const ema50 = valueAtTime(ema50Points, candle.openTimeMs);
    const atr14 = valueAtTime(atrPoints, candle.openTimeMs);
    if (ema20 == null || ema50 == null || atr14 == null) continue;
    const lower = Math.min(ema20, ema50) - 0.25 * atr14;
    const upper = Math.max(ema20, ema50) + 0.25 * atr14;
    if (candle.low <= upper && candle.high >= lower && touchIndex == null) {
      touchIndex = index;
      zoneLower = lower;
      zoneUpper = upper;
    }
  }

  let heldInvalidation = touchIndex != null;
  let invalidationLine: number | null = null;
  let lowestLow: number | null = null;
  if (touchIndex != null) {
    for (let index = touchIndex; index < candles.length; index += 1) {
      const candle = candles[index]!;
      const ema50 = valueAtTime(ema50Points, candle.openTimeMs);
      const atr14 = valueAtTime(atrPoints, candle.openTimeMs);
      if (ema50 == null || atr14 == null) continue;
      invalidationLine = ema50 - 0.5 * atr14;
      if (candle.low < invalidationLine) heldInvalidation = false;
      lowestLow = lowestLow == null ? candle.low : Math.min(lowestLow, candle.low);
    }
  }

  const enteredZone = touchIndex != null;
  const latestCloseAtOrAboveEma20 = latest.close >= latest.ema20;
  return {
    enteredZone,
    heldInvalidation,
    latestCloseAtOrAboveEma20,
    valid: enteredZone && heldInvalidation,
    touchIndex,
    barsSinceTouch: touchIndex == null ? null : candles.length - 1 - touchIndex,
    zoneLower,
    zoneUpper,
    invalidationLine,
    lowestLow,
  };
}

// crypto-ai-analysis.STRATEGY.6 crypto-ai-analysis.STRATEGY.7
export function evaluateHourlyConfirmation(
  candles: readonly MarketCandle[],
  latest: IntervalIndicatorSnapshot,
): HourlyConfirmation {
  assertClosedSeries("1h", candles);
  const input = toIndicatorCandles(candles);
  const ema20Points = ema(input, TREND_PULLBACK_V1.emaPeriods.fast);
  const previous = candles.at(-2);
  const priorThree = candles.slice(-4, -1);
  const previousEma20 = previous == null ? null : valueAtTime(ema20Points, previous.openTimeMs);
  const priorThreeHigh = priorThree.length === 3
    ? Math.max(...priorThree.map((candle) => candle.high))
    : null;
  const ema20Reclaim = previous != null && previousEma20 != null &&
    previous.close <= previousEma20 && latest.close > latest.ema20;
  const breakoutAbovePriorThreeHigh = priorThreeHigh != null && latest.close > priorThreeHigh;
  const priceTrigger = ema20Reclaim || breakoutAbovePriorThreeHigh;
  const bothPriceTriggers = ema20Reclaim && breakoutAbovePriorThreeHigh;
  const bullishCandle = latest.close > latest.open;
  const rsiAtLeast50 = latest.rsi14 >= 50;
  const rsiRising = latest.rsi14 > latest.previousRsi14;
  return {
    ema20Reclaim,
    breakoutAbovePriorThreeHigh,
    priceTrigger,
    bothPriceTriggers,
    bullishCandle,
    rsiAtLeast50,
    rsiRising,
    passed: priceTrigger && bullishCandle && rsiAtLeast50 && rsiRising,
    priorThreeHigh,
  };
}

function isDataTimely(indicators: AnalysisIndicatorSet, analysisTimeMs: number): boolean {
  return (Object.keys(indicators) as SpotInterval[]).every((interval) => {
    const closeTime = indicators[interval].candleCloseTimeMs;
    const age = analysisTimeMs - closeTime;
    return age >= 0 && age <= intervalToMs(interval);
  });
}

// crypto-ai-analysis.STRATEGY.8 crypto-ai-analysis.STRATEGY.9 crypto-ai-analysis.STRATEGY.13
// crypto-ai-analysis.STRATEGY.14 crypto-ai-analysis.STRATEGY.15 crypto-ai-analysis.STRATEGY.16
// crypto-ai-analysis.STRATEGY.17 crypto-ai-analysis.STRATEGY.18
export function evaluateStrategy(input: StrategyEvaluationInput): StrategyEvaluation {
  const { indicators, trend } = input;
  const fourHourPullback = evaluatePullback(input.fourHourCandles, indicators["4h"]);
  const hourlyConfirmation = evaluateHourlyConfirmation(input.oneHourCandles, indicators["1h"]);
  const dataTimely = isDataTimely(indicators, input.analysisTimeMs);
  const volatilityQualified = indicators["1h"].close > 0 &&
    indicators["1h"].atr14 / indicators["1h"].close >= 0.003 &&
    indicators["1h"].atr14 / indicators["1h"].close <= 0.03;
  const trendQuality = [...trend.daily.conditions, ...trend.fourHour.conditions]
    .filter((conditionItem) => conditionItem.passed).length * 5;
  const pullbackQuality = (fourHourPullback.enteredZone ? 8 : 0) +
    (fourHourPullback.heldInvalidation ? 6 : 0) +
    (fourHourPullback.latestCloseAtOrAboveEma20 ? 6 : 0);
  const priceConfirmation = (hourlyConfirmation.priceTrigger ? 10 : 0) +
    (hourlyConfirmation.bullishCandle ? 5 : 0) +
    (hourlyConfirmation.bothPriceTriggers ? 5 : 0);
  const momentum = (indicators["1h"].rsi14 >= 50 ? 5 : 0) +
    (indicators["1h"].rsi14 > indicators["1h"].previousRsi14 ? 5 : 0) +
    (indicators["1h"].macdHistogram > indicators["1h"].previousMacdHistogram ? 5 : 0);
  const volume = indicators["1h"].volume > indicators["1h"].volumeSma20 ? 10 : 0;
  const volatilityAndFreshness = (dataTimely ? 3 : 0) + (volatilityQualified ? 2 : 0);
  const scoreBreakdown: EvidenceScoreBreakdown = {
    trendQuality,
    pullbackQuality,
    priceConfirmation,
    momentum,
    volume,
    volatilityAndFreshness,
    total: trendQuality + pullbackQuality + priceConfirmation + momentum + volume + volatilityAndFreshness,
  };
  const dataComplete = input.dataComplete ?? true;
  const riskReward = input.riskReward ?? null;

  let state: StrategyState;
  let avoidReason: StrategyAvoidReason | null = null;
  if (!dataComplete || !dataTimely) {
    state = "avoid";
    avoidReason = "data-incomplete";
  } else if (!trend.eligibleForPullback) {
    state = "avoid";
    avoidReason = "trend-not-qualified";
  } else if (fourHourPullback.enteredZone && !fourHourPullback.heldInvalidation) {
    state = "avoid";
    avoidReason = "pullback-invalidated";
  } else if (!fourHourPullback.enteredZone) {
    state = "watch";
  } else if (!hourlyConfirmation.passed) {
    state = "setup";
  } else if (scoreBreakdown.total < 70) {
    state = "avoid";
    avoidReason = "confirmation-score-insufficient";
  } else if (riskReward == null || riskReward < 2) {
    state = "avoid";
    avoidReason = "risk-reward-insufficient";
  } else {
    state = "enter";
  }

  return {
    state,
    avoidReason,
    score: scoreBreakdown.total,
    scoreBreakdown,
    dataTimely,
    volatilityQualified,
    pullback: fourHourPullback,
    confirmation: hourlyConfirmation,
    riskReward,
  };
}
