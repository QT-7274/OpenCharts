import type { CandlestickData, HistogramData, Time } from "lightweight-charts";
import type { CandleData } from "../../lib/indicators.ts";
import type { Candle } from "../../services/schemas.ts";

type CandleRow = CandlestickData<Time> & {
  volume: number;
  isClosed?: boolean;
};

function secOrMsToMs(value: number): number {
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function candleTimeSec(candle: Candle): number {
  let timeMs = NaN;
  if (typeof candle.time === "number" && candle.time > 0) timeMs = secOrMsToMs(candle.time);
  else if (typeof candle.timestamp === "number" && candle.timestamp > 0) {
    timeMs = secOrMsToMs(candle.timestamp);
  } else if (typeof candle.timestamp === "string") {
    timeMs = Date.parse(candle.timestamp);
  }
  return Number.isNaN(timeMs) ? NaN : Math.floor(timeMs / 1_000);
}

function toCandleRow(candle: Candle): CandleRow {
  return {
    time: candleTimeSec(candle) as Time,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume) || 0,
    isClosed: candle.isClosed,
  };
}

function dedupeByTime(sorted: CandleRow[]): CandleRow[] {
  const byTime = new Map<number, CandleRow>();
  for (const candle of sorted) {
    const time = candle.time as number;
    const existing = byTime.get(time);
    if (!existing || candle.isClosed === true || existing.isClosed !== true) {
      byTime.set(time, candle);
    }
  }
  return [...byTime.values()];
}

export interface ChartSeriesData {
  chartData: CandlestickData<Time>[];
  volumeData: HistogramData<Time>[];
  indicatorData: CandleData[];
}

// crypto-ai-analysis.CANDLE_QUALITY.2
export function buildChartSeriesData(
  candles: Candle[],
  colors: { volumeUp: string; volumeDown: string },
): ChartSeriesData {
  const sorted = candles
    .map(toCandleRow)
    .filter((candle) => !Number.isNaN(candle.time as number) && (candle.time as number) > 0)
    .sort((left, right) => (left.time as number) - (right.time as number));
  const deduped = dedupeByTime(sorted);
  const toChartCandle = ({ volume: _volume, isClosed: _isClosed, ...candle }: CandleRow) => candle;

  return {
    chartData: deduped.map(toChartCandle),
    volumeData: deduped.map((candle) => ({
      time: candle.time,
      value: candle.volume,
      color: candle.close >= candle.open ? colors.volumeUp : colors.volumeDown,
    })),
    indicatorData: deduped
      .filter((candle) => candle.isClosed !== false)
      .map((candle) => ({
        time: candle.time as number,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      })),
  };
}
