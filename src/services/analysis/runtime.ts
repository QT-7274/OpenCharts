import { binanceKlineStream } from "../market-data/runtime.ts";
import { binanceRestAdapter } from "../market-data/rest-adapter.ts";
import { createAnalysisPipeline } from "./pipeline.ts";

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
  storage: browserStorage(),
});
