import type {
  MarketDataCandle,
  MarketDataCandlesPayload,
  MarketDataTick,
} from "../api/market-data.ts";
import type { Symbol } from "../schemas.ts";
import { findCandleGaps, mergeCandles } from "./candles.ts";
import {
  SUPPORTED_SPOT_SYMBOLS,
  intervalToMs,
  toSpotInterval,
  toSpotSymbol,
  type MarketCandle,
  type MarketDataHealth,
  type MarketDataRestAdapter,
  type SpotSymbol,
  type SpotSymbolMetadata,
} from "./types.ts";

interface BrowserMarketDataApiOptions {
  restAdapter: MarketDataRestAdapter;
  getHealth: () => MarketDataHealth;
  now?: () => number;
}

const DISPLAY_NAMES: Record<SpotSymbol, string> = {
  BTCUSDT: "Bitcoin / Tether",
  ETHUSDT: "Ethereum / Tether",
  SOLUSDT: "Solana / Tether",
  BNBUSDT: "BNB / Tether",
  XRPUSDT: "XRP / Tether",
  ADAUSDT: "Cardano / Tether",
};

function toChartCandle(candle: MarketCandle): MarketDataCandle {
  return {
    time: Math.floor(candle.openTimeMs / 1_000),
    timestamp: candle.openTimeMs,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    isClosed: candle.isClosed,
  };
}

function toInstrument(metadata: SpotSymbolMetadata): Symbol {
  return {
    id: metadata.symbol,
    name: metadata.symbol,
    displayName: DISPLAY_NAMES[metadata.symbol],
    category: "CRYPTO",
    contractSize: 1,
    tickSize: metadata.tickSize,
    tickValue: metadata.tickSize,
    marginPercent: 100,
    maxLeverage: 1,
    commission: 0.001,
    swapLong: 0,
    swapShort: 0,
    tradingHoursStart: null,
    tradingHoursEnd: null,
    isActive: metadata.status === "TRADING",
  };
}

// crypto-ai-analysis.MARKET_DATA.1-2 crypto-ai-analysis.DATA_BOUNDARY.1
export function createBrowserMarketDataApi(options: BrowserMarketDataApiOptions) {
  const now = options.now ?? Date.now;

  async function loadCandles(
    symbolValue: string,
    intervalValue: string,
    limit?: number,
    range?: { fromMs: number; toMs: number },
  ): Promise<MarketDataCandlesPayload> {
    const symbol = toSpotSymbol(symbolValue);
    const interval = toSpotInterval(intervalValue);
    let canonical = await options.restAdapter.getCandles({
      symbol,
      interval,
      ...(range ? { startTimeMs: range.fromMs, endTimeMs: range.toMs } : {}),
      ...(limit != null ? { limit } : {}),
    });
    const initialGaps = findCandleGaps(canonical, interval);
    if (initialGaps.length > 0) {
      const intervalMs = intervalToMs(interval);
      const repairs = await Promise.allSettled(
        initialGaps.map((gap) =>
          options.restAdapter.getCandles({
            symbol,
            interval,
            startTimeMs: gap.fromMs,
            endTimeMs: gap.toMs + intervalMs - 1,
            limit: Math.min(10_000, Math.floor((gap.toMs - gap.fromMs) / intervalMs) + 1),
          }),
        ),
      );
      canonical = mergeCandles(
        canonical,
        ...repairs.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
      );
    }
    const remainingGaps = findCandleGaps(canonical, interval);
    return {
      candles: canonical.map(toChartCandle),
      metadata: {
        historicalCoverageStart: canonical[0]?.openTimeMs ?? null,
        isPartial: remainingGaps.length > 0,
        backfillQueued: false,
      },
    };
  }

  return {
    getSymbols: async (): Promise<Symbol[]> => {
      const metadata = await options.restAdapter.getSpotSymbols();
      const bySymbol = new Map(metadata.map((item) => [item.symbol, item]));
      return SUPPORTED_SPOT_SYMBOLS.flatMap((symbol) => {
        const item = bySymbol.get(symbol);
        return item ? [toInstrument(item)] : [];
      });
    },
    getCandles: async (
      symbol: string,
      timeframe: string,
      limit?: number,
      range?: { fromMs: number; toMs: number },
    ): Promise<MarketDataCandle[]> =>
      (await loadCandles(symbol, timeframe, limit, range)).candles,
    getCandlesWithMeta: async (
      symbol: string,
      timeframe: string,
      limit?: number,
      range?: { fromMs: number; toMs: number },
    ): Promise<MarketDataCandlesPayload> => loadCandles(symbol, timeframe, limit, range),
    getTick: async (symbolValue: string): Promise<MarketDataTick> => {
      const symbol = toSpotSymbol(symbolValue);
      const candles = await options.restAdapter.getCandles({ symbol, interval: "1h", limit: 1 });
      const latest = candles.at(-1);
      if (!latest) throw new Error(`No Binance market data for ${symbol}`);
      return { symbol, bid: latest.close, ask: latest.close, timestamp: now() };
    },
    getMarketDataHealth: async () => {
      const health = options.getHealth();
      const lastTickAgeMs = health.lastMessageAtMs == null ? -1 : now() - health.lastMessageAtMs;
      const staleCount = lastTickAgeMs < 0 || lastTickAgeMs > 30_000 ? SUPPORTED_SPOT_SYMBOLS.length : 0;
      return {
        ...health,
        adapter: {
          status: health.state,
          reason:
            health.state === "degraded" && health.missingRanges.length > 0
              ? "REST recovery could not fill every closed-candle gap"
              : undefined,
        },
        staleCount,
        totalSymbols: SUPPORTED_SPOT_SYMBOLS.length,
        lastTickAgeMs,
      };
    },
  };
}
