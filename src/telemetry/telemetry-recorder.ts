import type { StreamProgress } from "../llm/stream-progress.js";
import type { ContextPressureSummary, ReviewStage, TelemetryEvent, ToolCallRecord } from "../types.js";
import type { CodegenieErrorCode } from "../util/errors.js";

export type LlmRole = "planner" | "packetReview" | "systemReview" | "verifier" | "composer";

export type LlmFinalArgumentState =
  | "strict"
  | "repaired"
  | "partial"
  | "invalid"
  | "length_stopped"
  | "event_capture_missing"
  | "event_final_mismatch";

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
  // Effective provider protocol for this call (plan 86): requested vs
  // effective tool choice and the reasoning mechanism the level maps onto.
  toolChoiceRequested?: string;
  toolChoiceEffective?: string;
  toolChoiceDowngraded?: boolean;
  reasoningConfigured?: string;
  reasoningSelected?: string;
  reasoningPolicy?: "configured" | "one_level_lower" | "lowest_supported";
  reasoningRequested?: string;
  reasoningMechanism?: string;
  reasoningLevelEffective?: string;
  // Headers can arrive before any model output; streamProgress measures Pi events.
  streamProgress?: StreamProgress;
  ttfbMs?: number;
  providerHttpStatus?: number;
  providerRequestId?: string;
  rateLimit?: Record<string, string>;
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
  reasoningTokens?: number;
  totalTokens?: number;
  costUSD?: number;
  inputCostUSD?: number;
  outputCostUSD?: number;
  cacheReadCostUSD?: number;
  cacheWriteCostUSD?: number;
  durationMs: number;
  cacheStatus: "hit" | "miss" | "disabled" | "write";
  schemaValid?: boolean;
  submitTool?: string;
  finalArgumentState?: LlmFinalArgumentState;
  finalArgumentErrorKind?: "unexpected_end" | "unterminated" | "invalid_syntax" | "non_object_root";
  finalArgumentRepairKind?: "pi_narrow_string_repair";
  finalArgumentCorrelationId?: string;
  stopReason: "submit" | "tool_calls" | "text" | "error";
  status: "ok" | "schema_invalid" | "transient_error" | "auth_error" | "timeout" | "aborted";
  errorCode?: CodegenieErrorCode;
  errorMessage?: string;
  retryable?: boolean;
  retryReason?: string;
  maxAttempts?: number;
  retryExhausted?: boolean;
};

export interface TelemetryRecorder {
  readonly runId: string;
  readonly runDir: string | undefined;
  event(e: Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">): void;
  recordModelCall(record: Omit<LlmCallRecord, "runId">): void;
  recordToolCall(record: Omit<ToolCallRecord, "runId" | "toolCallId" | "timestamp">): string;
  snapshotStageTimings?(): Array<{ stage: number; runtimeMs: number }>;
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
