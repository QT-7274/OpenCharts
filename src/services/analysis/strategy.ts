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

export interface PriceZone {
  price: number;
  lower: number;
  upper: number;
  touches: number;
  lastTouchedAtMs: number;
}

export interface SupportResistanceLevels {
  support: PriceZone | null;
  resistance: PriceZone | null;
}

export interface SimulatedRiskContext {
  accountEquity: number | null;
  availableQuoteBalance: number | null;
}

export interface SpotQuantityRules {
  minQty: number;
  maxQty: number;
  stepSize: number;
}

export type EntryPlanStatus = "active" | "waiting-for-price" | "expired" | "invalidated";
export type EntryPlanFailure =
  | "invalid-input"
  | "spot-price-unavailable"
  | "spot-price-stale"
  | "risk-budget-unavailable"
  | "quantity-rules-unavailable"
  | "quantity-below-minimum"
  | "structure-invalidated"
  | "resistance-before-tp1"
  | "expired"
  | "trend-invalidated"
  | "pullback-invalidated"
  | "hourly-close-below-pullback-low"
  | "insufficient-data";

export interface EntryPlan {
  referencePrice: number;
  entryLower: number;
  entryUpper: number;
  pullbackLow: number;
  structureStop: number;
  volatilityStop: number;
  stop: number;
  riskPerUnit: number;
  takeProfit1: number;
  takeProfit2: number;
  riskReward: number;
  riskBudgetAmount: number;
  suggestedQuantity: number;
  suggestedNotional: number;
  estimatedStopRisk: number;
  quantityRules: SpotQuantityRules;
  validFromMs: number;
  expiresAtMs: number;
  currentPrice: number;
  currentPriceObservedAtMs: number;
  status: EntryPlanStatus;
  failure: EntryPlanFailure | null;
}

export interface BuildEntryPlanInput {
  referencePrice: number;
  ema20: number;
  atr1h: number;
  atr4h: number;
  pullbackLow: number;
  latestOneHourClose: number;
  confirmationCloseTimeMs: number;
  analysisTimeMs: number;
  currentPrice: number | null;
  currentPriceObservedAtMs: number | null;
  quoteServerTimeMs: number | null;
  quantityRules: SpotQuantityRules | null;
  nearestResistance: PriceZone | null;
  riskContext: SimulatedRiskContext | null;
}

export interface UpdateEntryPlanInput {
  analysisTimeMs: number;
  dataComplete: boolean;
  trendQualified: boolean;
  pullbackValid: boolean;
  latestOneHourClose: number;
  currentPrice: number | null;
  currentPriceObservedAtMs: number | null;
  quoteServerTimeMs?: number | null;
  nearestResistance?: PriceZone | null;
  riskContext?: SimulatedRiskContext | null;
}

const MAX_ACCOUNT_RISK_FRACTION = 0.01;
const MAX_SPOT_QUOTE_AGE_MS = 30_000;
const FUTURE_QUOTE_TOLERANCE_MS = 1_000;

interface SpotRiskAllocation {
  riskBudgetAmount: number;
  suggestedQuantity: number;
  suggestedNotional: number;
  estimatedStopRisk: number;
}

// crypto-ai-analysis.MARKET_DATA.7
export type SpotQuoteFailure = "spot-price-unavailable" | "spot-price-stale";

export function getSpotQuoteFailure(
  price: number | null,
  tradeTimeMs: number | null,
  serverTimeMs: number | null,
  asOfMs = serverTimeMs,
): SpotQuoteFailure | null {
  if (price == null || tradeTimeMs == null || serverTimeMs == null ||
    !Number.isFinite(price) || price <= 0 || !Number.isFinite(tradeTimeMs) ||
    !Number.isFinite(serverTimeMs) || asOfMs == null || !Number.isFinite(asOfMs) ||
    tradeTimeMs <= 0 || serverTimeMs <= 0) return "spot-price-unavailable";
  const quoteAgeMs = serverTimeMs - tradeTimeMs;
  if (quoteAgeMs < -FUTURE_QUOTE_TOLERANCE_MS) return "spot-price-stale";
  const elapsedSinceQuoteMs = asOfMs - serverTimeMs;
  if (elapsedSinceQuoteMs < -FUTURE_QUOTE_TOLERANCE_MS) return "spot-price-stale";
  const ageMs = quoteAgeMs + elapsedSinceQuoteMs;
  return ageMs < -FUTURE_QUOTE_TOLERANCE_MS || ageMs > MAX_SPOT_QUOTE_AGE_MS
    ? "spot-price-stale"
    : null;
}

function isValidSpotQuantityRules(rules: SpotQuantityRules | null | undefined): rules is SpotQuantityRules {
  return rules != null && Number.isFinite(rules.minQty) && rules.minQty >= 0 &&
    Number.isFinite(rules.maxQty) && rules.maxQty > 0 && rules.maxQty >= rules.minQty &&
    Number.isFinite(rules.stepSize) && rules.stepSize > 0;
}

function decimalPlaces(value: number): number {
  const [coefficient, exponentValue] = value.toString().toLowerCase().split("e");
  const exponent = Number(exponentValue ?? 0);
  return Math.max(0, (coefficient!.split(".")[1]?.length ?? 0) - exponent);
}

function roundDownToStep(quantity: number, stepSize: number): number {
  const steps = Math.floor(quantity / stepSize + Number.EPSILON * 8);
  return Number((steps * stepSize).toFixed(decimalPlaces(stepSize)));
}

// crypto-ai-analysis.RISK_AND_PAPER_TRADING.5-1
function calculateSpotRiskAllocation(
  referencePrice: number,
  riskPerUnit: number,
  riskContext: SimulatedRiskContext | null | undefined,
  quantityRules: SpotQuantityRules,
): SpotRiskAllocation | null {
  const accountEquity = riskContext?.accountEquity;
  const availableQuoteBalance = riskContext?.availableQuoteBalance;
  if (accountEquity == null || availableQuoteBalance == null ||
    !Number.isFinite(accountEquity) || accountEquity <= 0 ||
    !Number.isFinite(availableQuoteBalance) || availableQuoteBalance <= 0) return null;

  const riskBudgetAmount = accountEquity * MAX_ACCOUNT_RISK_FRACTION;
  const uncappedQuantity = Math.min(
    riskBudgetAmount / riskPerUnit,
    availableQuoteBalance / referencePrice,
    quantityRules.maxQty,
  );
  let suggestedQuantity = roundDownToStep(uncappedQuantity, quantityRules.stepSize);
  if (suggestedQuantity < quantityRules.minQty) return null;
  let suggestedNotional = suggestedQuantity * referencePrice;
  let estimatedStopRisk = suggestedQuantity * riskPerUnit;
  if (suggestedNotional > availableQuoteBalance || estimatedStopRisk > riskBudgetAmount) {
    suggestedQuantity = roundDownToStep(
      Math.max(0, suggestedQuantity - quantityRules.stepSize), quantityRules.stepSize,
    );
    suggestedNotional = suggestedQuantity * referencePrice;
    estimatedStopRisk = suggestedQuantity * riskPerUnit;
  }
  if (![riskBudgetAmount, suggestedQuantity, suggestedNotional, estimatedStopRisk].every(Number.isFinite) ||
    riskBudgetAmount <= 0 || suggestedQuantity <= 0 || suggestedQuantity < quantityRules.minQty ||
    suggestedNotional > availableQuoteBalance || estimatedStopRisk > riskBudgetAmount) return null;

  return { riskBudgetAmount, suggestedQuantity, suggestedNotional, estimatedStopRisk };
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
  entryPlanStatus: EntryPlanStatus | null;
}

export interface StrategyEvaluationInput {
  indicators: AnalysisIndicatorSet;
  trend: TrendGateResult;
  fourHourCandles: readonly MarketCandle[];
  oneHourCandles: readonly MarketCandle[];
  analysisTimeMs: number;
  dataComplete?: boolean;
  riskReward?: number | null;
  entryPlanStatus?: EntryPlanStatus | null;
  pullbackAssessment?: PullbackAssessment;
  hourlyConfirmation?: HourlyConfirmation;
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

// crypto-ai-analysis.STRATEGY.2 crypto-ai-analysis.STRATEGY.3 crypto-ai-analysis.STRATEGY.12
export function buildIndicatorSnapshotHistory(
  interval: SpotInterval,
  candles: readonly MarketCandle[],
): Array<IntervalIndicatorSnapshot | null> {
  assertClosedSeries(interval, candles);
  if (candles.length === 0) return [];

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

  const valuesByTime = (points: readonly IndicatorPoint[]) =>
    new Map(points.map((point) => [point.time, point.value]));
  const ema20ByTime = valuesByTime(ema20Points);
  const ema50ByTime = valuesByTime(ema50Points);
  const ema200ByTime = valuesByTime(ema200Points);
  const atrByTime = valuesByTime(atrPoints);
  const rsiByTime = valuesByTime(rsiPoints);
  const macdByTime = valuesByTime(macdPoints);
  const volumePeriod = TREND_PULLBACK_V1.volumeSmaPeriod;
  let volumeSum = 0;

  return candles.map((candle, index) => {
    volumeSum += candle.volume;
    if (index >= volumePeriod) volumeSum -= candles[index - volumePeriod]!.volume;
    const ema20 = ema20ByTime.get(candle.openTimeMs) ?? null;
    const ema50 = ema50ByTime.get(candle.openTimeMs) ?? null;
    const ema20ThreeBarsAgo = index >= TREND_PULLBACK_V1.fourHourEmaSlopeLookback
      ? ema20ByTime.get(candles[index - TREND_PULLBACK_V1.fourHourEmaSlopeLookback]!.openTimeMs) ?? null
      : null;
    const rsi14 = rsiByTime.get(candle.openTimeMs) ?? null;
    const previousRsi14 = index > 0
      ? rsiByTime.get(candles[index - 1]!.openTimeMs) ?? null
      : null;
    const macdHistogram = macdByTime.get(candle.openTimeMs) ?? null;
    const previousMacdHistogram = index > 0
      ? macdByTime.get(candles[index - 1]!.openTimeMs) ?? null
      : null;
    const volumeSma20 = index >= volumePeriod - 1 ? volumeSum / volumePeriod : null;

    if (ema20 == null || ema50 == null || ema20ThreeBarsAgo == null ||
      atrByTime.get(candle.openTimeMs) == null || rsi14 == null || previousRsi14 == null ||
      macdHistogram == null || previousMacdHistogram == null || volumeSma20 == null) return null;

    return {
      interval,
      candleCloseTimeMs: candle.closeTimeMs,
      open: candle.open,
      close: candle.close,
      volume: candle.volume,
      ema20,
      ema50,
      ema200: ema200ByTime.get(candle.openTimeMs) ?? null,
      ema20ThreeBarsAgo,
      ema50FiveBarsAgo: index >= TREND_PULLBACK_V1.dailyEmaSlopeLookback
        ? ema50ByTime.get(candles[index - TREND_PULLBACK_V1.dailyEmaSlopeLookback]!.openTimeMs) ?? null
        : null,
      atr14: atrByTime.get(candle.openTimeMs)!,
      rsi14,
      previousRsi14,
      macdHistogram,
      previousMacdHistogram,
      volumeSma20,
    };
  });
}

export function buildIndicatorSnapshot(
  interval: SpotInterval,
  candles: readonly MarketCandle[],
): IntervalIndicatorSnapshot | null {
  return buildIndicatorSnapshotHistory(interval, candles).at(-1) ?? null;
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
  indicatorHistory?: readonly (IntervalIndicatorSnapshot | null)[],
): PullbackAssessment {
  assertClosedSeries("4h", candles);
  const history = indicatorHistory ?? buildIndicatorSnapshotHistory("4h", candles);
  const firstIndex = Math.max(0, candles.length - 6);
  let touchIndex: number | null = null;
  let zoneLower: number | null = null;
  let zoneUpper: number | null = null;

  for (let index = firstIndex; index < candles.length; index += 1) {
    const candle = candles[index]!;
    const snapshot = history[index];
    const ema20 = snapshot?.ema20;
    const ema50 = snapshot?.ema50;
    const atr14 = snapshot?.atr14;
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
      const snapshot = history[index];
      const ema50 = snapshot?.ema50;
      const atr14 = snapshot?.atr14;
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

// crypto-ai-analysis.ENTRY_PLAN.1 crypto-ai-analysis.ENTRY_PLAN.1-1 crypto-ai-analysis.ENTRY_PLAN.1-2
export function identifySupportResistance(
  candles: readonly MarketCandle[],
  currentPrice: number,
  atr4h: number,
  analysisTimeMs = Number.POSITIVE_INFINITY,
): SupportResistanceLevels {
  const closed = candles
    .filter((row) => row.isClosed && row.closeTimeMs <= analysisTimeMs)
    .slice(-60);
  assertClosedSeries("4h", closed);
  const candidates: Array<{ price: number; touchedAtMs: number; kind: "support" | "resistance" }> = [];

  for (let index = 2; index < closed.length - 2; index += 1) {
    const point = closed[index]!;
    const neighbors = [...closed.slice(index - 2, index), ...closed.slice(index + 1, index + 3)];
    if (neighbors.every((row) => point.low < row.low)) {
      candidates.push({ price: point.low, touchedAtMs: point.openTimeMs, kind: "support" });
    }
    if (neighbors.every((row) => point.high > row.high)) {
      candidates.push({ price: point.high, touchedAtMs: point.openTimeMs, kind: "resistance" });
    }
  }

  const mergeDistance = atr4h * 0.5;
  function nearest(kind: "support" | "resistance"): PriceZone | null {
    if (!Number.isFinite(currentPrice) || currentPrice <= 0 || !Number.isFinite(mergeDistance) || mergeDistance <= 0) {
      return null;
    }
    const levels = candidates
      .filter((item) => item.kind === kind && (kind === "support" ? item.price < currentPrice : item.price > currentPrice))
      .sort((a, b) => a.price - b.price);
    const clusters: Array<Array<(typeof levels)[number]>> = [];
    for (const level of levels) {
      const cluster = clusters.at(-1);
      const center = cluster == null
        ? null
        : cluster.reduce((sum, item) => sum + item.price, 0) / cluster.length;
      if (cluster && center != null && Math.abs(level.price - center) <= mergeDistance) cluster.push(level);
      else clusters.push([level]);
    }
    const zones = clusters.map((cluster): PriceZone => {
      const prices = cluster.map((item) => item.price);
      return {
        price: prices.reduce((sum, price) => sum + price, 0) / prices.length,
        lower: Math.min(...prices),
        upper: Math.max(...prices),
        touches: cluster.length,
        lastTouchedAtMs: Math.max(...cluster.map((item) => item.touchedAtMs)),
      };
    });
    return zones.sort((a, b) => {
      const distance = Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice);
      return distance || b.touches - a.touches || b.lastTouchedAtMs - a.lastTouchedAtMs;
    })[0] ?? null;
  }

  return { support: nearest("support"), resistance: nearest("resistance") };
}

// crypto-ai-analysis.ENTRY_PLAN.2 crypto-ai-analysis.ENTRY_PLAN.2-1 crypto-ai-analysis.ENTRY_PLAN.3
// crypto-ai-analysis.ENTRY_PLAN.3-1
// crypto-ai-analysis.ENTRY_PLAN.4 crypto-ai-analysis.ENTRY_PLAN.4-1 crypto-ai-analysis.ENTRY_PLAN.4-2
export function buildEntryPlan(input: BuildEntryPlanInput): { plan: EntryPlan | null; failure: EntryPlanFailure | null } {
  const requiredNumbers = [input.referencePrice, input.ema20, input.atr1h, input.atr4h,
    input.pullbackLow, input.latestOneHourClose, input.confirmationCloseTimeMs, input.analysisTimeMs];
  if (requiredNumbers.some((value) => !Number.isFinite(value)) || input.referencePrice <= 0 ||
    input.atr1h <= 0 || input.atr4h <= 0 || input.pullbackLow <= 0) {
    return { plan: null, failure: "invalid-input" };
  }
  if (input.latestOneHourClose < input.pullbackLow) return { plan: null, failure: "structure-invalidated" };
  const quoteFailure = getSpotQuoteFailure(
    input.currentPrice, input.currentPriceObservedAtMs, input.quoteServerTimeMs, input.quoteServerTimeMs,
  );
  if (quoteFailure) return { plan: null, failure: quoteFailure };
  const currentPrice = input.currentPrice!;
  if (!isValidSpotQuantityRules(input.quantityRules)) {
    return { plan: null, failure: "quantity-rules-unavailable" };
  }

  const entryLower = Math.max(input.ema20, input.referencePrice - 0.25 * input.atr1h);
  const entryUpper = input.referencePrice + 0.1 * input.atr1h;
  const structureStop = input.pullbackLow - 0.25 * input.atr4h;
  const volatilityStop = input.referencePrice - 1.5 * input.atr1h;
  const stop = Math.min(structureStop, volatilityStop);
  const riskPerUnit = input.referencePrice - stop;
  if (![entryLower, entryUpper, structureStop, volatilityStop, stop, riskPerUnit].every(Number.isFinite) ||
    entryLower > entryUpper || stop <= 0 || riskPerUnit <= 0) {
    return { plan: null, failure: "invalid-input" };
  }

  const riskContext = input.riskContext;
  if (riskContext?.accountEquity == null || riskContext.availableQuoteBalance == null ||
    !Number.isFinite(riskContext.accountEquity) || riskContext.accountEquity <= 0 ||
    !Number.isFinite(riskContext.availableQuoteBalance) || riskContext.availableQuoteBalance <= 0) {
    return { plan: null, failure: "risk-budget-unavailable" };
  }
  const riskAllocation = calculateSpotRiskAllocation(
    entryUpper, entryUpper - stop, riskContext, input.quantityRules,
  );
  if (!riskAllocation) return { plan: null, failure: "quantity-below-minimum" };

  const takeProfit1 = input.referencePrice + 2 * riskPerUnit;
  if (input.nearestResistance && input.nearestResistance.price < takeProfit1) {
    return { plan: null, failure: "resistance-before-tp1" };
  }
  const takeProfit2 = input.nearestResistance?.price ?? input.referencePrice + 3 * riskPerUnit;
  const validFromMs = input.confirmationCloseTimeMs + 1;
  const expiresAtMs = input.confirmationCloseTimeMs + 3 * intervalToMs("1h");
  if (input.analysisTimeMs >= expiresAtMs) return { plan: null, failure: "expired" };
  const status = input.analysisTimeMs >= validFromMs && currentPrice >= entryLower && currentPrice <= entryUpper
    ? "active"
    : "waiting-for-price";

  return {
    failure: null,
    plan: {
      referencePrice: input.referencePrice,
      entryLower,
      entryUpper,
      pullbackLow: input.pullbackLow,
      structureStop,
      volatilityStop,
      stop,
      riskPerUnit,
      takeProfit1,
      takeProfit2,
      riskReward: (takeProfit1 - input.referencePrice) / riskPerUnit,
      ...riskAllocation,
      quantityRules: input.quantityRules,
      validFromMs,
      expiresAtMs,
      currentPrice,
      currentPriceObservedAtMs: input.currentPriceObservedAtMs!,
      status,
      failure: null,
    },
  };
}

// crypto-ai-analysis.ENTRY_PLAN.3-1 crypto-ai-analysis.ENTRY_PLAN.5 crypto-ai-analysis.ENTRY_PLAN.5-1
export function updateEntryPlan(plan: EntryPlan, input: UpdateEntryPlanInput): EntryPlan {
  let failure: EntryPlanFailure | null = null;
  let status: EntryPlanStatus = "active";
  if (!input.dataComplete) failure = "insufficient-data";
  else if (input.analysisTimeMs >= plan.expiresAtMs) failure = "expired";
  else if (!input.trendQualified) failure = "trend-invalidated";
  else if (!input.pullbackValid) failure = "pullback-invalidated";
  else if (!Number.isFinite(input.latestOneHourClose) || input.latestOneHourClose < plan.pullbackLow) {
    failure = "hourly-close-below-pullback-low";
  } else if (input.nearestResistance && input.nearestResistance.price < plan.takeProfit1) {
    failure = "resistance-before-tp1";
  } else {
    failure = getSpotQuoteFailure(
      input.currentPrice,
      input.currentPriceObservedAtMs,
      input.quoteServerTimeMs ?? input.analysisTimeMs,
      input.quoteServerTimeMs ?? input.analysisTimeMs,
    );
  }
  const riskContext = input.riskContext;
  const riskContextAvailable = riskContext?.accountEquity != null &&
    riskContext.availableQuoteBalance != null && Number.isFinite(riskContext.accountEquity) &&
    riskContext.accountEquity > 0 && Number.isFinite(riskContext.availableQuoteBalance) &&
    riskContext.availableQuoteBalance > 0;
  const riskAllocation = input.riskContext === undefined || !riskContextAvailable ||
    !isValidSpotQuantityRules(plan.quantityRules)
    ? null
    : calculateSpotRiskAllocation(
      plan.entryUpper, plan.entryUpper - plan.stop, riskContext, plan.quantityRules,
    );
  if (!failure && input.riskContext !== undefined && !riskContextAvailable) {
    failure = "risk-budget-unavailable";
  } else if (!failure && input.riskContext !== undefined && !riskAllocation) {
    failure = isValidSpotQuantityRules(plan.quantityRules)
      ? "quantity-below-minimum"
      : "quantity-rules-unavailable";
  }

  if (failure) {
    status = failure === "expired" ? "expired"
      : failure === "spot-price-unavailable" || failure === "spot-price-stale" ? "waiting-for-price"
        : "invalidated";
  } else {
    status = input.analysisTimeMs >= plan.validFromMs &&
      input.currentPrice! >= plan.entryLower && input.currentPrice! <= plan.entryUpper
      ? "active"
      : "waiting-for-price";
  }

  return {
    ...plan,
    currentPrice: input.currentPrice ?? plan.currentPrice,
    currentPriceObservedAtMs: input.currentPriceObservedAtMs ?? plan.currentPriceObservedAtMs,
    takeProfit2: input.nearestResistance?.price ?? plan.referencePrice + 3 * plan.riskPerUnit,
    ...(riskAllocation ?? {}),
    status,
    failure,
  };
}

// crypto-ai-analysis.STRATEGY.6 crypto-ai-analysis.STRATEGY.7
export function evaluateHourlyConfirmation(
  candles: readonly MarketCandle[],
  latest: IntervalIndicatorSnapshot,
  indicatorHistory?: readonly (IntervalIndicatorSnapshot | null)[],
): HourlyConfirmation {
  assertClosedSeries("1h", candles);
  const history = indicatorHistory ?? buildIndicatorSnapshotHistory("1h", candles);
  const previous = candles.at(-2);
  const priorThree = candles.slice(-4, -1);
  let previousEma20 = previous == null ? null : history.at(-2)?.ema20 ?? null;
  if (previous != null && previousEma20 == null) {
    previousEma20 = ema(toIndicatorCandles(candles), TREND_PULLBACK_V1.emaPeriods.fast).at(-2)?.value ?? null;
  }
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
  const fourHourPullback = input.pullbackAssessment ??
    evaluatePullback(input.fourHourCandles, indicators["4h"]);
  const hourlyConfirmation = input.hourlyConfirmation ??
    evaluateHourlyConfirmation(input.oneHourCandles, indicators["1h"]);
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
  const entryPlanStatus = input.entryPlanStatus ?? null;

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
  } else if (entryPlanStatus === "waiting-for-price") {
    state = "setup";
  } else if (!hourlyConfirmation.passed && entryPlanStatus !== "active") {
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
    entryPlanStatus,
  };
}
