import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { analysisPipeline } from "../../services/analysis/runtime.ts";
import { marketDataMode } from "../../services/market-data/runtime.ts";
import { isSpotSymbol, type SpotInterval } from "../../services/market-data/types.ts";
import type { AnalysisAttempt } from "../../services/analysis/pipeline.ts";

const INTERVALS: SpotInterval[] = ["1d", "4h", "1h"];

function formatTime(value: number | null): string {
  return value == null ? "—" : new Date(value).toISOString().replace("T", " ").slice(0, 16) + " UTC";
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
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-secondary/30 px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
      <button
        type="button"
        onClick={() => void analyze()}
        disabled={pending}
        title="Check closed-candle data readiness"
        className="inline-flex shrink-0 items-center gap-1.5 rounded border border-border bg-background px-2 py-1 text-foreground hover:bg-secondary disabled:opacity-50"
      >
        <RefreshCw size={14} aria-hidden="true" className={pending ? "animate-spin" : ""} />
        {pending ? "Checking" : "Analyze data"}
      </button>
      {attempt ? (
        <>
          <span className={attempt.status === "ready" ? "text-emerald-500" : "text-amber-500"}>
            {attempt.status === "ready" ? "Data ready; signal not implemented" : "Insufficient data · No entry"}
          </span>
          <span>{attempt.trigger === "manual" ? "Manual" : "1h close"} · as of {formatTime(attempt.analysisTimeMs)}</span>
          {INTERVALS.map((interval) => (
            <span key={interval}>{interval} {formatTime(attempt.candleCloseTimes[interval])}</span>
          ))}
          {attempt.issues.length > 0 && (
            <span title={attempt.issues.map((issue) => `${issue.interval}: ${issue.code}`).join(", ")}>
              {attempt.issues.map((issue) => `${issue.interval} ${issue.code}`).join(" · ")}
            </span>
          )}
        </>
      ) : <span>Awaiting closed-candle analysis</span>}
    </div>
  );
}
