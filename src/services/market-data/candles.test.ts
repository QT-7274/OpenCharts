import { describe, expect, it } from "vitest";
import { findCandleGaps, mergeCandles } from "./candles.ts";
import type { MarketCandle } from "./types.ts";

function candle(overrides: Partial<MarketCandle> = {}): MarketCandle {
  return {
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
    isClosed: false,
    source: "ws",
    ...overrides,
  };
}

describe("canonical candle collection", () => {
  it("crypto-ai-analysis.MARKET_DATA.5 deduplicates candles and preserves the closed version", () => {
    const partial = candle({ close: 104, tradeCount: 40 });
    const closed = candle({ close: 105, tradeCount: 42, isClosed: true });
    const stalePartial = candle({ close: 103, tradeCount: 39 });

    expect(mergeCandles([partial], [closed], [stalePartial])).toEqual([closed]);
  });

  it("crypto-ai-analysis.MARKET_DATA.6 reports missing closed intervals without fabricating candles", () => {
    const first = candle({ isClosed: true });
    const third = candle({
      openTimeMs: first.openTimeMs + 2 * 60 * 60 * 1_000,
      closeTimeMs: first.closeTimeMs + 2 * 60 * 60 * 1_000,
      isClosed: true,
    });

    expect(findCandleGaps([first, third], "1h")).toEqual([
      {
        symbol: "BTCUSDT",
        interval: "1h",
        fromMs: first.openTimeMs + 60 * 60 * 1_000,
        toMs: first.openTimeMs + 60 * 60 * 1_000,
      },
    ]);
  });
});
