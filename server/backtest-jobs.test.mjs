import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKTEST_JOBS_KEY, BACKTEST_STRATEGY_VERSION, BacktestJobError, createBacktestJobRunner } from "./backtest-jobs.mjs";
import { BACKTEST_RECORD_KEY } from "./backtest-persistence.mjs";

const COSTS = { buyFeeRate: 0.001, sellFeeRate: 0.001, buySlippageRate: 0.0005, sellSlippageRate: 0.0005 };
const REPORT = { strategyVersion: BACKTEST_STRATEGY_VERSION, generatedAtMs: 10, requestedPeriod: { startMs: 1, endMs: 2 }, costAssumptions: COSTS };

function storageWith(values = new Map()) {
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test("crypto-ai-analysis.BACKTEST_JOBS.1 crypto-ai-analysis.BACKTEST_JOBS.2 returns a queued task before async work completes", async () => {
  const values = new Map();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runner = createBacktestJobRunner({
    storage: storageWith(values),
    loadHistory: async () => gate,
    runBacktest: () => REPORT,
  });
  const task = runner.create({ costAssumptions: COSTS });
  assert.equal(task.status, "queued");
  assert.equal(typeof task.taskId, "string");
  assert.equal(JSON.parse(values.get(BACKTEST_JOBS_KEY)).tasks[0].strategyVersion, BACKTEST_STRATEGY_VERSION);
  release({ assets: [], requestedPeriod: { startMs: 1, endMs: 2 } });
  await runner.waitForIdle();
  assert.equal(runner.get(task.taskId).status, "completed");
});

test("crypto-ai-analysis.BACKTEST_JOBS.3 crypto-ai-analysis.BACKTEST_JOBS.4 rejects strategy overrides and invalid parameters", () => {
  const runner = createBacktestJobRunner({ storage: storageWith(), loadHistory: async () => ({}), runBacktest: () => REPORT });
  assert.throws(() => runner.create({ strategyVersion: "trend-pullback-v2" }), BacktestJobError);
  assert.throws(() => runner.create({ intervals: ["1m"] }), BacktestJobError);
  assert.throws(() => runner.create({ costAssumptions: { ...COSTS, buyFeeRate: 2 } }), BacktestJobError);
});

test("crypto-ai-analysis.BACKTEST_JOBS.5 crypto-ai-analysis.BACKTEST_JOBS.6 persists completed reports and recovers running jobs", async () => {
  const values = new Map([[BACKTEST_JOBS_KEY, JSON.stringify({ schemaVersion: 1, tasks: [{
    taskId: "crashed", strategyVersion: BACKTEST_STRATEGY_VERSION, requestedAtMs: 1, updatedAtMs: 2,
    phase: "running-backtest", progress: 90, status: "running", errorSummary: null,
  }] })]]);
  const runner = createBacktestJobRunner({
    storage: storageWith(values),
    loadHistory: async () => ({ assets: [], requestedPeriod: { startMs: 1, endMs: 2 } }),
    runBacktest: () => REPORT,
  });
  assert.equal(runner.get("crashed").status, "failed");
  const task = runner.create();
  await runner.waitForIdle();
  assert.equal(runner.get(task.taskId).status, "completed");
  assert.equal(runner.getReport(task.taskId).report.strategyVersion, BACKTEST_STRATEGY_VERSION);
  assert.throws(() => runner.getReport("crashed"), BacktestJobError);
});

test("crypto-ai-analysis.BACKTEST_JOBS.3 marks failure without producing a successful report", async () => {
  const values = new Map();
  const runner = createBacktestJobRunner({
    storage: storageWith(values),
    loadHistory: async () => { throw new Error("/Users/private/project/.env OPENAI_API_KEY=secret"); },
    runBacktest: () => REPORT,
  });
  const task = runner.create();
  await runner.waitForIdle();
  assert.equal(runner.get(task.taskId).status, "failed");
  assert.match(runner.get(task.taskId).errorSummary, /\[redacted/);
  assert.doesNotMatch(runner.get(task.taskId).errorSummary, /OPENAI_API_KEY|\/Users\/private/);
});

test("crypto-ai-analysis.BACKTEST_JOBS.3 crypto-ai-analysis.BACKTEST_JOBS.5 keeps completed task reports and blocks stale shared status", async () => {
  const values = new Map();
  let calls = 0;
  const runner = createBacktestJobRunner({
    storage: storageWith(values),
    loadHistory: async () => {
      calls += 1;
      if (calls === 2) throw new Error("latest task failed");
      return { assets: [], requestedPeriod: { startMs: 1, endMs: 2 } };
    },
    runBacktest: () => REPORT,
  });
  const first = runner.create();
  await runner.waitForIdle();
  const second = runner.create();
  await runner.waitForIdle();

  assert.equal(runner.get(first.taskId).status, "completed");
  assert.equal(runner.get(second.taskId).status, "failed");
  assert.equal(runner.getReport(first.taskId).report.strategyVersion, BACKTEST_STRATEGY_VERSION);
  assert.equal(runner.getLatestBacktestStatus().status, "invalid");
});

test("crypto-ai-analysis.BACKTEST_JOBS.5 keeps a newer manual report visible beside an older async task", async () => {
  const values = new Map();
  let clock = 0;
  const runner = createBacktestJobRunner({
    storage: storageWith(values),
    now: () => ++clock,
    loadHistory: async () => ({ assets: [], requestedPeriod: { startMs: 1, endMs: 2 } }),
    runBacktest: () => REPORT,
  });
  const task = runner.create();
  await runner.waitForIdle();

  values.set(BACKTEST_RECORD_KEY, JSON.stringify({
    status: "invalid",
    strategyVersion: BACKTEST_STRATEGY_VERSION,
    costAssumptions: COSTS,
    updatedAtMs: clock + 10,
    reportGeneratedAtMs: null,
    taskId: null,
    statusReason: "manual report validation failed",
    report: null,
  }));

  const status = runner.getLatestBacktestStatus();
  assert.equal(runner.get(task.taskId).status, "completed");
  assert.equal(status.status, "invalid");
  assert.equal(status.taskId, null);
  assert.equal(status.statusReason, "manual report validation failed");
});

test("crypto-ai-analysis.BACKTEST_JOBS.5 rejects a newer shared record from another strategy", async () => {
  const values = new Map();
  let clock = 0;
  const runner = createBacktestJobRunner({
    storage: storageWith(values),
    now: () => ++clock,
    loadHistory: async () => ({ assets: [], requestedPeriod: { startMs: 1, endMs: 2 } }),
    runBacktest: () => REPORT,
  });
  const task = runner.create();
  await runner.waitForIdle();

  values.set(BACKTEST_RECORD_KEY, JSON.stringify({
    status: "invalid",
    strategyVersion: "trend-pullback-v2",
    costAssumptions: COSTS,
    updatedAtMs: clock + 10,
    reportGeneratedAtMs: null,
    taskId: null,
    statusReason: "foreign strategy",
    report: null,
  }));

  const status = runner.getLatestBacktestStatus();
  assert.equal(status.status, "invalid");
  assert.equal(status.taskId, task.taskId);
  assert.match(status.statusReason, /unavailable/);
});
