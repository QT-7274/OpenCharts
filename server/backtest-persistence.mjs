export const BACKTEST_RECORD_KEY = "opencharts.crypto.backtest-record.v1";
export const BACKTEST_STATUS_KEY = "opencharts.crypto.backtest-status.v1";

const SUPPORTED_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"];

function sanitizeDiagnosticText(value) {
  if (typeof value !== "string") return null;
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/(?:Bearer\s+|(?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "[redacted]")
    .replace(/(?:file:\/\/|\/(?:Users|home|private|tmp|var)\/|[A-Za-z]:\\)[^\s]+/g, "[redacted-path]")
    .slice(0, 500);
}

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

function finiteOrNull(value) {
  return value === null || Number.isFinite(value);
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validProfitFactor(value) {
  return value === null || value === "infinite" || (Number.isFinite(value) && value >= 0);
}

function validMetrics(metrics) {
  if (!metrics || typeof metrics !== "object") return false;
  const integerFields = ["signalCount", "tradeCount", "skippedSignalCount", "maxConsecutiveLosses"];
  const finiteFields = [
    "netReturnPct", "totalCosts", "endingEquity",
  ];
  const nullableFiniteFields = [
    "annualizedReturnPct", "averageNetPnl", "averageHoldingHours", "averageActualRiskReward", "sharpeRatio",
  ];
  if (!integerFields.every((key) => nonNegativeInteger(metrics[key])) ||
    !finiteFields.every((key) => Number.isFinite(metrics[key])) ||
    !nullableFiniteFields.every((key) => finiteOrNull(metrics[key])) ||
    !Number.isFinite(metrics.maxDrawdownPct) || metrics.maxDrawdownPct < 0 || metrics.maxDrawdownPct > 100 ||
    !finiteOrNull(metrics.winRatePct) || (metrics.winRatePct !== null &&
      (metrics.winRatePct < 0 || metrics.winRatePct > 100)) ||
    !validProfitFactor(metrics.profitFactor) || metrics.totalCosts < 0 || metrics.endingEquity < 0 ||
    !metrics.skipReasons || typeof metrics.skipReasons !== "object" ||
    !Object.values(metrics.skipReasons).every(nonNegativeInteger) ||
    !metrics.strategyStateCounts || typeof metrics.strategyStateCounts !== "object") return false;
  return ["watch", "setup", "enter", "avoid"].every((key) =>
    nonNegativeInteger(metrics.strategyStateCounts[key]));
}

function validTrade(trade) {
  return trade && typeof trade === "object" && typeof trade.id === "string" && trade.id.length > 0 &&
    SUPPORTED_SYMBOLS.includes(trade.symbol) && Number.isFinite(trade.entryTimeMs) &&
    Number.isFinite(trade.exitTimeMs) && trade.entryTimeMs <= trade.exitTimeMs &&
    ["theoreticalEntryPrice", "actualEntryPrice", "averageExitPrice", "stopPrice",
      "takeProfit1Price", "takeProfit2Price", "quantity"].every((key) =>
      Number.isFinite(trade[key]) && trade[key] > 0) &&
    Number.isFinite(trade.netPnl) && Number.isFinite(trade.costs) && trade.costs >= 0 &&
    Number.isFinite(trade.actualRisk) && trade.actualRisk >= 0 && finiteOrNull(trade.actualRiskReward) &&
    Number.isFinite(trade.holdingHours) && trade.holdingHours >= 0 &&
    ["stop", "break-even", "take-profit-2", "period-end"].includes(trade.exitReason) &&
    typeof trade.strategyVersion === "string" && trade.strategyVersion.length > 0;
}

function validBuyAndHold(value) {
  return value && typeof value === "object" &&
    ["netReturnPct", "maxDrawdownPct", "netReturnDifferencePct", "maxDrawdownDifferencePct"]
      .every((key) => Number.isFinite(value[key])) &&
    value.maxDrawdownPct >= 0 && value.maxDrawdownPct <= 100 &&
    finiteOrNull(value.sharpeRatio) && finiteOrNull(value.sharpeDifference);
}

function validResult(result) {
  const metrics = result?.metrics;
  return validPeriod(result?.period) && validMetrics(metrics) && Array.isArray(result.trades) &&
    result.trades.every(validTrade) && validBuyAndHold(result.buyAndHold);
}

function validRobustness(robustness) {
  if (!robustness || typeof robustness !== "object" || !Array.isArray(robustness.walkForward) ||
    robustness.walkForward.length < 3 || !Array.isArray(robustness.marketRegimes) ||
    !Array.isArray(robustness.parameterSensitivity)) return false;

  const folds = [...robustness.walkForward].sort((a, b) => (a?.id ?? 0) - (b?.id ?? 0));
  if (!folds.every((fold, index) => fold && Number.isSafeInteger(fold.id) && fold.id > 0 &&
    (index === 0 || folds[index - 1].id < fold.id) && validPeriod(fold.trainingPeriod) &&
    validPeriod(fold.testPeriod) && fold.trainingPeriod.endMs < fold.testPeriod.startMs &&
    typeof fold.sampleSufficient === "boolean" && validMetrics(fold.metrics))) return false;
  for (let index = 1; index < folds.length; index += 1) {
    if (folds[index - 1].testPeriod.endMs >= folds[index].testPeriod.startMs) return false;
  }

  const regimes = new Set(robustness.marketRegimes.map((item) => item?.regime));
  if (regimes.size !== 4 || !["bull", "sideways", "bear", "unknown"].every((regime) => regimes.has(regime)) ||
    !robustness.marketRegimes.every((item) => item && Number.isSafeInteger(item.tradeCount) && item.tradeCount >= 0 &&
      Number.isFinite(item.netPnl) && finiteOrNull(item.winRatePct) &&
      (item.winRatePct === null || (item.winRatePct >= 0 && item.winRatePct <= 100)) &&
      validProfitFactor(item.profitFactor))) return false;

  const sensitivity = robustness.parameterSensitivity;
  const scores = sensitivity.map((item) => item?.minimumScore);
  const versions = sensitivity.map((item) => item?.strategyVersion);
  return scores.length === 3 && [65, 70, 75].every((score) => scores.includes(score)) &&
    new Set(scores).size === 3 && new Set(versions).size === 3 &&
    sensitivity.every((item) => item && typeof item.strategyVersion === "string" &&
      item.strategyVersion.length > 0 && item.evaluationScope === "research-only" &&
      validPeriod(item.period) && validMetrics(item.metrics));
}

// crypto-ai-analysis.VALIDATION.18-1
function completeReport(report) {
  return report && typeof report === "object" && report.strategyVersion === "trend-pullback-v1" &&
    ["research-usable", "experimental", "invalid"].includes(report.status) &&
    typeof report.statusReason === "string" && Number.isFinite(report.generatedAtMs) &&
    validPeriod(report.requestedPeriod) &&
    validCostAssumptions(report.costAssumptions) &&
    validResult(report.portfolio?.research) && validResult(report.portfolio?.outOfSample) &&
    SUPPORTED_SYMBOLS.every((symbol) => validResult(report.symbols?.[symbol]?.research) &&
      validResult(report.symbols?.[symbol]?.outOfSample)) &&
    report.validityChecks && typeof report.validityChecks === "object" &&
    ["closedCandlesOnly", "nextBarExecution", "deterministicEngine"]
      .every((key) => typeof report.validityChecks[key] === "boolean") &&
    validRobustness(report.robustness);
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

export function createBacktestRecord(report, costAssumptions, updatedAtMs = Date.now(), metadata = {}) {
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
    taskId: typeof metadata.taskId === "string" ? metadata.taskId : null,
    statusReason: sanitizeDiagnosticText(report?.statusReason),
    report,
  };
}

export function persistBacktestRecord(storage, report, costAssumptions, updatedAtMs = Date.now(), metadata = {}) {
  if (!storage?.setItem) throw new Error("Backtest report storage is unavailable");
  const record = createBacktestRecord(report, costAssumptions, updatedAtMs, metadata);
  storage.setItem(BACKTEST_RECORD_KEY, JSON.stringify(record));
  return record;
}

export function createInvalidBacktestRecord(strategyVersion, updatedAtMs = Date.now(), statusReason = null, metadata = {}) {
  return {
    status: "invalid",
    strategyVersion,
    costAssumptions: DEFAULT_COST_ASSUMPTIONS,
    updatedAtMs,
    reportGeneratedAtMs: null,
    taskId: typeof metadata.taskId === "string" ? metadata.taskId : null,
    statusReason: sanitizeDiagnosticText(statusReason),
    report: null,
  };
}

export function readBacktestRecord(storage) {
  try {
    const record = JSON.parse(storage?.getItem(BACKTEST_RECORD_KEY) ?? "null");
    if (!record || typeof record.strategyVersion !== "string" || !Number.isFinite(record.updatedAtMs)) return null;
    if (record.status === "invalid" && !record.report) {
      return createInvalidBacktestRecord(record.strategyVersion, record.updatedAtMs, record.statusReason, {
        taskId: record.taskId,
      });
    }
    if (!completeReport(record.report)) {
      return createInvalidBacktestRecord(record.strategyVersion, record.updatedAtMs,
        "Persisted backtest report failed structural validation", { taskId: record.taskId });
    }
    const validated = createBacktestRecord(record.report, record.costAssumptions, record.updatedAtMs, {
      taskId: record.taskId,
    });
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
