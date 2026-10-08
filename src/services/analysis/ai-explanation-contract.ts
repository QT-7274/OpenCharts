import { z } from "zod";
import type { AnalysisAttempt } from "./pipeline.ts";

const finite = z.number().finite();
const nullableFinite = finite.nullable();
const interval = z.enum(["1d", "4h", "1h"]);

export const aiExplanationTextSchema = z.object({
  summary: z.string().min(1).max(240),
  trendExplanation: z.string().min(1).max(400),
  indicatorEvidence: z.array(z.string().min(1).max(180)).min(1).max(4),
  entryExplanation: z.string().min(1).max(320),
  riskExplanation: z.string().min(1).max(320),
  cautionNotes: z.array(z.string().min(1).max(180)).max(5),
  educationalNotes: z.array(z.string().min(1).max(180)).max(3),
}).strict();

const intervalIndicatorSchema = z.object({
  interval,
  candleCloseTimeMs: finite,
  close: finite,
  ema20: finite,
  ema50: finite,
  ema200: nullableFinite,
  ema20ThreeBarsAgo: finite,
  ema50FiveBarsAgo: nullableFinite,
  atr14: finite,
  rsi14: finite,
  previousRsi14: finite,
  macdHistogram: finite,
  previousMacdHistogram: finite,
  volume: finite,
  volumeSma20: finite,
}).strict();

const zoneSchema = z.object({
  price: finite,
  lower: finite,
  upper: finite,
  touches: finite,
}).strict();

export const aiExplanationSnapshotSchema = z.object({
  symbol: z.enum(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"]),
  analysisTimeMs: nullableFinite,
  trigger: z.enum(["manual", "hourly-close"]),
  strategyVersion: z.literal("trend-pullback-v1"),
  status: z.enum(["ready", "insufficient-data"]),
  candleCloseTimes: z.object({ "1d": nullableFinite, "4h": nullableFinite, "1h": nullableFinite }).strict(),
  issues: z.array(z.object({
    interval,
    code: z.enum(["invalid-candle", "conflict", "gap", "warmup", "stale", "unavailable"]),
  }).strict()).max(60),
  indicators: z.object({ "1d": intervalIndicatorSchema, "4h": intervalIndicatorSchema, "1h": intervalIndicatorSchema })
    .strict()
    .refine((value) => value["1d"].interval === "1d" && value["4h"].interval === "4h" && value["1h"].interval === "1h")
    .nullable(),
  trend: z.object({
    direction: z.enum(["bullish", "not-bullish"]),
    dailyPassed: z.number().int().min(0).max(3),
    fourHourPassed: z.number().int().min(0).max(3),
  }).strict().nullable(),
  strategy: z.object({
    state: z.enum(["watch", "setup", "enter", "avoid"]),
    avoidReason: z.string().max(80).nullable(),
    score: finite.min(0).max(100),
    scoreBreakdown: z.object({
      trendQuality: finite,
      pullbackQuality: finite,
      priceConfirmation: finite,
      momentum: finite,
      volume: finite,
      volatilityAndFreshness: finite,
      total: finite,
    }).strict(),
    pullbackValid: z.boolean(),
    confirmationPassed: z.boolean(),
    riskReward: nullableFinite,
  }).strict().nullable(),
  currentPrice: nullableFinite,
  quoteTradeTimeMs: nullableFinite,
  quoteServerTimeMs: nullableFinite,
  supportResistance: z.object({ support: zoneSchema.nullable(), resistance: zoneSchema.nullable() }).strict(),
  entryPlan: z.object({
    status: z.enum(["active", "waiting-for-price", "expired", "invalidated"]),
    failure: z.string().max(80).nullable(),
    entryLower: finite,
    entryUpper: finite,
    stop: finite,
    takeProfit1: finite,
    takeProfit2: finite,
    riskReward: finite,
    suggestedQuantity: finite,
    estimatedStopRisk: finite,
  }).strict().nullable(),
}).strict();

export type AiExplanationText = z.infer<typeof aiExplanationTextSchema>;
export type AiExplanationSnapshot = z.infer<typeof aiExplanationSnapshotSchema>;
export type AiExplanationStatus = "available" | "invalid" | "unavailable";

export interface AiExplanationRecord {
  status: AiExplanationStatus;
  provider: string;
  modelId: string | null;
  promptVersion: string;
  schemaVersion: string;
  requestedAtMs: number;
  respondedAtMs: number;
  tokenUsage: { inputTokens: number | null; outputTokens: number | null } | null;
  rawResponse: unknown | null;
  validationResult: "valid" | "invalid" | "unavailable";
  failureReason: string | null;
  explanation: AiExplanationText | null;
}

const nullableTokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
}).strict().nullable();

export const aiExplanationRecordSchema = z.object({
  status: z.enum(["available", "invalid", "unavailable"]),
  provider: z.string().min(1).max(40),
  modelId: z.string().max(200).nullable(),
  promptVersion: z.string().min(1).max(80),
  schemaVersion: z.string().min(1).max(80),
  requestedAtMs: finite,
  respondedAtMs: finite,
  tokenUsage: nullableTokenUsageSchema,
  rawResponse: z.record(z.string(), z.unknown()).nullable(),
  validationResult: z.enum(["valid", "invalid", "unavailable"]),
  failureReason: z.string().max(100).nullable(),
  explanation: aiExplanationTextSchema.nullable(),
}).strict().superRefine((record, context) => {
  if (record.status === "available" && (record.validationResult !== "valid" || record.explanation === null || record.failureReason !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Available explanations must be validated." });
  }
  if (record.status === "unavailable" && (record.validationResult !== "unavailable" || record.explanation !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Unavailable explanations cannot contain display text." });
  }
  if (record.status === "invalid" && (record.validationResult !== "invalid" || record.explanation !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "Invalid explanations cannot contain display text." });
  }
});

export function buildAiExplanationSnapshot(attempt: AnalysisAttempt): AiExplanationSnapshot {
  const indicators = attempt.indicators;
  const mapIndicators = (key: "1d" | "4h" | "1h") => {
    const value = indicators?.[key];
    if (!value) return null;
    return {
      interval: key,
      candleCloseTimeMs: value.candleCloseTimeMs,
      close: value.close,
      ema20: value.ema20,
      ema50: value.ema50,
      ema200: value.ema200,
      ema20ThreeBarsAgo: value.ema20ThreeBarsAgo,
      ema50FiveBarsAgo: value.ema50FiveBarsAgo,
      atr14: value.atr14,
      rsi14: value.rsi14,
      previousRsi14: value.previousRsi14,
      macdHistogram: value.macdHistogram,
      previousMacdHistogram: value.previousMacdHistogram,
      volume: value.volume,
      volumeSma20: value.volumeSma20,
    };
  };
  const mapZone = (zone: AnalysisAttempt["supportResistance"]["support"]) => zone && ({
    price: zone.price,
    lower: zone.lower,
    upper: zone.upper,
    touches: zone.touches,
  });
  const strategy = attempt.strategy;

  return {
    symbol: attempt.symbol,
    analysisTimeMs: attempt.analysisTimeMs,
    trigger: attempt.trigger,
    strategyVersion: attempt.strategyVersion,
    status: attempt.status,
    candleCloseTimes: attempt.candleCloseTimes,
    issues: attempt.issues.map(({ interval: candleInterval, code }) => ({ interval: candleInterval, code })),
    indicators: indicators ? { "1d": mapIndicators("1d")!, "4h": mapIndicators("4h")!, "1h": mapIndicators("1h")! } : null,
    trend: attempt.trend ? {
      direction: attempt.trend.direction,
      dailyPassed: attempt.trend.daily.conditions.filter((condition) => condition.passed).length,
      fourHourPassed: attempt.trend.fourHour.conditions.filter((condition) => condition.passed).length,
    } : null,
    strategy: strategy ? {
      state: strategy.state,
      avoidReason: strategy.avoidReason,
      score: strategy.score,
      scoreBreakdown: strategy.scoreBreakdown,
      pullbackValid: strategy.pullback.valid,
      confirmationPassed: strategy.confirmation.passed,
      riskReward: strategy.riskReward,
    } : null,
    currentPrice: attempt.currentPrice,
    quoteTradeTimeMs: attempt.currentPriceObservedAtMs ?? null,
    quoteServerTimeMs: attempt.currentPriceServerTimeMs ?? null,
    supportResistance: {
      support: mapZone(attempt.supportResistance.support),
      resistance: mapZone(attempt.supportResistance.resistance),
    },
    entryPlan: attempt.entryPlan ? {
      status: attempt.entryPlan.status,
      failure: attempt.entryPlan.failure,
      entryLower: attempt.entryPlan.entryLower,
      entryUpper: attempt.entryPlan.entryUpper,
      stop: attempt.entryPlan.stop,
      takeProfit1: attempt.entryPlan.takeProfit1,
      takeProfit2: attempt.entryPlan.takeProfit2,
      riskReward: attempt.entryPlan.riskReward,
      suggestedQuantity: attempt.entryPlan.suggestedQuantity,
      estimatedStopRisk: attempt.entryPlan.estimatedStopRisk,
    } : null,
  };
}
