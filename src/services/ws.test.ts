import { describe, expect, it } from "vitest";
import { wsClient } from "./ws.ts";

describe("websocket client module initialization", () => {
  it("crypto-ai-analysis.CANDLE_QUALITY.1 initializes without a circular dependency error", () => {
    expect(wsClient.state).toBe("disconnected");
  });
});
