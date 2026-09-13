Type: research
Status: resolved
Assignee: Codex
Resolved: 2026-09-13

## Question

为 OpenCharts 加密货币现货分析确定第一版行情接入契约：历史 K 线 REST 数据源、实时 WebSocket 数据源、交易对命名、时间戳和时区、K 线闭合事件、断线重连、重复事件去重、缺口回填、限流和浏览器部署约束。输出应能指导 `api` / `wsClient` adapter 设计，并明确哪些数据可以直接来自公开市场接口，哪些数据需要后端代理。

## Answer

### Decision

第一版使用 Binance Spot public market-data endpoints，只接现货 K 线，不接账户、订单或用户数据流：

- REST historical source: `https://data-api.binance.vision/api/v3/klines`
- WebSocket market-data source: `wss://data-stream.binance.vision/stream`
- Fallback REST base: `https://api.binance.com/api/v3`
- Official references:
  - `https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints`
  - `https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams`
  - `https://developers.binance.com/docs/binance-spot-api-docs/general-info`

Public klines, exchange metadata, server time, and public kline streams do not require an API key. AI provider calls, persistent user data, account/user-data streams, and any real order capability must stay behind a backend proxy. The browser may consume public market data directly in the first local-research build, but the adapter must keep the base URL configurable so a backend proxy can be inserted for CORS, regional availability, caching, replay, observability, and rate-limit coordination.

### Canonical market-data contract

Use these canonical values inside OpenCharts, independent of Binance wire shape:

```ts
type SpotSymbol = string; // uppercase, e.g. BTCUSDT
type SpotInterval = "1h" | "4h" | "1d";

interface MarketCandle {
  symbol: SpotSymbol;
  interval: SpotInterval;
  openTimeMs: number;
  closeTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  tradeCount: number;
  isClosed: boolean;
  source: "rest" | "ws";
}

interface MarketDataHealth {
  state: "connecting" | "live" | "degraded" | "disconnected";
  serverTimeMs: number | null;
  lastMessageAtMs: number | null;
  lastClosedCandleAtMs: number | null;
  missingRanges: Array<{ symbol: SpotSymbol; interval: SpotInterval; fromMs: number; toMs: number }>;
}
```

All internal timestamps are Unix epoch milliseconds in UTC. Display timezone is a presentation concern. REST array values arrive as decimal strings and must be parsed once at the adapter boundary; reject non-finite numeric values. Preserve `openTimeMs` and `closeTimeMs`; the existing `time`-only candle shape is insufficient for closed-bar analysis and gap repair.

### REST adapter

Expose a typed adapter equivalent to:

```ts
getServerTime(): Promise<number>;
getSpotSymbols(): Promise<SpotSymbolMetadata[]>;
getCandles(input: {
  symbol: SpotSymbol;
  interval: SpotInterval;
  startTimeMs?: number;
  endTimeMs?: number;
  limit?: number;
}): Promise<MarketCandle[]>;
```

Use uppercase symbols for REST requests. The first supported intervals are `1h`, `4h`, and `1d`. Fetch enough history for indicator warm-up plus the visible range; do not rely on the demo feed's time-shifted data. Exclude the still-open last REST candle from formal analysis by setting `isClosed` from `closeTimeMs` and the Binance server time, while retaining it for chart display.

`exchangeInfo` is the source of truth for symbol existence and spot-trading status. Only accept symbols whose status is `TRADING` and whose spot-trading permission is enabled. The initial allowlist remains `BTCUSDT`, `ETHUSDT`, `SOLUSDT`, `BNBUSDT`, `XRPUSDT`, and `ADAUSDT`; symbol metadata should still be fetched rather than hard-coded as the only validation layer.

### WebSocket adapter

Subscribe to lowercase combined-stream names, for example:

```text
btcusdt@kline_1h
btcusdt@kline_4h
btcusdt@kline_1d
```

The server event's `k.x` is the authoritative closed-bar flag. Normalize each event into `MarketCandle`; use `k.t` as `openTimeMs`, `k.T` as `closeTimeMs`, `E` as event time for ordering/observability, and preserve the latest partial candle until the closed event arrives. Partial (`x === false`) events update the chart only. A closed (`x === true`) event is the only WebSocket event eligible to trigger formal analysis.

The adapter owns connection lifecycle:

- reconnect on `error`/`close` with exponential backoff and jitter, capped at 30 seconds;
- resubscribe all desired streams after reconnect;
- maintain one client connection per browser tab and one combined subscription for the initial 18 streams;
- treat a connection as replaceable before Binance's documented 24-hour connection limit;
- expose `connecting`, `live`, `degraded`, and `disconnected` state plus the last message time;
- after reconnect, run REST tail backfill before emitting the stream as healthy.

Do not make analysis correctness depend on application-level ping messages in browser code. The native WebSocket implementation handles protocol control frames; the adapter should still use a message-age watchdog and reconnect when the stream is stale.

### Merge, dedupe, and gap repair

Use `(symbol, interval, openTimeMs)` as the candle identity. Merge REST and WebSocket data with upsert semantics; a later partial event replaces the same key, and the final closed event wins over every partial event. Sort by `openTimeMs` after each batch and never emit duplicate candles.

Bootstrap and recovery sequence:

1. Open the WebSocket and buffer events while REST bootstrap runs.
2. Fetch the closed historical tail using Binance server time.
3. Merge REST data with buffered events by candle identity.
4. Detect missing expected interval boundaries in the closed series.
5. Fetch each missing range through REST, merge again, then release `live` state.

On reconnect, backfill from the last accepted closed candle through the latest closed candle. If a gap remains after retry, mark the affected series `degraded` and block formal analysis for that symbol/interval. Do not forward-fill OHLC values or silently fabricate volume.

### Limits and browser boundary

The adapter must centralize request scheduling, bounded concurrency, and retry handling. Honor Binance response rate-limit headers and `Retry-After`; back off on HTTP `429` and stop retrying on permanent client errors. Keep REST polling event-driven: initial bootstrap, reconnect recovery, explicit range changes, and missing-range repair only.

The browser may directly access public klines and public kline WebSocket streams for this first research-only build, subject to deployment CORS/network behavior. No secret belongs in frontend code. A backend proxy becomes mandatory when adding AI provider keys, user/account data, real orders, durable shared caching, multi-user rate-limit coordination, or server-side historical storage. The public adapter should therefore depend on an injectable transport/base URL rather than hard-code browser-only fetch calls.

### Acceptance boundary

The implementation is ready to leave this ticket when tests prove that:

- REST arrays and WebSocket events normalize to the same canonical candle shape;
- only closed candles trigger analysis;
- REST + WebSocket overlap is deduplicated deterministically;
- reconnect recovery fills a missed range or reports `degraded`;
- a persistent gap blocks formal analysis instead of being filled silently;
- all supported symbols and intervals use the same uppercase/lowercase normalization rules.
