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
});
