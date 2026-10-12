import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BacktestPage } from "./BacktestPage.tsx";
import { BacktestHistoryValidationError } from "../services/analysis/backtest-history.ts";

const { loadHistory, runBacktest } = vi.hoisted(() => ({
  loadHistory: vi.fn(),
  runBacktest: vi.fn(),
}));

vi.mock("../services/analysis/backtest.ts", () => ({
  DEFAULT_BACKTEST_CONFIG: {
    initialCapital: 10_000,
    buyFeeRate: 0.001,
    sellFeeRate: 0.001,
    buySlippageRate: 0.0005,
    sellSlippageRate: 0.0005,
    maxTradeRiskFraction: 0.01,
    maxPortfolioRiskFraction: 0.03,
  },
  runCryptoBacktest: runBacktest,
}));

vi.mock("../services/analysis/backtest-history.ts", () => ({
  BacktestHistoryValidationError: class BacktestHistoryValidationError extends Error {},
  loadCryptoBacktestHistory: loadHistory,
}));

describe("backtest validation UI", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("crypto-ai-analysis.VALIDATION.14-1 marks rejected runtime data invalid", async () => {
    loadHistory.mockResolvedValue({
      assets: [],
      requestedPeriod: { startMs: 1, endMs: 2 },
    });
    runBacktest.mockImplementation(() => {
      throw new Error("回测历史区间无效");
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    render(<BacktestPage />);
    fireEvent.click(screen.getByRole("button", { name: "加载行情并回测" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("invalid");
    expect(screen.queryByText("实验性结果")).not.toBeInTheDocument();
  });

  it("crypto-ai-analysis.VALIDATION.4 marks invalid history without classifying network errors as invalid", async () => {
    const firstPage = render(<BacktestPage />);
    loadHistory.mockRejectedValueOnce(new BacktestHistoryValidationError("历史行情尾部不完整"));
    fireEvent.click(screen.getByRole("button", { name: "加载行情并回测" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid");

    firstPage.unmount();
    loadHistory.mockRejectedValueOnce(new Error("Binance 请求超时"));
    render(<BacktestPage />);
    fireEvent.click(screen.getByRole("button", { name: "加载行情并回测" }));
    expect(await screen.findByRole("alert")).not.toHaveTextContent("invalid");
  });

  it("crypto-ai-analysis.VALIDATION.15 crypto-ai-analysis.VALIDATION.16 crypto-ai-analysis.VALIDATION.17 shows separated robustness results", async () => {
    loadHistory.mockResolvedValue({
      assets: [],
      requestedPeriod: { startMs: 1, endMs: 2 },
    });
    const metrics = {
      signalCount: 0,
      tradeCount: 0,
      skippedSignalCount: 0,
      skipReasons: {},
      strategyStateCounts: { watch: 0, setup: 0, enter: 0, avoid: 0 },
      winRatePct: null,
      netReturnPct: 0,
      annualizedReturnPct: null,
      profitFactor: null,
      maxDrawdownPct: 0,
      averageNetPnl: null,
      averageHoldingHours: null,
      averageActualRiskReward: null,
      totalCosts: 0,
      maxConsecutiveLosses: 0,
      sharpeRatio: null,
      endingEquity: 10_000,
    };
    const period = { startMs: 1, endMs: 2 };
    const periodResult = {
      period,
      metrics,
      buyAndHold: {
        netReturnPct: 0,
        maxDrawdownPct: 0,
        sharpeRatio: null,
        netReturnDifferencePct: 0,
        maxDrawdownDifferencePct: 0,
        sharpeDifference: null,
      },
      trades: [],
    };
    runBacktest.mockReturnValue({
      strategyVersion: "trend-pullback-v1",
      status: "experimental",
      statusReason: "样本不足",
      generatedAtMs: 2,
      requestedPeriod: period,
      symbols: {},
      portfolio: { research: periodResult, outOfSample: periodResult },
      robustness: {
        walkForward: [{ id: 1, trainingPeriod: period, testPeriod: period, sampleSufficient: false, metrics }],
        marketRegimes: [{ regime: "bull", tradeCount: 1, netPnl: 2, winRatePct: 100, profitFactor: "infinite" }],
        parameterSensitivity: [{ minimumScore: 65, strategyVersion: "trend-pullback-v1-score-65", evaluationScope: "research-only", period, metrics }],
      },
      validityChecks: { closedCandlesOnly: true, nextBarExecution: true, deterministicEngine: true },
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    render(<BacktestPage />);
    fireEvent.click(screen.getByRole("button", { name: "加载行情并回测" }));

    expect(await screen.findByText("滚动样本外验证")).toBeInTheDocument();
    expect(screen.getByText("按市场阶段")).toBeInTheDocument();
    expect(screen.getByText("评分门槛敏感性")).toBeInTheDocument();
    expect(screen.getByText("trend-pullback-v1-score-65")).toBeInTheDocument();
    expect(screen.getByText(/DD 0% · Sharpe —/)).toBeInTheDocument();
    expect(screen.getByText(/胜率 100% · PF ∞/)).toBeInTheDocument();
  });
});
