import { binanceRestAdapter } from "../market-data/rest-adapter.ts";
import {
  SUPPORTED_SPOT_SYMBOLS,
  intervalToMs,
  type MarketCandle,
  type MarketDataRestAdapter,
  type SpotInterval,
  type SpotSymbol,
} from "../market-data/types.ts";
import { BACKTEST_WARMUP_DAILY_BARS, type BacktestAssetData, type BacktestPeriod } from "./backtest.ts";

const HOUR_MS = intervalToMs("1h");
const DAY_MS = intervalToMs("1d");
const MAX_CANDLES_PER_REQUEST = 10_000;
const INTERVALS: readonly SpotInterval[] = ["1h", "4h", "1d"];

export interface BacktestHistoryProgress {
  completed: number;
  total: number;
  symbol: SpotSymbol;
  interval: SpotInterval;
  loadedCandles: number;
}

export interface BacktestHistory {
  requestedPeriod: BacktestPeriod;
  warmupStartMs: number;
  assets: BacktestAssetData[];
}

export class BacktestHistoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacktestHistoryValidationError";
  }
}

interface MissingCandleRange {
  startMs: number;
  endMs: number;
}

function startThreeYearsBefore(endOpenTimeMs: number): number {
  const end = new Date(endOpenTimeMs);
  const year = end.getUTCFullYear() - 3;
  const month = end.getUTCMonth();
  const day = Math.min(end.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return Date.UTC(year, month, day, end.getUTCHours(), end.getUTCMinutes(), end.getUTCSeconds(), end.getUTCMilliseconds());
}

function lastClosedHourClose(serverTimeMs: number): number {
  const openTimeMs = Math.floor(serverTimeMs / HOUR_MS) * HOUR_MS - HOUR_MS;
  return openTimeMs + HOUR_MS - 1;
}

function findMissingRanges(candles: readonly MarketCandle[], duration: number): MissingCandleRange[] {
  const ranges: MissingCandleRange[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1]!;
    const current = candles[index]!;
    const distance = current.openTimeMs - previous.openTimeMs;
    if (distance % duration !== 0) throw new BacktestHistoryValidationError(`${current.symbol} ${current.interval} 历史行情时间边界无效`);
    const count = distance / duration - 1;
    if (count > 0) ranges.push({
      startMs: previous.openTimeMs + duration,
      endMs: current.openTimeMs - duration,
    });
  }
  return ranges;
}

async function backfillMissingCandles(
  adapter: MarketDataRestAdapter,
  symbol: SpotSymbol,
  interval: SpotInterval,
  candles: readonly MarketCandle[],
  expectedFirstOpenTimeMs: number,
  expectedLastOpenTimeMs: number,
): Promise<MarketCandle[]> {
  const duration = intervalToMs(interval);
  const merged = new Map(candles.map((candle) => [candle.openTimeMs, candle]));
  const firstCandle = candles[0];
  const ranges = firstCandle && firstCandle.openTimeMs > expectedFirstOpenTimeMs
    ? [{ startMs: expectedFirstOpenTimeMs, endMs: firstCandle.openTimeMs - duration }]
    : [];
  ranges.push(...findMissingRanges(candles, duration));
  const lastCandle = candles.at(-1);
  if (lastCandle && lastCandle.openTimeMs < expectedLastOpenTimeMs) {
    ranges.push({
      startMs: lastCandle.openTimeMs + duration,
      endMs: expectedLastOpenTimeMs,
    });
  } else if (!firstCandle) {
    ranges.push({ startMs: expectedFirstOpenTimeMs, endMs: expectedLastOpenTimeMs });
  }

  for (const range of ranges) {
    let cursor = range.startMs;
    while (cursor <= range.endMs) {
      const remaining = Math.floor((range.endMs - cursor) / duration) + 1;
      const limit = Math.min(MAX_CANDLES_PER_REQUEST, remaining);
      const endTimeMs = cursor + (limit - 1) * duration;
      const recovered = await adapter.getCandles({ symbol, interval, startTimeMs: cursor, endTimeMs, limit });
      for (const candle of recovered) {
        if (candle.symbol === symbol && candle.interval === interval && candle.isClosed &&
          candle.openTimeMs >= cursor && candle.openTimeMs <= endTimeMs && candle.closeTimeMs === candle.openTimeMs + duration - 1) {
          merged.set(candle.openTimeMs, candle);
        }
      }
      cursor = endTimeMs + duration;
    }
  }

  const result = [...merged.values()].sort((a, b) => a.openTimeMs - b.openTimeMs);
  if (findMissingRanges(result, duration).length > 0 || result[0]?.openTimeMs !== expectedFirstOpenTimeMs ||
    result.at(-1)?.openTimeMs !== expectedLastOpenTimeMs) {
    throw new BacktestHistoryValidationError(`${symbol} ${interval} 历史行情缺口经 REST 回填后仍未修复`);
  }
  return result;
}

// crypto-ai-analysis.VALIDATION.4 crypto-ai-analysis.VALIDATION.4-1
export async function fetchBacktestHistoryRange(
  adapter: MarketDataRestAdapter,
  symbol: SpotSymbol,
  interval: SpotInterval,
  startMs: number,
  endMs: number,
): Promise<MarketCandle[]> {
  const duration = intervalToMs(interval);
  let cursor = Math.ceil(startMs / duration) * duration;
  const firstOpenTimeMs = cursor;
  const lastOpenTimeMs = Math.floor((endMs + 1 - duration) / duration) * duration;
  const candles: MarketCandle[] = [];

  while (cursor <= lastOpenTimeMs) {
    const remaining = Math.floor((lastOpenTimeMs - cursor) / duration) + 1;
    const limit = Math.min(MAX_CANDLES_PER_REQUEST, remaining);
    const page = await adapter.getCandles({
      symbol,
      interval,
      startTimeMs: cursor,
      endTimeMs: lastOpenTimeMs,
      limit,
    });
    if (page.length === 0) break;

    for (let index = 1; index < page.length; index += 1) {
      if (page[index]!.openTimeMs <= page[index - 1]!.openTimeMs) {
        throw new BacktestHistoryValidationError(`${symbol} ${interval} 历史行情页存在重复或乱序`);
      }
    }

    const eligible = page
      .filter((candle) => candle.openTimeMs >= cursor && candle.closeTimeMs <= endMs && candle.isClosed);
    candles.push(...eligible);

    const lastEligible = eligible.at(-1);
    if (!lastEligible) break;
    const nextCursor = lastEligible.openTimeMs + duration;
    if (nextCursor <= cursor) throw new BacktestHistoryValidationError(`${symbol} ${interval} 历史行情分页重复`);
    cursor = nextCursor;
    if (page.length < limit) break;
  }

  // crypto-ai-analysis.MARKET_DATA.6
  const expectedLastOpenTimeMs = Math.floor((endMs + 1 - duration) / duration) * duration;
  return backfillMissingCandles(adapter, symbol, interval, candles, firstOpenTimeMs, expectedLastOpenTimeMs);
}

// crypto-ai-analysis.VALIDATION.1 crypto-ai-analysis.VALIDATION.2 crypto-ai-analysis.VALIDATION.4
// crypto-ai-analysis.VALIDATION.4-1
export async function loadCryptoBacktestHistory(
  options: {
    adapter?: MarketDataRestAdapter;
    onProgress?: (progress: BacktestHistoryProgress) => void;
  } = {},
): Promise<BacktestHistory> {
  const adapter = options.adapter ?? binanceRestAdapter;
  const serverTimeMs = await adapter.getServerTime();
  if (!Number.isFinite(serverTimeMs) || serverTimeMs <= 0) throw new BacktestHistoryValidationError("无法读取行情服务器时间");

  const endMs = lastClosedHourClose(serverTimeMs);
  const latestOpenTimeMs = endMs - HOUR_MS + 1;
  const startMs = startThreeYearsBefore(latestOpenTimeMs);
  const warmupStartMs = Math.floor(startMs / DAY_MS) * DAY_MS - BACKTEST_WARMUP_DAILY_BARS * DAY_MS;
  const requestedPeriod = { startMs, endMs };
  const total = SUPPORTED_SPOT_SYMBOLS.length * INTERVALS.length;
  const assets = new Map<SpotSymbol, Partial<Record<SpotInterval, MarketCandle[]>>>(
    SUPPORTED_SPOT_SYMBOLS.map((symbol) => [symbol, {}]),
  );
  let completed = 0;

  await Promise.all(SUPPORTED_SPOT_SYMBOLS.flatMap((symbol) => INTERVALS.map(async (interval) => {
    const candles = await fetchBacktestHistoryRange(adapter, symbol, interval, warmupStartMs, endMs);
    assets.get(symbol)![interval] = candles;
    completed += 1;
    options.onProgress?.({ completed, total, symbol, interval, loadedCandles: candles.length });
  })));

  return {
    requestedPeriod,
    warmupStartMs,
    assets: SUPPORTED_SPOT_SYMBOLS.map((symbol) => {
      const data = assets.get(symbol)!;
      return {
        symbol,
        candles1h: data["1h"] ?? [],
        candles4h: data["4h"] ?? [],
        candles1d: data["1d"] ?? [],
      };
    }),
  };
}
