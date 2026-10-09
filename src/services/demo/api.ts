import type { DrawingLine } from "../../pages/trading/constants.ts";
import { ReplaySessionResponseSchema } from "../api/contract.ts";
import { MarketDataCandlesPayloadSchema } from "../api/market-data.ts";
import {
  JournalEntriesResponseSchema,
  JournalEntrySchema,
} from "../api/journal.ts";
import type {
  CreateJournalEntryInput,
  JournalEntry,
  UpdateJournalEntryInput,
} from "../api/journal.ts";
import type {
  AccountStats,
  Candle,
  PlaceOrderInput,
  RegisterInput,
} from "../schemas.ts";
import {
  AccountSchema,
  AccountStatsSchema,
  CandleSchema,
  ClosedPositionSchema,
  FillSchema,
  OrderSchema,
  PositionSchema,
  SymbolSchema,
} from "../schemas.ts";
import type {
  Announcement,
  ClosedPositionsSummary,
  FillQualityResponse,
  MarketDataHealthResponse,
  OpenChartsApi,
  OrderModification,
  ReplaySessionData,
  UnsupportedDemoApi,
} from "../api/contract.ts";
import { unsupported } from "../api/errors.ts";
import { browserMarketDataApi, marketDataMode } from "../market-data/runtime.ts";
import { getHistory } from "./candles.ts";
import * as engine from "./engine.ts";
import { DEMO_SYMBOLS } from "./instruments.ts";

/**
 * Demo-mode API. Replaces the HTTP client for everything the terminal needs:
 * trading actions hit the in-browser paper engine, market data comes from the
 * bundled real OHLC, and chart drawings persist to localStorage. Methods not
 * implemented here are explicitly rejected below so callers can distinguish
 * unavailable demo capabilities from successful empty responses.
 */

const DEMO_USER = {
  id: "demo-user",
  email: "demo@opencharts.dev",
  firstName: "Demo",
  lastName: "Trader",
  roles: ["trader"],
  status: "ACTIVE",
  createdAt: new Date().toISOString(),
};

function authResponse() {
  return { accessToken: "demo-token", refreshToken: "demo-refresh", user: DEMO_USER };
}

// ── Chart drawings (localStorage) ─────────────────────────
const DRAW_KEY = (symbol: string) => `oc_drawings_${symbol}`;

function readDrawings(symbol: string): DrawingLine[] {
  try {
    return JSON.parse(localStorage.getItem(DRAW_KEY(symbol)) ?? "[]");
  } catch {
    return [];
  }
}
function writeDrawings(symbol: string, list: DrawingLine[]): void {
  localStorage.setItem(DRAW_KEY(symbol), JSON.stringify(list));
}

const chartDrawings = {
  list: (symbol: string) => Promise.resolve(readDrawings(symbol)),
  save: (symbol: string, _tf: string, drawing: DrawingLine) => {
    const list = readDrawings(symbol).filter((d) => d.id !== drawing.id);
    list.push(drawing);
    writeDrawings(symbol, list);
    return Promise.resolve({ saved: true });
  },
  remove: (drawingId: string) => {
    for (const s of DEMO_SYMBOLS) {
      writeDrawings(s.name, readDrawings(s.name).filter((d) => d.id !== drawingId));
    }
    return Promise.resolve({ deleted: true });
  },
  clear: (symbol: string) => {
    writeDrawings(symbol, []);
    return Promise.resolve({ cleared: true });
  },
};

const DEMO_JOURNAL_KEY = `opencharts-demo-journal-v1:${DEMO_USER.id}`;

function readDemoJournalEntries(): JournalEntry[] {
  const stored = localStorage.getItem(DEMO_JOURNAL_KEY);
  if (!stored) return [];

  try {
    return JournalEntrySchema.array().parse(JSON.parse(stored));
  } catch (error) {
    const backupKey = `${DEMO_JOURNAL_KEY}:invalid:${Date.now()}`;
    localStorage.setItem(backupKey, stored);
    localStorage.removeItem(DEMO_JOURNAL_KEY);
    console.error("Invalid Demo journal data was backed up", error);
    return [];
  }
}

function writeDemoJournalEntries(entries: JournalEntry[]): void {
  localStorage.setItem(DEMO_JOURNAL_KEY, JSON.stringify(JournalEntrySchema.array().parse(entries)));
}

// api-type-contract-repair.RUNTIME_COMPATIBILITY.1
const demoJournalApi = {
  getJournalEntries: async (
    accountId: string,
    opts?: { limit?: number; offset?: number; symbol?: string },
  ) => {
    let entries = readDemoJournalEntries();
    if (opts?.symbol) {
      entries = entries.filter(
        (entry) => entry.symbolName?.toUpperCase() === opts.symbol?.toUpperCase(),
      );
    }
    entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const offset = Math.max(0, opts?.offset ?? 0);
    const end = opts?.limit == null ? undefined : offset + Math.max(0, opts.limit);
    return JournalEntriesResponseSchema.parse({
      entries: entries.slice(offset, end).map((entry) => ({ ...entry, accountId })),
      total: entries.length,
    });
  },
  createJournalEntry: async (data: CreateJournalEntryInput) => {
    const entry = JournalEntrySchema.parse({
      ...data,
      id: crypto.randomUUID(),
      tags: data.tags ?? [],
      notes: data.notes ?? "",
      createdAt: new Date().toISOString(),
    });
    writeDemoJournalEntries([...readDemoJournalEntries(), entry]);
    return entry;
  },
  updateJournalEntry: async (id: string, data: UpdateJournalEntryInput) => {
    const entries = readDemoJournalEntries();
    const index = entries.findIndex((entry) => entry.id === id);
    if (index === -1) throw new Error(`Journal entry ${id} was not found`);

    const entry = JournalEntrySchema.parse({ ...entries[index], ...data });
    entries[index] = entry;
    writeDemoJournalEntries(entries);
    return entry;
  },
  deleteJournalEntry: async (id: string) => {
    writeDemoJournalEntries(readDemoJournalEntries().filter((entry) => entry.id !== id));
  },
};

// api-type-contract-repair.RUNTIME_COMPATIBILITY.2
const candlesMeta = (candles: Candle[]): import("../api/market-data.ts").MarketDataCandlesPayload => ({
  candles: candles.map((candle) => ({
    ...candle,
    timestamp: candle.timestamp ?? candle.time,
  })),
  metadata: { isPartial: false, backfillQueued: false, historicalCoverageStart: null },
});

const supportedDemoApi = {
  // ── Auth (no real auth in demo) ──
  login: () => Promise.resolve(authResponse()),
  demoLogin: () => Promise.resolve(authResponse()),
  register: (_data: RegisterInput) => Promise.resolve(authResponse()),
  completeMfaLogin: (_mfaToken: string, _code: string) => Promise.resolve(authResponse()),
  logout: (_refreshToken?: string) => Promise.resolve({ success: true }),
  refreshToken: (_refreshToken: string) =>
    Promise.resolve({ accessToken: "demo-token", refreshToken: "demo-refresh" }),
  getMyProfile: () => Promise.resolve(DEMO_USER),
  getMe: () => Promise.resolve(DEMO_USER),
  getPreferences: () => Promise.resolve({}),

  // ── Accounts ──
  getMyAccounts: () => Promise.resolve(AccountSchema.array().parse(engine.getAccounts())),
  getAccount: (_id: string) => Promise.resolve(AccountSchema.parse(engine.getAccount())),
  getEquityHistory: (_id: string) => Promise.resolve([]),
  getLedger: (_id: string, page = 1) =>
    Promise.resolve({ data: [], total: 0, page, pageSize: 50, totalPages: 0 }),
  getAccountStats: (_id: string): Promise<AccountStats> =>
    Promise.resolve(AccountStatsSchema.parse({
      totalTrades: 0,
      winRate: 0,
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
      bestTrade: 0,
      worstTrade: 0,
    })),
  getAccountMetrics: (accountId: string) => {
    const a = engine.getAccount();
    return Promise.resolve({
      accountId,
      equity: a.equity,
      balance: a.balance,
      freeMargin: a.freeMargin,
      marginUsed: a.margin,
      floatingPnl: a.equity - a.balance,
      dailyPnl: 0,
      ddDaily: null,
      ddDailyMax: null,
      ddTotal: null,
      ddTotalMax: null,
      ddTrailing: null,
      ddTrailingMax: null,
      trailingDrawdownFloor: null,
      trailingDrawdownPeak: null,
      trailingDrawdownMode: null,
      trailingDrawdownTrailMode: null,
      trailingDrawdownFloorLocked: false,
      trailingDrawdownTrailToBreakeven: false,
      profitTargetPercent: null,
      profitTargetProgress: 0,
      minTradingDays: null,
      tradingDaysCompleted: 0,
      minDaysProgress: 0,
      status: a.status,
      phase: a.phase,
      highWaterMark: a.balance,
      startingBalance: a.template?.startingBalance ?? a.balance,
      currency: "USD",
      lastMarkTs: new Date().toISOString(),
    });
  },

  // ── Symbols & market data ──
  getSymbols: () =>
    marketDataMode === "binance"
      ? browserMarketDataApi.getSymbols().then((symbols) => SymbolSchema.array().parse(symbols))
      : Promise.resolve(SymbolSchema.array().parse(DEMO_SYMBOLS)),
  getCandles: (
    symbol: string,
    timeframe: string,
    limit?: number,
    range?: { fromMs: number; toMs: number },
  ) =>
    marketDataMode === "binance"
      ? browserMarketDataApi.getCandles(symbol, timeframe, limit, range)
          .then((candles) => CandleSchema.array().parse(candles))
      : Promise.resolve(CandleSchema.array().parse(getHistory(symbol, timeframe, limit))),
  getCandlesWithMeta: (
    symbol: string,
    timeframe: string,
    limit?: number,
    range?: { fromMs: number; toMs: number },
  ): Promise<import("../api/market-data.ts").MarketDataCandlesPayload> =>
    marketDataMode === "binance"
      ? browserMarketDataApi.getCandlesWithMeta(symbol, timeframe, limit, range)
          .then((payload) => MarketDataCandlesPayloadSchema.parse(payload))
      : Promise.resolve(candlesMeta(getHistory(symbol, timeframe, limit)))
          .then((payload) => MarketDataCandlesPayloadSchema.parse(payload)),
  getTick: (symbol: string) => {
    if (marketDataMode === "binance") {
      return browserMarketDataApi.getTick(symbol).then((tick) => {
        engine.mark(symbol, (tick.bid + tick.ask) / 2);
        return tick;
      });
    }
    const price = engine.getLastPrice(symbol);
    return Promise.resolve({ symbol, bid: price, ask: price, timestamp: Date.now() });
  },
  getMarketDataHealth: (): Promise<MarketDataHealthResponse> =>
    marketDataMode === "binance"
      ? browserMarketDataApi.getMarketDataHealth()
      : Promise.resolve({
          state: "live",
          serverTimeMs: Date.now(),
          lastMessageAtMs: Date.now(),
          lastClosedCandleAtMs: Date.now(),
          missingRanges: [],
          adapter: { status: "live" },
          staleCount: 0,
          totalSymbols: DEMO_SYMBOLS.length,
          lastTickAgeMs: 0,
        }),
  getEconomicCalendar: (
    _currencies?: string[],
    _from?: string,
    _to?: string,
  ) => Promise.resolve([]),

  // ── Trading (paper engine) ──
  placeOrder: (data: PlaceOrderInput) => Promise.resolve(OrderSchema.parse(engine.placeOrder(data))),
  cancelOrder: (orderId: string) => Promise.resolve(engine.cancelOrder(orderId)),
  getOrders: (_accountId: string, _status?: string) =>
    Promise.resolve(OrderSchema.array().parse(engine.getOrders())),
  getPositions: (_accountId: string) =>
    Promise.resolve(PositionSchema.array().parse(engine.getPositions())),
  getOpenPositionCount: () => Promise.resolve(engine.getPositions().length),
  closePosition: (positionId: string, quantity?: number) =>
    Promise.resolve(engine.closePosition(positionId, quantity)),
  closeAllPositions: () => Promise.resolve(engine.closeAllPositions()),
  modifyPosition: (positionId: string, mods: { takeProfit?: number | null; stopLoss?: number | null }) =>
    Promise.resolve(engine.modifyPosition(positionId, mods)),
  getFills: (_accountId: string, page = 1) =>
    Promise.resolve({
      data: FillSchema.array().parse(engine.getFills()),
      total: engine.getFills().length,
      page,
      pageSize: 50,
      totalPages: Math.max(1, Math.ceil(engine.getFills().length / 50)),
    }),
  getClosedPositions: (_accountId: string, page = 1) =>
    Promise.resolve({
      data: ClosedPositionSchema.array().parse(engine.getClosedPositions()),
      total: engine.getClosedPositions().length,
      page,
      pageSize: 50,
      totalPages: Math.max(1, Math.ceil(engine.getClosedPositions().length / 50)),
    }),
  getClosedPositionsSummary: (
    _accountId: string,
    _from: string,
    _to: string,
  ): Promise<ClosedPositionsSummary> =>
    Promise.resolve({ pnl: 0, commission: 0, swap: 0, tradeCount: 0 }),
  getFillQuality: (_accountId: string): Promise<FillQualityResponse> =>
    Promise.resolve({ avgScore: null, count: 0, entries: [] }),

  // ── Trade journal ──
  ...demoJournalApi,

  // ── Chart persistence ──
  chartDrawings,
  savePreferences: (_prefs: Record<string, string>) => Promise.resolve({ success: true }),

  // ── Feature gating / misc (terminal reads these on mount) ──
  getFeatureFlags: () => Promise.resolve({}),
  isAiTraderEnabled: () => Promise.resolve({ enabled: false }),
  getAnnouncements: (_page?: number): Promise<Announcement[]> => Promise.resolve([]),
  getAnnouncementsUnreadCount: () => Promise.resolve(0),
  replayGetSession: (_accountId: string, _date: string): Promise<ReplaySessionData | null> =>
    Promise.resolve(ReplaySessionResponseSchema.parse(null)),
} as const;

export const unsupportedDemoApi: UnsupportedDemoApi = {
  setAccountLabel: (_id: string, _label: string) => unsupported("setAccountLabel"),
  cancelAllOrders: (_accountId?: string) => unsupported("cancelAllOrders"),
  changePassword: (_currentPassword: string, _newPassword: string) => unsupported("changePassword"),
  getAllPayouts: () => unsupported("getAllPayouts"),
  modifyOrder: (_orderId: string, _modifications: OrderModification) => unsupported("modifyOrder"),
  getLeaderboard: (_period?: string) => unsupported("getLeaderboard"),
  getFirmLeaderboard: (_period?: string) => unsupported("getFirmLeaderboard"),
  getLeaderboardStats: (_period?: string) => unsupported("getLeaderboardStats"),
  getLeaderboardPrizes: () => unsupported("getLeaderboardPrizes"),
  getMyLeaderboardRank: (_period?: string) => unsupported("getMyLeaderboardRank"),
  getMyAwards: () => unsupported("getMyAwards"),
  getActiveCompetitions: () => unsupported("getActiveCompetitions"),
  getMyCompetitionEntries: () => unsupported("getMyCompetitionEntries"),
  getCompetitionRankings: (_competitionId: string, _limit?: number) =>
    unsupported("getCompetitionRankings"),
  enrollInCompetition: (_competitionId: string) => unsupported("enrollInCompetition"),
  getMyCertificates: () => unsupported("getMyCertificates"),
  getMyTickets: () => unsupported("getMyTickets"),
  getTicket: (_id: string) => unsupported("getTicket"),
  createTicket: (_data: {
    subject: string;
    message: string;
    category?: string;
    priority?: string;
    accountId?: string | null;
  }) => unsupported("createTicket"),
  replyToTicket: (_id: string, _message: string, _attachments?: string[]) => unsupported("replyToTicket"),
  closeTicket: (_id: string) => unsupported("closeTicket"),
  validateCoupon: (_code: string) => unsupported("validateCoupon"),
  getAnalyticsSnapshots: (_params?: {
    accountId?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }) => unsupported("getAnalyticsSnapshots"),
  getAnalyticsAggregate: (_accountId?: string) => unsupported("getAnalyticsAggregate"),
  getPatterns: (_accountId: string, _lookbackDays?: number) => unsupported("getPatterns"),
  getDailyPnl: (_accountIds: string[], _from: string, _to: string) => unsupported("getDailyPnl"),
  getMyFirm: () => unsupported("getMyFirm"),
  getAiTraderHistory: (_accountId: string) => unsupported("getAiTraderHistory"),
  createAiTraderPlan: (_data: {
    accountId: string;
    message: string;
    context?: {
      selectedSymbol?: string;
      timezone?: string;
      deterministicMode?: boolean;
      readOnlyMode?: boolean;
    };
  }) => unsupported("createAiTraderPlan"),
  executeAiTraderPlan: (_data: { planId: string; accountId: string; confirm: true }) =>
    unsupported("executeAiTraderPlan"),
  clearAiTraderHistory: (_accountId: string) => unsupported("clearAiTraderHistory"),
  getBotActivityLogs: (_limit?: number) => unsupported("getBotActivityLogs"),
  getBotStatus: () => unsupported("getBotStatus"),
  connectBot: () => unsupported("connectBot"),
  disconnectBot: () => unsupported("disconnectBot"),
  getVapidPublicKey: () => unsupported("getVapidPublicKey"),
  getPushSubscriptions: () => unsupported("getPushSubscriptions"),
  subscribePush: (_subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    unsupported("subscribePush"),
  unsubscribePush: (_endpoint: string) => unsupported("unsubscribePush"),
  sendTestNotification: () => unsupported("sendTestNotification"),
  getBotIntegrations: () => unsupported("getBotIntegrations"),
  createBotIntegration: (_data: {
    platform: "discord" | "telegram";
    webhookUrl: string;
    chatId?: string;
    events: string[];
  }) => unsupported("createBotIntegration"),
  updateBotIntegration: (
    _id: string,
    _data: Partial<{ webhookUrl: string; chatId: string; events: string[]; isActive: boolean }>,
  ) => unsupported("updateBotIntegration"),
  deleteBotIntegration: (_id: string) => unsupported("deleteBotIntegration"),
  testBotIntegration: (_platform: string) => unsupported("testBotIntegration"),
  updateProfile: (_data: {
    displayName: string;
    bio?: string;
    avatarUrl?: string;
    isVisible?: boolean;
    showStats?: boolean;
    showEquityCurve?: boolean;
    socialLinks?: Record<string, string>;
  }) => unsupported("updateProfile"),
  getPublicProfiles: (_page?: number) => unsupported("getPublicProfiles"),
  getPublicProfile: (_userId: string) => unsupported("getPublicProfile"),
  getScalingPlans: () => unsupported("getScalingPlans"),
  createScalingPlan: (_data: {
    name: string;
    description?: string;
    milestones: Array<{ targetPnl: number; scalePercent: number; minDays: number; label: string }>;
    isDefault?: boolean;
  }) => unsupported("createScalingPlan"),
  getScalingProgress: (_accountId: string) => unsupported("getScalingProgress"),
  enrollScaling: (_accountId: string, _scalingPlanId: string) => unsupported("enrollScaling"),
  getProfitSplitConfig: () => unsupported("getProfitSplitConfig"),
  updateProfitSplitConfig: (
    _tiers: Array<{ minPayouts: number; splitPercent: number; label: string }>,
  ) => unsupported("updateProfitSplitConfig"),
  getMyProfitSplit: () => unsupported("getMyProfitSplit"),
  requestAccountMerge: (_data: {
    sourceAccountId: string;
    targetAccountId: string;
    reason?: string;
  }) => unsupported("requestAccountMerge"),
  getMergeRequests: () => unsupported("getMergeRequests"),
  processMergeRequest: (
    _id: string,
    _status: "APPROVED" | "REJECTED",
    _adminNotes?: string,
  ) => unsupported("processMergeRequest"),
  markAnnouncementRead: (_id: string) => unsupported("markAnnouncementRead"),
  markAllAnnouncementsRead: () => unsupported("markAllAnnouncementsRead"),
};

// api-type-contract-repair.API_CONTRACT.2 api-type-contract-repair.API_CONTRACT.2-2
export const demoApi: OpenChartsApi = supportedDemoApi;
