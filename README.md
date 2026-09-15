<div align="center">

# 📈 OpenCharts

**An open-source trading terminal with live Binance Spot market data and an in-browser paper-trading engine.**

Advanced charting · full drawing-tool suite · watchlist · depth-of-market · order panel · built-in paper-trading engine, seeded with **real** market history.

![OpenCharts trading terminal](docs/screenshot.png)

</div>

---

## Table of contents

- [What is OpenCharts?](#what-is-opencharts)
- [Features](#features)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Market data configuration](#market-data-configuration)
- [Refreshing the bundled market data](#refreshing-the-bundled-market-data)
- [Bring your own data / backend](#bring-your-own-data--backend)
- [Adding instruments](#adding-instruments)
- [Scripts](#scripts)
- [Tech stack](#tech-stack)
- [Known limitations](#known-limitations)
- [Contributing](#contributing)
- [Acknowledgements](#acknowledgements)
- [License](#license)

---

## What is OpenCharts?

OpenCharts is a self-contained, professional-grade **trading terminal UI**. Open it
and you land straight in a live-feeling terminal: a candlestick chart with a full
drawing toolbar, a watchlist, a depth-of-market ladder, and an order ticket — all
wired to an **in-browser paper-trading engine**.

There is **no application backend to run**. By default the browser loads public
Binance Spot candles over REST and follows live kline updates over WebSocket. The
paper account and order engine remain local to the browser.

It's ideal as:

- A **standalone charting / paper-trading app** you can host anywhere static.
- A **reference UI** you can point at your own market-data and trading backend
  (the data layer is cleanly isolated — see [Bring your own data](#bring-your-own-data--backend)).
- A **learning sandbox** for charting, technical drawing, and order management.

## Features

### 📊 Charting
- Candlestick chart powered by [`lightweight-charts`](https://github.com/tradingview/lightweight-charts).
- Binance Spot analysis timeframes: **1h, 4h, and 1d**.
- Volume histogram, OHLC legend, live bid/ask price lines, crosshair, and countdown.
- Session highlighting and session-break separators.
- Per-symbol chart preferences and saveable **chart templates** (persisted locally).

### ✏️ Drawing tools
- Draggable, hideable drawing toolbar with trend lines, rays, horizontal/vertical
  lines, rectangles, and text.
- Per-object styling (color, width, line style, labels) with a TradingView-style
  text settings editor.
- An **object tree** panel to select, toggle, and delete drawings.
- Drawings persist per symbol in `localStorage` and survive reloads.

### 📋 Watchlist · DOM · order panel
- **Watchlist** with live prices across all instruments.
- **Depth-of-market (DOM)** ladder.
- **Order panel**: market / limit / stop tickets with volume presets, take-profit
  and stop-loss, plus a one-click trade mode and an order confirmation dialog.
- **Positions / Orders / Trade History** tabs with modify, close, and close-all.

### 💵 Built-in paper trading
- Orders fill against an in-browser engine at the latest replayed price.
- Positions are **marked-to-market live** on every tick, with running P&L.
- Stop-loss / take-profit are evaluated automatically and close positions when hit.
- Account equity, balance, used/free margin update in real time.

### 🛰️ Real market data, no backend
- Historical candles come from Binance Spot public REST endpoints.
- Live candle updates come from Binance Spot public WebSocket streams.
- BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, and ADAUSDT are supported initially.
- No Binance account or API key is required.
- An explicit offline demo mode can replay bundled historical data.

## Quick start

> Requires **Node 22**.

```bash
nvm use 22
npm install
npm run dev
```

Open the printed local URL (e.g. `http://localhost:5173`). The app boots straight
into a session with a funded local paper-trading account — pick a symbol from the
watchlist, set a size in the order panel, and go long or short.

No `.env` file is required for the default Binance public feed. To customize the
provider URLs or use offline demo data, copy `.env.example` to `.env.local` and
change the documented values.

To build for production:

```bash
npm run build      # outputs to dist/
npm run preview    # serve the production build locally
```

## How it works

OpenCharts keeps the UI **backend-agnostic**. The terminal talks to a REST-shaped
`api` and a streaming `wsClient`; the live Binance adapter is isolated behind those
interfaces while paper trading stays in the local demo engine:

```
                ┌─────────────────────────────────────────────┐
                │                Terminal UI                   │
                │  ChartPanel · OrderPanel · DOM · Watchlist    │
                └───────────────┬───────────────┬──────────────┘
                                │ api.*          │ wsClient.subscribe()
                ┌───────────────▼───────┐ ┌──────▼───────────────┐
                │   services/api.ts      │ │   services/ws.ts      │
                │  (REST-shaped facade)  │ │  (streaming client)   │
                └───────────────┬───────┘ └──────┬───────────────┘
                                │                 │
                ┌───────────────▼─────────────────▼───────────────┐
                │ services/market-data/       │ services/demo/      │
                │ Binance REST + WebSocket    │ paper-trading engine│
                └──────────────────────────────────────────────────┘
```

- **`services/demo/engine.ts`** — the paper-trading engine and single source of
  truth for the account, positions, and orders. It marks positions to market and
  publishes the same position/order/equity events the UI already consumed.
- **`services/market-data/`** — normalizes Binance REST arrays and WebSocket events,
  deduplicates candles, detects gaps, reconnects, and runs REST tail recovery.
- **`services/demo/feed.ts`** — used only when `VITE_MARKET_DATA_MODE=demo`.
- **`services/demo/candles.ts`** — serves the bundled history, time-shifted so the
  most recent bar aligns to "now" (values stay real; only the timeline is
  normalized so it looks live).
- **`services/api.ts` / `services/ws.ts`** — stable REST + pub/sub contracts used by
  the UI. Public market data can later move behind a proxy without changing charts.

Because the data layer sits behind a stable interface, **no UI component had to
change** to run without a server.

## Market data configuration

The defaults use Binance's public market-data-only endpoints:

```dotenv
VITE_MARKET_DATA_MODE=binance
VITE_BINANCE_REST_BASE_URL=https://data-api.binance.vision/api/v3
VITE_BINANCE_WS_BASE_URL=wss://data-stream.binance.vision
```

These endpoints require no credentials. Do not add Binance secrets to a Vite
environment variable because every `VITE_*` value is included in browser code.

To run without network access:

```dotenv
VITE_MARKET_DATA_MODE=demo
```

## Project structure

```
src/
├─ App.tsx                  # boots a demo session, renders the terminal
├─ main.tsx                 # React entry, providers, MarketDataBridge
├─ pages/
│  ├─ TradingPage.tsx       # the full terminal layout
│  └─ trading/              # chart, order panel, DOM, watchlist, drawing tools…
├─ lib/
│  ├─ chart-plugins/        # lightweight-charts plugins actually used by the chart
│  │  ├─ drawing-tools/      #   trend lines, rays, rectangles, text, object tree
│  │  ├─ delta-tooltip/ tooltip/ highlight-bar-crosshair/
│  │  └─ session-breaks/ session-highlighting/ bands-indicator/
│  ├─ indicators.ts         # indicator definitions
│  └─ utils.ts
├─ components/              # shared UI (order/position dialogs, ui primitives…)
├─ hooks/                   # chart drawings, preferences, indicators…
├─ services/
│  ├─ api.ts                # REST-shaped facade (demo-backed)
│  ├─ ws.ts                 # streaming client (demo-backed)
│  ├─ store.tsx             # zustand stores (auth + trading state)
│  ├─ schemas.ts            # zod schemas / shared types
│  └─ demo/                 # engine, feed, candles, instruments, bundled data
└─ styles/
scripts/
└─ fetch-demo-data.mjs      # refresh the bundled real OHLC
```

## Refreshing the bundled market data

The demo OHLC lives in `src/services/demo/data/` as JSON and is fetched from the
public **Binance klines** endpoint (no API key required):

```bash
node scripts/fetch-demo-data.mjs
```

This re-pulls 1000 bars per symbol across every timeframe and rewrites the bundled
files. The data is genuine market history — OpenCharts never ships synthetic candles.

## Bring your own data / backend

To connect OpenCharts to real (or your own simulated) data, implement two files
against your APIs — the rest of the app is untouched:

1. **`src/services/api.ts`** — the request/response methods the UI calls
   (`getSymbols`, `getCandles`, `placeOrder`, `getPositions`, `closePosition`, …).
   The expected shapes are defined in `src/services/schemas.ts`.
2. **`src/services/ws.ts`** — a client exposing
   `connect` / `subscribe(channel, handler)` / `subscribeAccounts` / `onStateChange`.
   Publish `MarketTick`, `CandleUpdate`, `Position*`, `Order*`, and `EquityUpdated`
   events on the `market-data` / `positions` / `orders` / `account` channels.

`src/components/MarketDataBridge.tsx` shows exactly which events the UI consumes.

## Adding instruments

Demo instruments are defined in `src/services/demo/instruments.ts`. To add one:

1. Add a `Symbol` entry (name, tick size, contract size, etc.).
2. Add its trading pair to the `SYMBOLS` map in `scripts/fetch-demo-data.mjs`.
3. Run `node scripts/fetch-demo-data.mjs` to fetch and bundle its history.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Preview the production build |
| `npm run typecheck` | Type-check the project with `tsc` |
| `npm run test` | Run the unit test suite (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `node scripts/fetch-demo-data.mjs` | Refresh bundled real OHLC |

## Tech stack

- **React 19** + **TypeScript** + **Vite 6**
- **lightweight-charts** (+ custom plugins) for the chart engine
- **Zustand** for state, **TanStack Query** for data caching
- **Tailwind CSS** + **Radix UI** primitives
- **Zod** for schema validation
- **Vitest** + **Testing Library** for tests

## Known limitations

- **Demo state is ephemeral** — positions, orders, and account balance reset on
  reload (chart drawings and templates persist via `localStorage`).
- **Timeline is normalized** — bundled history is shifted so the latest bar is
  "now". OHLC values are real; the timestamps are remapped to feel live.
- **Crypto-only demo symbols** out of the box (the bundled data source is Binance).
  Wire your own adapter for FX, futures, or equities.
- The production `build` runs Vite only; run `npm run typecheck` separately for
  full type checking.

## Contributing

Issues and pull requests are welcome. Good first contributions: new chart
indicators, additional drawing tools, a persistence layer for the paper account,
or data adapters for other exchanges/brokers.

## Acknowledgements

The chart engine and several plugins build on TradingView's open-source
[`lightweight-charts`](https://github.com/tradingview/lightweight-charts) library.

## License

See [LICENSE](LICENSE).
