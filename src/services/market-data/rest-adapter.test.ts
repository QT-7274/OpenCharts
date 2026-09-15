import { describe, expect, it, vi } from "vitest";
import { createBinanceRestAdapter, type FetchLike } from "./rest-adapter.ts";

describe("Binance REST adapter", () => {
  it("crypto-ai-analysis.MARKET_DATA.1 crypto-ai-analysis.MARKET_DATA.1-1 crypto-ai-analysis.DATA_BOUNDARY.1 crypto-ai-analysis.DATA_BOUNDARY.2 uses public injected transport", async () => {
    const fetchFn = vi.fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ serverTime: 1_710_003_600_000 }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            [
              1_710_000_000_000,
              "100",
              "110",
              "90",
              "105",
              "12.5",
              1_710_003_599_999,
              "1312.5",
              42,
              "0",
              "0",
              "0",
            ],
          ]),
          { status: 200 },
        ),
      );
    const adapter = createBinanceRestAdapter({
      baseUrl: "https://market-data.example/api/v3/",
      fetchFn,
    });

    const result = await adapter.getCandles({
      symbol: "BTCUSDT",
      interval: "1h",
      startTimeMs: 1_710_000_000_000,
      endTimeMs: 1_710_003_600_000,
      limit: 25,
    });

    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      "https://market-data.example/api/v3/time",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "https://market-data.example/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=1710000000000&endTime=1710003600000&limit=25",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual([
      expect.objectContaining({
        symbol: "BTCUSDT",
        interval: "1h",
        openTimeMs: 1_710_000_000_000,
        closeTimeMs: 1_710_003_599_999,
        close: 105,
        isClosed: true,
        source: "rest",
      }),
    ]);
  });

  it("crypto-ai-analysis.MARKET_DATA.4 honors Retry-After for rate-limited requests", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response("rate limited", { status: 429, headers: { "Retry-After": "2" } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ serverTime: 1_710_003_600_000 }), { status: 200 }),
      );
    const adapter = createBinanceRestAdapter({ fetchFn, sleep });

    await expect(adapter.getServerTime()).resolves.toBe(1_710_003_600_000);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("crypto-ai-analysis.MARKET_DATA.4 retries a transient transport failure", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi
      .fn<FetchLike>()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ serverTime: 1_710_003_600_000 }), { status: 200 }),
      );
    const adapter = createBinanceRestAdapter({ fetchFn, sleep });

    await expect(adapter.getServerTime()).resolves.toBe(1_710_003_600_000);
    expect(sleep).toHaveBeenCalledWith(500);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
