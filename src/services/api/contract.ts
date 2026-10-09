import type { DrawingLine } from "../../pages/trading/constants.ts";
import type { AllPayoutsResponse } from "./accounts.ts";
import type { AccountMetricsResponse } from "./auth.ts";
import type {
  CreateJournalEntryInput,
  JournalEntriesResponse,
  JournalEntry,
  UpdateJournalEntryInput,
} from "./journal.ts";
import type { EconomicEvent, MarketDataCandlesPayload, MarketDataTick } from "./market-data.ts";
import type { MarketDataHealth } from "../market-data/types.ts";
import type { PnlCalendarResponse } from "@propsim/types";
import { z } from "zod";
import type {
  Account, AccountStats, AuthResponse, Candle, ClosedPosition, EquityPoint, Fill,
  LedgerEntry, Order, PlaceOrderInput, Position, RegisterInput, Symbol, User,
} from "../schemas.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);
export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), JsonValueSchema);

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ClosedPositionsSummary {
  pnl: number;
  commission: number;
  swap: number;
  tradeCount: number;
}

export interface FillQualityResponse {
  avgScore: number | null;
  count: number;
  entries: Array<{
    id: string;
    symbol: string;
    side: string;
    slippageBps: number;
    latencyMs: number;
    integrityCoupled: boolean;
    qualityScore: number | null;
    createdAt: string;
  }>;
}

export const ReplaySessionDataSchema = z.object({
  replaySession: z.object({
    id: z.string(),
    status: z.string(),
    speed: z.number(),
    cursorTimestamp: z.string().nullable(),
    sessionDate: z.string(),
  }),
  tickBuffer: z.array(z.object({ t: z.number(), o: z.number(), h: z.number(), l: z.number(), c: z.number(), v: z.number() })),
  tradeEvents: z.array(z.object({
    id: z.string(),
    type: z.enum(["entry", "exit", "violation"]),
    timestamp: z.string(),
    symbolName: z.string().nullable(),
    side: z.string().nullable(),
    price: z.number().nullable(),
    pnl: z.number().nullable(),
    ruleCode: z.string().optional(),
  })).nullish().transform((events) => events ?? []),
  meta: z.object({
    primarySymbol: z.string().nullable(),
    sessionDate: z.string(),
    tickCount: z.number(),
  }),
});
export type ReplaySessionData = z.infer<typeof ReplaySessionDataSchema>;

export const ReplaySessionResponseSchema = ReplaySessionDataSchema.nullable();

export interface MarketDataHealthResponse extends MarketDataHealth {
  adapter: { status: MarketDataHealth["state"] | "unavailable"; reason?: string };
  staleCount: number;
  totalSymbols: number;
  lastTickAgeMs: number;
}

export interface OrderModification {
  price?: number;
  quantity?: number;
  takeProfit?: number | null;
  stopLoss?: number | null;
}

export interface ChartDrawingsApi {
  list(symbol: string): Promise<DrawingLine[]>;
  save(symbol: string, timeframe: string, drawing: DrawingLine): Promise<{ saved: boolean }>;
  remove(drawingId: string): Promise<{ deleted: boolean }>;
  clear(symbol: string): Promise<{ cleared: boolean }>;
}

// api-type-contract-repair.API_CONTRACT.1 api-type-contract-repair.API_CONTRACT.1-1
export interface SupportedDemoApi {
  login(email: string, password: string): Promise<AuthResponse>;
  demoLogin(): Promise<AuthResponse>;
  register(data: RegisterInput): Promise<AuthResponse>;
  completeMfaLogin(mfaToken: string, code: string): Promise<AuthResponse>;
  logout(refreshToken?: string): Promise<{ success: boolean }>;
  refreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }>;
  getMyProfile(): Promise<User>;
  getMe(): Promise<User>;
  getPreferences(): Promise<Record<string, string>>;
  savePreferences(prefs: Record<string, string>): Promise<{ success: boolean }>;
  getMyAccounts(): Promise<Account[]>;
  getAccount(id: string): Promise<Account>;
  getAccountStats(id: string): Promise<AccountStats>;
  getEquityHistory(id: string): Promise<EquityPoint[]>;
  getLedger(id: string, page?: number): Promise<PaginatedResponse<LedgerEntry>>;
  getAccountMetrics(id: string): Promise<AccountMetricsResponse>;
  getSymbols(): Promise<Symbol[]>;
  getCandles(
    symbol: string,
    timeframe: string,
    limit?: number,
    range?: { fromMs: number; toMs: number },
  ): Promise<Candle[]>;
  getCandlesWithMeta(
    symbol: string,
    timeframe: string,
    limit?: number,
    range?: { fromMs: number; toMs: number },
  ): Promise<MarketDataCandlesPayload>;
  getTick(symbol: string): Promise<MarketDataTick>;
  getEconomicCalendar(
    currencies?: string[],
    from?: string,
    to?: string,
  ): Promise<EconomicEvent[]>;
  getMarketDataHealth(): Promise<MarketDataHealthResponse>;
  getOrders(accountId: string, status?: string): Promise<Order[]>;
  getPositions(accountId: string): Promise<Position[]>;
  getOpenPositionCount(): Promise<number>;
  getFills(accountId: string, page?: number): Promise<PaginatedResponse<Fill>>;
  getClosedPositions(
    accountId: string,
    page?: number,
  ): Promise<PaginatedResponse<ClosedPosition>>;
  getClosedPositionsSummary(
    accountId: string,
    from: string,
    to: string,
  ): Promise<ClosedPositionsSummary>;
  getFillQuality(accountId: string): Promise<FillQualityResponse>;
  placeOrder(input: PlaceOrderInput): Promise<Order>;
  cancelOrder(orderId: string): Promise<{ success: boolean }>;
  closePosition(positionId: string, quantity?: number): Promise<{ success: boolean }>;
  closeAllPositions(accountId?: string): Promise<{ success: boolean }>;
  modifyPosition(
    positionId: string,
    modifications: { takeProfit?: number | null; stopLoss?: number | null },
  ): Promise<Position | undefined>;
  getJournalEntries(
    accountId: string,
    opts?: { limit?: number; offset?: number; symbol?: string },
  ): Promise<JournalEntriesResponse>;
  createJournalEntry(data: CreateJournalEntryInput): Promise<JournalEntry>;
  updateJournalEntry(id: string, data: UpdateJournalEntryInput): Promise<JournalEntry>;
  deleteJournalEntry(id: string): Promise<void>;
  getFeatureFlags(): Promise<Record<string, boolean>>;
  isAiTraderEnabled(): Promise<{ enabled: boolean }>;
  replayGetSession(accountId: string, date: string): Promise<ReplaySessionData | null>;
  getAnnouncements(page?: number): Promise<Announcement[]>;
  getAnnouncementsUnreadCount(): Promise<number>;
  chartDrawings: ChartDrawingsApi;
}

export interface Announcement {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  isRead: boolean;
}

// api-type-contract-repair.API_CONTRACT.2-2 api-type-contract-repair.COMPATIBILITY.2
// These legacy backend capabilities reject explicitly in the standalone demo.
export interface UnsupportedDemoApi {
  setAccountLabel(id: string, label: string): Promise<Account>;
  cancelAllOrders(accountId?: string): Promise<{ success: boolean }>;
  changePassword(currentPassword: string, newPassword: string): Promise<{ success: boolean }>;
  getAllPayouts(): Promise<AllPayoutsResponse>;
  modifyOrder(orderId: string, modifications: OrderModification): Promise<Order | undefined>;
  getLeaderboard(period?: string): Promise<never>;
  getFirmLeaderboard(period?: string): Promise<never>;
  getLeaderboardStats(period?: string): Promise<never>;
  getLeaderboardPrizes(): Promise<never>;
  getMyLeaderboardRank(period?: string): Promise<never>;
  getMyAwards(): Promise<never>;
  getActiveCompetitions(): Promise<never>;
  getMyCompetitionEntries(): Promise<never>;
  getCompetitionRankings(competitionId: string, limit?: number): Promise<never>;
  enrollInCompetition(competitionId: string): Promise<never>;
  getMyCertificates(): Promise<never>;
  getMyTickets(): Promise<never>;
  getTicket(id: string): Promise<never>;
  createTicket(data: {
    subject: string;
    message: string;
    category?: string;
    priority?: string;
    accountId?: string | null;
  }): Promise<never>;
  replyToTicket(id: string, message: string, attachments?: string[]): Promise<never>;
  closeTicket(id: string): Promise<never>;
  validateCoupon(code: string): Promise<never>;
  getAnalyticsSnapshots(params?: {
    accountId?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }): Promise<never>;
  getAnalyticsAggregate(accountId?: string): Promise<never>;
  getPatterns(accountId: string, lookbackDays?: number): Promise<never>;
  getDailyPnl(accountIds: string[], from: string, to: string): Promise<PnlCalendarResponse>;
  getMyFirm(): Promise<JsonObject>;
  getAiTraderHistory(accountId: string): Promise<JsonValue[]>;
  createAiTraderPlan(data: {
    accountId: string;
    message: string;
    context?: {
      selectedSymbol?: string;
      timezone?: string;
      deterministicMode?: boolean;
      readOnlyMode?: boolean;
    };
  }): Promise<{ autoExecuted?: boolean }>;
  executeAiTraderPlan(data: { planId: string; accountId: string; confirm: true }): Promise<JsonObject>;
  clearAiTraderHistory(accountId: string): Promise<{ success: boolean }>;
  getBotActivityLogs(limit?: number): Promise<JsonObject[]>;
  getBotStatus(): Promise<JsonObject>;
  connectBot(): Promise<{ success: boolean }>;
  disconnectBot(): Promise<{ success: boolean }>;
  getVapidPublicKey(): Promise<string | null>;
  getPushSubscriptions(): Promise<JsonObject[]>;
  subscribePush(subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }): Promise<{ success: boolean }>;
  unsubscribePush(endpoint: string): Promise<{ success: boolean }>;
  sendTestNotification(): Promise<{ success: boolean }>;
  getBotIntegrations(): Promise<JsonObject[]>;
  createBotIntegration(data: {
    platform: "discord" | "telegram";
    webhookUrl: string;
    chatId?: string;
    events: string[];
  }): Promise<JsonObject>;
  updateBotIntegration(
    id: string,
    data: Partial<{ webhookUrl: string; chatId: string; events: string[]; isActive: boolean }>,
  ): Promise<JsonObject>;
  deleteBotIntegration(id: string): Promise<{ success: boolean }>;
  testBotIntegration(platform: string): Promise<{ success: boolean }>;
  updateProfile(data: {
    displayName: string;
    bio?: string;
    avatarUrl?: string;
    isVisible?: boolean;
    showStats?: boolean;
    showEquityCurve?: boolean;
    socialLinks?: Record<string, string>;
  }): Promise<JsonObject>;
  getPublicProfiles(page?: number): Promise<JsonValue[]>;
  getPublicProfile(userId: string): Promise<JsonObject>;
  getScalingPlans(): Promise<JsonValue[]>;
  createScalingPlan(data: {
    name: string;
    description?: string;
    milestones: Array<{ targetPnl: number; scalePercent: number; minDays: number; label: string }>;
    isDefault?: boolean;
  }): Promise<JsonObject>;
  getScalingProgress(accountId: string): Promise<JsonObject>;
  enrollScaling(accountId: string, scalingPlanId: string): Promise<{ success: boolean }>;
  getProfitSplitConfig(): Promise<JsonValue[]>;
  updateProfitSplitConfig(
    tiers: Array<{ minPayouts: number; splitPercent: number; label: string }>,
  ): Promise<{ success: boolean }>;
  getMyProfitSplit(): Promise<JsonObject>;
  requestAccountMerge(data: {
    sourceAccountId: string;
    targetAccountId: string;
    reason?: string;
  }): Promise<JsonObject>;
  getMergeRequests(): Promise<JsonValue[]>;
  processMergeRequest(
    id: string,
    status: "APPROVED" | "REJECTED",
    adminNotes?: string,
  ): Promise<JsonObject>;
  markAnnouncementRead(id: string): Promise<{ success: boolean }>;
  markAllAnnouncementsRead(): Promise<{ success: boolean }>;
}

export type OpenChartsApi = SupportedDemoApi;
