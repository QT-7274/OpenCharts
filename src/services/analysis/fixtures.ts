import type { MarketCandle, SpotInterval } from "../market-data/types.ts";

export const BASE = 1_728_000_000_000;
export const MS = { "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 } as const;

export function candle(interval: SpotInterval, index: number, overrides: Partial<MarketCandle> = {}): MarketCandle {
  const openTimeMs = BASE + index * MS[interval];
  return {
    symbol: "BTCUSDT",
    interval,
    openTimeMs,
    closeTimeMs: openTimeMs + MS[interval] - 1,
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 10,
    quoteVolume: 1_050,
    tradeCount: 3,
    isClosed: true,
    source: "rest",
    ...overrides,
  };
}
