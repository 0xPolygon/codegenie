import type { TSchema } from "@earendil-works/pi-ai";
import type { CodegenieConfig, RepositoryTools, ReviewStage, ToolBudget, ToolResultMeta } from "../types.js";
import type { CodegenieErrorCode } from "../util/errors.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import type { Logger } from "../types.js";

export type LlmRole = "planner" | "packetReview" | "systemReview" | "verifier" | "composer";

export type LlmCallUsage = {
  stage: ReviewStage;
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
  providerCalls: 1;
};

export type ToolExecutionResult = {
  text: string;
  isError?: boolean;
  errorCode?: CodegenieErrorCode;
  meta?: ToolResultMeta;
};

export type ToolResultCacheStatus = "hit" | "miss" | "write" | "disabled";

export type ToolResultCacheHitKind = "stored" | "inflight";

export type ToolResultCacheLookup = {
  result: ToolExecutionResult;
  status: ToolResultCacheStatus;
  backendExecuted: boolean;
  hitKind?: ToolResultCacheHitKind;
  evictedEntries?: number;
};

export interface ToolResultCache {
  execute(input: {
    toolName: string;
    args: Record<string, unknown>;
    signal?: AbortSignal;
    run: () => Promise<ToolExecutionResult>;
  }): Promise<ToolResultCacheLookup>;
}

export type LlmToolResultSummary = {
  id: string;
  tool: string;
  target: string;
  status: "ok" | "error" | "rejected" | "skipped";
  resultChars: number;
  preview?: string;
  errorCode?: CodegenieErrorCode;
  rejectionReason?: string;
  degraded?: boolean;
  degradationReason?: string;
  truncated?: boolean;
  lookupStatus?: ToolResultMeta["lookupStatus"];
  deliveryStatus?: ToolResultMeta["deliveryStatus"];
  recovery?: ToolResultMeta["recovery"];
};

export type LlmPostToolNudgeInput = {
  submitToolName: string;
  toolCallsUsed: number;
  investigationRounds: number;
  resultCharsUsed: number;
  lastToolResults: LlmToolResultSummary[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: TSchema;
  execute(args: unknown, signal: AbortSignal): Promise<ToolExecutionResult>;
};

export type LlmStructuredRequest<T> = {
  /** Type-only link between the request and the expected submit payload. */
  readonly responseType?: T;
  stage: ReviewStage;
  prompt: string;
  schema: TSchema;
  templateVersion: string;
  tools?: ToolDefinition[];
  toolBudget?: ToolBudget;
  timeoutMs: number;
  telemetryContext?: {
    workerId?: string;
    packetId?: string;
    candidateId?: string;
  };
  validateSubmit?(value: T): LlmSubmitSemanticValidation;
  schemaRepair?: {
    replaceConversation?: boolean;
    failAfterRepair?: boolean;
    recoverInvalidSubmit?(input: LlmSchemaInvalidSubmitRecoveryInput): Record<string, unknown> | LlmInvalidSubmitRecovery | undefined;
    buildPrompt?(input: LlmSchemaRepairInput): string;
  };
  finalization?: {
    noResultInstruction?: string;
    buildPostToolNudge?(input: LlmPostToolNudgeInput): string | undefined;
  };
};

export interface LlmRunner {
  runStructured<T>(request: LlmStructuredRequest<T>): Promise<T>;
}

export type LlmSubmitFailureClassification =
  | "schema_invalid"
  | "missing_submit"
  | "multiple_submits"
  | "revise_without_revision_payload"
  | "length_stopped"
  | "final_arguments_partial"
  | "final_arguments_invalid"
  | "event_capture_missing"
  | "event_final_mismatch"
  | "xml_parameter_bleed"
  | "extra_finding_properties"
  | "extra_top_level_properties"
  | "missing_required_finding_fields"
  | "invalid_enum_value"
  | "string_too_long"
  | "empty_no_findings_missing_fields"
  | "unsafe_candidate_like_payload"
  | "invalid_tool_arguments"
  | "unknown";

export type LlmSubmitSemanticValidation =
  | { ok: true }
  | { ok: false; classification: LlmSubmitFailureClassification };

export type LlmSchemaRepairInput = {
  stage: ReviewStage;
  submitTool: string;
  error: string;
  submitCalls: Array<{ id: string; arguments: Record<string, unknown> }>;
  untrustedSubmitCalls?: Array<{
    id: string;
    name: string;
    state: PiUntrustedArgumentParse["state"];
    errorKind?: "unexpected_end" | "unterminated" | "invalid_syntax" | "non_object_root";
  }>;
  extraToolNames: string[];
  classification?: LlmSubmitFailureClassification;
};

export type LlmSchemaInvalidSubmitRecoveryInput = LlmSchemaRepairInput & {
  schemaRepairUsed: boolean;
  // Runner conversation state: whether any earlier submit attempt carried
  // findings (the stage-7 downgrade guard keys on it). Optional because only
  // the packet-review flow consumes it.
  candidateDrafted?: boolean;
  // input.error is truncated for prompts; classification markers can sit past
  // the cap, so recovery hooks that classify get the untruncated message.
  fullError?: string;
};

// Rich recovery result: `kind: "recovery"` discriminates it from a plain
// recovered-arguments record (the legacy return shape planner/composer use).
// The outcome callbacks let a stage own its recovery telemetry while the
// runner keeps revalidation; the repair hints feed the model-repair queue
// when deterministic recovery declines or fails revalidation.
export type LlmInvalidSubmitRecovery = {
  kind: "recovery";
  arguments?: Record<string, unknown>;
  recoveredCallId?: string;
  onRecovered?(recoveredCallId: string): void;
  onRejected?(error: string): void;
  repairClassification?: LlmSubmitFailureClassification;
  replaceConversationOverride?: boolean;
};

export type CreateRunnerHooks = {
  checkpoint(stage: ReviewStage): "ok" | "exhausted";
  reserve?(stage: ReviewStage, estimatedTokens: number, estimatedModelCalls?: number): "ok" | "exhausted";
  releaseReservation?(stage: ReviewStage, estimatedTokens: number, estimatedModelCalls?: number): void;
  onUsage(usage: LlmCallUsage): void;
};

export type CreateRunnerOptions = {
  llmConfig: CodegenieConfig["llm"];
  telemetry: TelemetryRecorder;
  logger: Logger;
  cache?: ModelCallCache;
  toolResultCache?: ToolResultCache;
  runSignal: AbortSignal;
  adapter?: PiAiAdapter;
  hooks: CreateRunnerHooks;
};

export type PiToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Present only on stage submit calls finalized by Codegenie's stream boundary. */
  argumentParse?: PiTrustedArgumentParse;
};

export type PiTrustedArgumentParse =
  | { state: "strict" }
  | { state: "repaired"; repairs: ["pi_narrow_string_repair"] };

export type PiUntrustedArgumentParse =
  | { state: "length_stopped" }
  | { state: "partial"; errorKind: "unexpected_end" | "unterminated" }
  | { state: "invalid"; errorKind: "invalid_syntax" | "non_object_root" }
  | { state: "event_capture_missing" }
  | { state: "event_final_mismatch" };

export type PiInvalidToolCall = {
  type: "invalidToolCall";
  id: string;
  name: string;
  argumentParse: PiUntrustedArgumentParse;
};

export type PiSubmitCall = PiToolCall | PiInvalidToolCall;

export type PiTextContent = {
  type: "text";
  text: string;
};

export type PiAssistantMessage = {
  role: "assistant";
  content: Array<PiToolCall | PiInvalidToolCall | PiTextContent | Record<string, unknown>>;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
  };
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
};

export type PiModelRef = {
  provider: string;
  id: string;
  raw: unknown;
  apiKey?: string;
  oauthProvider?: string;
};

export interface PiAiAdapter {
  resolveModel(input: { provider?: string; model?: string }): PiModelRef | undefined;
  complete(
    model: PiModelRef,
    context: { messages: unknown[]; tools: Array<{ name: string; description: string; parameters: TSchema }> },
    options: Record<string, unknown> & { submitToolName: string }
  ): Promise<PiAssistantMessage>;
  validateToolCall(tools: Array<{ name: string; description: string; parameters: TSchema }>, toolCall: PiToolCall): unknown;
}

export type StoredProviderResponse = {
  cacheSchemaVersion: number;
  createdAt: string;
  stage: ReviewStage;
  message: PiAssistantMessage;
  finishReason: string;
  usage: {
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
  };
};

export type ModelCallCacheMissReason = "not_found" | "schema_mismatch" | "invalid_entry" | "unreadable";

export type CacheLookup =
  | { status: "hit"; response: StoredProviderResponse }
  | { status: "miss"; reason: ModelCallCacheMissReason };

export type ModelCallCacheWriteResult =
  | { status: "write" }
  | { status: "miss"; reason: "write_failed" };

export interface ModelCallCache {
  readonly runFingerprint?: string;
  get(key: string, stage?: ReviewStage): Promise<CacheLookup>;
  put(key: string, entry: StoredProviderResponse): Promise<ModelCallCacheWriteResult>;
}

export function roleForStage(stage: ReviewStage): LlmRole {
  switch (stage) {
    case 5:
      return "planner";
    case 7:
      return "packetReview";
    case 8:
      return "systemReview";
    case 9:
      return "verifier";
    case 10:
      return "composer";
    default:
      return "packetReview";
  }
}

export function repositoryToolsToDefinitions(_tools: RepositoryTools): ToolDefinition[] {
  throw new Error("use buildRepositoryToolDefinitions from src/llm/tool-definitions.ts");
}
