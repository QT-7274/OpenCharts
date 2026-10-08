const NUMBER = /(?<![A-Za-z0-9_])[-+]?\d[\d,]*(?:\.\d+)?(?:e[-+]?\d+)?(?:%|[hd])?/giu;
const INDICATOR_PERIOD = /\b(?:RSI|ATR)\s*\(\s*14\s*\)|\b(?:EMA|SMA)\s*(?:20|50|200)\b|\bMACD\s*\(\s*12\s*,\s*26\s*,\s*9\s*\)/giu;

const semanticFields = [
  { name: "takeProfit1", pattern: /(?:TP\s*1|止盈\s*1|第一止盈|take.?profit\s*1)/giu },
  { name: "takeProfit2", pattern: /(?:TP\s*2|止盈\s*2|第二止盈|take.?profit\s*2)/giu },
  { name: "entry", pattern: /(?:入场|进场|买入|entry)/giu },
  { name: "support", pattern: /(?:支撑|support)/giu },
  { name: "resistance", pattern: /(?:阻力|resistance)/giu },
  { name: "stop", pattern: /(?:止损|stop)/giu },
  { name: "takeProfit", pattern: /(?:止盈|take.?profit|目标|target)/giu },
  { name: "score", pattern: /(?:评分|得分|score)/giu },
  { name: "riskReward", pattern: /(?:风险收益比|盈亏比|risk.?reward|R\s*:\s*R)/giu },
  { name: "rsi", pattern: /RSI/giu },
  { name: "ema", pattern: /EMA/giu },
  { name: "atr", pattern: /ATR/giu },
  { name: "macd", pattern: /MACD/giu },
  { name: "volume", pattern: /(?:成交量|volume)/giu },
  { name: "currentPrice", pattern: /(?:现价|当前价格|current\s+price)/giu },
  { name: "price", pattern: /(?:价格|价位|price)/giu },
];

function parseNumber(token) {
  const normalized = token.replace(/[%hd]$/iu, "").replaceAll(",", "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function collectNumbers(value, output = []) {
  if (typeof value === "number" && Number.isFinite(value)) output.push(value);
  else if (typeof value === "string") {
    for (const match of value.matchAll(NUMBER)) {
      const number = parseNumber(match[0]);
      if (number !== null) output.push(number);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, output);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collectNumbers(key, output);
      collectNumbers(item, output);
    }
  }
  return output;
}

function collectPathNumbers(value, paths) {
  return paths.flatMap((path) => {
    let current = value;
    for (const key of path) current = current?.[key];
    return typeof current === "number" && Number.isFinite(current) ? [current] : [];
  });
}

function indicatorNumbers(input, fields) {
  return ["1d", "4h", "1h"].flatMap((interval) =>
    fields.flatMap((field) => collectPathNumbers(input, [["indicators", interval, field]])),
  );
}

function valuesForSemanticField(input, name) {
  const support = ["supportResistance", "support"];
  const resistance = ["supportResistance", "resistance"];
  const entry = ["entryPlan"];
  const plan = (fields) => fields.flatMap((field) => collectPathNumbers(input, [[...entry, field]]));

  switch (name) {
    case "entry": return [...plan(["entryLower", "entryUpper"]), ...collectPathNumbers(input, [["currentPrice"]])];
    case "support": return collectPathNumbers(input, [
      [...support, "price"], [...support, "lower"], [...support, "upper"],
    ]);
    case "resistance": return collectPathNumbers(input, [
      [...resistance, "price"], [...resistance, "lower"], [...resistance, "upper"],
    ]);
    case "stop": return plan(["stop"]);
    case "takeProfit1": return plan(["takeProfit1"]);
    case "takeProfit2": return plan(["takeProfit2"]);
    case "takeProfit": return plan(["takeProfit1", "takeProfit2"]);
    case "score": return collectPathNumbers(input, [["strategy", "score"], ["strategy", "scoreBreakdown", "total"]]);
    case "riskReward": return [
      ...collectPathNumbers(input, [["strategy", "riskReward"], ["entryPlan", "riskReward"]]),
      1,
    ];
    case "rsi": return indicatorNumbers(input, ["rsi14", "previousRsi14"]);
    case "ema": return indicatorNumbers(input, ["ema20", "ema50", "ema200", "ema20ThreeBarsAgo", "ema50FiveBarsAgo"]);
    case "atr": return indicatorNumbers(input, ["atr14"]);
    case "macd": return indicatorNumbers(input, ["macdHistogram", "previousMacdHistogram"]);
    case "volume": return indicatorNumbers(input, ["volume", "volumeSma20"]);
    case "currentPrice": return collectPathNumbers(input, [["currentPrice"]]);
    case "price": return [
      ...valuesForSemanticField(input, "entry"),
      ...valuesForSemanticField(input, "support"),
      ...valuesForSemanticField(input, "resistance"),
      ...valuesForSemanticField(input, "stop"),
      ...valuesForSemanticField(input, "takeProfit"),
      ...indicatorNumbers(input, ["close"]),
    ];
    default: return [];
  }
}

function matchesAllowed(value, allowed) {
  return allowed.some((candidate) =>
    Math.abs(candidate - value) <= Math.max(1, Math.abs(candidate), Math.abs(value)) * 1e-10,
  );
}

function semanticFieldBefore(text, index) {
  const start = Math.max(text.lastIndexOf("。", index), text.lastIndexOf("!", index), text.lastIndexOf("?", index), text.lastIndexOf("\n", index)) + 1;
  const context = text.slice(start, index);
  let nearest = null;

  for (const field of semanticFields) {
    field.pattern.lastIndex = 0;
    for (const match of context.matchAll(field.pattern)) {
      if (!nearest || match.index > nearest.index) nearest = { name: field.name, index: match.index };
    }
  }
  return nearest?.name ?? null;
}

function isConfiguredIndicatorPeriod(text, numberMatch) {
  const numberStart = numberMatch.index ?? 0;
  const numberEnd = numberStart + numberMatch[0].length;
  for (const indicatorMatch of text.matchAll(INDICATOR_PERIOD)) {
    const indicatorStart = indicatorMatch.index ?? 0;
    const indicatorEnd = indicatorStart + indicatorMatch[0].length;
    if (numberStart >= indicatorStart && numberEnd <= indicatorEnd) return true;
  }
  return false;
}

// crypto-ai-analysis.AI_EXPLANATION.6 crypto-ai-analysis.AI_EXPLANATION.6-2
export function validateAiExplanationNumbers(input, explanation) {
  const allAllowed = collectNumbers(input);
  const percentageAllowed = Object.entries(input ?? {}).flatMap(([key, value]) =>
    /percent|percentage|rate/iu.test(key) ? collectNumbers(value) : [],
  );

  for (const text of Object.values(explanation ?? {}).flat()) {
    if (typeof text !== "string") continue;
    for (const match of text.matchAll(NUMBER)) {
      if (/^(?:1h|4h|1d)$/iu.test(match[0]) || isConfiguredIndicatorPeriod(text, match)) continue;
      const number = parseNumber(match[0]);
      if (number === null) continue;
      if (match[0].endsWith("%") && !matchesAllowed(number, percentageAllowed)) return false;

      const semanticField = semanticFieldBefore(text, match.index ?? 0);
      const allowed = semanticField ? valuesForSemanticField(input, semanticField) : allAllowed;
      if (!matchesAllowed(number, allowed)) return false;
    }
  }
  return true;
}
