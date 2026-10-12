export const BACKTEST_RECORD_KEY = "opencharts.crypto.backtest-record.v1";
export const BACKTEST_STATUS_KEY = "opencharts.crypto.backtest-status.v1";

const SUPPORTED_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"];

export const DEFAULT_COST_ASSUMPTIONS = Object.freeze({
  buyFeeRate: 0.001,
  sellFeeRate: 0.001,
  buySlippageRate: 0.0005,
  sellSlippageRate: 0.0005,
});

export function validCostAssumptions(value) {
  return value && Object.keys(DEFAULT_COST_ASSUMPTIONS).every((key) =>
    Number.isFinite(value[key]) && value[key] >= 0 && value[key] < 1);
}

function profitFactorAtLeast(value, threshold) {
  return value === "infinite" || (Number.isFinite(value) && value >= threshold);
}

function validPeriod(period) {
  return period && Number.isFinite(period.startMs) && Number.isFinite(period.endMs) &&
    period.startMs <= period.endMs;
}

function validResult(result) {
  const metrics = result?.metrics;
  return validPeriod(result?.period) && Array.isArray(result.trades) && result.buyAndHold &&
    Number.isInteger(metrics?.tradeCount) && metrics.tradeCount >= 0 &&
    Number.isFinite(metrics.maxDrawdownPct) && metrics.maxDrawdownPct >= 0 && metrics.maxDrawdownPct <= 100 &&
    Number.isFinite(metrics.netReturnPct) &&
    (metrics.profitFactor === null || metrics.profitFactor === "infinite" ||
      (Number.isFinite(metrics.profitFactor) && metrics.profitFactor >= 0));
}

// crypto-ai-analysis.VALIDATION.18-1
function completeReport(report) {
  return report && Number.isFinite(report.generatedAtMs) && validPeriod(report.requestedPeriod) &&
    validCostAssumptions(report.costAssumptions) &&
    validResult(report.portfolio?.research) && validResult(report.portfolio?.outOfSample) &&
    SUPPORTED_SYMBOLS.every((symbol) => validResult(report.symbols?.[symbol]?.research) &&
      validResult(report.symbols?.[symbol]?.outOfSample)) &&
    Array.isArray(report.robustness?.walkForward) && Array.isArray(report.robustness?.marketRegimes) &&
    Array.isArray(report.robustness?.parameterSensitivity);
}

export function deriveBacktestStatus(report) {
  if (!report || report.strategyVersion !== "trend-pullback-v1" || report.status === "invalid" ||
    !completeReport(report) || !["closedCandlesOnly", "nextBarExecution", "deterministicEngine"]
      .every((key) => report.validityChecks?.[key] === true)) {
    return { status: "invalid", strategyVersion: report?.strategyVersion ?? "trend-pullback-v1" };
  }
  const outOfSample = report.portfolio?.outOfSample?.metrics;
  if (!outOfSample || !Number.isFinite(outOfSample.tradeCount) ||
    !Number.isFinite(outOfSample.maxDrawdownPct) || !Number.isFinite(outOfSample.netReturnPct)) {
    return { status: "invalid", strategyVersion: report.strategyVersion };
  }
  const eligibleSymbols = SUPPORTED_SYMBOLS.filter((symbol) =>
    profitFactorAtLeast(report.symbols?.[symbol]?.outOfSample?.metrics?.profitFactor, 1));
  const researchUsable = outOfSample.tradeCount >= 100 &&
    profitFactorAtLeast(outOfSample.profitFactor, 1.1) && outOfSample.maxDrawdownPct <= 25 &&
    outOfSample.netReturnPct > 0 && eligibleSymbols.length >= 4 &&
    SUPPORTED_SYMBOLS.every((symbol) => report.symbols?.[symbol]);
  return { status: researchUsable ? "research-usable" : "experimental", strategyVersion: report.strategyVersion };
}

export function createBacktestRecord(report, costAssumptions, updatedAtMs = Date.now()) {
  if (!validCostAssumptions(costAssumptions)) throw new Error("Invalid backtest cost assumptions");
  const derived = deriveBacktestStatus(report);
  if (!validCostAssumptions(report?.costAssumptions) ||
    Object.keys(DEFAULT_COST_ASSUMPTIONS).some((key) => report.costAssumptions[key] !== costAssumptions[key])) {
    derived.status = "invalid";
  }
  return {
    ...derived,
    costAssumptions,
    updatedAtMs,
    reportGeneratedAtMs: Number.isFinite(report?.generatedAtMs) ? report.generatedAtMs : null,
    statusReason: typeof report?.statusReason === "string" ? report.statusReason : null,
    report,
  };
}

export function persistBacktestRecord(storage, report, costAssumptions, updatedAtMs = Date.now()) {
  if (!storage?.setItem) throw new Error("Backtest report storage is unavailable");
  const record = createBacktestRecord(report, costAssumptions, updatedAtMs);
  storage.setItem(BACKTEST_RECORD_KEY, JSON.stringify(record));
  return record;
}

export function createInvalidBacktestRecord(strategyVersion, updatedAtMs = Date.now(), statusReason = null) {
  return {
    status: "invalid",
    strategyVersion,
    costAssumptions: DEFAULT_COST_ASSUMPTIONS,
    updatedAtMs,
    reportGeneratedAtMs: null,
    statusReason: typeof statusReason === "string" ? statusReason : null,
    report: null,
  };
}

export function readBacktestRecord(storage) {
  try {
    const record = JSON.parse(storage?.getItem(BACKTEST_RECORD_KEY) ?? "null");
    if (!record || typeof record.strategyVersion !== "string" || !Number.isFinite(record.updatedAtMs)) return null;
    if (record.status === "invalid" && !record.report) {
      return createInvalidBacktestRecord(record.strategyVersion, record.updatedAtMs, record.statusReason);
    }
    const validated = createBacktestRecord(record.report, record.costAssumptions, record.updatedAtMs);
    if (record.status === "invalid" || record.strategyVersion !== validated.strategyVersion) validated.status = "invalid";
    return validated;
  } catch {
    return null;
  }
}

export function backtestStatusSummary(record) {
  if (!record) return null;
  const { report: _report, ...status } = record;
  return status;
}
