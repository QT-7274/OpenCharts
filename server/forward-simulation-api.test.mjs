import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { BACKTEST_RECORD_KEY } from "./backtest-persistence.mjs";
import { BacktestJobError } from "./backtest-jobs.mjs";
import { createForwardSimulationApi, listenForwardSimulationApi } from "./forward-simulation-api.mjs";

const servers = [];
const COST_ASSUMPTIONS = { buyFeeRate: 0.001, sellFeeRate: 0.001, buySlippageRate: 0.0005, sellSlippageRate: 0.0005 };
const PERIOD = { startMs: 1, endMs: 2 };
const RESULT = {
  period: PERIOD,
  metrics: { tradeCount: 10, maxDrawdownPct: 5, netReturnPct: 2, profitFactor: 1.2 },
  trades: [],
  buyAndHold: {},
};
const BACKTEST_REPORT = {
  strategyVersion: "trend-pullback-v1",
  generatedAtMs: 1,
  costAssumptions: COST_ASSUMPTIONS,
  requestedPeriod: PERIOD,
  validityChecks: { closedCandlesOnly: true, nextBarExecution: true, deterministicEngine: true },
  portfolio: { research: RESULT, outOfSample: RESULT },
  symbols: Object.fromEntries(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"]
    .map((symbol) => [symbol, { research: RESULT, outOfSample: RESULT }])),
  robustness: { walkForward: [], marketRegimes: [], parameterSensitivity: [] },
};

function createBacktestJobsStub() {
  const completedTask = {
    taskId: "task-1",
    strategyVersion: "trend-pullback-v1",
    requestedAtMs: 1,
    updatedAtMs: 2,
    phase: "completed",
    progress: 100,
    status: "completed",
    errorSummary: null,
    reportGeneratedAtMs: 3,
    parameters: { initialCapital: 10_000 },
  };
  const runningTask = { ...completedTask, taskId: "task-running", phase: "running-backtest", progress: 90, status: "running" };
  const created = [];
  return {
    created,
    create(input) {
      created.push(input);
      return { ...completedTask, taskId: "task-created", requestedAtMs: 4, updatedAtMs: 4 };
    },
    get(taskId) {
      if (taskId === completedTask.taskId) return completedTask;
      if (taskId === runningTask.taskId) return runningTask;
      if (taskId === "task-created") return { ...completedTask, taskId };
      throw new BacktestJobError("Backtest task not found", 404);
    },
    getReport(taskId) {
      if (taskId === runningTask.taskId) {
        throw new BacktestJobError("Backtest report is not available for this task", 409);
      }
      if (taskId !== completedTask.taskId && taskId !== "task-created") {
        throw new BacktestJobError("Backtest task not found", 404);
      }
      return { task: this.get(taskId), reportGeneratedAtMs: 3, report: BACKTEST_REPORT };
    },
  };
}

async function startApi(overrides = {}) {
  const calls = [];
  let runtime = { connection: "live", ready: true, storageStatus: "ok" };
  let attempt = { snapshotId: "snapshot-1", symbol: "BTCUSDT", strategyVersion: "trend-pullback-v1", status: "ready" };
  const stored = new Map([[BACKTEST_RECORD_KEY, JSON.stringify({
    status: "experimental", strategyVersion: "trend-pullback-v1", costAssumptions: COST_ASSUMPTIONS,
    updatedAtMs: Date.now(), reportGeneratedAtMs: 1, statusReason: "样本不足", report: BACKTEST_REPORT,
  })]]);
  const storage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };
  const ledger = {
    getState: () => ({ orders: [], events: [] }),
    getRiskContext: () => ({ accountEquity: 10_000, availableQuoteBalance: 10_000 }),
    getRuntimeError: () => null,
    getCostComparison: () => ({ simulatedFees: 0, expectedFees: 0, feeDifference: 0,
      simulatedSlippage: 0, expectedSlippage: 0, slippageDifference: 0 }),
    createDraft: (attempt, backtestStatus) => {
      calls.push(["draft", attempt, backtestStatus]);
      return {
        symbol: attempt.symbol,
        snapshotId: attempt.snapshotId,
        strategyVersion: attempt.strategyVersion,
        backtestStatus,
        expiresAtMs: Date.now() + 60_000,
      };
    },
    submitDraft: (draft) => {
      calls.push(["submit", draft]);
      return { id: "paper-1", status: "pending" };
    },
    cancelOrder: (id) => calls.push(["cancel", id]),
    ...overrides.ledger,
  };
  const server = createForwardSimulationApi({
    ledger,
    storage,
    backtestJobs: overrides.backtestJobs,
    getRuntimeStatus: () => runtime,
    getAnalysisAttempt: (snapshotId) => attempt?.snapshotId === snapshotId ? attempt : null,
    runManualAnalysis: async (symbol) => ({ ...attempt, symbol }),
  });
  const address = await listenForwardSimulationApi(server, 0);
  servers.push(server);
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    address,
    server,
    calls,
    setRuntime(value) { runtime = value; },
    setBacktestStatus(status, strategyVersion = "trend-pullback-v1") {
      storage.setItem(BACKTEST_RECORD_KEY, JSON.stringify(status === "invalid"
        ? { status, strategyVersion, updatedAtMs: Date.now(), report: null }
        : { status, strategyVersion, costAssumptions: COST_ASSUMPTIONS, updatedAtMs: Date.now(), reportGeneratedAtMs: 1, report: BACKTEST_REPORT }));
    },
    setAttempt(value) { attempt = value; },
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

test("crypto-ai-analysis.RELIABILITY.4 binds the forward-simulation API to loopback", async () => {
  const api = await startApi();
  assert.equal(api.address.address, "127.0.0.1");
  const response = await fetch(`${api.baseUrl}/api/forward-sim/state`);
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.runtime.connection, "live");
  assert.equal(state.runtime.ready, true);
  assert.equal(state.costComparison.feeDifference, 0);
  assert.equal(state.riskContext.accountEquity, 10_000);
});

test("crypto-ai-analysis.LONG_RUNNING.3 rejects new requests after shutdown begins", async () => {
  const api = await startApi();
  api.server.beginShutdown();
  const response = await fetch(`${api.baseUrl}/api/forward-sim/state`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Forward simulation is shutting down" });
});

test("crypto-ai-analysis.BACKTEST_JOBS.1 crypto-ai-analysis.BACKTEST_JOBS.2 crypto-ai-analysis.BACKTEST_JOBS.5 exposes async task creation, status and report routes", async () => {
  const backtestJobs = createBacktestJobsStub();
  const api = await startApi({ backtestJobs });
  const createResponse = await fetch(`${api.baseUrl}/api/forward-sim/backtest-jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initialCapital: 10_000 }),
  });
  assert.equal(createResponse.status, 202);
  assert.deepEqual(backtestJobs.created, [{ initialCapital: 10_000 }]);
  const created = await createResponse.json();
  assert.equal(created.task.taskId, "task-created");

  const statusResponse = await fetch(`${api.baseUrl}/api/forward-sim/backtest-jobs/task-1`);
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).task.status, "completed");

  const reportResponse = await fetch(`${api.baseUrl}/api/forward-sim/backtest-jobs/task-1/report`);
  assert.equal(reportResponse.status, 200);
  const report = await reportResponse.json();
  assert.equal(report.task.taskId, "task-1");
  assert.equal(report.report.strategyVersion, "trend-pullback-v1");
});

test("crypto-ai-analysis.BACKTEST_JOBS.3 crypto-ai-analysis.BACKTEST_JOBS.6 maps task lookup and unavailable report errors", async () => {
  const api = await startApi({ backtestJobs: createBacktestJobsStub() });
  const missingTask = await fetch(`${api.baseUrl}/api/forward-sim/backtest-jobs/missing`);
  assert.equal(missingTask.status, 404);
  assert.deepEqual(await missingTask.json(), { error: "Backtest task not found" });

  const runningReport = await fetch(`${api.baseUrl}/api/forward-sim/backtest-jobs/task-running/report`);
  assert.equal(runningReport.status, 409);
  assert.deepEqual(await runningReport.json(), { error: "Backtest report is not available for this task" });
});

test("crypto-ai-analysis.FORWARD_SIMULATION.8 requires a prepared draft before confirmation", async () => {
  const api = await startApi();
  const draftResponse = await fetch(`${api.baseUrl}/api/forward-sim/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotId: "snapshot-1" }),
  });
  assert.equal(draftResponse.status, 201);
  const prepared = await draftResponse.json();
  assert.equal(api.calls[0][0], "draft");

  const confirmation = await fetch(`${api.baseUrl}/api/forward-sim/drafts/${prepared.id}/confirm`, { method: "POST" });
  assert.equal(confirmation.status, 201);
  assert.equal(api.calls[1][0], "submit");

  const replay = await fetch(`${api.baseUrl}/api/forward-sim/drafts/${prepared.id}/confirm`, { method: "POST" });
  assert.equal(replay.status, 404);
  assert.equal(api.calls.filter(([kind]) => kind === "submit").length, 1);
});

test("crypto-ai-analysis.FORWARD_SIMULATION.10-1 resolves analysis and backtest state on the server", async () => {
  const api = await startApi();
  const analysis = await fetch(`${api.baseUrl}/api/forward-sim/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ symbol: "BTCUSDT" }),
  });
  assert.equal(analysis.status, 200);
  assert.deepEqual(await analysis.json(), { snapshotId: "snapshot-1" });

  const response = await fetch(`${api.baseUrl}/api/forward-sim/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotId: "unknown-snapshot", attempt: {}, backtestStatus: "experimental" }),
  });
  assert.equal(response.status, 409);
  assert.equal(api.calls.length, 0);
});

test("crypto-ai-analysis.FORWARD_SIMULATION.10-1 refuses drafts when the persisted backtest status is invalid", async () => {
  const api = await startApi();
  api.setBacktestStatus("invalid");
  const response = await fetch(`${api.baseUrl}/api/forward-sim/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotId: "snapshot-1" }),
  });
  assert.equal(response.status, 409);
  assert.equal(api.calls.length, 0);
});

test("crypto-ai-analysis.FORWARD_SIMULATION.10-1 requires a backtest for the snapshot strategy", async () => {
  const api = await startApi();
  api.setBacktestStatus("experimental", "trend-pullback-v2");
  const response = await fetch(`${api.baseUrl}/api/forward-sim/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotId: "snapshot-1" }),
  });
  assert.equal(response.status, 409);
  assert.equal(api.calls.length, 0);
});

test("crypto-ai-analysis.FORWARD_SIMULATION.10 rejects order drafts unless runtime recovery and market data are ready", async () => {
  const api = await startApi();
  api.setRuntime({ connection: "live", ready: false, storageStatus: "ok", recovering: true });
  const response = await fetch(`${api.baseUrl}/api/forward-sim/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotId: "snapshot-1" }),
  });
  assert.equal(response.status, 409);
  assert.equal(api.calls.length, 0);
});

test("crypto-ai-analysis.FORWARD_SIMULATION.10 rechecks runtime readiness at confirmation", async () => {
  const api = await startApi();
  const draftResponse = await fetch(`${api.baseUrl}/api/forward-sim/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotId: "snapshot-1" }),
  });
  const prepared = await draftResponse.json();
  api.setRuntime({ connection: "connecting", ready: false, storageStatus: "ok" });
  const confirmation = await fetch(`${api.baseUrl}/api/forward-sim/drafts/${prepared.id}/confirm`, { method: "POST" });
  assert.equal(confirmation.status, 409);
  assert.equal(api.calls.some(([kind]) => kind === "submit"), false);
});

test("crypto-ai-analysis.FORWARD_SIMULATION.10-1 rechecks the persisted status and current snapshot on confirmation", async () => {
  const api = await startApi();
  const draftResponse = await fetch(`${api.baseUrl}/api/forward-sim/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotId: "snapshot-1" }),
  });
  const prepared = await draftResponse.json();
  api.setBacktestStatus("invalid");
  const confirmation = await fetch(`${api.baseUrl}/api/forward-sim/drafts/${prepared.id}/confirm`, { method: "POST" });
  assert.equal(confirmation.status, 409);
  assert.equal(api.calls.some(([kind]) => kind === "submit"), false);
});

test("crypto-ai-analysis.FORWARD_SIMULATION.10-1 rechecks strategy version at confirmation", async () => {
  const api = await startApi();
  const draftResponse = await fetch(`${api.baseUrl}/api/forward-sim/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotId: "snapshot-1" }),
  });
  const prepared = await draftResponse.json();
  api.setBacktestStatus("experimental", "trend-pullback-v2");
  const confirmation = await fetch(`${api.baseUrl}/api/forward-sim/drafts/${prepared.id}/confirm`, { method: "POST" });
  assert.equal(confirmation.status, 409);
  assert.equal(api.calls.some(([kind]) => kind === "submit"), false);
});

test("crypto-ai-analysis.FORWARD_SIMULATION.10-1 rejects a stale snapshot at confirmation", async () => {
  const api = await startApi();
  const draftResponse = await fetch(`${api.baseUrl}/api/forward-sim/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotId: "snapshot-1" }),
  });
  const prepared = await draftResponse.json();
  api.setAttempt({ snapshotId: "snapshot-2", symbol: "BTCUSDT", strategyVersion: "trend-pullback-v1" });
  const confirmation = await fetch(`${api.baseUrl}/api/forward-sim/drafts/${prepared.id}/confirm`, { method: "POST" });
  assert.equal(confirmation.status, 409);
  assert.equal(api.calls.some(([kind]) => kind === "submit"), false);
});

test("crypto-ai-analysis.FORWARD_SIMULATION.10-1 derives status from the report instead of the client claim", async () => {
  const api = await startApi();
  const symbols = Object.fromEntries(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"]
    .map((symbol) => [symbol, { outOfSample: { metrics: { tradeCount: 10, maxDrawdownPct: 5, netReturnPct: 2, profitFactor: 1.2 } } }]));
  const response = await fetch(`${api.baseUrl}/api/forward-sim/backtest-status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      status: "research-usable",
      report: {
        strategyVersion: "trend-pullback-v1",
        costAssumptions: { buyFeeRate: 0.002, sellFeeRate: 0.003, buySlippageRate: 0.001, sellSlippageRate: 0.0015 },
        generatedAtMs: Date.now(),
        requestedPeriod: { startMs: 1, endMs: 2 },
        validityChecks: { closedCandlesOnly: true, nextBarExecution: true, deterministicEngine: true },
        portfolio: {
          research: { period: { startMs: 1, endMs: 2 }, metrics: { tradeCount: 0, maxDrawdownPct: 0, netReturnPct: 0, profitFactor: null }, trades: [], buyAndHold: {} },
          outOfSample: { period: { startMs: 1, endMs: 2 }, metrics: { tradeCount: 10, maxDrawdownPct: 5, netReturnPct: 2, profitFactor: 1.2 }, trades: [], buyAndHold: {} },
        },
        symbols: Object.fromEntries(Object.entries(symbols).map(([symbol, value]) => [symbol, {
          research: { period: { startMs: 1, endMs: 2 }, metrics: { tradeCount: 0, maxDrawdownPct: 0, netReturnPct: 0, profitFactor: null }, trades: [], buyAndHold: {} },
          outOfSample: { ...value.outOfSample, period: { startMs: 1, endMs: 2 }, trades: [], buyAndHold: {} },
        }])),
        robustness: { walkForward: [], marketRegimes: [], parameterSensitivity: [] },
      },
      costAssumptions: { buyFeeRate: 0.002, sellFeeRate: 0.003, buySlippageRate: 0.001, sellSlippageRate: 0.0015 },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.backtestStatus.status, "experimental");
  assert.equal(result.backtestStatus.costAssumptions.buyFeeRate, 0.002);
});

test("crypto-ai-analysis.VALIDATION.18 persists and serves the complete backtest report", async () => {
  const api = await startApi();
  const period = { startMs: 1, endMs: 2 };
  const result = { period, metrics: { tradeCount: 10, maxDrawdownPct: 5, netReturnPct: 2, profitFactor: 1.2 }, trades: [], buyAndHold: {} };
  const report = {
    strategyVersion: "trend-pullback-v1", generatedAtMs: 123,
    costAssumptions: { buyFeeRate: 0.002, sellFeeRate: 0.003, buySlippageRate: 0.001, sellSlippageRate: 0.0015 },
    requestedPeriod: period,
    validityChecks: { closedCandlesOnly: true, nextBarExecution: true, deterministicEngine: true },
    portfolio: { research: result, outOfSample: result },
    symbols: Object.fromEntries(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"]
      .map((symbol) => [symbol, { research: result, outOfSample: result }])),
    robustness: { walkForward: [], marketRegimes: [], parameterSensitivity: [] },
  };
  const response = await fetch(`${api.baseUrl}/api/forward-sim/backtest-status`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ report, costAssumptions: report.costAssumptions }),
  });
  assert.equal(response.status, 200);
  const stored = await fetch(`${api.baseUrl}/api/forward-sim/backtest-report`);
  assert.equal(stored.status, 200);
  const payload = await stored.json();
  assert.deepEqual(payload.report, report);
  assert.equal(payload.backtestStatus.reportGeneratedAtMs, 123);
  assert.equal(payload.backtestStatus.status, "experimental");
});
