import { describe, expect, it, vi } from "vitest";
import { createAnalysisPipeline } from "./pipeline.ts";
import { BASE, MS, candle } from "./fixtures.ts";
import type { MarketDataRestAdapter, SpotInterval } from "../market-data/types.ts";

const INTERVALS: SpotInterval[] = ["1d", "4h", "1h"];
const COUNTS = { "1d": 2, "4h": 2, "1h": 2 };
const AT = BASE + 2 * MS["1d"] - 1;

function adapter(overrides: Partial<MarketDataRestAdapter> = {}): MarketDataRestAdapter {
  return {
    getServerTime: vi.fn().mockResolvedValue(AT),
    getSpotSymbols: vi.fn().mockResolvedValue([]),
    getCandles: vi.fn().mockImplementation(async ({ interval, startTimeMs }: { interval: SpotInterval; startTimeMs?: number }) => {
      if (startTimeMs != null) return [candle(interval, (startTimeMs - BASE) / MS[interval])];
      const end = Math.floor((AT + 1 - BASE) / MS[interval]) - 1;
      return [candle(interval, end - 1), candle(interval, end)];
    }),
    ...overrides,
  };
}

function makePipeline(rest: MarketDataRestAdapter) {
  return createAnalysisPipeline({
    restAdapter: rest,
    getHealth: () => ({ state: "live", serverTimeMs: AT, lastMessageAtMs: AT, lastClosedCandleAtMs: AT, missingRanges: [] }),
    minimumCandles: COUNTS,
  });
}

describe("analysis trigger and as-of pipeline", () => {
  it("crypto-ai-analysis.CANDLE_QUALITY.1 crypto-ai-analysis.CANDLE_QUALITY.3-1 crypto-ai-analysis.CANDLE_QUALITY.3-2 records manual Binance server time and actual close times", async () => {
    const pipeline = makePipeline(adapter());
    const result = await pipeline.runManual("BTCUSDT");
    expect(result.trigger).toBe("manual");
    expect(result.analysisTimeMs).toBe(AT);
    expect(result.candleCloseTimes).toEqual({
      "1d": candle("1d", 1).closeTimeMs,
      "4h": candle("4h", 11).closeTimeMs,
      "1h": candle("1h", 47).closeTimeMs,
    });
    expect(result.status).toBe("ready");
    expect(result.signal).toBeNull();
    expect(result.entryPlan).toBeNull();
    expect(INTERVALS.every((interval) => result.windows[interval].every((row) => row.isClosed && row.closeTimeMs <= AT))).toBe(true);
  });

  it("crypto-ai-analysis.CANDLE_QUALITY.1-1 auto trigger reuses one attempt even for concurrent duplicate 1h close events", async () => {
    const rest = adapter();
    const pipeline = makePipeline(rest);
    const event = candle("1h", 47);
    const [first, duplicate] = await Promise.all([pipeline.onHourlyClose(event), pipeline.onHourlyClose(event)]);
    expect(first).toBe(duplicate);
    expect(first?.trigger).toBe("hourly-close");
    expect(first?.analysisTimeMs).toBe(event.closeTimeMs);
    expect(await pipeline.onHourlyClose(event)).toBe(first);
    expect(rest.getCandles).toHaveBeenCalledTimes(3);
    expect(await pipeline.onHourlyClose({ ...event, isClosed: false })).toBeNull();
    expect(await pipeline.onHourlyClose({ ...event, closeTimeMs: event.closeTimeMs + 1 })).toBeNull();
  });

  it("crypto-ai-analysis.CANDLE_QUALITY.3 crypto-ai-analysis.CANDLE_QUALITY.4 repairs missing intervals before returning ready", async () => {
    const rest = adapter({
      getCandles: vi.fn().mockImplementation(async ({ interval, startTimeMs }: { interval: SpotInterval; startTimeMs?: number }) => {
        const end = Math.floor((AT + 1 - BASE) / MS[interval]) - 1;
        if (interval !== "1h") return [candle(interval, end - 1), candle(interval, end)];
        if (startTimeMs != null) return [candle("1h", end - 1)];
        return [candle("1h", end - 2), candle("1h", end)];
      }),
    });
    const result = await makePipeline(rest).runManual("BTCUSDT");
    expect(result.status).toBe("ready");
    expect(result.windows["1h"].map((row) => row.openTimeMs)).toEqual([
      candle("1h", 45).openTimeMs, candle("1h", 46).openTimeMs, candle("1h", 47).openTimeMs,
    ]);
  });

  it("crypto-ai-analysis.CANDLE_QUALITY.5 crypto-ai-analysis.CANDLE_QUALITY.5-1 records insufficient-data without a signal on repair failure", async () => {
    const rest = adapter({
      getCandles: vi.fn().mockImplementation(async ({ interval, startTimeMs }: { interval: SpotInterval; startTimeMs?: number }) => {
        const end = Math.floor((AT + 1 - BASE) / MS[interval]) - 1;
        if (startTimeMs != null) throw new Error("REST unavailable");
        return interval === "1h"
          ? [candle("1h", end - 2), candle("1h", end)]
          : [candle(interval, end - 1), candle(interval, end)];
      }),
    });
    const result = await makePipeline(rest).runManual("BTCUSDT");
    expect(result.status).toBe("insufficient-data");
    expect(result.decision).toBe("暂不入场");
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ interval: "1h", code: "gap" })]));
    expect(result.signal).toBeNull();
    expect(result.entryPlan).toBeNull();
  });

  it("crypto-ai-analysis.CANDLE_QUALITY.4 crypto-ai-analysis.CANDLE_QUALITY.5 corrects conflicting WS close only with authoritative REST", async () => {
    const rest = adapter();
    const pipeline = makePipeline(rest);
    const result = await pipeline.onHourlyClose(candle("1h", 47, { close: 999, source: "ws" }));
    expect(result?.status).toBe("ready");
    expect(result?.windows["1h"].at(-1)?.close).toBe(105);
    expect(rest.getCandles).toHaveBeenCalledWith(expect.objectContaining({ interval: "1h", startTimeMs: candle("1h", 47).openTimeMs }));
  });

  it("crypto-ai-analysis.CANDLE_QUALITY.5-1 does not substitute local clock when Binance time is unavailable", async () => {
    const pipeline = makePipeline(adapter({ getServerTime: vi.fn().mockRejectedValue(new Error("offline")) }));
    const result = await pipeline.runManual("BTCUSDT");
    expect(result.status).toBe("insufficient-data");
    expect(result.analysisTimeMs).toBeNull();
    expect(result.decision).toBe("暂不入场");
  });

  it("crypto-ai-analysis.CANDLE_QUALITY.3-2 persists bounded attempt metadata without raw candles", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const options = {
      restAdapter: adapter(), storage, minimumCandles: COUNTS,
      getHealth: () => ({ state: "live" as const, serverTimeMs: AT, lastMessageAtMs: AT,
        lastClosedCandleAtMs: AT, missingRanges: [] }),
    };
    await createAnalysisPipeline(options).runManual("BTCUSDT");
    const restored = createAnalysisPipeline(options).getRecords();
    expect(restored).toEqual([expect.objectContaining({
      trigger: "manual", analysisTimeMs: AT,
      candleCloseTimes: { "1d": AT, "4h": AT, "1h": AT },
    })]);
    expect(restored[0]).not.toHaveProperty("windows");
  });
});
