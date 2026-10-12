import { binanceKlineStream } from "../market-data/runtime.ts";
import { binanceRestAdapter } from "../market-data/rest-adapter.ts";
import { createAnalysisPipeline } from "./pipeline.ts";
import { createCryptoPaperLedger } from "./paper-trading.ts";

function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export const cryptoPaperLedger = createCryptoPaperLedger({ storage: browserStorage() });

export const analysisPipeline = createAnalysisPipeline({
  restAdapter: binanceRestAdapter,
  getHealth: () => binanceKlineStream.health,
  getRiskContext: () => cryptoPaperLedger.getRiskContext(),
  storage: browserStorage(),
});

analysisPipeline.subscribe((attempt) => cryptoPaperLedger.recordAnalysis(attempt));
