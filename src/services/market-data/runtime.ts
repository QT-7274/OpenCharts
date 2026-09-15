import { createBrowserMarketDataApi } from "./browser-api.ts";
import { binanceRestAdapter } from "./rest-adapter.ts";
import { BinanceKlineStream } from "./ws-adapter.ts";

export const marketDataMode = import.meta.env.VITE_MARKET_DATA_MODE === "demo" ? "demo" : "binance";

export const binanceKlineStream = new BinanceKlineStream({
  restAdapter: binanceRestAdapter,
});

export const browserMarketDataApi = createBrowserMarketDataApi({
  restAdapter: binanceRestAdapter,
  getHealth: () => binanceKlineStream.health,
});
