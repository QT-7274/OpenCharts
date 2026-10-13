import { z } from "zod";
import { SUPPORTED_SPOT_INTERVALS, SUPPORTED_SPOT_SYMBOLS } from "../market-data/types.ts";
import { aiExplanationRecordSchema, aiExplanationSnapshotSchema } from "./ai-explanation-contract.ts";
import type { AnalysisAttemptRecord } from "./pipeline.ts";

const finite = z.number().finite();
const nullableFinite = finite.nullable();
const interval = z.enum(SUPPORTED_SPOT_INTERVALS);
const issueSchema = z.object({
  interval,
  code: z.enum(["invalid-candle", "conflict", "gap", "warmup", "stale", "unavailable"]),
  fromMs: finite.optional(),
  toMs: finite.optional(),
  atMs: finite.optional(),
});

const indicatorSchema = z.object({
  interval,
  candleCloseTimeMs: finite,
  open: finite,
  close: finite,
  volume: finite,
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
  volumeSma20: finite,
});
const indicatorSetSchema = z.object({ "1d": indicatorSchema, "4h": indicatorSchema, "1h": indicatorSchema })
  .refine((value) => value["1d"].interval === "1d" && value["4h"].interval === "4h" && value["1h"].interval === "1h");

const trendConditionSchema = z.object({
  id: z.enum([
    "1d-close-above-ema200", "1d-ema50-above-ema200", "1d-ema50-rising",
    "4h-close-above-ema50", "4h-ema20-above-ema50", "4h-ema20-rising",
  ]),
  passed: z.boolean(),
  actual: finite,
  reference: nullableFinite,
});
const trendSchema = z.object({
  direction: z.enum(["bullish", "not-bullish"]),
  eligibleForPullback: z.boolean(),
  daily: z.object({ interval: z.literal("1d"), bullish: z.boolean(), conditions: z.array(trendConditionSchema) }),
  fourHour: z.object({ interval: z.literal("4h"), bullish: z.boolean(), conditions: z.array(trendConditionSchema) }),
});

const entryPlanStatusSchema = z.enum(["active", "waiting-for-price", "expired", "invalidated"]);
const entryPlanFailureSchema = z.enum([
  "invalid-input", "spot-price-unavailable", "spot-price-stale", "risk-budget-unavailable",
  "quantity-rules-unavailable", "quantity-below-minimum", "structure-invalidated",
  "resistance-before-tp1", "expired", "trend-invalidated", "pullback-invalidated",
  "hourly-close-below-pullback-low", "insufficient-data",
]);
const priceZoneSchema = z.object({
  price: finite,
  lower: finite,
  upper: finite,
  touches: finite,
  lastTouchedAtMs: finite,
});
const entryPlanSchema = z.object({
  referencePrice: finite,
  entryLower: finite,
  entryUpper: finite,
  pullbackLow: finite,
  structureStop: finite,
  volatilityStop: finite,
  stop: finite,
  riskPerUnit: finite,
  takeProfit1: finite,
  takeProfit2: finite,
  riskReward: finite,
  riskBudgetAmount: finite,
  suggestedQuantity: finite,
  suggestedNotional: finite,
  estimatedStopRisk: finite,
  quantityRules: z.object({ minQty: finite, maxQty: finite, stepSize: finite }),
  validFromMs: finite,
  expiresAtMs: finite,
  currentPrice: finite,
  currentPriceObservedAtMs: finite,
  status: entryPlanStatusSchema,
  failure: entryPlanFailureSchema.nullable(),
}).superRefine((plan, context) => {
  const reject = (path: string, message: string) => {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  };
  const near = (actual: number, expected: number) =>
    Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-8;
  const rules = plan.quantityRules;
  const stepCount = plan.suggestedQuantity / rules.stepSize;

  if (plan.referencePrice <= 0 || plan.entryLower <= 0 || plan.entryUpper < plan.entryLower) {
    reject("entryLower", "Invalid entry range");
  }
  if (plan.stop <= 0 || plan.stop >= plan.referencePrice ||
    !near(plan.riskPerUnit, plan.referencePrice - plan.stop)) {
    reject("stop", "Invalid stop risk");
  }
  if (plan.takeProfit1 < plan.referencePrice || plan.takeProfit2 < plan.takeProfit1 ||
    plan.validFromMs >= plan.expiresAtMs) {
    reject("takeProfit1", "Invalid target or plan lifetime");
  }
  if (rules.minQty < 0 || rules.maxQty < rules.minQty || rules.stepSize <= 0 ||
    plan.suggestedQuantity < rules.minQty || plan.suggestedQuantity > rules.maxQty ||
    Math.abs(stepCount - Math.round(stepCount)) > 1e-8) {
    reject("quantityRules", "Invalid quantity allocation");
  }
  if (plan.riskBudgetAmount <= 0 || plan.suggestedNotional <= 0 || plan.estimatedStopRisk <= 0 ||
    plan.estimatedStopRisk > plan.riskBudgetAmount + Math.max(1, plan.riskBudgetAmount) * 1e-8 ||
    !near(plan.suggestedNotional, plan.suggestedQuantity * plan.entryUpper) ||
    !near(plan.estimatedStopRisk, plan.suggestedQuantity * (plan.entryUpper - plan.stop))) {
    reject("estimatedStopRisk", "Invalid risk allocation");
  }
  if (plan.currentPrice <= 0 || plan.currentPriceObservedAtMs <= 0) {
    reject("currentPrice", "Invalid current quote");
  }
  if ((plan.status === "active" && plan.failure !== null) ||
    (plan.status === "expired" && plan.failure !== "expired") ||
    (plan.status === "invalidated" &&
      (plan.failure === null || plan.failure === "expired" ||
        plan.failure === "spot-price-stale" || plan.failure === "spot-price-unavailable")) ||
    (plan.status === "waiting-for-price" && plan.failure !== null &&
      plan.failure !== "spot-price-stale" && plan.failure !== "spot-price-unavailable")) {
    reject("status", "Plan status conflicts with its failure reason");
  }
});
const strategySchema = z.object({
  state: z.enum(["watch", "setup", "enter", "avoid"]),
  avoidReason: z.enum([
    "data-incomplete", "trend-not-qualified", "pullback-invalidated",
    "confirmation-score-insufficient", "risk-reward-insufficient",
  ]).nullable(),
  score: finite,
  scoreBreakdown: z.object({
    trendQuality: finite,
    pullbackQuality: finite,
    priceConfirmation: finite,
    momentum: finite,
    volume: finite,
    volatilityAndFreshness: finite,
    total: finite,
  }),
  dataTimely: z.boolean(),
  volatilityQualified: z.boolean(),
  pullback: z.object({
    enteredZone: z.boolean(),
    heldInvalidation: z.boolean(),
    latestCloseAtOrAboveEma20: z.boolean(),
    valid: z.boolean(),
    touchIndex: nullableFinite,
    barsSinceTouch: nullableFinite,
    zoneLower: nullableFinite,
    zoneUpper: nullableFinite,
    invalidationLine: nullableFinite,
    lowestLow: nullableFinite,
  }),
  confirmation: z.object({
    ema20Reclaim: z.boolean(),
    breakoutAbovePriorThreeHigh: z.boolean(),
    priceTrigger: z.boolean(),
    bothPriceTriggers: z.boolean(),
    bullishCandle: z.boolean(),
    rsiAtLeast50: z.boolean(),
    rsiRising: z.boolean(),
    passed: z.boolean(),
    priorThreeHigh: nullableFinite,
  }),
  riskReward: nullableFinite,
  entryPlanStatus: entryPlanStatusSchema.nullable(),
});

const analysisAttemptRecordSchema = z.object({
  snapshotId: z.string().min(1).max(240).optional(),
  aiInputSummary: aiExplanationSnapshotSchema.nullable().optional(),
  aiExplanation: aiExplanationRecordSchema.nullable().optional(),
  symbol: z.enum(SUPPORTED_SPOT_SYMBOLS),
  trigger: z.enum(["manual", "hourly-close"]),
  analysisTimeMs: nullableFinite,
  status: z.enum(["ready", "insufficient-data"]),
  decision: z.enum(["暂不入场", "可进入模拟交易"]),
  reason: z.literal("数据不足或多周期数据不同步").nullable(),
  candleCloseTimes: z.object({ "1d": nullableFinite, "4h": nullableFinite, "1h": nullableFinite }),
  issues: z.array(issueSchema),
  strategyVersion: z.literal("trend-pullback-v1"),
  indicators: indicatorSetSchema.nullable(),
  trend: trendSchema.nullable(),
  strategy: strategySchema.nullable(),
  currentPrice: nullableFinite,
  currentPriceObservedAtMs: nullableFinite,
  supportResistance: z.object({ support: priceZoneSchema.nullable(), resistance: priceZoneSchema.nullable() }),
  currentPriceServerTimeMs: nullableFinite,
  entryPlan: entryPlanSchema.nullable(),
  entryPlanFailure: entryPlanFailureSchema.nullable(),
});

// crypto-ai-analysis.ANALYSIS_SNAPSHOT.4
export function parseAnalysisAttemptRecord(value: unknown): AnalysisAttemptRecord | null {
  const parsed = analysisAttemptRecordSchema.safeParse(value);
  return parsed.success ? parsed.data as AnalysisAttemptRecord : null;
}
