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
import { registerSecret, stripCredentials, stripCredentialsWithSummary } from "../telemetry/redaction.js";
import { fenceUntrusted } from "../skills/prompt-builder.js";
import type { ReviewStage, ToolCallRecord, ToolResultMeta } from "../types.js";
import type { PiAuthStorage, ProviderAuthEntry } from "../provider/provider-services.js";
import { sha256Hex } from "../util/hashing.js";
import { CodeninjaError, type CodeninjaErrorCode } from "../util/errors.js";
import {
  roleForStage,
  type CreateRunnerOptions,
  type LlmCallUsage,
  type LlmSchemaRepairInput,
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

type ModelCallKind = "initial" | "tool-continuation" | "repair" | "finalize";

type ModelCallCacheStatus = "hit" | "miss" | "disabled" | "write";

type NormalizedUsage = {
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
const DEBUG_ARTIFACT_SCHEMA_VERSION = 1;
const MAX_DEBUG_ARTIFACT_CHARS = 1_500_000;
const RECORDED_PROVIDER_FAILURE = Symbol("recordedProviderFailure");

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
    throw new CodeninjaError("config_error", "no usable LLM model could be resolved; run `codeninja provider login <provider>` or configure --provider/--model", {
      context: {
        provider: opts.llmConfig.provider ?? null,
        model: opts.llmConfig.model ?? null,
        hint: "run `codeninja provider login <provider>` and `codeninja provider models --all` to inspect available authenticated models"
      }
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
      let finalizeSubmitRetryUsed = false;
      let forceFinalize = false;
      let budgetForceFinalize = false;
      const taskTimeout = timeoutSignal(opts.runSignal, request.timeoutMs);

      try {
        for (;;) {
          const activeTools = forceFinalize ? [submitTool] : allTools;
          const kind = forceFinalize ? schemaRepairUsed ? "repair" : "finalize" : messages.length === 1 ? "initial" : "tool-continuation";
          const toolChoice = forceFinalize || repositoryTools.length === 0
            ? { type: "tool" as const, name: submitTool.name }
            : "auto";
          let providerResult: ProviderCallResult;
          try {
            providerResult = await completeWithCache({
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
              taskTimedOut: taskTimeout.timedOut,
              budgetExempt: budgetForceFinalize
            });
          } catch (cause) {
            if (!forceFinalize && isBudgetExhaustedError(cause) && messages.length > 1) {
              forceFinalize = true;
              budgetForceFinalize = true;
              messages.push({
                role: "user",
                content: `LLM provider call budget is exhausted. Call ${submitTool.name} now with the best schema-valid result supported by the evidence already gathered. Do not request more repository tools.`,
                timestamp: 0
              });
              continue;
            }
            throw cause;
          }
          const message = providerResult.message;
          messages.push(message as unknown as ConversationMessage);

          const submitCalls = toolCallsNamed(message, submitTool.name);
          const submitCall = submitCalls[0];
          const toolCalls = toolCallsExcept(message, submitTool.name);
          const submitDisciplineError = submitResponseDisciplineError(request, submitTool.name, submitCalls);
          if (submitDisciplineError !== undefined) {
            queueSchemaRepair({
              opts,
              request,
              messages,
              submitToolName: submitTool.name,
              submitCalls,
              extraToolNames: toolCalls.map((toolCall) => toolCall.name),
              error: submitDisciplineError,
              schemaRepairUsed
            });
            schemaRepairUsed = true;
            forceFinalize = true;
            budgetForceFinalize = false;
            continue;
          }
          if (submitCall) {
            try {
              const validated = adapter.validateToolCall([toolSpec(submitTool)], submitCall);
              if (toolCalls.length > 0) {
                recordSubmitWithExtraTools(opts, request, submitTool.name, toolCalls);
              }
              return validated as T;
            } catch (cause) {
              queueSchemaRepair({
                opts,
                request,
                messages,
                submitToolName: submitTool.name,
                submitCalls,
                extraToolNames: toolCalls.map((toolCall) => toolCall.name),
                error: `The ${submitTool.name} arguments were schema-invalid: ${truncatePromptDiagnostic(cause instanceof Error ? cause.message : String(cause))}`,
                schemaRepairUsed,
                cause
              });
              schemaRepairUsed = true;
              forceFinalize = true;
              budgetForceFinalize = false;
              continue;
            }
          }

          if (forceFinalize) {
            if (!finalizeSubmitRetryUsed) {
              finalizeSubmitRetryUsed = true;
              recordFinalizeMissingSubmitRetry(opts, request, submitTool.name, kind, toolCalls);
              messages.push({
                role: "user",
                content: `The previous response did not call ${submitTool.name}. You must call ${submitTool.name} now with schema-valid arguments. Do not call repository tools, ask for more context, or answer in plain text. If there are no findings, submit empty arrays where the schema requires arrays.`,
                timestamp: 0
              });
              continue;
            }
            throw new CodeninjaError("llm_schema_invalid", `model did not call ${submitTool.name} during ${kind}`, {
              recoverable: true,
              context: { submitTool: submitTool.name, kind, unexpectedTools: toolCalls.map((toolCall) => toolCall.name) }
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
                content: [{ type: "text", text: fenceUntrusted(resultText, `tool-result-${safeFenceLabelPart(toolCall.name)}`) }],
                isError: outcome.result.isError === true,
                timestamp: 0
              });
            }
            messages.push(...toolResults);

            if (toolCallsUsed >= budget.maxToolCalls || investigationRounds >= budget.maxInvestigationRounds) {
              forceFinalize = true;
              budgetForceFinalize = false;
              messages.push({
                role: "user",
                content: `Tool budget is exhausted. Call ${submitTool.name} now with the best schema-valid result supported by the evidence already gathered.`,
                timestamp: 0
              });
            }
            continue;
          }

          if (!finalizeNudgeUsed) {
            finalizeNudgeUsed = true;
            messages.push({
              role: "user",
              content: `Continue reviewing with repository tools if useful, or call ${submitTool.name} with schema-valid arguments. Do not answer in plain text.`,
              timestamp: 0
            });
            continue;
          }
          forceFinalize = true;
          budgetForceFinalize = false;
          messages.push({
            role: "user",
            content: `Finish now by calling ${submitTool.name} with schema-valid arguments. Do not answer in plain text or call other tools.`,
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
  budgetExempt?: boolean;
}): Promise<ProviderCallResult> {
  const { opts, adapter, request, model, messages, tools, kind, toolChoice, providerLimit, nextModelCallId, taskSignal, taskTimedOut, budgetExempt } = input;
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
      const cachedResponse = scrubStoredProviderResponse(cached.response);
      const cachedFailure = providerFailureFromMessage(cachedResponse.message, false);
      const cachedSchemaValid = schemaValidityForResponse(adapter, request, tools, kind, cachedResponse.message);
      if (cachedFailure) {
        opts.telemetry.event({
          stage: request.stage,
          level: "warn",
          message: "model_call_cache_provider_error_miss",
          cacheStatus: "miss",
          data: { cacheKey, error: cachedFailure.message }
        });
      } else if (cachedSchemaValid === false) {
        opts.telemetry.event({
          stage: request.stage,
          level: "warn",
          message: "model_call_cache_schema_invalid_miss",
          cacheStatus: "miss",
          data: { cacheKey }
        });
      } else {
        const callId = nextModelCallId();
        writeModelCallRequestDebug(opts, request, model, {
          callId,
          kind,
          attempt: 1,
          cacheStatus: "hit",
          cacheKey,
          promptText,
          messages,
          tools,
          toolChoice
        });
        recordModelCall(opts, request, model, cachedResponse.message, {
          callId,
          kind,
          attempt: 1,
          cacheStatus: "hit",
          promptText,
          durationMs: 0,
          usage: cachedResponse.usage
        });
        return { source: "cache", message: cachedResponse.message, callId };
      }
    }
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
    throwIfTaskAborted(taskSignal, taskTimedOut);
    let estimatedTokens = 0;
    let reservationActive = false;
    if (budgetExempt !== true) {
      const checkpoint = opts.hooks.checkpoint(request.stage);
      if (checkpoint === "exhausted") {
        throw budgetExhaustedError(request.stage);
      }
      estimatedTokens = estimateProviderCallTokens(promptText);
      if (opts.hooks.reserve?.(request.stage, estimatedTokens) === "exhausted") {
        throw budgetExhaustedError(request.stage);
      }
      reservationActive = opts.hooks.reserve !== undefined;
    }
    const releaseReservation = (): void => {
      if (!reservationActive) {
        return;
      }
      reservationActive = false;
      opts.hooks.releaseReservation?.(request.stage, estimatedTokens);
    };

    const callId = nextModelCallId();
    const startedAt = Date.now();
    writeModelCallRequestDebug(opts, request, model, {
      callId,
      kind,
      attempt,
      cacheStatus: opts.cache ? "miss" : "disabled",
      cacheKey,
      promptText,
      messages,
      tools,
      toolChoice
    });
    try {
      recordModelCallEvent(opts, request, model, {
        callId,
        kind,
        attempt,
        promptText,
        message: "model_call_queued",
        toolNames: tools.map((tool) => tool.name)
      });
      const rawMessage = await providerLimit(() => {
        throwIfTaskAborted(taskSignal, taskTimedOut);
        recordModelCallEvent(opts, request, model, {
          callId,
          kind,
          attempt,
          promptText,
          message: "model_call_started",
          toolNames: tools.map((tool) => tool.name)
        });
        return awaitProviderCall(
          () => adapter.complete(
            model,
            { messages, tools: tools.map(providerToolSpec) },
            {
              signal: taskSignal,
              maxRetries: 0,
              reasoning: opts.llmConfig.reasoning ?? "high",
              toolChoice
            }
          ),
          taskSignal,
          taskTimedOut
        );
      });
      const message = scrubAssistantMessage(rawMessage);
      const durationMs = Date.now() - startedAt;
      const providerFailure = providerFailureFromMessage(message, taskTimedOut());
      if (providerFailure) {
        recordModelCall(opts, request, model, message, {
          callId,
          kind,
          attempt,
          cacheStatus: opts.cache ? "miss" : "disabled",
          promptText,
          durationMs,
          status: providerFailure.status,
          errorCode: "llm_call_failed",
          errorMessage: providerFailure.message
        });
        reportUsage(opts, request.stage, message);
        releaseReservation();
        lastError = providerFailure.cause;
        if (providerFailure.status === "transient_error" && isRetryableProviderError(providerFailure.cause, attempt) && attempt < MAX_PROVIDER_ATTEMPTS) {
          await sleep(retryDelayMs(providerFailure.cause, attempt), taskSignal, taskTimedOut);
          continue;
        }
        throw markRecordedProviderFailure(toLlmError(providerFailure.cause, providerFailure.status, taskTimedOut()));
      }
      const schemaValid = schemaValidityForResponse(adapter, request, tools, kind, message);
      const cacheable = Boolean(opts.cache && isCacheableProviderResponse(schemaValid, message, tools));
      const cacheStatus = cacheable ? "write" : opts.cache ? "miss" : "disabled";
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
      if (opts.cache && cacheable) {
        await opts.cache.put(cacheKey, cacheEntry(request.stage, message));
      }
      return { source: "provider", message, callId };
    } catch (cause) {
      if (isRecordedProviderFailure(cause)) {
        throw cause;
      }
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
        errorCode: "llm_call_failed",
        errorMessage: cause instanceof Error ? truncatePromptDiagnostic(cause.message) : truncatePromptDiagnostic(String(cause))
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
        const spec = providerToolSpec(tool);
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

function budgetExhaustedError(stage: ReviewStage): CodeninjaError {
  return new CodeninjaError("llm_call_failed", "LLM provider call budget exhausted", {
    recoverable: true,
    context: { reason: "budget_exhausted", stage }
  });
}

function isBudgetExhaustedError(cause: unknown): boolean {
  return cause instanceof CodeninjaError &&
    cause.code === "llm_call_failed" &&
    cause.context?.reason === "budget_exhausted";
}

function markRecordedProviderFailure(error: CodeninjaError): CodeninjaError {
  (error as CodeninjaError & { [RECORDED_PROVIDER_FAILURE]?: true })[RECORDED_PROVIDER_FAILURE] = true;
  return error;
}

function isRecordedProviderFailure(cause: unknown): boolean {
  return Boolean(cause && typeof cause === "object" && (cause as { [RECORDED_PROVIDER_FAILURE]?: true })[RECORDED_PROVIDER_FAILURE] === true);
}

function truncatePromptDiagnostic(input: string): string {
  const maxChars = 2_000;
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, maxChars).trimEnd()}\n[validation error truncated by codeninja]`;
}

function safeFenceLabelPart(input: string): string {
  return input.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "tool";
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
      return "auto";
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

function toolCallsNamed(message: PiAssistantMessage, name: string): PiToolCall[] {
  return message.content.filter((block): block is PiToolCall => isToolCall(block) && block.name === name);
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

  if (outcome.status === "rejected" && outcome.errorCode === "path_outside_repo") {
    opts.telemetry.event({
      stage: request.stage,
      level: "warn",
      message: "tool call rejected: path outside repository root (possible review manipulation)",
      ...(request.telemetryContext?.workerId !== undefined ? { workerId: request.telemetryContext.workerId } : {}),
      ...(request.telemetryContext?.packetId !== undefined ? { packetId: request.telemetryContext.packetId } : {}),
      data: {
        event: "tool_path_outside_repo",
        tool: toolCall.name,
        modelCallId,
        ...(request.telemetryContext?.candidateId !== undefined ? { candidateId: request.telemetryContext.candidateId } : {})
      }
    });
  }
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

function recordFinalizeMissingSubmitRetry(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  submitTool: string,
  kind: ModelCallKind,
  toolCalls: PiToolCall[]
): void {
  opts.telemetry.event(definedRecord({
    stage: request.stage,
    level: "warn",
    message: "finalize_missing_submit_retry",
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    data: definedRecord({
      submitTool,
      kind,
      unexpectedTools: toolCalls.map((toolCall) => toolCall.name),
      count: toolCalls.length,
      candidateId: request.telemetryContext?.candidateId
    })
  }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
}

function queueSchemaRepair(input: {
  opts: CreateRunnerOptions;
  request: LlmStructuredRequest<unknown>;
  messages: ConversationMessage[];
  submitToolName: string;
  submitCalls: PiToolCall[];
  extraToolNames: string[];
  error: string;
  schemaRepairUsed: boolean;
  cause?: unknown;
}): void {
  const error = truncatePromptDiagnostic(input.error);
  if (input.schemaRepairUsed) {
    throw new CodeninjaError("llm_schema_invalid", "model submit payload failed schema validation after repair", {
      recoverable: input.request.schemaRepair?.failAfterRepair === true ? false : true,
      context: { submitTool: input.submitToolName, error },
      cause: input.cause
    });
  }
  const repairInput: LlmSchemaRepairInput = {
    stage: input.request.stage,
    submitTool: input.submitToolName,
    error,
    submitCalls: input.submitCalls.map((call) => ({ id: call.id, arguments: call.arguments })),
    extraToolNames: input.extraToolNames
  };
  const content = input.request.schemaRepair?.buildPrompt(repairInput) ??
    `${error}. Call ${input.submitToolName} again with exactly one corrected schema-valid set of arguments.`;
  const replaceConversation = input.request.schemaRepair?.replaceConversation === true;
  const repairMessage = {
    role: "user",
    content,
    timestamp: 0
  };
  if (replaceConversation) {
    input.messages.splice(0, input.messages.length, repairMessage);
  } else {
    input.messages.push(repairMessage);
  }
  input.opts.telemetry.event(definedRecord({
    stage: input.request.stage,
    level: "warn",
    message: input.request.stage === 5 ? "planner_schema_repair_scheduled" : "schema_repair_scheduled",
    workerId: input.request.telemetryContext?.workerId,
    packetId: input.request.telemetryContext?.packetId,
    data: definedRecord({
      submitTool: input.submitToolName,
      invalidSubmitCallCount: input.submitCalls.length,
      extraToolNames: input.extraToolNames,
      repairPromptChars: content.length,
      replaceConversation,
      candidateId: input.request.telemetryContext?.candidateId,
      error
    })
  }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
}

function writeModelCallRequestDebug(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  model: PiModelRef,
  meta: {
    callId: string;
    kind: ModelCallKind;
    attempt: number;
    cacheStatus: ModelCallCacheStatus;
    cacheKey: string;
    promptText: string;
    messages: ConversationMessage[];
    tools: ToolDefinition[];
    toolChoice: ToolChoiceMode;
  }
): void {
  const schemaName = submitToolNameForStage(request.stage);
  writeDebugRecord(opts, request, "llm-calls", `${meta.callId}.request`, definedRecord({
    schemaVersion: DEBUG_ARTIFACT_SCHEMA_VERSION,
    artifactKind: "llm_call_request",
    callId: meta.callId,
    stage: request.stage,
    role: roleForStage(request.stage),
    kind: meta.kind,
    attempt: meta.attempt,
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    candidateId: request.telemetryContext?.candidateId,
    provider: {
      provider: model.provider,
      model: model.id,
      reasoning: opts.llmConfig.reasoning ?? "high"
    },
    cache: definedRecord({
      enabled: Boolean(opts.cache),
      status: meta.cacheStatus,
      key: opts.cache ? meta.cacheKey : undefined
    }),
    request: {
      runnerMessageVersion: RUNNER_MESSAGE_VERSION,
      promptTemplateVersion: request.templateVersion,
      schemaName,
      schemaVersion: SCHEMA_VERSIONS[schemaName],
      toolBudget: request.toolBudget ?? NO_REPOSITORY_TOOL_BUDGET,
      toolChoice: meta.toolChoice,
      promptChars: meta.promptText.length,
      promptHash: sha256Hex(meta.promptText),
      messageCount: meta.messages.length,
      messages: meta.messages,
      tools: toolDebugSpecs(meta.tools)
    }
  }));
}

function writeModelCallResponseDebug(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  id: string,
  record: Omit<LlmCallRecordForDebug, "runId">,
  payload: { response?: PiAssistantMessage; error?: { message: string }; usage?: Record<string, unknown> }
): void {
  writeDebugRecord(opts, request, "llm-calls", id, {
    schemaVersion: DEBUG_ARTIFACT_SCHEMA_VERSION,
    artifactKind: "llm_call_response",
    ...record,
    ...payload
  });
}

type LlmCallRecordForDebug = Parameters<CreateRunnerOptions["telemetry"]["recordModelCall"]>[0];

function writeDebugRecord(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  kind: "llm-calls" | "tool-calls",
  id: string,
  artifact: unknown
): void {
  const { value, summary } = stripCredentialsWithSummary(artifact);
  const redactedRecord = appendRedactionSummary(value, summary);
  const finalRecord = fitDebugArtifact(opts, request, kind, id, redactedRecord);
  void opts.telemetry.writeDebug(kind, id, finalRecord).catch((cause) => {
    opts.telemetry.event(definedRecord({
      stage: request.stage,
      level: "warn",
      message: "debug_artifact_write_failed",
      workerId: request.telemetryContext?.workerId,
      packetId: request.telemetryContext?.packetId,
      data: definedRecord({
        kind,
        id,
        candidateId: request.telemetryContext?.candidateId,
        error: cause instanceof Error ? stripCredentials(cause.message) : stripCredentials(String(cause))
      })
    }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
  });
}

function appendRedactionSummary(value: unknown, summary: { applied: boolean; markerCounts: Record<string, number> }): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>), redaction: summary };
  }
  return { value, redaction: summary };
}

function fitDebugArtifact(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  kind: "llm-calls" | "tool-calls",
  id: string,
  artifact: unknown
): unknown {
  const serialized = stableJson(artifact);
  if (serialized.length <= MAX_DEBUG_ARTIFACT_CHARS) {
    return artifact;
  }
  opts.telemetry.event(definedRecord({
    stage: request.stage,
    level: "warn",
    message: "debug_artifact_truncated",
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    data: definedRecord({
      kind,
      id,
      originalChars: serialized.length,
      maxChars: MAX_DEBUG_ARTIFACT_CHARS,
      candidateId: request.telemetryContext?.candidateId
    })
  }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
  return {
    schemaVersion: DEBUG_ARTIFACT_SCHEMA_VERSION,
    artifactKind: "truncated_debug_artifact",
    stage: request.stage,
    id,
    kind,
    originalChars: serialized.length,
    maxChars: MAX_DEBUG_ARTIFACT_CHARS,
    preview: serialized.slice(0, Math.max(0, MAX_DEBUG_ARTIFACT_CHARS - 256)),
    redaction: valueRedactionSummary(artifact)
  };
}

function valueRedactionSummary(artifact: unknown): { applied: boolean; markerCounts: Record<string, number> } {
  if (artifact && typeof artifact === "object" && !Array.isArray(artifact)) {
    const redaction = (artifact as Record<string, unknown>).redaction;
    if (redaction && typeof redaction === "object") {
      return redaction as { applied: boolean; markerCounts: Record<string, number> };
    }
  }
  return { applied: false, markerCounts: {} };
}

function toolDebugSpecs(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools
    .map((tool) => {
      const localSpec = toolSpec(tool);
      const providerSpec = providerToolSpec(tool);
      const localParametersText = stableJson(localSpec.parameters);
      const providerParametersText = stableJson(providerSpec.parameters);
      return {
        name: providerSpec.name,
        description: providerSpec.description,
        localParametersHash: sha256Hex(localParametersText),
        providerParametersHash: sha256Hex(providerParametersText),
        providerParameters: providerSpec.parameters
      };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function recordModelCallEvent(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  model: PiModelRef,
  meta: {
    callId: string;
    kind: ModelCallKind;
    attempt: number;
    promptText: string;
    message: "model_call_queued" | "model_call_started";
    toolNames: string[];
  }
): void {
  opts.telemetry.event(definedRecord({
    stage: request.stage,
    level: "debug",
    message: meta.message,
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    data: definedRecord({
      callId: meta.callId,
      role: roleForStage(request.stage),
      provider: model.provider,
      model: model.id,
      kind: meta.kind,
      attempt: meta.attempt,
      promptChars: meta.promptText.length,
      promptHash: sha256Hex(meta.promptText),
      toolCount: meta.toolNames.length,
      toolNames: meta.toolNames,
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
    kind: ModelCallKind;
    attempt: number;
    cacheStatus: ModelCallCacheStatus;
    promptText: string;
    durationMs: number;
    usage?: StoredProviderResponse["usage"];
    schemaValid?: boolean;
    status?: "ok" | "schema_invalid" | "transient_error" | "auth_error" | "timeout" | "aborted";
    errorCode?: CodeninjaErrorCode;
    errorMessage?: string;
  }
): void {
  const outputText = stableJson(message.content);
  const usage = normalizeUsage(meta.usage ?? message.usage);
  const record = definedRecord({
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
    inputTokens: usage?.inputTokens,
    uncachedInputTokens: usage?.uncachedInputTokens,
    cacheReadTokens: usage?.cacheReadTokens,
    cacheWriteTokens: usage?.cacheWriteTokens,
    billableInputTokens: usage?.billableInputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    costUSD: usage?.costUSD,
    inputCostUSD: usage?.inputCostUSD,
    outputCostUSD: usage?.outputCostUSD,
    cacheReadCostUSD: usage?.cacheReadCostUSD,
    cacheWriteCostUSD: usage?.cacheWriteCostUSD,
    durationMs: meta.durationMs,
    cacheStatus: meta.cacheStatus,
    schemaValid: meta.schemaValid,
    stopReason: stopReason(message),
    status: meta.status ?? "ok",
    errorCode: meta.errorCode,
    errorMessage: meta.errorMessage ?? providerErrorMessage(message)
  }) as Parameters<CreateRunnerOptions["telemetry"]["recordModelCall"]>[0];
  opts.telemetry.recordModelCall(record);
  const usageDebug = usageDebugPayload(model, message.usage, usage);
  writeModelCallResponseDebug(opts, request, meta.callId, record, { response: message, usage: usageDebug });
  writeModelCallResponseDebug(opts, request, `${meta.callId}.response`, record, { response: message, usage: usageDebug });
}

function recordErroredModelCall(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  model: PiModelRef,
  meta: {
    callId: string;
    kind: ModelCallKind;
    attempt: number;
    cacheStatus: ModelCallCacheStatus;
    promptText: string;
    durationMs: number;
    status: "transient_error" | "auth_error" | "timeout" | "aborted";
    errorCode: CodeninjaErrorCode;
    errorMessage?: string;
  }
): void {
  const record = definedRecord({
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
    errorCode: meta.errorCode,
    errorMessage: meta.errorMessage
  }) as Parameters<CreateRunnerOptions["telemetry"]["recordModelCall"]>[0];
  opts.telemetry.recordModelCall(record);
  writeModelCallResponseDebug(opts, request, meta.callId, record, {
    error: { message: meta.errorMessage ?? "LLM provider call failed" }
  });
  writeModelCallResponseDebug(opts, request, `${meta.callId}.response`, record, {
    error: { message: meta.errorMessage ?? "LLM provider call failed" }
  });
}

function schemaValidityForResponse(
  adapter: PiAiAdapter,
  request: LlmStructuredRequest<unknown>,
  tools: ToolDefinition[],
  kind: ModelCallKind,
  message: PiAssistantMessage
): boolean | undefined {
  const submitTool = tools.find((tool) => tool.name === submitToolNameForStage(request.stage));
  if (!submitTool) {
    return undefined;
  }
  const submitCalls = toolCallsNamed(message, submitTool.name);
  const disciplineError = submitResponseDisciplineError(request, submitTool.name, submitCalls);
  if (disciplineError !== undefined) {
    return false;
  }
  const submitCall = submitCalls[0];
  if (!submitCall) {
    return kind === "finalize" || kind === "repair" ? false : undefined;
  }
  try {
    adapter.validateToolCall([toolSpec(submitTool)], submitCall);
    return true;
  } catch {
    return false;
  }
}

function submitResponseDisciplineError(
  request: LlmStructuredRequest<unknown>,
  submitToolName: string,
  submitCalls: PiToolCall[]
): string | undefined {
  if (request.stage !== 5) {
    return undefined;
  }
  if (submitCalls.length === 1) {
    return undefined;
  }
  return `Stage 5 planner responses must call ${submitToolName} exactly once; received ${submitCalls.length} ${submitToolName} call${submitCalls.length === 1 ? "" : "s"}.`;
}

function isCacheableProviderResponse(schemaValid: boolean | undefined, message: PiAssistantMessage, tools: ToolDefinition[]): boolean {
  if (schemaValid === false) {
    return false;
  }
  if (schemaValid === true) {
    return true;
  }
  const toolCalls = message.content.filter((block): block is PiToolCall => isToolCall(block));
  return stopReason(message) === "tool_calls" &&
    toolCalls.length > 0 &&
    toolCalls.every((toolCall) => tools.some((tool) => tool.name === toolCall.name));
}

function reportUsage(opts: CreateRunnerOptions, stage: ReviewStage, message: PiAssistantMessage): void {
  opts.hooks.onUsage(definedRecord({
    stage,
    providerCalls: 1,
    ...normalizeUsage(message.usage)
  }) as LlmCallUsage);
}

function reportAttemptUsage(opts: CreateRunnerOptions, stage: ReviewStage): void {
  opts.hooks.onUsage({ stage, providerCalls: 1 });
}

function cacheEntry(stage: ReviewStage, message: PiAssistantMessage): StoredProviderResponse {
  const usage = normalizeUsage(message.usage);
  return {
    cacheSchemaVersion: MODEL_CALL_CACHE_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    stage,
    message,
    finishReason: message.stopReason ?? stopReason(message),
    usage: definedRecord(usage ?? {}) as StoredProviderResponse["usage"]
  };
}

function normalizeUsage(input: unknown): NormalizedUsage | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const cost = record.cost && typeof record.cost === "object" ? record.cost as Record<string, unknown> : {};
  const cacheReadTokens = firstNumber(
    record.cacheReadTokens,
    record.cacheRead,
    record.cache_read,
    record.cache_read_input_tokens,
    record.cachedTokens
  );
  const cacheWriteTokens = firstNumber(
    record.cacheWriteTokens,
    record.cacheWrite,
    record.cache_write,
    record.cache_creation_input_tokens,
    record.cacheCreation
  );
  const storedInputTokens = firstNumber(record.inputTokens);
  const hasExplicitCacheTokens = cacheReadTokens !== undefined || cacheWriteTokens !== undefined;
  const uncachedInputTokens = firstNumber(record.uncachedInputTokens, record.input) ??
    (hasExplicitCacheTokens ? undefined : storedInputTokens);
  const computedInputTokens = sumDefined(uncachedInputTokens, cacheReadTokens, cacheWriteTokens);
  const inputTokens = computedInputTokens ?? storedInputTokens;
  const outputTokens = firstNumber(record.outputTokens, record.output);
  const computedTotalTokens = sumDefined(inputTokens, outputTokens);
  const totalTokens = firstNumber(record.totalTokens) ?? computedTotalTokens;
  const billableInputTokens = firstNumber(record.billableInputTokens) ?? inputTokens;
  const inputCostUSD = firstNumber(record.inputCostUSD, cost.input);
  const outputCostUSD = firstNumber(record.outputCostUSD, cost.output);
  const cacheReadCostUSD = firstNumber(record.cacheReadCostUSD, cost.cacheRead);
  const cacheWriteCostUSD = firstNumber(record.cacheWriteCostUSD, cost.cacheWrite);
  const costUSD = firstNumber(record.costUSD, cost.total) ??
    sumDefined(inputCostUSD, outputCostUSD, cacheReadCostUSD, cacheWriteCostUSD);
  const normalized = definedRecord({
    inputTokens,
    uncachedInputTokens,
    cacheReadTokens: cacheReadTokens ?? (inputTokens !== undefined ? 0 : undefined),
    cacheWriteTokens: cacheWriteTokens ?? (inputTokens !== undefined ? 0 : undefined),
    billableInputTokens,
    outputTokens,
    totalTokens,
    costUSD,
    inputCostUSD,
    outputCostUSD,
    cacheReadCostUSD,
    cacheWriteCostUSD
  }) as NormalizedUsage;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function usageDebugPayload(model: PiModelRef, rawUsage: unknown, normalized: NormalizedUsage | undefined): Record<string, unknown> {
  return definedRecord({
    usageProvider: model.provider,
    usageRaw: rawUsage,
    usageNormalized: normalized
  });
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  let sawValue = false;
  let total = 0;
  for (const value of values) {
    if (value === undefined) {
      continue;
    }
    sawValue = true;
    total += value;
  }
  return sawValue ? total : undefined;
}

function scrubAssistantMessage(message: PiAssistantMessage): PiAssistantMessage {
  return stripCredentials(message) as PiAssistantMessage;
}

function scrubStoredProviderResponse(response: StoredProviderResponse): StoredProviderResponse {
  return stripCredentials(response) as StoredProviderResponse;
}

type ProviderFailure = {
  status: "transient_error" | "auth_error" | "timeout" | "aborted";
  cause: Error & { status?: number };
  message: string;
};

function providerFailureFromMessage(message: PiAssistantMessage, timedOut: boolean): ProviderFailure | undefined {
  if (message.stopReason !== "error" && message.stopReason !== "aborted") {
    return undefined;
  }
  const cause = providerMessageError(message);
  const status = message.stopReason === "aborted" ? timedOut ? "timeout" : "aborted" : errorStatus(cause);
  return {
    status,
    cause,
    message: cause.message
  };
}

function providerMessageError(message: PiAssistantMessage): Error & { status?: number } {
  const text = providerErrorMessage(message) ?? `LLM provider returned stopReason ${message.stopReason ?? "error"}`;
  const error = new Error(text) as Error & { status?: number };
  const status = parseHttpStatus(text);
  if (status !== undefined) {
    error.status = status;
  }
  return error;
}

function providerErrorMessage(message: PiAssistantMessage): string | undefined {
  return typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0
    ? truncatePromptDiagnostic(message.errorMessage.trim())
    : undefined;
}

function stopReason(message: PiAssistantMessage): "submit" | "tool_calls" | "text" | "error" {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
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
  if (errorMessageMatches(cause, /\b(auth|authentication|unauthorized|forbidden|api key|permission denied)\b/i)) {
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
  return new CodeninjaError("llm_call_failed", timedOut ? "LLM provider call timed out" : "LLM provider call failed", {
    recoverable: true,
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
  if (typeof status === "number") {
    return status;
  }
  if (typeof status === "string") {
    return parseHttpStatus(status);
  }
  return undefined;
}

function parseHttpStatus(input: string): number | undefined {
  const match = /\b([45]\d\d)\b/.exec(input);
  if (!match) {
    return undefined;
  }
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : undefined;
}

function errorMessageMatches(cause: unknown, pattern: RegExp): boolean {
  return cause instanceof Error && pattern.test(cause.message);
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

async function awaitProviderCall<T>(call: () => Promise<T>, signal: AbortSignal, timedOut: () => boolean): Promise<T> {
  if (signal.aborted) {
    throw taskAbortError(timedOut());
  }
  let cleanup = (): void => undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(taskAbortError(timedOut()));
    cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([call(), abort]);
  } finally {
    cleanup();
  }
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

function providerToolSpec(tool: ToolDefinition): { name: string; description: string; parameters: ToolDefinition["parameters"] } {
  return {
    name: tool.name,
    description: tool.description,
    parameters: jsonSchemaDraft202012(tool.parameters) as ToolDefinition["parameters"]
  };
}

function jsonSchemaDraft202012(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(jsonSchemaDraft202012);
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    output[key] = jsonSchemaDraft202012(value);
  }

  if (Array.isArray(output.items)) {
    output.prefixItems = output.items;
    output.items = output.additionalItems === false ? false : jsonSchemaDraft202012(output.additionalItems);
  }
  delete output.additionalItems;
  if (output.items === undefined) {
    delete output.items;
  }
  return output;
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
