import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalysisAttempt } from "../../services/analysis/pipeline.ts";
import type { PaperLedgerState, PaperOrderDraft } from "../../services/analysis/paper-trading.ts";
import { CryptoPaperPanel } from "./CryptoPaperPanel.tsx";

const { getState, getRiskContext, subscribe } = vi.hoisted(() => ({
  getState: vi.fn(),
  getRiskContext: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}));

vi.mock("../../services/analysis/runtime.ts", () => ({
  cryptoPaperLedger: { getState, getRiskContext, subscribe },
}));

function createAttempt(): AnalysisAttempt {
  return {
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
    aiExplanation: null,
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
}

function createState(): PaperLedgerState {
  return {
    schemaVersion: 1,
    initialCapital: 10_000,
    cash: 9_000,
    orders: [{
      id: "order-1",
      symbol: "BTCUSDT",
      status: "pending",
      snapshotId: "snapshot-1",
      strategyVersion: "trend-pullback-v1",
      backtestStatus: "invalid",
      costAssumptions: { buyFeeRate: 0.001, sellFeeRate: 0.001, buySlippageRate: 0.0005, sellSlippageRate: 0.0005 },
      createdAtMs: 1_760_000_000_100,
      updatedAtMs: 1_760_000_000_100,
      analysisTimeMs: 1_760_000_000_000,
      validFromMs: 1_760_000_003_600,
      expiresAtMs: 1_760_010_000_000,
      referencePrice: 100,
      entryLower: 99,
      entryUpper: 101,
      stopPrice: 95,
      takeProfit1Price: 110,
      takeProfit2Price: 115,
      riskReward: 2,
      pullbackLow: 94,
      quantity: 1,
      remainingQuantity: 0,
      riskAmount: 100,
      reservedQuote: 101,
      fillTimeMs: null,
      actualEntryPrice: null,
      entryFee: 0,
      entrySlippage: 0,
      exitFees: 0,
      exitSlippage: 0,
      realizedNetPnl: 0,
      averageExitPrice: null,
      exitedQuantity: 0,
      partialTaken: false,
      activeStopPrice: 95,
      exitReason: null,
      closedAtMs: null,
    }],
    events: [{
      id: "event-1",
      kind: "data-gap",
      symbol: "BTCUSDT",
      timeMs: 1_760_000_000_200,
      snapshotId: null,
      strategyVersion: null,
      price: null,
      fee: null,
      slippage: null,
      reason: "缺少闭合行情",
    }],
    lastProcessedOpenTimeMs: { BTCUSDT: 1_760_000_000_000 },
    lastAnalyzedOpenTimeMs: { BTCUSDT: 1_760_000_000_000 },
    lastPrices: { BTCUSDT: 100 },
    pausedSymbols: { BTCUSDT: "缺少闭合行情" },
  };
}

function createEnterAttempt(): AnalysisAttempt {
  const attempt = createAttempt();
  attempt.status = "ready";
  attempt.currentPrice = 100;
  attempt.currentPriceObservedAtMs = attempt.analysisTimeMs;
  attempt.currentPriceServerTimeMs = attempt.analysisTimeMs;
  attempt.strategy = {
    state: "enter",
    avoidReason: null,
    score: 85,
    scoreBreakdown: { trendQuality: 30, pullbackQuality: 20, priceConfirmation: 20, momentum: 15, volume: 10, volatilityAndFreshness: 5, total: 100 },
    dataTimely: true,
    volatilityQualified: true,
    pullback: { enteredZone: true, heldInvalidation: true, latestCloseAtOrAboveEma20: true, valid: true, touchIndex: 1, barsSinceTouch: 0, zoneLower: 99, zoneUpper: 101, invalidationLine: 95, lowestLow: 96 },
    confirmation: { ema20Reclaim: true, breakoutAbovePriorThreeHigh: false, priceTrigger: true, bothPriceTriggers: false, bullishCandle: true, rsiAtLeast50: true, rsiRising: true, passed: true, priorThreeHigh: 101 },
    riskReward: 2,
    entryPlanStatus: "active",
  };
  attempt.entryPlan = {
    referencePrice: 100,
    entryLower: 99,
    entryUpper: 101,
    pullbackLow: 95,
    structureStop: 94,
    volatilityStop: 90,
    stop: 90,
    riskPerUnit: 10,
    takeProfit1: 120,
    takeProfit2: 130,
    riskReward: 2,
    riskBudgetAmount: 100,
    suggestedQuantity: 5,
    suggestedNotional: 500,
    estimatedStopRisk: 50,
    quantityRules: { minQty: 0.01, maxQty: 100, stepSize: 0.01 },
    validFromMs: attempt.analysisTimeMs! + 1,
    expiresAtMs: attempt.analysisTimeMs! + 3_600_000,
    currentPrice: 100,
    currentPriceObservedAtMs: attempt.analysisTimeMs!,
    status: "active",
    failure: null,
  };
  return attempt;
}

describe("crypto paper panel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("crypto-ai-analysis.FORWARD_SIMULATION.9 crypto-ai-analysis.FORWARD_SIMULATION.11 shows runtime health, trade records, and runtime events", async () => {
    const state = createState();
    getState.mockReturnValue(state);
    getRiskContext.mockReturnValue({ accountEquity: 10_000, availableQuoteBalance: 9_000 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ledger: state,
        riskContext: { accountEquity: 10_000, availableQuoteBalance: 9_000 },
        costComparison: {
          simulatedFees: 0,
          expectedFees: 0,
          feeDifference: 0,
          simulatedSlippage: 0,
          expectedSlippage: 0,
          slippageDifference: 0,
        },
        backtestStatus: {
          status: "invalid",
          strategyVersion: "trend-pullback-v1",
          updatedAtMs: 1_760_000_000_400,
          reportGeneratedAtMs: null,
        },
        runtime: {
          connection: "live",
          ready: false,
          recovering: false,
          lastMarketAtMs: 1_760_000_000_300,
          lastSuccessfullyProcessedAtMs: 1_760_000_000_000,
          pausedSymbols: state.pausedSymbols,
          storageStatus: "ok",
          runtimeFailure: null,
        },
        storageError: null,
      }),
    }));

    render(<CryptoPaperPanel attempt={createAttempt()} />);

    await waitFor(() => expect(screen.getByText("部分币种已暂停")).toBeInTheDocument());
    expect(screen.getAllByText(/2025-10-09 08:53:20 UTC/).length).toBeGreaterThan(0);
    expect(screen.getByText("回测费率假设：无可用回测报告，费用差值暂不比较。")).toBeInTheDocument();
    expect(screen.getByText(/回测报告更新时间/).parentElement?.textContent).toContain("2025-10-09 08:53:20 UTC");
    expect(screen.getByRole("table", { name: "模拟交易记录" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /运行事件/ }));
    expect(await screen.findByText("数据中断")).toBeInTheDocument();
    expect(screen.getAllByRole("status").some((element) => element.textContent?.includes("缺少闭合行情"))).toBe(true);
    expect(screen.getByText("BTCUSDT")).toBeInTheDocument();
  });

  it("crypto-ai-analysis.FORWARD_SIMULATION.11-1 shows persisted backtest time and report cost assumptions", async () => {
    const state = createState();
    getState.mockReturnValue(state);
    getRiskContext.mockReturnValue({ accountEquity: 10_000, availableQuoteBalance: 9_000 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ledger: state,
        riskContext: { accountEquity: 10_000, availableQuoteBalance: 9_000 },
        costComparison: {
          simulatedFees: 1.2,
          expectedFees: 1.1,
          feeDifference: 0.1,
          simulatedSlippage: 0.6,
          expectedSlippage: 0.5,
          slippageDifference: 0.1,
        },
        backtestStatus: {
          status: "experimental",
          strategyVersion: "trend-pullback-v1",
          updatedAtMs: 1_760_000_010_000,
          reportGeneratedAtMs: 1_760_000_009_000,
          costAssumptions: { buyFeeRate: 0.002, sellFeeRate: 0.003, buySlippageRate: 0.001, sellSlippageRate: 0.0015 },
        },
        runtime: {
          connection: "live",
          ready: true,
          recovering: false,
          lastMarketAtMs: 1_760_000_000_300,
          lastSuccessfullyProcessedAtMs: 1_760_000_000_000,
          pausedSymbols: {},
          storageStatus: "ok",
          runtimeFailure: null,
        },
        storageError: null,
      }),
    }));

    render(<CryptoPaperPanel attempt={createAttempt()} />);

    await waitFor(() => expect(screen.getByText(/回测报告费率买\/卖 0.2% \/ 0.3%/)).toBeInTheDocument());
    expect(screen.getByText(/回测报告滑点买\/卖 0.1% \/ 0.15%/)).toBeInTheDocument();
    expect(screen.getByText(/回测报告更新时间/).parentElement?.textContent).toContain("2025-10-09 08:53:30 UTC");
  });

  it("crypto-ai-analysis.RISK_AND_PAPER_TRADING.8 shows reference price and separate modeled costs before confirmation", async () => {
    const state = createState();
    state.orders = [];
    state.pausedSymbols = {};
    getState.mockReturnValue(state);
    getRiskContext.mockReturnValue({ accountEquity: 10_000, availableQuoteBalance: 9_000 });
    const draft: PaperOrderDraft = {
      symbol: "BTCUSDT",
      snapshotId: "snapshot-1",
      strategyVersion: "trend-pullback-v1",
      backtestStatus: "experimental",
      costAssumptions: { buyFeeRate: 0.001, sellFeeRate: 0.001, buySlippageRate: 0.0005, sellSlippageRate: 0.0005 },
      analysisTimeMs: 1_760_000_000_000,
      validFromMs: 1_760_000_000_001,
      expiresAtMs: Date.now() + 60_000,
      referencePrice: 100,
      entryLower: 99,
      entryUpper: 101,
      stopPrice: 90,
      takeProfit1Price: 120,
      takeProfit2Price: 130,
      riskReward: 2,
      pullbackLow: 95,
      quantity: 5,
      riskAmount: 50,
      estimatedFees: 1.4,
      estimatedSlippage: 0.95,
      estimatedCosts: 2.35,
    };
    const snapshot = {
      ledger: state,
      riskContext: { accountEquity: 10_000, availableQuoteBalance: 9_000 },
      costComparison: { simulatedFees: 0, expectedFees: 0, feeDifference: 0, simulatedSlippage: 0, expectedSlippage: 0, slippageDifference: 0 },
      backtestStatus: { status: "experimental" as const, strategyVersion: "trend-pullback-v1", updatedAtMs: 1, reportGeneratedAtMs: 1, costAssumptions: draft.costAssumptions },
      runtime: { connection: "live", ready: true, recovering: false, lastMarketAtMs: 1, lastSuccessfullyProcessedAtMs: 1, pausedSymbols: {}, storageStatus: "ok" as const, runtimeFailure: null },
      storageError: null,
    };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: string) => {
      if (input.endsWith("/state")) return { ok: true, json: async () => snapshot };
      if (input.endsWith("/analyze")) return { ok: true, json: async () => ({ snapshotId: "snapshot-1" }) };
      if (input.endsWith("/drafts")) return { ok: true, json: async () => ({ id: "draft-1", draft }) };
      throw new Error(`Unexpected request ${input}`);
    }));

    render(<CryptoPaperPanel attempt={createEnterAttempt()} />);
    const prefill = await screen.findByRole("button", { name: /带入模拟订单/ });
    fireEvent.click(prefill);

    expect(await screen.findByText("参考入场价")).toBeInTheDocument();
    expect(screen.getByText("预计手续费 / 滑点")).toBeInTheDocument();
    expect(screen.getByText("1.4 / 0.95 USDT")).toBeInTheDocument();
  });
});
