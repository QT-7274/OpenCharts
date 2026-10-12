import { homedir } from "node:os";
import { join } from "node:path";
import { createAtomicFileStorage } from "./file-storage.mjs";
import { BACKTEST_RECORD_KEY, createInvalidBacktestRecord, persistBacktestRecord } from "./backtest-persistence.mjs";
import { createBinanceRestAdapter } from "../src/services/market-data/rest-adapter.ts";
import { loadCryptoBacktestHistory } from "../src/services/analysis/backtest-history.ts";
import { DEFAULT_BACKTEST_CONFIG, runCryptoBacktest } from "../src/services/analysis/backtest.ts";

const reportPath = process.env.OPENCHARTS_BACKTEST_REPORT_PATH || join(homedir(), ".opencharts", "crypto-backtest-report.json");
const restAdapter = createBinanceRestAdapter({
  baseUrl: process.env.OPENCHARTS_BINANCE_REST_BASE_URL || "https://data-api.binance.vision/api/v3",
});

const storage = createAtomicFileStorage(reportPath);

try {
  console.info("Loading closed Binance Spot history for crypto backtest...");
  const history = await loadCryptoBacktestHistory({
    adapter: restAdapter,
    onProgress: ({ completed, total, symbol, interval, loadedCandles }) => {
      console.info(`[${completed}/${total}] ${symbol} ${interval}: ${loadedCandles} candles`);
    },
  });
  const report = runCryptoBacktest(history.assets, { ...DEFAULT_BACKTEST_CONFIG }, history.requestedPeriod);
  const record = persistBacktestRecord(storage, report, report.costAssumptions);

  console.info(`Backtest report persisted: ${reportPath}`);
  console.info(JSON.stringify({
    status: record.status,
    strategyVersion: record.strategyVersion,
    reportGeneratedAtMs: record.reportGeneratedAtMs,
    updatedAtMs: record.updatedAtMs,
    outOfSample: report.portfolio.outOfSample.metrics,
  }, null, 2));
} catch (error) {
  const reason = error instanceof Error ? error.message : "Backtest history or execution failed";
  const record = createInvalidBacktestRecord("trend-pullback-v1", Date.now(), reason);
  storage.setItem(BACKTEST_RECORD_KEY, JSON.stringify(record));
  console.error(`Backtest invalid; no simulated orders may be created: ${reason}`);
  console.error(`Invalid status persisted: ${reportPath}`);
  process.exitCode = 1;
}
