import { binanceKlineStream } from "../market-data/runtime.ts";
import { binanceRestAdapter } from "../market-data/rest-adapter.ts";
import { useTradingStore } from "../store.tsx";
import { createAnalysisPipeline } from "./pipeline.ts";
import type { SimulatedRiskContext } from "./strategy.ts";

function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export const analysisPipeline = createAnalysisPipeline({
  restAdapter: binanceRestAdapter,
  getHealth: () => binanceKlineStream.health,
  getRiskContext: (): SimulatedRiskContext | null => {
    const state = useTradingStore.getState();
    const account = state.accounts.find((item) => item.id === state.activeAccountId);
    const accountEquity = account?.equity ?? account?.balance ?? null;
    const availableQuoteBalance = account?.freeMargin ?? account?.balance ?? null;
    return {
      accountEquity: Number.isFinite(accountEquity) ? accountEquity : null,
      availableQuoteBalance: Number.isFinite(availableQuoteBalance) ? availableQuoteBalance : null,
    };
  },
  storage: browserStorage(),
});
