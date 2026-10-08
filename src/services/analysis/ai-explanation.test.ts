import { describe, expect, it, vi } from "vitest";
import {
  AI_EXPLANATION_PROMPT_VERSION,
  AI_EXPLANATION_SCHEMA_VERSION,
  analysisSnapshotSchema,
  handleAiExplanationRequest,
  createAiExplanationService,
  createOpenAiAiExplanationProvider,
  validateAiExplanation,
} from "../../../server/ai-explanation.mjs";

const snapshot = {
  symbol: "BTCUSDT",
  analysisTimeMs: 1_760_000_000_000,
  trigger: "manual",
  strategyVersion: "trend-pullback-v1",
  status: "ready",
  candleCloseTimes: { "1d": 1_759_939_200_000, "4h": 1_759_985_600_000, "1h": 1_759_996_400_000 },
  issues: [],
  indicators: {
    "1d": { interval: "1d", candleCloseTimeMs: 1_759_939_200_000, close: 100, ema20: 98, ema50: 95, ema200: 90, ema20ThreeBarsAgo: 97, ema50FiveBarsAgo: 94, atr14: 3, rsi14: 58, previousRsi14: 54, macdHistogram: 1.2, previousMacdHistogram: 0.8, volume: 120, volumeSma20: 100 },
    "4h": { interval: "4h", candleCloseTimeMs: 1_759_985_600_000, close: 100, ema20: 99, ema50: 96, ema200: null, ema20ThreeBarsAgo: 98, ema50FiveBarsAgo: null, atr14: 2, rsi14: 56, previousRsi14: 52, macdHistogram: 0.9, previousMacdHistogram: 0.7, volume: 115, volumeSma20: 100 },
    "1h": { interval: "1h", candleCloseTimeMs: 1_759_996_400_000, close: 100, ema20: 99, ema50: 97, ema200: null, ema20ThreeBarsAgo: 98, ema50FiveBarsAgo: null, atr14: 1, rsi14: 55, previousRsi14: 52, macdHistogram: 0.7, previousMacdHistogram: 0.5, volume: 110, volumeSma20: 100 },
  },
  trend: { direction: "bullish", dailyPassed: 3, fourHourPassed: 3 },
  strategy: {
    state: "enter",
    avoidReason: null,
    score: 85,
    scoreBreakdown: { trendQuality: 30, pullbackQuality: 18, priceConfirmation: 15, momentum: 12, volume: 10, volatilityAndFreshness: 0, total: 85 },
    pullbackValid: true,
    confirmationPassed: true,
    riskReward: 2,
  },
  currentPrice: 100,
  quoteTradeTimeMs: 1_759_999_000_000,
  quoteServerTimeMs: 1_759_999_002_000,
  supportResistance: {
    support: { price: 95, lower: 94, upper: 96, touches: 3 },
    resistance: { price: 115, lower: 114, upper: 116, touches: 2 },
  },
  entryPlan: { status: "active", failure: null, entryLower: 99, entryUpper: 101, stop: 95, takeProfit1: 110, takeProfit2: 115, riskReward: 2, suggestedQuantity: 10, estimatedStopRisk: 60 },
};

const explanation = {
  summary: "多周期趋势偏多，当前确认条件满足。",
  trendExplanation: "日线与 4h 趋势条件均通过。",
  indicatorEvidence: ["RSI 处于 55，且高于前值。", "价格位于 EMA20 上方。"],
  entryExplanation: "算法生成的入场区间为 99 至 101。",
  riskExplanation: "计划止损位于 95，风险收益比为 2。",
  cautionNotes: ["若价格离开计划区间，不要追价。"],
  educationalNotes: ["EMA 用于观察一段时间内的平均价格方向。"],
};

describe("crypto-ai-analysis.AI_EXPLANATION.4 and crypto-ai-analysis.AI_EXPLANATION.4-1", () => {
  it("accepts only the algorithm summary and rejects raw candles or extra fields", () => {
    expect(analysisSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(analysisSnapshotSchema.safeParse({ ...snapshot, candles: [{ open: 1 }] }).success).toBe(false);
    expect(analysisSnapshotSchema.safeParse({ ...snapshot, accountToken: "secret" }).success).toBe(false);
  });
});

describe("crypto-ai-analysis.AI_EXPLANATION.5 and crypto-ai-analysis.AI_EXPLANATION.6", () => {
  it("rejects explanation numbers that do not occur in the algorithm input", () => {
    expect(validateAiExplanation(snapshot, explanation).valid).toBe(true);
    expect(validateAiExplanation(snapshot, {
      ...explanation,
      summary: "下一目标是 999。",
    }).valid).toBe(false);
  });

  it("crypto-ai-analysis.AI_EXPLANATION.6-2 rejects a support price presented as the entry price", () => {
    expect(validateAiExplanation(snapshot, {
      ...explanation,
      entryExplanation: "入场价为 95。",
    }).valid).toBe(false);
    expect(validateAiExplanation(snapshot, {
      ...explanation,
      cautionNotes: ["支撑位为 95。"],
    }).valid).toBe(true);
  });

  it("crypto-ai-analysis.AI_EXPLANATION.6-2 allows configured indicator periods while validating their values", () => {
    expect(validateAiExplanation(snapshot, {
      ...explanation,
      indicatorEvidence: ["RSI(14)为55，高于前值52；1h EMA20为99，ATR(14)为1。", "MACD(12,26,9) histogram 为0.7。"],
    }).valid).toBe(true);
    expect(validateAiExplanation(snapshot, {
      ...explanation,
      indicatorEvidence: ["RSI(999)为55。"],
    }).valid).toBe(false);
  });
});

describe("crypto-ai-analysis.AI_EXPLANATION.3-1, crypto-ai-analysis.AI_EXPLANATION.5 and crypto-ai-analysis.AI_EXPLANATION.9-2", () => {
  it("sends a strict Responses request without storage or tools", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: "resp_1",
      model: "gpt-6-luna-2026-01-01",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(explanation) }] }],
      usage: { input_tokens: 90, output_tokens: 70 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = createOpenAiAiExplanationProvider({ apiKey: "test-secret", model: "gpt-6-luna", fetchFn, now: () => 1_760_000_000_000 });

    const result = await provider.explain(snapshot);
    const request = JSON.parse(String(fetchFn.mock.calls[0]![1]?.body));

    expect(request.store).toBe(false);
    expect(request.max_output_tokens).toBe(1000);
    expect(request.text.format.strict).toBe(true);
    expect(request.tools).toBeUndefined();
    expect(result.modelId).toBe("gpt-6-luna-2026-01-01");
    expect(result.promptVersion).toBe(AI_EXPLANATION_PROMPT_VERSION);
    expect(result.schemaVersion).toBe(AI_EXPLANATION_SCHEMA_VERSION);
    expect(result.tokenUsage).toEqual({ inputTokens: 90, outputTokens: 70 });
  });
});

describe("crypto-ai-analysis.AI_EXPLANATION.8 and crypto-ai-analysis.AI_EXPLANATION.9-1", () => {
  it("reuses the first explanation for the same snapshot key and enforces the daily automatic limit", async () => {
    const provider = { explain: vi.fn().mockResolvedValue({ explanation, modelId: "gpt-6-luna" }) };
    const service = createAiExplanationService({ provider, now: () => Date.UTC(2026, 9, 8), dailyLimit: 1 });

    await service.explain(snapshot);
    await service.explain(snapshot);
    const another = await service.explain({ ...snapshot, analysisTimeMs: snapshot.analysisTimeMs + 1 });
    const regenerated = await service.explain(snapshot, { regenerate: true });

    expect(provider.explain).toHaveBeenCalledTimes(2);
    expect(another.failureReason).toBe("daily-limit");
    expect(regenerated.status).toBe("available");
  });

  it("crypto-ai-analysis.AI_EXPLANATION.9 coalesces concurrent requests for the same snapshot", async () => {
    let resolveExplanation!: (value: { explanation: typeof explanation; modelId: string }) => void;
    const provider = {
      explain: vi.fn(() => new Promise<{ explanation: typeof explanation; modelId: string }>((resolve) => {
        resolveExplanation = resolve;
      })),
      modelId: "gpt-6-luna",
    };
    const service = createAiExplanationService({ provider, now: () => Date.UTC(2026, 9, 8) });

    const first = service.explain(snapshot);
    const second = service.explain(snapshot);
    await vi.waitFor(() => expect(provider.explain).toHaveBeenCalledTimes(1));
    resolveExplanation({ explanation, modelId: "gpt-6-luna" });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(provider.explain).toHaveBeenCalledTimes(1);
    expect(secondResult).toEqual(firstResult);
  });

  it("crypto-ai-analysis.AI_EXPLANATION.9-1 crypto-ai-analysis.AI_EXPLANATION.10 preserves the daily limit across service restarts", async () => {
    let saved: { day: string; count: number } | null = null;
    const dailyLimitStore = {
      read: vi.fn(async () => saved),
      write: vi.fn(async (value: { day: string; count: number }) => { saved = value; }),
    };
    const provider = { explain: vi.fn().mockResolvedValue({ explanation, modelId: "gpt-6-luna" }) };
    const now = () => Date.UTC(2026, 9, 8);

    const firstInstance = createAiExplanationService({ provider, now, dailyLimit: 1, dailyLimitStore });
    await firstInstance.explain(snapshot);
    const restartedInstance = createAiExplanationService({ provider, now, dailyLimit: 1, dailyLimitStore });
    const limited = await restartedInstance.explain({ ...snapshot, analysisTimeMs: snapshot.analysisTimeMs + 1 });

    expect(saved).toEqual({ day: "2026-10-08", count: 1 });
    expect(limited.failureReason).toBe("daily-limit");
    expect(provider.explain).toHaveBeenCalledTimes(1);
  });

  it("crypto-ai-analysis.AI_EXPLANATION.9 rejects reusing a cache key for different input", async () => {
    const provider = { explain: vi.fn().mockResolvedValue({ explanation, modelId: "gpt-6-luna" }) };
    const service = createAiExplanationService({ provider, now: () => Date.UTC(2026, 9, 8) });

    await service.explain(snapshot);
    const conflict = await service.explain({ ...snapshot, currentPrice: 102 });

    expect(conflict).toMatchObject({ status: "invalid", failureReason: "snapshot-key-conflict", explanation: null });
    expect(provider.explain).toHaveBeenCalledTimes(1);
  });
});

describe("crypto-ai-analysis.AI_EXPLANATION.3 and crypto-ai-analysis.ANALYSIS_SNAPSHOT.3", () => {
  it("returns the explanation with the same snapshot ID through the backend endpoint", async () => {
    const provider = { explain: vi.fn().mockResolvedValue({ explanation, modelId: "gpt-6-luna" }), modelId: "gpt-6-luna" };
    const service = createAiExplanationService({ provider });
    const requestBody = JSON.stringify({ snapshotId: "snapshot-1", snapshot, regenerate: false });
    const request = {
      method: "POST",
      url: "/api/analysis/explanations",
      async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(requestBody); },
    };
    const response = {
      statusCode: 0,
      body: "",
      writeHead(statusCode: number) { this.statusCode = statusCode; },
      end(body: string) { this.body = body; },
    };

    await handleAiExplanationRequest(request as never, response as never, { service });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ snapshotId: "snapshot-1", status: "available", modelId: "gpt-6-luna" });
    const body = JSON.parse(response.body);
    expect(body.explanation).toEqual(explanation);
  });

  it("includes the snapshot ID when the provider is not configured", async () => {
    const requestBody = JSON.stringify({ snapshotId: "snapshot-1", snapshot, regenerate: false });
    const request = {
      method: "POST",
      url: "/api/analysis/explanations",
      async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(requestBody); },
    };
    const response = {
      statusCode: 0,
      body: "",
      writeHead(statusCode: number) { this.statusCode = statusCode; },
      end(body: string) { this.body = body; },
    };

    await handleAiExplanationRequest(request as never, response as never, {
      service: createAiExplanationService({ provider: { explain: vi.fn() } }),
      apiKeyConfigured: false,
    });

    expect(JSON.parse(response.body)).toMatchObject({
      snapshotId: "snapshot-1",
      status: "unavailable",
      failureReason: "provider-not-configured",
    });
  });
});
