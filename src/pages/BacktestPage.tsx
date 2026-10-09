import { ArrowLeft, BarChart3, CircleAlert, LoaderCircle, Play, RefreshCw, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { runCryptoBacktest, DEFAULT_BACKTEST_CONFIG, type BacktestConfig, type BacktestPeriodResult, type CryptoBacktestReport } from "../services/analysis/backtest.ts";
import { BacktestHistoryValidationError, loadCryptoBacktestHistory, type BacktestHistory, type BacktestHistoryProgress } from "../services/analysis/backtest-history.ts";
import { SUPPORTED_SPOT_SYMBOLS, type SpotSymbol } from "../services/market-data/types.ts";

type ResultPeriod = "research" | "outOfSample";
type ResultSymbol = "PORTFOLIO" | SpotSymbol;

const SYMBOL_LABELS: Record<SpotSymbol, string> = {
  BTCUSDT: "BTC",
  ETHUSDT: "ETH",
  SOLUSDT: "SOL",
  BNBUSDT: "BNB",
  XRPUSDT: "XRP",
  ADAUSDT: "ADA",
};

const SKIP_REASON_LABELS: Record<string, string> = {
  "entry-plan-expired": "入场计划过期",
  "entry-plan-invalidated": "入场结构失效",
  "entry-plan-already-active": "已有等待中的入场计划",
  "position-already-open": "该币已有持仓",
  "portfolio-risk-limit": "达到组合风险上限",
  "insufficient-spot-balance": "现货余额不足",
  "window-ended-before-entry": "区间结束前未成交",
};

function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

function formatPct(value: number | null): string {
  return value == null ? "—" : `${value >= 0 ? "+" : ""}${formatNumber(value)}%`;
}

function formatProfitFactor(value: number | "infinite" | null): string {
  return value === "infinite" ? "∞" : value == null ? "—" : formatNumber(value, 3);
}

function formatTime(value: number): string {
  return new Date(value).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function periodResult(report: CryptoBacktestReport, symbol: ResultSymbol, period: ResultPeriod): BacktestPeriodResult | null {
  return symbol === "PORTFOLIO" ? report.portfolio[period] : report.symbols[symbol]?.[period] ?? null;
}

function Metric({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail?: string; tone?: "neutral" | "positive" | "negative" }) {
  const color = tone === "positive" ? "text-emerald-400" : tone === "negative" ? "text-rose-400" : "text-zinc-100";
  return (
    <div className="min-w-0 border-l border-white/10 pl-3 first:border-l-0 first:pl-0">
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className={`mt-1 truncate font-mono text-lg tabular-nums ${color}`}>{value}</div>
      {detail && <div className="mt-0.5 truncate text-[10px] text-zinc-500">{detail}</div>}
    </div>
  );
}

// crypto-ai-analysis.VALIDATION.1
export function BacktestPage() {
  const [config, setConfig] = useState<BacktestConfig>({ ...DEFAULT_BACKTEST_CONFIG });
  const [history, setHistory] = useState<BacktestHistory | null>(null);
  const [report, setReport] = useState<CryptoBacktestReport | null>(null);
  const [progress, setProgress] = useState<BacktestHistoryProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [invalidBacktest, setInvalidBacktest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<ResultPeriod>("outOfSample");
  const [symbol, setSymbol] = useState<ResultSymbol>("PORTFOLIO");

  const selectedResult = useMemo(() => report ? periodResult(report, symbol, period) : null, [report, symbol, period]);
  const metrics = selectedResult?.metrics;
  const benchmark = selectedResult?.buyAndHold;
  const sampleRequired = symbol === "PORTFOLIO" ? 100 : 20;
  const sampleSufficient = period === "outOfSample" && (metrics?.tradeCount ?? 0) >= sampleRequired;

  function updatePercent(key: "buyFeeRate" | "sellFeeRate" | "buySlippageRate" | "sellSlippageRate", value: string) {
    setConfig((current) => ({ ...current, [key]: Number(value) / 100 }));
  }

  async function calculate(loadedHistory: BacktestHistory, nextConfig = config) {
    setRecalculating(true);
    setInvalidBacktest(false);
    setError(null);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      const nextReport = runCryptoBacktest(loadedHistory.assets, nextConfig, loadedHistory.requestedPeriod);
      setReport(nextReport);
      setPeriod("outOfSample");
    } catch (reason) {
      // crypto-ai-analysis.VALIDATION.14-1
      setReport(null);
      setInvalidBacktest(true);
      setError(reason instanceof Error ? reason.message : "回测计算失败");
    } finally {
      setRecalculating(false);
    }
  }

  async function loadAndRun() {
    setLoading(true);
    setInvalidBacktest(false);
    setError(null);
    setProgress(null);
    try {
      const loadedHistory = await loadCryptoBacktestHistory({ onProgress: setProgress });
      setHistory(loadedHistory);
      await calculate(loadedHistory);
    } catch (reason) {
      if (reason instanceof BacktestHistoryValidationError) {
        setHistory(null);
        setReport(null);
        setInvalidBacktest(true);
      }
      setError(reason instanceof Error ? reason.message : "历史行情加载失败");
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  async function recalculate() {
    if (!history) return;
    await calculate(history);
  }

  const isBusy = loading || recalculating;
  const statusTone = report?.status === "research-usable"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : "border-amber-500/30 bg-amber-500/10 text-amber-200";

  return (
    <main className="min-h-screen bg-[#0b0e11] text-zinc-100">
      <header className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-2 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <a href="/" className="inline-flex h-8 items-center gap-2 border border-white/10 px-2.5 text-xs text-zinc-400 transition hover:border-white/20 hover:text-white">
            <ArrowLeft size={14} /> 交易终端
          </a>
          <div className="flex items-center gap-2 border-l border-white/10 pl-3">
            <BarChart3 size={16} className="text-emerald-400" />
            <h1 className="text-sm font-semibold">现货策略回测</h1>
          </div>
        </div>
        <div className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
          <ShieldCheck size={14} className="text-emerald-500" /> Binance Spot · 仅模拟研究
        </div>
      </header>

      <div className="mx-auto max-w-[1440px] px-4 py-5 md:px-6">
        <section className="grid gap-4 border-b border-white/10 pb-5 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
          <div>
            <div className="text-xs text-zinc-500">最近完整 3 年 · 1h 执行 · 6 个现货交易对</div>
            <div className="mt-1 text-sm text-zinc-300">趋势回调 v1</div>
            {history && <div className="mt-1 font-mono text-[11px] text-zinc-600">{formatTime(history.requestedPeriod.startMs)} — {formatTime(history.requestedPeriod.endMs)}</div>}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-[10px] text-zinc-500">
              初始资金 · USDT
              <input type="number" min="1" step="100" value={config.initialCapital} onChange={(event) => setConfig((current) => ({ ...current, initialCapital: Number(event.target.value) }))} className="h-8 w-32 border border-white/10 bg-[#11161b] px-2 font-mono text-xs text-zinc-200 outline-none focus:border-emerald-500/50" />
            </label>
            {([
              ["buyFeeRate", "买入手续费 %"],
              ["sellFeeRate", "卖出手续费 %"],
              ["buySlippageRate", "买入滑点 %"],
              ["sellSlippageRate", "卖出滑点 %"],
            ] as const).map(([key, label]) => (
              <label key={key} className="grid gap-1 text-[10px] text-zinc-500">
                {label}
                <input type="number" min="0" max="99" step="0.01" value={(config[key] * 100).toFixed(2)} onChange={(event) => updatePercent(key, event.target.value)} className="h-8 w-28 border border-white/10 bg-[#11161b] px-2 font-mono text-xs text-zinc-200 outline-none focus:border-emerald-500/50" />
              </label>
            ))}
            <button type="button" onClick={() => void loadAndRun()} disabled={isBusy} className="inline-flex h-8 items-center gap-2 bg-emerald-500 px-3 text-xs font-medium text-black transition hover:bg-emerald-400 disabled:cursor-wait disabled:opacity-60">
              {loading ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {history ? "更新行情并回测" : "加载行情并回测"}
            </button>
            {history && <button type="button" onClick={() => void recalculate()} disabled={isBusy} title="使用已加载行情重新计算" className="grid h-8 w-8 place-items-center border border-white/10 text-zinc-400 hover:border-white/20 hover:text-white disabled:opacity-50"><Play size={14} /></button>}
          </div>
        </section>

        {isBusy && (
          <div className="flex flex-wrap items-center gap-3 border-b border-white/10 py-3 text-xs text-zinc-400" aria-live="polite">
            <LoaderCircle size={14} className="animate-spin text-emerald-400" />
            <span>{loading ? "正在读取 Binance 闭合历史 K 线" : "正在按历史顺序模拟成交"}</span>
            {progress && <span className="font-mono text-zinc-500">{progress.completed}/{progress.total} · {SYMBOL_LABELS[progress.symbol]} {progress.interval} · {formatNumber(progress.loadedCandles, 0)} 根</span>}
          </div>
        )}
        {error && <div role="alert" className="flex items-start gap-2 border-b border-rose-500/20 py-3 text-xs text-rose-300"><CircleAlert size={15} className="mt-0.5 shrink-0" />{invalidBacktest && <span className="shrink-0 font-mono font-semibold">invalid</span>}{error}</div>}

        {report && selectedResult ? (
          <>
            <section className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 py-4">
              <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="回测对象">
                <button type="button" role="tab" aria-selected={symbol === "PORTFOLIO"} onClick={() => setSymbol("PORTFOLIO")} className={`h-8 border px-3 text-xs ${symbol === "PORTFOLIO" ? "border-white/25 bg-white/10 text-white" : "border-white/10 text-zinc-500 hover:text-zinc-200"}`}>6 币组合</button>
                {SUPPORTED_SPOT_SYMBOLS.map((item) => <button key={item} type="button" role="tab" aria-selected={symbol === item} onClick={() => setSymbol(item)} className={`h-8 border px-3 text-xs ${symbol === item ? "border-white/25 bg-white/10 text-white" : "border-white/10 text-zinc-500 hover:text-zinc-200"}`}>{SYMBOL_LABELS[item]}</button>)}
              </div>
              <div className="flex h-8 border border-white/10 p-0.5" role="tablist" aria-label="回测时段">
                {([ ["research", "研究区间 70%"], ["outOfSample", "样本外 30%"] ] as const).map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={period === key} onClick={() => setPeriod(key)} className={`px-3 text-[11px] ${period === key ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-200"}`}>{label}</button>)}
              </div>
            </section>

            <section className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <span className={`border px-2 py-1 text-[11px] font-medium ${statusTone}`}>{report.status === "research-usable" ? "可继续模拟研究" : "实验性结果"}</span>
                <span className={`text-xs ${period === "research" || sampleSufficient ? "text-zinc-400" : "text-amber-300"}`}>{period === "research" ? `研究区间 · ${metrics?.tradeCount ?? 0} 笔` : sampleSufficient ? `样本足够 · ${metrics?.tradeCount} 笔` : `样本不足 · ${metrics?.tradeCount ?? 0}/${sampleRequired} 笔`}</span>
              </div>
              <span className="max-w-3xl text-right text-[11px] leading-5 text-zinc-500">{report.statusReason} 本结果仅用于模拟研究，不构成投资建议。</span>
            </section>

            <section className="grid grid-cols-2 gap-x-4 gap-y-5 border-b border-white/10 py-5 sm:grid-cols-3 lg:grid-cols-6">
              <Metric label="净收益" value={formatPct(metrics!.netReturnPct)} tone={metrics!.netReturnPct > 0 ? "positive" : metrics!.netReturnPct < 0 ? "negative" : "neutral"} detail={`期末净值 ${formatNumber(metrics!.endingEquity)} USDT`} />
              <Metric label="最大回撤" value={`${formatNumber(metrics!.maxDrawdownPct)}%`} tone={metrics!.maxDrawdownPct > 25 ? "negative" : "neutral"} detail="净值从高点回落幅度" />
              <Metric label="成交笔数" value={formatNumber(metrics!.tradeCount, 0)} detail={`信号 ${metrics!.signalCount} · 跳过 ${metrics!.skippedSignalCount}`} />
              <Metric label="胜率" value={formatPct(metrics!.winRatePct)} detail="扣除成本后的盈利笔数" />
              <Metric label="Profit Factor" value={formatProfitFactor(metrics!.profitFactor)} detail="盈利总额 ÷ 亏损总额" />
              <Metric label="总交易成本" value={`${formatNumber(metrics!.totalCosts)} USDT`} detail="手续费 + 买卖滑点" />
            </section>

            <section className="grid gap-6 border-b border-white/10 py-5 lg:grid-cols-[1.2fr_0.8fr]">
              <div>
                <h2 className="mb-3 text-xs font-semibold text-zinc-300">完整表现</h2>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-xs sm:grid-cols-3">
                  <div><dt className="text-zinc-500">年化收益</dt><dd className="mt-1 font-mono text-zinc-200">{formatPct(metrics!.annualizedReturnPct)}</dd></div>
                  <div><dt className="text-zinc-500">平均每笔净收益</dt><dd className="mt-1 font-mono text-zinc-200">{formatNumber(metrics!.averageNetPnl)} USDT</dd></div>
                  <div><dt className="text-zinc-500">平均持仓时间</dt><dd className="mt-1 font-mono text-zinc-200">{formatNumber(metrics!.averageHoldingHours)} 小时</dd></div>
                  <div><dt className="text-zinc-500">平均实际风险收益比</dt><dd className="mt-1 font-mono text-zinc-200">{formatNumber(metrics!.averageActualRiskReward)}</dd></div>
                  <div><dt className="text-zinc-500">风险调整收益 Sharpe</dt><dd className="mt-1 font-mono text-zinc-200">{formatNumber(metrics!.sharpeRatio, 3)}</dd></div>
                  <div><dt className="text-zinc-500">最大连续亏损</dt><dd className="mt-1 font-mono text-zinc-200">{metrics!.maxConsecutiveLosses} 笔</dd></div>
                </dl>
                <div className="mt-5 border-t border-white/10 pt-3">
                  <div className="mb-2 text-[11px] text-zinc-500">策略状态</div>
                  <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-zinc-300">
                    <span>等待 {metrics!.strategyStateCounts.watch}</span><span>观察回调 {metrics!.strategyStateCounts.setup}</span><span>确认信号 {metrics!.strategyStateCounts.enter}</span><span>跳过条件 {metrics!.strategyStateCounts.avoid}</span>
                  </div>
                </div>
              </div>

              <div className="border-t border-white/10 pt-4 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
                <h2 className="mb-3 text-xs font-semibold text-zinc-300">同期买入并持有对比</h2>
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div><div className="text-zinc-500">净收益</div><div className="mt-1 font-mono">{formatPct(benchmark!.netReturnPct)}</div><div className="mt-1 text-[10px] text-zinc-500">策略差 {formatPct(benchmark!.netReturnDifferencePct)}</div></div>
                  <div><div className="text-zinc-500">最大回撤</div><div className="mt-1 font-mono">{formatNumber(benchmark!.maxDrawdownPct)}%</div><div className="mt-1 text-[10px] text-zinc-500">差值 {formatNumber(benchmark!.maxDrawdownDifferencePct)}%</div></div>
                  <div><div className="text-zinc-500">Sharpe</div><div className="mt-1 font-mono">{formatNumber(benchmark!.sharpeRatio, 3)}</div><div className="mt-1 text-[10px] text-zinc-500">策略差 {formatNumber(benchmark!.sharpeDifference, 3)}</div></div>
                </div>
                <div className="mt-5 border-t border-white/10 pt-3">
                  <div className="mb-2 text-[11px] text-zinc-500">跳过原因</div>
                  {Object.keys(metrics!.skipReasons).length === 0 ? <span className="text-xs text-zinc-600">无</span> : (
                    <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-zinc-300">{Object.entries(metrics!.skipReasons).sort((a, b) => b[1] - a[1]).map(([reason, count]) => <span key={reason}>{SKIP_REASON_LABELS[reason] ?? reason} <span className="font-mono text-zinc-500">{count}</span></span>)}</div>
                  )}
                </div>
              </div>
            </section>

            <section className="py-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-xs font-semibold text-zinc-300">模拟成交明细</h2>
                <span className="text-[10px] text-zinc-600">理论计划价与模拟成交价均已保留</span>
              </div>
              {selectedResult.trades.length === 0 ? <div className="border-y border-white/10 py-8 text-center text-xs text-zinc-500">当前区间没有成交</div> : (
                <div className="overflow-x-auto border-y border-white/10">
                  <table className="w-full min-w-[960px] border-collapse text-left text-[11px]">
                    <thead className="text-zinc-500"><tr className="border-b border-white/10">{["交易对", "入场时间", "出场时间", "数量", "计划入场", "实际入场", "均价出场", "净盈亏", "成本", "退出原因"].map((label) => <th key={label} className="whitespace-nowrap px-2 py-2 font-medium">{label}</th>)}</tr></thead>
                    <tbody>{[...selectedResult.trades].reverse().slice(0, 100).map((trade) => <tr key={trade.id} className="border-b border-white/5 text-zinc-300 last:border-0">
                      <td className="px-2 py-2 font-medium">{SYMBOL_LABELS[trade.symbol]}</td><td className="whitespace-nowrap px-2 py-2 font-mono text-zinc-500">{formatTime(trade.entryTimeMs)}</td><td className="whitespace-nowrap px-2 py-2 font-mono text-zinc-500">{formatTime(trade.exitTimeMs)}</td><td className="px-2 py-2 font-mono">{formatNumber(trade.quantity, 6)}</td><td className="px-2 py-2 font-mono">{formatNumber(trade.theoreticalEntryPrice, 6)}</td><td className="px-2 py-2 font-mono">{formatNumber(trade.actualEntryPrice, 6)}</td><td className="px-2 py-2 font-mono">{formatNumber(trade.averageExitPrice, 6)}</td><td className={`px-2 py-2 font-mono ${trade.netPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{formatNumber(trade.netPnl)} USDT</td><td className="px-2 py-2 font-mono">{formatNumber(trade.costs)}</td><td className="whitespace-nowrap px-2 py-2">{trade.exitReason === "stop" ? "止损" : trade.exitReason === "break-even" ? "保本退出" : trade.exitReason === "take-profit-2" ? "第二止盈" : "区间结束"}</td>
                    </tr>)}</tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        ) : !isBusy && !error ? (
          <section className="grid min-h-[320px] place-items-center py-12 text-center">
            <div className="max-w-md">
              <BarChart3 size={26} className="mx-auto text-zinc-600" />
              <h2 className="mt-4 text-sm font-medium text-zinc-300">等待加载历史行情</h2>
              <p className="mt-2 text-xs leading-5 text-zinc-500">回测使用 Binance 公共现货 K 线，无需 API 密钥。开始前会加载额外的指标暖机数据。</p>
            </div>
          </section>
        ) : null}

        <footer className="border-t border-white/10 py-4 text-[10px] leading-5 text-zinc-600">
          现货模拟 · 无杠杆、无真实订单 · 手续费和滑点默认已计入 · 样本外成绩仅用于继续研究，不代表未来表现。
        </footer>
      </div>
    </main>
  );
}
