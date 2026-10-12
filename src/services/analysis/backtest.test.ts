import { describe, expect, it } from "vitest";
import { countSymbolsMeetingProfitFactor, DEFAULT_BACKTEST_CONFIG, runCryptoBacktest, simulateSpotExecution, type BacktestAssetData, type BacktestAnalysisEvent, type BacktestSignal } from "./backtest.ts";
import { intervalToMs, SUPPORTED_SPOT_SYMBOLS, type MarketCandle, type SpotInterval, type SpotSymbol } from "../market-data/types.ts";

const HOUR = intervalToMs("1h");
const DAY = intervalToMs("1d");
const START = Date.UTC(2023, 0, 1);
const CONFIG = { ...DEFAULT_BACKTEST_CONFIG, buyFeeRate: 0, sellFeeRate: 0, buySlippageRate: 0, sellSlippageRate: 0 };

function bar(interval: SpotInterval, openTimeMs: number, overrides: Partial<MarketCandle> = {}): MarketCandle {
  return { symbol: "BTCUSDT", interval, openTimeMs, closeTimeMs: openTimeMs + intervalToMs(interval) - 1,
    open: 100, high: 101, low: 99, close: 100, volume: 100, quoteVolume: 10_000, tradeCount: 10, isClosed: true, source: "rest", ...overrides };
}

function signal(timeMs = START + HOUR - 1, symbol: SpotSymbol = "BTCUSDT"): BacktestSignal {
  return { symbol, confirmedAtMs: timeMs, validFromMs: timeMs + 1, expiresAtMs: timeMs + 3 * HOUR,
    theoreticalEntryPrice: 100, entryLower: 99, entryUpper: 101, stopPrice: 90, takeProfit1Price: 120,
    takeProfit2Price: 130, riskReward: 2, pullbackLow: 95, score: 85, strategyVersion: "trend-pullback-v1" };
}

function execute(candles: MarketCandle[], signals = [signal()], config = CONFIG) {
  const assets: BacktestAssetData[] = [...new Set(candles.map((candle) => candle.symbol))].map((symbol) => ({
    symbol, candles1h: candles.filter((candle) => candle.symbol === symbol), candles4h: [], candles1d: [],
  }));
  const events = new Map<SpotSymbol, BacktestAnalysisEvent[]>();
  for (const plan of signals) events.set(plan.symbol, [...(events.get(plan.symbol) ?? []), {
    timeMs: plan.confirmedAtMs, state: "enter", avoidReason: null, pullbackLow: plan.pullbackLow, signal: plan,
  }]);
  return simulateSpotExecution(assets, events, { startMs: START, endMs: candles.at(-1)!.closeTimeMs }, config);
}

describe("spot backtest execution", () => {
  it("crypto-ai-analysis.VALIDATION.4-1 excludes warmup signals from the statistical period", () => {
    const plan = signal(START + HOUR - 1);
    const candles = [bar("1h", START), bar("1h", START + HOUR)];
    const asset: BacktestAssetData = { symbol: "BTCUSDT", candles1h: candles, candles4h: [], candles1d: [] };
    const warmupEvent: BacktestAnalysisEvent = {
      timeMs: plan.confirmedAtMs,
      state: "enter",
      avoidReason: null,
      pullbackLow: plan.pullbackLow,
      signal: plan,
    };
    const result = simulateSpotExecution(
      [asset],
      new Map([["BTCUSDT", [warmupEvent]]]),
      { startMs: START + HOUR, endMs: START + 2 * HOUR - 1 },
      CONFIG,
    );

    expect(result.metrics.signalCount).toBe(0);
    expect(result.trades).toHaveLength(0);
  });

  it("crypto-ai-analysis.VALIDATION.6 ignores prices inside the confirming candle", () => {
    const result = execute([bar("1h", START, { low: 80, high: 140 }), bar("1h", START + HOUR)]);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.entryTimeMs).toBe(START + HOUR);
    expect(result.trades[0]!.exitReason).toBe("period-end");
    expect(result.trades[0]!.netPnl).toBe(0);
  });

  it("crypto-ai-analysis.VALIDATION.6-1 fills then stops, with stop priority over targets", () => {
    const result = execute([bar("1h", START), bar("1h", START + HOUR, { low: 85, high: 140 })]);
    expect(result.trades[0]!.exitReason).toBe("stop");
    expect(result.trades[0]!.averageExitPrice).toBe(90);
    expect(result.trades[0]!.netPnl).toBeCloseTo(-90.9090909);
  });

  it("crypto-ai-analysis.VALIDATION.7 crypto-ai-analysis.VALIDATION.7-1 applies adverse costs and caps cost-inclusive risk", () => {
    const result = execute([bar("1h", START), bar("1h", START + HOUR)], [signal()], { ...DEFAULT_BACKTEST_CONFIG });
    const trade = result.trades[0]!;
    expect(trade.theoreticalEntryPrice).toBe(100);
    expect(trade.actualEntryPrice).toBeCloseTo(100.05);
    expect(trade.averageExitPrice).toBeCloseTo(99.95);
    expect(trade.costs).toBeGreaterThan(0);
    expect(trade.netPnl).toBeCloseTo(-trade.costs);
    expect(trade.actualRisk).toBeLessThanOrEqual(100);
    expect(result.metrics.endingEquity).toBeCloseTo(10_000 + trade.netPnl);
    expect(result.metrics.totalCosts).toBeCloseTo(trade.costs);
  });

  it("crypto-ai-analysis.VALIDATION.9 crypto-ai-analysis.VALIDATION.9-1 sells half at TP1 then prioritizes cost-inclusive break-even", () => {
    const result = execute([bar("1h", START), bar("1h", START + HOUR),
      bar("1h", START + 2 * HOUR, { open: 110, low: 100, high: 140, close: 125 })], [signal()], { ...DEFAULT_BACKTEST_CONFIG });
    const trade = result.trades[0]!;
    expect(trade.exitReason).toBe("break-even");
    expect(trade.netPnl).toBeCloseTo(trade.quantity / 2 * (119.94 * 0.999 - 100.05 * 1.001));
    expect(trade.averageExitPrice).toBeGreaterThan(109);
    expect(trade.averageExitPrice).toBeLessThan(111);
  });

  it("crypto-ai-analysis.VALIDATION.8 crypto-ai-analysis.VALIDATION.8-1 caps portfolio risk and records duplicate signals", () => {
    const symbols: SpotSymbol[] = ["ADAUSDT", "BNBUSDT", "BTCUSDT", "ETHUSDT"];
    const candles = [0, 1, 2].flatMap((index) => symbols.map((symbol) => bar("1h", START + index * HOUR, { symbol })));
    const plans = symbols.flatMap((symbol) => [signal(START + HOUR - 1, symbol), signal(START + 2 * HOUR - 1, symbol)]);
    const result = execute(candles, plans);
    expect(result.metrics.skipReasons["portfolio-risk-limit"]).toBeGreaterThanOrEqual(1);
    expect(result.metrics.skipReasons["position-already-open"]).toBe(3);
    expect(result.trades).toHaveLength(3);
    expect(result.trades.reduce((total, trade) => total + trade.actualRisk, 0)).toBeLessThanOrEqual(300);
  });

  it("crypto-ai-analysis.VALIDATION.12 includes identical buy-and-hold transaction costs", () => {
    const result = execute([bar("1h", START), bar("1h", START + HOUR)], [], { ...DEFAULT_BACKTEST_CONFIG });
    expect(result.metrics.netReturnPct).toBe(0);
    expect(result.buyAndHold.netReturnPct).toBeCloseTo(-0.2995505993);
    expect(result.buyAndHold.netReturnDifferencePct).toBeCloseTo(0.2995505993);
  });
});

function flatHistory(symbol: SpotSymbol = "BTCUSDT"): BacktestAssetData {
  const make = (interval: SpotInterval, count: number) => Array.from({ length: count }, (_, index) =>
    bar(interval, START + index * intervalToMs(interval), { symbol }));
  return { symbol, candles1h: make("1h", 252 * 24), candles4h: make("4h", 252 * 6), candles1d: make("1d", 252) };
}

describe("crypto historical report", () => {
  it("crypto-ai-analysis.VALIDATION.6 emits real confirmed strategy signals before later execution", () => {
    const candles1h = Array.from({ length: 252 * 24 }, (_, index) => {
      const mid = 100 + index * 0.002;
      const close = mid + Math.sin(index * Math.PI / 6) * 0.05;
      return bar("1h", START + index * HOUR, {
        open: close - 0.001, close, high: mid + 1, low: mid - 1,
      });
    });
    const aggregate = (interval: SpotInterval, size: number) => Array.from({ length: candles1h.length / size }, (_, index) => {
      const rows = candles1h.slice(index * size, (index + 1) * size);
      return bar(interval, rows[0]!.openTimeMs, {
        open: rows[0]!.open, close: rows.at(-1)!.close,
        high: Math.max(...rows.map((row) => row.high)), low: Math.min(...rows.map((row) => row.low)),
      });
    });
    const report = runCryptoBacktest([{
      symbol: "BTCUSDT", candles1h, candles4h: aggregate("4h", 4), candles1d: aggregate("1d", 24),
    }], CONFIG, { startMs: START, endMs: START + 252 * DAY - 1 });
    expect(report.portfolio.research.metrics.signalCount, JSON.stringify(report.portfolio.research.metrics.strategyStateCounts)).toBeGreaterThan(0);
    expect(report.portfolio.research.metrics.tradeCount).toBeGreaterThan(0);
  });
  it("crypto-ai-analysis.VALIDATION.4-1 crypto-ai-analysis.VALIDATION.5 excludes warmup and splits chronologically", () => {
    const report = runCryptoBacktest([flatHistory()], CONFIG, { startMs: START, endMs: START + 252 * DAY - 1 });
    expect(report.symbols.BTCUSDT!.research.period).toEqual({ startMs: START + 250 * DAY, endMs: START + 250 * DAY + 33 * HOUR - 1 });
    expect(report.symbols.BTCUSDT!.outOfSample.period.startMs).toBe(START + 250 * DAY + 33 * HOUR);
    expect(report.portfolio.research.metrics.tradeCount).toBe(0);
    expect(report.status).toBe("experimental");
    expect(report.portfolio.outOfSample.metrics.winRatePct).toBeNull();
  });

  it("crypto-ai-analysis.VALIDATION.14-1 repeats exactly and future changes preserve research results", () => {
    const asset = flatHistory();
    const period = { startMs: START, endMs: START + 252 * DAY - 1 };
    const report = runCryptoBacktest([asset], CONFIG, period);
    expect(report.costAssumptions).toEqual({
      buyFeeRate: CONFIG.buyFeeRate,
      sellFeeRate: CONFIG.sellFeeRate,
      buySlippageRate: CONFIG.buySlippageRate,
      sellSlippageRate: CONFIG.sellSlippageRate,
    });
    expect(runCryptoBacktest([asset], CONFIG, period)).toEqual(report);
    const split = report.symbols.BTCUSDT!.outOfSample.period.startMs;
    const change = (candles: readonly MarketCandle[]) => candles.map((candle) => candle.openTimeMs < split ? candle :
      { ...candle, open: 200, high: 201, low: 199, close: 200 });
    const changed = runCryptoBacktest([{ ...asset, candles1h: change(asset.candles1h), candles4h: change(asset.candles4h), candles1d: change(asset.candles1d) }], CONFIG, period);
    expect(changed.symbols.BTCUSDT!.research).toEqual(report.symbols.BTCUSDT!.research);
  });

  it("crypto-ai-analysis.VALIDATION.2 rejects open candles and unresolved gaps", () => {
    const asset = flatHistory();
    const period = { startMs: START, endMs: START + 252 * DAY - 1 };
    expect(() => runCryptoBacktest([{ ...asset, candles1h: asset.candles1h.slice(1).filter((_, index) => index !== 100) }], CONFIG, period)).toThrow(/invalid/);
    expect(() => runCryptoBacktest([{ ...asset, candles1d: [ ...asset.candles1d.slice(0, -1), { ...asset.candles1d.at(-1)!, isClosed: false } ] }], CONFIG, period)).toThrow(/无效/);
  });

  it("crypto-ai-analysis.VALIDATION.8 rejects invalid risk caps", () => {
    const asset = flatHistory();
    const period = { startMs: START, endMs: START + 252 * DAY - 1 };
    expect(() => runCryptoBacktest([asset], { ...CONFIG, maxTradeRiskFraction: 0 }, period)).toThrow(/风险/);
    expect(() => runCryptoBacktest([asset], { ...CONFIG, maxPortfolioRiskFraction: Number.NaN }, period)).toThrow(/风险/);
  });

  it("crypto-ai-analysis.VALIDATION.4 crypto-ai-analysis.VALIDATION.10 creates six coin and portfolio reports", () => {
    const assets = SUPPORTED_SPOT_SYMBOLS.map((symbol) => flatHistory(symbol));
    const period = { startMs: START, endMs: START + 252 * DAY - 1 };
    const report = runCryptoBacktest(assets, CONFIG, period);
    expect(Object.keys(report.symbols).sort()).toEqual([...SUPPORTED_SPOT_SYMBOLS].sort());
    expect(report.portfolio.research.period.endMs).toBeLessThan(report.portfolio.outOfSample.period.startMs);
    expect(report.portfolio.outOfSample.metrics.tradeCount).toBe(0);
    expect(report.status).toBe("experimental");
  });

  it("crypto-ai-analysis.VALIDATION.4 rejects incomplete timeframe tails", () => {
    const asset = flatHistory();
    const period = { startMs: START, endMs: START + 252 * DAY - 1 };

    expect(() => runCryptoBacktest([{ ...asset, candles4h: asset.candles4h.slice(0, -1) }], CONFIG, period)).toThrow(/4h.*尾部不完整/);
    expect(() => runCryptoBacktest([{ ...asset, candles1d: asset.candles1d.slice(0, -1) }], CONFIG, period)).toThrow(/1d.*尾部不完整/);
  });

  it("crypto-ai-analysis.VALIDATION.13 counts symbol profit factors only in the portfolio out-of-sample window", () => {
    const symbols = [...SUPPORTED_SPOT_SYMBOLS];
    const assets = symbols.map((symbol): BacktestAssetData => ({
      symbol,
      candles1h: [
        bar("1h", START, { symbol }),
        bar("1h", START + HOUR, { symbol }),
        bar("1h", START + 2 * HOUR, { symbol, low: 95, high: 140, close: 120 }),
      ],
      candles4h: [],
      candles1d: [],
    }));
    const events = new Map<SpotSymbol, BacktestAnalysisEvent[]>();
    for (const symbol of symbols.slice(0, 4)) {
      const plan = signal(START + 2 * HOUR - 1, symbol);
      events.set(symbol, [{ timeMs: plan.confirmedAtMs, state: "enter", avoidReason: null, pullbackLow: plan.pullbackLow, signal: plan }]);
    }
    const earlierSymbol = symbols[4]!;
    const earlierPlan = signal(START + HOUR - 1, earlierSymbol);
    events.set(earlierSymbol, [{ timeMs: earlierPlan.confirmedAtMs, state: "enter", avoidReason: null, pullbackLow: earlierPlan.pullbackLow, signal: earlierPlan }]);

    const count = countSymbolsMeetingProfitFactor(
      assets,
      events,
      { startMs: START + HOUR, endMs: START + 3 * HOUR - 1 },
      CONFIG,
    );

    expect(count).toBe(4);
  });
});
