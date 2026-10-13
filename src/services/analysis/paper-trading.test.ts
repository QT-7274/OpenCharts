import { describe, expect, it, vi } from "vitest";
import { createCryptoPaperLedger, CRYPTO_PAPER_LEDGER_KEY, type PaperLedgerState } from "./paper-trading.ts";
import type { AnalysisAttempt } from "./pipeline.ts";
import { DEFAULT_BACKTEST_CONFIG } from "./backtest.ts";
import { intervalToMs, type MarketCandle, type SpotSymbol } from "../market-data/types.ts";

const HOUR = intervalToMs("1h");
const START = Date.UTC(2026, 0, 1);
const fixedNow = START + HOUR - 1;

function makeAttempt(symbol: SpotSymbol = "BTCUSDT"): AnalysisAttempt {
  return {
    symbol,
    trigger: "hourly-close",
    analysisTimeMs: fixedNow,
    status: "ready",
    decision: "暂不入场",
    reason: null,
    candleCloseTimes: { "1d": fixedNow, "4h": fixedNow, "1h": fixedNow },
    windows: { "1d": [], "4h": [], "1h": [] },
    issues: [],
    strategyVersion: "trend-pullback-v1",
    indicators: null,
    trend: null,
    strategy: {
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
    },
    currentPrice: 100,
    currentPriceObservedAtMs: fixedNow,
    currentPriceServerTimeMs: fixedNow,
    supportResistance: { support: null, resistance: null },
    signal: null,
    entryPlan: {
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
      suggestedQuantity: 50,
      suggestedNotional: 5_000,
      estimatedStopRisk: 500,
      quantityRules: { minQty: 0.01, maxQty: 100, stepSize: 0.01 },
      validFromMs: fixedNow + 1,
      expiresAtMs: fixedNow + 3 * HOUR,
      currentPrice: 100,
      currentPriceObservedAtMs: fixedNow,
      status: "active",
      failure: null,
    },
    entryPlanFailure: null,
    snapshotId: `snapshot-${symbol}`,
  };
}

function candle(openTimeMs: number, overrides: Partial<MarketCandle> = {}): MarketCandle {
  return {
    symbol: "BTCUSDT",
    interval: "1h",
    openTimeMs,
    closeTimeMs: openTimeMs + HOUR - 1,
    open: 100,
    high: 105,
    low: 98,
    close: 100,
    volume: 10,
    quoteVolume: 1_000,
    tradeCount: 10,
    isClosed: true,
    source: "rest",
    ...overrides,
  };
}

function memoryStorage() {
  let value: string | null = null;
  return {
    getItem: vi.fn((key: string) => key === CRYPTO_PAPER_LEDGER_KEY ? value : null),
    setItem: vi.fn((key: string, next: string) => { if (key === CRYPTO_PAPER_LEDGER_KEY) value = next; }),
    read: () => value,
  };
}

describe("isolated crypto paper ledger", () => {
  it("crypto-ai-analysis.FORWARD_SIMULATION.2 retains the full simulated event audit trail", () => {
    let now = fixedNow;
    const ledger = createCryptoPaperLedger({ now: () => ++now });
    for (let index = 0; index < 1_005; index += 1) ledger.pauseSymbol("BTCUSDT", `event-${index}`);
    expect(ledger.getState().events).toHaveLength(1_005);
    expect(ledger.getState().events[0]?.reason).toBe("event-0");
  });

  it("crypto-ai-analysis.RISK_AND_PAPER_TRADING.11-1 cancels pending orders on invalid analysis without requiring a snapshot", () => {
    const ledger = createCryptoPaperLedger({ now: () => fixedNow });
    ledger.submitDraft(ledger.createDraft(makeAttempt(), "experimental"));
    const invalid = makeAttempt();
    invalid.strategy!.state = "avoid";
    invalid.strategy!.avoidReason = "trend-not-qualified";
    delete invalid.snapshotId;
    ledger.recordAnalysis(invalid);
    expect(ledger.getState().orders[0]!.status).toBe("cancelled");
  });

  it("crypto-ai-analysis.FORWARD_SIMULATION.6 rejects invalid OHLCV without advancing a checkpoint", async () => {
    const ledger = createCryptoPaperLedger({ now: () => fixedNow });
    ledger.submitDraft(ledger.createDraft(makeAttempt(), "experimental"));
    await ledger.processClosedCandle(candle(START + HOUR, { close: NaN }), { getCandles: vi.fn() } as never);
    expect(ledger.getState().lastProcessedOpenTimeMs.BTCUSDT).toBe(START);
    expect(ledger.getState().orders[0]!.status).toBe("pending");
    expect(ledger.getState().pausedSymbols.BTCUSDT).toBeTruthy();
  });
  it("crypto-ai-analysis.RISK_AND_PAPER_TRADING.12 keeps paper equity isolated from terminal accounts", () => {
    const ledger = createCryptoPaperLedger({ now: () => fixedNow });
    expect(ledger.getRiskContext()).toEqual({ accountEquity: 10_000, availableQuoteBalance: 10_000 });
    expect(ledger.getState().initialCapital).toBe(10_000);
    expect(ledger.getState().orders).toEqual([]);
  });

  it("crypto-ai-analysis.RISK_AND_PAPER_TRADING.6 crypto-ai-analysis.RISK_AND_PAPER_TRADING.6-1 requires a separate submit action", () => {
    const ledger = createCryptoPaperLedger({ now: () => fixedNow });
    const draft = ledger.createDraft(makeAttempt(), "experimental");
    expect(draft.quantity).toBeLessThanOrEqual(10);
    expect(draft.riskAmount).toBeLessThanOrEqual(100);
    expect(draft.estimatedFees).toBeGreaterThan(0);
    expect(draft.estimatedSlippage).toBeGreaterThan(0);
    expect(draft.estimatedCosts).toBeCloseTo(draft.estimatedFees + draft.estimatedSlippage);
    expect(ledger.getState().orders).toHaveLength(0);

    const order = ledger.submitDraft(draft);
    expect(order.status).toBe("pending");
    expect(order.snapshotId).toBe("snapshot-BTCUSDT");
    expect(order.backtestStatus).toBe("experimental");
  });

  it("crypto-ai-analysis.RISK_AND_PAPER_TRADING.7-1 enforces the portfolio risk cap", () => {
    const ledger = createCryptoPaperLedger({ now: () => fixedNow });
    for (const symbol of ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const) {
      ledger.submitDraft(ledger.createDraft(makeAttempt(symbol), "experimental"));
    }
    expect(() => ledger.createDraft(makeAttempt("BNBUSDT"), "experimental")).toThrow(/风险限制/);
  });

  it("crypto-ai-analysis.FORWARD_SIMULATION.1 crypto-ai-analysis.FORWARD_SIMULATION.3 fills only on a later closed candle and applies stop priority", async () => {
    const storage = memoryStorage();
    const ledger = createCryptoPaperLedger({ storage, now: () => fixedNow });
    const order = ledger.submitDraft(ledger.createDraft(makeAttempt(), "experimental"));
    const restAdapter = { getCandles: vi.fn() } as never;

    await ledger.processClosedCandle(candle(START + HOUR), restAdapter);
    const filled = ledger.getState().orders.find((item) => item.id === order.id)!;
    expect(filled.status).toBe("open");
    expect(filled.fillTimeMs).toBe(START + HOUR);
    expect(ledger.getState().events.some((event) => event.kind === "fill")).toBe(true);

    await ledger.processClosedCandle(candle(START + 2 * HOUR, { low: 85, high: 140 }), restAdapter);
    const closed = ledger.getState().orders.find((item) => item.id === order.id)!;
    expect(closed.status).toBe("closed");
    expect(closed.exitReason).toBe("stop");
    expect(closed.realizedNetPnl).toBeLessThan(0);
  });

  it("crypto-ai-analysis.VALIDATION.6-1 crypto-ai-analysis.FORWARD_SIMULATION.3 fills an entry candle before applying its stop", async () => {
    const ledger = createCryptoPaperLedger({ now: () => fixedNow });
    const order = ledger.submitDraft(ledger.createDraft(makeAttempt(), "experimental"));
    await ledger.processClosedCandle(candle(START + HOUR, { low: 85, high: 140 }), { getCandles: vi.fn() } as never);
    const closed = ledger.getState().orders.find((item) => item.id === order.id)!;
    expect(closed.status).toBe("closed");
    expect(closed.fillTimeMs).toBe(START + HOUR);
    expect(closed.exitReason).toBe("stop");
    expect(ledger.getState().events.map((event) => event.kind)).toContain("fill");
    expect(ledger.getState().events.map((event) => event.kind)).toContain("stop");
  });

  it("crypto-ai-analysis.FORWARD_SIMULATION.11 reports modeled cost deviation from the backtest rates", async () => {
    const ledger = createCryptoPaperLedger({ now: () => fixedNow });
    const order = ledger.submitDraft(ledger.createDraft(makeAttempt(), "experimental"));
    await ledger.processClosedCandle(candle(START + HOUR), { getCandles: vi.fn() } as never);
    await ledger.processClosedCandle(candle(START + 2 * HOUR, { low: 85 }), { getCandles: vi.fn() } as never);
    const costs = ledger.getCostComparison();
    expect(costs.simulatedFees).toBeGreaterThan(0);
    expect(costs.simulatedSlippage).toBeGreaterThan(0);
    expect(costs.feeDifference).toBeCloseTo(0, 8);
    expect(costs.slippageDifference).toBeCloseTo(0, 8);
    expect(ledger.getState().orders[0]?.id).toBe(order.id);
  });

  it("crypto-ai-analysis.FORWARD_SIMULATION.5 binds custom backtest cost assumptions to the order", async () => {
    const ledger = createCryptoPaperLedger({ now: () => fixedNow });
    const costs = { buyFeeRate: 0.002, sellFeeRate: 0.003, buySlippageRate: 0.001, sellSlippageRate: 0.0015 };
    const order = ledger.submitDraft(ledger.createDraft(makeAttempt(), "experimental", costs));
    await ledger.processClosedCandle(candle(START + HOUR), { getCandles: vi.fn() } as never);

    expect(order.costAssumptions).toEqual(costs);
    expect(ledger.getState().orders[0]?.costAssumptions).toEqual(costs);
    const comparison = ledger.getCostComparison();
    expect(comparison.simulatedFees).toBeGreaterThan(0);
    expect(comparison.simulatedFees).toBeCloseTo(comparison.expectedFees, 8);
    expect(comparison.simulatedSlippage).toBeCloseTo(comparison.expectedSlippage, 8);
  });

  it("crypto-ai-analysis.RISK_AND_PAPER_TRADING.12-3 crypto-ai-analysis.FORWARD_SIMULATION.4 restores orders and checkpoints after reload", () => {
    const storage = memoryStorage();
    const original = createCryptoPaperLedger({ storage, now: () => fixedNow });
    original.submitDraft(original.createDraft(makeAttempt(), "experimental"));
    const restored = createCryptoPaperLedger({ storage, now: () => fixedNow });
    const state: PaperLedgerState = restored.getState();
    expect(state.initialCapital).toBe(10_000);
    expect(state.orders[0]?.status).toBe("pending");
    expect(state.lastProcessedOpenTimeMs.BTCUSDT).toBe(START);
  });

  it("crypto-ai-analysis.FORWARD_SIMULATION.4 crypto-ai-analysis.FORWARD_SIMULATION.6 pauses on an unfillable gap", async () => {
    const ledger = createCryptoPaperLedger({ now: () => fixedNow });
    const order = ledger.submitDraft(ledger.createDraft(makeAttempt(), "experimental"));
    const restAdapter = { getCandles: vi.fn().mockResolvedValue([]) } as never;
    await ledger.processClosedCandle(candle(START + HOUR), restAdapter);
    await ledger.processClosedCandle(candle(START + 3 * HOUR), restAdapter);

    expect(ledger.getState().pausedSymbols.BTCUSDT).toMatch(/未返回完整/);
    expect(ledger.getState().orders.find((item) => item.id === order.id)?.status).toBe("open");
  });

  it("crypto-ai-analysis.RELIABILITY.1 fills gaps in chronological order and ignores duplicate candles", async () => {
    const processed: number[] = [];
    const ledger = createCryptoPaperLedger({ now: () => fixedNow, afterCandle: async (row) => { processed.push(row.openTimeMs); } });
    ledger.submitDraft(ledger.createDraft(makeAttempt(), "experimental"));
    await ledger.processClosedCandle(candle(START + HOUR), { getCandles: vi.fn() } as never);
    const restAdapter = { getCandles: vi.fn().mockResolvedValue([candle(START + 3 * HOUR), candle(START + 2 * HOUR)]) } as never;
    await ledger.processClosedCandle(candle(START + 4 * HOUR), restAdapter);
    const beforeRepeat = ledger.getState();
    await ledger.processClosedCandle(candle(START + 4 * HOUR), restAdapter);
    expect(processed).toEqual([START + HOUR, START + 2 * HOUR, START + 3 * HOUR, START + 4 * HOUR]);
    expect(ledger.getState()).toEqual(beforeRepeat);
    expect(ledger.getState().events.filter((event) => event.kind === "fill")).toHaveLength(1);
    expect(ledger.getState().events.filter((event) => event.kind === "data-restored")).toHaveLength(1);
  });

  it("crypto-ai-analysis.FORWARD_SIMULATION.4-1 crypto-ai-analysis.RELIABILITY.1-1 retries analysis without replaying a fill", async () => {
    const afterCandle = vi.fn().mockRejectedValueOnce(new Error("temporary analysis failure"));
    const ledger = createCryptoPaperLedger({ now: () => fixedNow, afterCandle });
    const order = ledger.submitDraft(ledger.createDraft(makeAttempt(), "experimental"));
    const row = candle(START + HOUR);
    const restAdapter = { getCandles: vi.fn() } as never;

    await ledger.processClosedCandle(row, restAdapter);
    expect(ledger.getState().lastProcessedOpenTimeMs.BTCUSDT).toBe(row.openTimeMs);
    expect(ledger.getState().lastAnalyzedOpenTimeMs.BTCUSDT).toBe(START);
    expect(ledger.getState().pausedSymbols.BTCUSDT).toBeTruthy();

    afterCandle.mockResolvedValue(undefined);
    await ledger.processClosedCandle(row, restAdapter);
    expect(ledger.getState().lastAnalyzedOpenTimeMs.BTCUSDT).toBe(row.openTimeMs);
    expect(ledger.getState().pausedSymbols.BTCUSDT).toBeUndefined();
    expect(ledger.getState().orders.find((item) => item.id === order.id)?.status).toBe("open");
    expect(ledger.getState().events.filter((event) => event.kind === "fill")).toHaveLength(1);
    expect(afterCandle).toHaveBeenCalledTimes(2);
  });

  it("crypto-ai-analysis.RELIABILITY.1-2 restores outages in REST-sized batches", async () => {
    const ledger = createCryptoPaperLedger({ now: () => fixedNow });
    ledger.submitDraft(ledger.createDraft(makeAttempt(), "experimental"));
    const first = candle(START + HOUR);
    await ledger.processClosedCandle(first, { getCandles: vi.fn() } as never);
    const getCandles = vi.fn(async ({ startTimeMs, limit }: { startTimeMs: number; limit: number }) =>
      Array.from({ length: limit }, (_, index) => candle(startTimeMs + index * HOUR)));
    const latest = candle(START + 1_003 * HOUR);

    await ledger.processClosedCandle(latest, { getCandles } as never);

    expect(getCandles.mock.calls.map(([request]) => request.limit)).toEqual([1_000, 1]);
    expect(ledger.getState().lastProcessedOpenTimeMs.BTCUSDT).toBe(latest.openTimeMs);
    expect(ledger.getState().lastAnalyzedOpenTimeMs.BTCUSDT).toBe(latest.openTimeMs);
    expect(ledger.getState().pausedSymbols.BTCUSDT).toBeUndefined();
  });

  it("crypto-ai-analysis.RISK_AND_PAPER_TRADING.12-3 keeps state unchanged and blocks orders after a storage failure", () => {
    const storage = memoryStorage();
    const ledger = createCryptoPaperLedger({ storage, now: () => fixedNow });
    const draft = ledger.createDraft(makeAttempt(), "experimental");
    storage.setItem.mockImplementation(() => { throw new Error("Disk unavailable"); });
    expect(() => ledger.submitDraft(draft)).toThrow(/保存失败/);
    expect(ledger.getState().orders).toHaveLength(0);
    expect(ledger.getRuntimeError()).toBe("Disk unavailable");
    expect(() => ledger.createDraft(makeAttempt(), "experimental")).toThrow(/存储不可用/);
  });

  it("crypto-ai-analysis.FORWARD_SIMULATION.4 clears a disconnect pause at the existing checkpoint without replaying a fill", async () => {
    const ledger = createCryptoPaperLedger({ now: () => fixedNow });
    ledger.submitDraft(ledger.createDraft(makeAttempt(), "experimental"));
    const restAdapter = { getCandles: vi.fn() } as never;
    await ledger.processClosedCandle(candle(START + HOUR), restAdapter);
    ledger.pauseSymbol("BTCUSDT", "market-data-connecting");
    await ledger.processClosedCandle(candle(START + HOUR), restAdapter);
    expect(ledger.getState().pausedSymbols.BTCUSDT).toBeUndefined();
    expect(ledger.getState().events.filter((event) => event.kind === "fill")).toHaveLength(1);
    expect(ledger.getState().events.some((event) => event.kind === "data-restored")).toBe(true);
  });

  it("crypto-ai-analysis.RISK_AND_PAPER_TRADING.9 retains the non-dismissible experimental status on the order", () => {
    const ledger = createCryptoPaperLedger({ now: () => fixedNow });
    const order = ledger.submitDraft(ledger.createDraft(makeAttempt(), "experimental"));
    expect(order.backtestStatus).toBe("experimental");
    expect(DEFAULT_BACKTEST_CONFIG.maxTradeRiskFraction).toBe(0.01);
  });
});
