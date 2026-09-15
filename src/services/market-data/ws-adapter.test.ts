import { describe, expect, it, vi } from "vitest";
import { BinanceKlineStream, type WebSocketLike } from "./ws-adapter.ts";
import type { MarketCandle, MarketDataRestAdapter } from "./types.ts";

class FakeWebSocket implements WebSocketLike {
  readyState: number = WebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent<string>);
  }

  serverClose(): void {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }
}

function restAdapter(): MarketDataRestAdapter {
  return {
    getServerTime: vi.fn().mockResolvedValue(1_710_003_600_000),
    getSpotSymbols: vi.fn().mockResolvedValue([]),
    getCandles: vi.fn().mockResolvedValue([
      {
        symbol: "BTCUSDT",
        interval: "1h",
        openTimeMs: 1_710_000_000_000,
        closeTimeMs: 1_710_003_599_999,
        open: 100,
        high: 110,
        low: 90,
        close: 105,
        volume: 12.5,
        quoteVolume: 1312.5,
        tradeCount: 42,
        isClosed: true,
        source: "rest",
      },
    ]),
  };
}

function kline(
  isClosed: boolean,
  offsetMs = 0,
  eventTimeMs = 1_710_003_599_500 + offsetMs,
  close = "105",
) {
  return {
    stream: "btcusdt@kline_1h",
    data: {
      e: "kline" as const,
      E: eventTimeMs,
      s: "BTCUSDT",
      k: {
        t: 1_710_000_000_000 + offsetMs,
        T: 1_710_003_599_999 + offsetMs,
        s: "BTCUSDT",
        i: "1h",
        o: "100",
        h: "110",
        l: "90",
        c: close,
        v: "12.5",
        q: "1312.5",
        n: 42,
        x: isClosed,
      },
    },
  };
}

function closedCandle(openTimeMs: number): MarketCandle {
  return {
    symbol: "BTCUSDT",
    interval: "1h",
    openTimeMs,
    closeTimeMs: openTimeMs + 60 * 60 * 1_000 - 1,
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 12.5,
    quoteVolume: 1312.5,
    tradeCount: 42,
    isClosed: true,
    source: "rest",
  };
}

describe("Binance WebSocket adapter", () => {
  it("crypto-ai-analysis.CANDLE_QUALITY.2 emits every candle for display but only closed candles to the closed seam", async () => {
    const socket = new FakeWebSocket();
    const stream = new BinanceKlineStream({
      restAdapter: restAdapter(),
      webSocketFactory: () => socket,
      random: () => 0,
    });
    const displayed = vi.fn();
    const closed = vi.fn();
    stream.subscribe(displayed);
    stream.subscribeClosed(closed);

    stream.connect([{ symbol: "BTCUSDT", interval: "1h" }]);
    socket.open();
    await vi.waitFor(() => expect(stream.health.state).toBe("live"));
    socket.message(kline(false));
    socket.message(kline(false, 60 * 60 * 1_000));
    socket.message(kline(true, 60 * 60 * 1_000));
    socket.message(kline(true, 60 * 60 * 1_000));
    socket.message(kline(false, 60 * 60 * 1_000));

    expect(displayed).toHaveBeenCalledTimes(2);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledWith(expect.objectContaining({ isClosed: true }));
    stream.disconnect();
  });

  it("crypto-ai-analysis.MARKET_DATA.4 ignores out-of-order partial updates by event time", async () => {
    const socket = new FakeWebSocket();
    const stream = new BinanceKlineStream({
      restAdapter: restAdapter(),
      webSocketFactory: () => socket,
    });
    const displayed = vi.fn();
    stream.subscribe(displayed);

    stream.connect([{ symbol: "BTCUSDT", interval: "1h" }]);
    socket.open();
    await vi.waitFor(() => expect(stream.health.state).toBe("live"));
    const nextInterval = 60 * 60 * 1_000;
    socket.message(kline(false, nextInterval, 200, "110"));
    socket.message(kline(false, nextInterval, 100, "90"));

    expect(displayed).toHaveBeenCalledTimes(1);
    expect(displayed).toHaveBeenLastCalledWith(expect.objectContaining({ close: 110 }));
    stream.disconnect();
  });

  it("crypto-ai-analysis.CANDLE_QUALITY.2 replays a buffered closed event before seeding REST state", async () => {
    const socket = new FakeWebSocket();
    let resolveCandles!: (candles: MarketCandle[]) => void;
    const pendingCandles = new Promise<MarketCandle[]>((resolve) => {
      resolveCandles = resolve;
    });
    const adapter: MarketDataRestAdapter = {
      getServerTime: vi.fn().mockResolvedValue(1_710_003_600_000),
      getSpotSymbols: vi.fn().mockResolvedValue([]),
      getCandles: vi.fn().mockReturnValue(pendingCandles),
    };
    const stream = new BinanceKlineStream({
      restAdapter: adapter,
      webSocketFactory: () => socket,
    });
    const closed = vi.fn();
    stream.subscribeClosed(closed);

    stream.connect([{ symbol: "BTCUSDT", interval: "1h" }]);
    socket.open();
    await vi.waitFor(() => expect(adapter.getCandles).toHaveBeenCalled());
    socket.message(kline(true));
    resolveCandles([closedCandle(1_710_000_000_000)]);
    await vi.waitFor(() => expect(stream.health.state).toBe("live"));

    expect(closed).toHaveBeenCalledTimes(1);
    stream.disconnect();
  });

  it("crypto-ai-analysis.MARKET_DATA.4 ignores pending recovery after disconnect", async () => {
    const socket = new FakeWebSocket();
    let resolveCandles!: (candles: MarketCandle[]) => void;
    const pendingCandles = new Promise<MarketCandle[]>((resolve) => {
      resolveCandles = resolve;
    });
    const adapter: MarketDataRestAdapter = {
      getServerTime: vi.fn().mockResolvedValue(1_710_003_600_000),
      getSpotSymbols: vi.fn().mockResolvedValue([]),
      getCandles: vi.fn().mockReturnValue(pendingCandles),
    };
    const stream = new BinanceKlineStream({
      restAdapter: adapter,
      webSocketFactory: () => socket,
    });
    const closed = vi.fn();
    stream.subscribeClosed(closed);

    stream.connect([{ symbol: "BTCUSDT", interval: "1h" }]);
    socket.open();
    await vi.waitFor(() => expect(adapter.getCandles).toHaveBeenCalled());
    stream.disconnect();
    resolveCandles([closedCandle(1_710_000_000_000)]);
    await Promise.resolve();
    await Promise.resolve();

    expect(stream.health.state).toBe("disconnected");
    expect(closed).not.toHaveBeenCalled();
  });

  it("crypto-ai-analysis.MARKET_DATA.4 reconnects, restores subscriptions, and backfills missed closed candles", async () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const urls: string[] = [];
    const missedOpenTimeMs = 1_710_003_600_000;
    const firstClosed = {
      symbol: "BTCUSDT" as const,
      interval: "1h" as const,
      openTimeMs: 1_710_000_000_000,
      closeTimeMs: 1_710_003_599_999,
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: 12.5,
      quoteVolume: 1312.5,
      tradeCount: 42,
      isClosed: true,
      source: "rest" as const,
    };
    const adapter: MarketDataRestAdapter = {
      getServerTime: vi
        .fn()
        .mockResolvedValueOnce(1_710_003_600_000)
        .mockResolvedValueOnce(1_710_007_200_000),
      getSpotSymbols: vi.fn().mockResolvedValue([]),
      getCandles: vi
        .fn()
        .mockResolvedValueOnce([firstClosed])
        .mockResolvedValueOnce([
          {
          symbol: "BTCUSDT",
          interval: "1h",
          openTimeMs: missedOpenTimeMs,
          closeTimeMs: 1_710_007_199_999,
          open: 105,
          high: 112,
          low: 103,
          close: 110,
          volume: 15,
          quoteVolume: 1650,
          tradeCount: 50,
          isClosed: true,
          source: "rest",
          },
        ]),
    };
    const stream = new BinanceKlineStream({
      restAdapter: adapter,
      webSocketFactory: (url) => {
        urls.push(url);
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      random: () => 0,
    });
    const closed = vi.fn();
    stream.subscribeClosed(closed);

    stream.connect([{ symbol: "BTCUSDT", interval: "1h" }]);
    sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.message(kline(true));
    sockets[0]!.serverClose();
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[1]!.open();
    await vi.advanceTimersByTimeAsync(0);

    expect(urls).toEqual([
      "wss://data-stream.binance.vision/stream?streams=btcusdt@kline_1h",
      "wss://data-stream.binance.vision/stream?streams=btcusdt@kline_1h",
    ]);
    expect(adapter.getCandles).toHaveBeenLastCalledWith({
      symbol: "BTCUSDT",
      interval: "1h",
      startTimeMs: missedOpenTimeMs,
      endTimeMs: 1_710_007_200_000,
      limit: 1,
    });
    expect(closed).toHaveBeenLastCalledWith(
      expect.objectContaining({ openTimeMs: missedOpenTimeMs, source: "rest" }),
    );
    expect(stream.health).toEqual(
      expect.objectContaining({ state: "live", missingRanges: [] }),
    );

    stream.disconnect();
    vi.useRealTimers();
  });

  it("crypto-ai-analysis.MARKET_DATA.6 stays degraded when REST bootstrap leaves a closed-candle gap", async () => {
    const socket = new FakeWebSocket();
    const adapter: MarketDataRestAdapter = {
      getServerTime: vi.fn().mockResolvedValue(1_710_007_200_000),
      getSpotSymbols: vi.fn().mockResolvedValue([]),
      getCandles: vi.fn().mockResolvedValue([
        {
          symbol: "BTCUSDT",
          interval: "1h",
          openTimeMs: 1_710_000_000_000,
          closeTimeMs: 1_710_003_599_999,
          open: 100,
          high: 110,
          low: 90,
          close: 105,
          volume: 12.5,
          quoteVolume: 1312.5,
          tradeCount: 42,
          isClosed: true,
          source: "rest",
        },
      ]),
    };
    const stream = new BinanceKlineStream({
      restAdapter: adapter,
      webSocketFactory: () => socket,
    });

    stream.connect([{ symbol: "BTCUSDT", interval: "1h" }]);
    socket.open();
    await vi.waitFor(() => expect(stream.health.state).toBe("degraded"));

    expect(stream.health.missingRanges).toEqual([
      {
        symbol: "BTCUSDT",
        interval: "1h",
        fromMs: 1_710_003_600_000,
        toMs: 1_710_003_600_000,
      },
    ]);
    stream.disconnect();
  });

  it("crypto-ai-analysis.MARKET_DATA.6 retries an unresolved gap on the next reconnect", async () => {
    vi.useFakeTimers();
    const intervalMs = 60 * 60 * 1_000;
    const baseOpenTimeMs = 1_710_000_000_000;
    const sockets: FakeWebSocket[] = [];
    const adapter: MarketDataRestAdapter = {
      getServerTime: vi
        .fn()
        .mockResolvedValueOnce(baseOpenTimeMs + intervalMs)
        .mockResolvedValueOnce(baseOpenTimeMs + 4 * intervalMs)
        .mockResolvedValueOnce(baseOpenTimeMs + 4 * intervalMs),
      getSpotSymbols: vi.fn().mockResolvedValue([]),
      getCandles: vi
        .fn()
        .mockResolvedValueOnce([closedCandle(baseOpenTimeMs)])
        .mockResolvedValueOnce([
          closedCandle(baseOpenTimeMs + intervalMs),
          closedCandle(baseOpenTimeMs + 3 * intervalMs),
        ])
        .mockResolvedValueOnce([closedCandle(baseOpenTimeMs + 3 * intervalMs)]),
    };
    const stream = new BinanceKlineStream({
      restAdapter: adapter,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      random: () => 0,
    });

    stream.connect([{ symbol: "BTCUSDT", interval: "1h" }]);
    sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.health.state).toBe("live");

    sockets[0]!.serverClose();
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[1]!.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.health).toEqual(
      expect.objectContaining({
        state: "degraded",
        missingRanges: [
          expect.objectContaining({
            fromMs: baseOpenTimeMs + 2 * intervalMs,
            toMs: baseOpenTimeMs + 2 * intervalMs,
          }),
        ],
      }),
    );

    sockets[1]!.serverClose();
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[2]!.open();
    await vi.advanceTimersByTimeAsync(0);

    expect(adapter.getCandles).toHaveBeenLastCalledWith({
      symbol: "BTCUSDT",
      interval: "1h",
      startTimeMs: baseOpenTimeMs + 2 * intervalMs,
      endTimeMs: baseOpenTimeMs + 4 * intervalMs,
      limit: 2,
    });
    expect(stream.health.state).toBe("degraded");

    stream.disconnect();
    vi.useRealTimers();
  });
});
