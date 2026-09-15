import { describe, expect, it } from "vitest";
import type { Candle } from "../../services/schemas.ts";
import { buildChartSeriesData } from "./chart-data.ts";

function candle(time: number, close: number, isClosed: boolean): Candle {
  return {
    time,
    timestamp: time * 1_000,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 10,
    isClosed,
  };
}

describe("chart market-data boundary", () => {
  it("crypto-ai-analysis.CANDLE_QUALITY.2 displays partial candles but excludes them from indicators", () => {
    const closed = candle(1_710_000_000, 105, true);
    const stalePartial = candle(1_710_000_000, 99, false);
    const currentPartial = candle(1_710_003_600, 110, false);

    const result = buildChartSeriesData([closed, stalePartial, currentPartial], {
      volumeUp: "green",
      volumeDown: "red",
    });

    expect(result.chartData).toHaveLength(2);
    expect(result.chartData[0]).toEqual(expect.objectContaining({ close: 105 }));
    expect(result.indicatorData).toEqual([expect.objectContaining({ close: 105 })]);
  });
});
