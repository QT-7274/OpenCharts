import {
  aiExplanationRecordSchema,
  aiExplanationSnapshotSchema,
  buildAiExplanationSnapshot as buildSnapshot,
  type AiExplanationRecord,
} from "./ai-explanation-contract.ts";
import { validateAiExplanationNumbers } from "./ai-explanation-validation.mjs";
import type { AnalysisAttempt } from "./pipeline.ts";

export type { AiExplanationRecord, AiExplanationSnapshot, AiExplanationText } from "./ai-explanation-contract.ts";
export { buildSnapshot as buildAiExplanationSnapshot };

function unavailable(requestedAtMs: number, respondedAtMs: number, failureReason: string): AiExplanationRecord {
  return {
    status: "unavailable",
    provider: "openai",
    modelId: null,
    promptVersion: "crypto-ai-explanation-v1",
    schemaVersion: "crypto-ai-explanation-v1",
    requestedAtMs,
    respondedAtMs,
    tokenUsage: null,
    rawResponse: null,
    validationResult: "unavailable",
    failureReason,
    explanation: null,
  };
}

export const AI_EXPLANATION_CLIENT_TIMEOUT_MS = 15_000;

const inFlight = new Map<string, Promise<AiExplanationRecord>>();

export async function requestAiExplanation(
  snapshotId: string,
  attempt: AnalysisAttempt,
  { regenerate = false, fetchFn = fetch, now = Date.now, timeoutMs = AI_EXPLANATION_CLIENT_TIMEOUT_MS }: {
    regenerate?: boolean;
    fetchFn?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
  } = {},
): Promise<AiExplanationRecord> {
  const requestKey = `${snapshotId}:${regenerate ? "regenerate" : "automatic"}`;
  if (!regenerate) {
    const existing = inFlight.get(requestKey);
    if (existing) return existing;
  }

  const task: Promise<AiExplanationRecord> = (async (): Promise<AiExplanationRecord> => {
    const requestedAtMs = now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const snapshot = attempt.aiInputSummary ?? buildSnapshot(attempt);
      const parsedSnapshot = aiExplanationSnapshotSchema.safeParse(snapshot);
      if (!parsedSnapshot.success) return unavailable(requestedAtMs, now(), "invalid-analysis-snapshot");

      const response = await fetchFn("/api/analysis/explanations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotId, snapshot: parsedSnapshot.data, regenerate }),
        signal: controller.signal,
      });
      if (!response.ok) return unavailable(requestedAtMs, now(), "backend-unavailable");

      const responseBody = await response.json() as unknown;
      if (responseBody == null || typeof responseBody !== "object" || Array.isArray(responseBody)) {
        return unavailable(requestedAtMs, now(), "invalid-backend-response");
      }
      const body = responseBody as Record<string, unknown>;
      if (body.snapshotId !== snapshotId) {
        return {
          ...unavailable(requestedAtMs, now(), "snapshot-mismatch"),
          status: "invalid",
          validationResult: "invalid",
        };
      }
      const record = { ...body };
      delete record.snapshotId;
      const parsed = aiExplanationRecordSchema.safeParse(record);
      if (!parsed.success) {
        return {
          ...unavailable(requestedAtMs, now(), "invalid-backend-response"),
          status: "invalid",
          validationResult: "invalid",
        };
      }
      if (parsed.data.status === "available" && parsed.data.explanation &&
        !validateAiExplanationNumbers(parsedSnapshot.data, parsed.data.explanation)) {
        return {
          ...unavailable(requestedAtMs, now(), "numeric-validation-failed"),
          status: "invalid",
          validationResult: "invalid",
          rawResponse: parsed.data.rawResponse,
        };
      }
      return parsed.data;
    } catch {
      return unavailable(requestedAtMs, now(), controller.signal.aborted ? "request-timeout" : "backend-unavailable");
    } finally {
      clearTimeout(timeout);
    }
  })();

  if (!regenerate) inFlight.set(requestKey, task);
  try {
    return await task;
  } finally {
    if (!regenerate && inFlight.get(requestKey) === task) inFlight.delete(requestKey);
  }
}
