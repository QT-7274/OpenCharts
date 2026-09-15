import { findCandleGaps, mergeCandles } from "./candles.ts";
import { normalizeWsKline, type BinanceWsKlineEnvelope } from "./binance.ts";
import {
  intervalToMs,
  type MarketCandle,
  type MarketDataHealth,
  type MarketDataRestAdapter,
  type MissingCandleRange,
  type SpotInterval,
  type SpotSymbol,
} from "./types.ts";

export const DEFAULT_BINANCE_WS_BASE_URL = "wss://data-stream.binance.vision";

export interface MarketDataSubscription {
  symbol: SpotSymbol;
  interval: SpotInterval;
}

export interface WebSocketLike {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  close(code?: number, reason?: string): void;
}

interface BinanceKlineStreamOptions {
  restAdapter: MarketDataRestAdapter;
  baseUrl?: string;
  webSocketFactory?: (url: string) => WebSocketLike;
  now?: () => number;
  random?: () => number;
  staleAfterMs?: number;
  replaceAfterMs?: number;
}

type CandleListener = (candle: MarketCandle) => void;
type HealthListener = (health: MarketDataHealth) => void;

interface RecoveryResult {
  missingRanges: MissingCandleRange[];
  bootstrapCandles: MarketCandle[];
}

function configuredBaseUrl(): string {
  return (
    import.meta.env.VITE_BINANCE_WS_BASE_URL || DEFAULT_BINANCE_WS_BASE_URL
  ).replace(/\/+$/, "");
}

function subscriptionKey(subscription: MarketDataSubscription): string {
  return `${subscription.symbol}:${subscription.interval}`;
}

function streamName(subscription: MarketDataSubscription): string {
  return `${subscription.symbol.toLowerCase()}@kline_${subscription.interval}`;
}

function latestClosedOpenTime(serverTimeMs: number, interval: SpotInterval): number {
  const intervalMs = intervalToMs(interval);
  return Math.floor(serverTimeMs / intervalMs) * intervalMs - intervalMs;
}

// crypto-ai-analysis.MARKET_DATA.4 crypto-ai-analysis.DATA_BOUNDARY.2
export class BinanceKlineStream {
  private readonly restAdapter: MarketDataRestAdapter;
  private readonly baseUrl: string;
  private readonly webSocketFactory: (url: string) => WebSocketLike;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly staleAfterMs: number;
  private readonly replaceAfterMs: number;
  private readonly candleListeners = new Set<CandleListener>();
  private readonly closedListeners = new Set<CandleListener>();
  private readonly healthListeners = new Set<HealthListener>();
  private readonly lastClosed = new Map<string, MarketCandle>();
  private readonly latestBySeries = new Map<string, MarketCandle>();
  private socket: WebSocketLike | null = null;
  private subscriptions: MarketDataSubscription[] = [];
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private replaceTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private recovering = false;
  private bufferedMessages: string[] = [];
  private connectionGeneration = 0;
  private healthValue: MarketDataHealth = {
    state: "disconnected",
    serverTimeMs: null,
    lastMessageAtMs: null,
    lastClosedCandleAtMs: null,
    missingRanges: [],
  };

  constructor(options: BinanceKlineStreamOptions) {
    this.restAdapter = options.restAdapter;
    this.baseUrl = (options.baseUrl ?? configuredBaseUrl()).replace(/\/+$/, "");
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.staleAfterMs = options.staleAfterMs ?? 15_000;
    this.replaceAfterMs = options.replaceAfterMs ?? 23 * 60 * 60 * 1_000 + 55 * 60 * 1_000;
  }

  get health(): MarketDataHealth {
    return { ...this.healthValue, missingRanges: [...this.healthValue.missingRanges] };
  }

  connect(subscriptions: readonly MarketDataSubscription[]): void {
    const unique = new Map(subscriptions.map((item) => [subscriptionKey(item), item]));
    this.subscriptions = [...unique.values()];
    this.intentionalClose = false;
    this.connectionGeneration += 1;
    this.clearReconnectTimer();
    const previousSocket = this.socket;
    this.socket = null;
    previousSocket?.close(1000, "subscriptions changed");
    this.openSocket();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.connectionGeneration += 1;
    this.recovering = false;
    this.bufferedMessages = [];
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "client disconnect");
    this.updateHealth({ state: "disconnected", missingRanges: [] });
  }

  subscribe(listener: CandleListener): () => void {
    this.candleListeners.add(listener);
    return () => this.candleListeners.delete(listener);
  }

  subscribeClosed(listener: CandleListener): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  onHealthChange(listener: HealthListener): () => void {
    this.healthListeners.add(listener);
    listener(this.health);
    return () => this.healthListeners.delete(listener);
  }

  private openSocket(): void {
    if (this.intentionalClose || this.subscriptions.length === 0) return;
    this.connectionGeneration += 1;
    this.updateHealth({ state: "connecting" });
    const streams = this.subscriptions.map(streamName).join("/");
    const socket = this.webSocketFactory(`${this.baseUrl}/stream?streams=${streams}`);
    const generation = this.connectionGeneration;
    this.socket = socket;

    socket.onopen = () => {
      void this.onOpen(socket, generation);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || generation !== this.connectionGeneration) return;
      if (this.recovering) {
        this.bufferedMessages.push(event.data);
        return;
      }
      this.acceptMessage(event.data);
    };
    socket.onerror = () => {
      socket.close(4001, "market-data error");
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.connectionGeneration += 1;
      this.recovering = false;
      this.bufferedMessages = [];
      this.clearLiveTimers();
      if (!this.intentionalClose) this.scheduleReconnect();
    };
  }

  private async onOpen(socket: WebSocketLike, generation: number): Promise<void> {
    this.recovering = true;
    this.bufferedMessages = [];
    let recovery: RecoveryResult = { missingRanges: [], bootstrapCandles: [] };

    try {
      recovery = await this.recoverClosedCandles(generation);
    } catch {
      if (!this.isActiveGeneration(generation)) return;
      recovery = { missingRanges: this.fallbackMissingRanges(), bootstrapCandles: [] };
    }

    if (this.socket !== socket || !this.isActiveGeneration(generation)) return;
    this.recovering = false;
    const buffered = this.bufferedMessages;
    this.bufferedMessages = [];
    for (const message of buffered) this.acceptMessage(message);
    for (const candle of recovery.bootstrapCandles) this.seedClosedBaseline(candle);
    this.reconnectAttempt = 0;
    this.updateHealth({
      state: recovery.missingRanges.length === 0 ? "live" : "degraded",
      missingRanges: recovery.missingRanges,
    });
    this.resetStaleTimer(socket);
    this.replaceTimer = setTimeout(() => socket.close(1000, "scheduled reconnect"), this.replaceAfterMs);
  }

  private acceptMessage(raw: string): void {
    try {
      const message = JSON.parse(raw) as BinanceWsKlineEnvelope;
      if (message.data?.e !== "kline") return;
      const candle = normalizeWsKline(message);
      this.updateHealth({ lastMessageAtMs: this.now() });
      this.acceptCandle(candle);
      if (this.socket) this.resetStaleTimer(this.socket);
    } catch {
      // Ignore malformed provider messages; the freshness watchdog handles a broken stream.
    }
  }

  private acceptCandle(candle: MarketCandle): void {
    const key = subscriptionKey(candle);
    const latest = this.latestBySeries.get(key);
    if (latest && candle.openTimeMs < latest.openTimeMs) return;
    if (latest && candle.openTimeMs === latest.openTimeMs) {
      if (latest.isClosed) return;
      if (
        !candle.isClosed &&
        latest.eventTimeMs != null &&
        candle.eventTimeMs != null &&
        candle.eventTimeMs <= latest.eventTimeMs
      ) {
        return;
      }
    }
    this.latestBySeries.set(key, candle);
    for (const listener of this.candleListeners) listener(candle);
    if (!candle.isClosed) return;

    const previous = this.lastClosed.get(key);
    if (previous && previous.openTimeMs >= candle.openTimeMs) return;
    this.lastClosed.set(key, candle);
    this.recordLastClosedTime(candle.closeTimeMs);
    for (const listener of this.closedListeners) listener(candle);
  }

  // crypto-ai-analysis.MARKET_DATA.4 crypto-ai-analysis.MARKET_DATA.6
  private async recoverClosedCandles(generation: number): Promise<RecoveryResult> {
    const serverTimeMs = await this.restAdapter.getServerTime();
    this.assertActiveGeneration(generation);
    this.updateHealth({ serverTimeMs });
    const missingRanges: MissingCandleRange[] = [];
    const bootstrapCandles: MarketCandle[] = [];
    const outstandingRanges = this.healthValue.missingRanges;

    await Promise.all(
      this.subscriptions.map(async (subscription) => {
        const key = subscriptionKey(subscription);
        const previous = this.lastClosed.get(key);
        const intervalMs = intervalToMs(subscription.interval);
        const expectedLastOpen = latestClosedOpenTime(serverTimeMs, subscription.interval);
        const outstandingStart = outstandingRanges
          .filter(
            (range) =>
              range.symbol === subscription.symbol && range.interval === subscription.interval,
          )
          .reduce<number | undefined>(
            (earliest, range) =>
              earliest == null ? range.fromMs : Math.min(earliest, range.fromMs),
            undefined,
          );
        if (outstandingStart == null && previous && previous.openTimeMs >= expectedLastOpen) return;

        const startTimeMs = outstandingStart ?? (previous ? previous.openTimeMs + intervalMs : undefined);
        const limit = startTimeMs == null
          ? 2
          : Math.min(
              10_000,
              Math.max(1, Math.floor((expectedLastOpen - startTimeMs) / intervalMs) + 1),
            );
        const fetched = (
          await this.restAdapter.getCandles({
            ...subscription,
            ...(startTimeMs == null ? {} : { startTimeMs }),
            endTimeMs: serverTimeMs,
            limit,
          })
        ).filter(
          (candle) =>
            candle.isClosed &&
            candle.openTimeMs <= expectedLastOpen &&
            (startTimeMs == null || candle.openTimeMs >= startTimeMs),
        );
        this.assertActiveGeneration(generation);
        const recovered = mergeCandles(fetched);
        const rangeStart = startTimeMs ?? recovered[0]?.openTimeMs ?? expectedLastOpen;
        if (recovered.length === 0) {
          missingRanges.push({
            ...subscription,
            fromMs: rangeStart,
            toMs: expectedLastOpen,
          });
          return;
        }

        const first = recovered[0]!;
        if (first.openTimeMs > rangeStart) {
          missingRanges.push({
            ...subscription,
            fromMs: rangeStart,
            toMs: first.openTimeMs - intervalMs,
          });
        }
        const gaps = findCandleGaps(recovered, subscription.interval);
        const latest = recovered.at(-1)!;
        if (latest.openTimeMs < expectedLastOpen) {
          gaps.push({
            ...subscription,
            fromMs: latest.openTimeMs + intervalMs,
            toMs: expectedLastOpen,
          });
        }
        missingRanges.push(...gaps);
        if (!previous) {
          bootstrapCandles.push(latest);
          return;
        }
        for (const candle of recovered) {
          if (candle.openTimeMs > previous.openTimeMs) this.acceptCandle(candle);
        }
      }),
    );

    this.assertActiveGeneration(generation);
    return { missingRanges, bootstrapCandles };
  }

  private fallbackMissingRanges(): MissingCandleRange[] {
    return this.subscriptions.flatMap((subscription) => {
      const outstanding = this.healthValue.missingRanges.filter(
        (range) => range.symbol === subscription.symbol && range.interval === subscription.interval,
      );
      if (outstanding.length > 0) return outstanding;
      const previous = this.lastClosed.get(subscriptionKey(subscription));
      const fromMs = previous
        ? previous.openTimeMs + intervalToMs(subscription.interval)
        : latestClosedOpenTime(this.now(), subscription.interval);
      return [{ ...subscription, fromMs, toMs: fromMs }];
    });
  }

  private seedClosedBaseline(candle: MarketCandle): void {
    const key = subscriptionKey(candle);
    const previous = this.lastClosed.get(key);
    if (previous && previous.openTimeMs >= candle.openTimeMs) return;
    this.lastClosed.set(key, candle);
    const latest = this.latestBySeries.get(key);
    if (!latest || latest.openTimeMs <= candle.openTimeMs) this.latestBySeries.set(key, candle);
    this.recordLastClosedTime(candle.closeTimeMs);
  }

  private isActiveGeneration(generation: number): boolean {
    return !this.intentionalClose && generation === this.connectionGeneration;
  }

  private assertActiveGeneration(generation: number): void {
    if (!this.isActiveGeneration(generation)) throw new Error("Stale market-data recovery");
  }

  private scheduleReconnect(): void {
    this.updateHealth({ state: "connecting" });
    const delayMs = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt) + this.random() * 250;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delayMs);
  }

  private resetStaleTimer(socket: WebSocketLike): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      if (this.socket === socket) socket.close(4000, "market-data stale");
    }, this.staleAfterMs);
  }

  private updateHealth(patch: Partial<MarketDataHealth>): void {
    this.healthValue = { ...this.healthValue, ...patch };
    for (const listener of this.healthListeners) listener(this.health);
  }

  private recordLastClosedTime(closeTimeMs: number): void {
    this.updateHealth({
      lastClosedCandleAtMs: Math.max(this.healthValue.lastClosedCandleAtMs ?? 0, closeTimeMs),
    });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearLiveTimers(): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    if (this.replaceTimer) clearTimeout(this.replaceTimer);
    this.staleTimer = null;
    this.replaceTimer = null;
  }

  private clearTimers(): void {
    this.clearReconnectTimer();
    this.clearLiveTimers();
  }
}
