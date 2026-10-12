import type { BacktestResearchStatus } from "./paper-trading.ts";
import type { BacktestConfig, BacktestCostAssumptions, CryptoBacktestReport } from "./backtest.ts";

const KEY = "opencharts.crypto.backtest-status.v1";

// crypto-ai-analysis.FORWARD_SIMULATION.10-1

export function readBacktestStatus(): BacktestResearchStatus {
  try {
    const value = typeof window === "undefined" ? null : window.localStorage.getItem(KEY);
    return value === "research-usable" || value === "experimental" || value === "invalid" ? value : null;
  } catch {
    return null;
  }
}

export function saveBacktestStatus(status: Exclude<BacktestResearchStatus, null>): boolean {
  try {
    window.localStorage.setItem(KEY, status);
    return true;
  } catch {
    return false;
  }
}

export async function publishBacktestStatus(report: CryptoBacktestReport, config: BacktestConfig): Promise<void> {
  const compactMetrics = (metrics: CryptoBacktestReport["portfolio"]["outOfSample"]["metrics"]) => ({
    tradeCount: metrics.tradeCount,
    maxDrawdownPct: metrics.maxDrawdownPct,
    netReturnPct: metrics.netReturnPct,
    profitFactor: metrics.profitFactor,
  });
  const attestation = {
    strategyVersion: report.strategyVersion,
    validityChecks: report.validityChecks,
    portfolio: { outOfSample: { metrics: compactMetrics(report.portfolio.outOfSample.metrics) } },
    symbols: Object.fromEntries(Object.entries(report.symbols).map(([symbol, result]) => [symbol, {
      outOfSample: result ? { metrics: compactMetrics(result.outOfSample.metrics) } : null,
    }])),
  };
  const response = await fetch("/api/forward-sim/backtest-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      report: attestation,
      costAssumptions: {
        buyFeeRate: config.buyFeeRate,
        sellFeeRate: config.sellFeeRate,
        buySlippageRate: config.buySlippageRate,
        sellSlippageRate: config.sellSlippageRate,
      } satisfies BacktestCostAssumptions,
    }),
  });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error ?? "无法同步回测状态到前向模拟服务");
}

// crypto-ai-analysis.FORWARD_SIMULATION.10-1: a failed run may only revoke order eligibility.
export async function publishInvalidBacktestStatus(strategyVersion: string): Promise<void> {
  const response = await fetch("/api/forward-sim/backtest-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "invalid", strategyVersion }),
  });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error ?? "无法同步回测状态到前向模拟服务");
}
