import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PREFIX = "/api/forward-sim";
const MAX_BODY_BYTES = 1_000_000;
const DRAFT_TTL_MS = 5 * 60 * 1_000;
const BACKTEST_STATUS_KEY = "opencharts.crypto.backtest-status.v1";
const SUPPORTED_SYMBOLS = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"]);
const DEFAULT_COST_ASSUMPTIONS = Object.freeze({
  buyFeeRate: 0.001,
  sellFeeRate: 0.001,
  buySlippageRate: 0.0005,
  sellSlippageRate: 0.0005,
});

function validCostAssumptions(value) {
  return value && Object.keys(DEFAULT_COST_ASSUMPTIONS).every((key) =>
    Number.isFinite(value[key]) && value[key] >= 0 && value[key] < 1);
}

function profitFactorAtLeast(value, threshold) {
  return value === "infinite" || (Number.isFinite(value) && value >= threshold);
}

function deriveBacktestStatus(report) {
  if (!report || report.strategyVersion !== "trend-pullback-v1" ||
    !report.validityChecks || Object.values(report.validityChecks).some((passed) => passed !== true)) {
    return { status: "invalid", strategyVersion: report?.strategyVersion ?? "trend-pullback-v1" };
  }
  const outOfSample = report.portfolio?.outOfSample?.metrics;
  if (!outOfSample || !Number.isFinite(outOfSample.tradeCount) ||
    !Number.isFinite(outOfSample.maxDrawdownPct) || !Number.isFinite(outOfSample.netReturnPct)) {
    return { status: "invalid", strategyVersion: report.strategyVersion };
  }
  const eligibleSymbols = [...SUPPORTED_SYMBOLS].filter((symbol) =>
    profitFactorAtLeast(report.symbols?.[symbol]?.outOfSample?.metrics?.profitFactor, 1));
  const researchUsable = outOfSample.tradeCount >= 100 &&
    profitFactorAtLeast(outOfSample.profitFactor, 1.1) && outOfSample.maxDrawdownPct <= 25 &&
    outOfSample.netReturnPct > 0 && eligibleSymbols.length >= 4 &&
    [...SUPPORTED_SYMBOLS].every((symbol) => report.symbols?.[symbol]);
  return { status: researchUsable ? "research-usable" : "experimental", strategyVersion: report.strategyVersion };
}

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
  now = Date.now,
}) {
  const drafts = new Map();
  function readBacktestStatus() {
    try {
      const record = JSON.parse(storage?.getItem(BACKTEST_STATUS_KEY) ?? "null");
      if (!record || !["research-usable", "experimental", "invalid"].includes(record.status) ||
        typeof record.strategyVersion !== "string") return null;
      return record;
    } catch {
      return null;
    }
  }

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    for (const [id, item] of drafts) if (item.expiresAtMs <= now()) drafts.delete(id);

    try {
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
      if (request.method === "POST" && url.pathname === `${PREFIX}/backtest-status`) {
        if (!storage?.setItem) {
          sendJson(response, 503, { error: "Backtest status storage is unavailable" });
          return;
        }
        const body = await readJson(request);
        if (body?.status === "invalid" && typeof body.strategyVersion === "string" && body.strategyVersion.length <= 100) {
          const backtestStatus = {
            status: "invalid",
            strategyVersion: body.strategyVersion,
            costAssumptions: DEFAULT_COST_ASSUMPTIONS,
            updatedAtMs: now(),
          };
          storage.setItem(BACKTEST_STATUS_KEY, JSON.stringify(backtestStatus));
          sendJson(response, 200, { backtestStatus });
          return;
        }
        if (!body?.report || !validCostAssumptions(body.costAssumptions)) {
          sendJson(response, 400, { error: "A backtest report and valid cost assumptions are required" });
          return;
        }
        const derived = deriveBacktestStatus(body.report);
        const backtestStatus = {
          ...derived,
          costAssumptions: body.costAssumptions,
          updatedAtMs: now(),
        };
        storage.setItem(BACKTEST_STATUS_KEY, JSON.stringify(backtestStatus));
        sendJson(response, 200, { backtestStatus });
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
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Request failed" });
    }
  });
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
