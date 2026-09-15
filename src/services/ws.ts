import { publish, subscribeChannel, type ChannelHandler } from "./demo/bus.ts";
import { mark } from "./demo/engine.ts";
import { startDemoFeed, stopDemoFeed } from "./demo/feed.ts";
import { binanceKlineStream, marketDataMode } from "./market-data/runtime.ts";
import {
  SUPPORTED_SPOT_INTERVALS,
  SUPPORTED_SPOT_SYMBOLS,
  type MarketDataHealth,
} from "./market-data/types.ts";

export type ConnectionState = "connected" | "connecting" | "reconnecting" | "disconnected";
export type WsHandler = ChannelHandler;

const BINANCE_SUBSCRIPTIONS = SUPPORTED_SPOT_SYMBOLS.flatMap((symbol) =>
  SUPPORTED_SPOT_INTERVALS.map((interval) => ({ symbol, interval })),
);

class MarketDataWsClient {
  private _state: ConnectionState = "disconnected";
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private hasConnected = false;

  constructor() {
    if (marketDataMode !== "binance") return;

    binanceKlineStream.subscribe((candle) => {
      publish("market-data", {
        eventType: "CandleUpdate",
        symbol: candle.symbol,
        timeframe: candle.interval,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        timestamp: candle.openTimeMs,
      });

      if (candle.interval === "1h") {
        publish("market-data", {
          eventType: "MarketTick",
          symbol: candle.symbol,
          bid: candle.close,
          ask: candle.close,
          occurredAt: Date.now(),
        });
        mark(candle.symbol, candle.close);
      }
    });

    // crypto-ai-analysis.CANDLE_QUALITY.2
    binanceKlineStream.subscribeClosed((candle) => {
      publish("market-data", {
        eventType: "CandleClosed",
        symbol: candle.symbol,
        timeframe: candle.interval,
        candle,
      });
    });

    binanceKlineStream.onHealthChange((health) => {
      if (health.state === "live" || health.state === "degraded") {
        this.hasConnected = true;
        this.setState("connected");
      } else if (health.state === "connecting") {
        this.setState(this.hasConnected ? "reconnecting" : "connecting");
      } else {
        this.setState("disconnected");
      }
    });
  }

  get state(): ConnectionState {
    return this._state;
  }

  get health(): MarketDataHealth {
    return binanceKlineStream.health;
  }

  private setState(next: ConnectionState): void {
    if (this._state === next) return;
    this._state = next;
    for (const callback of this.stateListeners) callback(next);
  }

  connect(_token?: string): void {
    if (
      this._state === "connected" ||
      this._state === "connecting" ||
      this._state === "reconnecting"
    ) {
      return;
    }

    this.setState("connecting");
    if (marketDataMode === "demo") {
      startDemoFeed();
      setTimeout(() => this.setState("connected"), 0);
      return;
    }
    binanceKlineStream.connect(BINANCE_SUBSCRIPTIONS);
  }

  disconnect(): void {
    if (marketDataMode === "demo") stopDemoFeed();
    else binanceKlineStream.disconnect();
    this.hasConnected = false;
    this.setState("disconnected");
  }

  reauthenticate(_token: string): void {
    // Public Binance market data has no authentication state to refresh.
  }

  subscribe(channel: string, handler: WsHandler): () => void {
    return subscribeChannel(channel, handler);
  }

  subscribeAccounts(_accountIds: string[]): void {
    // Paper-account events already flow through the local event bus.
  }

  setSymbolInterest(_symbols: string[]): void {
    // The first release keeps one combined subscription for the six-symbol allowlist.
  }

  onStateChange(callback: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(callback);
    callback(this._state);
    return () => {
      this.stateListeners.delete(callback);
    };
  }

  emit(channel: string, event: unknown): void {
    publish(channel, event);
  }
}

export const wsClient = new MarketDataWsClient();
