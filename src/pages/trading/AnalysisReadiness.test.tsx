import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AnalysisAttempt } from "../../services/analysis/pipeline.ts";
import { AnalysisReadiness } from "./AnalysisReadiness.tsx";

const { getLatest, subscribe, updateAiSnapshot, requestAiExplanation } = vi.hoisted(() => ({
  getLatest: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
  updateAiSnapshot: vi.fn(),
  requestAiExplanation: vi.fn(),
}));
vi.mock("../../services/analysis/runtime.ts", () => ({
  analysisPipeline: { getLatest, subscribe, updateAiSnapshot },
}));
vi.mock("./CryptoPaperPanel.tsx", () => ({ CryptoPaperPanel: () => null }));
vi.mock("../../services/market-data/runtime.ts", () => ({ marketDataMode: "binance" }));
vi.mock("../../services/analysis/ai-explanation-client.ts", () => ({ requestAiExplanation }));

describe("analysis output", () => {
  it("crypto-ai-analysis.ANALYSIS_OUTPUT.1 crypto-ai-analysis.ANALYSIS_SNAPSHOT.5 shows invalidation conditions and persistence errors", () => {
    const now = Date.now();
    const attempt: AnalysisAttempt = {
      symbol: "BTCUSDT",
      trigger: "manual",
      analysisTimeMs: 1_710_003_600_000,
      status: "insufficient-data",
      decision: "暂不入场",
      reason: "数据不足或多周期数据不同步",
      candleCloseTimes: { "1d": null, "4h": null, "1h": null },
      windows: { "1d": [], "4h": [], "1h": [] },
      issues: [{ interval: "1h", code: "unavailable" }],
      strategyVersion: "trend-pullback-v1",
      snapshotId: "snapshot-1",
      aiInputSummary: null,
      aiExplanation: null,
      indicators: null,
      trend: null,
      strategy: null,
      currentPrice: 100,
      currentPriceObservedAtMs: now - 31_000,
      currentPriceServerTimeMs: now - 2_000,
      supportResistance: { support: null, resistance: null },
      signal: null,
      entryPlan: null,
      entryPlanFailure: null,
      persistenceError: "analysis-snapshot",
    };
    getLatest.mockReturnValue(attempt);

    render(<AnalysisReadiness symbol="BTCUSDT" />);

    expect(screen.getByText(/数据不足 · 暂不入场/)).toBeInTheDocument();
    expect(screen.getByText(/失效条件：多周期趋势或回调结构失效/)).toBeInTheDocument();
    expect(screen.getByText(/已过期/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("未能保存到本地");
  });

  it("crypto-ai-analysis.AI_EXPLANATION.6-1 and crypto-ai-analysis.AI_EXPLANATION.8-1 keeps algorithm status separate and offers explicit regeneration", async () => {
    const attempt: AnalysisAttempt = {
      symbol: "BTCUSDT",
      trigger: "manual",
      analysisTimeMs: 1_760_000_000_000,
      status: "insufficient-data",
      decision: "暂不入场",
      reason: "数据不足或多周期数据不同步",
      candleCloseTimes: { "1d": null, "4h": null, "1h": null },
      windows: { "1d": [], "4h": [], "1h": [] },
      issues: [{ interval: "1h", code: "unavailable" }],
      strategyVersion: "trend-pullback-v1",
      snapshotId: "snapshot-1",
      aiInputSummary: null,
      aiExplanation: {
        status: "unavailable",
        provider: "openai",
        modelId: "gpt-6-luna",
        promptVersion: "crypto-ai-explanation-v1",
        schemaVersion: "crypto-ai-explanation-v1",
        requestedAtMs: 1_760_000_000_001,
        respondedAtMs: 1_760_000_000_002,
        tokenUsage: null,
        rawResponse: null,
        validationResult: "unavailable",
        failureReason: "backend-unavailable",
        explanation: null,
      },
      indicators: null,
      trend: null,
      strategy: null,
      currentPrice: null,
      currentPriceObservedAtMs: null,
      currentPriceServerTimeMs: null,
      supportResistance: { support: null, resistance: null },
      signal: null,
      entryPlan: null,
      entryPlanFailure: null,
    };
    getLatest.mockReturnValue(attempt);
    requestAiExplanation.mockResolvedValue({
      ...attempt.aiExplanation,
      status: "available",
      modelId: "gpt-6-luna-2026-01-01",
      validationResult: "valid",
      failureReason: null,
      explanation: {
        summary: "数据不足，暂不入场。",
        trendExplanation: "当前无法验证多周期趋势。",
        indicatorEvidence: ["指标尚不可用。"],
        entryExplanation: "数据完整前不生成入场计划。",
        riskExplanation: "当前没有有效风险计划。",
        cautionNotes: [],
        educationalNotes: [],
      },
    });

    render(<AnalysisReadiness symbol="BTCUSDT" />);
    expect(screen.getByText("数据不足 · 暂不入场")).toBeInTheDocument();
    expect(screen.getByText("AI 解释暂不可用")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新生成解释" }));

    await waitFor(() => expect(requestAiExplanation).toHaveBeenCalledWith(
      "snapshot-1", attempt, { regenerate: true },
    ));
    await waitFor(() => expect(updateAiSnapshot).toHaveBeenCalledWith(
      "snapshot-1", expect.objectContaining({ aiExplanation: expect.objectContaining({ status: "available" }) }),
    ));
    expect(screen.getByText("数据不足 · 暂不入场")).toBeInTheDocument();
  });
});
