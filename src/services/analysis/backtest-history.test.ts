import { describe, expect, it, vi } from "vitest";
import { BacktestHistoryValidationError, fetchBacktestHistoryRange, loadCryptoBacktestHistory } from "./backtest-history.ts";
import { intervalToMs, SUPPORTED_SPOT_SYMBOLS, type MarketCandle, type MarketDataRestAdapter, type SpotInterval, type SpotSymbol } from "../market-data/types.ts";

const HOUR = intervalToMs("1h");

function candle(symbol: SpotSymbol, interval: SpotInterval, openTimeMs: number): MarketCandle {
  const duration = intervalToMs(interval);
  return { symbol, interval, openTimeMs, closeTimeMs: openTimeMs + duration - 1, open: 100, high: 101,
    low: 99, close: 100, volume: 1, quoteVolume: 100, tradeCount: 1, isClosed: true, source: "rest" };
}

function adapter(overrides: Partial<MarketDataRestAdapter> = {}): MarketDataRestAdapter {
  return {
    getServerTime: async () => Date.UTC(2026, 9, 9, 12, 30),
    getSpotSymbols: async () => [],
    getSpotQuote: async () => ({ price: 100, tradeTimeMs: 1, serverTimeMs: 1 }),
    getCandles: async () => [],
    ...overrides,
  };
}

describe("backtest history loader", () => {
  it("crypto-ai-analysis.VALIDATION.4 paginates a range and excludes open or future candles", async () => {
    const calls: Array<{ start: number; limit: number }> = [];
    const startMs = Date.UTC(2026, 0, 1);
    const history = await fetchBacktestHistoryRange(adapter({
      getCandles: async ({ symbol, interval, startTimeMs, limit }) => {
        const start = startTimeMs!;
        calls.push({ start, limit: limit! });
        const rows = Array.from({ length: limit! }, (_, index) => candle(symbol, interval, start + index * intervalToMs(interval)));
        return [...rows, { ...candle(symbol, interval, start + limit! * intervalToMs(interval)), isClosed: false }];
      },
    }), "BTCUSDT", "1h", startMs, startMs + 10_003 * intervalToMs("1h") - 1);

    expect(calls.map((call) => call.limit)).toEqual([10_000, 3]);
    expect(calls[1]!.start).toBe(startMs + 10_000 * intervalToMs("1h"));
    expect(history).toHaveLength(10_003);
    expect(history.at(-1)!.closeTimeMs).toBe(startMs + 10_003 * intervalToMs("1h") - 1);
  });

  it("crypto-ai-analysis.MARKET_DATA.6 repairs an internal candle gap from REST", async () => {
    const startMs = Date.UTC(2026, 0, 1);
    const calls: Array<{ start: number; end: number }> = [];
    const history = await fetchBacktestHistoryRange(adapter({
      getCandles: async ({ startTimeMs, endTimeMs }) => {
        calls.push({ start: startTimeMs!, end: endTimeMs! });
        if (startTimeMs === startMs) return [candle("BTCUSDT", "1h", startMs), candle("BTCUSDT", "1h", startMs + 2 * HOUR)];
        return [candle("BTCUSDT", "1h", startTimeMs!)];
      },
    }), "BTCUSDT", "1h", startMs, startMs + 3 * HOUR - 1);

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ start: startMs + HOUR, end: startMs + HOUR });
    expect(history.map((item) => item.openTimeMs)).toEqual([startMs, startMs + HOUR, startMs + 2 * HOUR]);
  });

  it("crypto-ai-analysis.MARKET_DATA.6 backfills missing candles at the requested history tail", async () => {
    const startMs = Date.UTC(2026, 0, 1);
    const calls: number[] = [];
    const history = await fetchBacktestHistoryRange(adapter({
      getCandles: async ({ startTimeMs }) => {
        calls.push(startTimeMs!);
        return startTimeMs === startMs
          ? [candle("BTCUSDT", "1h", startMs)]
          : [candle("BTCUSDT", "1h", startMs + HOUR), candle("BTCUSDT", "1h", startMs + 2 * HOUR)];
      },
    }), "BTCUSDT", "1h", startMs, startMs + 3 * HOUR - 1);

    expect(calls).toEqual([startMs, startMs + HOUR]);
    expect(history.map((item) => item.openTimeMs)).toEqual([startMs, startMs + HOUR, startMs + 2 * HOUR]);
  });

  it("crypto-ai-analysis.MARKET_DATA.6 backfills missing candles at the requested history start", async () => {
    const startMs = Date.UTC(2026, 0, 1);
    const calls: Array<{ start: number; end: number }> = [];
    const history = await fetchBacktestHistoryRange(adapter({
      getCandles: async ({ startTimeMs, endTimeMs }) => {
        calls.push({ start: startTimeMs!, end: endTimeMs! });
        return endTimeMs === startMs + 2 * HOUR
          ? [candle("BTCUSDT", "1h", startMs + HOUR), candle("BTCUSDT", "1h", startMs + 2 * HOUR)]
          : [candle("BTCUSDT", "1h", startMs)];
      },
    }), "BTCUSDT", "1h", startMs, startMs + 3 * HOUR - 1);

    expect(calls).toEqual([
      { start: startMs, end: startMs + 2 * HOUR },
      { start: startMs, end: startMs },
    ]);
    expect(history.map((item) => item.openTimeMs)).toEqual([startMs, startMs + HOUR, startMs + 2 * HOUR]);
  });

  it("crypto-ai-analysis.VALIDATION.4 rejects a truncated requested history tail", async () => {
    const startMs = Date.UTC(2026, 0, 1);
    await expect(fetchBacktestHistoryRange(adapter({
      getCandles: async () => [candle("BTCUSDT", "1h", startMs)],
    }), "BTCUSDT", "1h", startMs, startMs + 3 * HOUR - 1)).rejects.toBeInstanceOf(BacktestHistoryValidationError);
  });

  it("crypto-ai-analysis.VALIDATION.1 crypto-ai-analysis.VALIDATION.4-1 loads all spot pairs with 250 daily warmup bars", async () => {
    const progress: number[] = [];
    const getCandles = vi.fn(async ({ symbol, interval, startTimeMs, endTimeMs, limit }: {
      symbol: SpotSymbol;
      interval: SpotInterval;
      startTimeMs?: number;
      endTimeMs?: number;
      limit?: number;
    }) => {
      const duration = intervalToMs(interval);
      const firstOpenTimeMs = Math.ceil(startTimeMs! / duration) * duration;
      const lastOpenTimeMs = Math.floor(endTimeMs! / duration) * duration;
      const count = Math.min(limit!, Math.floor((lastOpenTimeMs - firstOpenTimeMs) / duration) + 1);
      return Array.from({ length: count }, (_, index) => candle(symbol, interval, firstOpenTimeMs + index * duration));
    });
    const history = await loadCryptoBacktestHistory({
      adapter: adapter({ getCandles }),
      onProgress: (update) => progress.push(update.completed),
    });

    expect(history.assets.map((asset) => asset.symbol)).toEqual([...SUPPORTED_SPOT_SYMBOLS]);
    expect(getCandles.mock.calls.length).toBeGreaterThan(18);
    expect(progress).toEqual(Array.from({ length: 18 }, (_, index) => index + 1));
    expect(history.warmupStartMs).toBeLessThan(history.requestedPeriod.startMs - 250 * intervalToMs("1d"));
    expect(history.requestedPeriod.endMs % intervalToMs("1h")).toBe(intervalToMs("1h") - 1);
    expect(getCandles.mock.calls.some(([request]) => request.startTimeMs === history.warmupStartMs)).toBe(true);
    for (const asset of history.assets) {
      expect(asset.candles1h.length).toBeGreaterThan(250);
      expect(asset.candles4h.length).toBeGreaterThan(250);
      expect(asset.candles1d.length).toBeGreaterThan(250);
      expect(asset.candles1h[0]!.openTimeMs).toBe(history.warmupStartMs);
      expect(asset.candles4h[0]!.openTimeMs).toBe(history.warmupStartMs);
      expect(asset.candles1d[0]!.openTimeMs).toBe(history.warmupStartMs);
    }
  });

  it("crypto-ai-analysis.VALIDATION.4 rejects a non-advancing pagination cursor", async () => {
    const startMs = Date.UTC(2026, 0, 1);
    await expect(fetchBacktestHistoryRange(adapter({
      getCandles: async ({ symbol, interval, startTimeMs, limit }) =>
        Array.from({ length: limit! }, (_, index) => candle(symbol, interval, startTimeMs! - index * intervalToMs(interval))),
    }), "BTCUSDT", "1h", startMs, startMs + 10_000 * intervalToMs("1h"))).rejects.toThrow(/乱序|分页/);
  });
});
