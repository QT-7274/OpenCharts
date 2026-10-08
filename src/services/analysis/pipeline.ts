import { SUPPORTED_SPOT_INTERVALS, intervalToMs, isSpotSymbol, type MarketCandle,
  type MarketDataHealth, type MarketDataRestAdapter, type SpotInterval, type SpotSymbol } from "../market-data/types.ts";
import { inspectWindow, type AnalysisIssue } from "./quality.ts";
import { parseAnalysisAttemptRecord } from "./history-record.ts";
import {
  aiExplanationSnapshotSchema,
  buildAiExplanationSnapshot,
  type AiExplanationRecord,
  type AiExplanationSnapshot,
} from "./ai-explanation-contract.ts";
import { validateAiExplanationNumbers } from "./ai-explanation-validation.mjs";
import {
  TREND_PULLBACK_V1,
  buildEntryPlan,
  buildIndicatorSnapshot,
  evaluateStrategy,
  evaluateTrendGate,
  identifySupportResistance,
  getSpotQuoteFailure,
  updateEntryPlan,
  type AnalysisIndicatorSet,
  type EntryPlan,
  type EntryPlanFailure,
  type EntryPlanStatus,
  type SupportResistanceLevels,
  type SimulatedRiskContext,
  type SpotQuantityRules,
  type StrategyEvaluation,
  type StrategyVersion,
  type TrendGateResult,
} from "./strategy.ts";

export type AnalysisTrigger = "manual" | "hourly-close";
export type AnalysisStatus = "ready" | "insufficient-data";

export interface AnalysisAttempt {
  symbol: SpotSymbol;
  trigger: AnalysisTrigger;
  analysisTimeMs: number | null;
  status: AnalysisStatus;
  decision: "暂不入场";
  reason: "数据不足或多周期数据不同步" | null;
  candleCloseTimes: Record<SpotInterval, number | null>;
  windows: Record<SpotInterval, MarketCandle[]>;
  issues: AnalysisIssue[];
  strategyVersion: StrategyVersion;
  indicators: AnalysisIndicatorSet | null;
  trend: TrendGateResult | null;
  strategy: StrategyEvaluation | null;
  currentPrice: number | null;
  currentPriceObservedAtMs: number | null;
  supportResistance: SupportResistanceLevels;
  currentPriceServerTimeMs: number | null;
  signal: null;
  entryPlan: EntryPlan | null;
  entryPlanFailure: EntryPlanFailure | null;
  snapshotId?: string;
  aiInputSummary?: AiExplanationSnapshot | null;
  aiExplanation?: AiExplanationRecord | null;
  persistenceError?: "analysis-snapshot" | "ai-explanation";
}

export interface AnalysisPipelineOptions {
  restAdapter: MarketDataRestAdapter;
  getHealth: () => MarketDataHealth;
  getRiskContext: () => SimulatedRiskContext | null;
  minimumCandles?: Record<SpotInterval, number>;
  storage?: Pick<Storage, "getItem" | "setItem">;
  now?: () => number;
}

export type AnalysisAttemptRecord = Omit<AnalysisAttempt, "windows" | "signal" | "persistenceError">;
const HISTORY_KEY = "opencharts.analysis.attempts.v1";
const IN_MEMORY_HISTORY_LIMIT = 100;

// EMA200 on 1d, 4h structure, and 1h momentum require independent warmup windows.
export const DEFAULT_MINIMUM_CANDLES: Record<SpotInterval, number> = { "1d": 210, "4h": 65, "1h": 50 };

function emptyAttempt(symbol: SpotSymbol, trigger: AnalysisTrigger, time: number | null): AnalysisAttempt {
  return {
    symbol, trigger, analysisTimeMs: time, status: "insufficient-data", decision: "暂不入场",
    reason: "数据不足或多周期数据不同步",
    candleCloseTimes: { "1d": null, "4h": null, "1h": null },
    windows: { "1d": [], "4h": [], "1h": [] }, issues: [],
    strategyVersion: TREND_PULLBACK_V1.version, indicators: null, trend: null, strategy: null,
    currentPrice: null,
    currentPriceObservedAtMs: null,
    currentPriceServerTimeMs: null,
    supportResistance: { support: null, resistance: null },
    signal: null, entryPlan: null, entryPlanFailure: null,
  };
}

function normalizeStoredRecord(value: unknown): AnalysisAttemptRecord | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.symbol !== "string" || !isSpotSymbol(record.symbol) ||
    (record.trigger !== "manual" && record.trigger !== "hourly-close")) return null;
  const analysisTimeMs = record.analysisTimeMs == null ? null : record.analysisTimeMs;
  if (analysisTimeMs !== null && (typeof analysisTimeMs !== "number" || !Number.isFinite(analysisTimeMs))) return null;
  const defaults = emptyAttempt(record.symbol, record.trigger, analysisTimeMs);
  const { windows: _windows, signal: _signal, ...defaultRecord } = defaults;
  const parsed = parseAnalysisAttemptRecord({ ...defaultRecord, ...record });
  if (!parsed) return null;
  const withSnapshot = parsed as AnalysisAttemptRecord & AnalysisAttempt;
  const expectedSnapshot = buildAiExplanationSnapshot(withSnapshot);
  const storedSnapshot = parsed.aiInputSummary ?? expectedSnapshot;
  const storedSnapshotIsConsistent = aiExplanationSnapshotSchema.safeParse(storedSnapshot).success &&
    JSON.stringify(storedSnapshot) === JSON.stringify(expectedSnapshot);
  const storedExplanation = parsed.aiExplanation ?? null;
  const explanationIsConsistent = storedSnapshotIsConsistent &&
    (storedExplanation?.status !== "available" || (storedExplanation.explanation !== null &&
      validateAiExplanationNumbers(expectedSnapshot, storedExplanation.explanation)));
  return {
    ...parsed,
    snapshotId: parsed.snapshotId || createSnapshotId(parsed),
    aiInputSummary: expectedSnapshot,
    aiExplanation: explanationIsConsistent ? storedExplanation : null,
  };
}

let fallbackSnapshotSequence = 0;

function createSnapshotId(
  attempt: Pick<AnalysisAttempt, "symbol" | "analysisTimeMs" | "strategyVersion" | "trigger">,
  sequence?: number,
): string {
  const timeKey = attempt.analysisTimeMs == null
    ? `unknown-${sequence ?? fallbackSnapshotSequence++}`
    : String(attempt.analysisTimeMs);
  return `${attempt.symbol}:${timeKey}:${attempt.strategyVersion}:${attempt.trigger}`;
}

function withPlanStatus(
  plan: EntryPlan,
  status: EntryPlanStatus,
  failure: EntryPlanFailure | null,
  currentPrice?: number,
  currentPriceObservedAtMs?: number,
): EntryPlan {
  return {
    ...plan,
    status,
    failure,
    ...(currentPrice == null ? {} : { currentPrice }),
    ...(currentPriceObservedAtMs == null ? {} : { currentPriceObservedAtMs }),
  };
}

function repairPoints(issues: readonly AnalysisIssue[], earliest: number, latest: number): number[] {
  const points = new Set<number>();
  for (const issue of issues) {
    if (issue.code === "gap" && issue.fromMs != null && issue.toMs != null) {
      const ms = intervalToMs(issue.interval);
      for (let time = Math.max(issue.fromMs, earliest); time <= Math.min(issue.toMs, latest); time += ms) points.add(time);
    }
    if ((issue.code === "invalid-candle" || issue.code === "conflict") && issue.atMs != null) {
      if (issue.atMs >= earliest && issue.atMs <= latest) points.add(issue.atMs);
    }
  }
  return [...points].sort((a, b) => a - b);
}

// crypto-ai-analysis.CANDLE_QUALITY.1 crypto-ai-analysis.CANDLE_QUALITY.1-1 crypto-ai-analysis.CANDLE_QUALITY.3-2
export function createAnalysisPipeline({ restAdapter, getHealth, getRiskContext, minimumCandles = DEFAULT_MINIMUM_CANDLES, storage, now = Date.now }: AnalysisPipelineOptions) {
  const requiredCandles: Record<SpotInterval, number> = {
    "1d": Math.max(DEFAULT_MINIMUM_CANDLES["1d"], minimumCandles["1d"]),
    "4h": Math.max(DEFAULT_MINIMUM_CANDLES["4h"], minimumCandles["4h"]),
    "1h": Math.max(DEFAULT_MINIMUM_CANDLES["1h"], minimumCandles["1h"]),
  };
  const closedAttempts = new Map<string, Promise<AnalysisAttempt>>();
  const listeners = new Set<(attempt: AnalysisAttempt) => void>();
  const history: AnalysisAttempt[] = [];
  const activePlans = new Map<SpotSymbol, EntryPlan>();
  const restoredAtMs = now();
  let records: AnalysisAttemptRecord[] = [];
  let lifecycleChangedDuringRestore = false;
  // crypto-ai-analysis.ENTRY_PLAN.6
  try {
    const stored = storage?.getItem(HISTORY_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    if (Array.isArray(parsed)) {
      records = parsed
        .map(normalizeStoredRecord)
        .filter((record): record is AnalysisAttemptRecord => record !== null)
        .map((normalized) => {
          const plan = normalized.entryPlan;
          if (plan && Number.isFinite(plan.expiresAtMs) && plan.expiresAtMs <= restoredAtMs &&
            plan.status !== "expired" && plan.status !== "invalidated") {
            lifecycleChangedDuringRestore = true;
            return {
              ...normalized,
              entryPlan: withPlanStatus(plan, "expired", "expired"),
              entryPlanFailure: "expired",
              strategy: normalized.strategy ? {
                ...normalized.strategy, state: "avoid", avoidReason: null, entryPlanStatus: "expired",
              } : null,
            };
          }
          if (plan && (plan.status === "active" || plan.status === "waiting-for-price")) {
            const quoteFailure = getSpotQuoteFailure(
              normalized.currentPrice,
              normalized.currentPriceObservedAtMs,
              normalized.currentPriceServerTimeMs,
              restoredAtMs,
            );
            if (quoteFailure) {
              lifecycleChangedDuringRestore = true;
              return {
                ...normalized,
                entryPlan: withPlanStatus(plan, "waiting-for-price", quoteFailure),
                entryPlanFailure: quoteFailure,
                strategy: normalized.strategy ? {
                  ...normalized.strategy, state: "setup", avoidReason: null, entryPlanStatus: "waiting-for-price",
                } : null,
              };
            }
          }
          return normalized;
        });
    }
  } catch {
    // Private browsing or malformed prior storage should not prevent analysis.
  }

  history.push(...records.slice(-IN_MEMORY_HISTORY_LIMIT).map((record): AnalysisAttempt => ({
    ...record,
    windows: { "1d": [], "4h": [], "1h": [] },
    signal: null,
  })));
  for (const record of records) {
    const plan = record.entryPlan;
    if (record.status === "ready" && plan &&
      (plan.status === "active" || plan.status === "waiting-for-price") &&
      plan.expiresAtMs > restoredAtMs) {
      activePlans.set(record.symbol, plan);
    } else {
      activePlans.delete(record.symbol);
    }
  }
  if (lifecycleChangedDuringRestore) {
    try {
      storage?.setItem(HISTORY_KEY, JSON.stringify(records));
    } catch {
      // Keep the restored expiration in memory when browser storage is unavailable.
    }
  }

  function record(attempt: AnalysisAttempt): AnalysisAttempt {
    const snapshotId = attempt.snapshotId ?? createSnapshotId(attempt);
    const aiInputSummary = attempt.aiInputSummary ?? buildAiExplanationSnapshot(attempt);
    const existingRecordIndex = records.findIndex((record) => record.snapshotId === snapshotId);
    const previous = existingRecordIndex < 0 ? null : records[existingRecordIndex] ?? null;
    const canReuseExplanation = previous !== null &&
      JSON.stringify(previous.aiInputSummary) === JSON.stringify(aiInputSummary);
    const recorded: AnalysisAttempt = {
      ...attempt,
      snapshotId,
      aiInputSummary,
      aiExplanation: attempt.aiExplanation ?? (canReuseExplanation ? previous.aiExplanation ?? null : null),
    };
    const existingHistoryIndex = history.findIndex((entry) => entry.snapshotId === snapshotId);
    if (existingHistoryIndex >= 0) history.splice(existingHistoryIndex, 1);
    history.push(recorded);
    if (history.length > IN_MEMORY_HISTORY_LIMIT) history.shift();
    const { windows: _windows, signal: _signal, ...summary } = recorded;
    if (existingRecordIndex >= 0) records[existingRecordIndex] = summary;
    else records.push(summary);
    try {
      storage?.setItem(HISTORY_KEY, JSON.stringify(records));
    } catch {
      recorded.persistenceError = "analysis-snapshot";
      history[history.length - 1] = recorded;
    }
    for (const listener of listeners) listener(recorded);
    return recorded;
  }

  function updateAiSnapshot(snapshotId: string, update: { aiExplanation: AiExplanationRecord | null }): AnalysisAttempt | null {
    let recordIndex = records.length - 1;
    while (recordIndex >= 0 && records[recordIndex]?.snapshotId !== snapshotId) recordIndex -= 1;
    if (recordIndex === -1) return null;
    const saved = records[recordIndex];
    if (!saved) return null;
    let aiExplanation = update.aiExplanation;
    if (aiExplanation?.status === "available" && aiExplanation.explanation && saved.aiInputSummary &&
      !validateAiExplanationNumbers(saved.aiInputSummary, aiExplanation.explanation)) {
      aiExplanation = {
        ...aiExplanation,
        status: "invalid",
        validationResult: "invalid",
        failureReason: "numeric-validation-failed",
        explanation: null,
      };
    }
    const updatedRecord = { ...saved, aiExplanation };
    records[recordIndex] = updatedRecord;
    let historyIndex = history.length - 1;
    while (historyIndex >= 0 && history[historyIndex]?.snapshotId !== snapshotId) historyIndex -= 1;
    const existing = historyIndex === -1 ? null : history[historyIndex];
    let updated: AnalysisAttempt = existing
      ? { ...existing, aiExplanation }
      : { ...updatedRecord, windows: { "1d": [], "4h": [], "1h": [] }, signal: null };
    const persistableUpdate = { ...updated };
    delete persistableUpdate.persistenceError;
    updated = persistableUpdate;
    try {
      storage?.setItem(HISTORY_KEY, JSON.stringify(records));
    } catch {
      updated = { ...updated, persistenceError: "ai-explanation" };
    }
    if (historyIndex !== -1) history[historyIndex] = updated;
    for (const listener of listeners) listener(updated);
    return updated;
  }

  async function run(symbol: SpotSymbol, trigger: AnalysisTrigger, time: number, event?: MarketCandle): Promise<AnalysisAttempt> {
    const result = emptyAttempt(symbol, trigger, time);
    const previousPlan = activePlans.get(symbol) ?? null;
    const health = getHealth();
    await Promise.all(SUPPORTED_SPOT_INTERVALS.map(async (interval) => {
      const ms = intervalToMs(interval);
      const latestOpen = Math.floor((time + 1) / ms) * ms - ms;
      const earliestOpen = latestOpen - (requiredCandles[interval] - 1) * ms;
      const request = { symbol, interval, endTimeMs: time, limit: requiredCandles[interval] + 2 };
      let rows: MarketCandle[];
      try {
        rows = await restAdapter.getCandles(request);
      } catch {
        result.issues.push({ interval, code: "unavailable" });
        return;
      }

      rows = rows.filter((row) => row.openTimeMs >= earliestOpen - 2 * ms && row.openTimeMs <= latestOpen);
      let inspected = inspectWindow(symbol, interval, time, rows, requiredCandles[interval]);
      const healthRanges = health.missingRanges.filter((range) =>
        range.symbol === symbol && range.interval === interval && range.toMs >= earliestOpen && range.fromMs <= latestOpen);
      const points = new Set(repairPoints(inspected.issues, earliestOpen, latestOpen));
      let repairFailed = false;
      if (inspected.issues.some((issue) => issue.code === "warmup" || issue.code === "stale")) {
        try {
          const backfill = await restAdapter.getCandles({
            symbol, interval, startTimeMs: earliestOpen, endTimeMs: latestOpen + ms - 1,
            limit: requiredCandles[interval],
          });
          rows = rows.concat(backfill.filter((row) => row.openTimeMs >= earliestOpen && row.openTimeMs <= latestOpen));
          inspected = inspectWindow(symbol, interval, time, rows, requiredCandles[interval]);
          for (const at of repairPoints(inspected.issues, earliestOpen, latestOpen)) points.add(at);
        } catch {
          repairFailed = true;
        }
      }
      for (const range of healthRanges) {
        for (let at = Math.max(range.fromMs, earliestOpen); at <= Math.min(range.toMs, latestOpen); at += ms) points.add(at);
      }
      if (event && interval === "1h" && event.openTimeMs <= latestOpen && event.openTimeMs >= earliestOpen) {
        const matching = inspected.candles.find((row) => row.openTimeMs === event.openTimeMs);
        if (!matching || matching.open !== event.open || matching.high !== event.high ||
          matching.low !== event.low || matching.close !== event.close || matching.volume !== event.volume ||
          matching.quoteVolume !== event.quoteVolume || matching.tradeCount !== event.tradeCount) {
          points.add(event.openTimeMs);
        }
      }

      for (const at of [...points].sort((a, b) => a - b)) {
        try {
          const repaired = await restAdapter.getCandles({ symbol, interval, startTimeMs: at, endTimeMs: at + ms - 1, limit: 1 });
          const replacement = repaired.find((row) => row.openTimeMs === at && row.isClosed);
          if (!replacement) { repairFailed = true; continue; }
          rows = rows.filter((row) => row.openTimeMs !== at).concat(replacement);
        } catch {
          repairFailed = true;
        }
      }
      inspected = inspectWindow(symbol, interval, time, rows, requiredCandles[interval]);
      result.windows[interval] = inspected.candles;
      result.candleCloseTimes[interval] = inspected.latestCloseTimeMs;
      result.issues.push(...inspected.issues);
      if (repairFailed || (healthRanges.length && healthRanges.some((range) =>
        ![...points].every((at) => at < range.fromMs || at > range.toMs ||
          inspected.candles.some((row) => row.openTimeMs === at))))) {
        result.issues.push({ interval, code: "unavailable" });
      }
    }));
    if (result.issues.length === 0) {
      const daily = buildIndicatorSnapshot("1d", result.windows["1d"]);
      const fourHour = buildIndicatorSnapshot("4h", result.windows["4h"]);
      const hourly = buildIndicatorSnapshot("1h", result.windows["1h"]);
      if (!daily) result.issues.push({ interval: "1d", code: "warmup" });
      if (!fourHour) result.issues.push({ interval: "4h", code: "warmup" });
      if (!hourly) result.issues.push({ interval: "1h", code: "warmup" });
      if (daily && fourHour && hourly) {
        result.indicators = { "1d": daily, "4h": fourHour, "1h": hourly };
        result.trend = evaluateTrendGate(result.indicators);
        const preliminary = evaluateStrategy({
          indicators: result.indicators,
          trend: result.trend,
          fourHourCandles: result.windows["4h"],
          oneHourCandles: result.windows["1h"],
          analysisTimeMs: time,
          dataComplete: true,
          riskReward: null,
        });
        let currentPrice: number | null = null;
        let currentPriceObservedAtMs: number | null = null;
        let quoteServerTimeMs: number | null = null;
        let quoteFailure: ReturnType<typeof getSpotQuoteFailure> = "spot-price-unavailable";
        try {
          const quote = await restAdapter.getSpotQuote(symbol);
          currentPrice = quote.price;
          currentPriceObservedAtMs = quote.tradeTimeMs;
          quoteServerTimeMs = quote.serverTimeMs;
          quoteFailure = getSpotQuoteFailure(
            currentPrice, currentPriceObservedAtMs, quoteServerTimeMs,
          );
        } catch {
          quoteFailure = "spot-price-unavailable";
        }
        result.entryPlanFailure = quoteFailure;
        const riskContext = getRiskContext();
        result.currentPrice = currentPrice;
        result.currentPriceObservedAtMs = currentPriceObservedAtMs;
        result.currentPriceServerTimeMs = quoteServerTimeMs;
        const freshPrice = quoteFailure === null ? currentPrice : null;
        result.supportResistance = identifySupportResistance(
          result.windows["4h"], freshPrice ?? hourly.close, fourHour.atr14, time,
        );

        let plan: EntryPlan | null = null;
        // crypto-ai-analysis.ENTRY_PLAN.3-1 crypto-ai-analysis.ENTRY_PLAN.5 crypto-ai-analysis.ENTRY_PLAN.5-1
        if (previousPlan) {
          const updatedPlan = updateEntryPlan(previousPlan, {
            analysisTimeMs: time,
            dataComplete: result.issues.length === 0,
            trendQualified: result.trend.eligibleForPullback,
            pullbackValid: preliminary.pullback.valid,
            latestOneHourClose: hourly.close,
            currentPrice,
            currentPriceObservedAtMs,
            quoteServerTimeMs,
            nearestResistance: result.supportResistance.resistance,
            riskContext,
          });
          if (updatedPlan.status === "expired" || updatedPlan.status === "invalidated") {
            result.entryPlan = updatedPlan;
            result.entryPlanFailure = updatedPlan.failure;
            activePlans.delete(symbol);
          } else {
            plan = updatedPlan;
            activePlans.set(symbol, updatedPlan);
          }
        } else if (result.trend.eligibleForPullback && preliminary.pullback.valid && preliminary.confirmation.passed) {
          let quantityRules: SpotQuantityRules | null = null;
          try {
            const metadata = (await restAdapter.getSpotSymbols()).find((item) => item.symbol === symbol);
            if (metadata) {
              quantityRules = {
                minQty: metadata.minQty,
                maxQty: metadata.maxQty,
                stepSize: metadata.stepSize,
              };
            }
          } catch {
            // A plan cannot be sized safely without the exchange's lot-size rules.
          }
          const built = buildEntryPlan({
            referencePrice: hourly.close,
            ema20: hourly.ema20,
            atr1h: hourly.atr14,
            atr4h: fourHour.atr14,
            pullbackLow: preliminary.pullback.lowestLow ?? Number.NaN,
            latestOneHourClose: hourly.close,
            confirmationCloseTimeMs: hourly.candleCloseTimeMs,
            analysisTimeMs: time,
            currentPrice,
            currentPriceObservedAtMs,
            quoteServerTimeMs,
            quantityRules,
            nearestResistance: result.supportResistance.resistance,
            riskContext,
          });
          result.entryPlanFailure = built.failure;
          plan = built.plan;
          if (plan) activePlans.set(symbol, plan);
        }

        if (plan) result.entryPlan = plan;
        result.strategy = evaluateStrategy({
          indicators: result.indicators,
          trend: result.trend,
          fourHourCandles: result.windows["4h"],
          oneHourCandles: result.windows["1h"],
          analysisTimeMs: time,
          dataComplete: true,
          riskReward: plan?.riskReward ?? null,
          entryPlanStatus: plan?.status ?? null,
        });
        result.status = "ready";
        result.reason = null;
      }
    }
    if (result.status === "insufficient-data" && previousPlan) {
      result.entryPlan = withPlanStatus(previousPlan, "invalidated", "insufficient-data");
      result.entryPlanFailure = "insufficient-data";
      activePlans.delete(symbol);
    }
    return record(result);
  }

  async function runManual(symbol: SpotSymbol): Promise<AnalysisAttempt> {
    let time: number;
    try {
      time = await restAdapter.getServerTime();
      if (!Number.isFinite(time)) throw new Error("Invalid Binance server time");
    } catch {
      const result = emptyAttempt(symbol, "manual", null);
      result.issues.push(...SUPPORTED_SPOT_INTERVALS.map((interval) => ({ interval, code: "unavailable" as const })));
      const previousPlan = activePlans.get(symbol);
      if (previousPlan) {
        result.entryPlan = withPlanStatus(previousPlan, "invalidated", "insufficient-data");
        result.entryPlanFailure = "insufficient-data";
        activePlans.delete(symbol);
      }
      return record(result);
    }
    return run(symbol, "manual", time);
  }

  function onHourlyClose(event: MarketCandle): Promise<AnalysisAttempt | null> {
    if (!event.isClosed || event.interval !== "1h" || !isSpotSymbol(event.symbol) ||
      !Number.isFinite(event.openTimeMs) || !Number.isFinite(event.closeTimeMs) ||
      event.openTimeMs % intervalToMs("1h") !== 0 ||
      event.closeTimeMs !== event.openTimeMs + intervalToMs("1h") - 1) return Promise.resolve(null);
    const key = `${event.symbol}:${event.openTimeMs}`;
    let attempt = closedAttempts.get(key);
    if (!attempt) {
      attempt = run(event.symbol, "hourly-close", event.closeTimeMs, event);
      closedAttempts.set(key, attempt);
      if (closedAttempts.size > 500) closedAttempts.delete(closedAttempts.keys().next().value!);
    }
    return attempt;
  }

  return {
    runManual, onHourlyClose, updateAiSnapshot,
    subscribe(listener: (attempt: AnalysisAttempt) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getHistory: () => [...history],
    getRecords: () => [...records],
    getLatest: (symbol: SpotSymbol) => [...history].reverse().find((attempt) => attempt.symbol === symbol) ?? null,
  };
}
