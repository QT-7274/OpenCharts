/**
 * THROWAWAY PROTOTYPE: three analysis-workflow layouts, selected with ?variant=A|B|C.
 * This branch is a visual decision aid and must not be promoted as production code.
 */
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Database,
  Eye,
  FileClock,
  Gauge,
  Layers3,
  LineChart,
  ListFilter,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Variant = "A" | "B" | "C";
type AnalysisState = "enter" | "setup" | "insufficient";

type StateView = {
  label: string;
  decision: string;
  detail: string;
  score: number | null;
  confidence: string;
  tone: "positive" | "waiting" | "danger";
  expires: string;
  actionEnabled: boolean;
};

const STATE_VIEWS: Record<AnalysisState, StateView> = {
  enter: {
    label: "ENTER",
    decision: "满足模拟入场条件",
    detail: "多周期趋势一致，回调与 1h 确认完成",
    score: 82,
    confidence: "高",
    tone: "positive",
    expires: "02:17:42",
    actionEnabled: true,
  },
  setup: {
    label: "SETUP",
    decision: "等待 1h 价格确认",
    detail: "趋势和回调成立，尚未重新站上 EMA20",
    score: 64,
    confidence: "低",
    tone: "waiting",
    expires: "观察中",
    actionEnabled: false,
  },
  insufficient: {
    label: "DATA GAP",
    decision: "暂不入场",
    detail: "4h 行情存在缺口，REST 回填尚未完成",
    score: null,
    confidence: "不可用",
    tone: "danger",
    expires: "已暂停",
    actionEnabled: false,
  },
};

const VARIANT_NAMES: Record<Variant, string> = {
  A: "图表旁检查",
  B: "决策工作台",
  C: "流程时间线",
};

const SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA"];

const INDICATORS = [
  { label: "1d 趋势", value: "EMA50 > EMA200", score: "+15", ok: true },
  { label: "4h 趋势", value: "EMA20 > EMA50", score: "+15", ok: true },
  { label: "4h 回调", value: "触及动态区域", score: "+20", ok: true },
  { label: "1h 确认", value: "EMA20 reclaim", score: "+15", ok: true },
  { label: "动量", value: "RSI 57.4 · MACD ↑", score: "+12", ok: true },
  { label: "成交量", value: "1.18 × SMA20", score: "+10", ok: true },
  { label: "数据质量", value: "3 周期及时", score: "+5", ok: true },
];

const PLAN = [
  { label: "入场区间", value: "67,820 – 68,060" },
  { label: "止损", value: "65,940" },
  { label: "TP1 · 50%", value: "71,940" },
  { label: "TP2 · 50%", value: "74,260" },
  { label: "风险收益比", value: "1 : 2.14" },
  { label: "模拟数量", value: "0.052 BTC" },
];

function toneClasses(tone: StateView["tone"]): string {
  if (tone === "positive") return "border-emerald-400/40 bg-emerald-400/10 text-emerald-300";
  if (tone === "waiting") return "border-amber-400/40 bg-amber-400/10 text-amber-200";
  return "border-rose-400/40 bg-rose-400/10 text-rose-200";
}

function TinyButton({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid h-8 w-8 shrink-0 place-items-center border border-white/10 bg-[#171b20] text-zinc-400 transition hover:border-white/20 hover:text-white"
    >
      <Icon size={15} />
    </button>
  );
}

function AppHeader({ state }: { state: StateView }) {
  return (
    <header className="flex min-h-12 items-center justify-between border-b border-white/10 bg-[#0b0e11] px-3 md:px-4">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <LineChart size={17} className="text-emerald-400" />
          <span>OpenCharts</span>
        </div>
        <div className="hidden h-5 border-l border-white/10 sm:block" />
        <div className="hidden min-w-0 items-center gap-2 text-xs text-zinc-400 sm:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          Binance Spot
          <span className="font-mono text-zinc-600">12:00:04 UTC</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className={`hidden border px-2 py-1 text-[11px] font-semibold sm:block ${toneClasses(state.tone)}`}>
          {state.label}
        </div>
        <TinyButton icon={FileClock} label="历史快照" />
        <TinyButton icon={WalletCards} label="模拟账户" />
      </div>
    </header>
  );
}

function SymbolBar() {
  return (
    <div className="flex min-h-14 items-center gap-2 overflow-x-auto border-b border-white/10 bg-[#0e1216] px-3 md:px-4">
      <button className="flex h-9 min-w-40 items-center justify-between border border-white/15 bg-[#171b20] px-3 text-left">
        <span>
          <span className="block text-xs font-semibold text-white">BTC / USDT</span>
          <span className="block font-mono text-[10px] text-emerald-400">68,044.20 +2.31%</span>
        </span>
        <ChevronDown size={14} className="text-zinc-500" />
      </button>
      <div className="flex h-9 items-center border border-white/10 bg-[#10151a] p-0.5">
        {(["1h", "4h", "1d"] as const).map((period) => (
          <button
            key={period}
            type="button"
            className={`h-7 px-3 text-xs ${period === "1h" ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
          >
            {period}
          </button>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <span className="hidden text-[11px] text-zinc-500 lg:inline">strategy</span>
        <span className="border border-cyan-400/20 bg-cyan-400/5 px-2 py-1 font-mono text-[10px] text-cyan-300">
          trend-pullback-v1
        </span>
        <TinyButton icon={RefreshCw} label="重新分析" />
      </div>
    </div>
  );
}

function AnalysisStateSwitcher({ value, onChange }: { value: AnalysisState; onChange: (state: AnalysisState) => void }) {
  const items: Array<{ key: AnalysisState; label: string }> = [
    { key: "enter", label: "可入场" },
    { key: "setup", label: "等待" },
    { key: "insufficient", label: "数据不足" },
  ];

  return (
    <div className="flex h-8 items-center border border-white/10 bg-[#0d1115] p-0.5">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onChange(item.key)}
          className={`h-7 px-2.5 text-[11px] transition ${value === item.key ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function PriceChart({ compact = false, dataGap = false }: { compact?: boolean; dataGap?: boolean }) {
  return (
    <div className={`relative overflow-hidden bg-[#0a0e12] ${compact ? "min-h-52" : "min-h-72"}`}>
      <svg viewBox="0 0 920 420" className="absolute inset-0 h-full w-full" preserveAspectRatio="none" aria-label="BTC USDT 1h price chart">
        <defs>
          <pattern id={`grid-${compact ? "compact" : "full"}`} width="92" height="52" patternUnits="userSpaceOnUse">
            <path d="M 92 0 L 0 0 0 52" fill="none" stroke="rgba(255,255,255,0.055)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#grid-${compact ? "compact" : "full"})`} />
        <path
          d="M0 330 C36 304 58 322 88 292 S140 238 178 260 S242 278 282 230 S342 148 386 174 S448 214 492 164 S554 92 602 126 S666 184 716 142 S784 64 830 92 S882 128 920 76"
          fill="none"
          stroke="#38d9a9"
          strokeWidth="3"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d="M0 350 C120 330 202 286 302 250 S468 190 566 170 S746 136 920 104"
          fill="none"
          stroke="#22b8cf"
          strokeDasharray="7 6"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
        />
        {!dataGap && <line x1="0" y1="112" x2="920" y2="112" stroke="#ffcc66" strokeDasharray="3 5" />}
        {!dataGap && <line x1="0" y1="318" x2="920" y2="318" stroke="#ff6b6b" strokeDasharray="3 5" />}
      </svg>
      <div className="absolute left-3 top-3 flex items-center gap-3 text-[10px] text-zinc-500">
        <span>O 67,882.10</span><span className="text-emerald-300">H 68,121.40</span><span className="text-rose-300">L 67,754.00</span><span>C 68,044.20</span>
      </div>
      {!dataGap && <div className="absolute right-0 top-[25%] bg-amber-300 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-black">74,260</div>}
      {!dataGap && <div className="absolute right-0 bottom-[22%] bg-rose-400 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-black">65,940</div>}
      <div className="absolute bottom-3 left-3 flex gap-4 text-[10px] text-zinc-600">
        <span>EMA20 <b className="font-normal text-cyan-300">67,610</b></span>
        <span>EMA50 <b className="font-normal text-zinc-300">66,824</b></span>
        <span>ATR14 <b className="font-normal text-zinc-300">1,264</b></span>
      </div>
      {dataGap && <div className="absolute inset-0 grid place-items-center bg-[#090c0f]/70"><div className="border border-rose-400/30 bg-[#111419] px-4 py-3 text-center"><span className="block text-xs font-semibold text-rose-200">4h 数据回填中</span><span className="mt-1 block text-[10px] text-zinc-500">价格计划已暂停</span></div></div>}
    </div>
  );
}

function ScoreRing({ score }: { score: number | null }) {
  const display = score == null ? "--" : String(score);
  const stroke = score == null ? "#fb7185" : score >= 70 ? "#34d399" : "#fbbf24";
  const dash = score == null ? 18 : score;
  return (
    <div className="relative h-24 w-24 shrink-0">
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" aria-label={`Evidence score ${display}`}>
        <circle cx="50" cy="50" r="40" fill="none" stroke="#262b31" strokeWidth="8" />
        <circle cx="50" cy="50" r="40" fill="none" stroke={stroke} strokeWidth="8" pathLength="100" strokeDasharray={`${dash} 100`} strokeLinecap="butt" />
      </svg>
      <div className="absolute inset-0 grid place-content-center text-center">
        <span className="font-mono text-2xl font-semibold text-white">{display}</span>
        <span className="text-[9px] text-zinc-500">证据分</span>
      </div>
    </div>
  );
}

function PrimaryAction({ enabled, compact = false }: { enabled: boolean; compact?: boolean }) {
  return (
    <button
      type="button"
      disabled={!enabled}
      className={`flex items-center justify-center gap-2 bg-emerald-400 font-semibold text-[#07110e] transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500 ${compact ? "h-9 px-3 text-xs" : "h-11 w-full px-4 text-sm"}`}
    >
      <WalletCards size={15} />
      带入模拟订单
    </button>
  );
}

function explanationFor(state: StateView): string {
  if (state.score == null) {
    return "4 小时行情尚未完成回填，算法已暂停评分与价格计划。数据完整前，AI 不生成方向性结论。";
  }
  if (!state.actionEnabled) {
    return "日线与 4 小时结构仍然有效，但 1 小时尚未重新站上 EMA20。当前只保留观察状态，不生成入场计划。";
  }
  return "日线和 4 小时趋势保持向上，最近回调没有破坏结构。1 小时重新站上短期均线，并得到动量与成交量支持。";
}

function VariantA({ state }: { state: StateView }) {
  const dataGap = state.score == null;
  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto bg-[#090c0f] xl:grid-cols-[minmax(0,1fr)_360px] xl:overflow-hidden">
      <section className="flex min-h-[620px] min-w-0 flex-col border-r border-white/10 xl:min-h-0">
        <div className="flex items-center justify-between border-b border-white/10 bg-[#0d1115] px-3 py-2">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-white">BTCUSDT · 1h</span>
            <span className="font-mono text-[10px] text-zinc-500">closed 12:00 UTC</span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-zinc-500">
            <Database size={12} /> {dataGap ? "572 / 600 bars · gap" : "600 / 600 bars"}
          </div>
        </div>
        <PriceChart dataGap={dataGap} />
        <div className="grid flex-1 grid-cols-1 border-t border-white/10 md:grid-cols-[1.1fr_0.9fr]">
          <div className="min-w-0 border-b border-white/10 p-3 md:border-b-0 md:border-r">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold text-white">多周期证据</h2>
              <span className="text-[10px] text-zinc-600">{dataGap ? "4h 回填中" : "7 / 7 已计算"}</span>
            </div>
            <div className="grid grid-cols-1 gap-px overflow-hidden border border-white/10 bg-white/10 sm:grid-cols-2">
              {INDICATORS.map((item) => (
                <div key={item.label} className="flex min-h-12 items-center justify-between bg-[#101419] px-3 py-2">
                  <div>
                    <span className="block text-[10px] text-zinc-500">{item.label}</span>
                    <span className="block text-xs text-zinc-200">{item.value}</span>
                  </div>
                  <span className={`font-mono text-[11px] ${dataGap ? "text-rose-300" : "text-emerald-300"}`}>{dataGap ? "--" : item.score}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="min-w-0 p-3">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-xs font-semibold text-white"><Bot size={14} className="text-cyan-300" />AI 解释</h2>
              <span className="border border-cyan-400/20 px-1.5 py-0.5 text-[9px] text-cyan-300">explanation only</span>
            </div>
            <p className="text-xs leading-5 text-zinc-300">
              {explanationFor(state)}
            </p>
            <div className="mt-3 border-l-2 border-amber-300/70 pl-3 text-[11px] leading-5 text-zinc-500">
              证据分表示条件完整度，不代表上涨概率。价格若未在计划有效期内回到入场区间，本次机会将自动失效。
            </div>
          </div>
        </div>
      </section>
      <aside className="flex min-h-[760px] flex-col bg-[#0d1115] xl:min-h-0">
        <div className="border-b border-white/10 p-4">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <span className={`inline-flex border px-2 py-1 text-[10px] font-semibold ${toneClasses(state.tone)}`}>{state.label}</span>
              <h1 className="mt-3 text-lg font-semibold text-white">{state.decision}</h1>
              <p className="mt-1 text-xs text-zinc-500">{state.detail}</p>
            </div>
            <ScoreRing score={state.score} />
          </div>
          <div className="flex items-center justify-between border-t border-white/10 pt-3 text-[11px]">
            <span className="text-zinc-500">置信度 <b className="ml-1 font-medium text-zinc-200">{state.confidence}</b></span>
            <span className="flex items-center gap-1 text-zinc-500"><Clock3 size={12} />{state.expires}</span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-white">确定性计划</h2>
            <ShieldCheck size={14} className="text-emerald-400" />
          </div>
          <div className="border-y border-white/10">
            {PLAN.map((row) => (
              <div key={row.label} className="flex items-center justify-between border-b border-white/5 py-2.5 last:border-0">
                <span className="text-[11px] text-zinc-500">{row.label}</span>
                <span className="font-mono text-xs text-zinc-100">{state.actionEnabled ? row.value : "—"}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 bg-[#11171a] p-3">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-zinc-500">最大模拟风险</span>
              <span className="font-mono text-white">100.00 USDT · 1%</span>
            </div>
            <div className="mt-2 h-1.5 bg-zinc-800"><div className="h-full w-1/3 bg-emerald-400" /></div>
            <div className="mt-1 flex justify-between font-mono text-[9px] text-zinc-600"><span>账户风险 1%</span><span>组合上限 3%</span></div>
          </div>
        </div>
        <div className="space-y-2 border-t border-white/10 p-4 pb-20 xl:pb-4">
          <PrimaryAction enabled={state.actionEnabled} />
          <button className="flex h-9 w-full items-center justify-center gap-2 border border-white/10 text-xs text-zinc-300 hover:bg-white/5"><Save size={14} />保存分析快照</button>
        </div>
      </aside>
    </main>
  );
}

function VariantB({ state }: { state: StateView }) {
  const dataGap = state.score == null;
  const setup = !state.actionEnabled && !dataGap;
  const periodSummaries = [
    { label: "1d", title: dataGap ? "趋势尚未验证" : "主趋势向上", sub: dataGap ? "等待完整行情" : "EMA50 > EMA200", value: "15 / 15", done: !dataGap },
    { label: "4h", title: dataGap ? "行情回填中" : "回调结构有效", sub: dataGap ? "存在 28 根缺口" : "距失效线 +3.2%", value: "35 / 35", done: !dataGap },
    { label: "1h", title: dataGap ? "确认尚未验证" : setup ? "等待价格确认" : "确认已经完成", sub: dataGap ? "评分已暂停" : setup ? "尚未站上 EMA20" : "RSI 57.4 · Volume 1.18×", value: "32 / 35", done: state.actionEnabled },
  ];
  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto bg-[#0a0d10] lg:grid-cols-[220px_minmax(0,1fr)_320px] lg:overflow-hidden">
      <aside className="border-b border-white/10 bg-[#0c1014] lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-2 border-b border-white/10 p-3">
          <div className="flex h-8 flex-1 items-center gap-2 border border-white/10 bg-[#14191e] px-2 text-zinc-500"><Search size={13} /><span className="text-[11px]">搜索市场</span></div>
          <TinyButton icon={ListFilter} label="筛选" />
        </div>
        <div className="grid grid-cols-3 gap-px bg-white/10 lg:grid-cols-1">
          {SYMBOLS.map((symbol, index) => (
            <button key={symbol} type="button" className={`flex min-h-14 items-center justify-between bg-[#0c1014] px-3 text-left hover:bg-[#14191e] ${index === 0 ? "border-l-2 border-emerald-400 bg-[#151b1d]" : "border-l-2 border-transparent"}`}>
              <span><b className="block text-xs font-semibold text-white">{symbol}</b><small className="text-[9px] text-zinc-600">USDT · SPOT</small></span>
              <span className={`hidden font-mono text-[10px] lg:block ${index === 4 ? "text-rose-300" : "text-emerald-300"}`}>{index === 4 ? "-0.42%" : `+${(2.31 - index * 0.19).toFixed(2)}%`}</span>
            </button>
          ))}
        </div>
        <div className="hidden border-t border-white/10 p-3 lg:block">
          <div className="flex items-center justify-between text-[10px] text-zinc-500"><span>Scanner</span><span>6 markets</span></div>
          <div className="mt-2 flex gap-1">{[82, 71, 63, 58, 41, 39].map((score) => <span key={score} className={`h-1 flex-1 ${score >= 70 ? "bg-emerald-400" : score >= 50 ? "bg-amber-300" : "bg-zinc-700"}`} />)}</div>
        </div>
      </aside>
      <section className="min-w-0 lg:overflow-y-auto">
        <div className="border-b border-white/10 bg-[#0e1317] px-4 py-5 md:px-6">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
            <div>
              <div className="mb-2 flex items-center gap-2 text-[10px] text-zinc-500"><Activity size={12} className="text-emerald-400" />策略计算 · 12:00:04 UTC · Binance Spot</div>
              <h1 className="text-xl font-semibold text-white md:text-2xl">{state.decision}</h1>
              <p className="mt-1 text-xs text-zinc-500">{state.detail}</p>
            </div>
            <div className="flex items-center gap-4">
              <ScoreRing score={state.score} />
              <div className="space-y-1 text-[11px]"><div className="text-zinc-500">置信度 <b className="text-zinc-100">{state.confidence}</b></div><div className="text-zinc-500">有效期 <b className="font-mono text-zinc-100">{state.expires}</b></div><span className={`inline-block border px-2 py-0.5 text-[9px] font-semibold ${toneClasses(state.tone)}`}>{state.label}</span></div>
            </div>
          </div>
        </div>
        <div className="grid gap-px bg-white/10 md:grid-cols-3">
          {periodSummaries.map((item) => (
            <div key={item.label} className="bg-[#101419] p-4">
              <div className="flex items-center justify-between"><span className="border border-white/10 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">{item.label}</span>{item.done ? <Check size={14} className="text-emerald-400" /> : <Clock3 size={14} className={dataGap ? "text-rose-300" : "text-amber-300"} />}</div>
              <h2 className="mt-4 text-sm font-semibold text-white">{item.title}</h2><p className="mt-1 text-[11px] text-zinc-500">{item.sub}</p><p className={`mt-3 font-mono text-xs ${item.done ? "text-emerald-300" : dataGap ? "text-rose-300" : "text-amber-200"}`}>{dataGap ? "--" : item.done ? item.value : "等待"}</p>
            </div>
          ))}
        </div>
        <div className="border-b border-white/10 bg-[#0d1115] p-4 md:p-6">
          <div className="mb-3 flex items-center justify-between"><h2 className="text-xs font-semibold text-white">证据账本</h2><span className="font-mono text-[9px] text-zinc-600">snapshot a4f2...9c18</span></div>
          <div className="overflow-x-auto border border-white/10">
            <table className="min-w-[620px] text-xs">
              <thead className="bg-[#14191e] text-[10px] text-zinc-500"><tr><th className="p-2 text-left font-medium">条件</th><th className="p-2 text-left font-medium">观测值</th><th className="p-2 text-left font-medium">门槛</th><th className="p-2 text-left font-medium">结果</th><th className="p-2 text-right font-medium">分数</th></tr></thead>
              <tbody>{INDICATORS.slice(0, 6).map((item, index) => {
                const pending = setup && index === 3;
                return <tr key={item.label} className="border-t border-white/5"><td className="p-2 text-zinc-300">{item.label}</td><td className="p-2 font-mono text-zinc-400">{dataGap ? "--" : item.value}</td><td className="p-2 text-zinc-600">{index < 2 ? "hard gate" : "v1 baseline"}</td><td className="p-2"><span className={dataGap ? "text-rose-300" : pending ? "text-amber-200" : "text-emerald-300"}>{dataGap ? "未验证" : pending ? "等待" : "通过"}</span></td><td className="p-2 text-right font-mono text-zinc-200">{dataGap || pending ? "--" : item.score}</td></tr>;
              })}</tbody>
            </table>
          </div>
        </div>
        <div className="grid gap-px bg-white/10 md:grid-cols-2">
          <div className="bg-[#0e1216] p-4 md:p-6"><div className="mb-3 flex items-center gap-2 text-xs font-semibold text-white"><Bot size={14} className="text-cyan-300" />AI 解释</div><p className="text-xs leading-5 text-zinc-400">{explanationFor(state)}</p><p className="mt-3 text-[10px] text-cyan-300">AI 仅解释上方策略结果</p></div>
          <div className="bg-[#0e1216] p-4 pb-24 md:p-6"><div className="mb-3 flex items-center gap-2 text-xs font-semibold text-white"><CircleAlert size={14} className="text-amber-300" />需要注意</div><p className="text-xs leading-5 text-zinc-400">{dataGap ? "行情完整性校验失败时不计算证据分，也不能带入模拟订单。" : setup ? "确认条件尚未完成，不要把观察状态误认为入场信号。" : "置信度不是胜率。计划只有 3 根 1h K 线有效；超过入场上沿时等待回落，不追涨。"}</p></div>
        </div>
      </section>
      <aside className="flex flex-col border-t border-white/10 bg-[#0d1115] lg:border-l lg:border-t-0">
        <div className="border-b border-white/10 p-4"><div className="flex items-center justify-between"><h2 className="text-xs font-semibold text-white">模拟执行预览</h2><Eye size={14} className="text-zinc-500" /></div><p className="mt-1 text-[10px] text-zinc-600">只读 · 确认后才创建订单</p></div>
        <div className="flex-1 p-4"><div className="space-y-1">{PLAN.map((row) => <div key={row.label} className="flex min-h-10 items-center justify-between border-b border-white/5"><span className="text-[11px] text-zinc-500">{row.label}</span><span className="font-mono text-[11px] text-white">{state.actionEnabled ? row.value : "—"}</span></div>)}</div><div className="mt-5 border border-amber-300/20 bg-amber-300/5 p-3 text-[10px] leading-4 text-amber-100">experimental · 策略尚未通过研究可用门槛，仍可用于模拟研究。</div></div>
        <div className="space-y-2 border-t border-white/10 p-4 pb-20 lg:pb-4"><PrimaryAction enabled={state.actionEnabled} /><button className="flex h-9 w-full items-center justify-center gap-2 border border-white/10 text-xs text-zinc-300"><Save size={14} />保存快照</button></div>
      </aside>
    </main>
  );
}

function VariantC({ state }: { state: StateView }) {
  const dataGap = state.score == null;
  const steps = [
    { icon: Database, label: "数据", value: dataGap ? "回填中" : "完整", done: !dataGap },
    { icon: TrendingUp, label: "趋势", value: dataGap ? "未验证" : "多头", done: !dataGap },
    { icon: Layers3, label: "回调", value: dataGap ? "未验证" : "有效", done: !dataGap },
    { icon: Target, label: "确认", value: dataGap ? "未验证" : state.actionEnabled ? "完成" : "等待", done: state.actionEnabled },
    { icon: Gauge, label: "风险", value: state.actionEnabled ? "通过" : "未计算", done: state.actionEnabled },
  ];
  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-[#090c0f]">
      <section className="border-b border-white/10 bg-[#0e1216] px-3 py-4 md:px-6">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-px bg-white/10 sm:grid-cols-5">
          {steps.map((step, index) => {
            const Icon = step.icon;
            return <div key={step.label} className={`relative flex min-h-16 items-center gap-3 bg-[#10151a] px-3 ${index === steps.length - 1 ? "col-span-2 sm:col-span-1" : ""}`}><div className={`grid h-8 w-8 shrink-0 place-items-center border ${step.done ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" : dataGap ? "border-rose-400/30 bg-rose-400/10 text-rose-200" : "border-amber-300/30 bg-amber-300/10 text-amber-200"}`}><Icon size={14} /></div><div><span className="block text-[9px] text-zinc-600">{String(index + 1).padStart(2, "0")} · {step.label}</span><span className="block text-xs text-white">{step.value}</span></div>{index < steps.length - 1 && <ArrowRight size={12} className="absolute -right-2 z-10 hidden text-zinc-600 sm:block" />}</div>;
          })}
        </div>
      </section>
      <section className="mx-auto max-w-6xl border-x border-white/10">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 border-b border-white/10 lg:border-b-0 lg:border-r"><div className="flex items-center justify-between border-b border-white/10 px-4 py-3"><div><span className="text-sm font-semibold text-white">BTCUSDT</span><span className="ml-2 font-mono text-[10px] text-zinc-500">1h · 68,044.20</span></div><span className="flex items-center gap-1 text-[10px] text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />LIVE</span></div><PriceChart compact dataGap={dataGap} /></div>
          <div className="flex flex-col justify-between bg-[#0d1115] p-5">
            <div><span className={`inline-flex border px-2 py-1 text-[10px] font-semibold ${toneClasses(state.tone)}`}>{state.label}</span><h1 className="mt-4 text-xl font-semibold text-white">{state.decision}</h1><p className="mt-2 text-xs leading-5 text-zinc-500">{state.detail}</p></div>
            <div className="mt-6 flex items-end justify-between"><ScoreRing score={state.score} /><div className="pb-2 text-right"><span className="block text-[10px] text-zinc-600">计划有效期</span><span className="font-mono text-sm text-white">{state.expires}</span></div></div>
          </div>
        </div>
        <div className="grid gap-px bg-white/10 md:grid-cols-[1fr_1fr] xl:grid-cols-[1fr_1.1fr_0.9fr]">
          <div className="bg-[#0e1216] p-4 md:p-5"><div className="mb-4 flex items-center justify-between"><h2 className="text-xs font-semibold text-white">关键证据</h2><ShieldCheck size={14} className="text-emerald-400" /></div><div className="space-y-3">{INDICATORS.slice(0, 5).map((item) => <div key={item.label} className="grid grid-cols-[72px_1fr_auto] items-center gap-2"><span className="text-[10px] text-zinc-600">{item.label}</span><span className="truncate text-[11px] text-zinc-300">{item.value}</span><span className="font-mono text-[10px] text-emerald-300">{state.score == null ? "--" : item.score}</span></div>)}</div></div>
          <div className="bg-[#0e1216] p-4 md:p-5"><div className="mb-4 flex items-center justify-between"><h2 className="text-xs font-semibold text-white">价格计划</h2><span className="font-mono text-[9px] text-zinc-600">{state.actionEnabled ? "1R = 1,940" : "未生成"}</span></div><div className="grid grid-cols-2 gap-px bg-white/10">{PLAN.slice(0, 4).map((row, index) => <div key={row.label} className="bg-[#11161b] p-3"><span className="block text-[9px] text-zinc-600">{row.label}</span><span className={`mt-1 block font-mono text-xs ${index === 1 ? "text-rose-300" : index > 1 ? "text-amber-200" : "text-white"}`}>{state.actionEnabled ? row.value : "—"}</span></div>)}</div></div>
          <div className="bg-[#0e1216] p-4 pb-24 md:col-span-2 md:p-5 xl:col-span-1"><div className="mb-4 flex items-center gap-2"><Sparkles size={14} className="text-cyan-300" /><h2 className="text-xs font-semibold text-white">AI 解释</h2></div><p className="text-[11px] leading-5 text-zinc-400">{explanationFor(state)}</p><div className="mt-3 flex items-center gap-2 text-[9px] text-cyan-300"><Bot size={11} />schema v1 · validated</div></div>
        </div>
        <div className="flex flex-col items-stretch justify-between gap-3 border-t border-white/10 bg-[#0c1014] p-4 pb-24 sm:flex-row sm:items-center md:px-5">
          <div className="flex items-center gap-4 text-[10px] text-zinc-500"><span className="flex items-center gap-1"><FileClock size={12} />snapshot ready</span><span className="flex items-center gap-1"><Clock3 size={12} />12:00:04 UTC</span><span className="hidden md:inline">research status: experimental</span></div>
          <div className="flex items-center gap-2"><button className="flex h-9 flex-1 items-center justify-center gap-2 border border-white/10 px-3 text-xs text-zinc-300 sm:flex-none"><Save size={14} />保存快照</button><PrimaryAction enabled={state.actionEnabled} compact /></div>
        </div>
      </section>
    </main>
  );
}

function PrototypeSwitcher({ variant, onChange }: { variant: Variant; onChange: (variant: Variant) => void }) {
  const variants: Variant[] = ["A", "B", "C"];
  const move = (delta: number) => {
    const current = variants.indexOf(variant);
    const next = variants[(current + delta + variants.length) % variants.length];
    if (next) onChange(next);
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft") move(-1);
      if (event.key === "ArrowRight") move(1);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex h-11 -translate-x-1/2 items-center border border-white/20 bg-black px-1 shadow-2xl shadow-black/60">
      <button type="button" onClick={() => move(-1)} title="上一个方案" aria-label="上一个方案" className="grid h-9 w-9 place-items-center text-zinc-400 hover:bg-white/10 hover:text-white"><ArrowLeft size={15} /></button>
      <div className="min-w-40 px-3 text-center"><span className="block text-[9px] text-zinc-600">THROWAWAY PROTOTYPE</span><span className="block text-xs font-semibold text-white">{variant} · {VARIANT_NAMES[variant]}</span></div>
      <button type="button" onClick={() => move(1)} title="下一个方案" aria-label="下一个方案" className="grid h-9 w-9 place-items-center text-zinc-400 hover:bg-white/10 hover:text-white"><ArrowRight size={15} /></button>
    </div>
  );
}

export function AiAnalysisPrototypePage() {
  const initialVariant = useMemo<Variant>(() => {
    const value = new URLSearchParams(window.location.search).get("variant")?.toUpperCase();
    return value === "B" || value === "C" ? value : "A";
  }, []);
  const initialState = useMemo<AnalysisState>(() => {
    const value = new URLSearchParams(window.location.search).get("state");
    return value === "setup" || value === "insufficient" ? value : "enter";
  }, []);
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const [analysisState, setAnalysisState] = useState<AnalysisState>(initialState);
  const state = STATE_VIEWS[analysisState];

  const updateLocation = (nextVariant: Variant, nextState: AnalysisState) => {
    const params = new URLSearchParams(window.location.search);
    params.set("variant", nextVariant);
    params.set("state", nextState);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  };

  const handleVariant = (next: Variant) => {
    setVariant(next);
    updateLocation(next, analysisState);
  };
  const handleState = (next: AnalysisState) => {
    setAnalysisState(next);
    updateLocation(variant, next);
  };

  return (
    <div className="flex h-screen min-h-0 w-screen flex-col overflow-hidden bg-[#090c0f] text-zinc-200">
      <AppHeader state={state} />
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-white/10 bg-[#0b0f13] px-3 md:px-4">
        <div className="flex min-w-0 items-center gap-3"><span className="hidden text-[10px] text-zinc-600 sm:inline">AI ANALYSIS PROTOTYPE</span><AnalysisStateSwitcher value={analysisState} onChange={handleState} /></div>
        <div className="flex items-center gap-2 text-[10px] text-zinc-500"><span className="hidden md:inline">自动分析</span><span className="relative inline-flex h-4 w-7 items-center bg-emerald-400/20"><span className="ml-3.5 h-3 w-3 bg-emerald-400" /></span></div>
      </div>
      <SymbolBar />
      {variant === "A" && <VariantA state={state} />}
      {variant === "B" && <VariantB state={state} />}
      {variant === "C" && <VariantC state={state} />}
      {import.meta.env.DEV && <PrototypeSwitcher variant={variant} onChange={handleVariant} />}
    </div>
  );
}
