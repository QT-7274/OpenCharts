import { describe, expect, it, vi } from "vitest";
import { createAnalysisPipeline } from "./pipeline.ts";
import { evaluateStrategy } from "./strategy.ts";
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
    getSpotSymbols: vi.fn().mockResolvedValue([{
      symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT",
      tickSize: 0.01, minQty: 0.001, maxQty: 1_000_000, stepSize: 0.001,
    }]),
    getSpotQuote: vi.fn().mockResolvedValue({ price: 149, tradeTimeMs: AT, serverTimeMs: AT }),
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
    getRiskContext: () => ({ accountEquity: 100_000, availableQuoteBalance: 100_000 }),
  });
}

describe("analysis trigger and as-of pipeline", () => {
  it("crypto-ai-analysis.STRATEGY.2 crypto-ai-analysis.STRATEGY.3 crypto-ai-analysis.STRATEGY.4 crypto-ai-analysis.STRATEGY.12 attaches versioned indicators and trend evidence", async () => {
    const restAdapter = adapter();
    const pipeline = makePipeline(restAdapter);

    const result = await pipeline.runManual("BTCUSDT");
    expect(result.status).toBe("ready");
    expect(result.strategyVersion).toBe("trend-pullback-v1");
    expect(result.indicators?.["1d"]).toEqual(expect.objectContaining({ interval: "1d", close: 309 }));
    expect(result.indicators?.["4h"]).toEqual(expect.objectContaining({ interval: "4h", close: 164 }));
    expect(result.indicators?.["1h"]).toEqual(expect.objectContaining({ interval: "1h", close: 149 }));
    expect(result.trend).toEqual(expect.objectContaining({ direction: "bullish", eligibleForPullback: true }));
    expect(result.strategy).toEqual(expect.objectContaining({ state: "watch", avoidReason: null }));
    expect(result.strategy?.score).toBeGreaterThanOrEqual(0);
    expect(result.currentPrice).toBe(149);
    expect(restAdapter.getSpotQuote).toHaveBeenCalledWith("BTCUSDT");
    expect(result.supportResistance).toEqual({ support: null, resistance: null });
    expect(result.signal).toBeNull();
    expect(result.entryPlan).toBeNull();
  });

  it("crypto-ai-analysis.CANDLE_QUALITY.4 does not allow configuration below strategy warmup floors", async () => {
    const rest = adapter();
    const pipeline = createAnalysisPipeline({
      restAdapter: rest,
      getHealth: () => ({ state: "live", serverTimeMs: AT, lastMessageAtMs: AT,
        lastClosedCandleAtMs: AT, missingRanges: [] }),
      getRiskContext: () => ({ accountEquity: 100_000, availableQuoteBalance: 100_000 }),
      minimumCandles: { "1d": 2, "4h": 2, "1h": 2 },
    });

    expect((await pipeline.runManual("BTCUSDT")).status).toBe("ready");
    expect(rest.getCandles).toHaveBeenCalledWith(expect.objectContaining({ interval: "1d", limit: 212 }));
    expect(rest.getCandles).toHaveBeenCalledWith(expect.objectContaining({ interval: "4h", limit: 67 }));
    expect(rest.getCandles).toHaveBeenCalledWith(expect.objectContaining({ interval: "1h", limit: 52 }));
  });

  it("crypto-ai-analysis.ENTRY_PLAN.2 crypto-ai-analysis.ENTRY_PLAN.2-1 crypto-ai-analysis.ENTRY_PLAN.3-1 crypto-ai-analysis.ENTRY_PLAN.3 crypto-ai-analysis.ENTRY_PLAN.4 crypto-ai-analysis.ENTRY_PLAN.6 crypto-ai-analysis.ANALYSIS_SNAPSHOT.4 builds and restores a valid closed-candle plan", async () => {
    const byInterval = Object.fromEntries(INTERVALS.map((interval) => [
      interval,
      risingSeries(interval, COUNTS[interval]),
    ])) as Record<SpotInterval, MarketCandle[]>;
    const fourHourCloses = [149, 147, 148, 150, 152, 154];
    fourHourCloses.forEach((close, offset) => {
      const index = byInterval["4h"].length - fourHourCloses.length + offset;
      byInterval["4h"][index] = {
        ...byInterval["4h"][index]!,
        open: close - 1,
        high: close + 2,
        low: close - 3,
        close,
      };
    });
    const resistanceIndex = byInterval["4h"].length - fourHourCloses.length - 1;
    byInterval["4h"][resistanceIndex] = { ...byInterval["4h"][resistanceIndex]!, high: 175 };
    [145, 125, 118, 150].forEach((close, offset) => {
      const index = byInterval["1h"].length - 4 + offset;
      byInterval["1h"][index] = {
        ...byInterval["1h"][index]!,
        open: close - 1,
        high: close + 2,
        low: close - 2,
        close,
      };
    });

    const rest = adapter({
      getServerTime: vi.fn().mockResolvedValue(AT + 1),
      getSpotQuote: vi.fn().mockResolvedValue({ price: 150, tradeTimeMs: AT - 29_000, serverTimeMs: AT }),
      getCandles: vi.fn().mockImplementation(async ({ interval, startTimeMs }: {
        interval: SpotInterval;
        startTimeMs?: number;
      }) => startTimeMs == null
        ? byInterval[interval]
        : byInterval[interval].filter((row) => row.openTimeMs >= startTimeMs)),
    });
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const options = {
      restAdapter: rest,
      storage,
      now: () => AT + MS["1h"],
      getHealth: () => ({ state: "live" as const, serverTimeMs: AT, lastMessageAtMs: AT,
        lastClosedCandleAtMs: AT, missingRanges: [] }),
      getRiskContext: () => ({ accountEquity: 100_000, availableQuoteBalance: 100_000 }),
    };
    const pipeline = createAnalysisPipeline(options);
    const result = await pipeline.runManual("BTCUSDT");

    expect(result.status).toBe("ready");
    expect(result.supportResistance.resistance?.price).toBe(175);
    expect(result.entryPlan).toMatchObject({
      status: "active",
      referencePrice: 150,
      entryLower: expect.any(Number),
      entryUpper: expect.any(Number),
      stop: expect.any(Number),
      takeProfit1: expect.any(Number),
      takeProfit2: 175,
      riskReward: 2,
      riskBudgetAmount: 1_000,
      estimatedStopRisk: expect.any(Number),
      suggestedQuantity: expect.any(Number),
    });
    expect(result.entryPlan?.estimatedStopRisk).toBeLessThanOrEqual(1_000);
    expect(result.strategy?.state).toBe("enter");
    const storedRecord = values.get("opencharts.analysis.attempts.v1")!;
    const storedRecords = JSON.parse(storedRecord) as Array<Record<string, unknown>>;
    const corruptedPlanRecord = {
      ...storedRecords[0],
      entryPlan: { ...result.entryPlan!, stop: result.entryPlan!.referencePrice + 1 },
    };
    values.set("opencharts.analysis.attempts.v1", JSON.stringify([...storedRecords, corruptedPlanRecord]));
    const reloaded = createAnalysisPipeline({ ...options, now: () => AT + 2_000 });
    expect(reloaded.getRecords()).toHaveLength(1);
    expect(reloaded.getLatest("BTCUSDT")?.entryPlan).toMatchObject({
      status: "waiting-for-price",
      failure: "spot-price-stale",
    });

    const offline = adapter({
      getCandles: vi.fn().mockRejectedValue(new Error("offline")),
    });
    const afterRefresh = await createAnalysisPipeline({ ...options, restAdapter: offline })
      .runManual("BTCUSDT");
    expect(afterRefresh.entryPlan).toMatchObject({ status: "invalidated", failure: "insufficient-data" });

    const invalidatedRecord = {
      ...storedRecords[0],
      entryPlan: { ...result.entryPlan!, status: "invalidated", failure: "trend-invalidated" },
      entryPlanFailure: "trend-invalidated",
      strategy: {
        ...result.strategy!, state: "avoid", avoidReason: "trend-not-qualified", entryPlanStatus: "invalidated",
      },
    };
    const invalidatedStorage = {
      getItem: () => JSON.stringify([invalidatedRecord]),
      setItem: vi.fn(),
    };
    const invalidatedPipeline = createAnalysisPipeline({
      ...options,
      restAdapter: { ...rest, getSpotSymbols: vi.fn().mockResolvedValue([]) },
      storage: invalidatedStorage,
    });
    expect(invalidatedPipeline.getLatest("BTCUSDT")?.entryPlan?.status).toBe("invalidated");
    expect((await invalidatedPipeline.runManual("BTCUSDT")).entryPlan).toBeNull();

    const expiredStorage = {
      getItem: () => storedRecord,
      setItem: vi.fn(),
    };
    const expiredPipeline = createAnalysisPipeline({
      ...options,
      restAdapter: offline,
      storage: expiredStorage,
      now: () => AT + 3 * MS["1h"],
    });
    expect(expiredPipeline.getLatest("BTCUSDT")?.entryPlan?.status).toBe("expired");
    const expiredAfterRefresh = await expiredPipeline.runManual("BTCUSDT");
    expect(expiredAfterRefresh.entryPlan).toBeNull();
    const insufficientReward = evaluateStrategy({
      indicators: result.indicators!,
      trend: result.trend!,
      fourHourCandles: result.windows["4h"],
      oneHourCandles: result.windows["1h"],
      analysisTimeMs: result.analysisTimeMs!,
      dataComplete: true,
      riskReward: 1.5,
      entryPlanStatus: "active",
    });
    expect(insufficientReward).toMatchObject({ state: "avoid", avoidReason: "risk-reward-insufficient" });

    const hourlyRest = adapter({
      getSpotQuote: vi.fn().mockResolvedValue({ price: 170, tradeTimeMs: AT, serverTimeMs: AT }),
      getCandles: vi.fn().mockImplementation(async ({ interval, startTimeMs }: {
        interval: SpotInterval;
        startTimeMs?: number;
      }) => startTimeMs == null
        ? byInterval[interval]
        : byInterval[interval].filter((row) => row.openTimeMs >= startTimeMs)),
    });
    const auto = await makePipeline(hourlyRest).onHourlyClose(byInterval["1h"].at(-1)!);
    expect(auto?.currentPrice).toBe(byInterval["1h"].at(-1)?.close);
    expect(auto?.entryPlan?.status).toBe("waiting-for-price");
    expect(auto?.strategy?.state).toBe("setup");
    expect(hourlyRest.getSpotQuote).not.toHaveBeenCalled();
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
    expect(first?.currentPrice).toBe(event.close);
    expect(rest.getSpotQuote).not.toHaveBeenCalled();
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
      getRiskContext: () => ({ accountEquity: 100_000, availableQuoteBalance: 100_000 }),
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

  it("crypto-ai-analysis.FORWARD_SIMULATION.10-1 serves durable snapshots beyond the memory window", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const options = {
      restAdapter: adapter(),
      storage,
      getRiskContext: () => ({ accountEquity: 100_000, availableQuoteBalance: 100_000 }),
      getHealth: () => ({ state: "live" as const, serverTimeMs: AT, lastMessageAtMs: AT,
        lastClosedCandleAtMs: AT, missingRanges: [] }),
    };
    await createAnalysisPipeline(options).runManual("BTCUSDT");
    const saved = JSON.parse(values.get("opencharts.analysis.attempts.v1")!) as Array<Record<string, unknown>>;
    values.set("opencharts.analysis.attempts.v1", JSON.stringify(Array.from({ length: 101 }, (_, index) => ({
      ...saved[0], snapshotId: `snapshot-${index}`,
    }))));

    const restored = createAnalysisPipeline(options);

    expect(restored.getHistory()).toHaveLength(100);
    expect(restored.getRecords()).toHaveLength(101);
    expect(restored.getRecords()[0]?.snapshotId).toBe("snapshot-0");
  });

  it("crypto-ai-analysis.FORWARD_SIMULATION.10-1 excludes snapshots that failed durable persistence", async () => {
    const pipeline = createAnalysisPipeline({
      restAdapter: adapter(),
      storage: { getItem: () => null, setItem: () => { throw new Error("disk unavailable"); } },
      getRiskContext: () => ({ accountEquity: 100_000, availableQuoteBalance: 100_000 }),
      getHealth: () => ({ state: "live" as const, serverTimeMs: AT, lastMessageAtMs: AT,
        lastClosedCandleAtMs: AT, missingRanges: [] }),
    });

    await pipeline.runManual("BTCUSDT");

    expect(pipeline.getRecords()).toHaveLength(0);
  });

  it("crypto-ai-analysis.ANALYSIS_SNAPSHOT.1 crypto-ai-analysis.ANALYSIS_SNAPSHOT.3 persists the explanation with its algorithm snapshot", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const options = {
      restAdapter: adapter(), storage,
      getRiskContext: () => ({ accountEquity: 100_000, availableQuoteBalance: 100_000 }),
      getHealth: () => ({ state: "live" as const, serverTimeMs: AT, lastMessageAtMs: AT,
        lastClosedCandleAtMs: AT, missingRanges: [] }),
    };
    const pipeline = createAnalysisPipeline(options);
    const attempt = await pipeline.runManual("BTCUSDT");
    const explanationRecord = {
      status: "available" as const,
      provider: "openai",
      modelId: "gpt-6-luna-2026-01-01",
      promptVersion: "crypto-ai-explanation-v1",
      schemaVersion: "crypto-ai-explanation-v1",
      requestedAtMs: AT,
      respondedAtMs: AT + 1,
      tokenUsage: { inputTokens: 50, outputTokens: 35 },
      rawResponse: { summary: "趋势条件满足。" },
      validationResult: "valid" as const,
      failureReason: null,
      explanation: {
        summary: "趋势条件满足。",
        trendExplanation: "日线和 4 小时趋势偏多。",
        indicatorEvidence: ["现价高于 EMA20。"],
        entryExplanation: "仅按算法给定的计划观察。",
        riskExplanation: "止损和止盈以策略结果为准。",
        cautionNotes: [],
        educationalNotes: [],
      },
    };

    expect(attempt.snapshotId).toBeTruthy();
    expect(attempt.aiInputSummary).toMatchObject({ symbol: "BTCUSDT", strategyVersion: "trend-pullback-v1" });
    expect(attempt.aiInputSummary).not.toHaveProperty("windows");
    expect(pipeline.updateAiSnapshot(attempt.snapshotId!, { aiExplanation: explanationRecord })).toMatchObject({
      snapshotId: attempt.snapshotId,
      aiExplanation: explanationRecord,
    });

    const restored = createAnalysisPipeline(options).getLatest("BTCUSDT");
    expect(restored?.snapshotId).toBe(attempt.snapshotId);
    expect(restored?.aiInputSummary).toEqual(attempt.aiInputSummary);
    expect(restored?.aiExplanation).toEqual(explanationRecord);
  });

  it("crypto-ai-analysis.AI_EXPLANATION.9 reuses the explanation and replaces duplicate snapshot IDs", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const pipeline = createAnalysisPipeline({
      restAdapter: adapter(), storage,
      getRiskContext: () => ({ accountEquity: 100_000, availableQuoteBalance: 100_000 }),
      getHealth: () => ({ state: "live", serverTimeMs: AT, lastMessageAtMs: AT,
        lastClosedCandleAtMs: AT, missingRanges: [] }),
    });
    const first = await pipeline.runManual("BTCUSDT");
    const explanation = {
      status: "unavailable" as const, provider: "openai", modelId: "gpt-6-luna",
      promptVersion: "crypto-ai-explanation-v1", schemaVersion: "crypto-ai-explanation-v1",
      requestedAtMs: AT, respondedAtMs: AT, tokenUsage: null, rawResponse: null,
      validationResult: "unavailable" as const, failureReason: "provider-not-configured", explanation: null,
    };
    pipeline.updateAiSnapshot(first.snapshotId!, { aiExplanation: explanation });

    const second = await pipeline.runManual("BTCUSDT");

    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.aiExplanation).toEqual(explanation);
    expect(pipeline.getRecords()).toHaveLength(1);
    expect(JSON.parse(values.get("opencharts.analysis.attempts.v1")!)).toHaveLength(1);
  });

  it("crypto-ai-analysis.AI_EXPLANATION.6-2 does not restore text with numbers inconsistent with its snapshot", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const options = {
      restAdapter: adapter(), storage,
      getRiskContext: () => ({ accountEquity: 100_000, availableQuoteBalance: 100_000 }),
      getHealth: () => ({ state: "live" as const, serverTimeMs: AT, lastMessageAtMs: AT,
        lastClosedCandleAtMs: AT, missingRanges: [] }),
    };
    const pipeline = createAnalysisPipeline(options);
    const attempt = await pipeline.runManual("BTCUSDT");
    pipeline.updateAiSnapshot(attempt.snapshotId!, { aiExplanation: {
      status: "available", provider: "openai", modelId: "gpt-6-luna",
      promptVersion: "crypto-ai-explanation-v1", schemaVersion: "crypto-ai-explanation-v1",
      requestedAtMs: AT, respondedAtMs: AT + 1, tokenUsage: null, rawResponse: { summary: "趋势条件尚待确认。" },
      validationResult: "valid", failureReason: null,
      explanation: {
        summary: "当前仍需等待趋势条件确认。", trendExplanation: "趋势条件尚待确认。",
        indicatorEvidence: ["目前没有额外指标数值。"], entryExplanation: "等待算法确认。",
        riskExplanation: "暂无有效风险计划。", cautionNotes: [], educationalNotes: [],
      },
    } });
    const stored = JSON.parse(values.get("opencharts.analysis.attempts.v1")!) as Array<Record<string, unknown>>;
    const savedExplanation = stored[0]!.aiExplanation as Record<string, unknown>;
    const savedText = savedExplanation.explanation as Record<string, unknown>;
    stored[0] = {
      ...stored[0],
      aiExplanation: {
        ...savedExplanation,
        explanation: { ...savedText, summary: "评分为 999。" },
      },
    };
    values.set("opencharts.analysis.attempts.v1", JSON.stringify(stored));

    const restored = createAnalysisPipeline(options).getLatest("BTCUSDT");

    expect(restored?.status).toBe("ready");
    expect(restored?.aiExplanation).toBeNull();
  });

  it("crypto-ai-analysis.ANALYSIS_SNAPSHOT.5 reports failed local persistence", async () => {
    const pipeline = createAnalysisPipeline({
      restAdapter: adapter(),
      storage: { getItem: () => null, setItem: () => { throw new Error("quota exceeded"); } },
      getRiskContext: () => ({ accountEquity: 100_000, availableQuoteBalance: 100_000 }),
      getHealth: () => ({ state: "live", serverTimeMs: AT, lastMessageAtMs: AT,
        lastClosedCandleAtMs: AT, missingRanges: [] }),
    });

    const attempt = await pipeline.runManual("BTCUSDT");

    expect(attempt.persistenceError).toBe("analysis-snapshot");
  });

  it("crypto-ai-analysis.ANALYSIS_SNAPSHOT.5 clears persistence errors after a successful save", async () => {
    const values = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => { values.set(key, value); })
      .mockImplementationOnce(() => { throw new Error("quota exceeded"); })
      .mockImplementationOnce(() => { throw new Error("quota exceeded"); });
    const options = {
      restAdapter: adapter(),
      storage: { getItem: (key: string) => values.get(key) ?? null, setItem },
      getRiskContext: () => ({ accountEquity: 100_000, availableQuoteBalance: 100_000 }),
      getHealth: () => ({ state: "live" as const, serverTimeMs: AT, lastMessageAtMs: AT,
        lastClosedCandleAtMs: AT, missingRanges: [] }),
    };
    const pipeline = createAnalysisPipeline(options);
    const attempt = await pipeline.runManual("BTCUSDT");
    const aiExplanation = {
      status: "unavailable" as const, provider: "openai", modelId: null,
      promptVersion: "crypto-ai-explanation-v1", schemaVersion: "crypto-ai-explanation-v1",
      requestedAtMs: AT, respondedAtMs: AT, tokenUsage: null, rawResponse: null,
      validationResult: "unavailable" as const, failureReason: "provider-not-configured", explanation: null,
    };

    expect(attempt.persistenceError).toBe("analysis-snapshot");
    expect(pipeline.updateAiSnapshot(attempt.snapshotId!, { aiExplanation })?.persistenceError)
      .toBe("ai-explanation");

    const saved = pipeline.updateAiSnapshot(attempt.snapshotId!, { aiExplanation });

    expect(saved?.persistenceError).toBeUndefined();
    expect(pipeline.getLatest("BTCUSDT")?.persistenceError).toBeUndefined();
    expect(createAnalysisPipeline(options).getLatest("BTCUSDT")?.aiExplanation).toEqual(aiExplanation);
  });

  it("crypto-ai-analysis.ANALYSIS_SNAPSHOT.4 skips malformed history records independently", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const options = {
      restAdapter: adapter(), storage,
      getRiskContext: () => ({ accountEquity: 100_000, availableQuoteBalance: 100_000 }),
      getHealth: () => ({ state: "live" as const, serverTimeMs: AT, lastMessageAtMs: AT,
        lastClosedCandleAtMs: AT, missingRanges: [] }),
    };
    await createAnalysisPipeline(options).runManual("BTCUSDT");
    const saved = JSON.parse(values.get("opencharts.analysis.attempts.v1")!) as unknown[];
    values.set("opencharts.analysis.attempts.v1", JSON.stringify([
      ...saved,
      { ...saved[0] as object, issues: [{ interval: "1h", code: { invalid: true } }] },
    ]));

    const restored = createAnalysisPipeline(options);
    expect(restored.getRecords()).toHaveLength(1);
    expect(restored.getLatest("BTCUSDT")?.status).toBe("ready");
  });
});
