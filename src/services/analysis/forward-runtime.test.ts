import { describe, expect, it, vi } from "vitest";
import { createForwardRuntime } from "./forward-runtime.ts";
import { SUPPORTED_SPOT_SYMBOLS, intervalToMs, type MarketCandle, type MarketDataHealth } from "../market-data/types.ts";

const HOUR = intervalToMs("1h");
const NOW = Date.UTC(2026, 0, 2, 1, 10);

function makeCandle(symbol: typeof SUPPORTED_SPOT_SYMBOLS[number], openTimeMs: number): MarketCandle {
  return {
    symbol, interval: "1h", openTimeMs, closeTimeMs: openTimeMs + HOUR - 1,
    open: 100, high: 101, low: 99, close: 100, volume: 10, quoteVolume: 1_000,
    tradeCount: 10, isClosed: true, source: "rest",
  };
}

function streamHarness() {
  let health: MarketDataHealth = {
    state: "disconnected", serverTimeMs: null, lastMessageAtMs: null,
    lastClosedCandleAtMs: null, missingRanges: [],
  };
  const healthListeners = new Set<(value: MarketDataHealth) => void>();
  const closeListeners = new Set<(candle: MarketCandle) => void>();
  return {
    get health() { return health; },
    onHealthChange(listener: (value: MarketDataHealth) => void) {
      healthListeners.add(listener);
      listener(health);
      return () => healthListeners.delete(listener);
    },
    subscribeClosed(listener: (candle: MarketCandle) => void) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    setHealth(next: Partial<MarketDataHealth>) {
      health = { ...health, ...next };
      for (const listener of healthListeners) listener(health);
    },
    emit(candle: MarketCandle) { for (const listener of closeListeners) listener(candle); },
  };
}

function ledgerHarness() {
  const pausedSymbols: Record<string, string> = {};
  const processClosedCandle = vi.fn(async (candle: MarketCandle) => { delete pausedSymbols[candle.symbol]; });
  return {
    ledger: {
      processClosedCandle,
      pauseSymbol: vi.fn((symbol: string, reason: string) => { pausedSymbols[symbol] = reason; }),
      getState: () => ({ pausedSymbols }),
      getRuntimeError: () => null,
    } as never,
    processClosedCandle,
    pausedSymbols,
  };
}

describe("forward simulation runtime", () => {
  it("crypto-ai-analysis.FORWARD_SIMULATION.4 restores each latest closed candle before becoming ready", async () => {
    const stream = streamHarness();
    const { ledger, processClosedCandle } = ledgerHarness();
    const latestOpen = Math.floor(NOW / HOUR) * HOUR - HOUR;
    const restAdapter = {
      getServerTime: vi.fn(async () => NOW),
      getCandles: vi.fn(async ({ symbol }: { symbol: typeof SUPPORTED_SPOT_SYMBOLS[number] }) => [makeCandle(symbol, latestOpen)]),
    } as never;
    const runtime = createForwardRuntime({ ledger, stream, restAdapter, now: () => NOW });

    stream.setHealth({ state: "live", lastMessageAtMs: NOW });
    expect(runtime.getStatus().ready).toBe(false);
    await vi.waitFor(() => expect(processClosedCandle).toHaveBeenCalledTimes(SUPPORTED_SPOT_SYMBOLS.length));
    expect(runtime.getStatus().ready).toBe(true);
    runtime.stop();
  });

  it("crypto-ai-analysis.FORWARD_SIMULATION.10 pauses order readiness through disconnect and recovery", async () => {
    const stream = streamHarness();
    const { ledger, pausedSymbols, processClosedCandle } = ledgerHarness();
    const latestOpen = Math.floor(NOW / HOUR) * HOUR - HOUR;
    const restAdapter = {
      getServerTime: vi.fn(async () => NOW),
      getCandles: vi.fn(async ({ symbol }: { symbol: typeof SUPPORTED_SPOT_SYMBOLS[number] }) => [makeCandle(symbol, latestOpen)]),
    } as never;
    const runtime = createForwardRuntime({ ledger, stream, restAdapter, now: () => NOW });

    stream.setHealth({ state: "live", lastMessageAtMs: NOW });
    await vi.waitFor(() => expect(processClosedCandle).toHaveBeenCalledTimes(SUPPORTED_SPOT_SYMBOLS.length));
    expect(runtime.getStatus().ready).toBe(true);

    stream.setHealth({ state: "connecting" });
    expect(runtime.getStatus().ready).toBe(false);
    expect(Object.keys(pausedSymbols)).toHaveLength(SUPPORTED_SPOT_SYMBOLS.length);
    runtime.stop();
  });

  it("crypto-ai-analysis.FORWARD_SIMULATION.10 ignores stale recovery after a disconnect", async () => {
    const stream = streamHarness();
    const { ledger, processClosedCandle } = ledgerHarness();
    const latestOpen = Math.floor(NOW / HOUR) * HOUR - HOUR;
    let releaseFirst: ((time: number) => void) | undefined;
    const firstServerTime = new Promise<number>((resolve) => { releaseFirst = resolve; });
    const restAdapter = {
      getServerTime: vi.fn().mockImplementationOnce(() => firstServerTime).mockResolvedValue(NOW),
      getCandles: vi.fn(async ({ symbol }: { symbol: typeof SUPPORTED_SPOT_SYMBOLS[number] }) => [makeCandle(symbol, latestOpen)]),
    } as never;
    const runtime = createForwardRuntime({ ledger, stream, restAdapter, now: () => NOW });

    stream.setHealth({ state: "live", lastMessageAtMs: NOW });
    stream.setHealth({ state: "connecting" });
    stream.setHealth({ state: "live", lastMessageAtMs: NOW });
    await vi.waitFor(() => expect(processClosedCandle).toHaveBeenCalledTimes(SUPPORTED_SPOT_SYMBOLS.length));
    releaseFirst!(NOW);
    await Promise.resolve();
    expect(processClosedCandle).toHaveBeenCalledTimes(SUPPORTED_SPOT_SYMBOLS.length);
    expect(runtime.getStatus().ready).toBe(true);
    runtime.stop();
  });

  it("crypto-ai-analysis.FORWARD_SIMULATION.4 buffers closed candles during recovery", async () => {
    const stream = streamHarness();
    const { ledger, processClosedCandle } = ledgerHarness();
    const latestOpen = Math.floor(NOW / HOUR) * HOUR - HOUR;
    let releaseRecovery: (() => void) | undefined;
    const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const restAdapter = {
      getServerTime: vi.fn(async () => {
        await recoveryGate;
        return NOW;
      }),
      getCandles: vi.fn(async ({ symbol }: { symbol: typeof SUPPORTED_SPOT_SYMBOLS[number] }) => [makeCandle(symbol, latestOpen)]),
    } as never;
    const runtime = createForwardRuntime({ ledger, stream, restAdapter, now: () => NOW });

    stream.setHealth({ state: "live", lastMessageAtMs: NOW });
    stream.emit(makeCandle("BTCUSDT", latestOpen + HOUR));
    await Promise.resolve();
    expect(processClosedCandle).not.toHaveBeenCalled();

    releaseRecovery!();
    await vi.waitFor(() => expect(processClosedCandle).toHaveBeenCalled());
    expect(processClosedCandle.mock.calls.at(-1)?.[0].openTimeMs).toBe(latestOpen + HOUR);
    runtime.stop();
  });

  it("crypto-ai-analysis.RELIABILITY.1 crypto-ai-analysis.LONG_RUNNING.1 serializes closed candles after recovery", async () => {
    const stream = streamHarness();
    const { ledger, processClosedCandle, pausedSymbols } = ledgerHarness();
    const latestOpen = Math.floor(NOW / HOUR) * HOUR - HOUR;
    let releaseFirst: (() => void) | undefined;
    const firstProcessing = new Promise<void>((resolve) => { releaseFirst = resolve; });
    processClosedCandle.mockImplementation(async (row: MarketCandle) => {
      delete pausedSymbols[row.symbol];
      if (row.openTimeMs === latestOpen + HOUR) await firstProcessing;
    });
    const restAdapter = {
      getServerTime: vi.fn(async () => NOW),
      getCandles: vi.fn(async ({ symbol }: { symbol: typeof SUPPORTED_SPOT_SYMBOLS[number] }) => [makeCandle(symbol, latestOpen)]),
    } as never;
    const runtime = createForwardRuntime({ ledger, stream, restAdapter, now: () => NOW });

    stream.setHealth({ state: "live", lastMessageAtMs: NOW });
    await vi.waitFor(() => expect(runtime.getStatus().ready).toBe(true));

    const first = makeCandle("BTCUSDT", latestOpen + HOUR);
    const second = makeCandle("BTCUSDT", latestOpen + 2 * HOUR);
    stream.emit(first);
    stream.emit(second);
    await Promise.resolve();

    expect(processClosedCandle.mock.calls.filter(([row]) => row.openTimeMs === second.openTimeMs)).toHaveLength(0);
    releaseFirst!();
    await vi.waitFor(() => expect(processClosedCandle.mock.calls.filter(([row]) => row.openTimeMs === second.openTimeMs)).toHaveLength(1));

    expect(processClosedCandle.mock.calls.map(([row]) => row.openTimeMs).slice(-2)).toEqual([
      first.openTimeMs,
      second.openTimeMs,
    ]);
    await runtime.stop();
  });

  it("crypto-ai-analysis.LONG_RUNNING.3 waits for queued candle processing before stopping", async () => {
    const stream = streamHarness();
    const pausedSymbols: Record<string, string> = {};
    const recordRuntimeEvent = vi.fn();
    let releaseCandle: (() => void) | undefined;
    let processingStarted: (() => void) | undefined;
    const processStarted = new Promise<void>((resolve) => { processingStarted = resolve; });
    const processClosedCandle = vi.fn(async (candle: MarketCandle) => {
      delete pausedSymbols[candle.symbol];
      if (processClosedCandle.mock.calls.length > SUPPORTED_SPOT_SYMBOLS.length) {
        processingStarted!();
        await new Promise<void>((resolve) => { releaseCandle = resolve; });
      }
    });
    const ledger = {
      processClosedCandle,
      pauseSymbol: vi.fn((symbol: string, reason: string) => { pausedSymbols[symbol] = reason; }),
      recordRuntimeEvent,
      getState: () => ({ pausedSymbols }),
      getRuntimeError: () => null,
    } as never;
    const latestOpen = Math.floor(NOW / HOUR) * HOUR - HOUR;
    const restAdapter = {
      getServerTime: vi.fn(async () => NOW),
      getCandles: vi.fn(async ({ symbol }: { symbol: typeof SUPPORTED_SPOT_SYMBOLS[number] }) => [makeCandle(symbol, latestOpen)]),
    } as never;
    const runtime = createForwardRuntime({ ledger, stream, restAdapter, now: () => NOW });

    stream.setHealth({ state: "live", lastMessageAtMs: NOW });
    await vi.waitFor(() => expect(processClosedCandle).toHaveBeenCalledTimes(SUPPORTED_SPOT_SYMBOLS.length));
    stream.emit(makeCandle("BTCUSDT", latestOpen + HOUR));
    await processStarted;

    let stopped = false;
    const stopping = runtime.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseCandle!();
    await stopping;
    expect(stopped).toBe(true);
    expect(recordRuntimeEvent).toHaveBeenCalledTimes(SUPPORTED_SPOT_SYMBOLS.length);
    expect(recordRuntimeEvent).toHaveBeenCalledWith("BTCUSDT", "runtime-shutdown", expect.any(String));
  });
});
