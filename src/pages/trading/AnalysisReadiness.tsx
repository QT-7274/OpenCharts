import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { analysisPipeline } from "../../services/analysis/runtime.ts";
import { marketDataMode } from "../../services/market-data/runtime.ts";
import { isSpotSymbol, type SpotInterval } from "../../services/market-data/types.ts";
import type { AnalysisAttempt } from "../../services/analysis/pipeline.ts";
import {
  getSpotQuoteFailure,
  type EntryPlanFailure,
  type EntryPlanStatus,
  type StrategyAvoidReason,
} from "../../services/analysis/strategy.ts";

const INTERVALS: SpotInterval[] = ["1d", "4h", "1h"];

function formatTime(value: number | null): string {
  return value == null ? "—" : new Date(value).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

const STRATEGY_STATE_LABELS = {
  watch: "WATCH · 等待回调",
  setup: "SETUP · 等待 1h 确认",
  enter: "ENTER · 条件满足",
  avoid: "AVOID · 暂不入场",
} as const;

const REASON_LABELS: Record<StrategyAvoidReason | EntryPlanFailure, string> = {
  "data-incomplete": "分析数据不完整",
  "trend-not-qualified": "日线或 4 小时趋势未通过",
  "pullback-invalidated": "4 小时回调结构已失效",
  "confirmation-score-insufficient": "确认信号评分不足",
  "risk-reward-insufficient": "风险收益比不足 1:2",
  "invalid-input": "计算所需数据无效",
  "spot-price-unavailable": "暂时无法获取现货价格",
  "spot-price-stale": "现价报价已过期",
  "risk-budget-unavailable": "模拟账户风险预算不可用",
  "quantity-rules-unavailable": "交易对数量规则不可用",
  "quantity-below-minimum": "风险预算低于交易对最小下单量",
  "structure-invalidated": "1 小时收盘跌破回调低点",
  "resistance-before-tp1": "上方阻力早于第一止盈位",
  expired: "计划已超过有效期",
  "trend-invalidated": "多周期趋势条件失效",
  "hourly-close-below-pullback-low": "1 小时收盘跌破回调低点",
  "insufficient-data": "行情数据不足，计划已取消",
};

const PLAN_STATUS_LABELS: Record<EntryPlanStatus, string> = {
  active: "入场区间内",
  "waiting-for-price": "等待价格回到入场区间",
  expired: "计划已过期",
  invalidated: "计划已失效",
};

function formatPrice(value: number | null): string {
  return value == null ? "—" : new Intl.NumberFormat("en-US", { maximumSignificantDigits: 8 }).format(value);
}

function formatQuantity(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 }).format(value);
}

function confidenceLabel(score: number): string {
  return score >= 80 ? "高" : score >= 70 ? "中" : "低";
}

export function AnalysisReadiness({ symbol }: { symbol: string }) {
  const [attempt, setAttempt] = useState<AnalysisAttempt | null>(
    () => isSpotSymbol(symbol) ? analysisPipeline.getLatest(symbol) : null,
  );
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setAttempt(isSpotSymbol(symbol) ? analysisPipeline.getLatest(symbol) : null);
    const unsubscribe = analysisPipeline.subscribe((next) => {
      if (next.symbol === symbol) setAttempt(next);
    });
    return () => { unsubscribe(); };
  }, [symbol]);

  if (marketDataMode !== "binance" || !isSpotSymbol(symbol)) return null;

  const quoteFailure = attempt?.currentPrice == null ? null : getSpotQuoteFailure(
    attempt.currentPrice,
    attempt.currentPriceObservedAtMs,
    attempt.currentPriceServerTimeMs,
    Date.now(),
  );

  async function analyze() {
    if (!isSpotSymbol(symbol)) return;
    setPending(true);
    try {
      setAttempt(await analysisPipeline.runManual(symbol));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-1.5 border-b border-border bg-secondary/30 px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <button
          type="button"
          onClick={() => void analyze()}
          disabled={pending}
          title="Analyze validated closed candles"
          className="inline-flex shrink-0 items-center gap-1.5 rounded border border-border bg-background px-2 py-1 text-foreground hover:bg-secondary disabled:opacity-50"
        >
          <RefreshCw size={14} aria-hidden="true" className={pending ? "animate-spin" : ""} />
          {pending ? "分析中" : "分析行情"}
        </button>
        {attempt ? (
          <>
            <span className={attempt.status === "ready" ? "text-emerald-500" : "text-amber-500"}>
              {attempt.status === "ready"
                ? attempt.strategy
                  ? `${STRATEGY_STATE_LABELS[attempt.strategy.state]} · ${attempt.strategy.score}/100`
                  : "分析完成 · 暂不入场"
                : "数据不足 · 暂不入场"}
            </span>
            {attempt.strategy?.avoidReason && <span>{REASON_LABELS[attempt.strategy.avoidReason]}</span>}
            {attempt.strategy && (
              <span>证据置信度 {confidenceLabel(attempt.strategy.score)}</span>
            )}
            {attempt.entryPlanFailure && <span>{REASON_LABELS[attempt.entryPlanFailure]}</span>}
            <span>{attempt.strategyVersion}</span>
            <span>{attempt.trigger === "manual" ? "手动" : "1h 收盘"} · {formatTime(attempt.analysisTimeMs)}</span>
            {INTERVALS.map((interval) => (
              <span key={interval}>{interval} {formatTime(attempt.candleCloseTimes[interval])}</span>
            ))}
            {attempt.issues.length > 0 && (
              <span title={attempt.issues.map((issue) => `${issue.interval}: ${issue.code}`).join(", ")}>
                {attempt.issues.map((issue) => `${issue.interval} ${issue.code}`).join(" · ")}
              </span>
            )}
          </>
        ) : <span>等待闭合 K 线分析</span>}
      </div>
      {/* crypto-ai-analysis.ANALYSIS_OUTPUT.1 */}
      {attempt && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border/60 pt-1.5">
          <span>
            现价 {formatPrice(attempt.currentPrice)}
            {attempt.currentPriceObservedAtMs != null && <> · 报价 {formatTime(attempt.currentPriceObservedAtMs)}</>}
            {quoteFailure === "spot-price-stale" && " · 已过期"}
            {quoteFailure === "spot-price-unavailable" && " · 报价时间不可用"}
          </span>
          <span>支撑 {formatPrice(attempt.supportResistance.support?.price ?? null)}</span>
          <span>阻力 {formatPrice(attempt.supportResistance.resistance?.price ?? null)}</span>
          {attempt.entryPlan && (
            <>
              <span>{PLAN_STATUS_LABELS[attempt.entryPlan.status]}</span>
              <span>入场 {formatPrice(attempt.entryPlan.entryLower)}–{formatPrice(attempt.entryPlan.entryUpper)}</span>
              <span>止损 {formatPrice(attempt.entryPlan.stop)}</span>
              <span>止盈 {formatPrice(attempt.entryPlan.takeProfit1)} / {formatPrice(attempt.entryPlan.takeProfit2)}</span>
              <span>R:R 1:{attempt.entryPlan.riskReward.toFixed(2)}</span>
              <span>仓位上限 {formatQuantity(attempt.entryPlan.suggestedQuantity)} {symbol.replace("USDT", "")}</span>
              <span>名义价值 {formatPrice(attempt.entryPlan.suggestedNotional)} USDT</span>
              <span>止损风险 {formatPrice(attempt.entryPlan.estimatedStopRisk)} / {formatPrice(attempt.entryPlan.riskBudgetAmount)} USDT</span>
            </>
          )}
        </div>
      )}
      {attempt?.trend && attempt.indicators && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border/60 pt-1.5">
          <span>
            趋势 {attempt.trend.direction === "bullish" ? "偏多" : "未通过"}
            · 日线 {attempt.trend.daily.conditions.filter((condition) => condition.passed).length}/3
            · 4 小时 {attempt.trend.fourHour.conditions.filter((condition) => condition.passed).length}/3
          </span>
          <span>
            指标证据 1h RSI {attempt.indicators["1h"].rsi14.toFixed(1)}
            · MACD 柱 {formatPrice(attempt.indicators["1h"].macdHistogram)}
            · 成交量 {attempt.indicators["1h"].volume >= attempt.indicators["1h"].volumeSma20 ? "高于" : "低于"} 20 根均量
          </span>
        </div>
      )}
      {attempt && (
        <div className="border-t border-border/60 pt-1.5">
          <span>失效条件：多周期趋势或回调结构失效、1h 收盘低于回调低点、3 根 1h K 线未触发</span>
        </div>
      )}
    </div>
  );
}
