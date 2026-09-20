import { describe, expect, it } from "vitest";
import { inspectWindow, type AnalysisIssue } from "./quality.ts";
import { BASE, MS, candle } from "./fixtures.ts";

function codes(issues: AnalysisIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

describe("formal analysis candle quality", () => {
  it("crypto-ai-analysis.CANDLE_QUALITY.2 crypto-ai-analysis.CANDLE_QUALITY.3 filters open and future bars before selection", () => {
    const asOf = candle("1h", 2).closeTimeMs;
    const result = inspectWindow(
      "BTCUSDT", "1h", asOf,
      [candle("1h", 0), candle("1h", 1), candle("1h", 2, { isClosed: false }), candle("1h", 3)],
      2,
    );
    expect(result.candles.map((row) => row.openTimeMs)).toEqual([BASE, BASE + MS["1h"]]);
    expect(result.issues).toEqual([]);
  });

  it("crypto-ai-analysis.CANDLE_QUALITY.4 rejects invalid OHLCV and UTC interval boundaries", () => {
    const asOf = candle("1h", 1).closeTimeMs;
    const bad = candle("1h", 1, { high: 99, volume: -1, openTimeMs: BASE + MS["1h"] + 1 });
    const result = inspectWindow("BTCUSDT", "1h", asOf, [candle("1h", 0), bad], 2);
    expect(codes(result.issues)).toContain("invalid-candle");
  });

  it("crypto-ai-analysis.CANDLE_QUALITY.4 rejects non-finite timestamps on closed bars", () => {
    const result = inspectWindow("BTCUSDT", "1h", candle("1h", 1).closeTimeMs,
      [candle("1h", 0), candle("1h", 1, { closeTimeMs: Number.NaN })], 2);
    expect(codes(result.issues)).toContain("invalid-candle");
  });

  it("crypto-ai-analysis.CANDLE_QUALITY.4 crypto-ai-analysis.CANDLE_QUALITY.5 detects gaps and conflicting closed versions", () => {
    const asOf = candle("1h", 3).closeTimeMs;
    const result = inspectWindow(
      "BTCUSDT", "1h", asOf,
      [candle("1h", 0), candle("1h", 2), candle("1h", 2, { close: 106 })], 2,
    );
    expect(codes(result.issues)).toContain("conflict");
    expect(codes(result.issues)).toContain("gap");
    expect(result.issues.find((issue) => issue.code === "gap")?.fromMs).toBe(BASE + MS["1h"]);
  });

  it("crypto-ai-analysis.CANDLE_QUALITY.4 crypto-ai-analysis.CANDLE_QUALITY.5-1 reports warmup and stale data times", () => {
    const result = inspectWindow("BTCUSDT", "4h", candle("4h", 4).closeTimeMs, [candle("4h", 0)], 3);
    expect(codes(result.issues)).toEqual(expect.arrayContaining(["warmup", "stale"]));
    expect(result.latestCloseTimeMs).toBe(candle("4h", 0).closeTimeMs);
  });
});
