import { intervalToMs, type MarketCandle, type MissingCandleRange, type SpotInterval } from "./types.ts";

export function candleKey(candle: Pick<MarketCandle, "symbol" | "interval" | "openTimeMs">): string {
  return `${candle.symbol}:${candle.interval}:${candle.openTimeMs}`;
}

// crypto-ai-analysis.MARKET_DATA.5
export function mergeCandles(...groups: readonly MarketCandle[][]): MarketCandle[] {
  const merged = new Map<string, MarketCandle>();

  for (const group of groups) {
    for (const candle of group) {
      const key = candleKey(candle);
      const existing = merged.get(key);
      if (existing?.isClosed && !candle.isClosed) continue;
      merged.set(key, candle);
    }
  }

  return [...merged.values()].sort((a, b) => a.openTimeMs - b.openTimeMs);
}

export function findCandleGaps(
  candles: readonly MarketCandle[],
  interval: SpotInterval,
): MissingCandleRange[] {
  const closed = candles
    .filter((candle) => candle.interval === interval && candle.isClosed)
    .sort((a, b) => a.openTimeMs - b.openTimeMs);
  const intervalMs = intervalToMs(interval);
  const gaps: MissingCandleRange[] = [];

  for (let index = 1; index < closed.length; index += 1) {
    const previous = closed[index - 1]!;
    const current = closed[index]!;
    const expectedOpenTimeMs = previous.openTimeMs + intervalMs;
    if (current.openTimeMs <= expectedOpenTimeMs) continue;
    gaps.push({
      symbol: current.symbol,
      interval,
      fromMs: expectedOpenTimeMs,
      toMs: current.openTimeMs - intervalMs,
    });
  }

  return gaps;
}
