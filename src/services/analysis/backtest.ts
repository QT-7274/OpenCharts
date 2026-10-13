import { intervalToMs, SUPPORTED_SPOT_SYMBOLS, type MarketCandle, type SpotSymbol } from "../market-data/types.ts";
import {
  TREND_PULLBACK_V1,
  buildEntryPlan,
  buildIndicatorSnapshotHistory,
  evaluateHourlyConfirmation,
  evaluatePullback,
  evaluateStrategy,
  evaluateTrendGate,
  identifySupportResistance,
  type StrategyAvoidReason,
  type StrategyState,
} from "./strategy.ts";

const HOUR_MS = intervalToMs("1h");
const DAY_MS = intervalToMs("1d");
export const BACKTEST_WARMUP_DAILY_BARS = 250;
const TRAINING_FRACTION = 0.7;

export const DEFAULT_BACKTEST_CONFIG = Object.freeze({
  initialCapital: 10_000,
  buyFeeRate: 0.001,
  sellFeeRate: 0.001,
  buySlippageRate: 0.0005,
  sellSlippageRate: 0.0005,
  maxTradeRiskFraction: 0.01,
  maxPortfolioRiskFraction: 0.03,
});

export interface BacktestConfig {
  initialCapital: number;
  buyFeeRate: number;
  sellFeeRate: number;
  buySlippageRate: number;
  sellSlippageRate: number;
  maxTradeRiskFraction?: number;
  maxPortfolioRiskFraction?: number;
}

export type BacktestCostAssumptions = Pick<BacktestConfig,
  "buyFeeRate" | "sellFeeRate" | "buySlippageRate" | "sellSlippageRate">;

export interface BacktestAssetData {
  symbol: SpotSymbol;
  candles1h: readonly MarketCandle[];
  candles4h: readonly MarketCandle[];
  candles1d: readonly MarketCandle[];
}

export interface BacktestPeriod {
  startMs: number;
  endMs: number;
}

export interface BacktestTrade {
  id: string;
  symbol: SpotSymbol;
  entryTimeMs: number;
  exitTimeMs: number;
  theoreticalEntryPrice: number;
  actualEntryPrice: number;
  averageExitPrice: number;
  stopPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  quantity: number;
  netPnl: number;
  costs: number;
  actualRisk: number;
  actualRiskReward: number | null;
  holdingHours: number;
  exitReason: "stop" | "break-even" | "take-profit-2" | "period-end";
  strategyVersion: string;
}

export interface BacktestMetrics {
  signalCount: number;
  tradeCount: number;
  skippedSignalCount: number;
  skipReasons: Record<string, number>;
  strategyStateCounts: Record<StrategyState, number>;
  winRatePct: number | null;
  netReturnPct: number;
  annualizedReturnPct: number | null;
  profitFactor: number | "infinite" | null;
  maxDrawdownPct: number;
  averageNetPnl: number | null;
  averageHoldingHours: number | null;
  averageActualRiskReward: number | null;
  totalCosts: number;
  maxConsecutiveLosses: number;
  sharpeRatio: number | null;
  endingEquity: number;
}

export interface BuyAndHoldMetrics {
  netReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number | null;
  netReturnDifferencePct: number;
  maxDrawdownDifferencePct: number;
  sharpeDifference: number | null;
}

export interface BacktestPeriodResult {
  period: BacktestPeriod;
  metrics: BacktestMetrics;
  buyAndHold: BuyAndHoldMetrics;
  trades: BacktestTrade[];
}

export interface BacktestSymbolResult {
  research: BacktestPeriodResult;
  outOfSample: BacktestPeriodResult;
}

export interface CryptoBacktestReport {
  strategyVersion: string;
  costAssumptions: BacktestCostAssumptions;
  status: "research-usable" | "experimental" | "invalid";
  statusReason: string;
  generatedAtMs: number;
  requestedPeriod: BacktestPeriod;
  symbols: Partial<Record<SpotSymbol, BacktestSymbolResult>>;
  portfolio: BacktestSymbolResult;
  robustness: BacktestRobustnessReport;
  validityChecks: {
    closedCandlesOnly: boolean;
    nextBarExecution: boolean;
    deterministicEngine: boolean;
  };
}

export interface BacktestWalkForwardFold {
  id: number;
  trainingPeriod: BacktestPeriod;
  testPeriod: BacktestPeriod;
  sampleSufficient: boolean;
  metrics: BacktestMetrics;
}

export type MarketRegime = "bull" | "sideways" | "bear" | "unknown";

export interface MarketRegimeMetrics {
  regime: MarketRegime;
  tradeCount: number;
  netPnl: number;
  winRatePct: number | null;
  profitFactor: number | "infinite" | null;
}

export interface ParameterSensitivityResult {
  minimumScore: number;
  strategyVersion: string;
  evaluationScope: "research-only";
  period: BacktestPeriod;
  metrics: BacktestMetrics;
}

export interface BacktestRobustnessReport {
  walkForward: BacktestWalkForwardFold[];
  marketRegimes: MarketRegimeMetrics[];
  parameterSensitivity: ParameterSensitivityResult[];
}

export interface BacktestSignal {
  symbol: SpotSymbol;
  confirmedAtMs: number;
  validFromMs: number;
  expiresAtMs: number;
  theoreticalEntryPrice: number;
  entryLower: number;
  entryUpper: number;
  stopPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  riskReward: number;
  pullbackLow: number;
  score: number;
  strategyVersion: string;
}

export interface BacktestAnalysisEvent {
  timeMs: number;
  state: StrategyState;
  avoidReason: StrategyAvoidReason | null;
  pullbackLow: number | null;
  signal: BacktestSignal | null;
}

interface PendingOrder {
  signal: BacktestSignal;
  quantity: number;
  riskAmount: number;
  signalRiskBudget: number;
}

interface OpenPosition {
  id: string;
  signal: BacktestSignal;
  entryTimeMs: number;
  theoreticalEntryPrice: number;
  actualEntryPrice: number;
  initialQuantity: number;
  quantity: number;
  entryFeePerUnit: number;
  entrySlippageCost: number;
  entryFee: number;
  exitCosts: number;
  netPnl: number;
  exitNotional: number;
  exitedQuantity: number;
  actualRisk: number;
  remainingRisk: number;
  stopPrice: number;
  partialTaken: boolean;
  exitReason: BacktestTrade["exitReason"] | null;
}

export interface BacktestExecutionResult {
  metrics: BacktestMetrics;
  buyAndHold: BuyAndHoldMetrics;
  trades: BacktestTrade[];
}

function emptyStateCounts(): Record<StrategyState, number> {
  return { watch: 0, setup: 0, enter: 0, avoid: 0 };
}

function validateConfig(config: BacktestConfig): void {
  const fractions = [config.buyFeeRate, config.sellFeeRate, config.buySlippageRate, config.sellSlippageRate];
  const riskLimits = [
    config.maxTradeRiskFraction ?? DEFAULT_BACKTEST_CONFIG.maxTradeRiskFraction,
    config.maxPortfolioRiskFraction ?? DEFAULT_BACKTEST_CONFIG.maxPortfolioRiskFraction,
  ];
  if (!Number.isFinite(config.initialCapital) || config.initialCapital <= 0 ||
    fractions.some((value) => !Number.isFinite(value) || value < 0 || value >= 1) ||
    riskLimits.some((value) => !Number.isFinite(value) || value <= 0 || value > 1)) {
    throw new Error("回测资金、手续费、滑点或风险上限参数无效");
  }
}

function validateSeries(symbol: SpotSymbol, interval: MarketCandle["interval"], candles: readonly MarketCandle[]): void {
  const duration = intervalToMs(interval);
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]!;
    const values = [candle.open, candle.high, candle.low, candle.close, candle.volume];
    if (candle.symbol !== symbol || candle.interval !== interval || !candle.isClosed ||
      !Number.isFinite(candle.openTimeMs) || candle.closeTimeMs !== candle.openTimeMs + duration - 1 ||
      values.some((value) => !Number.isFinite(value)) || candle.open <= 0 || candle.close <= 0 ||
      candle.low <= 0 || candle.high < Math.max(candle.open, candle.close) ||
      candle.low > Math.min(candle.open, candle.close) || candle.volume < 0) {
      throw new Error(`${symbol} ${interval} 历史 K 线数据无效`);
    }
    if (index > 0) {
      const previous = candles[index - 1]!;
      if (candle.openTimeMs - previous.openTimeMs !== duration) {
        throw new Error(`${symbol} ${interval} 历史 K 线存在缺口或重复，回测标记为 invalid`);
      }
    }
  }
}

function validateAssets(assets: readonly BacktestAssetData[]): void {
  if (assets.length === 0) throw new Error("没有可回测的交易对历史数据");
  const seen = new Set<string>();
  for (const asset of assets) {
    if (seen.has(asset.symbol)) throw new Error(`回测输入重复包含 ${asset.symbol}`);
    seen.add(asset.symbol);
    validateSeries(asset.symbol, "1h", asset.candles1h);
    validateSeries(asset.symbol, "4h", asset.candles4h);
    validateSeries(asset.symbol, "1d", asset.candles1d);
  }
}

function validateAssetCoverage(asset: BacktestAssetData, endMs: number): void {
  for (const interval of ["1h", "4h", "1d"] as const) {
    const candles = asset[`candles${interval}`];
    const duration = intervalToMs(interval);
    const expectedLastOpenTimeMs = Math.floor((endMs + 1 - duration) / duration) * duration;
    const latestIndex = latestClosedIndex(candles, endMs);
    if (latestIndex < 0 || candles[latestIndex]!.openTimeMs !== expectedLastOpenTimeMs) {
      throw new Error(`${asset.symbol} ${interval} 历史行情尾部不完整，回测标记为 invalid`);
    }
  }
}

function latestClosedIndex(candles: readonly MarketCandle[], timeMs: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (candles[middle]!.closeTimeMs <= timeMs) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function buildStrategyEvents(
  asset: BacktestAssetData,
  period: BacktestPeriod,
  initialCapital: number,
): BacktestAnalysisEvent[] {
  const dailyHistory = buildIndicatorSnapshotHistory("1d", asset.candles1d);
  const fourHourHistory = buildIndicatorSnapshotHistory("4h", asset.candles4h);
  const hourlyHistory = buildIndicatorSnapshotHistory("1h", asset.candles1h);
  const events: BacktestAnalysisEvent[] = [];
  const quantityRules = { minQty: 0, maxQty: 1e12, stepSize: 1e-8 };

  for (let hourlyIndex = 0; hourlyIndex < asset.candles1h.length; hourlyIndex += 1) {
    const hourly = asset.candles1h[hourlyIndex]!;
    if (hourly.openTimeMs < period.startMs || hourly.closeTimeMs > period.endMs) continue;
    const analysisTimeMs = hourly.closeTimeMs;
    const dailyIndex = latestClosedIndex(asset.candles1d, analysisTimeMs);
    const fourHourIndex = latestClosedIndex(asset.candles4h, analysisTimeMs);
    const hourlySnapshot = hourlyHistory[hourlyIndex];
    const dailySnapshot = dailyIndex < 0 ? null : dailyHistory[dailyIndex];
    const fourHourSnapshot = fourHourIndex < 0 ? null : fourHourHistory[fourHourIndex];

    if (!hourlySnapshot || !dailySnapshot || !fourHourSnapshot) {
      events.push({ timeMs: analysisTimeMs, state: "avoid", avoidReason: "data-incomplete", pullbackLow: null, signal: null });
      continue;
    }

    const recentFourHourCandles = asset.candles4h.slice(Math.max(0, fourHourIndex - 5), fourHourIndex + 1);
    const recentFourHourHistory = fourHourHistory.slice(Math.max(0, fourHourIndex - 5), fourHourIndex + 1);
    const recentHourlyCandles = asset.candles1h.slice(Math.max(0, hourlyIndex - 3), hourlyIndex + 1);
    const recentHourlyHistory = hourlyHistory.slice(Math.max(0, hourlyIndex - 3), hourlyIndex + 1);
    const indicators = { "1d": dailySnapshot, "4h": fourHourSnapshot, "1h": hourlySnapshot };
    const trend = evaluateTrendGate(indicators);
    const pullback = evaluatePullback(recentFourHourCandles, fourHourSnapshot, recentFourHourHistory);
    const confirmation = evaluateHourlyConfirmation(recentHourlyCandles, hourlySnapshot, recentHourlyHistory);
    const supportResistance = identifySupportResistance(
      asset.candles4h.slice(Math.max(0, fourHourIndex - 59), fourHourIndex + 1),
      hourly.close,
      fourHourSnapshot.atr14,
      analysisTimeMs,
    );
    const input = {
      indicators,
      trend,
      fourHourCandles: recentFourHourCandles,
      oneHourCandles: recentHourlyCandles,
      analysisTimeMs,
      pullbackAssessment: pullback,
      hourlyConfirmation: confirmation,
    };
    // The candidate must still pass every hard confirmation gate. The score threshold is
    // applied later so sensitivity variants can reuse the same causal signal candidates.
    const preliminary = evaluateStrategy({ ...input, riskReward: 2, entryPlanStatus: null, minimumEntryScore: 0 });
    if (preliminary.state !== "enter" || pullback.lowestLow == null) {
      events.push({
        timeMs: analysisTimeMs,
        state: preliminary.state,
        avoidReason: preliminary.avoidReason,
        pullbackLow: pullback.lowestLow,
        signal: null,
      });
      continue;
    }

    const planResult = buildEntryPlan({
      referencePrice: hourly.close,
      ema20: hourlySnapshot.ema20,
      atr1h: hourlySnapshot.atr14,
      atr4h: fourHourSnapshot.atr14,
      pullbackLow: pullback.lowestLow,
      latestOneHourClose: hourly.close,
      confirmationCloseTimeMs: hourly.closeTimeMs,
      analysisTimeMs,
      currentPrice: hourly.close,
      currentPriceObservedAtMs: analysisTimeMs,
      quoteServerTimeMs: analysisTimeMs,
      quantityRules,
      nearestResistance: supportResistance.resistance,
      riskContext: { accountEquity: initialCapital, availableQuoteBalance: initialCapital },
    });
    if (!planResult.plan) {
      events.push({
        timeMs: analysisTimeMs,
        state: "avoid",
        avoidReason: "risk-reward-insufficient",
        pullbackLow: pullback.lowestLow,
        signal: null,
      });
      continue;
    }

    const strategy = evaluateStrategy({
      ...input,
      riskReward: planResult.plan.riskReward,
      // The plan is created after the confirming candle closes; the simulator
      // only evaluates fills from the next candle via validFromMs.
      entryPlanStatus: null,
      minimumEntryScore: 0,
    });
    const signal = strategy.state === "enter" ? {
      symbol: asset.symbol,
      confirmedAtMs: analysisTimeMs,
      validFromMs: planResult.plan.validFromMs,
      expiresAtMs: planResult.plan.expiresAtMs,
      theoreticalEntryPrice: planResult.plan.referencePrice,
      entryLower: planResult.plan.entryLower,
      entryUpper: planResult.plan.entryUpper,
      stopPrice: planResult.plan.stop,
      takeProfit1Price: planResult.plan.takeProfit1,
      takeProfit2Price: planResult.plan.takeProfit2,
      riskReward: planResult.plan.riskReward,
      pullbackLow: pullback.lowestLow,
      score: strategy.score,
      strategyVersion: TREND_PULLBACK_V1.version,
    } : null;
    events.push({
      timeMs: analysisTimeMs,
      state: strategy.state,
      avoidReason: strategy.avoidReason,
      pullbackLow: pullback.lowestLow,
      signal,
    });
  }
  return events;
}

function getAvailableWindow(asset: BacktestAssetData, requestedStartMs: number, requestedEndMs: number): BacktestPeriod {
  const firstDailyOpen = asset.candles1d[0]?.openTimeMs;
  const firstFourHourOpen = asset.candles4h[0]?.openTimeMs;
  const firstHourlyOpen = asset.candles1h[0]?.openTimeMs;
  const lastHourlyClose = asset.candles1h.at(-1)?.closeTimeMs;
  if (firstDailyOpen == null || firstFourHourOpen == null || firstHourlyOpen == null || lastHourlyClose == null) {
    throw new Error(`${asset.symbol} 可用历史数据不足`);
  }
  const warmupCompleteAt = firstDailyOpen + BACKTEST_WARMUP_DAILY_BARS * DAY_MS;
  const firstStatisticalBar = Math.ceil(
    Math.max(requestedStartMs, warmupCompleteAt, firstFourHourOpen, firstHourlyOpen) / HOUR_MS,
  ) * HOUR_MS;
  const first = asset.candles1h.find((candle) => candle.openTimeMs >= firstStatisticalBar);
  const last = [...asset.candles1h].reverse().find((candle) => candle.closeTimeMs <= requestedEndMs);
  if (!first || !last || first.openTimeMs >= last.closeTimeMs) {
    throw new Error(`${asset.symbol} 在暖机后没有足够的完整回测区间`);
  }
  return { startMs: first.openTimeMs, endMs: Math.min(last.closeTimeMs, lastHourlyClose) };
}

function splitPeriod(candles: readonly MarketCandle[], period: BacktestPeriod): [BacktestPeriod, BacktestPeriod] {
  const selected = candles.filter((candle) =>
    candle.openTimeMs >= period.startMs && candle.closeTimeMs <= period.endMs,
  );
  const splitIndex = Math.floor(selected.length * TRAINING_FRACTION);
  if (splitIndex < 2 || selected.length - splitIndex < 2) throw new Error("回测区间不足以进行 70/30 时间切分");
  return [
    { startMs: selected[0]!.openTimeMs, endMs: selected[splitIndex - 1]!.closeTimeMs },
    { startMs: selected[splitIndex]!.openTimeMs, endMs: selected.at(-1)!.closeTimeMs },
  ];
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

function addReason(reasons: Record<string, number>, reason: string): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

function markEquity(
  cash: number,
  positions: ReadonlyMap<SpotSymbol, OpenPosition>,
  lastPrices: ReadonlyMap<SpotSymbol, number>,
  config: BacktestConfig,
): number {
  let equity = cash;
  for (const position of positions.values()) {
    const mark = lastPrices.get(position.signal.symbol);
    if (mark != null) equity += position.quantity * mark * (1 - config.sellSlippageRate) * (1 - config.sellFeeRate);
  }
  return equity;
}

function estimateOpenRisk(
  positions: ReadonlyMap<SpotSymbol, OpenPosition>,
  pending: ReadonlyMap<SpotSymbol, PendingOrder>,
): number {
  let risk = 0;
  for (const position of positions.values()) risk += position.remainingRisk;
  for (const order of pending.values()) risk += order.riskAmount;
  return risk;
}

function makeClosedTrade(position: OpenPosition, exitTimeMs: number): BacktestTrade {
  const quantity = position.exitedQuantity;
  const averageExitPrice = quantity > 0 ? position.exitNotional / quantity : position.actualEntryPrice;
  return {
    id: position.id,
    symbol: position.signal.symbol,
    entryTimeMs: position.entryTimeMs,
    exitTimeMs,
    theoreticalEntryPrice: position.theoreticalEntryPrice,
    actualEntryPrice: position.actualEntryPrice,
    averageExitPrice,
    stopPrice: position.signal.stopPrice,
    takeProfit1Price: position.signal.takeProfit1Price,
    takeProfit2Price: position.signal.takeProfit2Price,
    quantity: position.initialQuantity,
    netPnl: position.netPnl,
    costs: position.entrySlippageCost + position.entryFee + position.exitCosts,
    actualRisk: position.actualRisk,
    actualRiskReward: position.actualRisk > 0 ? position.netPnl / position.actualRisk : null,
    holdingHours: (exitTimeMs - position.entryTimeMs) / HOUR_MS,
    exitReason: position.exitReason ?? "period-end",
    strategyVersion: position.signal.strategyVersion,
  };
}

// crypto-ai-analysis.VALIDATION.10
export function calculateAnnualizedSharpe(hourlyReturns: readonly number[]): number | null {
  if (hourlyReturns.length < 2 || hourlyReturns.some((value) => !Number.isFinite(value))) return null;
  const mean = hourlyReturns.reduce((sum, value) => sum + value, 0) / hourlyReturns.length;
  const variance = hourlyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (hourlyReturns.length - 1);
  const standardDeviation = Math.sqrt(variance);
  return standardDeviation > 0 ? mean / standardDeviation * Math.sqrt(24 * 365) : null;
}

function sellPosition(
  position: OpenPosition,
  quantity: number,
  triggerPrice: number,
  reason: BacktestTrade["exitReason"],
  cash: { value: number },
  config: BacktestConfig,
): boolean {
  const soldQuantity = Math.min(position.quantity, quantity);
  if (soldQuantity <= 0) return false;
  const actualPrice = triggerPrice * (1 - config.sellSlippageRate);
  const notional = soldQuantity * actualPrice;
  const fee = notional * config.sellFeeRate;
  const entryBasis = soldQuantity * (position.actualEntryPrice + position.entryFeePerUnit);
  cash.value += notional - fee;
  position.netPnl += notional - fee - entryBasis;
  position.exitCosts += soldQuantity * (triggerPrice - actualPrice) + fee;
  position.exitNotional += notional;
  position.exitedQuantity += soldQuantity;
  position.quantity -= soldQuantity;
  if (position.quantity <= position.initialQuantity * 1e-12) {
    position.quantity = 0;
    position.exitReason = reason;
    return true;
  }
  return false;
}

function stopFillPrice(candle: MarketCandle, stopPrice: number): number {
  return candle.open < stopPrice ? candle.open : stopPrice;
}

function processPositionBar(
  position: OpenPosition,
  candle: MarketCandle,
  cash: { value: number },
  config: BacktestConfig,
): boolean {
  if (candle.low <= position.stopPrice) {
    return sellPosition(position, position.quantity, stopFillPrice(candle, position.stopPrice),
      position.partialTaken ? "break-even" : "stop", cash, config);
  }

  if (!position.partialTaken && candle.high >= position.signal.takeProfit1Price) {
    const tpFill = Math.max(position.signal.takeProfit1Price, Math.min(candle.open, candle.high));
    const closed = sellPosition(position, position.quantity / 2, tpFill,
      "take-profit-2", cash, config);
    if (closed) return true;
    position.partialTaken = true;
    position.stopPrice = position.actualEntryPrice * (1 + config.buyFeeRate) /
      ((1 - config.sellSlippageRate) * (1 - config.sellFeeRate));
    const breakEvenProceeds = position.stopPrice * (1 - config.sellSlippageRate) * (1 - config.sellFeeRate);
    position.remainingRisk = Math.max(0,
      position.quantity * (position.actualEntryPrice + position.entryFeePerUnit - breakEvenProceeds));
    if (candle.low <= position.stopPrice) {
      return sellPosition(position, position.quantity, stopFillPrice(candle, position.stopPrice), "break-even", cash, config);
    }
  }

  if (candle.high >= position.signal.takeProfit2Price) {
    const tpFill = Math.max(position.signal.takeProfit2Price, Math.min(candle.open, candle.high));
    return sellPosition(position, position.quantity, tpFill, "take-profit-2", cash, config);
  }
  return false;
}

function fillPendingOrder(
  order: PendingOrder,
  candle: MarketCandle,
  cash: { value: number },
  config: BacktestConfig,
  id: string,
): OpenPosition | null {
  const signal = order.signal;
  if (candle.openTimeMs < signal.validFromMs || candle.openTimeMs >= signal.expiresAtMs ||
    candle.low > signal.entryUpper || candle.high < signal.entryLower) return null;

  const theoreticalFill = clamp(candle.open, signal.entryLower, signal.entryUpper);
  const actualEntryPrice = theoreticalFill * (1 + config.buySlippageRate);
  const unitEntryCost = actualEntryPrice * (1 + config.buyFeeRate);
  const unitStopProceeds = signal.stopPrice * (1 - config.sellSlippageRate) * (1 - config.sellFeeRate);
  const unitRisk = Math.max(0, unitEntryCost - unitStopProceeds);
  const affordableQuantity = cash.value / unitEntryCost;
  const riskCappedQuantity = unitRisk > 0 ? order.signalRiskBudget / unitRisk : 0;
  const quantity = Math.min(order.quantity, affordableQuantity, riskCappedQuantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;

  const entryNotional = quantity * actualEntryPrice;
  const entryFee = entryNotional * config.buyFeeRate;
  const entrySlippageCost = quantity * (actualEntryPrice - theoreticalFill);
  const actualRisk = Math.max(0, quantity * (actualEntryPrice + entryFee / quantity - unitStopProceeds));
  if (actualRisk > order.signalRiskBudget * (1 + 1e-9)) return null;
  cash.value -= entryNotional + entryFee;
  return {
    id,
    signal,
    entryTimeMs: candle.openTimeMs,
    theoreticalEntryPrice: signal.theoreticalEntryPrice,
    actualEntryPrice,
    initialQuantity: quantity,
    quantity,
    entryFeePerUnit: entryFee / quantity,
    entrySlippageCost,
    entryFee,
    exitCosts: 0,
    netPnl: 0,
    exitNotional: 0,
    exitedQuantity: 0,
    actualRisk,
    remainingRisk: actualRisk,
    stopPrice: signal.stopPrice,
    partialTaken: false,
    exitReason: null,
  };
}

function calculateMetrics(
  equityCurve: readonly { timeMs: number; equity: number }[],
  trades: readonly BacktestTrade[],
  signalCount: number,
  skippedReasons: Record<string, number>,
  strategyStateCounts: Record<StrategyState, number>,
  initialCapital: number,
  period: BacktestPeriod,
  totalCosts: number,
): BacktestMetrics {
  const endingEquity = equityCurve.at(-1)?.equity ?? initialCapital;
  let peak = initialCapital;
  let maxDrawdownPct = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - point.equity) / peak * 100);
  }
  const profits = trades.filter((trade) => trade.netPnl > 0).reduce((sum, trade) => sum + trade.netPnl, 0);
  const losses = Math.abs(trades.filter((trade) => trade.netPnl < 0).reduce((sum, trade) => sum + trade.netPnl, 0));
  const profitFactor = losses === 0 ? (profits > 0 ? "infinite" : null) : profits / losses;
  let maxConsecutiveLosses = 0;
  let consecutiveLosses = 0;
  for (const trade of trades) {
    consecutiveLosses = trade.netPnl < 0 ? consecutiveLosses + 1 : 0;
    maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutiveLosses);
  }
  const returns: number[] = [];
  for (let index = 1; index < equityCurve.length; index += 1) {
    const previous = equityCurve[index - 1]!.equity;
    const current = equityCurve[index]!.equity;
    if (previous > 0) returns.push(current / previous - 1);
  }
  const sharpeRatio = calculateAnnualizedSharpe(returns);
  const durationDays = Math.max(0, (period.endMs - period.startMs) / DAY_MS);
  const totalReturn = endingEquity / initialCapital;
  const annualizedReturnPct = durationDays > 0 && totalReturn > 0
    ? (totalReturn ** (365 / durationDays) - 1) * 100
    : null;
  const skippedSignalCount = Object.values(skippedReasons).reduce((sum, count) => sum + count, 0);
  return {
    signalCount,
    tradeCount: trades.length,
    skippedSignalCount,
    skipReasons: { ...skippedReasons },
    strategyStateCounts: { ...strategyStateCounts },
    winRatePct: trades.length ? trades.filter((trade) => trade.netPnl > 0).length / trades.length * 100 : null,
    netReturnPct: (totalReturn - 1) * 100,
    annualizedReturnPct,
    profitFactor,
    maxDrawdownPct,
    averageNetPnl: trades.length ? trades.reduce((sum, trade) => sum + trade.netPnl, 0) / trades.length : null,
    averageHoldingHours: trades.length ? trades.reduce((sum, trade) => sum + trade.holdingHours, 0) / trades.length : null,
    averageActualRiskReward: trades.length
      ? trades.reduce((sum, trade) => sum + (trade.actualRiskReward ?? 0), 0) / trades.length
      : null,
    totalCosts,
    maxConsecutiveLosses,
    sharpeRatio,
    endingEquity,
  };
}

function periodCandles(asset: BacktestAssetData, period: BacktestPeriod): MarketCandle[] {
  return asset.candles1h.filter((candle) =>
    candle.openTimeMs >= period.startMs && candle.closeTimeMs <= period.endMs,
  );
}

function calculateBuyAndHold(
  assets: readonly BacktestAssetData[],
  period: BacktestPeriod,
  config: BacktestConfig,
  strategyMetrics: BacktestMetrics,
): BuyAndHoldMetrics {
  const weight = config.initialCapital / assets.length;
  const curves = assets.map((asset) => {
    const candles = periodCandles(asset, period);
    if (candles.length === 0) return { points: [], costs: 0 };
    const first = candles[0]!;
    const buyReference = first.open;
    const entryPrice = buyReference * (1 + config.buySlippageRate);
    const quantity = weight / (entryPrice * (1 + config.buyFeeRate));
    const buyFee = quantity * entryPrice * config.buyFeeRate;
    const buySlippage = quantity * (entryPrice - buyReference);
    const points = candles.map((candle) => ({
      timeMs: candle.closeTimeMs,
      equity: Math.max(0, weight - quantity * entryPrice - buyFee) +
        quantity * candle.close * (1 - config.sellSlippageRate) * (1 - config.sellFeeRate),
    }));
    const finalReference = candles.at(-1)!.close;
    const finalSell = finalReference * (1 - config.sellSlippageRate);
    const sellFee = quantity * finalSell * config.sellFeeRate;
    const sellSlippage = quantity * (finalReference - finalSell);
    return { points, costs: buyFee + buySlippage + sellFee + sellSlippage };
  });
  const pointsByTime = new Map<number, number>();
  for (const curve of curves) {
    for (const point of curve.points) pointsByTime.set(point.timeMs, (pointsByTime.get(point.timeMs) ?? 0) + point.equity);
  }
  const curve = [...pointsByTime.entries()]
    .sort(([a], [b]) => a - b)
    .map(([timeMs, equity]) => ({ timeMs, equity }));
  const benchmark = calculateMetrics(curve, [], 0, {}, emptyStateCounts(), config.initialCapital, period,
    curves.reduce((sum, item) => sum + item.costs, 0));
  return {
    netReturnPct: benchmark.netReturnPct,
    maxDrawdownPct: benchmark.maxDrawdownPct,
    sharpeRatio: benchmark.sharpeRatio,
    netReturnDifferencePct: strategyMetrics.netReturnPct - benchmark.netReturnPct,
    maxDrawdownDifferencePct: strategyMetrics.maxDrawdownPct - benchmark.maxDrawdownPct,
    sharpeDifference: strategyMetrics.sharpeRatio == null || benchmark.sharpeRatio == null
      ? null
      : strategyMetrics.sharpeRatio - benchmark.sharpeRatio,
  };
}

// crypto-ai-analysis.VALIDATION.6 crypto-ai-analysis.VALIDATION.6-1
// crypto-ai-analysis.VALIDATION.7 crypto-ai-analysis.VALIDATION.7-1 crypto-ai-analysis.VALIDATION.8
// crypto-ai-analysis.VALIDATION.8-1 crypto-ai-analysis.VALIDATION.9 crypto-ai-analysis.VALIDATION.9-1
// crypto-ai-analysis.VALIDATION.10 crypto-ai-analysis.VALIDATION.12
export function simulateSpotExecution(
  assets: readonly BacktestAssetData[],
  analysisEvents: ReadonlyMap<SpotSymbol, readonly BacktestAnalysisEvent[]>,
  period: BacktestPeriod,
  config: BacktestConfig,
  options: { includeOpeningSignal?: boolean } = {},
): BacktestExecutionResult {
  const sortedAssets = [...assets].sort((a, b) => a.symbol.localeCompare(b.symbol));
  const eventsBySymbol = new Map<SpotSymbol, Map<number, BacktestAnalysisEvent>>();
  const barsByTime = new Map<number, Map<SpotSymbol, MarketCandle>>();
  for (const asset of sortedAssets) {
    const relevantEvents = (analysisEvents.get(asset.symbol) ?? []).filter((event) =>
      event.timeMs >= period.startMs && event.timeMs <= period.endMs,
    );
    eventsBySymbol.set(asset.symbol, new Map(relevantEvents.map((event) => [event.timeMs, event])));
    for (const candle of periodCandles(asset, period)) {
      const atTime = barsByTime.get(candle.openTimeMs) ?? new Map<SpotSymbol, MarketCandle>();
      atTime.set(asset.symbol, candle);
      barsByTime.set(candle.openTimeMs, atTime);
    }
  }

  const times = [...barsByTime.keys()].sort((a, b) => a - b);
  const cash = { value: config.initialCapital };
  const positions = new Map<SpotSymbol, OpenPosition>();
  const pending = new Map<SpotSymbol, PendingOrder>();
  const lastPrices = new Map<SpotSymbol, number>();
  const trades: BacktestTrade[] = [];
  const skippedReasons: Record<string, number> = {};
  const strategyStateCounts = emptyStateCounts();
  let signalCount = 0;
  let totalCosts = 0;
  let nextTradeId = 1;
  const equityCurve: Array<{ timeMs: number; equity: number }> = [
    { timeMs: period.startMs, equity: config.initialCapital },
  ];

  function recordAnalysisEvent(event: BacktestAnalysisEvent): void {
    strategyStateCounts[event.state] += 1;
    if (event.signal && event.state === "enter") signalCount += 1;
  }

  function queueSignal(symbol: SpotSymbol, event: BacktestAnalysisEvent): void {
    if (!event.signal || event.state !== "enter") return;
    if (positions.has(symbol)) {
      addReason(skippedReasons, "position-already-open");
      return;
    }
    if (pending.has(symbol)) {
      addReason(skippedReasons, "entry-plan-already-active");
      return;
    }
    const equity = markEquity(cash.value, positions, lastPrices, config);
    const tradeRiskLimit = equity * (config.maxTradeRiskFraction ?? DEFAULT_BACKTEST_CONFIG.maxTradeRiskFraction);
    const portfolioRiskLimit = equity * (config.maxPortfolioRiskFraction ?? DEFAULT_BACKTEST_CONFIG.maxPortfolioRiskFraction);
    const entryWorstCase = event.signal.entryUpper * (1 + config.buySlippageRate);
    const unitRisk = entryWorstCase * (1 + config.buyFeeRate) -
      event.signal.stopPrice * (1 - config.sellSlippageRate) * (1 - config.sellFeeRate);
    if (unitRisk <= 0 || cash.value <= 0) {
      addReason(skippedReasons, "insufficient-spot-balance");
      return;
    }
    const quantity = Math.min(
      tradeRiskLimit / unitRisk,
      cash.value / (entryWorstCase * (1 + config.buyFeeRate)),
    );
    const riskAmount = quantity * unitRisk;
    if (quantity <= 0 || riskAmount <= 0) {
      addReason(skippedReasons, "insufficient-spot-balance");
    } else if (estimateOpenRisk(positions, pending) + riskAmount > portfolioRiskLimit + 1e-9) {
      addReason(skippedReasons, "portfolio-risk-limit");
    } else {
      pending.set(symbol, { signal: event.signal, quantity, riskAmount, signalRiskBudget: tradeRiskLimit });
    }
  }

  // crypto-ai-analysis.VALIDATION.15-3
  const openingSignals = options.includeOpeningSignal ? sortedAssets.flatMap((asset) => {
    const firstCandle = periodCandles(asset, period)[0];
    if (!firstCandle) return [];
    const priorEvents = [...(analysisEvents.get(asset.symbol) ?? [])]
      .filter((event) => event.timeMs < firstCandle.openTimeMs)
      .sort((a, b) => a.timeMs - b.timeMs);
    const openingEvent = [...priorEvents].reverse().find((event) =>
      event.state === "enter" && event.signal && event.signal.validFromMs <= firstCandle.openTimeMs &&
      event.signal.expiresAtMs > firstCandle.openTimeMs &&
      !priorEvents.some((later) => later.timeMs > event.timeMs && later.state === "avoid" &&
        later.avoidReason !== "confirmation-score-insufficient"),
    );
    return openingEvent
      ? [{ symbol: asset.symbol, event: openingEvent }]
      : [];
  }).sort((a, b) => a.event.timeMs - b.event.timeMs || a.symbol.localeCompare(b.symbol)) : [];
  for (const item of openingSignals) {
    recordAnalysisEvent(item.event);
    queueSignal(item.symbol, item.event);
  }

  for (const openTimeMs of times) {
    const bars = barsByTime.get(openTimeMs)!;
    for (const asset of sortedAssets) {
      const candle = bars.get(asset.symbol);
      if (!candle) continue;
      lastPrices.set(asset.symbol, candle.close);
      const position = positions.get(asset.symbol);
      if (position && processPositionBar(position, candle, cash, config)) {
        totalCosts += position.entrySlippageCost + position.entryFee + position.exitCosts;
        trades.push(makeClosedTrade(position, candle.closeTimeMs));
        positions.delete(asset.symbol);
      }

      const activeOrder = pending.get(asset.symbol);
      if (activeOrder) {
        if (candle.openTimeMs >= activeOrder.signal.expiresAtMs) {
          pending.delete(asset.symbol);
          addReason(skippedReasons, "entry-plan-expired");
        } else {
          const positionFromFill = fillPendingOrder(activeOrder, candle, cash, config, `bt-${nextTradeId}`);
          if (positionFromFill) {
            nextTradeId += 1;
            pending.delete(asset.symbol);
            positions.set(asset.symbol, positionFromFill);
            if (processPositionBar(positionFromFill, candle, cash, config)) {
              totalCosts += positionFromFill.entrySlippageCost + positionFromFill.entryFee + positionFromFill.exitCosts;
              trades.push(makeClosedTrade(positionFromFill, candle.closeTimeMs));
              positions.delete(asset.symbol);
            }
          }
        }
      }
    }

    const eventTimeMs = openTimeMs + HOUR_MS - 1;
    for (const asset of sortedAssets) {
      const event = eventsBySymbol.get(asset.symbol)?.get(eventTimeMs);
      if (!event) continue;
      recordAnalysisEvent(event);
      const pendingOrder = pending.get(asset.symbol);
      if (pendingOrder && (event.state === "avoid" ||
        (event.pullbackLow != null && (bars.get(asset.symbol)?.close ?? Infinity) < event.pullbackLow))) {
        pending.delete(asset.symbol);
        addReason(skippedReasons, "entry-plan-invalidated");
      }
      if (!event.signal || event.state !== "enter") continue;
      queueSignal(asset.symbol, event);
    }

    equityCurve.push({
      timeMs: eventTimeMs,
      equity: markEquity(cash.value, positions, lastPrices, config),
    });
  }

  const finalTimeMs = times.length ? times.at(-1)! + HOUR_MS - 1 : period.endMs;
  for (const [symbol, position] of positions) {
    const lastPrice = lastPrices.get(symbol);
    if (lastPrice == null) continue;
    const theoreticalExit = lastPrice;
    sellPosition(position, position.quantity, theoreticalExit, "period-end", cash, config);
    position.exitReason = "period-end";
    totalCosts += position.entrySlippageCost + position.entryFee + position.exitCosts;
    trades.push(makeClosedTrade(position, finalTimeMs));
  }
  for (let index = 0; index < pending.size; index += 1) addReason(skippedReasons, "window-ended-before-entry");
  const endingEquity = cash.value;
  if (equityCurve.length) equityCurve[equityCurve.length - 1] = { timeMs: finalTimeMs, equity: endingEquity };

  const metrics = calculateMetrics(
    equityCurve,
    trades,
    signalCount,
    skippedReasons,
    strategyStateCounts,
    config.initialCapital,
    period,
    totalCosts,
  );
  const buyAndHold = calculateBuyAndHold(assets, period, config, metrics);
  return { metrics, buyAndHold, trades };
}

function toPeriodResult(
  assets: readonly BacktestAssetData[],
  analysisEvents: ReadonlyMap<SpotSymbol, readonly BacktestAnalysisEvent[]>,
  period: BacktestPeriod,
  config: BacktestConfig,
): BacktestPeriodResult {
  const result = simulateSpotExecution(assets, analysisEvents, period, config);
  return { period, ...result };
}

function makeSymbolWindows(
  asset: BacktestAssetData,
  requestedPeriod: BacktestPeriod,
): [BacktestPeriod, BacktestPeriod] {
  const available = getAvailableWindow(asset, requestedPeriod.startMs, requestedPeriod.endMs);
  return splitPeriod(asset.candles1h, available);
}

function applyEntryScoreThreshold(
  candidates: ReadonlyMap<SpotSymbol, readonly BacktestAnalysisEvent[]>,
  minimumScore: number,
  strategyVersion: string,
): Map<SpotSymbol, readonly BacktestAnalysisEvent[]> {
  return new Map([...candidates].map(([symbol, events]) => [symbol, events.map((event) => {
    if (event.state !== "enter" || !event.signal) return event;
    const signal = { ...event.signal, strategyVersion };
    return event.signal.score < minimumScore
      ? { ...event, state: "avoid" as const, avoidReason: "confirmation-score-insufficient" as const, signal }
      : { ...event, state: "enter" as const, avoidReason: null, signal };
  })]));
}

function buildWalkForwardFolds(
  asset: BacktestAssetData,
  assets: readonly BacktestAssetData[],
  analysisEvents: ReadonlyMap<SpotSymbol, readonly BacktestAnalysisEvent[]>,
  researchPeriod: BacktestPeriod,
  outOfSamplePeriod: BacktestPeriod,
  config: BacktestConfig,
): BacktestWalkForwardFold[] {
  const candles = periodCandles(asset, outOfSamplePeriod);
  return [0, 1, 2].map((foldIndex) => {
    const fromIndex = Math.floor(candles.length * foldIndex / 3);
    const toIndex = Math.floor(candles.length * (foldIndex + 1) / 3);
    const first = candles[fromIndex];
    const last = toIndex > fromIndex ? candles[toIndex - 1] : null;
    const testStartMs = first?.openTimeMs ?? (candles[fromIndex - 1]?.closeTimeMs ?? outOfSamplePeriod.startMs - 1) + 1;
    const testPeriod = {
      startMs: testStartMs,
      endMs: last?.closeTimeMs ?? testStartMs - 1,
    };
    const execution = simulateSpotExecution(assets, analysisEvents, testPeriod, config, {
      includeOpeningSignal: true,
    });
    return {
      id: foldIndex + 1,
      trainingPeriod: { startMs: researchPeriod.startMs, endMs: testStartMs - 1 },
      testPeriod,
      sampleSufficient: execution.metrics.tradeCount >= 100,
      metrics: execution.metrics,
    };
  });
}

function classifySnapshotRegime(snapshot: ReturnType<typeof buildIndicatorSnapshotHistory>[number]): MarketRegime {
  if (!snapshot?.ema200) return "unknown";
  if (snapshot.close > snapshot.ema200 && snapshot.ema50 > snapshot.ema200) return "bull";
  if (snapshot.close < snapshot.ema200 && snapshot.ema50 < snapshot.ema200) return "bear";
  return "sideways";
}

// crypto-ai-analysis.VALIDATION.16 crypto-ai-analysis.VALIDATION.16-1
export function classifyMarketRegimeAt(candles: readonly MarketCandle[], timeMs: number): MarketRegime {
  if (!Number.isFinite(timeMs)) return "unknown";
  const closedCandles = candles
    .filter((candle) => candle.isClosed && candle.closeTimeMs <= timeMs)
    .sort((a, b) => a.openTimeMs - b.openTimeMs);
  const snapshots = buildIndicatorSnapshotHistory("1d", closedCandles);
  return classifySnapshotRegime(snapshots.at(-1) ?? null);
}

function summarizeMarketRegimes(
  trades: readonly BacktestTrade[],
  benchmarkCandles: readonly MarketCandle[],
): MarketRegimeMetrics[] {
  const snapshots = buildIndicatorSnapshotHistory("1d", benchmarkCandles);
  const groups = new Map<MarketRegime, BacktestTrade[]>([
    ["bull", []], ["sideways", []], ["bear", []], ["unknown", []],
  ]);
  for (const trade of trades) {
    const candleIndex = latestClosedIndex(benchmarkCandles, trade.entryTimeMs);
    const regime = classifySnapshotRegime(candleIndex < 0 ? null : snapshots[candleIndex] ?? null);
    groups.get(regime)!.push(trade);
  }
  return (["bull", "sideways", "bear", "unknown"] as const).map((regime) => {
    const grouped = groups.get(regime)!;
    const profits = grouped.filter((trade) => trade.netPnl > 0).reduce((sum, trade) => sum + trade.netPnl, 0);
    const losses = Math.abs(grouped.filter((trade) => trade.netPnl < 0).reduce((sum, trade) => sum + trade.netPnl, 0));
    return {
      regime,
      tradeCount: grouped.length,
      netPnl: grouped.reduce((sum, trade) => sum + trade.netPnl, 0),
      winRatePct: grouped.length ? grouped.filter((trade) => trade.netPnl > 0).length / grouped.length * 100 : null,
      profitFactor: losses === 0 ? (profits > 0 ? "infinite" : null) : profits / losses,
    };
  });
}

// crypto-ai-analysis.VALIDATION.15 crypto-ai-analysis.VALIDATION.15-1 crypto-ai-analysis.VALIDATION.15-2
// crypto-ai-analysis.VALIDATION.17 crypto-ai-analysis.VALIDATION.17-1
function buildRobustnessReport(
  assets: readonly BacktestAssetData[],
  candidateEvents: ReadonlyMap<SpotSymbol, readonly BacktestAnalysisEvent[]>,
  baselineEvents: ReadonlyMap<SpotSymbol, readonly BacktestAnalysisEvent[]>,
  researchPeriod: BacktestPeriod,
  outOfSamplePeriod: BacktestPeriod,
  portfolioResearchResult: BacktestPeriodResult,
  portfolioOutOfSampleResult: BacktestPeriodResult,
  config: BacktestConfig,
): BacktestRobustnessReport {
  const btc = assets.find((asset) => asset.symbol === "BTCUSDT");
  const thresholds = [65, 70, 75] as const;
  return {
    walkForward: buildWalkForwardFolds(
      assets[0]!, assets, baselineEvents, researchPeriod, outOfSamplePeriod, config,
    ),
    marketRegimes: summarizeMarketRegimes(
      portfolioOutOfSampleResult.trades,
      btc?.candles1d ?? [],
    ),
    parameterSensitivity: thresholds.map((minimumScore) => {
      const strategyVersion = minimumScore === 70
        ? TREND_PULLBACK_V1.version
        : `${TREND_PULLBACK_V1.version}-score-${minimumScore}`;
      const events = minimumScore === 70
        ? baselineEvents
        : applyEntryScoreThreshold(candidateEvents, minimumScore, strategyVersion);
      const result = minimumScore === 70
        ? portfolioResearchResult
        : toPeriodResult(assets, events, researchPeriod, config);
      return {
        minimumScore,
        strategyVersion,
        evaluationScope: "research-only",
        period: researchPeriod,
        metrics: result.metrics,
      };
    }),
  };
}

function profitFactorAtLeast(value: number | "infinite" | null, threshold: number): boolean {
  return value === "infinite" || (typeof value === "number" && value >= threshold);
}

// crypto-ai-analysis.VALIDATION.13
export function countSymbolsMeetingProfitFactor(
  assets: readonly BacktestAssetData[],
  analysisEvents: ReadonlyMap<SpotSymbol, readonly BacktestAnalysisEvent[]>,
  period: BacktestPeriod,
  config: BacktestConfig,
): number {
  const assetsBySymbol = new Map(assets.map((asset) => [asset.symbol, asset]));
  return SUPPORTED_SPOT_SYMBOLS.filter((symbol) => {
    const asset = assetsBySymbol.get(symbol);
    if (!asset) return false;
    const profitFactor = toPeriodResult([asset], analysisEvents, period, config).metrics.profitFactor;
    return profitFactorAtLeast(profitFactor, 1);
  }).length;
}

// crypto-ai-analysis.VALIDATION.1 crypto-ai-analysis.VALIDATION.2 crypto-ai-analysis.VALIDATION.4
// crypto-ai-analysis.VALIDATION.4-1 crypto-ai-analysis.VALIDATION.5 crypto-ai-analysis.VALIDATION.5-1
// crypto-ai-analysis.VALIDATION.6 crypto-ai-analysis.VALIDATION.6-1 crypto-ai-analysis.VALIDATION.7
// crypto-ai-analysis.VALIDATION.7-1 crypto-ai-analysis.VALIDATION.8 crypto-ai-analysis.VALIDATION.8-1
// crypto-ai-analysis.VALIDATION.9 crypto-ai-analysis.VALIDATION.9-1 crypto-ai-analysis.VALIDATION.10
// crypto-ai-analysis.VALIDATION.11 crypto-ai-analysis.VALIDATION.11-1 crypto-ai-analysis.VALIDATION.12
// crypto-ai-analysis.VALIDATION.12-1 crypto-ai-analysis.VALIDATION.13 crypto-ai-analysis.VALIDATION.13-1
// crypto-ai-analysis.VALIDATION.14 crypto-ai-analysis.VALIDATION.14-1
export function runCryptoBacktest(
  assetsInput: readonly BacktestAssetData[],
  configInput: BacktestConfig,
  requestedPeriod: BacktestPeriod,
): CryptoBacktestReport {
  validateConfig(configInput);
  validateAssets(assetsInput);
  if (!Number.isFinite(requestedPeriod.startMs) || !Number.isFinite(requestedPeriod.endMs) ||
    requestedPeriod.startMs >= requestedPeriod.endMs) throw new Error("回测历史区间无效");
  for (const asset of assetsInput) validateAssetCoverage(asset, requestedPeriod.endMs);

  const config: BacktestConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    ...configInput,
    maxTradeRiskFraction: configInput.maxTradeRiskFraction ?? DEFAULT_BACKTEST_CONFIG.maxTradeRiskFraction,
    maxPortfolioRiskFraction: configInput.maxPortfolioRiskFraction ?? DEFAULT_BACKTEST_CONFIG.maxPortfolioRiskFraction,
  };
  const assets = [...assetsInput].sort((a, b) => a.symbol.localeCompare(b.symbol));
  const symbolWindows = new Map<SpotSymbol, [BacktestPeriod, BacktestPeriod]>();
  for (const asset of assets) symbolWindows.set(asset.symbol, makeSymbolWindows(asset, requestedPeriod));

  const symbols: Partial<Record<SpotSymbol, BacktestSymbolResult>> = {};
  const candidateEvents = new Map<SpotSymbol, readonly BacktestAnalysisEvent[]>();
  for (const asset of assets) {
    const [researchPeriod, outOfSamplePeriod] = symbolWindows.get(asset.symbol)!;
    candidateEvents.set(asset.symbol, buildStrategyEvents(asset, {
      startMs: researchPeriod.startMs,
      endMs: outOfSamplePeriod.endMs,
    }, config.initialCapital));
  }
  const analysisEvents = applyEntryScoreThreshold(candidateEvents, 70, TREND_PULLBACK_V1.version);
  for (const asset of assets) {
    const [researchPeriod, outOfSamplePeriod] = symbolWindows.get(asset.symbol)!;
    symbols[asset.symbol] = {
      research: toPeriodResult([asset], analysisEvents, researchPeriod, config),
      outOfSample: toPeriodResult([asset], analysisEvents, outOfSamplePeriod, config),
    };
  }

  const commonStartMs = Math.max(...[...symbolWindows.values()].map(([research]) => research.startMs));
  const commonEndMs = Math.min(...[...symbolWindows.values()].map(([, outOfSample]) => outOfSample.endMs));
  const commonPeriod = { startMs: commonStartMs, endMs: commonEndMs };
  const [portfolioResearchPeriod, portfolioOutOfSamplePeriod] = splitPeriod(assets[0]!.candles1h, commonPeriod);
  const portfolio = {
    research: toPeriodResult(assets, analysisEvents, portfolioResearchPeriod, config),
    outOfSample: toPeriodResult(assets, analysisEvents, portfolioOutOfSamplePeriod, config),
  };
  const robustness = buildRobustnessReport(
    assets,
    candidateEvents,
    analysisEvents,
    portfolioResearchPeriod,
    portfolioOutOfSamplePeriod,
    portfolio.research,
    portfolio.outOfSample,
    config,
  );
  const outOfSample = portfolio.outOfSample.metrics;
  // crypto-ai-analysis.VALIDATION.14-2
  const validityChecks = {
    closedCandlesOnly: assets.every((asset) =>
      [...asset.candles1h, ...asset.candles4h, ...asset.candles1d]
        .filter((candle) => candle.closeTimeMs <= requestedPeriod.endMs)
        .every((candle) => candle.isClosed),
    ),
    nextBarExecution: [...candidateEvents.values()].flat().every((event) =>
      !event.signal || (event.signal.confirmedAtMs === event.timeMs &&
        event.signal.validFromMs === event.signal.confirmedAtMs + 1),
    ),
    deterministicEngine: false,
  };
  const deterministicReplay = simulateSpotExecution(assets, analysisEvents, portfolioOutOfSamplePeriod, config);
  validityChecks.deterministicEngine = JSON.stringify({ period: portfolio.outOfSample.period, ...deterministicReplay }) ===
    JSON.stringify(portfolio.outOfSample);
  const perSymbolProfitFactorCount = countSymbolsMeetingProfitFactor(
    assets,
    analysisEvents,
    portfolioOutOfSamplePeriod,
    config,
  );
  const validityPassed = Object.values(validityChecks).every(Boolean);
  const researchUsable = validityPassed && assets.length === SUPPORTED_SPOT_SYMBOLS.length &&
    assets.every((asset) => SUPPORTED_SPOT_SYMBOLS.includes(asset.symbol)) &&
    outOfSample.tradeCount >= 100 && profitFactorAtLeast(outOfSample.profitFactor, 1.1) &&
    outOfSample.maxDrawdownPct <= 25 && outOfSample.netReturnPct > 0 &&
    perSymbolProfitFactorCount >= 4;

  return {
    strategyVersion: TREND_PULLBACK_V1.version,
    // crypto-ai-analysis.VALIDATION.18-1
    costAssumptions: {
      buyFeeRate: config.buyFeeRate,
      sellFeeRate: config.sellFeeRate,
      buySlippageRate: config.buySlippageRate,
      sellSlippageRate: config.sellSlippageRate,
    },
    status: !validityPassed ? "invalid" : researchUsable ? "research-usable" : "experimental",
    statusReason: !validityPassed
      ? "回测有效性检查未通过，结果无效，不可用于模拟订单。"
      : researchUsable
      ? "样本外组合达到继续模拟研究的门槛；这不代表适合真实交易或保证未来收益。"
      : "样本外结果未达到全部研究可用门槛，或样本量不足；仅供继续验证。",
    generatedAtMs: requestedPeriod.endMs,
    requestedPeriod,
    symbols,
    portfolio,
    robustness,
    validityChecks,
  };
}
