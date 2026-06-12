import type { TSchema } from "@earendil-works/pi-ai";
import type { CodeninjaConfig, RepositoryTools, ReviewStage, ToolBudget, ToolResultMeta } from "../types.js";
import type { CodeninjaErrorCode } from "../util/errors.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import type { Logger } from "../types.js";

export type LlmRole = "planner" | "packetReview" | "verifier" | "composer";

export type LlmCallUsage = {
  stage: ReviewStage;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUSD?: number;
  providerCalls: 1;
};

export type ToolExecutionResult = {
  text: string;
  isError?: boolean;
  errorCode?: CodeninjaErrorCode;
  meta?: ToolResultMeta;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: TSchema;
  execute(args: unknown, signal: AbortSignal): Promise<ToolExecutionResult>;
};

export type LlmStructuredRequest<T> = {
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
};

export interface LlmRunner {
  runStructured<T>(request: LlmStructuredRequest<T>): Promise<T>;
}

export type CreateRunnerHooks = {
  checkpoint(stage: ReviewStage): "ok" | "exhausted";
  reserve?(stage: ReviewStage, estimatedTokens: number): "ok" | "exhausted";
  releaseReservation?(stage: ReviewStage, estimatedTokens: number): void;
  onUsage(usage: LlmCallUsage): void;
};

export type CreateRunnerOptions = {
  llmConfig: CodeninjaConfig["llm"];
  telemetry: TelemetryRecorder;
  logger: Logger;
  cache?: ModelCallCache;
  runSignal: AbortSignal;
  adapter?: PiAiAdapter;
  hooks: CreateRunnerHooks;
};

export type PiToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type PiTextContent = {
  type: "text";
  text: string;
};

export type PiAssistantMessage = {
  role: "assistant";
  content: Array<PiToolCall | PiTextContent | Record<string, unknown>>;
  provider: string;
  model: string;
  usage?: {
    input?: number;
    output?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
  stopReason?: string;
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
    options: Record<string, unknown>
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
    outputTokens?: number;
    totalTokens?: number;
    costUSD?: number;
  };
};

export type CacheLookup = { status: "hit"; response: StoredProviderResponse } | { status: "miss" };

export interface ModelCallCache {
  get(key: string, stage?: ReviewStage): Promise<CacheLookup>;
  put(key: string, entry: StoredProviderResponse): Promise<void>;
}

export function roleForStage(stage: ReviewStage): LlmRole {
  switch (stage) {
    case 5:
      return "planner";
    case 7:
      return "packetReview";
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
