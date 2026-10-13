import { DEFAULT_BACKTEST_CONFIG } from "./backtest.ts";
import type { BacktestCostAssumptions } from "./backtest.ts";
import type { AnalysisAttempt } from "./pipeline.ts";
import { getSpotQuoteFailure, type EntryPlan } from "./strategy.ts";
import { intervalToMs, isSpotSymbol, type MarketCandle, type MarketDataRestAdapter, type SpotSymbol } from "../market-data/types.ts";

export const CRYPTO_PAPER_LEDGER_KEY = "opencharts.crypto.paper-ledger.v1";
export const CRYPTO_PAPER_INITIAL_CAPITAL = 10_000;
const HOUR_MS = intervalToMs("1h");
const DEFAULT_COST_ASSUMPTIONS: BacktestCostAssumptions = {
  buyFeeRate: DEFAULT_BACKTEST_CONFIG.buyFeeRate,
  sellFeeRate: DEFAULT_BACKTEST_CONFIG.sellFeeRate,
  buySlippageRate: DEFAULT_BACKTEST_CONFIG.buySlippageRate,
  sellSlippageRate: DEFAULT_BACKTEST_CONFIG.sellSlippageRate,
};

export type PaperOrderStatus = "pending" | "open" | "closed" | "cancelled" | "expired";
export type PaperExitReason = "stop" | "break-even" | "take-profit-2";
export type BacktestResearchStatus = "research-usable" | "experimental" | "invalid" | null;

export interface PaperOrder {
  id: string;
  symbol: SpotSymbol;
  status: PaperOrderStatus;
  snapshotId: string;
  strategyVersion: string;
  backtestStatus: Exclude<BacktestResearchStatus, null>;
  costAssumptions: BacktestCostAssumptions;
  createdAtMs: number;
  updatedAtMs: number;
  analysisTimeMs: number;
  validFromMs: number;
  expiresAtMs: number;
  referencePrice: number;
  entryLower: number;
  entryUpper: number;
  stopPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  riskReward: number;
  pullbackLow: number;
  quantity: number;
  remainingQuantity: number;
  riskAmount: number;
  reservedQuote: number;
  fillTimeMs: number | null;
  actualEntryPrice: number | null;
  entryFee: number;
  entrySlippage: number;
  exitFees: number;
  exitSlippage: number;
  realizedNetPnl: number;
  averageExitPrice: number | null;
  exitedQuantity: number;
  partialTaken: boolean;
  activeStopPrice: number;
  exitReason: PaperExitReason | null;
  closedAtMs: number | null;
}

export interface PaperTradingEvent {
  id: string;
  kind: "signal" | "order-created" | "order-cancelled" | "order-expired" | "fill" |
    "take-profit-1" | "take-profit-2" | "stop" | "break-even" | "data-gap" | "data-restored" |
    "runtime-error" | "runtime-shutdown";
  symbol: SpotSymbol;
  timeMs: number;
  snapshotId: string | null;
  strategyVersion: string | null;
  orderId?: string;
  price: number | null;
  fee: number | null;
  slippage: number | null;
  reason?: string;
}

type PaperTradingEventInput = Omit<PaperTradingEvent, "snapshotId" | "strategyVersion" | "price" | "fee" | "slippage"> &
  Partial<Pick<PaperTradingEvent, "snapshotId" | "strategyVersion" | "price" | "fee" | "slippage">>;

export interface PaperLedgerState {
  schemaVersion: 1;
  initialCapital: number;
  cash: number;
  orders: PaperOrder[];
  events: PaperTradingEvent[];
  lastProcessedOpenTimeMs: Partial<Record<SpotSymbol, number>>;
  lastAnalyzedOpenTimeMs: Partial<Record<SpotSymbol, number>>;
  lastPrices: Partial<Record<SpotSymbol, number>>;
  pausedSymbols: Partial<Record<SpotSymbol, string>>;
}

export interface PaperOrderDraft {
  symbol: SpotSymbol;
  snapshotId: string;
  strategyVersion: string;
  backtestStatus: Exclude<BacktestResearchStatus, null>;
  costAssumptions: BacktestCostAssumptions;
  analysisTimeMs: number;
  validFromMs: number;
  expiresAtMs: number;
  referencePrice: number;
  entryLower: number;
  entryUpper: number;
  stopPrice: number;
  takeProfit1Price: number;
  takeProfit2Price: number;
  riskReward: number;
  pullbackLow: number;
  quantity: number;
  riskAmount: number;
  estimatedCosts: number;
}

export interface PaperLedgerOptions {
  storage?: Pick<Storage, "getItem" | "setItem">;
  now?: () => number;
  afterCandle?: (candle: MarketCandle) => Promise<void>;
}

export interface PaperCostComparison {
  simulatedFees: number;
  expectedFees: number;
  feeDifference: number;
  simulatedSlippage: number;
  expectedSlippage: number;
  slippageDifference: number;
}

function emptyState(): PaperLedgerState {
  return {
    schemaVersion: 1,
    initialCapital: CRYPTO_PAPER_INITIAL_CAPITAL,
    cash: CRYPTO_PAPER_INITIAL_CAPITAL,
    orders: [],
    events: [],
    lastProcessedOpenTimeMs: {},
    lastAnalyzedOpenTimeMs: {},
    lastPrices: {},
    pausedSymbols: {},
  };
}

function validLedger(value: unknown): value is PaperLedgerState {
  if (value == null || typeof value !== "object") return false;
  const ledger = value as Partial<PaperLedgerState>;
  return ledger.schemaVersion === 1 && Number.isFinite(ledger.initialCapital) && ledger.initialCapital! > 0 &&
    Number.isFinite(ledger.cash) && ledger.cash! >= 0 && Array.isArray(ledger.orders) &&
    Array.isArray(ledger.events) && ledger.lastProcessedOpenTimeMs != null &&
    typeof ledger.lastProcessedOpenTimeMs === "object" && ledger.lastPrices != null &&
    typeof ledger.lastPrices === "object" && ledger.pausedSymbols != null && typeof ledger.pausedSymbols === "object" &&
    (ledger.lastAnalyzedOpenTimeMs == null || typeof ledger.lastAnalyzedOpenTimeMs === "object");
}

function cloneState(state: PaperLedgerState): PaperLedgerState {
  return JSON.parse(JSON.stringify(state)) as PaperLedgerState;
}

function activeForSymbol(state: PaperLedgerState, symbol: SpotSymbol): PaperOrder | undefined {
  return state.orders.find((order) => order.symbol === symbol && (order.status === "pending" || order.status === "open"));
}

function openOrders(state: PaperLedgerState): PaperOrder[] {
  return state.orders.filter((order) => order.status === "pending" || order.status === "open");
}

function validCostAssumptions(value: unknown): value is BacktestCostAssumptions {
  if (!value || typeof value !== "object") return false;
  const assumptions = value as BacktestCostAssumptions;
  return [assumptions.buyFeeRate, assumptions.sellFeeRate,
    assumptions.buySlippageRate, assumptions.sellSlippageRate]
    .every((rate) => Number.isFinite(rate) && rate >= 0 && rate < 1);
}

function unitRisk(entryUpper: number, stop: number, assumptions: BacktestCostAssumptions): number {
  const entry = entryUpper * (1 + assumptions.buySlippageRate);
  const exit = stop * (1 - assumptions.sellSlippageRate);
  return entry * (1 + assumptions.buyFeeRate) - exit * (1 - assumptions.sellFeeRate);
}

function riskExposure(state: PaperLedgerState): number {
  return openOrders(state).reduce((sum, order) => sum + order.riskAmount, 0);
}

function accountEquity(state: PaperLedgerState): number {
  return state.orders.filter((order) => order.status === "open").reduce((equity, order) => {
    const mark = state.lastPrices[order.symbol] ?? order.actualEntryPrice ?? order.referencePrice;
    const costs = order.costAssumptions;
    return equity + order.remainingQuantity * mark *
      (1 - costs.sellSlippageRate) * (1 - costs.sellFeeRate);
  }, state.cash);
}

function availableQuote(state: PaperLedgerState): number {
  const reserved = openOrders(state).filter((order) => order.status === "pending")
    .reduce((sum, order) => sum + order.reservedQuote, 0);
  return Math.max(0, state.cash - reserved);
}

function addEvent(state: PaperLedgerState, event: PaperTradingEventInput): void {
  if (state.events.some((item) => item.id === event.id)) return;
  state.events.push({
    snapshotId: null,
    strategyVersion: null,
    price: null,
    fee: null,
    slippage: null,
    ...event,
    reason: event.reason == null ? event.reason : sanitizeDiagnosticText(event.reason),
  });
}

function sanitizeDiagnosticText(value: unknown): string {
  return String(value)
    .replace(/[\r\n]+/g, " ")
    .replace(/(?:Bearer\s+|(?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "[redacted]")
    .replace(/(?:file:\/\/|\/(?:Users|home|private|tmp|var)\/|[A-Za-z]:\\)[^\s]+/g, "[redacted-path]")
    .slice(0, 500);
}

function getPlan(attempt: AnalysisAttempt, now: number): EntryPlan {
  const plan = attempt.entryPlan;
  const quoteFailure = getSpotQuoteFailure(
    attempt.currentPrice,
    attempt.currentPriceObservedAtMs,
    attempt.currentPriceServerTimeMs,
    now,
  );
  if (attempt.status !== "ready" || attempt.strategy?.state !== "enter" || !plan ||
    (plan.status !== "active" && plan.status !== "waiting-for-price") || quoteFailure ||
    !attempt.snapshotId || attempt.analysisTimeMs == null || plan.expiresAtMs <= now ||
    plan.riskReward < 2 || plan.stop >= plan.entryLower || plan.suggestedQuantity <= 0 ||
    ![plan.entryLower, plan.entryUpper, plan.stop, plan.takeProfit1, plan.takeProfit2,
      plan.suggestedQuantity, plan.estimatedStopRisk].every(Number.isFinite)) {
    throw new Error("当前分析不满足模拟订单创建条件");
  }
  return plan;
}

function buildDraft(
  state: PaperLedgerState,
  attempt: AnalysisAttempt,
  backtestStatus: BacktestResearchStatus,
  now: number,
  costAssumptions: BacktestCostAssumptions = DEFAULT_COST_ASSUMPTIONS,
): PaperOrderDraft {
  const plan = getPlan(attempt, now);
  if (backtestStatus == null || backtestStatus === "invalid") {
    throw new Error("请先完成有效回测；invalid 回测禁止创建模拟订单");
  }
  if (activeForSymbol(state, attempt.symbol)) throw new Error("该币种已有未成交订单或未平仓仓位");
  if (state.pausedSymbols[attempt.symbol]) throw new Error("该币种前向模拟已暂停，需先恢复行情");

  const equity = accountEquity(state);
  const tradeRiskLimit = equity * DEFAULT_BACKTEST_CONFIG.maxTradeRiskFraction!;
  const portfolioRiskLimit = equity * DEFAULT_BACKTEST_CONFIG.maxPortfolioRiskFraction!;
  if (!validCostAssumptions(costAssumptions)) throw new Error("回测成本假设无效");
  const perUnitRisk = unitRisk(plan.entryUpper, plan.stop, costAssumptions);
  const reservePerUnit = plan.entryUpper * (1 + costAssumptions.buySlippageRate) *
    (1 + costAssumptions.buyFeeRate);
  const maxQuantityByRisk = tradeRiskLimit / perUnitRisk;
  const maxQuantityByCash = availableQuote(state) / reservePerUnit;
  const step = plan.quantityRules.stepSize;
  const rawQuantity = Math.min(plan.suggestedQuantity, maxQuantityByRisk, maxQuantityByCash, plan.quantityRules.maxQty);
  const quantity = Math.floor(rawQuantity / step + Number.EPSILON * 8) * step;
  const riskAmount = quantity * perUnitRisk;
  const reservedQuote = quantity * reservePerUnit;
  if (!Number.isFinite(quantity) || quantity < plan.quantityRules.minQty || riskAmount <= 0 ||
    riskAmount > tradeRiskLimit + 1e-8 || reservedQuote > availableQuote(state) + 1e-8 ||
    riskExposure(state) + riskAmount > portfolioRiskLimit + 1e-8) {
    throw new Error("模拟账户资金或单笔/组合风险限制不满足");
  }
  const estimatedEntryCosts = quantity * (plan.entryUpper * costAssumptions.buySlippageRate +
    plan.entryUpper * (1 + costAssumptions.buySlippageRate) * costAssumptions.buyFeeRate);
  const estimatedExitCosts = quantity * (plan.stop * costAssumptions.sellSlippageRate +
    plan.stop * (1 - costAssumptions.sellSlippageRate) * costAssumptions.sellFeeRate);
  return {
    symbol: attempt.symbol,
    snapshotId: attempt.snapshotId!,
    strategyVersion: attempt.strategyVersion,
    backtestStatus,
    costAssumptions: { ...costAssumptions },
    analysisTimeMs: attempt.analysisTimeMs!,
    validFromMs: plan.validFromMs,
    expiresAtMs: plan.expiresAtMs,
    referencePrice: plan.referencePrice,
    entryLower: plan.entryLower,
    entryUpper: plan.entryUpper,
    stopPrice: plan.stop,
    takeProfit1Price: plan.takeProfit1,
    takeProfit2Price: plan.takeProfit2,
    riskReward: plan.riskReward,
    pullbackLow: plan.pullbackLow,
    quantity,
    riskAmount,
    estimatedCosts: estimatedEntryCosts + estimatedExitCosts,
  };
}

function appendOrderEvent(
  state: PaperLedgerState,
  kind: PaperTradingEvent["kind"],
  order: PaperOrder,
  timeMs: number,
  extra: Partial<PaperTradingEvent> = {},
): void {
  addEvent(state, {
    id: `${order.id}:${kind}:${timeMs}`,
    kind,
    symbol: order.symbol,
    timeMs,
    snapshotId: order.snapshotId,
    strategyVersion: order.strategyVersion,
    orderId: order.id,
    ...extra,
  });
}

function sellQuantity(
  state: PaperLedgerState,
  order: PaperOrder,
  requestedQuantity: number,
  triggerPrice: number,
  timeMs: number,
  reason: PaperExitReason,
): void {
  const quantity = Math.min(order.remainingQuantity, requestedQuantity);
  if (quantity <= 0 || order.actualEntryPrice == null) return;
  const costs = order.costAssumptions;
  const actualPrice = triggerPrice * (1 - costs.sellSlippageRate);
  const notional = quantity * actualPrice;
  const fee = notional * costs.sellFeeRate;
  const entryBasis = quantity * (order.actualEntryPrice + order.entryFee / order.quantity);
  const slippage = quantity * (triggerPrice - actualPrice);
  state.cash += notional - fee;
  order.realizedNetPnl += notional - fee - entryBasis;
  order.exitFees += fee;
  order.exitSlippage += slippage;
  order.averageExitPrice = ((order.averageExitPrice ?? 0) * order.exitedQuantity + notional) /
    (order.exitedQuantity + quantity);
  order.exitedQuantity += quantity;
  order.remainingQuantity -= quantity;
  order.updatedAtMs = timeMs;
  if (order.remainingQuantity <= order.quantity * 1e-12) {
    order.remainingQuantity = 0;
    order.status = "closed";
    order.exitReason = reason;
    order.closedAtMs = timeMs;
    order.riskAmount = 0;
    order.reservedQuote = 0;
    appendOrderEvent(state, reason === "stop" ? "stop" : reason === "break-even" ? "break-even" : "take-profit-2", order, timeMs, {
      price: actualPrice, fee, slippage,
    });
  }
}

function processOpenPosition(state: PaperLedgerState, order: PaperOrder, candle: MarketCandle): void {
  const costs = order.costAssumptions;
  if (candle.low <= order.activeStopPrice) {
    const fill = candle.open < order.activeStopPrice ? candle.open : order.activeStopPrice;
    sellQuantity(state, order, order.remainingQuantity, fill, candle.closeTimeMs,
      order.partialTaken ? "break-even" : "stop");
    return;
  }
  if (!order.partialTaken && candle.high >= order.takeProfit1Price) {
    const trigger = Math.max(order.takeProfit1Price, Math.min(candle.open, candle.high));
    const partialQuantity = order.remainingQuantity / 2;
    const previousStatus = order.status;
    sellQuantity(state, order, partialQuantity, trigger, candle.closeTimeMs, "take-profit-2");
    if (order.status === "closed") return;
    order.partialTaken = true;
    order.activeStopPrice = order.actualEntryPrice! * (1 + costs.buyFeeRate) /
      ((1 - costs.sellSlippageRate) * (1 - costs.sellFeeRate));
    const breakEvenProceeds = order.activeStopPrice * (1 - costs.sellSlippageRate) *
      (1 - costs.sellFeeRate);
    order.riskAmount = Math.max(0, order.remainingQuantity *
      (order.actualEntryPrice! + order.entryFee / order.quantity - breakEvenProceeds));
    addEvent(state, {
      id: `${order.id}:take-profit-1:${candle.closeTimeMs}`,
      kind: "take-profit-1",
      symbol: order.symbol,
      timeMs: candle.closeTimeMs,
      snapshotId: order.snapshotId,
      strategyVersion: order.strategyVersion,
      orderId: order.id,
      price: trigger * (1 - costs.sellSlippageRate),
      fee: partialQuantity * trigger * (1 - costs.sellSlippageRate) * costs.sellFeeRate,
      slippage: partialQuantity * trigger * costs.sellSlippageRate,
    });
    if (candle.low <= order.activeStopPrice) {
      sellQuantity(state, order, order.remainingQuantity, order.activeStopPrice, candle.closeTimeMs, "break-even");
      return;
    }
    order.status = previousStatus;
  }
  if (order.status === "open" && candle.high >= order.takeProfit2Price) {
    const trigger = Math.max(order.takeProfit2Price, Math.min(candle.open, candle.high));
    sellQuantity(state, order, order.remainingQuantity, trigger, candle.closeTimeMs, "take-profit-2");
  }
}

function processCandle(state: PaperLedgerState, candle: MarketCandle): void {
  state.lastPrices[candle.symbol] = candle.close;
  const order = activeForSymbol(state, candle.symbol);
  if (!order) return;
  if (order.status === "pending") {
    if (candle.openTimeMs >= order.expiresAtMs) {
      order.status = "expired";
      order.updatedAtMs = candle.closeTimeMs;
      order.reservedQuote = 0;
      order.riskAmount = 0;
      appendOrderEvent(state, "order-expired", order, candle.closeTimeMs, { reason: "entry-plan-expired" });
      return;
    }
    if (candle.openTimeMs < order.validFromMs) return;
    if (candle.low > order.entryUpper || candle.high < order.entryLower) {
      if (candle.close < order.pullbackLow) {
        order.status = "cancelled";
        order.updatedAtMs = candle.closeTimeMs;
        order.reservedQuote = 0;
        order.riskAmount = 0;
        appendOrderEvent(state, "order-cancelled", order, candle.closeTimeMs, { reason: "hourly-close-below-pullback-low" });
      }
      return;
    }
    const theoreticalFill = candle.open > order.entryUpper ? order.entryUpper
      : candle.open < order.entryLower ? order.entryLower
        : candle.open;
    const costs = order.costAssumptions;
    const actualEntryPrice = theoreticalFill * (1 + costs.buySlippageRate);
    const notional = actualEntryPrice * order.quantity;
    const entryFee = notional * costs.buyFeeRate;
    state.cash -= notional + entryFee;
    order.status = "open";
    order.updatedAtMs = candle.closeTimeMs;
    order.fillTimeMs = candle.openTimeMs;
    order.actualEntryPrice = actualEntryPrice;
    order.entryFee = entryFee;
    order.entrySlippage = order.quantity * (actualEntryPrice - theoreticalFill);
    order.reservedQuote = 0;
    order.remainingQuantity = order.quantity;
    const riskPerUnit = unitRisk(order.entryUpper, order.activeStopPrice, costs);
    order.riskAmount = order.quantity * riskPerUnit;
    appendOrderEvent(state, "fill", order, candle.closeTimeMs, {
      price: actualEntryPrice, fee: entryFee, slippage: order.entrySlippage,
    });
    processOpenPosition(state, order, candle);
    return;
  }
  processOpenPosition(state, order, candle);
}

function validClosedHourly(candle: MarketCandle, expectedSymbol?: SpotSymbol): boolean {
  const prices = [candle.open, candle.high, candle.low, candle.close];
  return isSpotSymbol(candle.symbol) && (!expectedSymbol || candle.symbol === expectedSymbol) &&
    candle.interval === "1h" && candle.isClosed && Number.isFinite(candle.openTimeMs) &&
    Number.isFinite(candle.closeTimeMs) && candle.openTimeMs > 0 && candle.openTimeMs % HOUR_MS === 0 &&
    candle.closeTimeMs === candle.openTimeMs + HOUR_MS - 1 &&
    prices.every((price) => Number.isFinite(price) && price > 0) &&
    candle.low <= Math.min(candle.open, candle.close) && candle.high >= Math.max(candle.open, candle.close) &&
    candle.low <= candle.high && Number.isFinite(candle.volume) && candle.volume >= 0 &&
    Number.isFinite(candle.quoteVolume) && candle.quoteVolume >= 0 &&
    Number.isSafeInteger(candle.tradeCount) && candle.tradeCount >= 0;
}

export function createCryptoPaperLedger({ storage, now = Date.now, afterCandle }: PaperLedgerOptions = {}) {
  let state = emptyState();
  let storageError: string | null = null;
  let sequence = 0;
  const drafts = new Map<string, { draft: PaperOrderDraft; attempt: AnalysisAttempt }>();
  let processing: Promise<void> = Promise.resolve();
  const listeners = new Set<(next: PaperLedgerState) => void>();
  try {
    const stored = storage?.getItem(CRYPTO_PAPER_LEDGER_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (!validLedger(parsed)) throw new Error("模拟账本格式无效");
      state = {
        ...parsed,
        orders: parsed.orders.map((order) => ({
          ...order,
          costAssumptions: validCostAssumptions(order.costAssumptions)
            ? order.costAssumptions
            : { ...DEFAULT_COST_ASSUMPTIONS },
        })),
        events: parsed.events.map((event) => ({
          ...event,
          snapshotId: event.snapshotId ?? null,
          strategyVersion: event.strategyVersion ?? null,
          price: event.price ?? null,
          fee: event.fee ?? null,
          slippage: event.slippage ?? null,
        })),
        lastAnalyzedOpenTimeMs: parsed.lastAnalyzedOpenTimeMs ?? { ...parsed.lastProcessedOpenTimeMs },
      };
    }
  } catch (error) {
    storageError = error instanceof Error ? error.message : "无法读取模拟账本";
  }

  function snapshot(): PaperLedgerState {
    return cloneState(state);
  }

  function commit(next: PaperLedgerState): void {
    try {
      storage?.setItem(CRYPTO_PAPER_LEDGER_KEY, JSON.stringify(next));
      state = next;
      storageError = null;
      for (const listener of listeners) listener(snapshot());
    } catch (error) {
      storageError = error instanceof Error ? error.message : "模拟账本保存失败";
      throw new Error("模拟账本保存失败；操作未生效");
    }
  }

  function createDraft(
    attempt: AnalysisAttempt,
    backtestStatus: BacktestResearchStatus,
    costAssumptions: BacktestCostAssumptions = DEFAULT_COST_ASSUMPTIONS,
  ): PaperOrderDraft {
    if (storageError || attempt.persistenceError) throw new Error("存储不可用，禁止创建模拟订单");
    const draft = buildDraft(state, attempt, backtestStatus, now(), costAssumptions);
    drafts.set(draft.symbol, { draft: { ...draft }, attempt: structuredClone(attempt) });
    return draft;
  }

  function submitDraft(draft: PaperOrderDraft): PaperOrder {
    if (storageError) throw new Error("存储不可用，禁止提交模拟订单");
    const prepared = drafts.get(draft.symbol);
    if (!prepared || JSON.stringify(prepared.draft) !== JSON.stringify(draft)) throw new Error("订单预填已失效，请重新带入");
    getPlan(prepared.attempt, now());
    const next = cloneState(state);
    if (activeForSymbol(next, draft.symbol)) throw new Error("该币种已有未成交订单或未平仓仓位");
    if (next.pausedSymbols[draft.symbol]) throw new Error("该币种前向模拟已暂停，需先恢复行情");
    const equity = accountEquity(next);
    const riskLimit = equity * DEFAULT_BACKTEST_CONFIG.maxTradeRiskFraction!;
    const portfolioLimit = equity * DEFAULT_BACKTEST_CONFIG.maxPortfolioRiskFraction!;
    const costs = draft.costAssumptions;
    const riskAmount = draft.quantity * unitRisk(draft.entryUpper, draft.stopPrice, costs);
    const reserve = draft.quantity * draft.entryUpper * (1 + costs.buySlippageRate) *
      (1 + costs.buyFeeRate);
    if (draft.backtestStatus === "invalid" || draft.expiresAtMs <= now() || draft.quantity <= 0 ||
      draft.riskReward < 2 || draft.stopPrice >= draft.entryLower || riskAmount > riskLimit + 1e-8 ||
      riskExposure(next) + riskAmount > portfolioLimit + 1e-8 || reserve > availableQuote(next) + 1e-8) {
      throw new Error("订单已过期或风险、资金条件不再满足");
    }
    const orderId = `${draft.symbol}-${draft.analysisTimeMs}-${state.orders.length}-${sequence++}`;
    const order: PaperOrder = {
      id: orderId,
      symbol: draft.symbol,
      status: "pending",
      snapshotId: draft.snapshotId,
      strategyVersion: draft.strategyVersion,
      backtestStatus: draft.backtestStatus,
      costAssumptions: { ...draft.costAssumptions },
      createdAtMs: now(),
      updatedAtMs: now(),
      analysisTimeMs: draft.analysisTimeMs,
      validFromMs: draft.validFromMs,
      expiresAtMs: draft.expiresAtMs,
      referencePrice: draft.referencePrice,
      entryLower: draft.entryLower,
      entryUpper: draft.entryUpper,
      stopPrice: draft.stopPrice,
      takeProfit1Price: draft.takeProfit1Price,
      takeProfit2Price: draft.takeProfit2Price,
      riskReward: draft.riskReward,
      pullbackLow: draft.pullbackLow,
      quantity: draft.quantity,
      remainingQuantity: 0,
      riskAmount,
      reservedQuote: reserve,
      fillTimeMs: null,
      actualEntryPrice: null,
      entryFee: 0,
      entrySlippage: 0,
      exitFees: 0,
      exitSlippage: 0,
      realizedNetPnl: 0,
      averageExitPrice: null,
      exitedQuantity: 0,
      partialTaken: false,
      activeStopPrice: draft.stopPrice,
      exitReason: null,
      closedAtMs: null,
    };
    next.orders.push(order);
    next.lastProcessedOpenTimeMs[draft.symbol] ??= draft.validFromMs - HOUR_MS;
    next.lastAnalyzedOpenTimeMs[draft.symbol] ??= draft.validFromMs - HOUR_MS;
    appendOrderEvent(next, "order-created", order, order.createdAtMs, {
      price: order.entryUpper,
      fee: order.quantity * order.entryUpper * (1 + costs.buySlippageRate) * costs.buyFeeRate,
      slippage: order.quantity * order.entryUpper * costs.buySlippageRate,
    });
    commit(next);
    drafts.delete(draft.symbol);
    return { ...order };
  }

  function cancelOrder(orderId: string, reason = "user-cancelled"): void {
    const next = cloneState(state);
    const order = next.orders.find((item) => item.id === orderId && item.status === "pending");
    if (!order) throw new Error("未找到可取消的模拟挂单");
    order.status = "cancelled";
    order.updatedAtMs = now();
    order.riskAmount = 0;
    order.reservedQuote = 0;
    appendOrderEvent(next, "order-cancelled", order, order.updatedAtMs, { reason });
    commit(next);
  }

  function recordAnalysis(attempt: AnalysisAttempt): void {
    const next = cloneState(state);
    const signalId = attempt.snapshotId ? `signal:${attempt.snapshotId}` : null;
    if (signalId && attempt.status === "ready" && attempt.strategy?.state === "enter") {
      addEvent(next, {
        id: signalId,
        kind: "signal",
        symbol: attempt.symbol,
        timeMs: attempt.analysisTimeMs ?? now(),
        snapshotId: attempt.snapshotId,
        strategyVersion: attempt.strategyVersion,
        price: attempt.entryPlan?.referencePrice ?? attempt.currentPrice,
        fee: 0,
        slippage: 0,
      });
    }
    const order = next.orders.find((item) => item.symbol === attempt.symbol && item.status === "pending");
    const cancellationReason = attempt.status === "insufficient-data" ? "insufficient-data"
      : attempt.entryPlan?.status === "expired" ? "entry-plan-expired"
        : attempt.entryPlan?.status === "invalidated" ? attempt.entryPlan.failure ?? "entry-plan-invalidated"
          : attempt.strategy?.state === "avoid" && attempt.strategy.avoidReason !== "confirmation-score-insufficient"
            ? attempt.strategy.avoidReason ?? attempt.entryPlanFailure ?? "analysis-invalidated"
            : null;
    if (order && cancellationReason) {
      order.status = cancellationReason === "entry-plan-expired" ? "expired" : "cancelled";
      order.updatedAtMs = attempt.analysisTimeMs ?? now();
      order.riskAmount = 0;
      order.reservedQuote = 0;
      appendOrderEvent(next, order.status === "expired" ? "order-expired" : "order-cancelled", order,
        order.updatedAtMs, { reason: cancellationReason });
    }
    if (cancellationReason) drafts.delete(attempt.symbol);
    if (next.events.at(-1)?.id !== state.events.at(-1)?.id || order?.status === "cancelled" || order?.status === "expired") commit(next);
  }

  function pauseSymbol(symbol: SpotSymbol, reason: string): void {
    const next = cloneState(state);
    const safeReason = sanitizeDiagnosticText(reason);
    next.pausedSymbols[symbol] = safeReason;
    addEvent(next, { id: `${symbol}:runtime:${now()}`, kind: "runtime-error", symbol, timeMs: now(), reason: safeReason });
    commit(next);
  }

  function recordRuntimeEvent(symbol: SpotSymbol, kind: "runtime-error" | "runtime-shutdown", reason: string): void {
    const next = cloneState(state);
    addEvent(next, { id: `${symbol}:${kind}:${now()}`, kind, symbol, timeMs: now(), reason });
    commit(next);
  }

  async function processClosedCandleImpl(candle: MarketCandle, restAdapter: MarketDataRestAdapter): Promise<void> {
    if (!isSpotSymbol(candle.symbol) || storageError) return;
    if (!validClosedHourly(candle) && !state.pausedSymbols[candle.symbol]) {
      const next = cloneState(state);
      const reason = "无效的闭合 1h OHLCV 行情，已暂停模拟成交";
      next.pausedSymbols[candle.symbol] = sanitizeDiagnosticText(reason);
      addEvent(next, {
        id: `${candle.symbol}:invalid-candle:${Number.isFinite(candle.openTimeMs) ? candle.openTimeMs : now()}`,
        kind: "data-gap",
        symbol: candle.symbol,
        timeMs: now(),
        reason,
      });
      commit(next);
      return;
    }
    if (!validClosedHourly(candle)) return;
    const processedOpen = state.lastProcessedOpenTimeMs[candle.symbol];
    const analyzedOpen = state.lastAnalyzedOpenTimeMs[candle.symbol];
    const checkpoints = [processedOpen, analyzedOpen].filter((value): value is number => value != null);
    const checkpoint = checkpoints.length ? Math.min(...checkpoints) : null;
    if (checkpoint != null && candle.openTimeMs <= checkpoint) {
      if (candle.openTimeMs === checkpoint && processedOpen === checkpoint && analyzedOpen === checkpoint &&
        state.pausedSymbols[candle.symbol]?.startsWith("market-data-")) {
        const next = cloneState(state);
        delete next.pausedSymbols[candle.symbol];
        addEvent(next, { id: `${candle.symbol}:reconnected:${now()}`, kind: "data-restored",
          symbol: candle.symbol, timeMs: now(), reason: "行情已恢复，处理检查点无缺口" });
        commit(next);
      }
      return;
    }
    if (checkpoint == null && activeForSymbol(state, candle.symbol)) {
      const next = cloneState(state);
      next.pausedSymbols[candle.symbol] = "missing-forward-simulation-checkpoint";
      addEvent(next, {
        id: `${candle.symbol}:checkpoint:${candle.openTimeMs}`,
        kind: "data-gap",
        symbol: candle.symbol,
        timeMs: now(),
        reason: "缺少前向模拟检查点，已暂停该交易对",
      });
      commit(next);
      return;
    }

    let candlesToProcess = [candle];
    if (checkpoint != null && candle.openTimeMs - checkpoint > HOUR_MS) {
      try {
        const missing: MarketCandle[] = [];
        let nextOpen = checkpoint + HOUR_MS;
        while (nextOpen < candle.openTimeMs) {
          const count = Math.min(1_000, (candle.openTimeMs - nextOpen) / HOUR_MS);
          const rows = await restAdapter.getCandles({
            symbol: candle.symbol,
            interval: "1h",
            startTimeMs: nextOpen,
            endTimeMs: nextOpen + count * HOUR_MS - 1,
            limit: count,
          });
          const sorted = [...rows].filter((row) => validClosedHourly(row, candle.symbol))
            .sort((a, b) => a.openTimeMs - b.openTimeMs);
          const complete = sorted.length === count && sorted.every((row, index) =>
            row.openTimeMs === nextOpen + index * HOUR_MS);
          if (!complete) throw new Error("REST 未返回完整的闭合行情缺口");
          missing.push(...sorted);
          nextOpen += count * HOUR_MS;
        }
        candlesToProcess = [...missing, candle];
      } catch (error) {
        const next = cloneState(state);
        const reason = error instanceof Error ? error.message : "行情缺口补齐失败";
        next.pausedSymbols[candle.symbol] = sanitizeDiagnosticText(reason);
        addEvent(next, {
          id: `${candle.symbol}:gap:${candle.openTimeMs}`,
          kind: "data-gap",
          symbol: candle.symbol,
          timeMs: now(),
          reason,
        });
        commit(next);
        return;
      }
    }

    for (const row of candlesToProcess) {
      if (state.lastProcessedOpenTimeMs[candle.symbol] == null ||
        row.openTimeMs > state.lastProcessedOpenTimeMs[candle.symbol]!) {
        const next = cloneState(state);
        processCandle(next, row);
        next.lastProcessedOpenTimeMs[candle.symbol] = row.openTimeMs;
        commit(next);
      }
      if (state.lastAnalyzedOpenTimeMs[candle.symbol] == null ||
        row.openTimeMs > state.lastAnalyzedOpenTimeMs[candle.symbol]!) {
        try {
          await afterCandle?.(row);
        } catch {
          pauseSymbol(candle.symbol, "闭合行情分析失败，已暂停模拟成交");
          return;
        }
        const next = cloneState(state);
        next.lastAnalyzedOpenTimeMs[candle.symbol] = row.openTimeMs;
        delete next.pausedSymbols[candle.symbol];
        commit(next);
      }
    }
    if (candlesToProcess.length > 1) {
      const next = cloneState(state);
      addEvent(next, {
      id: `${candle.symbol}:restored:${candle.openTimeMs}`,
      kind: "data-restored",
      symbol: candle.symbol,
      timeMs: now(),
      reason: `${candlesToProcess.length - 1} 根闭合 K 线已补齐并按序处理`,
      });
      commit(next);
    }
  }

  function processClosedCandle(candle: MarketCandle, restAdapter: MarketDataRestAdapter): Promise<void> {
    const task = processing.then(() => processClosedCandleImpl(candle, restAdapter));
    processing = task.catch(() => {});
    return task;
  }

  function getRiskContext(): { accountEquity: number; availableQuoteBalance: number } {
    return { accountEquity: accountEquity(state), availableQuoteBalance: availableQuote(state) };
  }

  function getCostComparison(): PaperCostComparison {
    const simulatedFees = state.orders.reduce((sum, order) => sum + order.entryFee + order.exitFees, 0);
    const expectedFees = state.orders.reduce((sum, order) => {
      const entryNotional = (order.actualEntryPrice ?? 0) * order.quantity;
      const exitNotional = (order.averageExitPrice ?? 0) * order.exitedQuantity;
      return sum + entryNotional * order.costAssumptions.buyFeeRate +
        exitNotional * order.costAssumptions.sellFeeRate;
    }, 0);
    const simulatedSlippage = state.orders.reduce((sum, order) => sum + order.entrySlippage + order.exitSlippage, 0);
    const expectedSlippage = state.orders.reduce((sum, order) => {
      const theoreticalEntry = (order.actualEntryPrice ?? 0) / (1 + order.costAssumptions.buySlippageRate);
      const theoreticalExit = (order.averageExitPrice ?? 0) / (1 - order.costAssumptions.sellSlippageRate);
      return sum + order.quantity * theoreticalEntry * order.costAssumptions.buySlippageRate +
        order.exitedQuantity * theoreticalExit * order.costAssumptions.sellSlippageRate;
    }, 0);
    return {
      simulatedFees,
      expectedFees,
      feeDifference: simulatedFees - expectedFees,
      simulatedSlippage,
      expectedSlippage,
      slippageDifference: simulatedSlippage - expectedSlippage,
    };
  }

  return {
    createDraft,
    submitDraft,
    cancelOrder,
    recordAnalysis,
    pauseSymbol,
    recordRuntimeEvent,
    processClosedCandle,
    getRiskContext,
    getCostComparison,
    getState: snapshot,
    getRuntimeError: () => storageError,
    subscribe(listener: (next: PaperLedgerState) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
