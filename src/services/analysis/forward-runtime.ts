import { SUPPORTED_SPOT_SYMBOLS, intervalToMs, type MarketDataRestAdapter } from "../market-data/types.ts";
import type { BinanceKlineStream } from "../market-data/ws-adapter.ts";
import type { createCryptoPaperLedger } from "./paper-trading.ts";

interface ForwardRuntimeOptions {
  ledger: ReturnType<typeof createCryptoPaperLedger>;
  stream: Pick<BinanceKlineStream, "health" | "subscribeClosed" | "onHealthChange">;
  restAdapter: MarketDataRestAdapter;
  now?: () => number;
}

// crypto-ai-analysis.FORWARD_SIMULATION.4 crypto-ai-analysis.FORWARD_SIMULATION.10
// crypto-ai-analysis.RELIABILITY.1 crypto-ai-analysis.RELIABILITY.3
export function createForwardRuntime({ ledger, stream, restAdapter, now = Date.now }: ForwardRuntimeOptions) {
  let stopped = false;
  let recovering = false;
  let recovered = false;
  let pending = 0;
  let recoveryGeneration = 0;
  let runtimeFailure: string | null = null;
  let lastSuccessfullyProcessedAtMs: number | null = null;
  const bufferedClosedCandles = new Map<string, Parameters<typeof ledger.processClosedCandle>[0]>();
  const stopWaiters: Array<() => void> = [];
  const hourMs = intervalToMs("1h");

  function resolveStopWaiters(): void {
    if (!stopped || pending > 0 || recovering) return;
    while (stopWaiters.length) stopWaiters.shift()!();
  }

  function fail(symbol: typeof SUPPORTED_SPOT_SYMBOLS[number], error: unknown) {
    runtimeFailure = error instanceof Error ? error.message : "Forward simulation failed";
    try { ledger.pauseSymbol(symbol, runtimeFailure); } catch { /* Storage errors remain visible in status. */ }
  }

  function processCandle(candle: Parameters<typeof ledger.processClosedCandle>[0]): void {
    pending += 1;
    void ledger.processClosedCandle(candle, restAdapter).then(() => {
      if (!ledger.getState().pausedSymbols[candle.symbol] && !ledger.getRuntimeError()) {
        lastSuccessfullyProcessedAtMs = Math.max(lastSuccessfullyProcessedAtMs ?? 0, candle.closeTimeMs);
      }
    }).catch((error: unknown) => fail(candle.symbol, error)).finally(() => {
      pending -= 1;
      resolveStopWaiters();
    });
  }

  function bufferCandle(candle: Parameters<typeof ledger.processClosedCandle>[0]): void {
    bufferedClosedCandles.set(`${candle.symbol}:${candle.openTimeMs}`, candle);
  }

  function flushBufferedCandles(): void {
    const candles = [...bufferedClosedCandles.values()]
      .sort((a, b) => a.openTimeMs - b.openTimeMs || a.symbol.localeCompare(b.symbol));
    bufferedClosedCandles.clear();
    for (const candle of candles) processCandle(candle);
  }

  const unsubscribeClosed = stream.subscribeClosed((candle) => {
    if (stopped || candle.interval !== "1h") return;
    // Stream recovery emits closed candles before its health state becomes live. Hold them
    // until the runtime has completed its own checkpoint recovery so no fill is evaluated
    // against a partially restored ledger.
    if (recovering || !recovered || stream.health.state !== "live") {
      bufferCandle(candle);
      return;
    }
    processCandle(candle);
  });

  async function recover() {
    const generation = ++recoveryGeneration;
    recovering = true;
    recovered = false;
    try {
      const serverTimeMs = await restAdapter.getServerTime();
      if (!Number.isFinite(serverTimeMs)) throw new Error("Invalid market server time");
      const latestOpenTimeMs = Math.floor(serverTimeMs / hourMs) * hourMs - hourMs;
      for (const symbol of SUPPORTED_SPOT_SYMBOLS) {
        if (stopped || generation !== recoveryGeneration || stream.health.state !== "live") return;
        try {
          const candles = await restAdapter.getCandles({ symbol, interval: "1h", startTimeMs: latestOpenTimeMs,
            endTimeMs: latestOpenTimeMs + hourMs - 1, limit: 1 });
          const latest = candles.find((candle) => candle.isClosed && candle.openTimeMs === latestOpenTimeMs);
          if (!latest) throw new Error("Latest closed candle is unavailable");
          await ledger.processClosedCandle(latest, restAdapter);
          if (ledger.getState().pausedSymbols[symbol] || ledger.getRuntimeError()) continue;
          lastSuccessfullyProcessedAtMs = Math.max(lastSuccessfullyProcessedAtMs ?? 0, latest.closeTimeMs);
        } catch (error) { fail(symbol, error); }
      }
      recovered = !stopped && generation === recoveryGeneration && stream.health.state === "live";
      if (recovered && !Object.keys(ledger.getState().pausedSymbols).length && !ledger.getRuntimeError()) runtimeFailure = null;
    } catch (error) {
      for (const symbol of SUPPORTED_SPOT_SYMBOLS) fail(symbol, error);
    } finally {
      if (generation === recoveryGeneration) {
        recovering = false;
        if (recovered) flushBufferedCandles();
        resolveStopWaiters();
      }
    }
  }

  let previousConnection: string | null = null;
  const unsubscribeHealth = stream.onHealthChange((health) => {
    if (stopped || health.state === previousConnection) return;
    previousConnection = health.state;
    if (health.state !== "live") {
      recoveryGeneration += 1;
      recovering = false;
      recovered = false;
      for (const symbol of SUPPORTED_SPOT_SYMBOLS) {
        try { ledger.pauseSymbol(symbol, `market-data-${health.state}`); } catch {}
      }
    } else { void recover(); }
  });

  return {
    getStatus() {
      const health = stream.health;
      const fresh = health.lastMessageAtMs != null && now() - health.lastMessageAtMs >= 0 &&
        now() - health.lastMessageAtMs <= 15_000;
      const storageError = ledger.getRuntimeError();
      return {
        connection: health.state,
        shuttingDown: stopped,
        ready: !stopped && health.state === "live" && fresh && recovered && !recovering && pending === 0 &&
          !storageError && Object.keys(ledger.getState().pausedSymbols).length === 0,
        recovering,
        lastMarketAtMs: health.lastMessageAtMs,
        lastSuccessfullyProcessedAtMs,
        pausedSymbols: ledger.getState().pausedSymbols,
        storageStatus: storageError ? "error" as const : "ok" as const,
        runtimeFailure,
      };
    },
    stop(): Promise<void> {
      if (stopped) return Promise.resolve();
      stopped = true;
      for (const symbol of SUPPORTED_SPOT_SYMBOLS) {
        ledger.recordRuntimeEvent?.(symbol, "runtime-shutdown", "Forward simulation service is shutting down");
      }
      unsubscribeClosed();
      unsubscribeHealth();
      if (pending === 0 && !recovering) return Promise.resolve();
      return new Promise((resolve) => stopWaiters.push(resolve));
    },
  };
}
