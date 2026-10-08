import { homedir } from "node:os";
import { join } from "node:path";
import {
  createAiExplanationServer,
  createAiExplanationService,
  createFileDailyLimitStore,
  createOpenAiAiExplanationProvider,
} from "./ai-explanation.mjs";

const port = Number(process.env.OPENCHARTS_AI_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("OPENCHARTS_AI_PORT must be a valid TCP port");
}

const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
const model = process.env.OPENAI_MODEL?.trim() || "gpt-6-luna";
const provider = createOpenAiAiExplanationProvider({ apiKey, model });
const usagePath = process.env.OPENCHARTS_AI_USAGE_PATH || join(homedir(), ".opencharts", "ai-usage.json");
const service = createAiExplanationService({ provider, dailyLimitStore: createFileDailyLimitStore(usagePath) });
const server = createAiExplanationServer({ service, apiKeyConfigured: Boolean(apiKey) });

server.on("error", (error) => {
  console.error("AI explanation server failed:", error.message);
  process.exitCode = 1;
});

server.listen(port, "127.0.0.1", () => {
  console.info(`AI explanation server listening on http://127.0.0.1:${port}`);
});
