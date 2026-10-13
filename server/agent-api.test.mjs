import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AgentDomainError, createAgentDomain } from "./agent-domain.mjs";
import { createForwardSimulationApi, listenForwardSimulationApi } from "./forward-simulation-api.mjs";

const servers = [];

function createAgentStub(calls) {
  return {
    getCapabilities() {
      calls.push(["capabilities"]);
      return { source: "opencharts-agent-api", capabilities: { realOrderSubmission: false } };
    },
    async getMarketSnapshot(input) {
      calls.push(["market", input]);
      return { source: "binance-spot-public", symbol: input.symbol, candles: {} };
    },
    async analyzeSymbol(input) {
      calls.push(["analysis", input]);
      return { source: "analysisPipeline", snapshot: { snapshotId: "snapshot-1", strategyVersion: "trend-pullback-v1" } };
    },
    getAnalysisHistory(input) {
      calls.push(["history", input]);
      return { source: "analysisPipeline", records: [] };
    },
    getAnalysisSnapshot(input) {
      calls.push(["snapshot", input]);
      return { source: "analysisPipeline", snapshot: { snapshotId: input.snapshotId } };
    },
    getBacktestReport() {
      calls.push(["backtest"]);
      return { source: "backtest-persistence", reportGeneratedAtMs: 123 };
    },
    getForwardSimulationState() {
      calls.push(["state"]);
      return { source: "forward-simulation", runtime: {} };
    },
    createPaperOrderDraft(input) {
      calls.push(["draft", input]);
      return { source: "paper-ledger", confirmationRequired: true, realOrderCapability: false };
    },
  };
}

async function startApi({ agentToken = null, agentDomain = null } = {}) {
  const calls = [];
  const server = createForwardSimulationApi({
    ledger: {},
    storage: {},
    getRuntimeStatus: () => ({ ready: true }),
    agentDomain: agentDomain ?? createAgentStub(calls),
    agentToken,
  });
  const address = await listenForwardSimulationApi(server, 0);
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${address.port}`, calls };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

test("crypto-ai-analysis.AGENT_ACCESS.2 crypto-ai-analysis.AGENT_ACCESS.3 crypto-ai-analysis.AGENT_ACCESS.4 crypto-ai-analysis.AGENT_ACCESS.5 crypto-ai-analysis.AGENT_ACCESS.6 routes agent research operations through the shared domain", async () => {
  const api = await startApi();
  const headers = { "content-type": "application/json" };

  assert.equal((await fetch(`${api.baseUrl}/api/agent/v1/capabilities`)).status, 200);
  assert.equal((await fetch(`${api.baseUrl}/api/agent/v1/market?symbol=BTCUSDT&intervals=1h,4h&limit=20`)).status, 200);
  assert.equal((await fetch(`${api.baseUrl}/api/agent/v1/analysis`, {
    method: "POST", headers, body: JSON.stringify({ symbol: "BTCUSDT" }),
  })).status, 200);
  assert.equal((await fetch(`${api.baseUrl}/api/agent/v1/analysis/history?symbol=ETHUSDT&limit=3`)).status, 200);
  assert.equal((await fetch(`${api.baseUrl}/api/agent/v1/analysis/snapshot-1`)).status, 200);
  assert.equal((await fetch(`${api.baseUrl}/api/agent/v1/backtest-report`)).status, 200);
  assert.equal((await fetch(`${api.baseUrl}/api/agent/v1/forward-simulation/state`)).status, 200);
  assert.equal((await fetch(`${api.baseUrl}/api/agent/v1/paper-order-drafts`, {
    method: "POST", headers, body: JSON.stringify({ snapshotId: "snapshot-1" }),
  })).status, 201);

  assert.deepEqual(api.calls.map(([kind]) => kind), [
    "capabilities", "market", "analysis", "history", "snapshot", "backtest", "state", "draft",
  ]);
  assert.deepEqual(api.calls[1][1], { symbol: "BTCUSDT", intervals: ["1h", "4h"], limit: "20" });
  assert.deepEqual(api.calls[7][1], { snapshotId: "snapshot-1" });
});

test("crypto-ai-analysis.AGENT_ACCESS.5 exposes draft creation without confirmation or real-order routes", async () => {
  const api = await startApi();
  const response = await fetch(`${api.baseUrl}/api/agent/v1/paper-order-drafts/anything/confirm`, { method: "POST" });
  assert.equal(response.status, 404);
  assert.equal(api.calls.length, 0);
});

test("crypto-ai-analysis.AGENT_ACCESS.8 enforces the configured bearer token", async () => {
  const api = await startApi({ agentToken: "agent-secret" });
  const missing = await fetch(`${api.baseUrl}/api/agent/v1/capabilities`);
  assert.equal(missing.status, 401);
  const wrong = await fetch(`${api.baseUrl}/api/agent/v1/capabilities`, {
    headers: { authorization: "Bearer wrong" },
  });
  assert.equal(wrong.status, 401);
  const valid = await fetch(`${api.baseUrl}/api/agent/v1/capabilities`, {
    headers: { authorization: "Bearer agent-secret" },
  });
  assert.equal(valid.status, 200);
});

test("crypto-ai-analysis.AGENT_ACCESS.7 hides unexpected errors from agent responses", async () => {
  const api = await startApi({
    agentDomain: {
      getCapabilities() {
        throw new Error("/Users/private/project/.env OPENAI_API_KEY=secret");
      },
    },
  });
  const response = await fetch(`${api.baseUrl}/api/agent/v1/capabilities`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Agent request failed" });
});

test("crypto-ai-analysis.AGENT_ACCESS.2 returns domain validation errors as structured client errors", async () => {
  const api = await startApi({
    agentDomain: {
      getMarketSnapshot() {
        throw new AgentDomainError("Unsupported spot symbol", 400);
      },
    },
  });
  const response = await fetch(`${api.baseUrl}/api/agent/v1/market?symbol=NOPE`);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Unsupported spot symbol" });
});

const attempt = {
  symbol: "BTCUSDT",
  trigger: "manual",
  analysisTimeMs: 1_000,
  status: "ready",
  decision: "暂不入场",
  reason: null,
  candleCloseTimes: { "1d": 1, "4h": 1, "1h": 1 },
  issues: [],
  strategyVersion: "trend-pullback-v1",
  indicators: { "1d": { ema200: 1 }, "4h": {}, "1h": {} },
  trend: { state: "setup" },
  strategy: { state: "setup" },
  currentPrice: 100,
  currentPriceObservedAtMs: 1_000,
  supportResistance: { support: 90, resistance: 110 },
  currentPriceServerTimeMs: 1_000,
  entryPlan: null,
  entryPlanFailure: null,
  snapshotId: "snapshot-1",
  aiInputSummary: null,
  aiExplanation: null,
  windows: [{ secret: "should-not-leak" }],
  signal: { secret: "should-not-leak" },
};

test("crypto-ai-analysis.AGENT_ACCESS.2 crypto-ai-analysis.AGENT_ACCESS.3 crypto-ai-analysis.AGENT_ACCESS.4 crypto-ai-analysis.AGENT_ACCESS.6 crypto-ai-analysis.AGENT_ACCESS.7 domain returns closed candles and traceable safe snapshots", async () => {
  const storage = new Map();
  const restAdapter = {
    getServerTime: async () => 2_000,
    getSpotQuote: async () => ({ price: 100, tradeTimeMs: 1_900, serverTimeMs: 2_000 }),
    getCandles: async ({ interval }) => [
      { interval, openTimeMs: 1, closeTimeMs: 2, isClosed: false },
      { interval, openTimeMs: 2, closeTimeMs: 3, isClosed: true },
    ],
  };
  const analysisPipeline = {
    runManual: async () => attempt,
    getHistory: () => [attempt],
    getRecords: () => [attempt],
  };
  const ledger = {
    getState: () => ({
      orders: [],
      events: [{ id: "event-1", reason: "/Users/private/.env OPENAI_API_KEY=secret" }],
      pausedSymbols: { BTCUSDT: "/private/runtime.log" },
    }),
    getRiskContext: () => ({ accountEquity: 10_000 }),
    getCostComparison: () => ({ feeDifference: 0 }),
    getRuntimeError: () => "secret storage error",
  };
  const domain = createAgentDomain({
    restAdapter,
    analysisPipeline,
    ledger,
    backtestStorage: { getItem: (key) => storage.get(key) ?? null },
    getRuntimeStatus: () => ({ runtimeFailure: "/private/secret", ready: true }),
    now: () => 3_000,
  });

  const market = await domain.getMarketSnapshot({ symbol: "BTCUSDT", intervals: ["1h"], limit: 2 });
  assert.equal(market.candles["1h"].length, 1);
  assert.equal(market.candles["1h"][0].isClosed, true);
  const analysis = await domain.analyzeSymbol({ symbol: "BTCUSDT" });
  assert.equal(analysis.snapshot.snapshotId, "snapshot-1");
  assert.equal(analysis.snapshot.analysisTimeMs, 1_000);
  assert.equal(analysis.snapshot.strategyVersion, "trend-pullback-v1");
  assert.equal("windows" in analysis.snapshot, false);
  assert.equal("signal" in analysis.snapshot, false);
  const state = domain.getForwardSimulationState();
  assert.equal(state.runtime.runtimeFailure, "runtime-failure");
  assert.equal(state.storageError, "storage-error");
  assert.doesNotMatch(state.ledger.events[0].reason, /OPENAI_API_KEY|\/Users\/private/);
  assert.doesNotMatch(state.ledger.pausedSymbols.BTCUSDT, /\/private\/runtime/);
});

test("crypto-ai-analysis.AGENT_ACCESS.2 rejects unsupported symbols, intervals and limits", async () => {
  const domain = createAgentDomain({
    restAdapter: { getServerTime: async () => 1, getSpotQuote: async () => ({}), getCandles: async () => [] },
    analysisPipeline: { runManual: async () => attempt, getHistory: () => [], getRecords: () => [] },
    ledger: { getState: () => ({}), getRiskContext: () => ({}), getCostComparison: () => ({}), getRuntimeError: () => null },
    backtestStorage: { getItem: () => null },
  });
  await assert.rejects(domain.getMarketSnapshot({ symbol: "NOPE" }), { statusCode: 400 });
  await assert.rejects(domain.getMarketSnapshot({ symbol: "BTCUSDT", intervals: ["5m"] }), { statusCode: 400 });
  await assert.rejects(domain.getMarketSnapshot({ symbol: "BTCUSDT", limit: 501 }), { statusCode: 400 });
  assert.throws(() => domain.getAnalysisHistory({ limit: 0 }), { statusCode: 400 });
});

test("crypto-ai-analysis.AGENT_ACCESS.5 crypto-ai-analysis.FORWARD_SIMULATION.10-1 ignores volatile snapshots", () => {
  const domain = createAgentDomain({
    restAdapter: { getServerTime: async () => 1, getSpotQuote: async () => ({}), getCandles: async () => [] },
    analysisPipeline: { getHistory: () => [attempt], getRecords: () => [] },
    ledger: { getState: () => ({}), getRiskContext: () => ({}), getCostComparison: () => ({}), getRuntimeError: () => null },
    backtestStorage: { getItem: () => null },
  });

  assert.throws(() => domain.getAnalysisSnapshot({ snapshotId: "snapshot-1" }), { statusCode: 404 });
  assert.throws(() => domain.createPaperOrderDraft({ snapshotId: "snapshot-1" }), { statusCode: 404 });
});
