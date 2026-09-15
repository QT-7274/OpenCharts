import type { Symbol } from "../schemas.ts";

/**
 * Demo instruments use the same USDT symbols as the Binance market-data adapter.
 * Demo history maps these names to the bundled USD files at its boundary.
 */
function crypto(name: string, displayName: string, tickSize: number): Symbol {
  return {
    id: name,
    name,
    displayName,
    category: "CRYPTO",
    contractSize: 1,
    tickSize,
    tickValue: tickSize,
    marginPercent: 1,
    maxLeverage: 100,
    commission: 0,
    swapLong: 0,
    swapShort: 0,
    tradingHoursStart: null,
    tradingHoursEnd: null,
    isActive: true,
  };
}

export const DEMO_SYMBOLS: Symbol[] = [
  crypto("BTCUSDT", "Bitcoin / Tether", 0.01),
  crypto("ETHUSDT", "Ethereum / Tether", 0.01),
  crypto("SOLUSDT", "Solana / Tether", 0.01),
  crypto("BNBUSDT", "BNB / Tether", 0.01),
  crypto("XRPUSDT", "XRP / Tether", 0.0001),
  crypto("ADAUSDT", "Cardano / Tether", 0.0001),
];

export const DEMO_SYMBOL_NAMES = DEMO_SYMBOLS.map((s) => s.name);

export function getDemoSymbol(name: string): Symbol | undefined {
  return DEMO_SYMBOLS.find((s) => s.name === name);
}
