import {
  complete,
  completeSimple,
  getEnvApiKey,
  getModel,
  getModels,
  getProviders,
  validateToolCall,
  type Api,
  type AssistantMessage,
  type Context,
  type KnownProvider,
  type Model,
  type SimpleStreamOptions,
  type Tool,
  type ToolCall
} from "@earendil-works/pi-ai";
import { getOAuthApiKey, getOAuthProvider, type OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import pLimit from "p-limit";
import { createFileAuthStorage } from "../provider/provider-services.js";
import { getCodeninjaPaths } from "../config/paths.js";
import { registerSecret } from "../telemetry/redaction.js";
import { fenceUntrusted } from "../skills/prompt-builder.js";
import type { ReviewStage, ToolCallRecord, ToolResultMeta } from "../types.js";
import type { PiAuthStorage, ProviderAuthEntry } from "../provider/provider-services.js";
import { sha256Hex } from "../util/hashing.js";
import { CodeninjaError, type CodeninjaErrorCode } from "../util/errors.js";
import {
  roleForStage,
  type CreateRunnerOptions,
  type LlmCallUsage,
  type LlmRunner,
  type LlmStructuredRequest,
  type PiAiAdapter,
  type PiAssistantMessage,
  type PiModelRef,
  type PiToolCall,
  type StoredProviderResponse,
  type ToolDefinition,
  type ToolExecutionResult
} from "./llm-runner.js";
import { MODEL_CALL_CACHE_SCHEMA_VERSION, buildModelCallCacheKey } from "./model-call-cache.js";
import { SCHEMA_VERSIONS, submitToolNameForStage } from "./schemas.js";

type ConversationMessage = Record<string, unknown>;

type ProviderCallResult =
  | { source: "cache"; message: PiAssistantMessage; callId: string }
  | { source: "provider"; message: PiAssistantMessage; callId: string };

type ProviderLimit = <T>(fn: () => Promise<T>) => Promise<T>;

type ToolChoiceMode = "auto" | { type: "tool"; name: string };

type ToolRunOutcome = {
  result: ToolExecutionResult;
  status: ToolCallRecord["status"];
  errorCode?: CodeninjaErrorCode;
  args: Record<string, unknown>;
  durationMs: number;
};

const NO_REPOSITORY_TOOL_BUDGET = {
  maxToolCalls: 0,
  maxInvestigationRounds: 0,
  maxResultChars: 0
};

const MAX_PROVIDER_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30_000;
const RUNNER_MESSAGE_VERSION = "pi-runner-loop-v2";

type RealPiAiAdapterDeps = {
  complete?: typeof complete;
  completeSimple?: typeof completeSimple;
  getOAuthApiKey?: typeof getOAuthApiKey;
  authStorage?: PiAuthStorage;
};

export function createPiRunner(opts: CreateRunnerOptions): LlmRunner {
  const adapter = opts.adapter ?? createRealPiAiAdapter();
  const providerLimit = pLimit(Math.max(1, opts.llmConfig.maxConcurrentCalls));
  const model = adapter.resolveModel(definedRecord({ provider: opts.llmConfig.provider, model: opts.llmConfig.model }) as {
    provider?: string;
    model?: string;
  });
  if (!model) {
    throw new CodeninjaError("config_error", "no usable LLM model could be resolved", {
      context: { provider: opts.llmConfig.provider ?? null, model: opts.llmConfig.model ?? null }
    });
  }

  let modelCallSeq = 0;
  const nextModelCallId = (): string => `mc-${String(++modelCallSeq).padStart(6, "0")}`;

  return {
    runStructured: async <T>(request: LlmStructuredRequest<T>): Promise<T> => {
      const submitTool = buildSubmitTool(request);
      const repositoryTools = request.tools ?? [];
      const allTools = [...repositoryTools, submitTool];
      const budget = request.toolBudget ?? NO_REPOSITORY_TOOL_BUDGET;
      const messages: ConversationMessage[] = [
        { role: "user", content: request.prompt, timestamp: 0 }
      ];
      let toolCallsUsed = 0;
      let investigationRounds = 0;
      let resultCharsUsed = 0;
      let schemaRepairUsed = false;
      let finalizeNudgeUsed = false;
      let forceFinalize = false;
      const taskTimeout = timeoutSignal(opts.runSignal, request.timeoutMs);

      try {
        for (;;) {
          const activeTools = forceFinalize ? [submitTool] : allTools;
          const kind = forceFinalize ? schemaRepairUsed ? "repair" : "finalize" : messages.length === 1 ? "initial" : "tool-continuation";
          const toolChoice = forceFinalize || repositoryTools.length === 0
            ? { type: "tool" as const, name: submitTool.name }
            : "auto";
          const providerResult = await completeWithCache({
            opts,
            adapter,
            request,
            model,
            messages,
            tools: activeTools,
            kind,
            toolChoice,
            providerLimit,
            nextModelCallId,
            taskSignal: taskTimeout.signal,
            taskTimedOut: taskTimeout.timedOut
          });
          const message = providerResult.message;
          messages.push(message as unknown as ConversationMessage);

          const submitCall = firstToolCall(message, submitTool.name);
          const toolCalls = toolCallsExcept(message, submitTool.name);
          if (submitCall) {
            try {
              const validated = adapter.validateToolCall([toolSpec(submitTool)], submitCall);
              if (toolCalls.length > 0) {
                recordSubmitWithExtraTools(opts, request, submitTool.name, toolCalls);
              }
              return validated as T;
            } catch (cause) {
              if (schemaRepairUsed) {
                throw new CodeninjaError("llm_schema_invalid", "model submit payload failed schema validation after repair", {
                  recoverable: true,
                  context: { submitTool: submitTool.name, error: cause instanceof Error ? cause.message : String(cause) },
                  cause
                });
              }
              schemaRepairUsed = true;
              forceFinalize = true;
              messages.push({
                role: "user",
                content: `The ${submitTool.name} arguments were schema-invalid: ${cause instanceof Error ? cause.message : String(cause)}. Call ${submitTool.name} again with corrected schema-valid arguments.`,
                timestamp: 0
              });
              continue;
            }
          }

          if (forceFinalize) {
            throw new CodeninjaError("llm_schema_invalid", `model did not call ${submitTool.name} during ${kind}`, {
              recoverable: true,
              context: { submitTool: submitTool.name, kind }
            });
          }

          if (toolCalls.length > 0 && !forceFinalize) {
            investigationRounds += 1;
            const toolResults: ConversationMessage[] = [];
            for (const toolCall of toolCalls) {
              const tool = repositoryTools.find((candidate) => candidate.name === toolCall.name);
              const remainingResultChars = Math.max(0, budget.maxResultChars - resultCharsUsed);
              const outcome =
                remainingResultChars <= 0
                  ? rejectedToolOutcome(toolCall, "tool result character budget exhausted")
                  : toolCallsUsed >= budget.maxToolCalls || investigationRounds > budget.maxInvestigationRounds
                  ? rejectedToolOutcome(toolCall, "tool budget exhausted")
                  : tool
                    ? await executeToolCall(adapter, repositoryTools, tool, toolCall, taskTimeout.signal, taskTimeout.timedOut)
                    : rejectedToolOutcome(toolCall, `unknown tool ${toolCall.name}`);

              toolCallsUsed += 1;
              let resultText = fitToolResultText(outcome.result.text, remainingResultChars);
              if (resultText.length < outcome.result.text.length) {
                outcome.result = {
                  ...outcome.result,
                  text: resultText,
                  meta: markTruncated(outcome.result.meta)
                };
              }
              resultCharsUsed += resultText.length;
              recordToolCall(opts, request, providerResult.callId, toolCall, outcome);
              toolResults.push({
                role: "toolResult",
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                content: [{ type: "text", text: fenceUntrusted(resultText, `tool-result-${toolCall.name}`) }],
                isError: outcome.result.isError === true,
                timestamp: 0
              });
            }
            messages.push(...toolResults);

            if (toolCallsUsed >= budget.maxToolCalls || investigationRounds >= budget.maxInvestigationRounds) {
              forceFinalize = true;
              messages.push({
                role: "user",
                content: `Tool budget is exhausted. Call ${submitTool.name} now with the best schema-valid result supported by the evidence already gathered.`,
                timestamp: 0
              });
            }
            continue;
          }

          if (finalizeNudgeUsed) {
            throw new CodeninjaError("llm_schema_invalid", `model did not call ${submitTool.name} after repair/finalization`, {
              recoverable: true,
              context: { submitTool: submitTool.name }
            });
          }
          finalizeNudgeUsed = true;
          forceFinalize = true;
          messages.push({
            role: "user",
            content: `Finish by calling ${submitTool.name} with schema-valid arguments. Do not answer in plain text.`,
            timestamp: 0
          });
        }
      } finally {
        taskTimeout.cleanup();
      }
    }
  };
}

export function createRealPiAiAdapter(deps: RealPiAiAdapterDeps = {}): PiAiAdapter {
  const completeFn = deps.complete ?? complete;
  const completeSimpleFn = deps.completeSimple ?? completeSimple;
  return {
    resolveModel: ({ provider, model }) => resolveRealModel(provider, model, deps.authStorage),
    complete: async (model, context, options) => {
      const apiKey = await resolveModelApiKey(model, deps);
      const completeOptions = definedRecord({ ...options, apiKey }) as SimpleStreamOptions & Record<string, unknown>;
      if (isForcedToolChoice(completeOptions.toolChoice)) {
        return completeFn(
          model.raw as Model<Api>,
          context as Context,
          mapProviderOptions(model.raw as Model<Api>, completeOptions)
        ) as Promise<PiAssistantMessage>;
      }
      return completeSimpleFn(model.raw as Model<Api>, context as Context, completeOptions) as Promise<PiAssistantMessage>;
    },
    validateToolCall: (tools, toolCall) => validateToolCall(tools as Tool[], toolCall as ToolCall)
  };
}

async function completeWithCache(input: {
  opts: CreateRunnerOptions;
  adapter: PiAiAdapter;
  request: LlmStructuredRequest<unknown>;
  model: PiModelRef;
  messages: ConversationMessage[];
  tools: ToolDefinition[];
  kind: "initial" | "tool-continuation" | "repair" | "finalize";
  toolChoice: ToolChoiceMode;
  providerLimit: ProviderLimit;
  nextModelCallId: () => string;
  taskSignal: AbortSignal;
  taskTimedOut: () => boolean;
}): Promise<ProviderCallResult> {
  const { opts, adapter, request, model, messages, tools, kind, toolChoice, providerLimit, nextModelCallId, taskSignal, taskTimedOut } = input;
  const canonicalRequest = canonicalModelRequest({
    cacheSchemaVersion: MODEL_CALL_CACHE_SCHEMA_VERSION,
    runFingerprint: opts.cache?.runFingerprint ?? null,
    runnerMessageVersion: RUNNER_MESSAGE_VERSION,
    provider: model.provider,
    model: model.id,
    reasoning: opts.llmConfig.reasoning ?? "high",
    stage: request.stage,
    templateVersion: request.templateVersion,
    schemaName: submitToolNameForStage(request.stage),
    schemaVersion: SCHEMA_VERSIONS[submitToolNameForStage(request.stage)],
    toolBudget: request.toolBudget ?? NO_REPOSITORY_TOOL_BUDGET,
    kind,
    toolChoice,
    messages,
    tools
  });
  const promptText = stableJson(canonicalRequest);
  const cacheKey = buildModelCallCacheKey(canonicalRequest);

  if (opts.cache) {
    const cached = await opts.cache.get(cacheKey, request.stage);
    if (cached.status === "hit") {
      const cachedSchemaValid = schemaValidityForResponse(adapter, request, tools, cached.response.message);
      if (cachedSchemaValid === false) {
        opts.telemetry.event({
          stage: request.stage,
          level: "warn",
          message: "model_call_cache_schema_invalid_miss",
          cacheStatus: "miss",
          data: { cacheKey }
        });
      } else {
        const callId = nextModelCallId();
          recordModelCall(opts, request, model, cached.response.message, {
            callId,
            kind,
            attempt: 1,
            cacheStatus: "hit",
            promptText,
            durationMs: 0,
            usage: cached.response.usage
          });
        return { source: "cache", message: cached.response.message, callId };
      }
    }
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
    throwIfTaskAborted(taskSignal, taskTimedOut);
    const checkpoint = opts.hooks.checkpoint(request.stage);
    if (checkpoint === "exhausted") {
      throw new CodeninjaError("llm_call_failed", "LLM provider call budget exhausted", {
        recoverable: true,
        context: { reason: "budget_exhausted", stage: request.stage }
      });
    }
    const estimatedTokens = estimateProviderCallTokens(promptText);
    if (opts.hooks.reserve?.(request.stage, estimatedTokens) === "exhausted") {
      throw new CodeninjaError("llm_call_failed", "LLM provider call budget exhausted", {
        recoverable: true,
        context: { reason: "budget_exhausted", stage: request.stage }
      });
    }
    let reservationActive = opts.hooks.reserve !== undefined;
    const releaseReservation = (): void => {
      if (!reservationActive) {
        return;
      }
      reservationActive = false;
      opts.hooks.releaseReservation?.(request.stage, estimatedTokens);
    };

    const callId = nextModelCallId();
    const startedAt = Date.now();
    try {
      const message = await providerLimit(() =>
        adapter.complete(
          model,
          { messages, tools: tools.map(toolSpec) },
          {
            signal: taskSignal,
            maxRetries: 0,
            reasoning: opts.llmConfig.reasoning ?? "high",
            toolChoice
          }
        )
      );
      const durationMs = Date.now() - startedAt;
      const schemaValid = schemaValidityForResponse(adapter, request, tools, message);
      const cacheStatus = opts.cache ? "miss" : "disabled";
      const modelCallMeta = definedRecord({
        callId,
        kind,
        attempt,
        cacheStatus,
        promptText,
        durationMs,
        schemaValid
      }) as {
        callId: string;
        kind: "initial" | "tool-continuation" | "repair" | "finalize";
        attempt: number;
        cacheStatus: "hit" | "miss" | "disabled" | "write";
        promptText: string;
        durationMs: number;
        schemaValid?: boolean;
      };
      const callStatus = schemaValid === false ? "schema_invalid" : "ok";
      const callErrorCode = schemaValid === false ? "llm_schema_invalid" : undefined;
      recordModelCall(opts, request, model, message, definedRecord({
        ...modelCallMeta,
        status: callStatus,
        errorCode: callErrorCode
      }) as typeof modelCallMeta & { status?: "ok" | "schema_invalid"; errorCode?: CodeninjaErrorCode });
      reportUsage(opts, request.stage, message);
      releaseReservation();
      if (opts.cache && isCacheableProviderResponse(schemaValid, message)) {
        await opts.cache.put(cacheKey, cacheEntry(request.stage, message));
      }
      return { source: "provider", message, callId };
    } catch (cause) {
      releaseReservation();
      reportAttemptUsage(opts, request.stage);
      lastError = cause;
      const status = taskTimedOut() ? "timeout" : errorStatus(cause);
      recordErroredModelCall(opts, request, model, {
        callId,
        kind,
        attempt,
        cacheStatus: opts.cache ? "miss" : "disabled",
        promptText,
        durationMs: Date.now() - startedAt,
        status,
        errorCode: "llm_call_failed"
      });
      if (status === "transient_error" && isRetryableProviderError(cause, attempt) && attempt < MAX_PROVIDER_ATTEMPTS) {
        await sleep(retryDelayMs(cause, attempt), taskSignal, taskTimedOut);
        continue;
      }
      throw toLlmError(cause, status, taskTimedOut());
    }
  }

  throw toLlmError(lastError, "transient_error", false);
}

function buildSubmitTool<T>(request: LlmStructuredRequest<T>): ToolDefinition {
  const name = submitToolNameForStage(request.stage);
  return {
    name,
    description: `Submit the final structured result for stage ${request.stage}.`,
    parameters: request.schema,
    execute: async () => ({ text: "submit tool is handled by codeninja" })
  };
}

function canonicalModelRequest(input: {
  cacheSchemaVersion: number;
  runFingerprint: string | null;
  runnerMessageVersion: string;
  provider: string;
  model: string;
  reasoning: string;
  stage: ReviewStage;
  templateVersion: string;
  schemaName: string;
  schemaVersion: number;
  toolBudget: unknown;
  kind: "initial" | "tool-continuation" | "repair" | "finalize";
  toolChoice: ToolChoiceMode;
  messages: ConversationMessage[];
  tools: ToolDefinition[];
}): Record<string, unknown> {
  return {
    cacheSchemaVersion: input.cacheSchemaVersion,
    runFingerprint: input.runFingerprint,
    runnerMessageVersion: input.runnerMessageVersion,
    provider: input.provider,
    model: input.model,
    reasoning: input.reasoning,
    stage: input.stage,
    templateVersion: input.templateVersion,
    schemaName: input.schemaName,
    schemaVersion: input.schemaVersion,
    toolBudget: input.toolBudget,
    kind: input.kind,
    toolChoice: input.toolChoice,
    messages: input.messages,
    tools: input.tools
      .map((tool) => {
        const spec = toolSpec(tool);
        return {
          name: spec.name,
          description: spec.description,
          parameters: spec.parameters,
          parametersHash: sha256Hex(stableJson(spec.parameters))
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  };
}

function estimateProviderCallTokens(promptText: string): number {
  return Math.max(1, Math.ceil(promptText.length / 4));
}

function isForcedToolChoice(choice: unknown): choice is Extract<ToolChoiceMode, { type: "tool" }> {
  return Boolean(choice && typeof choice === "object" && (choice as { type?: unknown }).type === "tool");
}

function mapProviderOptions(model: Model<Api>, options: SimpleStreamOptions & Record<string, unknown>): Record<string, unknown> {
  const mapped = { ...options };
  const reasoning = typeof options.reasoning === "string" ? options.reasoning : undefined;
  const toolChoice = mapProviderToolChoice(model, options.toolChoice);
  delete mapped.reasoning;
  delete mapped.toolChoice;

  Object.assign(mapped, mapReasoningOptions(model, reasoning));
  if (toolChoice !== undefined) {
    if (model.api === "openai-responses" || model.api === "azure-openai-responses" || model.api === "openai-codex-responses") {
      mapped.onPayload = withToolChoicePayload(options.onPayload, toolChoice);
    } else {
      mapped.toolChoice = toolChoice;
    }
  }
  return mapped;
}

function mapReasoningOptions(model: Model<Api>, reasoning: string | undefined): Record<string, unknown> {
  if (!reasoning) {
    return {};
  }
  switch (model.api) {
    case "anthropic-messages":
      return { thinkingEnabled: true, effort: reasoning };
    case "bedrock-converse-stream":
      return { reasoning };
    case "google-generative-ai":
    case "google-vertex":
      return { thinking: { enabled: true, level: googleThinkingLevel(reasoning) } };
    case "mistral-conversations":
    case "openai-completions":
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return { reasoningEffort: reasoning };
    default:
      return { reasoningEffort: reasoning };
  }
}

function googleThinkingLevel(reasoning: string): "LOW" | "MEDIUM" | "HIGH" {
  switch (reasoning) {
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    default:
      return "HIGH";
  }
}

function mapProviderToolChoice(model: Model<Api>, choice: unknown): unknown {
  if (choice === "auto") {
    return "auto";
  }
  if (!isForcedToolChoice(choice)) {
    return undefined;
  }
  switch (model.api) {
    case "anthropic-messages":
    case "bedrock-converse-stream":
      return { type: "tool", name: choice.name };
    case "google-generative-ai":
    case "google-vertex":
      return "any";
    case "mistral-conversations":
    case "openai-completions":
      return { type: "function", function: { name: choice.name } };
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return { type: "function", name: choice.name };
    default:
      return "required";
  }
}

function withToolChoicePayload(
  existing: unknown,
  toolChoice: unknown
): (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined> {
  return async (payload, model) => {
    const next = typeof existing === "function"
      ? await (existing as (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>)(payload, model)
      : undefined;
    const target = next ?? payload;
    if (target && typeof target === "object") {
      (target as Record<string, unknown>).tool_choice = toolChoice;
    }
    return target;
  };
}

function firstToolCall(message: PiAssistantMessage, name: string): PiToolCall | undefined {
  return message.content.find((block): block is PiToolCall => isToolCall(block) && block.name === name);
}

function toolCallsExcept(message: PiAssistantMessage, excludedName: string): PiToolCall[] {
  return message.content.filter((block): block is PiToolCall => isToolCall(block) && block.name !== excludedName);
}

function isToolCall(block: unknown): block is PiToolCall {
  return Boolean(block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall");
}

async function executeToolCall(
  adapter: PiAiAdapter,
  tools: ToolDefinition[],
  tool: ToolDefinition,
  toolCall: PiToolCall,
  taskSignal: AbortSignal,
  taskTimedOut: () => boolean
): Promise<ToolRunOutcome> {
  const startedAt = Date.now();
  try {
    throwIfTaskAborted(taskSignal, taskTimedOut);
    const args = adapter.validateToolCall(tools.map(toolSpec), toolCall) as Record<string, unknown>;
    try {
      const result = await tool.execute(args, taskSignal);
      return {
        result,
        status: result.isError ? result.errorCode === "path_outside_repo" ? "rejected" : "error" : "ok",
        ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
        args,
        durationMs: Date.now() - startedAt
      };
    } catch (cause) {
      if (taskSignal.aborted && isAbortError(cause)) {
        throw taskAbortError(taskTimedOut());
      }
      throw cause;
    }
  } catch (cause) {
    if (taskSignal.aborted && cause instanceof CodeninjaError && cause.code === "llm_call_failed") {
      throw cause;
    }
    if (cause instanceof CodeninjaError) {
      return {
        result: {
          text: `tool error: ${cause.code}: ${cause.message}`,
          isError: true,
          meta: { backend: "text", precision: "text", degraded: true, degradationReason: cause.code }
        },
        status: cause.code === "path_outside_repo" ? "rejected" : "error",
        errorCode: cause.code,
        args: toolCall.arguments,
        durationMs: Date.now() - startedAt
      };
    }
    return {
      result: {
        text: `tool error: ${cause instanceof Error ? cause.message : String(cause)}`,
        isError: true,
        meta: { backend: "text", precision: "text", degraded: true, degradationReason: "tool_failed" }
      },
      status: "error",
      errorCode: "llm_call_failed",
      args: toolCall.arguments,
      durationMs: Date.now() - startedAt
    };
  }
}

function rejectedToolOutcome(toolCall: PiToolCall, reason: string): ToolRunOutcome {
  return {
    result: {
      text: `tool rejected: ${reason}`,
      isError: true,
      meta: { backend: "text", precision: "text", degraded: true, degradationReason: "budget_or_tool_rejected" }
    },
    status: "rejected",
    args: toolCall.arguments,
    durationMs: 0
  };
}

function fitToolResultText(text: string, remainingChars: number): string {
  if (text.length <= remainingChars) {
    return text;
  }
  if (remainingChars <= 0) {
    return "";
  }
  const marker = "\n[tool result truncated by codeninja tool budget]";
  if (remainingChars <= marker.length) {
    return marker.slice(0, remainingChars);
  }
  return `${text.slice(0, remainingChars - marker.length).trimEnd()}${marker}`;
}

function recordToolCall(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  modelCallId: string,
  toolCall: PiToolCall,
  outcome: ToolRunOutcome
): void {
  const meta = outcome.result.meta ?? defaultToolMeta();
  const record = definedRecord({
    stage: request.stage,
    initiator: "model" as const,
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    candidateId: request.telemetryContext?.candidateId,
    modelCallId,
    tool: toolCall.name,
    args: toolArgsForRecord(outcome.args),
    backend: meta.backend,
    precision: meta.precision,
    degraded: meta.degraded,
    degradationReason: meta.degradationReason,
    truncated: meta.truncated,
    omittedCount: meta.omittedCount,
    resultChars: outcome.result.text.length,
    durationMs: outcome.durationMs,
    status: outcome.status,
    errorCode: outcome.errorCode
  }) as Parameters<CreateRunnerOptions["telemetry"]["recordToolCall"]>[0];
  opts.telemetry.recordToolCall(record);
}

function recordSubmitWithExtraTools(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  submitTool: string,
  toolCalls: PiToolCall[]
): void {
  opts.telemetry.event(definedRecord({
    stage: request.stage,
    level: "warn",
    message: "submit_with_extra_tools",
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    data: definedRecord({
      submitTool,
      ignoredTools: toolCalls.map((toolCall) => toolCall.name),
      count: toolCalls.length,
      candidateId: request.telemetryContext?.candidateId
    })
  }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
}

function recordModelCall(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  model: PiModelRef,
  message: PiAssistantMessage,
  meta: {
    callId: string;
    kind: "initial" | "tool-continuation" | "repair" | "finalize";
    attempt: number;
    cacheStatus: "hit" | "miss" | "disabled" | "write";
    promptText: string;
    durationMs: number;
    usage?: StoredProviderResponse["usage"];
    schemaValid?: boolean;
    status?: "ok" | "schema_invalid";
    errorCode?: CodeninjaErrorCode;
  }
): void {
  const outputText = stableJson(message.content);
  const usage = meta.usage;
  opts.telemetry.recordModelCall(definedRecord({
    callId: meta.callId,
    stage: request.stage,
    role: roleForStage(request.stage),
    model: model.id,
    provider: model.provider,
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    candidateId: request.telemetryContext?.candidateId,
    kind: meta.kind,
    attempt: meta.attempt,
    promptChars: meta.promptText.length,
    promptHash: sha256Hex(meta.promptText),
    outputChars: outputText.length,
    outputHash: sha256Hex(outputText),
    inputTokens: usage !== undefined ? usage.inputTokens : message.usage?.input,
    outputTokens: usage !== undefined ? usage.outputTokens : message.usage?.output,
    totalTokens: usage !== undefined ? usage.totalTokens : message.usage?.totalTokens,
    costUSD: usage !== undefined ? usage.costUSD : message.usage?.cost?.total,
    durationMs: meta.durationMs,
    cacheStatus: meta.cacheStatus,
    schemaValid: meta.schemaValid,
    stopReason: stopReason(message),
    status: meta.status ?? "ok",
    errorCode: meta.errorCode
  }) as Parameters<CreateRunnerOptions["telemetry"]["recordModelCall"]>[0]);
}

function recordErroredModelCall(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  model: PiModelRef,
  meta: {
    callId: string;
    kind: "initial" | "tool-continuation" | "repair" | "finalize";
    attempt: number;
    cacheStatus: "hit" | "miss" | "disabled" | "write";
    promptText: string;
    durationMs: number;
    status: "transient_error" | "auth_error" | "timeout" | "aborted";
    errorCode: CodeninjaErrorCode;
  }
): void {
  opts.telemetry.recordModelCall(definedRecord({
    callId: meta.callId,
    stage: request.stage,
    role: roleForStage(request.stage),
    model: model.id,
    provider: model.provider,
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    candidateId: request.telemetryContext?.candidateId,
    kind: meta.kind,
    attempt: meta.attempt,
    promptChars: meta.promptText.length,
    promptHash: sha256Hex(meta.promptText),
    outputChars: 0,
    outputHash: sha256Hex(""),
    durationMs: meta.durationMs,
    cacheStatus: meta.cacheStatus,
    stopReason: "error",
    status: meta.status,
    errorCode: meta.errorCode
  }) as Parameters<CreateRunnerOptions["telemetry"]["recordModelCall"]>[0]);
}

function schemaValidityForResponse(
  adapter: PiAiAdapter,
  request: LlmStructuredRequest<unknown>,
  tools: ToolDefinition[],
  message: PiAssistantMessage
): boolean | undefined {
  const submitTool = tools.find((tool) => tool.name === submitToolNameForStage(request.stage));
  if (!submitTool) {
    return undefined;
  }
  const submitCall = firstToolCall(message, submitTool.name);
  if (!submitCall) {
    return undefined;
  }
  try {
    adapter.validateToolCall([toolSpec(submitTool)], submitCall);
    return true;
  } catch {
    return false;
  }
}

function isCacheableProviderResponse(schemaValid: boolean | undefined, message: PiAssistantMessage): boolean {
  return schemaValid === true || stopReason(message) === "tool_calls";
}

function reportUsage(opts: CreateRunnerOptions, stage: ReviewStage, message: PiAssistantMessage): void {
  const usage: LlmCallUsage = { stage, providerCalls: 1 };
  if (message.usage?.input !== undefined) {
    usage.inputTokens = message.usage.input;
  }
  if (message.usage?.output !== undefined) {
    usage.outputTokens = message.usage.output;
  }
  if (message.usage?.totalTokens !== undefined) {
    usage.totalTokens = message.usage.totalTokens;
  }
  if (message.usage?.cost?.total !== undefined) {
    usage.costUSD = message.usage.cost.total;
  }
  opts.hooks.onUsage(usage);
}

function reportAttemptUsage(opts: CreateRunnerOptions, stage: ReviewStage): void {
  opts.hooks.onUsage({ stage, providerCalls: 1 });
}

function cacheEntry(stage: ReviewStage, message: PiAssistantMessage): StoredProviderResponse {
  return {
    cacheSchemaVersion: MODEL_CALL_CACHE_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    stage,
    message,
    finishReason: message.stopReason ?? stopReason(message),
    usage: definedRecord({
      inputTokens: message.usage?.input,
      outputTokens: message.usage?.output,
      totalTokens: message.usage?.totalTokens,
      costUSD: message.usage?.cost?.total
    }) as StoredProviderResponse["usage"]
  };
}

function stopReason(message: PiAssistantMessage): "submit" | "tool_calls" | "text" | "error" {
  if (message.stopReason === "error") {
    return "error";
  }
  if (message.content.some(isToolCall)) {
    return message.content.some((block) => isToolCall(block) && block.name.startsWith("submit_")) ? "submit" : "tool_calls";
  }
  return "text";
}

function errorStatus(cause: unknown): "transient_error" | "auth_error" | "aborted" {
  if (isAbortError(cause)) {
    return "aborted";
  }
  const status = errorHttpStatus(cause);
  if (status === 401 || status === 403) {
    return "auth_error";
  }
  return "transient_error";
}

function isRetryableProviderError(cause: unknown, attempt: number): boolean {
  if (isAbortError(cause)) {
    return false;
  }
  const status = errorHttpStatus(cause);
  if (status !== undefined) {
    return status === 429 || status >= 500;
  }
  return isLikelyNetworkError(cause) || attempt === 1;
}

function toLlmError(
  cause: unknown,
  status: "transient_error" | "auth_error" | "timeout" | "aborted",
  timedOut: boolean
): CodeninjaError {
  if (status === "auth_error") {
    return new CodeninjaError("llm_call_failed", "LLM provider authentication failed", {
      recoverable: false,
      context: { reason: "auth" },
      cause
    });
  }
  const reason = timedOut ? "timeout" : requestErrorReason(cause, status);
  const fatalProviderFailure = status === "transient_error" && reason === "transient_error";
  return new CodeninjaError("llm_call_failed", timedOut ? "LLM provider call timed out" : "LLM provider call failed", {
    recoverable: !fatalProviderFailure,
    context: { reason },
    cause
  });
}

function requestErrorReason(cause: unknown, status: "transient_error" | "auth_error" | "timeout" | "aborted"): string {
  const httpStatus = errorHttpStatus(cause);
  if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) {
    return "request_error";
  }
  return status;
}

function errorHttpStatus(cause: unknown): number | undefined {
  if (!cause || typeof cause !== "object") {
    return undefined;
  }
  const record = cause as Record<string, unknown>;
  const status = record.status ?? record.statusCode ?? record.code;
  return typeof status === "number" ? status : undefined;
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "AbortError" || cause.message.toLowerCase().includes("abort"));
}

function isLikelyNetworkError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") {
    return false;
  }
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" && /^(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR_)/.test(code);
}

function timeoutSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; cleanup(): void; timedOut(): boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = (): void => controller.abort(parent.reason);
  if (parent.aborted) {
    abortFromParent();
  } else {
    parent.addEventListener("abort", abortFromParent, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("timeout"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", abortFromParent);
    },
    timedOut: () => timedOut
  };
}

async function sleep(ms: number, signal: AbortSignal, timedOut: () => boolean = () => false): Promise<void> {
  if (signal.aborted) {
    throw taskAbortError(timedOut());
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(taskAbortError(timedOut()));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function retryDelayMs(cause: unknown, attempt: number): number {
  const jitterCap = Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
  const jitterDelay = Math.floor(Math.random() * jitterCap);
  const retryAfterDelay = retryAfterMs(cause);
  return retryAfterDelay !== undefined && retryAfterDelay > jitterDelay ? retryAfterDelay : jitterDelay;
}

function retryAfterMs(cause: unknown): number | undefined {
  const value = retryAfterHeader(cause);
  if (value === undefined) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

function retryAfterHeader(cause: unknown): string | undefined {
  if (!cause || typeof cause !== "object") {
    return undefined;
  }
  const record = cause as Record<string, unknown>;
  return headerValue(record.headers) ?? headerValue((record.response as Record<string, unknown> | undefined)?.headers);
}

function headerValue(headers: unknown): string | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  const maybeGet = (headers as { get?: unknown }).get;
  if (typeof maybeGet === "function") {
    const value = maybeGet.call(headers, "retry-after") ?? maybeGet.call(headers, "Retry-After");
    return typeof value === "string" ? value : undefined;
  }
  const record = headers as Record<string, unknown>;
  const value = record["retry-after"] ?? record["Retry-After"];
  return typeof value === "string" ? value : undefined;
}

function throwIfTaskAborted(signal: AbortSignal, timedOut: () => boolean): void {
  if (signal.aborted) {
    throw taskAbortError(timedOut());
  }
}

function taskAbortError(timedOut: boolean): CodeninjaError {
  return new CodeninjaError("llm_call_failed", timedOut ? "LLM model task timed out" : "LLM model task aborted", {
    recoverable: true,
    context: { reason: timedOut ? "timeout" : "aborted" }
  });
}

function toolSpec(tool: ToolDefinition): { name: string; description: string; parameters: ToolDefinition["parameters"] } {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  };
}

function toolArgsForRecord(args: Record<string, unknown>): ToolCallRecord["args"] {
  return definedRecord({
    path: typeof args.path === "string" ? args.path : undefined,
    symbolName: typeof args.symbolName === "string" ? args.symbolName : undefined,
    line: typeof args.line === "number" ? args.line : undefined,
    startLine: typeof args.startLine === "number" ? args.startLine : undefined,
    endLine: typeof args.endLine === "number" ? args.endLine : undefined,
    query: typeof args.query === "string" ? args.query : undefined,
    glob: typeof args.glob === "string" ? args.glob : undefined,
    source: sourceForRecord(args.source),
    contextMode: typeof args.contextMode === "string" ? args.contextMode : undefined
  }) as ToolCallRecord["args"];
}

function sourceForRecord(source: unknown): string | undefined {
  if (source && typeof source === "object" && typeof (source as { kind?: unknown }).kind === "string") {
    return (source as { kind: string }).kind;
  }
  return undefined;
}

function markTruncated(meta: ToolResultMeta | undefined): ToolResultMeta {
  return {
    ...(meta ?? defaultToolMeta()),
    degraded: true,
    truncated: true,
    degradationReason: meta?.degradationReason ?? "tool_result_budget"
  };
}

function defaultToolMeta(): ToolResultMeta {
  return { backend: "text", precision: "text", degraded: false };
}

function resolveRealModel(provider: string | undefined, model: string | undefined, authStorage?: PiAuthStorage): PiModelRef | undefined {
  const qualified = provider === undefined && model ? splitProviderQualifiedModel(model) : undefined;
  const resolvedProvider = provider ?? qualified?.provider;
  const resolvedModel = qualified?.model ?? model;

  if (resolvedProvider && resolvedModel) {
    try {
      const raw = (getModel as unknown as (provider: string, model: string) => unknown)(resolvedProvider, resolvedModel);
      if (!raw) {
        return undefined;
      }
      const auth = resolveProviderAuth(resolvedProvider, authStorage);
      return auth ? { provider: resolvedProvider, id: resolvedModel, raw, ...auth } : undefined;
    } catch {
      return undefined;
    }
  }

  if (resolvedProvider) {
    const auth = resolveProviderAuth(resolvedProvider, authStorage);
    if (!auth) {
      return undefined;
    }
    const models = getModels(resolvedProvider as KnownProvider);
    const first = models[0];
    return first ? { provider: resolvedProvider, id: first.id, raw: first, ...auth } : undefined;
  }

  for (const providerId of getProviders()) {
    const auth = resolveProviderAuth(providerId, authStorage);
    if (!auth) {
      continue;
    }
    const models = getModels(providerId);
    const match = resolvedModel ? models.find((candidate) => candidate.id === resolvedModel) : models[0];
    if (match) {
      return { provider: providerId, id: match.id, raw: match, ...auth };
    }
  }
  return undefined;
}

function splitProviderQualifiedModel(model: string): { provider: string; model: string } | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    return undefined;
  }
  const provider = model.slice(0, slash);
  if (!getProviders().includes(provider as KnownProvider)) {
    return undefined;
  }
  return { provider, model: model.slice(slash + 1) };
}

function resolveProviderAuth(provider: string, authStorage = createFileAuthStorage(getCodeninjaPaths())): Pick<PiModelRef, "apiKey" | "oauthProvider"> | undefined {
  const envApiKey = getEnvApiKey(provider);
  if (envApiKey) {
    registerSecret(envApiKey);
    return { apiKey: envApiKey };
  }
  const stored = authStorage.get(provider);
  if (!stored) {
    return undefined;
  }
  if (stored.type === "api_key") {
    return { apiKey: stored.apiKey };
  }
  return getOAuthProvider(provider) ? { oauthProvider: provider } : undefined;
}

async function resolveModelApiKey(model: PiModelRef, deps: RealPiAiAdapterDeps): Promise<string | undefined> {
  if (model.apiKey) {
    return model.apiKey;
  }
  if (!model.oauthProvider) {
    return undefined;
  }

  const authStorage = deps.authStorage ?? createFileAuthStorage(getCodeninjaPaths());
  const stored = authStorage.get(model.oauthProvider);
  if (!stored || stored.type !== "oauth") {
    return undefined;
  }

  const result = await (deps.getOAuthApiKey ?? getOAuthApiKey)(model.oauthProvider, {
    [model.oauthProvider]: stored.credentials
  });
  if (!result) {
    return undefined;
  }

  persistRefreshedOAuthCredentials(authStorage, model.oauthProvider, stored, result.newCredentials);
  registerSecret(result.apiKey);
  return result.apiKey;
}

function persistRefreshedOAuthCredentials(
  authStorage: PiAuthStorage,
  provider: string,
  stored: Extract<ProviderAuthEntry, { type: "oauth" }>,
  credentials: OAuthCredentials
): void {
  authStorage.set(provider, {
    type: "oauth",
    credentials,
    createdAt: stored.createdAt
  });
}

function stableJson(input: unknown): string {
  return JSON.stringify(sortJson(input));
}

function sortJson(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(sortJson);
  }
  if (input && typeof input === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      output[key] = sortJson((input as Record<string, unknown>)[key]);
    }
    return output;
  }
  return input;
}

function definedRecord<T extends Record<string, unknown>>(input: T): T {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output as T;
}
