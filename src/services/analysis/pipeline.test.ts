import { describe, expect, it, vi } from "vitest";
import { createAnalysisPipeline } from "./pipeline.ts";
import { BASE, MS, candle } from "./fixtures.ts";
import type { MarketCandle, MarketDataRestAdapter, SpotInterval } from "../market-data/types.ts";

const INTERVALS: SpotInterval[] = ["1d", "4h", "1h"];
const COUNTS = { "1d": 210, "4h": 65, "1h": 50 } as const;
const AT = BASE + 210 * MS["1d"] - 1;

function risingSeries(interval: SpotInterval, count: number): MarketCandle[] {
  const endIndex = Math.floor((AT + 1 - BASE) / MS[interval]) - 1;
  return Array.from({ length: count }, (_, offset) => {
    const index = endIndex - count + 1 + offset;
    const close = 100 + offset;
    return candle(interval, index, {
      open: close,
      high: close + 2,
      low: close - 2,
      close,
      volume: 100,
      quoteVolume: close * 100,
    });
  });
}

function adapter(overrides: Partial<MarketDataRestAdapter> = {}): MarketDataRestAdapter {
  return {
    getServerTime: vi.fn().mockResolvedValue(AT),
    getSpotSymbols: vi.fn().mockResolvedValue([]),
    getCandles: vi.fn().mockImplementation(async ({ interval, startTimeMs }: { interval: SpotInterval; startTimeMs?: number }) => {
      const rows = risingSeries(interval, COUNTS[interval]);
      return startTimeMs == null ? rows : rows.filter((row) => row.openTimeMs >= startTimeMs);
    }),
    ...overrides,
  };
}

function makePipeline(rest: MarketDataRestAdapter) {
  return createAnalysisPipeline({
    restAdapter: rest,
    getHealth: () => ({ state: "live", serverTimeMs: AT, lastMessageAtMs: AT, lastClosedCandleAtMs: AT, missingRanges: [] }),
  });
}

describe("analysis trigger and as-of pipeline", () => {
  it("crypto-ai-analysis.STRATEGY.2 crypto-ai-analysis.STRATEGY.3 crypto-ai-analysis.STRATEGY.4 crypto-ai-analysis.STRATEGY.12 attaches versioned indicators and trend evidence", async () => {
    const pipeline = makePipeline(adapter());

    const result = await pipeline.runManual("BTCUSDT");
    expect(result.status).toBe("ready");
    expect(result.strategyVersion).toBe("trend-pullback-v1");
    expect(result.indicators?.["1d"]).toEqual(expect.objectContaining({ interval: "1d", close: 309 }));
    expect(result.indicators?.["4h"]).toEqual(expect.objectContaining({ interval: "4h", close: 164 }));
    expect(result.indicators?.["1h"]).toEqual(expect.objectContaining({ interval: "1h", close: 149 }));
    expect(result.trend).toEqual(expect.objectContaining({ direction: "bullish", eligibleForPullback: true }));
    expect(result.signal).toBeNull();
    expect(result.entryPlan).toBeNull();
  });

  it("crypto-ai-analysis.CANDLE_QUALITY.4 does not allow configuration below strategy warmup floors", async () => {
    const rest = adapter();
    const pipeline = createAnalysisPipeline({
      restAdapter: rest,
      getHealth: () => ({ state: "live", serverTimeMs: AT, lastMessageAtMs: AT,
        lastClosedCandleAtMs: AT, missingRanges: [] }),
      minimumCandles: { "1d": 2, "4h": 2, "1h": 2 },
    });

    expect((await pipeline.runManual("BTCUSDT")).status).toBe("ready");
    expect(rest.getCandles).toHaveBeenCalledWith(expect.objectContaining({ interval: "1d", limit: 212 }));
    expect(rest.getCandles).toHaveBeenCalledWith(expect.objectContaining({ interval: "4h", limit: 67 }));
    expect(rest.getCandles).toHaveBeenCalledWith(expect.objectContaining({ interval: "1h", limit: 52 }));
  });

  it("crypto-ai-analysis.CANDLE_QUALITY.1 crypto-ai-analysis.CANDLE_QUALITY.3-1 crypto-ai-analysis.CANDLE_QUALITY.3-2 records manual Binance server time and actual close times", async () => {
    const pipeline = makePipeline(adapter());
    const result = await pipeline.runManual("BTCUSDT");
    expect(result.trigger).toBe("manual");
    expect(result.analysisTimeMs).toBe(AT);
    expect(result.candleCloseTimes).toEqual({
      "1d": AT,
      "4h": AT,
      "1h": AT,
    });
    expect(result.status).toBe("ready");
    expect(result.signal).toBeNull();
    expect(result.entryPlan).toBeNull();
    expect(INTERVALS.every((interval) => result.windows[interval].every((row) => row.isClosed && row.closeTimeMs <= AT))).toBe(true);
  });

  it("crypto-ai-analysis.CANDLE_QUALITY.1-1 auto trigger reuses one attempt even for concurrent duplicate 1h close events", async () => {
    const rest = adapter();
    const pipeline = makePipeline(rest);
    const event = risingSeries("1h", COUNTS["1h"]).at(-1)!;
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
        const rows = risingSeries(interval, COUNTS[interval]);
        if (interval !== "1h") return rows;
        const missing = rows.at(-2)!;
        if (startTimeMs != null) return [missing];
        return rows.filter((row) => row.openTimeMs !== missing.openTimeMs);
      }),
    });
    const result = await makePipeline(rest).runManual("BTCUSDT");
    expect(result.status).toBe("ready");
    expect(result.windows["1h"]).toHaveLength(COUNTS["1h"]);
    expect(result.windows["1h"].at(-2)?.close).toBe(148);
  });

  it("crypto-ai-analysis.CANDLE_QUALITY.5 crypto-ai-analysis.CANDLE_QUALITY.5-1 records insufficient-data without a signal on repair failure", async () => {
    const rest = adapter({
      getCandles: vi.fn().mockImplementation(async ({ interval, startTimeMs }: { interval: SpotInterval; startTimeMs?: number }) => {
        if (startTimeMs != null) throw new Error("REST unavailable");
        const rows = risingSeries(interval, COUNTS[interval]);
        return interval === "1h" ? rows.filter((_, index) => index !== rows.length - 2) : rows;
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
    const canonical = risingSeries("1h", COUNTS["1h"]).at(-1)!;
    const result = await pipeline.onHourlyClose({ ...canonical, close: 999, source: "ws" });
    expect(result?.status).toBe("ready");
    expect(result?.windows["1h"].at(-1)?.close).toBe(149);
    expect(rest.getCandles).toHaveBeenCalledWith(expect.objectContaining({ interval: "1h", startTimeMs: canonical.openTimeMs }));
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
      restAdapter: adapter(), storage,
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
