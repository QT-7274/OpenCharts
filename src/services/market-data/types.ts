export const SUPPORTED_SPOT_SYMBOLS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "ADAUSDT",
] as const;

export const SUPPORTED_SPOT_INTERVALS = ["1h", "4h", "1d"] as const;

export type SpotSymbol = (typeof SUPPORTED_SPOT_SYMBOLS)[number];
export type SpotInterval = (typeof SUPPORTED_SPOT_INTERVALS)[number];

export interface MarketCandle {
  symbol: SpotSymbol;
  interval: SpotInterval;
  openTimeMs: number;
  closeTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  tradeCount: number;
  isClosed: boolean;
  source: "rest" | "ws";
  eventTimeMs?: number;
}

export interface MissingCandleRange {
  symbol: SpotSymbol;
  interval: SpotInterval;
  fromMs: number;
  toMs: number;
}

export interface MarketDataHealth {
  state: "connecting" | "live" | "degraded" | "disconnected";
  serverTimeMs: number | null;
  lastMessageAtMs: number | null;
  lastClosedCandleAtMs: number | null;
  missingRanges: MissingCandleRange[];
}

export interface CandleRequest {
  symbol: SpotSymbol;
  interval: SpotInterval;
  startTimeMs?: number;
  endTimeMs?: number;
  limit?: number;
}

export interface SpotSymbolMetadata {
  symbol: SpotSymbol;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: number;
  stepSize: number;
}

export interface MarketDataRestAdapter {
  getServerTime(): Promise<number>;
  getSpotSymbols(): Promise<SpotSymbolMetadata[]>;
  getCandles(input: CandleRequest): Promise<MarketCandle[]>;
}

export function isSpotSymbol(value: string): value is SpotSymbol {
  return (SUPPORTED_SPOT_SYMBOLS as readonly string[]).includes(value);
}

export function isSpotInterval(value: string): value is SpotInterval {
  return (SUPPORTED_SPOT_INTERVALS as readonly string[]).includes(value);
}

export function toSpotSymbol(value: string): SpotSymbol {
  const normalized = value.toUpperCase();
  if (!isSpotSymbol(normalized)) throw new Error(`Unsupported spot symbol: ${value}`);
  return normalized;
}

export function toSpotInterval(value: string): SpotInterval {
  if (!isSpotInterval(value)) throw new Error(`Unsupported spot interval: ${value}`);
  return value;
}

export function intervalToMs(interval: SpotInterval): number {
  if (interval === "1h") return 60 * 60 * 1_000;
  if (interval === "4h") return 4 * 60 * 60 * 1_000;
  return 24 * 60 * 60 * 1_000;
}
