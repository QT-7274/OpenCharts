import { describe, expect, it } from "vitest";
import { normalizeRestKline, normalizeWsKline } from "./binance.ts";
import {
  SUPPORTED_SPOT_INTERVALS,
  SUPPORTED_SPOT_SYMBOLS,
  toSpotInterval,
  toSpotSymbol,
} from "./types.ts";

describe("Binance market-data normalization", () => {
  it("crypto-ai-analysis.MARKET_DATA.2 defines the initial spot symbol and interval allowlists", () => {
    expect(SUPPORTED_SPOT_SYMBOLS).toEqual([
      "BTCUSDT",
      "ETHUSDT",
      "SOLUSDT",
      "BNBUSDT",
      "XRPUSDT",
      "ADAUSDT",
    ]);
    expect(SUPPORTED_SPOT_INTERVALS).toEqual(["1h", "4h", "1d"]);
    for (const symbol of SUPPORTED_SPOT_SYMBOLS) {
      for (const interval of SUPPORTED_SPOT_INTERVALS) {
        expect(toSpotSymbol(symbol.toLowerCase())).toBe(symbol);
        expect(toSpotInterval(interval)).toBe(interval);
        expect(
          normalizeWsKline({
            stream: `${symbol.toLowerCase()}@kline_${interval}`,
            data: {
              e: "kline",
              E: 1_710_003_599_500,
              s: symbol,
              k: {
                t: 1_710_000_000_000,
                T: 1_710_003_599_999,
                s: symbol,
                i: interval,
                o: "100",
                h: "110",
                l: "90",
                c: "105",
                v: "12.5",
                q: "1312.5",
                n: 42,
                x: false,
              },
            },
          }),
        ).toEqual(expect.objectContaining({ symbol, interval }));
      }
    }
  });

  it("crypto-ai-analysis.MARKET_DATA.3 crypto-ai-analysis.MARKET_DATA.3-1 crypto-ai-analysis.MARKET_DATA.3-2 normalizes REST and WS klines", () => {
    const rest = normalizeRestKline(
      [
        1_710_000_000_000,
        "100.00",
        "110.00",
        "90.00",
        "105.00",
        "12.50",
        1_710_003_599_999,
        "1312.50",
        42,
        "0",
        "0",
        "0",
      ],
      "BTCUSDT",
      "1h",
      1_710_003_600_000,
    );

    const websocket = normalizeWsKline({
      stream: "btcusdt@kline_1h",
      data: {
        e: "kline",
        E: 1_710_003_599_500,
        s: "BTCUSDT",
        k: {
          t: 1_710_000_000_000,
          T: 1_710_003_599_999,
          s: "BTCUSDT",
          i: "1h",
          o: "100.00",
          h: "110.00",
          l: "90.00",
          c: "105.00",
          v: "12.50",
          q: "1312.50",
          n: 42,
          x: true,
        },
      },
    });

    expect(rest).toEqual({
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
    });
    expect(websocket).toEqual({
      ...rest,
      source: "ws",
      eventTimeMs: 1_710_003_599_500,
    });
  });
});
