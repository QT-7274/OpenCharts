import { normalizeRestKline, type BinanceRestKline } from "./binance.ts";
import {
  SUPPORTED_SPOT_SYMBOLS,
  intervalToMs,
  toSpotInterval,
  toSpotSymbol,
  type CandleRequest,
  type MarketCandle,
  type MarketDataRestAdapter,
  type SpotSymbolMetadata,
} from "./types.ts";

export const DEFAULT_BINANCE_REST_BASE_URL = "https://data-api.binance.vision/api/v3";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface BinanceExchangeFilter {
  filterType: string;
  tickSize?: string;
  stepSize?: string;
}

interface BinanceExchangeSymbol {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  isSpotTradingAllowed?: boolean;
  permissions?: string[];
  filters: BinanceExchangeFilter[];
}

interface BinanceExchangeInfo {
  symbols: BinanceExchangeSymbol[];
}

interface BinanceRestAdapterOptions {
  baseUrl?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  maxConcurrent?: number;
  maxRetries?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function configuredBaseUrl(): string {
  return trimTrailingSlash(
    import.meta.env.VITE_BINANCE_REST_BASE_URL || DEFAULT_BINANCE_REST_BASE_URL,
  );
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  }
  return Math.min(30_000, 500 * 2 ** attempt);
}

function readFilterNumber(
  filters: BinanceExchangeFilter[],
  filterType: string,
  field: "tickSize" | "stepSize",
): number {
  const value = filters.find((filter) => filter.filterType === filterType)?.[field];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createConcurrencyGate(maxConcurrent: number) {
  let active = 0;
  const waiters: Array<() => void> = [];

  return async function withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiters.shift()?.();
    }
  };
}

// crypto-ai-analysis.MARKET_DATA.1-2 crypto-ai-analysis.DATA_BOUNDARY.2
export function createBinanceRestAdapter(
  options: BinanceRestAdapterOptions = {},
): MarketDataRestAdapter {
  const baseUrl = trimTrailingSlash(options.baseUrl ?? configuredBaseUrl());
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxRetries = options.maxRetries ?? 2;
  const sleep = options.sleep ?? defaultSleep;
  const withSlot = createConcurrencyGate(options.maxConcurrent ?? 4);
  let serverTimeCache: { value: number; fetchedAtMs: number } | null = null;
  let serverTimeRequest: Promise<number> | null = null;

  async function requestJson<T>(path: string, params?: URLSearchParams): Promise<T> {
    const url = `${baseUrl}${path}${params && params.size > 0 ? `?${params.toString()}` : ""}`;

    return withSlot(async () => {
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        let response: Response;
        try {
          response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
        } catch (error) {
          if (attempt === maxRetries) throw error;
          await sleep(Math.min(30_000, 500 * 2 ** attempt));
          continue;
        }
        if (response.ok) return (await response.json()) as T;

        const retryable = response.status === 429 || response.status === 418 || response.status >= 500;
        if (!retryable || attempt === maxRetries) {
          throw new Error(`Binance market-data request failed (${response.status})`);
        }
        await sleep(retryDelayMs(response, attempt));
      }
      throw new Error("Binance market-data request failed");
    });
  }

  async function getServerTime(): Promise<number> {
    const nowMs = Date.now();
    if (serverTimeCache && nowMs - serverTimeCache.fetchedAtMs < 1_000) {
      return serverTimeCache.value;
    }
    if (serverTimeRequest) return serverTimeRequest;

    serverTimeRequest = requestJson<{ serverTime: number }>("/time")
      .then((result) => {
        if (!Number.isFinite(result.serverTime)) throw new Error("Invalid Binance server time");
        serverTimeCache = { value: result.serverTime, fetchedAtMs: Date.now() };
        return result.serverTime;
      })
      .finally(() => {
        serverTimeRequest = null;
      });
    return serverTimeRequest;
  }

  async function fetchKlinePage(
    request: CandleRequest,
    pageLimit: number,
    serverTimeMs: number,
  ): Promise<MarketCandle[]> {
    const params = new URLSearchParams();
    params.set("symbol", request.symbol);
    params.set("interval", request.interval);
    if (request.startTimeMs != null) params.set("startTime", String(request.startTimeMs));
    if (request.endTimeMs != null) params.set("endTime", String(request.endTimeMs));
    params.set("limit", String(pageLimit));
    const rows = await requestJson<BinanceRestKline[]>("/klines", params);
    return rows.map((row) => normalizeRestKline(row, request.symbol, request.interval, serverTimeMs));
  }

  async function getCandles(input: CandleRequest): Promise<MarketCandle[]> {
    const symbol = toSpotSymbol(input.symbol);
    const interval = toSpotInterval(input.interval);
    const desired = Math.max(1, Math.min(input.limit ?? 1_000, 10_000));
    const serverTimeMs = await getServerTime();
    const candles: MarketCandle[] = [];

    if (input.startTimeMs != null) {
      let cursor = input.startTimeMs;
      while (candles.length < desired && cursor <= (input.endTimeMs ?? serverTimeMs)) {
        const pageLimit = Math.min(1_000, desired - candles.length);
        const page = await fetchKlinePage(
          { symbol, interval, startTimeMs: cursor, endTimeMs: input.endTimeMs },
          pageLimit,
          serverTimeMs,
        );
        candles.push(...page);
        if (page.length < pageLimit) break;
        cursor = page.at(-1)!.openTimeMs + intervalToMs(interval);
      }
      return candles.slice(0, desired);
    }

    let cursorEnd = input.endTimeMs ?? serverTimeMs;
    while (candles.length < desired) {
      const pageLimit = Math.min(1_000, desired - candles.length);
      const page = await fetchKlinePage(
        { symbol, interval, endTimeMs: cursorEnd },
        pageLimit,
        serverTimeMs,
      );
      candles.unshift(...page);
      if (page.length < pageLimit) break;
      cursorEnd = page[0]!.openTimeMs - 1;
    }
    return candles.slice(-desired);
  }

  async function getSpotSymbols(): Promise<SpotSymbolMetadata[]> {
    const params = new URLSearchParams();
    params.set("symbols", JSON.stringify(SUPPORTED_SPOT_SYMBOLS));
    const info = await requestJson<BinanceExchangeInfo>("/exchangeInfo", params);
    const allowed = new Set<string>(SUPPORTED_SPOT_SYMBOLS);

    return info.symbols
      .filter(
        (symbol) =>
          allowed.has(symbol.symbol) &&
          symbol.status === "TRADING" &&
          (symbol.isSpotTradingAllowed === true || symbol.permissions?.includes("SPOT") === true),
      )
      .map((symbol) => ({
        symbol: toSpotSymbol(symbol.symbol),
        status: symbol.status,
        baseAsset: symbol.baseAsset,
        quoteAsset: symbol.quoteAsset,
        tickSize: readFilterNumber(symbol.filters, "PRICE_FILTER", "tickSize"),
        stepSize: readFilterNumber(symbol.filters, "LOT_SIZE", "stepSize"),
      }));
  }

  return { getServerTime, getSpotSymbols, getCandles };
}

export const binanceRestAdapter = createBinanceRestAdapter();
