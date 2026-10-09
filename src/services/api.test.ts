// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ReplaySessionDataSchema,
  type OpenChartsApi,
  type UnsupportedDemoApi,
} from "./api/contract.ts";
import { accountsApi } from "./api/accounts.ts";

let api: OpenChartsApi;
let unsupportedApi: UnsupportedDemoApi;

beforeAll(async () => {
  vi.stubEnv("VITE_MARKET_DATA_MODE", "demo");
  ({ api, unsupportedApi } = await import("./api.ts"));
});

afterAll(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllGlobals());

describe("Demo API contract", () => {
  it("api-type-contract-repair.API_CONTRACT.1-2 exposes no fallback for undeclared methods", () => {
    expect(Reflect.get(api, "notARealMethod")).toBeUndefined();
    expect(Reflect.get(api, "getAllPayouts")).toBeUndefined();
  });

  it("api-type-contract-repair.API_CONTRACT.2-2 rejects unavailable backend capabilities", async () => {
    await expect(unsupportedApi.getAllPayouts()).rejects.toMatchObject({
      code: "DEMO_UNSUPPORTED",
      capability: "getAllPayouts",
    });
    await expect(unsupportedApi.setAccountLabel("demo", "Updated")).rejects.toMatchObject({
      code: "DEMO_UNSUPPORTED",
      capability: "setAccountLabel",
    });
    await expect(unsupportedApi.cancelAllOrders("demo")).rejects.toMatchObject({
      code: "DEMO_UNSUPPORTED",
      capability: "cancelAllOrders",
    });
  });

  it("api-type-contract-repair.REGRESSION_COVERAGE.1-1 returns typed empty pagination for a parameterized query", async () => {
    const account = (await api.getMyAccounts())[0]!;
    const result = await api.getLedger(account.id, 3);

    expect(result).toEqual({ data: [], total: 0, page: 3, pageSize: 50, totalPages: 0 });
  });

  it("api-type-contract-repair.REGRESSION_COVERAGE.1-1 preserves mutation output types", async () => {
    const account = (await api.getMyAccounts())[0]!;
    const order = await api.placeOrder({
      accountId: account.id,
      symbol: "BTCUSDT",
      side: "BUY",
      type: "MARKET",
      quantity: 0.01,
      price: 100,
    });

    expect(order).toMatchObject({ accountId: account.id, symbolName: "BTCUSDT", status: "FILLED" });
    await api.closeAllPositions(account.id);
  });

  it("api-type-contract-repair.QUERY_LAYER.2-2 returns market metadata with non-null candle timestamps", async () => {
    const result = await api.getCandlesWithMeta("BTCUSDT", "1h", 2);

    expect(result.metadata).toEqual({
      isPartial: false,
      backfillQueued: false,
      historicalCoverageStart: null,
    });
    expect(result.candles.every((candle) => candle.timestamp !== undefined)).toBe(true);
  });

  it("api-type-contract-repair.QUERY_LAYER.2-1 represents an empty replay session explicitly", async () => {
    await expect(api.replayGetSession("missing-account", "2026-01-01")).resolves.toBeNull();
  });

  it("api-type-contract-repair.QUERY_LAYER.2-1 accepts an empty session from the HTTP API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("null", { status: 200 })));

    await expect(accountsApi.replayGetSession("demo-account", "2026-01-01")).resolves.toBeNull();
  });

  it("api-type-contract-repair.QUERY_LAYER.2-1 unwraps a nullable replay response envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"data":null}', { status: 200 })),
    );

    await expect(accountsApi.replayGetSession("demo-account", "2026-01-01")).resolves.toBeNull();
  });

  it("api-type-contract-repair.QUERY_LAYER.2-1 defaults missing replay events to an empty list", () => {
    const session = ReplaySessionDataSchema.parse({
      replaySession: {
        id: "replay-1",
        status: "paused",
        speed: 1,
        cursorTimestamp: null,
        sessionDate: "2026-01-01",
      },
      tickBuffer: [],
      meta: { primarySymbol: null, sessionDate: "2026-01-01", tickCount: 0 },
    });

    expect(session.tradeEvents).toEqual([]);
  });

  it("api-type-contract-repair.RUNTIME_COMPATIBILITY.1 persists Demo journal entries through their CRUD flow", async () => {
    const accountId = `journal-${crypto.randomUUID()}`;
    const created = await api.createJournalEntry({
      accountId,
      symbolName: "BTCUSDT",
      notes: "Initial note",
      tags: ["demo"],
    });

    expect(created).toMatchObject({
      accountId,
      symbolName: "BTCUSDT",
      notes: "Initial note",
      tags: ["demo"],
    });

    const updated = await api.updateJournalEntry(created.id, { notes: "Updated note" });
    expect(updated.notes).toBe("Updated note");
    const refreshedAccountId = `${accountId}-after-reload`;
    await expect(
      api.getJournalEntries(refreshedAccountId, { limit: 1, symbol: "BTCUSDT" }),
    ).resolves.toEqual({
      entries: [{ ...updated, accountId: refreshedAccountId }],
      total: 1,
    });

    await api.deleteJournalEntry(created.id);
    await expect(api.getJournalEntries(refreshedAccountId)).resolves.toEqual({
      entries: [],
      total: 0,
    });
  });
});

describe("firm cache validation", () => {
  it("api-type-contract-repair.QUERY_LAYER.1-1 rejects cached values that do not match the API response shape", async () => {
    const { parseCachedFirm } = await import("./queries.ts");

    expect(parseCachedFirm('{"data":null,"cachedAt":1}')).toBeUndefined();
    expect(parseCachedFirm('{"data":[],"cachedAt":1}')).toBeUndefined();
    expect(parseCachedFirm('{"data":{"firm":{"name":"Demo"}},"cachedAt":"1"}'))
      .toBeUndefined();
    expect(parseCachedFirm("not-json")).toBeUndefined();
  });

  it("api-type-contract-repair.QUERY_LAYER.1-1 accepts a valid cached firm response", async () => {
    const { parseCachedFirm } = await import("./queries.ts");

    expect(parseCachedFirm('{"data":{"firm":{"name":"Demo"}},"cachedAt":1}')).toEqual({
      firm: { name: "Demo" },
    });
  });
});
