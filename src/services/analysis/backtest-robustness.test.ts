import { describe, expect, it } from "vitest";
import { calculateAnnualizedSharpe, classifyMarketRegimeAt, runCryptoBacktest, simulateSpotExecution, DEFAULT_BACKTEST_CONFIG, type BacktestAnalysisEvent, type BacktestAssetData } from "./backtest.ts";
import { intervalToMs, type MarketCandle, type SpotInterval, type SpotSymbol } from "../market-data/types.ts";

const START = Date.UTC(2023, 0, 1);
const DAY = intervalToMs("1d");
const HOUR = intervalToMs("1h");
const CONFIG = { ...DEFAULT_BACKTEST_CONFIG, buyFeeRate: 0, sellFeeRate: 0, buySlippageRate: 0, sellSlippageRate: 0 };

function candle(symbol: SpotSymbol, interval: SpotInterval, openTimeMs: number, close: number): MarketCandle {
  return {
    symbol,
    interval,
    openTimeMs,
    closeTimeMs: openTimeMs + intervalToMs(interval) - 1,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 100,
    quoteVolume: close * 100,
    tradeCount: 10,
    isClosed: true,
    source: "rest",
  };
}

function asset(symbol: SpotSymbol = "BTCUSDT"): BacktestAssetData {
  const days = 252;
  const candles1d = Array.from({ length: days }, (_, index) => candle(symbol, "1d", START + index * DAY, 100));
  const candles4h = Array.from({ length: days * 6 }, (_, index) => candle(symbol, "4h", START + index * 4 * HOUR, 100));
  const candles1h = Array.from({ length: days * 24 }, (_, index) => candle(symbol, "1h", START + index * HOUR, 100));
  return { symbol, candles1d, candles4h, candles1h };
}

describe("backtest robustness report", () => {
  it("crypto-ai-analysis.VALIDATION.15 crypto-ai-analysis.VALIDATION.15-1 creates three chronological, non-overlapping test folds", () => {
    const report = runCryptoBacktest([asset()], CONFIG, { startMs: START, endMs: START + 252 * DAY - 1 });
    const folds = report.robustness.walkForward;

    expect(folds).toHaveLength(3);
    for (const fold of folds) {
      expect(fold.trainingPeriod.endMs).toBeLessThan(fold.testPeriod.startMs);
      expect(fold.metrics.tradeCount).toBe(0);
      expect(fold.sampleSufficient).toBe(false);
    }
    expect(folds[0]!.testPeriod.endMs).toBeLessThan(folds[1]!.testPeriod.startMs);
    expect(folds[1]!.testPeriod.endMs).toBeLessThan(folds[2]!.testPeriod.startMs);
    expect(folds[0]!.trainingPeriod.endMs).toBeLessThan(folds[1]!.trainingPeriod.endMs);
    expect(folds[1]!.trainingPeriod.endMs).toBeLessThan(folds[2]!.trainingPeriod.endMs);
    expect(report.validityChecks).toEqual({
      closedCandlesOnly: true,
      nextBarExecution: true,
      deterministicEngine: true,
    });
  });

  it("crypto-ai-analysis.VALIDATION.15-3 carries a pre-window confirmed plan into the first test candle", () => {
    const testOpen = START + 30 * HOUR;
    const firstBar = candle("BTCUSDT", "1h", testOpen, 100);
    const priorEvent: BacktestAnalysisEvent = {
      timeMs: testOpen - 1,
      state: "enter",
      avoidReason: null,
      pullbackLow: 95,
      signal: {
        symbol: "BTCUSDT",
        confirmedAtMs: testOpen - 1,
        validFromMs: testOpen,
        expiresAtMs: testOpen + 3 * HOUR,
        theoreticalEntryPrice: 100,
        entryLower: 99,
        entryUpper: 101,
        stopPrice: 90,
        takeProfit1Price: 120,
        takeProfit2Price: 130,
        riskReward: 2,
        pullbackLow: 95,
        score: 85,
        strategyVersion: "trend-pullback-v1",
      },
    };
    const result = simulateSpotExecution([{
      symbol: "BTCUSDT",
      candles1h: [firstBar],
      candles4h: [],
      candles1d: [],
    }], new Map([["BTCUSDT", [priorEvent]]]), {
      startMs: testOpen,
      endMs: firstBar.closeTimeMs,
    }, CONFIG, { includeOpeningSignal: true });

    expect(result.metrics.tradeCount).toBe(1);
    expect(result.trades[0]?.entryTimeMs).toBe(testOpen);
  });

  it("crypto-ai-analysis.VALIDATION.16 crypto-ai-analysis.VALIDATION.16-1 classifies only from candles closed at the trade time", () => {
    const daily = Array.from({ length: 230 }, (_, index) =>
      candle("BTCUSDT", "1d", START + index * DAY, 100 + index),
    );
    const atMs = daily[220]!.closeTimeMs;
    const original = classifyMarketRegimeAt(daily, atMs);
    const futureChanged = daily.map((row, index) => index <= 220 ? row : {
      ...row,
      open: 20,
      high: 21,
      low: 19,
      close: 20,
    });

    expect(original).toBe("bull");
    expect(classifyMarketRegimeAt(futureChanged, atMs)).toBe(original);
    expect(classifyMarketRegimeAt([], atMs)).toBe("unknown");
  });

  it("crypto-ai-analysis.VALIDATION.17 crypto-ai-analysis.VALIDATION.17-1 keeps score-threshold variants versioned and research-only", () => {
    const report = runCryptoBacktest([asset()], CONFIG, { startMs: START, endMs: START + 252 * DAY - 1 });

    expect(report.strategyVersion).toBe("trend-pullback-v1");
    expect(report.robustness.parameterSensitivity.map((item) => item.minimumScore)).toEqual([65, 70, 75]);
    expect(new Set(report.robustness.parameterSensitivity.map((item) => item.strategyVersion)).size).toBe(3);
    for (const variant of report.robustness.parameterSensitivity) {
      expect(variant.period.startMs).toBeGreaterThanOrEqual(report.symbols.BTCUSDT!.research.period.startMs);
      expect(variant.period.endMs).toBeLessThanOrEqual(report.symbols.BTCUSDT!.research.period.endMs);
      expect(variant.evaluationScope).toBe("research-only");
    }
  });

  it("crypto-ai-analysis.VALIDATION.10 audits hourly Sharpe using sample deviation and annualization", () => {
    const result = calculateAnnualizedSharpe([0.01, -0.01, 0.02]);
    expect(result).toBeCloseTo(40.848, 2);
    expect(calculateAnnualizedSharpe([0, 0, 0])).toBeNull();
    expect(calculateAnnualizedSharpe([])).toBeNull();
  });
});
