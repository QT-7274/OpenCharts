import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const DEFAULT_AGENT_API_URL = `http://127.0.0.1:${process.env.OPENCHARTS_FORWARD_PORT || 4001}/api/agent/v1`;

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"];
const INTERVALS = ["1h", "4h", "1d"];

// crypto-ai-analysis.AGENT_MCP.2 crypto-ai-analysis.AGENT_MCP.4
export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "opencharts_market_snapshot",
    description: "Read closed Binance Spot candles and the current public quote for research. This tool never places orders.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["symbol"],
      properties: {
        symbol: { type: "string", enum: SYMBOLS, description: "Supported Binance Spot symbol." },
        intervals: { type: "array", items: { type: "string", enum: INTERVALS }, maxItems: 3 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
    },
  },
  {
    name: "opencharts_analyze_symbol",
    description: "Run the deterministic OpenCharts analysis pipeline for a supported Spot symbol. AI explanations are supplementary and this tool never places orders.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["symbol"],
      properties: {
        symbol: { type: "string", enum: SYMBOLS },
      },
    },
  },
  {
    name: "opencharts_analysis_history",
    description: "Read persisted deterministic analysis snapshots for research.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        symbol: { type: "string", enum: SYMBOLS },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
    },
  },
  {
    name: "opencharts_analysis_snapshot",
    description: "Read one persisted analysis snapshot by its server-issued ID.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["snapshotId"],
      properties: {
        snapshotId: { type: "string", minLength: 1, maxLength: 240 },
      },
    },
  },
  {
    name: "opencharts_backtest_report",
    description: "Read the latest persisted backtest report and its validity status. A report is for research only.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "opencharts_forward_simulation_state",
    description: "Read forward-simulation health, paper ledger state, cost comparison, and persisted backtest status. No live trading is available.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "opencharts_create_paper_order_draft",
    description: "Create a paper-order draft from a server-issued analysis snapshot. User confirmation remains separate; this tool cannot confirm drafts or submit real exchange orders.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["snapshotId"],
      properties: {
        snapshotId: { type: "string", minLength: 1, maxLength: 240 },
      },
    },
  },
]);

class AgentApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "AgentApiError";
    this.status = status;
  }
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_AGENT_API_URL).replace(/\/+$/, "");
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function queryString(values = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value == null || value === "") continue;
    query.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const result = query.toString();
  return result ? `?${result}` : "";
}

// crypto-ai-analysis.AGENT_MCP.3
export function createAgentApiClient({ baseUrl = DEFAULT_AGENT_API_URL, token = null, fetchFn = fetch } = {}) {
  const root = normalizeBaseUrl(baseUrl);

  async function request(path, { method = "GET", body } = {}) {
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetchFn(`${root}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      const message = typeof payload?.error === "string" ? payload.error : "Agent API request failed";
      throw new AgentApiError(message, response.status);
    }
    return payload;
  }

  return {
    getMarketSnapshot(input) {
      return request(`/market${queryString(input)}`);
    },
    analyzeSymbol(input) {
      return request("/analysis", { method: "POST", body: input });
    },
    getAnalysisHistory(input) {
      return request(`/analysis/history${queryString(input)}`);
    },
    getAnalysisSnapshot(input) {
      return request(`/analysis/${encodeURIComponent(input.snapshotId)}`);
    },
    getBacktestReport() {
      return request("/backtest-report");
    },
    getForwardSimulationState() {
      return request("/forward-simulation/state");
    },
    createPaperOrderDraft(input) {
      return request("/paper-order-drafts", { method: "POST", body: input });
    },
  };
}

function toolError(message) {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function textResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function negotiatedProtocolVersion(requested) {
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
    ? requested
    : MCP_PROTOCOL_VERSION;
}

// crypto-ai-analysis.AGENT_MCP.1 crypto-ai-analysis.AGENT_MCP.2
export function createAgentMcpServer({ apiClient = createAgentApiClient(), serverName = "opencharts-agent" } = {}) {
  const handlers = {
    opencharts_market_snapshot: (args) => apiClient.getMarketSnapshot(args),
    opencharts_analyze_symbol: (args) => apiClient.analyzeSymbol(args),
    opencharts_analysis_history: (args) => apiClient.getAnalysisHistory(args),
    opencharts_analysis_snapshot: (args) => apiClient.getAnalysisSnapshot(args),
    opencharts_backtest_report: () => apiClient.getBacktestReport(),
    opencharts_forward_simulation_state: () => apiClient.getForwardSimulationState(),
    opencharts_create_paper_order_draft: (args) => apiClient.createPaperOrderDraft(args),
  };

  async function callTool(name, argumentsInput) {
    const handler = handlers[name];
    if (!handler) return toolError(`Unknown tool: ${name}`);
    try {
      return textResult(await handler(asObject(argumentsInput)));
    } catch (error) {
      if (error instanceof AgentApiError) return toolError(`Agent API error (${error.status}): ${error.message}`);
      return toolError("Agent API request failed");
    }
  }

  async function handleMessage(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
    }
    if (message.method === "notifications/initialized" || message.method.startsWith("notifications/")) return null;
    if (message.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: negotiatedProtocolVersion(message.params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: serverName, version: "0.1.0" },
          instructions: "OpenCharts exposes public Spot research and paper-order drafts only. Draft confirmation and real exchange orders are unavailable.",
        },
      };
    }
    if (message.method === "ping") return { jsonrpc: "2.0", id: message.id, result: {} };
    if (message.method === "tools/list") {
      return { jsonrpc: "2.0", id: message.id, result: { tools: TOOL_DEFINITIONS } };
    }
    if (message.method === "tools/call") {
      const params = asObject(message.params);
      return { jsonrpc: "2.0", id: message.id, result: await callTool(params.name, params.arguments) };
    }
    return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
  }

  return { handleMessage, callTool };
}

export async function serveStdio({ input = process.stdin, output = process.stdout, ...options } = {}) {
  const server = createAgentMcpServer(options);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
      continue;
    }
    const response = await server.handleMessage(message);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href) {
  await serveStdio({
    baseUrl: process.env.OPENCHARTS_AGENT_API_URL || DEFAULT_AGENT_API_URL,
    token: process.env.OPENCHARTS_AGENT_TOKEN || null,
  });
}
