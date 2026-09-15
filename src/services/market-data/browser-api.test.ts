import { describe, expect, it, vi } from "vitest";
import { createBrowserMarketDataApi } from "./browser-api.ts";
import type { MarketDataHealth, MarketDataRestAdapter } from "./types.ts";

describe("browser market-data API", () => {
  it("crypto-ai-analysis.MARKET_DATA.1-2 adapts canonical Binance candles to the existing chart contract", async () => {
    const restAdapter: MarketDataRestAdapter = {
      getServerTime: vi.fn().mockResolvedValue(1_710_003_600_000),
      getSpotSymbols: vi.fn().mockResolvedValue([]),
      getCandles: vi.fn().mockResolvedValue([
        {
          symbol: "BTCUSDT",
          interval: "1h",
          openTimeMs: 1_710_000_000_000,
          closeTimeMs: 1_710_003_599_999,
          open: 100,
          high: 110,
          low: 90,
          close: 105,
          volume: 12.5,
          quoteVolume: 1312.5,
          tradeCount: 42,
          isClosed: true,
          source: "rest",
        },
      ]),
    };
    const health: MarketDataHealth = {
      state: "live",
      serverTimeMs: 1_710_003_600_000,
      lastMessageAtMs: 1_710_003_599_500,
      lastClosedCandleAtMs: 1_710_003_599_999,
      missingRanges: [],
    };
    const api = createBrowserMarketDataApi({ restAdapter, getHealth: () => health });

    const result = await api.getCandlesWithMeta("btcusdt", "1h", 400);

    expect(restAdapter.getCandles).toHaveBeenCalledWith({
      symbol: "BTCUSDT",
      interval: "1h",
      limit: 400,
    });
    expect(result).toEqual({
      candles: [
        {
          time: 1_710_000_000,
          timestamp: 1_710_000_000_000,
          open: 100,
          high: 110,
          low: 90,
          close: 105,
          volume: 12.5,
          isClosed: true,
        },
      ],
      metadata: {
        historicalCoverageStart: 1_710_000_000_000,
        isPartial: false,
        backfillQueued: false,
      },
    });
  });

  it("crypto-ai-analysis.MARKET_DATA.6 repairs a detected historical gap with REST", async () => {
    const base = {
      symbol: "BTCUSDT" as const,
      interval: "1h" as const,
      openTimeMs: 1_710_000_000_000,
      closeTimeMs: 1_710_003_599_999,
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: 12.5,
      quoteVolume: 1312.5,
      tradeCount: 42,
      isClosed: true,
      source: "rest" as const,
    };
    const second = {
      ...base,
      openTimeMs: base.openTimeMs + 60 * 60 * 1_000,
      closeTimeMs: base.closeTimeMs + 60 * 60 * 1_000,
    };
    const third = {
      ...base,
      openTimeMs: base.openTimeMs + 2 * 60 * 60 * 1_000,
      closeTimeMs: base.closeTimeMs + 2 * 60 * 60 * 1_000,
    };
    const restAdapter: MarketDataRestAdapter = {
      getServerTime: vi.fn().mockResolvedValue(1_710_010_800_000),
      getSpotSymbols: vi.fn().mockResolvedValue([]),
      getCandles: vi.fn().mockResolvedValueOnce([base, third]).mockResolvedValueOnce([second]),
    };
    const api = createBrowserMarketDataApi({
      restAdapter,
      getHealth: () => ({
        state: "live",
        serverTimeMs: null,
        lastMessageAtMs: null,
        lastClosedCandleAtMs: null,
        missingRanges: [],
      }),
    });

    const result = await api.getCandlesWithMeta("BTCUSDT", "1h", 3);

    expect(restAdapter.getCandles).toHaveBeenLastCalledWith({
      symbol: "BTCUSDT",
      interval: "1h",
      startTimeMs: second.openTimeMs,
      endTimeMs: second.closeTimeMs,
      limit: 1,
    });
    expect(result.candles.map((candle) => candle.time)).toEqual([
      base.openTimeMs / 1_000,
      second.openTimeMs / 1_000,
      third.openTimeMs / 1_000,
    ]);
    expect(result.metadata.isPartial).toBe(false);
  });

  it("crypto-ai-analysis.MARKET_DATA.6 keeps available candles when a gap repair fails", async () => {
    const intervalMs = 60 * 60 * 1_000;
    const base = {
      symbol: "BTCUSDT" as const,
      interval: "1h" as const,
      openTimeMs: 1_710_000_000_000,
      closeTimeMs: 1_710_003_599_999,
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: 12.5,
      quoteVolume: 1312.5,
      tradeCount: 42,
      isClosed: true,
      source: "rest" as const,
    };
    const third = {
      ...base,
      openTimeMs: base.openTimeMs + 2 * intervalMs,
      closeTimeMs: base.closeTimeMs + 2 * intervalMs,
    };
    const restAdapter: MarketDataRestAdapter = {
      getServerTime: vi.fn().mockResolvedValue(1_710_010_800_000),
      getSpotSymbols: vi.fn().mockResolvedValue([]),
      getCandles: vi
        .fn()
        .mockResolvedValueOnce([base, third])
        .mockRejectedValueOnce(new Error("repair unavailable")),
    };
    const api = createBrowserMarketDataApi({
      restAdapter,
      getHealth: () => ({
        state: "live",
        serverTimeMs: null,
        lastMessageAtMs: null,
        lastClosedCandleAtMs: null,
        missingRanges: [],
      }),
    });

    const result = await api.getCandlesWithMeta("BTCUSDT", "1h", 3);

    expect(result.candles).toHaveLength(2);
    expect(result.metadata.isPartial).toBe(true);
  });
});
