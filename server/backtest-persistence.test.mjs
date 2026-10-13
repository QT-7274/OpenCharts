import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BACKTEST_RECORD_KEY,
  persistBacktestRecord,
  readBacktestRecord,
} from "./backtest-persistence.mjs";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"];
const COSTS = { buyFeeRate: 0.001, sellFeeRate: 0.001, buySlippageRate: 0.0005, sellSlippageRate: 0.0005 };

function metrics() {
  return {
    signalCount: 10,
    tradeCount: 10,
    skippedSignalCount: 0,
    skipReasons: {},
    strategyStateCounts: { watch: 0, setup: 0, enter: 10, avoid: 0 },
    winRatePct: 50,
    netReturnPct: 2,
    annualizedReturnPct: 2,
    profitFactor: 1.2,
    maxDrawdownPct: 5,
    averageNetPnl: 20,
    averageHoldingHours: 4,
    averageActualRiskReward: 1.1,
    totalCosts: 10,
    maxConsecutiveLosses: 2,
    sharpeRatio: 0.8,
    endingEquity: 10_200,
  };
}

function result(period) {
  return {
    period,
    metrics: metrics(),
    trades: [],
    buyAndHold: {
      netReturnPct: 3,
      maxDrawdownPct: 6,
      sharpeRatio: 0.7,
      netReturnDifferencePct: -1,
      maxDrawdownDifferencePct: -1,
      sharpeDifference: 0.1,
    },
  };
}

function report(overrides = {}) {
  const requestedPeriod = { startMs: 1, endMs: 100 };
  const folds = [
    { id: 1, trainingPeriod: { startMs: 1, endMs: 30 }, testPeriod: { startMs: 31, endMs: 50 } },
    { id: 2, trainingPeriod: { startMs: 1, endMs: 50 }, testPeriod: { startMs: 51, endMs: 70 } },
    { id: 3, trainingPeriod: { startMs: 1, endMs: 70 }, testPeriod: { startMs: 71, endMs: 100 } },
  ].map((fold) => ({ ...fold, sampleSufficient: false, metrics: metrics() }));
  const robustness = {
    walkForward: folds,
    marketRegimes: ["bull", "sideways", "bear", "unknown"].map((regime) => ({
      regime, tradeCount: 0, netPnl: 0, winRatePct: null, profitFactor: null,
    })),
    parameterSensitivity: [65, 70, 75].map((minimumScore) => ({
      minimumScore,
      strategyVersion: minimumScore === 70 ? "trend-pullback-v1" : `trend-pullback-v1-score-${minimumScore}`,
      evaluationScope: "research-only",
      period: { startMs: 1, endMs: 30 },
      metrics: metrics(),
    })),
  };
  const base = {
    strategyVersion: "trend-pullback-v1",
    status: "experimental",
    statusReason: "样本不足",
    generatedAtMs: 100,
    costAssumptions: COSTS,
    requestedPeriod,
    validityChecks: { closedCandlesOnly: true, nextBarExecution: true, deterministicEngine: true },
    portfolio: { research: result({ startMs: 1, endMs: 70 }), outOfSample: result({ startMs: 71, endMs: 100 }) },
    symbols: Object.fromEntries(SYMBOLS.map((symbol) => [symbol, {
      research: result({ startMs: 1, endMs: 70 }),
      outOfSample: result({ startMs: 71, endMs: 100 }),
    }])),
    robustness,
  };
  return { ...base, ...overrides };
}

function storageWith(values = new Map()) {
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("crypto-ai-analysis.VALIDATION.18-1 persists a restart-readable complete report record", () => {
  const storage = storageWith();
  const value = report();
  const record = persistBacktestRecord(storage, value, value.costAssumptions, 200);
  const restored = JSON.parse(storage.getItem(BACKTEST_RECORD_KEY));
  assert.equal(record.status, "experimental");
  assert.deepEqual(restored.report, value);
  assert.equal(restored.reportGeneratedAtMs, 100);
  assert.equal(restored.updatedAtMs, 200);
  assert.equal(readBacktestRecord(storage).status, "experimental");
});

test("crypto-ai-analysis.VALIDATION.14-2 rejects an incomplete robustness report", () => {
  const storage = storageWith();
  const value = report({ robustness: { walkForward: [], marketRegimes: [], parameterSensitivity: [] } });
  persistBacktestRecord(storage, value, value.costAssumptions, 200);

  const restored = readBacktestRecord(storage);
  assert.equal(restored.status, "invalid");
  assert.equal(restored.report, null);
});

test("crypto-ai-analysis.BACKTEST_JOBS.5 preserves task identity in the shared report record", () => {
  const storage = storageWith();
  persistBacktestRecord(storage, report({ generatedAtMs: 1 }), COSTS, 3, { taskId: "task-1" });
  assert.equal(readBacktestRecord(storage).taskId, "task-1");
});
