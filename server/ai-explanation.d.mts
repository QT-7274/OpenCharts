export const AI_EXPLANATION_PROMPT_VERSION: string;
export const AI_EXPLANATION_SCHEMA_VERSION: string;
export const AI_EXPLANATION_MAX_OUTPUT_TOKENS: number;
export const AI_EXPLANATION_TIMEOUT_MS: number;
export const AI_EXPLANATION_DAILY_LIMIT: number;

export function createFileDailyLimitStore(filePath: string): {
  read(): Promise<{ day: string; count: number } | null>;
  write(state: { day: string; count: number }): Promise<void>;
};

export const analysisSnapshotSchema: {
  safeParse(value: unknown): { success: boolean; data?: unknown };
};

export function validateAiExplanation(input: unknown, value: unknown): {
  valid: boolean;
  reason: string | null;
  explanation: unknown | null;
};

export function createOpenAiAiExplanationProvider(options?: Record<string, unknown>): {
  modelId: string;
  explain(input: unknown): Promise<Record<string, unknown>>;
};

export function createAiExplanationService(options?: Record<string, unknown>): {
  explain(input: unknown, options?: { regenerate?: boolean }): Promise<Record<string, unknown>>;
};

export function handleAiExplanationRequest(...args: unknown[]): Promise<void>;
export function createAiExplanationServer(options?: Record<string, unknown>): unknown;
