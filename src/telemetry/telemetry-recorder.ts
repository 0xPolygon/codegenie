import type { ContextPressureSummary, ReviewStage, TelemetryEvent, ToolCallRecord } from "../types.js";
import type { CodeninjaErrorCode } from "../util/errors.js";

export type LlmRole = "planner" | "packetReview" | "systemReview" | "verifier" | "composer";

export type LlmCallRecord = {
  callId: string;
  runId: string;
  stage: ReviewStage | 0;
  role: LlmRole;
  model: string;
  provider: string;
  workerId?: string;
  packetId?: string;
  candidateId?: string;
  kind: "initial" | "tool-continuation" | "repair" | "finalize";
  finalizeMode?: "compact" | "full" | undefined;
  finalizeTarget?: "no_findings" | "candidate_or_unknown" | undefined;
  attempt: number;
  promptChars: number;
  promptHash: string;
  outputChars: number;
  outputHash: string;
  inputTokens?: number;
  uncachedInputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  billableInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUSD?: number;
  inputCostUSD?: number;
  outputCostUSD?: number;
  cacheReadCostUSD?: number;
  cacheWriteCostUSD?: number;
  durationMs: number;
  cacheStatus: "hit" | "miss" | "disabled" | "write";
  schemaValid?: boolean;
  stopReason: "submit" | "tool_calls" | "text" | "error";
  status: "ok" | "schema_invalid" | "transient_error" | "auth_error" | "timeout" | "aborted";
  errorCode?: CodeninjaErrorCode;
  errorMessage?: string;
};

export interface TelemetryRecorder {
  readonly runId: string;
  readonly runDir: string | undefined;
  event(e: Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">): void;
  recordModelCall(record: Omit<LlmCallRecord, "runId">): void;
  recordToolCall(record: Omit<ToolCallRecord, "runId" | "toolCallId" | "timestamp">): string;
  snapshotContextPressure?(): Pick<
    ContextPressureSummary,
    | "toolBudgetRejections"
    | "toolBudgetRejectionsByStage"
    | "toolBudgetExtensions"
    | "degradedToolResults"
    | "degradedToolResultsByStage"
    | "rejectionReasons"
  >;
  writeArtifact(relPath: string, data: unknown): Promise<void>;
  writeDebug(kind: "llm-calls" | "tool-calls", id: string, record: unknown): Promise<void>;
  flush(): Promise<void>;
}
