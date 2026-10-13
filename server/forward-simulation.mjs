import { homedir } from "node:os";
import { join } from "node:path";
import { createAtomicFileStorage } from "./file-storage.mjs";
import { createForwardSimulationApi, listenForwardSimulationApi } from "./forward-simulation-api.mjs";
import { resolveCurrentPersistedAnalysisAttempt } from "./analysis-snapshot-resolver.mjs";
import { createBacktestJobRunner } from "./backtest-jobs.mjs";
import { createAgentDomain } from "./agent-domain.mjs";
import { SUPPORTED_SPOT_SYMBOLS } from "../src/services/market-data/types.ts";
import { createBinanceRestAdapter } from "../src/services/market-data/rest-adapter.ts";
import { BinanceKlineStream } from "../src/services/market-data/ws-adapter.ts";
import { createAnalysisPipeline } from "../src/services/analysis/pipeline.ts";
import { loadCryptoBacktestHistory } from "../src/services/analysis/backtest-history.ts";
import { runCryptoBacktest } from "../src/services/analysis/backtest.ts";
import { createCryptoPaperLedger } from "../src/services/analysis/paper-trading.ts";
import { createForwardRuntime } from "../src/services/analysis/forward-runtime.ts";

const port = Number(process.env.OPENCHARTS_FORWARD_PORT ?? 4001);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("OPENCHARTS_FORWARD_PORT is invalid");

const dataPath = process.env.OPENCHARTS_FORWARD_DATA_PATH || join(homedir(), ".opencharts", "forward-simulation.json");
const backtestReportPath = process.env.OPENCHARTS_BACKTEST_REPORT_PATH || join(homedir(), ".opencharts", "crypto-backtest-report.json");
const restAdapter = createBinanceRestAdapter({
  baseUrl: process.env.OPENCHARTS_BINANCE_REST_BASE_URL || "https://data-api.binance.vision/api/v3",
});
const stream = new BinanceKlineStream({
  restAdapter,
  baseUrl: process.env.OPENCHARTS_BINANCE_WS_BASE_URL || "wss://data-stream.binance.vision",
});
const storage = createAtomicFileStorage(dataPath);
const backtestStorage = createAtomicFileStorage(backtestReportPath);
const backtestJobs = createBacktestJobRunner({
  storage: backtestStorage,
  loadHistory: ({ onProgress }) => loadCryptoBacktestHistory({ adapter: restAdapter, onProgress }),
  runBacktest: (assets, config, requestedPeriod) => runCryptoBacktest(assets, config, requestedPeriod),
});
const ledger = createCryptoPaperLedger({
  storage,
  afterCandle: async (candle) => {
    await analysisPipeline.onHourlyClose(candle);
  },
});
const analysisPipeline = createAnalysisPipeline({
  restAdapter,
  getHealth: () => stream.health,
  getRiskContext: () => ledger.getRiskContext(),
  storage,
});
analysisPipeline.subscribe((attempt) => ledger.recordAnalysis(attempt));

const subscriptions = SUPPORTED_SPOT_SYMBOLS.map((symbol) => ({ symbol, interval: "1h" }));
const runtime = createForwardRuntime({ ledger, stream, restAdapter });
const agentDomain = createAgentDomain({
  restAdapter,
  analysisPipeline,
  ledger,
  backtestStorage,
  backtestJobs,
  getRuntimeStatus: () => runtime.getStatus(),
});

const api = createForwardSimulationApi({
  ledger,
  storage,
  backtestStorage,
  backtestJobs,
  agentDomain,
  agentToken: process.env.OPENCHARTS_AGENT_TOKEN || null,
  runManualAnalysis: (symbol) => {
    if (!SUPPORTED_SPOT_SYMBOLS.includes(symbol)) throw new Error("Unsupported spot symbol");
    return analysisPipeline.runManual(symbol);
  },
  // crypto-ai-analysis.FORWARD_SIMULATION.10-1
  getAnalysisAttempt: (snapshotId) => resolveCurrentPersistedAnalysisAttempt(analysisPipeline, snapshotId),
  getRuntimeStatus: () => ({
    ...runtime.getStatus(),
    dataPath,
  }),
});

api.on("error", (error) => {
  console.error("Forward simulation API failed:", error.message);
});

const address = await listenForwardSimulationApi(api, port);
stream.connect(subscriptions);
console.info(`Forward simulation listening on http://127.0.0.1:${address.port}/api/forward-sim/state`);
console.info(`Agent API available at http://127.0.0.1:${address.port}/api/agent/v1`);
console.info(`Paper ledger stored at ${dataPath}`);
console.info(`Backtest report stored at ${backtestReportPath}`);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  api.beginShutdown?.();
  const runtimeStopped = runtime.stop();
  stream.disconnect();
  await Promise.all([runtimeStopped, backtestJobs.waitForIdle()]);
  await new Promise((resolve) => api.close(resolve));
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
