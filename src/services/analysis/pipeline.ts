import { SUPPORTED_SPOT_INTERVALS, intervalToMs, isSpotSymbol, type MarketCandle,
  type MarketDataHealth, type MarketDataRestAdapter, type SpotInterval, type SpotSymbol } from "../market-data/types.ts";
import { inspectWindow, type AnalysisIssue } from "./quality.ts";
import {
  TREND_PULLBACK_V1,
  buildIndicatorSnapshot,
  evaluateTrendGate,
  type AnalysisIndicatorSet,
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
  signal: null;
  entryPlan: null;
}

export interface AnalysisPipelineOptions {
  restAdapter: MarketDataRestAdapter;
  getHealth: () => MarketDataHealth;
  minimumCandles?: Record<SpotInterval, number>;
  storage?: Pick<Storage, "getItem" | "setItem">;
}

export type AnalysisAttemptRecord = Omit<AnalysisAttempt, "windows" | "signal" | "entryPlan">;
const HISTORY_KEY = "opencharts.analysis.attempts.v1";

// EMA200 on 1d, 4h structure, and 1h momentum require independent warmup windows.
export const DEFAULT_MINIMUM_CANDLES: Record<SpotInterval, number> = { "1d": 210, "4h": 65, "1h": 50 };

function emptyAttempt(symbol: SpotSymbol, trigger: AnalysisTrigger, time: number | null): AnalysisAttempt {
  return {
    symbol, trigger, analysisTimeMs: time, status: "insufficient-data", decision: "暂不入场",
    reason: "数据不足或多周期数据不同步",
    candleCloseTimes: { "1d": null, "4h": null, "1h": null },
    windows: { "1d": [], "4h": [], "1h": [] }, issues: [],
    strategyVersion: TREND_PULLBACK_V1.version, indicators: null, trend: null,
    signal: null, entryPlan: null,
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
export function createAnalysisPipeline({ restAdapter, getHealth, minimumCandles = DEFAULT_MINIMUM_CANDLES, storage }: AnalysisPipelineOptions) {
  const requiredCandles: Record<SpotInterval, number> = {
    "1d": Math.max(DEFAULT_MINIMUM_CANDLES["1d"], minimumCandles["1d"]),
    "4h": Math.max(DEFAULT_MINIMUM_CANDLES["4h"], minimumCandles["4h"]),
    "1h": Math.max(DEFAULT_MINIMUM_CANDLES["1h"], minimumCandles["1h"]),
  };
  const closedAttempts = new Map<string, Promise<AnalysisAttempt>>();
  const listeners = new Set<(attempt: AnalysisAttempt) => void>();
  const history: AnalysisAttempt[] = [];
  let records: AnalysisAttemptRecord[] = [];
  try {
    const stored = storage?.getItem(HISTORY_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    if (Array.isArray(parsed)) records = parsed.filter((item) => item && typeof item === "object").slice(-100);
  } catch {
    // Private browsing or malformed prior storage should not prevent analysis.
  }

  function record(attempt: AnalysisAttempt): AnalysisAttempt {
    history.push(attempt);
    if (history.length > 100) history.shift();
    const { windows: _windows, signal: _signal, entryPlan: _entryPlan, ...summary } = attempt;
    records.push(summary);
    if (records.length > 100) records.shift();
    try {
      storage?.setItem(HISTORY_KEY, JSON.stringify(records));
    } catch {
      // Keep this session's record even if browser storage is unavailable.
    }
    for (const listener of listeners) listener(attempt);
    return attempt;
  }

  async function run(symbol: SpotSymbol, trigger: AnalysisTrigger, time: number, event?: MarketCandle): Promise<AnalysisAttempt> {
    const result = emptyAttempt(symbol, trigger, time);
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
        result.status = "ready";
        result.reason = null;
      }
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
    runManual, onHourlyClose,
    subscribe(listener: (attempt: AnalysisAttempt) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getHistory: () => [...history],
    getRecords: () => [...records],
    getLatest: (symbol: SpotSymbol) => [...history].reverse().find((attempt) => attempt.symbol === symbol) ?? null,
  };
}
