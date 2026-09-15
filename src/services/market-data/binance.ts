import {
  toSpotInterval,
  toSpotSymbol,
  type MarketCandle,
  type SpotInterval,
  type SpotSymbol,
} from "./types.ts";

export type BinanceRestKline = readonly [
  openTimeMs: number,
  open: string,
  high: string,
  low: string,
  close: string,
  volume: string,
  closeTimeMs: number,
  quoteVolume: string,
  tradeCount: number,
  takerBuyBaseVolume: string,
  takerBuyQuoteVolume: string,
  unused: string,
];

interface BinanceWsKline {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  q: string;
  n: number;
  x: boolean;
}

export interface BinanceWsKlineEnvelope {
  stream: string;
  data: {
    e: "kline";
    E: number;
    s: string;
    k: BinanceWsKline;
  };
}

function finiteNumber(value: number | string, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid Binance ${field}: ${String(value)}`);
  return parsed;
}

function canonicalCandle(input: {
  symbol: SpotSymbol;
  interval: SpotInterval;
  openTimeMs: number;
  closeTimeMs: number;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume: number | string;
  quoteVolume: number | string;
  tradeCount: number;
  isClosed: boolean;
  source: MarketCandle["source"];
  eventTimeMs?: number;
}): MarketCandle {
  return {
    symbol: input.symbol,
    interval: input.interval,
    openTimeMs: finiteNumber(input.openTimeMs, "open time"),
    closeTimeMs: finiteNumber(input.closeTimeMs, "close time"),
    open: finiteNumber(input.open, "open"),
    high: finiteNumber(input.high, "high"),
    low: finiteNumber(input.low, "low"),
    close: finiteNumber(input.close, "close"),
    volume: finiteNumber(input.volume, "volume"),
    quoteVolume: finiteNumber(input.quoteVolume, "quote volume"),
    tradeCount: finiteNumber(input.tradeCount, "trade count"),
    isClosed: input.isClosed,
    source: input.source,
    ...(input.eventTimeMs == null
      ? {}
      : { eventTimeMs: finiteNumber(input.eventTimeMs, "event time") }),
  };
}

// crypto-ai-analysis.MARKET_DATA.3
export function normalizeRestKline(
  row: BinanceRestKline,
  symbol: string,
  interval: string,
  serverTimeMs: number,
): MarketCandle {
  return canonicalCandle({
    symbol: toSpotSymbol(symbol),
    interval: toSpotInterval(interval),
    openTimeMs: row[0],
    closeTimeMs: row[6],
    open: row[1],
    high: row[2],
    low: row[3],
    close: row[4],
    volume: row[5],
    quoteVolume: row[7],
    tradeCount: row[8],
    isClosed: row[6] < serverTimeMs,
    source: "rest",
  });
}

// crypto-ai-analysis.MARKET_DATA.3 crypto-ai-analysis.CANDLE_QUALITY.2
export function normalizeWsKline(message: BinanceWsKlineEnvelope): MarketCandle {
  const kline = message.data.k;
  return canonicalCandle({
    symbol: toSpotSymbol(kline.s),
    interval: toSpotInterval(kline.i),
    openTimeMs: kline.t,
    closeTimeMs: kline.T,
    open: kline.o,
    high: kline.h,
    low: kline.l,
    close: kline.c,
    volume: kline.v,
    quoteVolume: kline.q,
    tradeCount: kline.n,
    isClosed: kline.x,
    source: "ws",
    eventTimeMs: message.data.E,
  });
}
