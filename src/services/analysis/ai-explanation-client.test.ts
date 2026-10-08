import { describe, expect, it, vi } from "vitest";
import { analysisSnapshotSchema } from "../../../server/ai-explanation.mjs";
import { buildAiExplanationSnapshot, requestAiExplanation } from "./ai-explanation-client.ts";
import type { AnalysisAttempt } from "./pipeline.ts";

const attempt = {
  symbol: "BTCUSDT",
  analysisTimeMs: 1_760_000_000_000,
  trigger: "manual",
  status: "insufficient-data",
  strategyVersion: "trend-pullback-v1",
  candleCloseTimes: { "1d": null, "4h": null, "1h": null },
  issues: [{ interval: "1h", code: "unavailable" }],
  indicators: null,
  trend: null,
  strategy: null,
  currentPrice: null,
  supportResistance: { support: null, resistance: null },
  entryPlan: null,
  windows: { "1d": [{ open: 1 }], "4h": [], "1h": [] },
} as unknown as AnalysisAttempt;

const explanation = {
  summary: "行情数据尚不完整，暂不入场。",
  trendExplanation: "三个周期的有效指标尚未齐备。",
  indicatorEvidence: ["当前没有可验证的指标证据。"],
  entryExplanation: "数据完整前不生成入场计划。",
  riskExplanation: "当前没有可验证的止损和止盈计划。",
  cautionNotes: ["等待行情补齐后重新分析。"],
  educationalNotes: [],
};

const availableResponse = (snapshotId: string) => ({
  snapshotId,
  status: "available",
  provider: "openai",
  modelId: "gpt-6-luna-2026-01-01",
  promptVersion: "crypto-ai-explanation-v1",
  schemaVersion: "crypto-ai-explanation-v1",
  requestedAtMs: 1_760_000_000_001,
  respondedAtMs: 1_760_000_000_002,
  tokenUsage: { inputTokens: 50, outputTokens: 35 },
  rawResponse: explanation,
  validationResult: "valid",
  failureReason: null,
  explanation,
});

describe("crypto-ai-analysis.AI_EXPLANATION.4, crypto-ai-analysis.AI_EXPLANATION.4-1 and crypto-ai-analysis.ANALYSIS_SNAPSHOT.1", () => {
  it("projects only the allowlisted analysis summary and excludes raw candles", () => {
    const snapshot = buildAiExplanationSnapshot(attempt);

    expect(analysisSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(Object.keys(snapshot)).toEqual([
      "symbol", "analysisTimeMs", "trigger", "strategyVersion", "status", "candleCloseTimes",
      "issues", "indicators", "trend", "strategy", "currentPrice", "quoteTradeTimeMs",
      "quoteServerTimeMs", "supportResistance", "entryPlan",
    ]);
    expect(snapshot).not.toHaveProperty("windows");
  });
});

describe("crypto-ai-analysis.AI_EXPLANATION.3, crypto-ai-analysis.AI_EXPLANATION.8-1 and crypto-ai-analysis.ANALYSIS_SNAPSHOT.3", () => {
  it("posts the snapshot to the backend and associates the response with the same snapshot ID", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(availableResponse("snapshot-1")), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const result = await requestAiExplanation("snapshot-1", attempt, { fetchFn, now: () => 1_760_000_000_000 });
    const [url, init] = fetchFn.mock.calls[0]!;
    const body = JSON.parse(init.body);

    expect(url).toBe("/api/analysis/explanations");
    expect(body).toEqual({ snapshotId: "snapshot-1", snapshot: buildAiExplanationSnapshot(attempt), regenerate: false });
    expect(body.snapshot.windows).toBeUndefined();
    expect(result).toMatchObject({ status: "available", modelId: "gpt-6-luna-2026-01-01", explanation });
  });

  it("records backend failures as unavailable without throwing away the algorithm attempt", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("offline"));

    const result = await requestAiExplanation("snapshot-1", attempt, { fetchFn, now: () => 1_760_000_000_000 });

    expect(result).toMatchObject({
      status: "unavailable",
      requestedAtMs: 1_760_000_000_000,
      respondedAtMs: 1_760_000_000_000,
      validationResult: "unavailable",
      failureReason: "backend-unavailable",
      explanation: null,
    });
  });

  it("rejects a response attached to another snapshot", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(availableResponse("snapshot-2")), { status: 200 }));

    const result = await requestAiExplanation("snapshot-1", attempt, { fetchFn, now: () => 1_760_000_000_000 });

    expect(result).toMatchObject({ status: "invalid", validationResult: "invalid", failureReason: "snapshot-mismatch", explanation: null });
  });

  it("crypto-ai-analysis.AI_EXPLANATION.8 aborts a browser request at the total timeout", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        requestSignal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      });

      const resultPromise = requestAiExplanation("snapshot-timeout", attempt, {
        fetchFn,
        now: () => 1_760_000_000_000,
        timeoutMs: 15_000,
      });
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await resultPromise;

      expect(requestSignal?.aborted).toBe(true);
      expect(result).toMatchObject({ status: "unavailable", failureReason: "request-timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});
