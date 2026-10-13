import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKTEST_RECORD_KEY, persistBacktestRecord, readBacktestRecord } from "./backtest-persistence.mjs";

test("crypto-ai-analysis.VALIDATION.18-1 persists a restart-readable report record", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const period = { startMs: 1, endMs: 2 };
  const result = { period, metrics: { tradeCount: 10, maxDrawdownPct: 5, netReturnPct: 2, profitFactor: 1.2 }, trades: [], buyAndHold: {} };
  const report = {
    strategyVersion: "trend-pullback-v1", generatedAtMs: 100, statusReason: "样本不足",
    costAssumptions: { buyFeeRate: 0.001, sellFeeRate: 0.001, buySlippageRate: 0.0005, sellSlippageRate: 0.0005 },
    requestedPeriod: period, validityChecks: { closedCandlesOnly: true, nextBarExecution: true, deterministicEngine: true },
    portfolio: { research: result, outOfSample: result },
    symbols: Object.fromEntries(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"]
      .map((symbol) => [symbol, { research: result, outOfSample: result }])),
    robustness: { walkForward: [], marketRegimes: [], parameterSensitivity: [] },
  };
  const record = persistBacktestRecord(storage, report, report.costAssumptions, 200);
  const restored = JSON.parse(storage.getItem(BACKTEST_RECORD_KEY));
  assert.equal(record.status, "experimental");
  assert.deepEqual(restored.report, report);
  assert.equal(restored.reportGeneratedAtMs, 100);
  assert.equal(restored.updatedAtMs, 200);
});

test("crypto-ai-analysis.BACKTEST_JOBS.5 preserves task identity in the shared report record", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const report = {
    strategyVersion: "trend-pullback-v1",
    generatedAtMs: 1,
    requestedPeriod: { startMs: 1, endMs: 2 },
    costAssumptions: { buyFeeRate: 0.001, sellFeeRate: 0.001, buySlippageRate: 0.0005, sellSlippageRate: 0.0005 },
    validityChecks: { closedCandlesOnly: true, nextBarExecution: true, deterministicEngine: true },
    portfolio: { research: { period: { startMs: 1, endMs: 2 }, metrics: { tradeCount: 10, maxDrawdownPct: 5, netReturnPct: 2, profitFactor: 1.2 }, trades: [], buyAndHold: {} }, outOfSample: { period: { startMs: 1, endMs: 2 }, metrics: { tradeCount: 10, maxDrawdownPct: 5, netReturnPct: 2, profitFactor: 1.2 }, trades: [], buyAndHold: {} } },
    symbols: Object.fromEntries(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"].map((symbol) => [symbol, { research: { period: { startMs: 1, endMs: 2 }, metrics: { tradeCount: 10, maxDrawdownPct: 5, netReturnPct: 2, profitFactor: 1.2 }, trades: [], buyAndHold: {} }, outOfSample: { period: { startMs: 1, endMs: 2 }, metrics: { tradeCount: 10, maxDrawdownPct: 5, netReturnPct: 2, profitFactor: 1.2 }, trades: [], buyAndHold: {} } }])),
    robustness: { walkForward: [], marketRegimes: [], parameterSensitivity: [] },
  };
  persistBacktestRecord(storage, report, report.costAssumptions, 3, { taskId: "task-1" });
  assert.equal(readBacktestRecord(storage).taskId, "task-1");
});
