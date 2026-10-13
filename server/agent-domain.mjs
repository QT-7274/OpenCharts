import {
  BACKTEST_RECORD_KEY,
  backtestStatusSummary,
  readBacktestRecord,
} from "./backtest-persistence.mjs";

const SUPPORTED_SYMBOLS = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"]);
const SUPPORTED_INTERVALS = new Set(["1h", "4h", "1d"]);
const DEFAULT_INTERVALS = ["1h", "4h", "1d"];
const DEFAULT_CANDLE_LIMIT = 200;
const MAX_CANDLE_LIMIT = 500;

export class AgentDomainError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "AgentDomainError";
    this.statusCode = statusCode;
  }
}

function requireSymbol(value) {
  if (typeof value !== "string" || !SUPPORTED_SYMBOLS.has(value)) {
    throw new AgentDomainError("Unsupported spot symbol", 400);
  }
  return value;
}

function normalizeIntervals(value) {
  const requested = value == null ? DEFAULT_INTERVALS : value;
  if (!Array.isArray(requested) || requested.length === 0 || requested.length > DEFAULT_INTERVALS.length) {
    throw new AgentDomainError("One or more supported spot intervals are required", 400);
  }
  const intervals = [...new Set(requested)];
  if (intervals.some((interval) => typeof interval !== "string" || !SUPPORTED_INTERVALS.has(interval))) {
    throw new AgentDomainError("Unsupported spot interval", 400);
  }
  return intervals;
}

function normalizeLimit(value) {
  if (value == null || value === "") return DEFAULT_CANDLE_LIMIT;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CANDLE_LIMIT) {
    throw new AgentDomainError(`Candle limit must be an integer from 1 to ${MAX_CANDLE_LIMIT}`, 400);
  }
  return limit;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function sanitizeDiagnosticText(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/(?:Bearer\s+|(?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "[redacted]")
    .replace(/(?:file:\/\/|\/(?:Users|home|private|tmp|var)\/|[A-Za-z]:\\)[^\s]+/g, "[redacted-path]")
    .slice(0, 500);
}

function serializeLedgerState(value) {
  const state = clone(value);
  if (!state || typeof state !== "object") return state;
  if (Array.isArray(state.events)) {
    state.events = state.events.map((event) => ({
      ...event,
      reason: event?.reason == null ? event?.reason : sanitizeDiagnosticText(event.reason),
    }));
  }
  if (state.pausedSymbols && typeof state.pausedSymbols === "object") {
    state.pausedSymbols = Object.fromEntries(Object.entries(state.pausedSymbols)
      .map(([symbol, reason]) => [symbol, sanitizeDiagnosticText(reason)]));
  }
  return state;
}

// crypto-ai-analysis.AGENT_ACCESS.3 crypto-ai-analysis.AGENT_ACCESS.6
export function serializeAnalysisAttempt(attempt) {
  if (!attempt) return null;
  return clone({
    symbol: attempt.symbol,
    trigger: attempt.trigger,
    analysisTimeMs: attempt.analysisTimeMs,
    status: attempt.status,
    decision: attempt.decision,
    reason: attempt.reason,
    candleCloseTimes: attempt.candleCloseTimes,
    issues: attempt.issues,
    strategyVersion: attempt.strategyVersion,
    indicators: attempt.indicators,
    trend: attempt.trend,
    strategy: attempt.strategy,
    currentPrice: attempt.currentPrice,
    currentPriceObservedAtMs: attempt.currentPriceObservedAtMs,
    supportResistance: attempt.supportResistance,
    currentPriceServerTimeMs: attempt.currentPriceServerTimeMs,
    entryPlan: attempt.entryPlan,
    entryPlanFailure: attempt.entryPlanFailure,
    snapshotId: attempt.snapshotId,
    aiInputSummary: attempt.aiInputSummary,
    aiExplanation: attempt.aiExplanation,
  });
}

function safeRuntimeStatus(value) {
  const runtime = value && typeof value === "object" ? value : {};
  return {
    connection: typeof runtime.connection === "string" ? runtime.connection : "unknown",
    shuttingDown: runtime.shuttingDown === true,
    ready: runtime.ready === true,
    recovering: runtime.recovering === true,
    lastMarketAtMs: Number.isFinite(runtime.lastMarketAtMs) ? runtime.lastMarketAtMs : null,
    lastSuccessfullyProcessedAtMs: Number.isFinite(runtime.lastSuccessfullyProcessedAtMs)
      ? runtime.lastSuccessfullyProcessedAtMs
      : null,
    pausedSymbols: runtime.pausedSymbols && typeof runtime.pausedSymbols === "object"
      ? Object.fromEntries(Object.entries(runtime.pausedSymbols)
        .map(([symbol, reason]) => [symbol, sanitizeDiagnosticText(reason)]))
      : {},
    storageStatus: runtime.storageStatus === "error" ? "error" : "ok",
    runtimeFailure: runtime.runtimeFailure ? "runtime-failure" : null,
  };
}

function findAttempt(analysisPipeline, snapshotId) {
  if (typeof snapshotId !== "string" || snapshotId.length === 0 || snapshotId.length > 240) {
    throw new AgentDomainError("A valid analysis snapshot ID is required", 400);
  }
  const current = analysisPipeline.getHistory?.().find((attempt) => attempt.snapshotId === snapshotId);
  if (current) return current;
  const record = analysisPipeline.getRecords?.().find((item) => item.snapshotId === snapshotId);
  return record ?? null;
}

function readPersistedBacktest(backtestStorage, backtestJobs) {
  const current = backtestJobs?.getLatestBacktestStatus?.();
  if (current) return current;
  return readBacktestRecord(backtestStorage);
}

// crypto-ai-analysis.AGENT_ACCESS.1 crypto-ai-analysis.AGENT_ACCESS.1-1
export function createAgentDomain({
  restAdapter,
  analysisPipeline,
  ledger,
  getRuntimeStatus = () => ({}),
  backtestStorage,
  backtestJobs = null,
  now = Date.now,
}) {
  if (!restAdapter || !analysisPipeline || !ledger || !backtestStorage) {
    throw new Error("Agent domain dependencies are incomplete");
  }

  return {
    // crypto-ai-analysis.AGENT_ACCESS.2
    async getMarketSnapshot({ symbol: symbolInput, intervals: intervalsInput, limit: limitInput } = {}) {
      const symbol = requireSymbol(symbolInput);
      const intervals = normalizeIntervals(intervalsInput);
      const limit = normalizeLimit(limitInput);
      const serverTimeMs = await restAdapter.getServerTime();
      const quote = await restAdapter.getSpotQuote(symbol);
      const candles = {};
      for (const interval of intervals) {
        const rows = await restAdapter.getCandles({ symbol, interval, limit });
        candles[interval] = rows.filter((candle) => candle.isClosed).slice(-limit);
      }
      return {
        source: "binance-spot-public",
        symbol,
        observedAtMs: now(),
        serverTimeMs,
        quote: clone(quote),
        candles: clone(candles),
      };
    },

    // crypto-ai-analysis.AGENT_ACCESS.3
    async analyzeSymbol({ symbol: symbolInput } = {}) {
      const symbol = requireSymbol(symbolInput);
      const attempt = await analysisPipeline.runManual(symbol);
      return {
        source: "analysisPipeline",
        observedAtMs: now(),
        snapshot: serializeAnalysisAttempt(attempt),
      };
    },

    // crypto-ai-analysis.AGENT_ACCESS.4 crypto-ai-analysis.AGENT_ACCESS.6
    getAnalysisHistory({ symbol: symbolInput, limit: limitInput } = {}) {
      const symbol = symbolInput == null ? null : requireSymbol(symbolInput);
      const limit = normalizeLimit(limitInput);
      const records = analysisPipeline.getRecords()
        .filter((record) => symbol == null || record.symbol === symbol)
        .slice(-limit)
        .map(serializeAnalysisAttempt);
      return { source: "analysisPipeline", observedAtMs: now(), symbol, records };
    },

    getAnalysisSnapshot({ snapshotId } = {}) {
      const attempt = findAttempt(analysisPipeline, snapshotId);
      if (!attempt) throw new AgentDomainError("Analysis snapshot not found", 404);
      return {
        source: "analysisPipeline",
        observedAtMs: now(),
        snapshot: serializeAnalysisAttempt(attempt),
      };
    },

    // crypto-ai-analysis.AGENT_ACCESS.4 crypto-ai-analysis.AGENT_ACCESS.7
    getBacktestReport() {
      const record = readPersistedBacktest(backtestStorage, backtestJobs);
      if (!record?.report) throw new AgentDomainError("No persisted backtest report", 404);
      return {
        source: "backtest-persistence",
        reportGeneratedAtMs: record.reportGeneratedAtMs,
        observedAtMs: now(),
        backtestStatus: backtestStatusSummary(record),
        report: clone(record.report),
      };
    },

    // crypto-ai-analysis.AGENT_ACCESS.4 crypto-ai-analysis.AGENT_ACCESS.7
    getForwardSimulationState() {
      const runtime = safeRuntimeStatus(getRuntimeStatus());
      const record = readPersistedBacktest(backtestStorage, backtestJobs);
      return {
        source: "forward-simulation",
        observedAtMs: now(),
        runtime,
        ledger: serializeLedgerState(ledger.getState()),
        riskContext: clone(ledger.getRiskContext()),
        costComparison: clone(ledger.getCostComparison()),
        storageError: ledger.getRuntimeError() ? "storage-error" : null,
        backtestStatus: record ? backtestStatusSummary(record) : null,
      };
    },

    // crypto-ai-analysis.AGENT_ACCESS.5
    createPaperOrderDraft({ snapshotId } = {}) {
      const attempt = findAttempt(analysisPipeline, snapshotId);
      if (!attempt) throw new AgentDomainError("Analysis snapshot not found", 404);
      const record = readPersistedBacktest(backtestStorage, backtestJobs);
      const backtestStatus = backtestStatusSummary(record);
      if (!backtestStatus || backtestStatus.status === "invalid" ||
        backtestStatus.strategyVersion !== attempt.strategyVersion) {
        throw new AgentDomainError("A valid backtest for the analysis strategy is required", 409);
      }
      let draft;
      try {
        draft = ledger.createDraft(attempt, backtestStatus.status, backtestStatus.costAssumptions);
      } catch {
        throw new AgentDomainError("Paper order draft failed eligibility or risk checks", 409);
      }
      return {
        source: "paper-ledger",
        observedAtMs: now(),
        confirmationRequired: true,
        realOrderCapability: false,
        draft: clone(draft),
      };
    },

    getCapabilities() {
      return {
        source: "opencharts-agent-api",
        observedAtMs: now(),
        supportedSymbols: [...SUPPORTED_SYMBOLS],
        supportedIntervals: [...SUPPORTED_INTERVALS],
        capabilities: {
          marketSnapshot: true,
          analysis: true,
          analysisHistory: true,
          backtestReport: true,
          forwardSimulationState: true,
          paperOrderDraft: true,
          paperOrderConfirmation: false,
          realOrderSubmission: false,
        },
      };
    },

    getBacktestRecordForTests() {
      return readPersistedBacktest(backtestStorage, backtestJobs);
    },
  };
}

export { BACKTEST_RECORD_KEY };
