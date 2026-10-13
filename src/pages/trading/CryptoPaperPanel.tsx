import { Activity, Check, CircleAlert, Plus, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cryptoPaperLedger } from "../../services/analysis/runtime.ts";
import type { AnalysisAttempt } from "../../services/analysis/pipeline.ts";
import type {
  PaperCostComparison,
  PaperLedgerState,
  PaperOrder,
  PaperOrderDraft,
  PaperTradingEvent,
} from "../../services/analysis/paper-trading.ts";

interface ForwardSimulationSnapshot {
  ledger: PaperLedgerState;
  riskContext: { accountEquity: number; availableQuoteBalance: number };
  costComparison: PaperCostComparison;
  backtestStatus: {
    status: "research-usable" | "experimental" | "invalid";
    strategyVersion: string;
    updatedAtMs: number;
    reportGeneratedAtMs?: number | null;
    statusReason?: string | null;
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
  return value == null ? "--" : new Date(value).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function statusLabel(status: PaperOrder["status"]): string {
  return {
    pending: "挂单",
    open: "持仓",
    closed: "已平仓",
    cancelled: "已取消",
    expired: "已过期",
  }[status];
}

function eventLabel(kind: PaperTradingEvent["kind"]): string {
  return {
    signal: "信号",
    "order-created": "创建挂单",
    "order-cancelled": "取消挂单",
    "order-expired": "挂单过期",
    fill: "成交",
    "take-profit-1": "TP1",
    "take-profit-2": "TP2",
    stop: "止损",
    "break-even": "保本止损",
    "data-gap": "数据中断",
    "data-restored": "数据恢复",
    "runtime-error": "运行异常",
    "runtime-shutdown": "服务关闭",
  }[kind];
}

function runtimeLabel(connection: string, online: boolean): string {
  if (!online) return "离线";
  return {
    live: "已连接",
    connecting: "连接中",
    reconnecting: "重连中",
    closed: "已断开",
  }[connection] ?? connection;
}

function freshnessLabel(value: number | null, now = Date.now()): string {
  if (value == null) return "无数据";
  const ageSeconds = Math.max(0, Math.floor((now - value) / 1_000));
  return ageSeconds < 60 ? `${ageSeconds} 秒前` : `${Math.floor(ageSeconds / 60)} 分钟前`;
}

function marketTimeLabel(value: number | null): string {
  return value == null ? "无数据" : `${time(value)} · ${freshnessLabel(value)}`;
}

function pnlClass(value: number): string {
  return value > 0 ? "text-emerald-600" : value < 0 ? "text-rose-500" : "text-muted-foreground";
}

type PanelView = "overview" | "orders" | "events";

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
  const [panelView, setPanelView] = useState<PanelView>("overview");

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
  const runtimeReady = serverSnapshot?.runtime.ready === true && !serverSnapshot.storageError;
  const backtestReady = serverSnapshot?.backtestStatus != null && serverSnapshot.backtestStatus.status !== "invalid";
  const canCreateOrder = serverOnline && runtimeReady && backtestReady && !busy;
  const hasBacktestReport = serverSnapshot?.backtestStatus?.reportGeneratedAtMs != null;
  const activeOrders = state.orders.filter((item) => item.status === "pending" || item.status === "open");
  const sortedOrders = [...state.orders].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const sortedEvents = [...state.events].sort((a, b) => b.timeMs - a.timeMs);
  const realizedPnl = state.orders.reduce((sum, item) => sum + item.realizedNetPnl, 0);
  const totalReturn = context.accountEquity - state.initialCapital;
  const completedOrders = state.orders.filter((item) => item.status === "closed");
  const winningOrders = completedOrders.filter((item) => item.realizedNetPnl > 0).length;
  const winRate = completedOrders.length ? winningOrders / completedOrders.length * 100 : null;
  const runtimeCondition = !serverOnline ? "前向服务离线"
    : serverSnapshot?.storageError || serverSnapshot?.runtime.storageStatus === "error" ? "账本存储异常"
      : serverSnapshot?.runtime.recovering ? "行情补齐中"
        : serverSnapshot?.runtime.connection !== "live" ? "行情连接异常"
          : Object.keys(serverSnapshot.runtime.pausedSymbols).length > 0 ? "部分币种已暂停"
            : !runtimeReady ? "正在恢复运行状态" : "服务健康";
  const backtestStatusLabel = serverSnapshot?.backtestStatus?.status === "research-usable" ? "可继续模拟研究"
    : serverSnapshot?.backtestStatus?.status === "experimental" ? "实验性 · 尚未通过研究门槛"
      : serverSnapshot?.backtestStatus?.status === "invalid" ? "无效 · 已禁止新订单" : "尚无回测报告";
  const visibleOrders = panelView === "orders" ? sortedOrders : activeOrders;
  const visibleEvents = panelView === "events" ? sortedEvents : [];

  async function cancelOrder(orderId: string) {
    setError(null);
    try {
      const response = await fetch(`/api/forward-sim/orders/${encodeURIComponent(orderId)}`, { method: "DELETE" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "取消失败");
      await refreshServerState();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "取消失败");
    }
  }

  return (
    <section className="space-y-3 border-t border-border/60 pt-3 text-xs" aria-label="加密货币模拟账户">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Activity size={15} aria-hidden="true" className="shrink-0 text-muted-foreground" />
          <h2 className="font-semibold text-foreground">现货前向模拟</h2>
          <span className={`inline-flex items-center gap-1 ${runtimeReady ? "text-emerald-600" : "text-amber-600"}`}>
            <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
            {runtimeCondition}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">回测：{backtestStatusLabel}</span>
          <button type="button" title="刷新前向模拟状态" aria-label="刷新前向模拟状态" onClick={() => void refreshServerState().catch((reason: unknown) => setServerMessage(reason instanceof Error ? reason.message : "刷新失败"))} className="grid h-7 w-7 place-items-center text-muted-foreground hover:text-foreground">
            <RefreshCw size={14} aria-hidden="true" />
          </button>
          <button type="button" onClick={() => void prefill()} disabled={!canCreateOrder || attempt.strategy?.state !== "enter" || Boolean(order) || Boolean(paused)} className="inline-flex items-center gap-1.5 border border-border bg-background px-2 py-1 text-foreground hover:bg-secondary disabled:opacity-50">
            <Plus size={14} aria-hidden="true" /> 带入模拟订单
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-3 lg:grid-cols-6" aria-label="模拟账户摘要">
        <Metric label="账户净值" value={`${number(context.accountEquity, 2)} USDT`} />
        <Metric label="可用 USDT" value={number(context.availableQuoteBalance, 2)} />
        <Metric label="累计收益" value={`${totalReturn >= 0 ? "+" : ""}${number(totalReturn, 2)} USDT`} valueClass={pnlClass(totalReturn)} />
        <Metric label="已实现盈亏" value={`${realizedPnl >= 0 ? "+" : ""}${number(realizedPnl, 2)} USDT`} valueClass={pnlClass(realizedPnl)} />
        <Metric label="完成交易 / 胜率" value={`${completedOrders.length} / ${winRate == null ? "--" : `${number(winRate, 1)}%`}`} />
        <Metric label="挂单 / 持仓" value={`${activeOrders.filter((item) => item.status === "pending").length} / ${activeOrders.filter((item) => item.status === "open").length}`} />
      </div>

      {serverOnline && !runtimeReady && <p role="status" className="flex items-start gap-1.5 text-amber-600"><CircleAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0" />模拟服务尚未就绪；行情断开、补齐中或存储异常时不能创建新订单。</p>}
      {serverOnline && runtimeReady && !serverSnapshot?.backtestStatus && <p role="status" className="text-amber-600">请先运行回测，完成后才能准备模拟订单。</p>}
      {serverSnapshot?.backtestStatus?.status === "invalid" && <p role="alert" className="text-rose-500">当前回测无效，模拟订单已禁用。{serverSnapshot.backtestStatus.statusReason ? ` ${serverSnapshot.backtestStatus.statusReason}` : ""}</p>}
      {serverSnapshot?.backtestStatus?.status === "experimental" && <p role="status" className="text-amber-600">策略尚未通过研究可用门槛；当前报告仅用于模拟研究，不代表策略有效。</p>}
      {serverMessage && <p role="alert" className="text-amber-600">{serverMessage}</p>}
      {paused && <p role="alert" className="text-amber-600">{attempt.symbol} 前向模拟暂停：{paused}</p>}

      <div className="grid gap-3 border-y border-border py-2 sm:grid-cols-2 lg:grid-cols-4" aria-label="运行状态">
        <StatusItem label="行情连接" value={`${runtimeLabel(serverSnapshot?.runtime.connection ?? "", serverOnline)} · ${marketTimeLabel(serverSnapshot?.runtime.lastMarketAtMs ?? null)}`} tone={serverSnapshot?.runtime.connection === "live" && serverOnline ? "good" : "warn"} />
        <StatusItem label="最后成功处理" value={time(serverSnapshot?.runtime.lastSuccessfullyProcessedAtMs ?? null)} />
        <StatusItem label="账本存储" value={serverSnapshot?.runtime.storageStatus === "ok" ? "正常" : serverOnline ? "异常" : "未连接"} tone={serverSnapshot?.runtime.storageStatus === "ok" ? "good" : "warn"} />
        <StatusItem label="回测报告更新时间" value={time(serverSnapshot?.backtestStatus?.updatedAtMs ?? null)} />
      </div>

      {serverSnapshot && <div className="grid gap-1 text-muted-foreground sm:grid-cols-2" aria-label="模拟成本与回测假设">
        {hasBacktestReport ? <>
          <span>模拟手续费 {number(serverSnapshot.costComparison.simulatedFees, 4)} USDT；回测报告费率买/卖 {number(serverSnapshot.backtestStatus?.costAssumptions?.buyFeeRate! * 100, 3)}% / {number(serverSnapshot.backtestStatus?.costAssumptions?.sellFeeRate! * 100, 3)}%</span>
          <span>模拟滑点 {number(serverSnapshot.costComparison.simulatedSlippage, 4)} USDT；回测报告滑点买/卖 {number(serverSnapshot.backtestStatus?.costAssumptions?.buySlippageRate! * 100, 3)}% / {number(serverSnapshot.backtestStatus?.costAssumptions?.sellSlippageRate! * 100, 3)}%</span>
          <span>相对回测模型费用差值 {number(serverSnapshot.costComparison.feeDifference, 4)} USDT</span>
          <span>相对回测模型滑点差值 {number(serverSnapshot.costComparison.slippageDifference, 4)} USDT</span>
        </> : <>
          <span>模拟手续费 {number(serverSnapshot.costComparison.simulatedFees, 4)} USDT</span>
          <span>模拟滑点 {number(serverSnapshot.costComparison.simulatedSlippage, 4)} USDT</span>
          <span className="sm:col-span-2">回测费率假设：无可用回测报告，费用差值暂不比较。</span>
        </>}
        <span className="sm:col-span-2">成本按回测费率模型计算，不代表真实订单成交费用或实测滑点。</span>
      </div>}

      <nav className="flex items-center gap-1 border-b border-border" aria-label="模拟账户视图">
        {(["overview", "orders", "events"] as const).map((view) => {
          const label = view === "overview" ? `当前订单 (${activeOrders.length})`
            : view === "orders" ? `全部记录 (${state.orders.length})` : `运行事件 (${state.events.length})`;
          return <button key={view} type="button" role="tab" aria-selected={panelView === view} onClick={() => setPanelView(view)} className={`border-b-2 px-2 py-1.5 ${panelView === view ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {label}
          </button>;
        })}
      </nav>

      {(panelView === "overview" || panelView === "orders") && <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-left" aria-label="模拟交易记录">
          <thead className="text-[10px] text-muted-foreground"><tr>
            <th className="py-1.5 pr-3 font-medium">时间 (UTC)</th><th className="py-1.5 pr-3 font-medium">交易对</th><th className="py-1.5 pr-3 font-medium">状态</th>
            <th className="py-1.5 pr-3 text-right font-medium">数量</th><th className="py-1.5 pr-3 text-right font-medium">入场 / 当前</th>
            <th className="py-1.5 pr-3 text-right font-medium">止损 / TP1 / TP2</th><th className="py-1.5 pr-3 text-right font-medium">净盈亏</th>
            <th className="py-1.5 pr-3 text-right font-medium">费用 / 滑点</th><th className="py-1.5 pr-3 font-medium">策略 / 回测</th><th className="py-1.5 font-medium">操作</th>
          </tr></thead>
          <tbody className="divide-y divide-border/70">
            {visibleOrders.map((item) => <tr key={item.id}>
              <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">{time(item.createdAtMs)}</td>
              <td className="py-2 pr-3 font-mono text-foreground">{item.symbol}</td>
              <td className="py-2 pr-3">{statusLabel(item.status)}</td>
              <td className="py-2 pr-3 text-right font-mono">{number(item.status === "open" ? item.remainingQuantity : item.quantity, 8)}</td>
              <td className="py-2 pr-3 text-right font-mono">{number(item.actualEntryPrice ?? item.referencePrice)} / {number(state.lastPrices[item.symbol] ?? item.actualEntryPrice ?? item.referencePrice)}</td>
              <td className="py-2 pr-3 text-right font-mono">{number(item.activeStopPrice)} / {number(item.takeProfit1Price)} / {number(item.takeProfit2Price)}</td>
              <td className={`py-2 pr-3 text-right font-mono ${pnlClass(item.realizedNetPnl)}`}>{item.realizedNetPnl >= 0 ? "+" : ""}{number(item.realizedNetPnl, 4)} USDT</td>
              <td className="py-2 pr-3 text-right font-mono">{number(item.entryFee + item.exitFees, 4)} / {number(item.entrySlippage + item.exitSlippage, 4)}</td>
              <td className="py-2 pr-3"><span className="block">{item.strategyVersion}</span><span className="text-[10px] text-muted-foreground">{item.backtestStatus}</span></td>
              <td className="py-2">{item.status === "pending" && <button type="button" title={`取消 ${item.symbol} 模拟挂单`} aria-label={`取消 ${item.symbol} 模拟挂单`} disabled={!serverOnline} onClick={() => void cancelOrder(item.id)} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-50"><X size={13} aria-hidden="true" />取消</button>}</td>
            </tr>)}
          </tbody>
        </table>
        {visibleOrders.length === 0 && <p className="py-5 text-center text-muted-foreground">{panelView === "overview" ? "暂无挂单或持仓" : "暂无模拟交易记录"}</p>}
      </div>}

      {panelView === "events" && <div className="max-h-64 overflow-auto">
        {visibleEvents.length === 0 ? <p className="py-5 text-center text-muted-foreground">暂无运行事件</p> : <table className="w-full min-w-[600px] text-left" aria-label="前向模拟运行事件">
          <thead className="text-[10px] text-muted-foreground"><tr><th className="py-1.5 pr-3 font-medium">时间 (UTC)</th><th className="py-1.5 pr-3 font-medium">交易对</th><th className="py-1.5 pr-3 font-medium">事件</th><th className="py-1.5 pr-3 text-right font-medium">价格</th><th className="py-1.5 font-medium">详情</th></tr></thead>
          <tbody className="divide-y divide-border/70">{visibleEvents.map((event) => <tr key={event.id}>
            <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">{time(event.timeMs)}</td><td className="py-2 pr-3 font-mono">{event.symbol}</td>
            <td className="py-2 pr-3">{eventLabel(event.kind)}</td><td className="py-2 pr-3 text-right font-mono">{event.price == null ? "--" : number(event.price)}</td>
            <td className="py-2">{event.reason ?? "--"}</td>
          </tr>)}</tbody>
        </table>}
      </div>}

      {Object.entries(serverSnapshot?.runtime.pausedSymbols ?? {}).length > 0 && <div className="space-y-1 border-t border-border pt-2" aria-label="暂停交易对">
        {Object.entries(serverSnapshot?.runtime.pausedSymbols ?? {}).map(([symbol, reason]) => <p key={symbol} role="status" className="text-amber-600">{symbol} 已暂停：{reason}</p>)}
      </div>}
      {error && <p role="alert" className="text-rose-500">{error}</p>}
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
            <div><dt>参考入场价</dt><dd className="font-mono text-foreground">{number(draft.referencePrice)}</dd></div>
            <div><dt>入场区间</dt><dd className="font-mono text-foreground">{number(draft.entryLower)}–{number(draft.entryUpper)}</dd></div>
            <div><dt>数量</dt><dd className="font-mono text-foreground">{number(draft.quantity, 8)}</dd></div>
            <div><dt>最大风险</dt><dd className="font-mono text-foreground">{number(draft.riskAmount, 2)} USDT · {number(draft.riskAmount / context.accountEquity * 100, 2)}%</dd></div>
            <div><dt>止损</dt><dd className="font-mono text-foreground">{number(draft.stopPrice)}</dd></div>
            <div><dt>止盈 TP1 / TP2</dt><dd className="font-mono text-foreground">{number(draft.takeProfit1Price)} / {number(draft.takeProfit2Price)}</dd></div>
            <div><dt>预计手续费 / 滑点</dt><dd className="font-mono text-foreground">{number(draft.estimatedFees, 2)} / {number(draft.estimatedSlippage, 2)} USDT</dd></div>
            <div><dt>剩余有效时间</dt><dd className="font-mono text-foreground">{remainingSeconds} 秒</dd></div>
          </dl>
          <p className="mt-2 break-all text-[10px]">{draft.strategyVersion} · {draft.snapshotId} · {draft.backtestStatus}</p>
          <button type="button" onClick={() => void confirm()} disabled={!canCreateOrder || remainingSeconds <= 0} className="mt-3 inline-flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50">
            <Check size={14} aria-hidden="true" /> 确认创建模拟订单
          </button>
        </div>
      )}
    </section>
  );
}

function Metric({ label, value, valueClass = "text-foreground" }: { label: string; value: string; valueClass?: string }) {
  return <div className="min-w-0 bg-background px-2.5 py-2">
    <dt className="truncate text-[10px] text-muted-foreground">{label}</dt>
    <dd className={`mt-0.5 truncate font-mono tabular-nums ${valueClass}`}>{value}</dd>
  </div>;
}

function StatusItem({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "good" | "warn" }) {
  const toneClass = tone === "good" ? "text-emerald-600" : tone === "warn" ? "text-amber-600" : "text-foreground";
  return <div className="min-w-0">
    <div className="text-[10px] text-muted-foreground">{label}</div>
    <div className={`truncate font-mono ${toneClass}`} title={value}>{value}</div>
  </div>;
}
