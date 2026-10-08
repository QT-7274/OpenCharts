import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AnalysisAttempt } from "../../services/analysis/pipeline.ts";
import { AnalysisReadiness } from "./AnalysisReadiness.tsx";

const { getLatest } = vi.hoisted(() => ({ getLatest: vi.fn() }));
vi.mock("../../services/analysis/runtime.ts", () => ({
  analysisPipeline: { getLatest, subscribe: () => () => undefined },
}));
vi.mock("../../services/market-data/runtime.ts", () => ({ marketDataMode: "binance" }));

describe("analysis output", () => {
  it("crypto-ai-analysis.ANALYSIS_OUTPUT.1 shows invalidation conditions when no entry plan exists", () => {
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
    };
    getLatest.mockReturnValue(attempt);

    render(<AnalysisReadiness symbol="BTCUSDT" />);

    expect(screen.getByText(/数据不足 · 暂不入场/)).toBeInTheDocument();
    expect(screen.getByText(/失效条件：多周期趋势或回调结构失效/)).toBeInTheDocument();
    expect(screen.getByText(/已过期/)).toBeInTheDocument();
  });
});
