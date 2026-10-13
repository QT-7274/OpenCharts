import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  BACKTEST_RECORD_KEY,
  backtestStatusSummary,
  createInvalidBacktestRecord,
  persistBacktestRecord,
  readBacktestRecord,
  validCostAssumptions,
} from "./backtest-persistence.mjs";
import { BacktestJobError } from "./backtest-jobs.mjs";
import { AgentDomainError } from "./agent-domain.mjs";

const PREFIX = "/api/forward-sim";
const AGENT_PREFIX = "/api/agent/v1";
const MAX_BODY_BYTES = 8_000_000;
const DRAFT_TTL_MS = 5 * 60 * 1_000;
const SUPPORTED_SYMBOLS = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"]);

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createForwardSimulationApi({
  ledger,
  getRuntimeStatus,
  getAnalysisAttempt,
  runManualAnalysis,
  storage,
  backtestStorage = storage,
  backtestJobs = null,
  agentDomain = null,
  agentToken = null,
  now = Date.now,
}) {
  const drafts = new Map();
  const configuredAgentToken = typeof agentToken === "string" && agentToken.length > 0 ? agentToken : null;
  let acceptingRequests = true;

  function agentAuthorized(request) {
    if (!configuredAgentToken) return true;
    return request.headers.authorization === `Bearer ${configuredAgentToken}`;
  }

  function parseIntervals(url) {
    const values = [
      ...url.searchParams.getAll("interval"),
      ...url.searchParams.getAll("intervals").flatMap((value) => value.split(",")),
    ].filter(Boolean);
    return values.length > 0 ? values : undefined;
  }

  async function readAgentBody(request) {
    const body = await readJson(request);
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
      throw new AgentDomainError("A JSON object body is required", 400);
    }
    return body;
  }

  async function handleAgentRequest(request, response, url) {
    if (!agentDomain) {
      sendJson(response, 503, { error: "Agent API is unavailable" });
      return;
    }
    if (!agentAuthorized(request)) {
      sendJson(response, 401, { error: "Agent authorization required" });
      return;
    }

    if (request.method === "GET" && url.pathname === `${AGENT_PREFIX}/capabilities`) {
      sendJson(response, 200, agentDomain.getCapabilities());
      return;
    }
    if (request.method === "GET" && url.pathname === `${AGENT_PREFIX}/market`) {
      sendJson(response, 200, await agentDomain.getMarketSnapshot({
        symbol: url.searchParams.get("symbol"),
        intervals: parseIntervals(url),
        limit: url.searchParams.get("limit"),
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === `${AGENT_PREFIX}/analysis`) {
      const body = await readAgentBody(request);
      sendJson(response, 200, await agentDomain.analyzeSymbol(body));
      return;
    }
    if (request.method === "GET" && url.pathname === `${AGENT_PREFIX}/analysis/history`) {
      sendJson(response, 200, agentDomain.getAnalysisHistory({
        symbol: url.searchParams.get("symbol") || undefined,
        limit: url.searchParams.get("limit"),
      }));
      return;
    }
    const snapshotMatch = url.pathname.match(new RegExp(`^${AGENT_PREFIX}/analysis/([^/]+)$`));
    if (request.method === "GET" && snapshotMatch) {
      sendJson(response, 200, agentDomain.getAnalysisSnapshot({
        snapshotId: decodeURIComponent(snapshotMatch[1]),
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === `${AGENT_PREFIX}/backtest-report`) {
      sendJson(response, 200, agentDomain.getBacktestReport());
      return;
    }
    if (request.method === "GET" && url.pathname === `${AGENT_PREFIX}/forward-simulation/state`) {
      sendJson(response, 200, agentDomain.getForwardSimulationState());
      return;
    }
    if (request.method === "POST" && url.pathname === `${AGENT_PREFIX}/paper-order-drafts`) {
      const body = await readAgentBody(request);
      sendJson(response, 201, agentDomain.createPaperOrderDraft(body));
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  }

  function readBacktestStatus() {
    // crypto-ai-analysis.FORWARD_SIMULATION.11-1
    const current = backtestJobs?.getLatestBacktestStatus?.();
    if (current) return backtestStatusSummary(current);
    return backtestStatusSummary(readBacktestRecord(backtestStorage));
  }

  const server = createServer(async (request, response) => {
    if (!acceptingRequests) {
      sendJson(response, 503, { error: "Forward simulation is shutting down" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    for (const [id, item] of drafts) if (item.expiresAtMs <= now()) drafts.delete(id);

    try {
      if (request.method === "GET" && url.pathname === `${PREFIX}/health`) {
        // crypto-ai-analysis.LONG_RUNNING.3
        const runtime = getRuntimeStatus();
        const healthy = runtime?.ready === true && runtime?.storageStatus !== "error" && !ledger.getRuntimeError();
        sendJson(response, healthy ? 200 : 503, {
          status: healthy ? "ok" : "degraded",
          runtime,
          storageError: ledger.getRuntimeError(),
        });
        return;
      }
      if (url.pathname === AGENT_PREFIX || url.pathname.startsWith(`${AGENT_PREFIX}/`)) {
        try {
          await handleAgentRequest(request, response, url);
        } catch (error) {
          if (response.headersSent) {
            response.destroy();
            return;
          }
          const status = error instanceof AgentDomainError
            ? error.statusCode
            : error instanceof SyntaxError ? 400 : 500;
          sendJson(response, status, {
            error: error instanceof AgentDomainError
              ? error.message
              : error instanceof SyntaxError ? "Invalid JSON request body" : "Agent request failed",
          });
        }
        return;
      }
      if (url.pathname === `${PREFIX}/backtest-jobs` && request.method === "POST") {
        if (!backtestJobs) {
          sendJson(response, 503, { error: "Backtest job service is unavailable" });
          return;
        }
        const task = backtestJobs.create(await readJson(request));
        sendJson(response, 202, { task });
        return;
      }
      const backtestReportMatch = url.pathname.match(new RegExp(`^${PREFIX}/backtest-jobs/([^/]+)/report$`));
      if (request.method === "GET" && backtestReportMatch) {
        if (!backtestJobs) {
          sendJson(response, 503, { error: "Backtest job service is unavailable" });
          return;
        }
        sendJson(response, 200, backtestJobs.getReport(decodeURIComponent(backtestReportMatch[1])));
        return;
      }
      const backtestTaskMatch = url.pathname.match(new RegExp(`^${PREFIX}/backtest-jobs/([^/]+)$`));
      if (request.method === "GET" && backtestTaskMatch) {
        if (!backtestJobs) {
          sendJson(response, 503, { error: "Backtest job service is unavailable" });
          return;
        }
        sendJson(response, 200, { task: backtestJobs.get(decodeURIComponent(backtestTaskMatch[1])) });
        return;
      }
      if (request.method === "GET" && url.pathname === `${PREFIX}/state`) {
        sendJson(response, 200, {
          ledger: ledger.getState(),
          riskContext: ledger.getRiskContext(),
          runtime: getRuntimeStatus(),
          storageError: ledger.getRuntimeError(),
          costComparison: ledger.getCostComparison(),
          backtestStatus: readBacktestStatus(),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === `${PREFIX}/backtest-report`) {
        const record = backtestJobs?.getLatestBacktestStatus?.() ?? readBacktestRecord(backtestStorage);
        if (!record?.report) {
          sendJson(response, 404, { error: "No persisted backtest report" });
          return;
        }
        sendJson(response, 200, { report: record.report, backtestStatus: backtestStatusSummary(record) });
        return;
      }
      if (request.method === "POST" && url.pathname === `${PREFIX}/backtest-status`) {
        if (!backtestStorage?.setItem) {
          sendJson(response, 503, { error: "Backtest status storage is unavailable" });
          return;
        }
        const body = await readJson(request);
        if (body?.status === "invalid" && typeof body.strategyVersion === "string" && body.strategyVersion.length <= 100) {
          const record = createInvalidBacktestRecord(body.strategyVersion, now(), body.reason);
          backtestStorage.setItem(BACKTEST_RECORD_KEY, JSON.stringify(record));
          sendJson(response, 200, { backtestStatus: backtestStatusSummary(record) });
          return;
        }
        if (!body?.report || !validCostAssumptions(body.costAssumptions)) {
          sendJson(response, 400, { error: "A backtest report and valid cost assumptions are required" });
          return;
        }
        const record = persistBacktestRecord(backtestStorage, body.report, body.costAssumptions, now());
        sendJson(response, 200, { backtestStatus: backtestStatusSummary(record) });
        return;
      }
      if (request.method === "POST" && url.pathname === `${PREFIX}/analyze`) {
        if (!getRuntimeStatus().ready) {
          sendJson(response, 409, { error: "Forward simulation is disconnected, recovering or unavailable" });
          return;
        }
        const body = await readJson(request);
        if (!SUPPORTED_SYMBOLS.has(body?.symbol) || typeof runManualAnalysis !== "function") {
          sendJson(response, 400, { error: "A supported symbol is required for server-side analysis" });
          return;
        }
        const attempt = await runManualAnalysis(body.symbol);
        if (!attempt?.snapshotId || attempt.status !== "ready") {
          sendJson(response, 409, { error: "Latest server-side analysis is not ready for a simulated order" });
          return;
        }
        sendJson(response, 200, { snapshotId: attempt.snapshotId });
        return;
      }
      if (request.method === "POST" && url.pathname === `${PREFIX}/drafts`) {
        // crypto-ai-analysis.FORWARD_SIMULATION.10
        if (!getRuntimeStatus().ready) {
          sendJson(response, 409, { error: "Forward simulation is disconnected, recovering or unavailable" });
          return;
        }
        const body = await readJson(request);
        if (typeof body?.snapshotId !== "string" || typeof getAnalysisAttempt !== "function") {
          sendJson(response, 400, { error: "A server-issued analysis snapshot ID is required" });
          return;
        }
        const attempt = getAnalysisAttempt(body.snapshotId);
        if (!attempt || attempt.snapshotId !== body.snapshotId) {
          sendJson(response, 409, { error: "Analysis snapshot is unknown or no longer current" });
          return;
        }
        const backtestStatus = readBacktestStatus();
        if (!backtestStatus || backtestStatus.status === "invalid" ||
          backtestStatus.strategyVersion !== attempt.strategyVersion) {
          sendJson(response, 409, { error: "A valid backtest for the analysis strategy is required" });
          return;
        }
        const draft = ledger.createDraft(attempt, backtestStatus.status, backtestStatus.costAssumptions);
        const id = randomUUID();
        drafts.set(id, { draft, expiresAtMs: Math.min(now() + DRAFT_TTL_MS, draft.expiresAtMs) });
        sendJson(response, 201, { id, draft });
        return;
      }
      const confirmMatch = url.pathname.match(new RegExp(`^${PREFIX}/drafts/([^/]+)/confirm$`));
      if (request.method === "POST" && confirmMatch) {
        if (!getRuntimeStatus().ready) {
          sendJson(response, 409, { error: "Forward simulation is disconnected, recovering or unavailable" });
          return;
        }
        const id = decodeURIComponent(confirmMatch[1]);
        const prepared = drafts.get(id);
        if (!prepared || prepared.expiresAtMs <= now()) {
          drafts.delete(id);
          sendJson(response, 404, { error: "Prepared simulated order is missing or expired" });
          return;
        }
        const attempt = getAnalysisAttempt?.(prepared.draft.snapshotId);
        const backtestStatus = readBacktestStatus();
        if (!attempt || attempt.strategyVersion !== prepared.draft.strategyVersion ||
          !backtestStatus || backtestStatus.status !== prepared.draft.backtestStatus ||
          backtestStatus.strategyVersion !== prepared.draft.strategyVersion ||
          backtestStatus.status === "invalid") {
          drafts.delete(id);
          sendJson(response, 409, { error: "Analysis snapshot or backtest status changed; prepare the order again" });
          return;
        }
        const order = ledger.submitDraft(prepared.draft);
        drafts.delete(id);
        sendJson(response, 201, { order });
        return;
      }
      const orderMatch = url.pathname.match(new RegExp(`^${PREFIX}/orders/([^/]+)$`));
      if (request.method === "DELETE" && orderMatch) {
        ledger.cancelOrder(decodeURIComponent(orderMatch[1]));
        sendJson(response, 200, { ledger: ledger.getState() });
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, error instanceof BacktestJobError ? error.statusCode : 400, {
        error: error instanceof Error ? error.message : "Request failed",
      });
    }
  });
  server.beginShutdown = () => {
    acceptingRequests = false;
    drafts.clear();
  };
  return server;
}

export function listenForwardSimulationApi(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}
