import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createForwardSimulationApi, listenForwardSimulationApi } from "./forward-simulation-api.mjs";

const servers = [];
const BACKTEST_STATUS_KEY = "opencharts.crypto.backtest-status.v1";

async function startApi(overrides = {}) {
  const calls = [];
  let runtime = { connection: "live", ready: true, storageStatus: "ok" };
  let attempt = { snapshotId: "snapshot-1", symbol: "BTCUSDT", strategyVersion: "trend-pullback-v1", status: "ready" };
  const stored = new Map([[BACKTEST_STATUS_KEY, JSON.stringify({
    status: "experimental", strategyVersion: "trend-pullback-v1", updatedAtMs: Date.now(),
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
    getRuntimeStatus: () => runtime,
    getAnalysisAttempt: (snapshotId) => attempt?.snapshotId === snapshotId ? attempt : null,
    runManualAnalysis: async (symbol) => ({ ...attempt, symbol }),
  });
  const address = await listenForwardSimulationApi(server, 0);
  servers.push(server);
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    address,
    calls,
    setRuntime(value) { runtime = value; },
    setBacktestStatus(status, strategyVersion = "trend-pullback-v1") {
      storage.setItem(BACKTEST_STATUS_KEY, JSON.stringify({ status, strategyVersion }));
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
        validityChecks: { closedCandlesOnly: true, nextBarExecution: true, deterministicEngine: true },
        portfolio: { outOfSample: { metrics: { tradeCount: 10, maxDrawdownPct: 5, netReturnPct: 2, profitFactor: 1.2 } } },
        symbols,
      },
      costAssumptions: { buyFeeRate: 0.002, sellFeeRate: 0.003, buySlippageRate: 0.001, sellSlippageRate: 0.0015 },
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.backtestStatus.status, "experimental");
  assert.equal(result.backtestStatus.costAssumptions.buyFeeRate, 0.002);
});
