import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MCP_PROTOCOL_VERSION,
  TOOL_DEFINITIONS,
  createAgentApiClient,
  createAgentMcpServer,
} from "./agent-mcp.mjs";

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("crypto-ai-analysis.AGENT_MCP.1 crypto-ai-analysis.AGENT_MCP.2 exposes stable research tools over JSON-RPC", async () => {
  const server = createAgentMcpServer({
    apiClient: {
      getMarketSnapshot: async () => ({ symbol: "BTCUSDT" }),
      analyzeSymbol: async () => ({ snapshot: { snapshotId: "snapshot-1" } }),
      getAnalysisHistory: async () => ({ records: [] }),
      getAnalysisSnapshot: async () => ({ snapshot: { snapshotId: "snapshot-1" } }),
      getBacktestReport: async () => ({ reportGeneratedAtMs: 1 }),
      getForwardSimulationState: async () => ({ runtime: { ready: false } }),
      createPaperOrderDraft: async () => ({ confirmationRequired: true, realOrderCapability: false }),
    },
  });

  const initialized = await server.handleMessage({
    jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION },
  });
  assert.equal(initialized.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(initialized.result.capabilities.tools.listChanged, false);

  const listed = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
    "opencharts_market_snapshot",
    "opencharts_analyze_symbol",
    "opencharts_analysis_history",
    "opencharts_analysis_snapshot",
    "opencharts_backtest_report",
    "opencharts_forward_simulation_state",
    "opencharts_create_paper_order_draft",
  ]);

  const draftTool = listed.result.tools.at(-1);
  assert.match(draftTool.description, /cannot confirm drafts|real exchange orders/i);
  const called = await server.handleMessage({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "opencharts_create_paper_order_draft", arguments: { snapshotId: "snapshot-1" } },
  });
  assert.equal(called.result.structuredContent.confirmationRequired, true);
  assert.equal(called.result.structuredContent.realOrderCapability, false);
  assert.equal(await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("crypto-ai-analysis.AGENT_MCP.3 routes every research operation through the shared Agent REST API", async () => {
  const requests = [];
  const client = createAgentApiClient({
    baseUrl: "http://127.0.0.1:4001/api/agent/v1",
    token: "secret-token",
    fetchFn: async (url, init) => {
      requests.push({ url, init });
      return response({ ok: true });
    },
  });
  await client.getMarketSnapshot({ symbol: "BTCUSDT", intervals: ["1h", "4h"], limit: 20 });
  await client.analyzeSymbol({ symbol: "BTCUSDT" });
  await client.getAnalysisHistory({ symbol: "ETHUSDT", limit: 3 });
  await client.getAnalysisSnapshot({ snapshotId: "snapshot/1" });
  await client.getBacktestReport();
  await client.getForwardSimulationState();
  await client.createPaperOrderDraft({ snapshotId: "snapshot-1" });

  assert.deepEqual(requests.map((request) => request.url), [
    "http://127.0.0.1:4001/api/agent/v1/market?symbol=BTCUSDT&intervals=1h%2C4h&limit=20",
    "http://127.0.0.1:4001/api/agent/v1/analysis",
    "http://127.0.0.1:4001/api/agent/v1/analysis/history?symbol=ETHUSDT&limit=3",
    "http://127.0.0.1:4001/api/agent/v1/analysis/snapshot%2F1",
    "http://127.0.0.1:4001/api/agent/v1/backtest-report",
    "http://127.0.0.1:4001/api/agent/v1/forward-simulation/state",
    "http://127.0.0.1:4001/api/agent/v1/paper-order-drafts",
  ]);
  assert.equal(requests.every((request) => request.init.headers.authorization === "Bearer secret-token"), true);
});

test("crypto-ai-analysis.AGENT_MCP.4 converts API failures to safe tool errors", async () => {
  const server = createAgentMcpServer({
    apiClient: {
      getMarketSnapshot: async () => { throw new Error("secret token must not be returned"); },
    },
  });
  const result = await server.handleMessage({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "opencharts_market_snapshot", arguments: { symbol: "BTCUSDT" } },
  });
  assert.equal(result.result.isError, true);
  assert.equal(result.result.content[0].text, "Agent API request failed");
});

test("crypto-ai-analysis.AGENT_MCP.4 rejects unknown tools without accessing the API", async () => {
  let called = false;
  const server = createAgentMcpServer({ apiClient: { getMarketSnapshot: async () => { called = true; } } });
  const result = await server.handleMessage({
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "real_order_submission", arguments: {} },
  });
  assert.equal(result.result.isError, true);
  assert.equal(called, false);
  assert.equal(TOOL_DEFINITIONS.some((tool) => tool.name.includes("real_order")), false);
});
