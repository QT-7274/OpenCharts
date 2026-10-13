import { randomUUID } from "node:crypto";
import {
  BACKTEST_RECORD_KEY,
  DEFAULT_COST_ASSUMPTIONS,
  createInvalidBacktestRecord,
  persistBacktestRecord,
  readBacktestRecord,
  validCostAssumptions,
} from "./backtest-persistence.mjs";

export const BACKTEST_JOBS_KEY = "opencharts.crypto.backtest-jobs.v1";
export const BACKTEST_STRATEGY_VERSION = "trend-pullback-v1";
const SUPPORTED_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"];
const SUPPORTED_INTERVALS = ["1h", "4h", "1d"];
const TERMINAL_STATUSES = new Set(["completed", "failed"]);

export class BacktestJobError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "BacktestJobError";
    this.statusCode = statusCode;
  }
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function isSameSet(value, expected) {
  return Array.isArray(value) && value.length === expected.length &&
    [...new Set(value)].length === expected.length && expected.every((item) => value.includes(item));
}

function safeErrorSummary(error) {
  const message = error instanceof Error ? error.message : "Backtest job failed";
  return message
    .replace(/[\r\n]+/g, " ")
    .replace(/(?:Bearer\s+|(?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "[redacted]")
    .replace(/(?:file:\/\/|\/(?:Users|home|private|tmp|var)\/|[A-Za-z]:\\)[^\s]+/g, "[redacted-path]")
    .slice(0, 500);
}

function readJobState(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(BACKTEST_JOBS_KEY) ?? "null");
    const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks.filter((task) =>
      task && typeof task.taskId === "string" && typeof task.status === "string") : [];
    const reports = parsed?.reports && typeof parsed.reports === "object" ? parsed.reports : {};
    const latestTaskId = typeof parsed?.latestTaskId === "string"
      ? parsed.latestTaskId
      : tasks.at(-1)?.taskId ?? null;
    return { tasks, reports, latestTaskId };
  } catch {
    return { tasks: [], reports: {}, latestTaskId: null };
  }
}

function validateRequest(input = {}) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new BacktestJobError("A JSON object is required", 400);
  }
  if (Object.prototype.hasOwnProperty.call(input, "strategyVersion")) {
    throw new BacktestJobError("strategyVersion is server-controlled", 400);
  }
  if (input.symbols != null && !isSameSet(input.symbols, SUPPORTED_SYMBOLS)) {
    throw new BacktestJobError("Backtest jobs must cover the supported six Spot symbols", 400);
  }
  if (input.intervals != null && !isSameSet(input.intervals, SUPPORTED_INTERVALS)) {
    throw new BacktestJobError("Backtest jobs must use the supported 1h, 4h and 1d intervals", 400);
  }
  const costAssumptions = input.costAssumptions ?? DEFAULT_COST_ASSUMPTIONS;
  if (!validCostAssumptions(costAssumptions)) {
    throw new BacktestJobError("Invalid backtest cost assumptions", 400);
  }
  const initialCapital = input.initialCapital ?? 10_000;
  if (!Number.isFinite(initialCapital) || initialCapital <= 0 || initialCapital > 1_000_000_000) {
    throw new BacktestJobError("initialCapital must be between 0 and 1000000000", 400);
  }
  return {
    strategyVersion: BACKTEST_STRATEGY_VERSION,
    symbols: [...SUPPORTED_SYMBOLS],
    intervals: [...SUPPORTED_INTERVALS],
    initialCapital,
    costAssumptions: { ...costAssumptions },
  };
}

function publicTask(task) {
  return clone({
    taskId: task.taskId,
    strategyVersion: task.strategyVersion,
    requestedAtMs: task.requestedAtMs,
    updatedAtMs: task.updatedAtMs,
    phase: task.phase,
    progress: task.progress,
    status: task.status,
    errorSummary: task.errorSummary,
    reportGeneratedAtMs: task.reportGeneratedAtMs,
    parameters: task.parameters,
  });
}

// crypto-ai-analysis.BACKTEST_JOBS.2 crypto-ai-analysis.BACKTEST_JOBS.6
export function createBacktestJobRunner({
  storage,
  loadHistory,
  runBacktest,
  now = Date.now,
  schedule = (callback) => queueMicrotask(callback),
} = {}) {
  if (!storage?.getItem || !storage?.setItem || typeof loadHistory !== "function" || typeof runBacktest !== "function") {
    throw new Error("Backtest job runner dependencies are incomplete");
  }

  const persisted = readJobState(storage);
  const tasks = new Map(persisted.tasks.map((task) => [task.taskId, task]));
  const reports = new Map(Object.entries(persisted.reports));
  let latestTaskId = persisted.latestTaskId;
  let activeTaskId = null;
  let pumpScheduled = false;
  let dirty = false;

  for (const task of tasks.values()) {
    if (task.status === "queued" || task.status === "running") {
      task.status = "failed";
      task.phase = "recovered-after-restart";
      task.updatedAtMs = now();
      task.errorSummary = "Process restarted while the backtest task was running";
      dirty = true;
    }
  }
  if (dirty) persistTasks();

  function persistTasks() {
    storage.setItem(BACKTEST_JOBS_KEY, JSON.stringify({
      schemaVersion: 1,
      latestTaskId,
      tasks: [...tasks.values()],
      reports: Object.fromEntries(reports),
    }));
  }

  function update(task, values) {
    if (TERMINAL_STATUSES.has(task.status)) return false;
    Object.assign(task, values, { updatedAtMs: now() });
    persistTasks();
    return true;
  }

  function schedulePump() {
    if (pumpScheduled) return;
    pumpScheduled = true;
    schedule(() => {
      pumpScheduled = false;
      pump();
    });
  }

  function pump() {
    if (activeTaskId) return;
    const next = [...tasks.values()].find((task) => task.status === "queued");
    if (!next) return;
    activeTaskId = next.taskId;
    void run(next).finally(() => {
      activeTaskId = null;
      schedulePump();
    });
  }

  async function run(task) {
    if (TERMINAL_STATUSES.has(task.status)) return;
    update(task, { status: "running", phase: "loading-history", progress: 0, errorSummary: null });
    try {
      const history = await loadHistory({
        onProgress: ({ completed, total }) => {
          if (task.status !== "running") return;
          const progress = total > 0 ? Math.min(85, Math.max(1, Math.round((completed / total) * 85))) : 1;
          update(task, { phase: "loading-history", progress });
        },
      });
      update(task, { phase: "running-backtest", progress: 90 });
      const report = await runBacktest(history.assets, {
        initialCapital: task.parameters.initialCapital,
        ...task.parameters.costAssumptions,
      }, history.requestedPeriod);
      if (task.status !== "running") return;
      reports.set(task.taskId, {
        report: clone(report),
        reportGeneratedAtMs: report.generatedAtMs,
      });
      persistTasks();
      if (latestTaskId === task.taskId) {
        persistBacktestRecord(storage, report, report.costAssumptions, now(), { taskId: task.taskId });
      }
      update(task, {
        status: "completed",
        phase: "completed",
        progress: 100,
        reportGeneratedAtMs: report.generatedAtMs,
        errorSummary: null,
      });
    } catch (error) {
      if (TERMINAL_STATUSES.has(task.status)) return;
      const reason = safeErrorSummary(error);
      try {
        reports.delete(task.taskId);
        persistTasks();
        storage.setItem(BACKTEST_RECORD_KEY, JSON.stringify(
          createInvalidBacktestRecord(BACKTEST_STRATEGY_VERSION, now(), reason, { taskId: task.taskId }),
        ));
      } catch {
        // Keep the task failure authoritative even when the invalidation write fails.
      }
      update(task, { status: "failed", phase: "failed", errorSummary: reason });
    }
  }

  return {
    // crypto-ai-analysis.BACKTEST_JOBS.1 crypto-ai-analysis.BACKTEST_JOBS.4
    create(input = {}) {
      const parameters = validateRequest(input);
      const timestamp = now();
      const task = {
        taskId: randomUUID(),
        strategyVersion: BACKTEST_STRATEGY_VERSION,
        requestedAtMs: timestamp,
        updatedAtMs: timestamp,
        phase: "queued",
        progress: 0,
        status: "queued",
        errorSummary: null,
        reportGeneratedAtMs: null,
        parameters,
      };
      tasks.set(task.taskId, task);
      latestTaskId = task.taskId;
      persistTasks();
      schedulePump();
      return publicTask(task);
    },

    get(taskId) {
      const task = tasks.get(taskId);
      if (!task) throw new BacktestJobError("Backtest task not found", 404);
      return publicTask(task);
    },

    getReport(taskId) {
      const task = tasks.get(taskId);
      if (!task) throw new BacktestJobError("Backtest task not found", 404);
      if (task.status !== "completed") {
        throw new BacktestJobError("Backtest report is not available for this task", 409);
      }
      const persistedReport = reports.get(taskId);
      const record = readBacktestRecord(storage);
      const report = persistedReport?.report ?? (record?.taskId === taskId ? record.report : null);
      if (!report) {
        throw new BacktestJobError("Backtest report is unavailable or does not match this task", 409);
      }
      return {
        task: publicTask(task),
        reportGeneratedAtMs: persistedReport?.reportGeneratedAtMs ?? record.reportGeneratedAtMs,
        report: clone(report),
      };
    },

    list() {
      return [...tasks.values()].map(publicTask);
    },

    getLatestTask() {
      const task = latestTaskId ? tasks.get(latestTaskId) : null;
      return task ? publicTask(task) : null;
    },

    getLatestBacktestStatus() {
      const task = latestTaskId ? tasks.get(latestTaskId) : null;
      const record = readBacktestRecord(storage);
      if (!task) return record ? { ...record } : null;
      // crypto-ai-analysis.BACKTEST_JOBS.5: a newer manual/UI report is the
      // shared source of truth until a newer async task publishes its result.
      if (record && record.taskId == null && record.strategyVersion === task.strategyVersion &&
        record.updatedAtMs > task.updatedAtMs) {
        return record;
      }
      if (task.status !== "completed") {
        return createInvalidBacktestRecord(task.strategyVersion, task.updatedAtMs,
          task.errorSummary || `Backtest task ${task.status}`, { taskId: task.taskId });
      }
      if (!record?.report || record.taskId !== task.taskId) {
        return createInvalidBacktestRecord(task.strategyVersion, task.updatedAtMs,
          "Backtest report is unavailable", { taskId: task.taskId });
      }
      return record;
    },

    waitForIdle() {
      if (!activeTaskId && ![...tasks.values()].some((task) => task.status === "queued")) return Promise.resolve();
      return new Promise((resolve) => {
        const check = () => {
          if (!activeTaskId && ![...tasks.values()].some((task) => task.status === "queued")) resolve();
          else setTimeout(check, 0);
        };
        check();
      });
    },
  };
}

export { SUPPORTED_INTERVALS, SUPPORTED_SYMBOLS, validateRequest as validateBacktestJobRequest };
