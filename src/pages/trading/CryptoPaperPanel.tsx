import { Check, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cryptoPaperLedger } from "../../services/analysis/runtime.ts";
import { DEFAULT_BACKTEST_CONFIG } from "../../services/analysis/backtest.ts";
import type { AnalysisAttempt } from "../../services/analysis/pipeline.ts";
import type { PaperCostComparison, PaperLedgerState, PaperOrderDraft } from "../../services/analysis/paper-trading.ts";

interface ForwardSimulationSnapshot {
  ledger: PaperLedgerState;
  riskContext: { accountEquity: number; availableQuoteBalance: number };
  costComparison: PaperCostComparison;
  backtestStatus: {
    status: "research-usable" | "experimental" | "invalid";
    strategyVersion: string;
    costAssumptions?: {
      buyFeeRate: number;
      sellFeeRate: number;
      buySlippageRate: number;
      sellSlippageRate: number;
    };
  } | null;
  runtime: {
    connection: string;
    ready: boolean;
    recovering: boolean;
    lastMarketAtMs: number | null;
    lastSuccessfullyProcessedAtMs: number | null;
    pausedSymbols: Partial<Record<string, string>>;
    storageStatus: "ok" | "error";
    runtimeFailure: string | null;
  };
  storageError: string | null;
}

function number(value: number, digits = 4): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

function time(value: number | null): string {
  return value == null ? "--" : new Date(value).toLocaleString();
}

// crypto-ai-analysis.FORWARD_SIMULATION.9 crypto-ai-analysis.FORWARD_SIMULATION.11
export function CryptoPaperPanel({ attempt }: { attempt: AnalysisAttempt }) {
  const [localState, setLocalState] = useState(() => cryptoPaperLedger.getState());
  const [serverSnapshot, setServerSnapshot] = useState<ForwardSimulationSnapshot | null>(null);
  const [serverOnline, setServerOnline] = useState(false);
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState<PaperOrderDraft | null>(null);
  const [serverDraftId, setServerDraftId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(0);

  useEffect(() => cryptoPaperLedger.subscribe(setLocalState), []);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch("/api/forward-sim/state", { cache: "no-store" });
        const result = await response.json() as ForwardSimulationSnapshot & { error?: string };
        if (!response.ok) throw new Error(result.error ?? "前向模拟服务不可用");
        if (!active) return;
        setServerSnapshot(result);
        setServerOnline(true);
        setServerMessage(result.storageError ?? result.runtime.runtimeFailure);
      } catch (reason) {
        if (!active) return;
        setServerOnline(false);
        setServerMessage(reason instanceof Error ? reason.message : "前向模拟服务不可用");
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 3_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);
  useEffect(() => {
    if (!draft) return;
    const update = () => setRemainingSeconds(Math.max(0, Math.ceil((draft.expiresAtMs - Date.now()) / 1_000)));
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [draft]);

  async function prefill() {
    setError(null);
    setBusy(true);
    try {
      if (!serverOnline) throw new Error("前向模拟服务离线，无法准备服务器订单");
      const analysisResponse = await fetch("/api/forward-sim/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol: attempt.symbol }),
      });
      const analysisResult = await analysisResponse.json() as { snapshotId?: string; error?: string };
      if (!analysisResponse.ok || !analysisResult.snapshotId) {
        throw new Error(analysisResult.error ?? "服务端分析未能生成有效快照");
      }
      const response = await fetch("/api/forward-sim/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotId: analysisResult.snapshotId }),
      });
      const result = await response.json() as { id?: string; draft?: PaperOrderDraft; error?: string };
      if (!response.ok || !result.id || !result.draft) throw new Error(result.error ?? "不能带入模拟订单");
      setServerDraftId(result.id);
      setDraft(result.draft);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "不能带入模拟订单");
    } finally {
      setBusy(false);
    }
  }

  async function refreshServerState() {
    const response = await fetch("/api/forward-sim/state", { cache: "no-store" });
    const result = await response.json() as ForwardSimulationSnapshot & { error?: string };
    if (!response.ok) throw new Error(result.error ?? "前向模拟服务不可用");
    setServerSnapshot(result);
    setServerOnline(true);
    setServerMessage(result.storageError ?? result.runtime.runtimeFailure);
  }

  async function confirm() {
    if (!draft || !serverDraftId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/forward-sim/drafts/${encodeURIComponent(serverDraftId)}/confirm`, { method: "POST" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "模拟订单创建失败");
      setDraft(null);
      setServerDraftId(null);
      await refreshServerState();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模拟订单创建失败");
    } finally {
      setBusy(false);
    }
  }

  const state = serverSnapshot?.ledger ?? localState;
  const order = state.orders.find((item) => item.symbol === attempt.symbol &&
    (item.status === "pending" || item.status === "open"));
  const context = serverSnapshot?.riskContext ?? cryptoPaperLedger.getRiskContext();
  const paused = state.pausedSymbols[attempt.symbol];
  const costs = state.orders.reduce((sum, item) => sum + item.entryFee + item.entrySlippage + item.exitFees + item.exitSlippage, 0);
  const runtimeReady = serverSnapshot?.runtime.ready === true && !serverSnapshot.storageError;
  const backtestReady = serverSnapshot?.backtestStatus != null && serverSnapshot.backtestStatus.status !== "invalid";
  const canCreateOrder = serverOnline && runtimeReady && backtestReady && !busy;

  return (
    <section className="border-t border-border/60 pt-1.5" aria-label="加密货币模拟账户">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-medium text-foreground">独立现货模拟账户</span>
          <span className={canCreateOrder ? "text-emerald-600" : "text-amber-600"}>
            前向服务 {serverOnline ? `${serverSnapshot?.runtime.connection ?? "连接中"}${serverSnapshot?.runtime.recovering ? " · 补齐中" : ""}` : "离线"}
          </span>
          <span>净值 {number(context.accountEquity, 2)} USDT</span>
          <span>可用 {number(context.availableQuoteBalance, 2)} USDT</span>
          <span>累计费用与滑点 {number(costs, 2)} USDT</span>
          <span>服务端回测状态 {serverSnapshot?.backtestStatus?.status ?? "未同步"}</span>
        </div>
        <button type="button" onClick={() => void prefill()} disabled={!canCreateOrder || attempt.strategy?.state !== "enter" || Boolean(order) || Boolean(paused)} className="inline-flex items-center gap-1.5 rounded border border-border bg-background px-2 py-1 text-foreground hover:bg-secondary disabled:opacity-50">
          <Plus size={14} aria-hidden="true" /> 带入模拟订单
        </button>
      </div>
      {serverOnline && !runtimeReady && <p role="status" className="mt-1 text-amber-600">模拟服务尚未就绪；行情断开、补齐中或存储异常时不能创建新订单。</p>}
      {serverOnline && runtimeReady && !serverSnapshot?.backtestStatus && <p role="status" className="mt-1 text-amber-600">请先运行回测，完成后才能准备模拟订单。</p>}
      {serverSnapshot?.backtestStatus?.status === "invalid" && <p role="alert" className="mt-1 text-rose-500">当前回测无效，模拟订单已禁用。</p>}
      {serverMessage && <p role="alert" className="mt-1 text-amber-600">{serverMessage}</p>}
      {paused && <p role="alert" className="mt-1 text-amber-600">前向模拟暂停：{paused}</p>}
      {serverSnapshot && <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        <span>最后行情 {time(serverSnapshot.runtime.lastMarketAtMs)}</span>
        <span>最后处理 {time(serverSnapshot.runtime.lastSuccessfullyProcessedAtMs)}</span>
        <span>账本存储 {serverSnapshot.runtime.storageStatus === "ok" ? "正常" : "异常"}</span>
        {Object.entries(serverSnapshot.runtime.pausedSymbols).map(([symbol, reason]) => (
          <span key={symbol} role="status">{symbol} 暂停 · {reason}</span>
        ))}
      </div>}
      {serverSnapshot && <p className="mt-1 text-muted-foreground">
        模拟成本 {number(serverSnapshot.costComparison.simulatedFees, 2)} 手续费 + {number(serverSnapshot.costComparison.simulatedSlippage, 2)} 滑点 USDT；
        回测假设买/卖手续费 {number((serverSnapshot.backtestStatus?.costAssumptions?.buyFeeRate ?? DEFAULT_BACKTEST_CONFIG.buyFeeRate) * 100, 3)}% / {number((serverSnapshot.backtestStatus?.costAssumptions?.sellFeeRate ?? DEFAULT_BACKTEST_CONFIG.sellFeeRate) * 100, 3)}%、买/卖滑点 {number((serverSnapshot.backtestStatus?.costAssumptions?.buySlippageRate ?? DEFAULT_BACKTEST_CONFIG.buySlippageRate) * 100, 3)}% / {number((serverSnapshot.backtestStatus?.costAssumptions?.sellSlippageRate ?? DEFAULT_BACKTEST_CONFIG.sellSlippageRate) * 100, 3)}%。
        模型差值 {number(serverSnapshot.costComparison.feeDifference, 4)} / {number(serverSnapshot.costComparison.slippageDifference, 4)} USDT；前向与回测使用同一费率，差值不代表真实成交偏差。
      </p>}
      {error && <p role="alert" className="mt-1 text-rose-500">{error}</p>}
      {order && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">
          <span>当前模拟{order.status === "pending" ? "挂单" : "持仓"} · {number(order.quantity, 8)} {order.symbol.replace("USDT", "")} · {order.strategyVersion}</span>
          {order.status === "pending" && <button type="button" title="取消模拟挂单" disabled={!serverOnline} onClick={() => {
            void fetch(`/api/forward-sim/orders/${encodeURIComponent(order.id)}`, { method: "DELETE" })
              .then(async (response) => {
                const result = await response.json() as { error?: string };
                if (!response.ok) throw new Error(result.error ?? "取消失败");
                await refreshServerState();
              })
              .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "取消失败"));
          }} className="grid h-6 w-6 place-items-center text-muted-foreground hover:text-foreground disabled:opacity-50"><X size={14} /></button>}
        </div>
      )}
      {draft && (
        <div role="dialog" aria-modal="false" aria-label="确认创建模拟订单" className="mt-2 border border-border bg-background p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-semibold text-foreground">确认创建模拟订单</span>
            <button type="button" title="关闭订单确认" onClick={() => { setDraft(null); setServerDraftId(null); }} className="grid h-6 w-6 place-items-center"><X size={14} /></button>
          </div>
          {draft.backtestStatus === "experimental" && <p className="mb-2 text-amber-600">策略尚未通过研究可用门槛</p>}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            <div><dt>订单性质</dt><dd className="text-foreground">仅模拟 · 现货做多</dd></div>
            <div><dt>交易对</dt><dd className="font-mono text-foreground">{draft.symbol}</dd></div>
            <div><dt>入场区间</dt><dd className="font-mono text-foreground">{number(draft.entryLower)}–{number(draft.entryUpper)}</dd></div>
            <div><dt>数量</dt><dd className="font-mono text-foreground">{number(draft.quantity, 8)}</dd></div>
            <div><dt>最大风险</dt><dd className="font-mono text-foreground">{number(draft.riskAmount, 2)} USDT · {number(draft.riskAmount / context.accountEquity * 100, 2)}%</dd></div>
            <div><dt>止损</dt><dd className="font-mono text-foreground">{number(draft.stopPrice)}</dd></div>
            <div><dt>止盈 TP1 / TP2</dt><dd className="font-mono text-foreground">{number(draft.takeProfit1Price)} / {number(draft.takeProfit2Price)}</dd></div>
            <div><dt>预计成本</dt><dd className="font-mono text-foreground">{number(draft.estimatedCosts, 2)} USDT</dd></div>
            <div><dt>剩余有效时间</dt><dd className="font-mono text-foreground">{remainingSeconds} 秒</dd></div>
          </dl>
          <p className="mt-2 break-all text-[10px]">{draft.strategyVersion} · {draft.snapshotId} · {draft.backtestStatus}</p>
          <button type="button" onClick={() => void confirm()} disabled={!canCreateOrder || remainingSeconds <= 0} className="mt-3 inline-flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50">
            <Check size={14} aria-hidden="true" /> 确认创建模拟订单
          </button>
        </div>
      )}
      <div className="mt-2 max-h-24 space-y-1 overflow-auto border-t border-border/60 pt-2 text-[10px]">
        {state.events.filter((event) => event.symbol === attempt.symbol).slice(-5).reverse().map((event) => (
          <p key={event.id}>{new Date(event.timeMs).toISOString()} · {event.kind}{event.price != null && ` · ${number(event.price)}`}{event.reason && ` · ${event.reason}`}</p>
        ))}
      </div>
    </section>
  );
}
