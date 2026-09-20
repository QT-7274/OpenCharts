import { findCandleGaps } from "../market-data/candles.ts";
import { intervalToMs, type MarketCandle, type SpotInterval, type SpotSymbol } from "../market-data/types.ts";

export type AnalysisIssueCode = "invalid-candle" | "conflict" | "gap" | "warmup" | "stale" | "unavailable";

export interface AnalysisIssue {
  interval: SpotInterval;
  code: AnalysisIssueCode;
  fromMs?: number;
  toMs?: number;
  atMs?: number;
}

export interface InspectedWindow {
  candles: MarketCandle[];
  latestCloseTimeMs: number | null;
  issues: AnalysisIssue[];
}

function validCandle(candle: MarketCandle, symbol: SpotSymbol, interval: SpotInterval): boolean {
  const ms = intervalToMs(interval);
  const numbers = [candle.openTimeMs, candle.closeTimeMs, candle.open, candle.high, candle.low,
    candle.close, candle.volume, candle.quoteVolume, candle.tradeCount];
  return candle.symbol === symbol && candle.interval === interval &&
    numbers.every(Number.isFinite) &&
    candle.openTimeMs % ms === 0 && candle.closeTimeMs === candle.openTimeMs + ms - 1 &&
    candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0 &&
    candle.high >= Math.max(candle.open, candle.close) &&
    candle.low <= Math.min(candle.open, candle.close) && candle.high >= candle.low &&
    candle.volume >= 0 && candle.quoteVolume >= 0 &&
    Number.isInteger(candle.tradeCount) && candle.tradeCount >= 0;
}

function sameValues(a: MarketCandle, b: MarketCandle): boolean {
  return a.closeTimeMs === b.closeTimeMs && a.open === b.open && a.high === b.high &&
    a.low === b.low && a.close === b.close && a.volume === b.volume &&
    a.quoteVolume === b.quoteVolume && a.tradeCount === b.tradeCount;
}

// crypto-ai-analysis.CANDLE_QUALITY.2 crypto-ai-analysis.CANDLE_QUALITY.3 crypto-ai-analysis.CANDLE_QUALITY.4
export function inspectWindow(
  symbol: SpotSymbol,
  interval: SpotInterval,
  analysisTimeMs: number,
  rawCandles: readonly MarketCandle[],
  minimumCandles: number,
): InspectedWindow {
  const issues: AnalysisIssue[] = [];
  const byOpenTime = new Map<number, MarketCandle>();
  for (const row of rawCandles) {
    if (!row.isClosed || row.closeTimeMs > analysisTimeMs) continue;
    if (!validCandle(row, symbol, interval)) {
      issues.push({ interval, code: "invalid-candle", atMs: Number.isFinite(row.openTimeMs) ? row.openTimeMs : undefined });
      continue;
    }
    const previous = byOpenTime.get(row.openTimeMs);
    if (previous && !sameValues(previous, row)) {
      issues.push({ interval, code: "conflict", atMs: row.openTimeMs });
    } else if (!previous) {
      byOpenTime.set(row.openTimeMs, row);
    }
  }

  const candles = [...byOpenTime.values()].sort((a, b) => a.openTimeMs - b.openTimeMs);
  for (const gap of findCandleGaps(candles, interval)) {
    issues.push({ interval, code: "gap", fromMs: gap.fromMs, toMs: gap.toMs });
  }
  if (candles.length < minimumCandles) issues.push({ interval, code: "warmup" });
  const latestCloseTimeMs = candles.at(-1)?.closeTimeMs ?? null;
  const ms = intervalToMs(interval);
  const expectedCloseTimeMs = Math.floor((analysisTimeMs + 1) / ms) * ms - 1;
  if (latestCloseTimeMs == null || expectedCloseTimeMs - latestCloseTimeMs > ms) {
    issues.push({ interval, code: "stale", atMs: latestCloseTimeMs ?? undefined });
  }
  return { candles, latestCloseTimeMs, issues };
}
