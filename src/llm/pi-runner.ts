import {
  complete,
  completeSimple,
  getEnvApiKey,
  getModel,
  getModels,
  getProviders,
  validateToolCall,
  type Api,
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
import { filterDeprecatedProviderModels, isDeprecatedProviderModel } from "../provider/model-policy.js";
import { getCodegeniePaths } from "../config/paths.js";
import { registerSecret, stripCredentials, stripCredentialsWithSummary } from "../telemetry/redaction.js";
import { fenceUntrusted } from "../skills/prompt-builder.js";
import type { ReviewStage, ToolBudget, ToolBudgetState, ToolCallRecord, ToolResultMeta } from "../types.js";
import type { PiAuthStorage, ProviderAuthEntry } from "../provider/provider-services.js";
import { sha256Hex } from "../util/hashing.js";
import { CodegenieError, type CodegenieErrorCode } from "../util/errors.js";
import {
  roleForStage,
  type CreateRunnerOptions,
  type LlmCallUsage,
  type LlmSchemaInvalidSubmitRecoveryInput,
  type LlmSchemaRepairInput,
  type LlmRunner,
  type LlmStructuredRequest,
  type LlmToolResultSummary,
  type ModelCallCacheMissReason,
  type PiAiAdapter,
  type PiAssistantMessage,
  type PiModelRef,
  type PiToolCall,
  type StoredProviderResponse,
  type ToolDefinition,
  type ToolExecutionResult,
  type ToolResultCache,
  type ToolResultCacheHitKind,
  type ToolResultCacheStatus
} from "./llm-runner.js";
import { MODEL_CALL_CACHE_SCHEMA_VERSION, buildModelCallCacheKey } from "./model-call-cache.js";
import { SCHEMA_VERSIONS, submitToolNameForStage } from "./schemas.js";
import {
  classifyStage7SchemaInvalid,
  stage7CompactSchemaRepairPrompt,
  stage7SubmitPayloadKind,
  stage7SubmitRepairDecision,
  type Stage7SchemaInvalidKind,
  type Stage7SubmitRepairDecision
} from "./stage7-submit-repair.js";

type ConversationMessage = Record<string, unknown>;

type ProviderCallResult =
  | { source: "cache"; message: PiAssistantMessage; callId: string }
  | { source: "provider"; message: PiAssistantMessage; callId: string };

type ProviderLimit = <T>(fn: () => Promise<T>) => Promise<T>;

type ToolChoiceMode = "auto" | { type: "tool"; name: string };

type ModelCallCacheDiagnostics = {
  keyPrefix: string;
  requestHash: string;
  runFingerprintHash?: string;
  runnerMessageVersion: string;
  stage: ReviewStage;
  kind: ModelCallKind;
  templateVersion: string;
  schemaName: string;
  schemaVersion: number;
  toolChoiceHash: string;
  toolBudgetHash: string;
  messageHash: string;
  messageCount: number;
  toolSpecHash: string;
  toolCount: number;
  promptChars: number;
  providerPromptCache: ProviderPromptCacheDebug;
};

type ToolRunOutcome = {
  result: ToolExecutionResult;
  status: ToolCallRecord["status"];
  errorCode?: CodegenieErrorCode;
  rejectionReason?: ToolRejectionReason;
  budgetState?: ToolBudgetState;
  args: Record<string, unknown>;
  durationMs: number;
  cacheStatus: ToolResultCacheStatus;
  backendExecuted: boolean;
  cacheHitKind?: ToolResultCacheHitKind;
  cacheEvictedEntries?: number;
};

type ToolRejectionReason =
  | "tool_result_budget_exhausted"
  | "tool_call_budget_exhausted"
  | "investigation_round_budget_exhausted"
  | "unknown_tool";

type ToolBudgetExtensionState = {
  toolCallsUsed: number;
  resultCharsUsed: number;
};

type ToolBudgetExtensionDecision =
  | {
      status: "granted";
      triggerReason: Exclude<ToolRejectionReason, "unknown_tool">;
      resultCharLimit: number;
      remainingResultChars: number;
    }
  | {
      status: "denied";
      triggerReason: Exclude<ToolRejectionReason, "unknown_tool">;
      denyReason: string;
    };

type ModelCallKind = "initial" | "tool-continuation" | "repair" | "finalize";

type ModelCallCacheStatus = "hit" | "miss" | "disabled" | "write";

type ProviderPromptCacheOptions = {
  strategy: "pi-session";
  sessionId: string;
  cacheRetention: "short";
};

type ProviderPromptCacheDebug = {
  strategy: ProviderPromptCacheOptions["strategy"];
  sessionId: string;
  cacheRetention: ProviderPromptCacheOptions["cacheRetention"];
  scope: "run-stage";
  explicitCacheBlocks: false;
};

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
const RUNNER_MESSAGE_VERSION = "pi-runner-loop-v3";
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
    throw new CodegenieError("config_error", "no usable LLM model could be resolved; run `codegenie provider login <provider>` or configure --provider/--model", {
      context: {
        provider: opts.llmConfig.provider ?? null,
        model: opts.llmConfig.model ?? null,
        hint: "run `codegenie provider login <provider>` and `codegenie provider models --all` to inspect available authenticated models"
      }
    });
  }

  let modelCallSeq = 0;
  const nextModelCallId = (): string => `mc-${String(++modelCallSeq).padStart(6, "0")}`;
  const recordedPromptCacheStages = new Set<ReviewStage>();

  return {
    runStructured: async <T>(request: LlmStructuredRequest<T>): Promise<T> => {
      const submitTool = buildSubmitTool(request);
      const repositoryTools = request.tools ?? [];
      const allTools = [...repositoryTools, submitTool];
      const budget = request.toolBudget ?? NO_REPOSITORY_TOOL_BUDGET;
      const providerPromptCache = providerPromptCacheOptions(opts.telemetry.runId, request.stage);
      recordProviderPromptCacheStrategy(opts, request, providerPromptCache, recordedPromptCacheStages);
      const messages: ConversationMessage[] = [
        { role: "user", content: request.prompt, timestamp: 0 }
      ];
      let toolCallsUsed = 0;
      let investigationRounds = 0;
      let resultCharsUsed = 0;
      const sourceExtensionState: ToolBudgetExtensionState = { toolCallsUsed: 0, resultCharsUsed: 0 };
      let schemaRepairUsed = false;
      let finalizeNudgeUsed = false;
      let finalizeSubmitRetryUsed = false;
      let forceFinalize = false;
      let budgetForceFinalize = false;
      let candidateDrafted = false;
      const toolResultSummaries: LlmToolResultSummary[] = [];
      const taskTimeout = timeoutSignal(opts.runSignal, request.timeoutMs);

      try {
        for (;;) {
          const activeTools = forceFinalize ? [submitTool] : allTools;
          const kind = forceFinalize ? schemaRepairUsed ? "repair" : "finalize" : messages.length === 1 ? "initial" : "tool-continuation";
          const finalizeMode = forceFinalize ? "full" : undefined;
          const finalizeTarget = forceFinalize ? candidateDrafted ? "candidate_or_unknown" : "no_findings" : undefined;
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
              providerPromptCache,
              budgetExempt: budgetForceFinalize,
              finalizeMode,
              finalizeTarget
            });
          } catch (cause) {
            if (!forceFinalize && isBudgetExhaustedError(cause) && messages.length > 1) {
              forceFinalize = true;
              budgetForceFinalize = true;
              queueForcedFinalizePrompt({
                opts,
                request,
                messages,
                submitToolName: submitTool.name,
                reason: "budget_exhausted",
                candidateDrafted
              });
              continue;
            }
            throw cause;
          }
          const message = providerResult.message;
          messages.push(message as unknown as ConversationMessage);

          const candidateDraftedBeforeSubmit = candidateDrafted;
          const submitCalls = toolCallsNamed(message, submitTool.name);
          const submitCall = submitCalls[0];
          const toolCalls = toolCallsExcept(message, submitTool.name);
          candidateDrafted = candidateDrafted || submitCalls.some(submitCallHasFindings);
          const submitDisciplineError = submitResponseDisciplineError(request, submitTool.name, submitCalls);
          if (submitDisciplineError !== undefined) {
            if (request.stage === 5) {
              request.schemaRepair?.recoverInvalidSubmit?.(schemaRepairInput({
                request,
                submitToolName: submitTool.name,
                error: submitDisciplineError,
                submitCalls,
                extraToolNames: toolCalls.map((toolCall) => toolCall.name),
                schemaRepairUsed
              }));
            }
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
              if (request.stage === 7 && schemaRepairUsed) {
                if (candidateDrafted && !submitCallHasFindings(submitCall)) {
                  const error = "Stage 7 candidate schema repair returned no findings; codegenie will not silently downgrade malformed findings to no-findings.";
                  recordStage7SchemaRepairFailed(opts, request, submitTool.name, "unsafe_candidate_like_payload", error);
                  throw new CodegenieError("llm_schema_invalid", error, {
                    recoverable: true,
                    context: { submitTool: submitTool.name, error }
                  });
                }
                recordStage7SchemaRepairRecovered(opts, request, "schema_valid_after_retry");
              }
              if (toolCalls.length > 0) {
                recordSubmitWithExtraTools(opts, request, submitTool.name, toolCalls);
              }
              return validated as T;
            } catch (cause) {
              const stage7Repair = stage7SubmitRepairDecision(request, submitCall, cause, candidateDraftedBeforeSubmit);
              if (stage7Repair !== undefined) {
                recordStage7SchemaRepairAttempted(opts, request, submitTool.name, submitCalls, toolCalls, stage7Repair.classification, cause);
                if (stage7Repair.recovered !== undefined) {
                  recordStage7SchemaCleanupAttempted(opts, request, submitTool.name, stage7Repair);
                  try {
                    const recoveredCallId = `${submitCall.id || submitTool.name}-stage7-recovered`;
                    const validated = adapter.validateToolCall([toolSpec(submitTool)], {
                      type: "toolCall",
                      id: recoveredCallId,
                      name: submitTool.name,
                      arguments: stage7Repair.recovered
                    });
                    recordStage7SchemaCleanupRecovered(opts, request, stage7Repair, recoveredCallId);
                    recordStage7SchemaRepairRecovered(opts, request, stage7Repair.classification);
                    return validated as T;
                  } catch (recoveryCause) {
                    recordStage7SchemaCleanupRejected(opts, request, submitTool.name, stage7Repair, recoveryCause);
                  }
                } else if (stage7Repair.cleanupKind !== undefined) {
                  recordStage7SchemaCleanupAttempted(opts, request, submitTool.name, stage7Repair);
                  recordStage7SchemaCleanupRejected(opts, request, submitTool.name, stage7Repair, cause);
                }
              }
              const submitError = `The ${submitTool.name} arguments were schema-invalid: ${truncatePromptDiagnostic(cause instanceof Error ? cause.message : String(cause))}`;
              const repairInput = schemaRepairInput({
                request,
                submitToolName: submitTool.name,
                error: submitError,
                submitCalls,
                extraToolNames: toolCalls.map((toolCall) => toolCall.name),
                schemaRepairUsed
              });
              const recovered = tryRecoverInvalidSubmit({
                opts,
                adapter,
                request,
                submitTool,
                repairInput,
                cause
              });
              if (recovered !== undefined) {
                return recovered as T;
              }
              queueSchemaRepair({
                opts,
                request,
                messages,
                submitToolName: submitTool.name,
                submitCalls,
                extraToolNames: toolCalls.map((toolCall) => toolCall.name),
                error: submitError,
                schemaRepairUsed,
                ...(stage7Repair?.classification !== undefined ? { repairClassification: stage7Repair.classification } : {}),
                ...(stage7Repair?.compactRepair === true ? { replaceConversationOverride: true } : {}),
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
                content: `The previous response did not call ${submitTool.name}. You must call ${submitTool.name} now with schema-valid arguments. Do not call repository tools, ask for more context, or answer in plain text. ${noResultInstruction(request)}`,
                timestamp: 0
              });
              continue;
            }
            throw new CodegenieError("llm_schema_invalid", `model did not call ${submitTool.name} during ${kind}`, {
              recoverable: true,
              context: { submitTool: submitTool.name, kind, unexpectedTools: toolCalls.map((toolCall) => toolCall.name) }
            });
          }

          if (toolCalls.length > 0 && !forceFinalize) {
            investigationRounds += 1;
            const toolResults: ConversationMessage[] = [];
            for (const toolCall of toolCalls) {
              const tool = repositoryTools.find((candidate) => candidate.name === toolCall.name);
              const budgetState = toolBudgetState({
                toolCallsUsed,
                investigationRounds,
                resultCharsUsed,
                budget,
                toolName: toolCall.name,
                extension: sourceExtensionState
              });
              const baseResultCharLimit = budgetState.toolResultCharLimit ?? budgetState.remainingResultChars;
              const localBudgetReason = localBudgetRejectionReason({
                resultCharLimit: baseResultCharLimit,
                toolCallsUsed,
                investigationRounds,
                budget
              });
              const extensionDecision = localBudgetReason === undefined
                ? undefined
                : decideToolBudgetExtension({
                    opts,
                    request,
                    toolCall,
                    toolFound: tool !== undefined,
                    budget,
                    extension: sourceExtensionState,
                    triggerReason: localBudgetReason
                  });
              if (extensionDecision?.status === "denied" && shouldRecordToolBudgetExtensionDenied(extensionDecision)) {
                recordToolBudgetExtensionDenied(opts, request, providerResult.callId, toolCall, extensionDecision, budgetState);
              }
              const remainingResultChars = extensionDecision?.status === "granted"
                ? extensionDecision.resultCharLimit
                : baseResultCharLimit;
              const outcome =
                localBudgetReason !== undefined && extensionDecision?.status !== "granted"
                  ? rejectedToolOutcome(toolCall, localBudgetReason, toolRejectionMessage(localBudgetReason), budgetState)
                  : tool
                    ? await executeToolCall(adapter, repositoryTools, tool, toolCall, taskTimeout.signal, taskTimeout.timedOut, opts.toolResultCache)
                    : rejectedToolOutcome(toolCall, "unknown_tool", `unknown tool ${toolCall.name}`, budgetState);

              outcome.budgetState ??= budgetState;
              if (extensionDecision?.status === "granted") {
                outcome.budgetState = {
                  ...outcome.budgetState,
                  toolResultCharLimit: extensionDecision.resultCharLimit,
                  sourceExtensionActive: true
                };
              }

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
              if (extensionDecision?.status === "granted") {
                sourceExtensionState.toolCallsUsed += 1;
                sourceExtensionState.resultCharsUsed += resultText.length;
                recordToolBudgetExtensionGranted(opts, request, providerResult.callId, toolCall, extensionDecision, resultText.length);
              }
              recordToolCall(opts, request, providerResult.callId, toolCall, outcome);
              toolResultSummaries.push(summarizeToolResult(toolCall, outcome, resultText));
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

            if (toolCallsUsed >= effectiveToolCallLimit(budget) || investigationRounds >= budget.maxInvestigationRounds) {
              forceFinalize = true;
              budgetForceFinalize = false;
              queueForcedFinalizePrompt({
                opts,
                request,
                messages,
                submitToolName: submitTool.name,
                candidateDrafted,
                reason: "tool_budget_exhausted"
              });
            } else {
              const nudge = request.finalization?.buildPostToolNudge?.({
                submitToolName: submitTool.name,
                toolCallsUsed,
                investigationRounds,
                resultCharsUsed,
                lastToolResults: toolResultSummaries.slice(-toolCalls.length)
              });
              if (nudge !== undefined && nudge.trim().length > 0) {
                messages.push({ role: "user", content: nudge.trim(), timestamp: 0 });
                opts.telemetry.event(definedRecord({
                  stage: request.stage,
                  level: "debug",
                  message: "post_tool_close_nudge",
                  workerId: request.telemetryContext?.workerId,
                  packetId: request.telemetryContext?.packetId,
                  data: definedRecord({
                    investigationRounds,
                    toolCallsUsed,
                    resultCharsUsed,
                    nudgeChars: nudge.trim().length,
                    candidateId: request.telemetryContext?.candidateId
                  })
                }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
              }
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
          queueForcedFinalizePrompt({
            opts,
            request,
            messages,
            submitToolName: submitTool.name,
            candidateDrafted,
            reason: "plain_text_or_empty_response"
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

function queueForcedFinalizePrompt(input: {
  opts: CreateRunnerOptions;
  request: LlmStructuredRequest<unknown>;
  messages: ConversationMessage[];
  submitToolName: string;
  reason: ForcedFinalizeReason;
  candidateDrafted: boolean;
}): void {
  const content = input.reason === "budget_exhausted"
    ? `LLM provider call budget is exhausted. Call ${input.submitToolName} now with the best schema-valid result supported by the evidence already gathered. Do not request more repository tools. ${noResultInstruction(input.request)}`
    : input.reason === "tool_budget_exhausted"
      ? `Tool budget is exhausted. Call ${input.submitToolName} now with the best schema-valid result supported by the evidence already gathered. ${noResultInstruction(input.request)}`
      : `Finish now by calling ${input.submitToolName} with schema-valid arguments. Do not answer in plain text or call other tools. ${noResultInstruction(input.request)}`;
  input.messages.push({ role: "user", content, timestamp: 0 });
  recordFinalizeStart(
    input.opts,
    input.request,
    "full",
    input.candidateDrafted ? "candidate_or_unknown" : "no_findings",
    input.reason,
    content.length
  );
}

function noResultInstruction(request: LlmStructuredRequest<unknown>): string {
  return request.finalization?.noResultInstruction ??
    "If there is no concrete result to report, submit the smallest schema-valid empty or negative result supported by the evidence.";
}

function recordFinalizeStart(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  mode: "full",
  target: "no_findings" | "candidate_or_unknown",
  reason: ForcedFinalizeReason,
  promptChars: number
): void {
  opts.telemetry.event(definedRecord({
    stage: request.stage,
    level: "debug",
    message: "full_finalize_started",
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    data: definedRecord({
      mode,
      target,
      reason,
      promptChars,
      candidateId: request.telemetryContext?.candidateId
    })
  }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
}

type ForcedFinalizeReason = "budget_exhausted" | "tool_budget_exhausted" | "plain_text_or_empty_response";

function providerPromptCacheOptions(runId: string, stage: ReviewStage): ProviderPromptCacheOptions {
  return {
    strategy: "pi-session",
    sessionId: `codegenie-${safePromptCacheSessionPart(runId)}-stage-${stage}`,
    cacheRetention: "short"
  };
}

function providerPromptCacheDebug(options: ProviderPromptCacheOptions): ProviderPromptCacheDebug {
  return {
    strategy: options.strategy,
    sessionId: options.sessionId,
    cacheRetention: options.cacheRetention,
    scope: "run-stage",
    explicitCacheBlocks: false
  };
}

function safePromptCacheSessionPart(input: string): string {
  return input.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "run";
}

function recordProviderPromptCacheStrategy(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  options: ProviderPromptCacheOptions,
  recordedStages: Set<ReviewStage>
): void {
  if (recordedStages.has(request.stage)) {
    return;
  }
  recordedStages.add(request.stage);
  opts.telemetry.event(definedRecord({
    stage: request.stage,
    level: "debug",
    message: "provider_prompt_cache_strategy",
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    data: definedRecord({
      ...providerPromptCacheDebug(options),
      sessionIdHash: sha256Hex(options.sessionId),
      note: "Pi session-based prompt cache hint; codegenie does not emit provider-specific explicit cache-control blocks"
    })
  }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
}

function submitCallHasFindings(toolCall: PiToolCall): boolean {
  const findings = toolCall.arguments.findings;
  return Array.isArray(findings) && findings.length > 0;
}

function summarizeToolResult(toolCall: PiToolCall, outcome: ToolRunOutcome, resultText: string): LlmToolResultSummary {
  const meta = outcome.result.meta;
  return definedRecord({
    id: toolCall.id || safeFenceLabelPart(toolCall.name),
    tool: toolCall.name,
    target: toolTargetSummary(toolCall),
    status: outcome.status,
    resultChars: resultText.length,
    preview: firstMeaningfulLine(resultText),
    errorCode: outcome.errorCode,
    rejectionReason: outcome.rejectionReason,
    degraded: meta?.degraded,
    degradationReason: meta?.degradationReason,
    truncated: meta?.truncated,
    lookupStatus: meta?.lookupStatus,
    deliveryStatus: meta?.deliveryStatus,
    recovery: meta?.recovery
  }) as LlmToolResultSummary;
}

function toolTargetSummary(toolCall: PiToolCall): string {
  const args = stripCredentials(toolCall.arguments) as Record<string, unknown>;
  const parts: string[] = [];
  const path = typeof args.path === "string" ? args.path : undefined;
  const pathGlob = typeof args.pathGlob === "string" ? args.pathGlob : undefined;
  const symbolName = typeof args.symbolName === "string" ? args.symbolName : undefined;
  const query = typeof args.query === "string" ? args.query : undefined;
  const glob = typeof args.glob === "string" ? args.glob : undefined;
  if (path) {
    parts.push(`path=${path}`);
  }
  if (pathGlob) {
    parts.push(`pathGlob=${pathGlob}`);
  }
  if (symbolName) {
    parts.push(`symbol=${symbolName}`);
  }
  if (typeof args.line === "number") {
    parts.push(`line=${args.line}`);
  }
  if (typeof args.startLine === "number" || typeof args.endLine === "number") {
    parts.push(`lines=${String(args.startLine ?? "?")}-${String(args.endLine ?? "?")}`);
  }
  if (query) {
    parts.push(`query=${truncateDiagnosticPart(query, 80)}`);
  }
  if (glob) {
    parts.push(`glob=${glob}`);
  }
  return parts.length > 0 ? parts.join(" ") : stableJson(args).slice(0, 200);
}

function firstMeaningfulLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("```") || trimmed.startsWith("The following block is")) {
      continue;
    }
    return truncateDiagnosticPart(trimmed, 240);
  }
  return undefined;
}

function truncateDiagnosticPart(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
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
  providerPromptCache: ProviderPromptCacheOptions;
  budgetExempt?: boolean;
  finalizeMode?: "compact" | "full" | undefined;
  finalizeTarget?: "no_findings" | "candidate_or_unknown" | undefined;
}): Promise<ProviderCallResult> {
  const {
    opts,
    adapter,
    request,
    model,
    messages,
    tools,
    kind,
    toolChoice,
    providerLimit,
    nextModelCallId,
    taskSignal,
    taskTimedOut,
    providerPromptCache,
    budgetExempt,
    finalizeMode,
    finalizeTarget
  } = input;
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
    finalizeMode,
    finalizeTarget,
    toolChoice,
    messages,
    tools
  });
  const promptText = stableJson(canonicalRequest);
  const cacheKey = buildModelCallCacheKey(canonicalRequest);
  const cacheDiagnostics = modelCallCacheDiagnostics(canonicalRequest, cacheKey, promptText.length, providerPromptCache);

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
          data: { ...cacheDiagnostics, missReason: "cached_provider_error", error: cachedFailure.message }
        });
      } else if (cachedSchemaValid === false) {
        opts.telemetry.event({
          stage: request.stage,
          level: "warn",
          message: "model_call_cache_schema_invalid_miss",
          cacheStatus: "miss",
          data: { ...cacheDiagnostics, missReason: "cached_schema_invalid" }
        });
      } else {
        const callId = nextModelCallId();
        writeModelCallRequestDebug(opts, request, model, {
          callId,
          kind,
          attempt: 1,
          cacheStatus: "hit",
          cacheKey,
          cacheDiagnostics,
          promptText,
          messages,
          tools,
          toolChoice,
          providerPromptCache,
          finalizeMode,
          finalizeTarget
        });
        recordModelCall(opts, request, model, cachedResponse.message, {
          callId,
          kind,
          finalizeMode,
          finalizeTarget,
          attempt: 1,
          cacheStatus: "hit",
          promptText,
          durationMs: 0,
          usage: cachedResponse.usage
        });
        return { source: "cache", message: cachedResponse.message, callId };
      }
    } else {
      emitModelCallCacheDiagnostic(opts, request, cached.reason, cacheDiagnostics);
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
      cacheDiagnostics,
      promptText,
      messages,
      tools,
      toolChoice,
      providerPromptCache,
      finalizeMode,
      finalizeTarget
    });
    try {
      recordModelCallEvent(opts, request, model, {
        callId,
        kind,
        finalizeMode,
        finalizeTarget,
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
          finalizeMode,
          finalizeTarget,
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
              toolChoice,
              sessionId: providerPromptCache.sessionId,
              cacheRetention: providerPromptCache.cacheRetention
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
        const retry = classifyProviderRetry(providerFailure.cause, attempt);
        recordModelCall(opts, request, model, message, {
          callId,
          kind,
          finalizeMode,
          finalizeTarget,
          attempt,
          cacheStatus: opts.cache ? "miss" : "disabled",
          promptText,
          durationMs,
          status: providerFailure.status,
          errorCode: "llm_call_failed",
          errorMessage: providerFailure.message,
          retryable: retry.retryable,
          retryReason: retry.reason,
          maxAttempts: MAX_PROVIDER_ATTEMPTS,
          retryExhausted: retry.retryable && attempt >= MAX_PROVIDER_ATTEMPTS
        });
        releaseReservation();
        reportUsage(opts, request.stage, message);
        lastError = providerFailure.cause;
        if (providerFailure.status === "transient_error" && retry.retryable && attempt < MAX_PROVIDER_ATTEMPTS) {
          const delayMs = retryDelayMs(providerFailure.cause, attempt);
          recordProviderRetryEvent(opts, request, {
            callId,
            attempt,
            maxAttempts: MAX_PROVIDER_ATTEMPTS,
            reason: retry.reason,
            nextDelayMs: delayMs
          });
          await sleep(delayMs, taskSignal, taskTimedOut);
          continue;
        }
        if (providerFailure.status === "transient_error" && retry.retryable) {
          recordProviderRetryExhaustedEvent(opts, request, {
            callId,
            attempt,
            maxAttempts: MAX_PROVIDER_ATTEMPTS,
            reason: retry.reason
          });
        }
        throw markRecordedProviderFailure(toLlmError(providerFailure.cause, providerFailure.status, taskTimedOut()));
      }
      const schemaValid = schemaValidityForResponse(adapter, request, tools, kind, message);
      const cacheable = Boolean(opts.cache && isCacheableProviderResponse(schemaValid, message, tools));
      releaseReservation();
      reportUsage(opts, request.stage, message);
      const cacheStatus = await modelCallCacheWriteStatus(opts, cacheKey, request.stage, message, cacheable);
      const modelCallMeta = definedRecord({
        callId,
        kind,
        finalizeMode,
        finalizeTarget,
        attempt,
        cacheStatus,
        promptText,
        durationMs,
        schemaValid
      }) as {
        callId: string;
        kind: "initial" | "tool-continuation" | "repair" | "finalize";
        finalizeMode?: "compact" | "full" | undefined;
        finalizeTarget?: "no_findings" | "candidate_or_unknown" | undefined;
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
      }) as typeof modelCallMeta & { status?: "ok" | "schema_invalid"; errorCode?: CodegenieErrorCode });
      return { source: "provider", message, callId };
    } catch (cause) {
      if (isRecordedProviderFailure(cause)) {
        throw cause;
      }
      releaseReservation();
      reportAttemptUsage(opts, request.stage);
      lastError = cause;
      const status = taskTimedOut() ? "timeout" : errorStatus(cause);
      const retry = classifyProviderRetry(cause, attempt);
      recordErroredModelCall(opts, request, model, {
        callId,
        kind,
        finalizeMode,
        finalizeTarget,
        attempt,
        cacheStatus: opts.cache ? "miss" : "disabled",
        promptText,
        durationMs: Date.now() - startedAt,
        status,
        errorCode: "llm_call_failed",
        errorMessage: cause instanceof Error ? truncatePromptDiagnostic(cause.message) : truncatePromptDiagnostic(String(cause)),
        retryable: retry.retryable,
        retryReason: retry.reason,
        maxAttempts: MAX_PROVIDER_ATTEMPTS,
        retryExhausted: retry.retryable && attempt >= MAX_PROVIDER_ATTEMPTS
      });
      if (status === "transient_error" && retry.retryable && attempt < MAX_PROVIDER_ATTEMPTS) {
        const delayMs = retryDelayMs(cause, attempt);
        recordProviderRetryEvent(opts, request, {
          callId,
          attempt,
          maxAttempts: MAX_PROVIDER_ATTEMPTS,
          reason: retry.reason,
          nextDelayMs: delayMs
        });
        await sleep(delayMs, taskSignal, taskTimedOut);
        continue;
      }
      if (status === "transient_error" && retry.retryable) {
        recordProviderRetryExhaustedEvent(opts, request, {
          callId,
          attempt,
          maxAttempts: MAX_PROVIDER_ATTEMPTS,
          reason: retry.reason
        });
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
    execute: async () => ({ text: "submit tool is handled by codegenie" })
  };
}

async function modelCallCacheWriteStatus(
  opts: CreateRunnerOptions,
  cacheKey: string,
  stage: ReviewStage,
  message: PiAssistantMessage,
  cacheable: boolean
): Promise<ModelCallCacheStatus> {
  if (!opts.cache) {
    return "disabled";
  }
  if (!cacheable) {
    return "miss";
  }
  try {
    const result = await opts.cache.put(cacheKey, cacheEntry(stage, message));
    return result.status;
  } catch (cause) {
    const error = cause instanceof Error ? stripCredentials(cause.message) : stripCredentials(String(cause));
    opts.logger.warn({
      runId: opts.telemetry.runId,
      stage,
      event: "model_call_cache_write_failed",
      message: "failed to write model-call cache entry",
      data: { error }
    });
    opts.telemetry.event({
      stage,
      level: "warn",
      message: "model_call_cache_write_failed",
      cacheStatus: "miss",
      data: { error }
    });
    return "miss";
  }
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
  finalizeMode?: "compact" | "full" | undefined;
  finalizeTarget?: "no_findings" | "candidate_or_unknown" | undefined;
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
    finalizeMode: input.finalizeMode,
    finalizeTarget: input.finalizeTarget,
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

function budgetExhaustedError(stage: ReviewStage): CodegenieError {
  return new CodegenieError("llm_call_failed", "LLM provider call budget exhausted", {
    recoverable: true,
    context: { reason: "budget_exhausted", stage }
  });
}

function isBudgetExhaustedError(cause: unknown): boolean {
  return cause instanceof CodegenieError &&
    cause.code === "llm_call_failed" &&
    cause.context?.reason === "budget_exhausted";
}

function markRecordedProviderFailure(error: CodegenieError): CodegenieError {
  (error as CodegenieError & { [RECORDED_PROVIDER_FAILURE]?: true })[RECORDED_PROVIDER_FAILURE] = true;
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
  return `${input.slice(0, maxChars).trimEnd()}\n[validation error truncated by codegenie]`;
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
  taskTimedOut: () => boolean,
  toolResultCache?: ToolResultCache
): Promise<ToolRunOutcome> {
  const startedAt = Date.now();
  try {
    throwIfTaskAborted(taskSignal, taskTimedOut);
    try {
      const args = adapter.validateToolCall(tools.map(toolSpec), toolCall) as Record<string, unknown>;
      try {
        const cacheLookup = toolResultCache === undefined
          ? {
              result: await tool.execute(args, taskSignal),
              status: "disabled" as const,
              backendExecuted: true
            }
          : await toolResultCache.execute({
              toolName: tool.name,
              args,
              signal: taskSignal,
              run: () => tool.execute(args, taskSignal)
            });
        const result = cacheLookup.result;
        return {
          result,
          status: result.isError ? result.errorCode === "path_outside_repo" ? "rejected" : "error" : "ok",
          ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
          args,
          durationMs: Date.now() - startedAt,
          cacheStatus: cacheLookup.status,
          backendExecuted: cacheLookup.backendExecuted,
          ...(cacheLookup.hitKind !== undefined ? { cacheHitKind: cacheLookup.hitKind } : {}),
          ...(cacheLookup.evictedEntries !== undefined ? { cacheEvictedEntries: cacheLookup.evictedEntries } : {})
        };
      } catch (cause) {
        if (taskSignal.aborted && isAbortError(cause)) {
          throw taskAbortError(taskTimedOut());
        }
        return toolExecutionErrorOutcome(cause, args, Date.now() - startedAt, true, "miss");
      }
    } catch (cause) {
      if (taskSignal.aborted && cause instanceof CodegenieError && cause.code === "llm_call_failed") {
        throw cause;
      }
      if (taskSignal.aborted && isAbortError(cause)) {
        throw taskAbortError(taskTimedOut());
      }
      return toolExecutionErrorOutcome(cause, toolCall.arguments, Date.now() - startedAt, false, "disabled");
    }
  } catch (cause) {
    if (taskSignal.aborted && cause instanceof CodegenieError && cause.code === "llm_call_failed") {
      throw cause;
    }
    return toolExecutionErrorOutcome(cause, toolCall.arguments, Date.now() - startedAt, false, "disabled");
  }
}

function toolExecutionErrorOutcome(
  cause: unknown,
  args: Record<string, unknown>,
  durationMs: number,
  backendExecuted: boolean,
  cacheStatus: ToolResultCacheStatus
): ToolRunOutcome {
  if (cause instanceof CodegenieError) {
    return {
      result: {
        text: `tool error: ${cause.code}: ${cause.message}`,
        isError: true,
        meta: { backend: "text", precision: "text", degraded: true, degradationReason: cause.code }
      },
      status: cause.code === "path_outside_repo" ? "rejected" : "error",
      errorCode: cause.code,
      args,
      durationMs,
      cacheStatus,
      backendExecuted
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
    args,
    durationMs,
    cacheStatus,
    backendExecuted
  };
}

function rejectedToolOutcome(
  toolCall: PiToolCall,
  reasonCode: ToolRejectionReason,
  message: string,
  budgetState: ToolBudgetState
): ToolRunOutcome {
  return {
    result: {
      text: `tool rejected: ${message}`,
      isError: true,
      meta: { backend: "text", precision: "text", degraded: true, degradationReason: reasonCode }
    },
    status: "rejected",
    rejectionReason: reasonCode,
    budgetState,
    args: toolCall.arguments,
    durationMs: 0,
    cacheStatus: "disabled",
    backendExecuted: false
  };
}

function localBudgetRejectionReason(input: {
  resultCharLimit: number;
  toolCallsUsed: number;
  investigationRounds: number;
  budget: {
    maxToolCalls: number;
    maxInvestigationRounds: number;
  };
}): Exclude<ToolRejectionReason, "unknown_tool"> | undefined {
  if (input.resultCharLimit <= 0) {
    return "tool_result_budget_exhausted";
  }
  if (input.toolCallsUsed >= input.budget.maxToolCalls) {
    return "tool_call_budget_exhausted";
  }
  if (input.investigationRounds > input.budget.maxInvestigationRounds) {
    return "investigation_round_budget_exhausted";
  }
  return undefined;
}

function toolRejectionMessage(reason: Exclude<ToolRejectionReason, "unknown_tool">): string {
  switch (reason) {
    case "tool_result_budget_exhausted":
      return "tool result character budget exhausted";
    case "tool_call_budget_exhausted":
      return "tool call budget exhausted";
    case "investigation_round_budget_exhausted":
      return "investigation round budget exhausted";
  }
}

function decideToolBudgetExtension(input: {
  opts: CreateRunnerOptions;
  request: LlmStructuredRequest<unknown>;
  toolCall: PiToolCall;
  toolFound: boolean;
  budget: ToolBudget;
  extension: ToolBudgetExtensionState;
  triggerReason: Exclude<ToolRejectionReason, "unknown_tool">;
}): ToolBudgetExtensionDecision {
  if (input.triggerReason === "investigation_round_budget_exhausted") {
    return { status: "denied", triggerReason: input.triggerReason, denyReason: "round_budget_exhausted" };
  }
  if (!input.toolFound) {
    return { status: "denied", triggerReason: input.triggerReason, denyReason: "unknown_tool" };
  }
  const allowance = input.budget.sourceExtension;
  if (allowance === undefined || allowance.maxToolCalls <= 0 || allowance.maxResultChars <= 0) {
    return { status: "denied", triggerReason: input.triggerReason, denyReason: "no_source_extension_budget" };
  }
  if (unsafePathLikeArgument(input.toolCall)) {
    return { status: "denied", triggerReason: input.triggerReason, denyReason: "unsafe_path_arg" };
  }
  if (!isExactSourceExtensionTool(input.toolCall)) {
    return { status: "denied", triggerReason: input.triggerReason, denyReason: "not_exact_source_tool" };
  }
  if (input.extension.toolCallsUsed >= allowance.maxToolCalls) {
    return { status: "denied", triggerReason: input.triggerReason, denyReason: "source_extension_call_budget_exhausted" };
  }
  const remainingResultChars = Math.max(0, allowance.maxResultChars - input.extension.resultCharsUsed);
  if (remainingResultChars <= 0) {
    return { status: "denied", triggerReason: input.triggerReason, denyReason: "source_extension_result_budget_exhausted" };
  }
  if (input.opts.hooks.checkpoint(input.request.stage) !== "ok") {
    return { status: "denied", triggerReason: input.triggerReason, denyReason: "global_budget_exhausted" };
  }
  const resultCharLimit = input.budget.maxSingleToolResultChars === undefined
    ? remainingResultChars
    : Math.min(remainingResultChars, input.budget.maxSingleToolResultChars);
  return {
    status: "granted",
    triggerReason: input.triggerReason,
    resultCharLimit,
    remainingResultChars
  };
}

function shouldRecordToolBudgetExtensionDenied(decision: Extract<ToolBudgetExtensionDecision, { status: "denied" }>): boolean {
  return decision.denyReason !== "no_source_extension_budget";
}

function isExactSourceExtensionTool(toolCall: PiToolCall): boolean {
  const args = toolCall.arguments;
  switch (toolCall.name) {
    case "read_range":
      return safeRepoRelativePath(args.path) && finiteNumber(args.startLine) && finiteNumber(args.endLine);
    case "read_symbol": {
      const symbolName = nonEmptyString(args.symbolName);
      const line = finiteNumber(args.line);
      return safeRepoRelativePath(args.path) && symbolName !== line;
    }
    case "find_definition":
      return nonEmptyString(args.symbolName) && (args.pathGlob === undefined || safeRepoRelativePath(args.pathGlob));
    case "read_diff_blocks": {
      const packetId = nonEmptyString(args.packetId);
      const path = safeRepoRelativePath(args.path);
      return packetId !== path;
    }
    default:
      return false;
  }
}

function unsafePathLikeArgument(toolCall: PiToolCall): boolean {
  const args = toolCall.arguments;
  switch (toolCall.name) {
    case "read_range":
    case "read_symbol":
      return nonEmptyString(args.path) && !safeRepoRelativePath(args.path);
    case "find_definition":
      return args.pathGlob !== undefined && nonEmptyString(args.pathGlob) && !safeRepoRelativePath(args.pathGlob);
    case "read_diff_blocks":
      return nonEmptyString(args.path) && !safeRepoRelativePath(args.path);
    default:
      return false;
  }
}

function nonEmptyString(input: unknown): input is string {
  return typeof input === "string" && input.trim().length > 0;
}

function safeRepoRelativePath(input: unknown): input is string {
  if (!nonEmptyString(input) || input.includes("\0") || input.startsWith("/") || input.startsWith("//") || input.includes("\\")) {
    return false;
  }
  const parts = input.split("/").filter((part) => part.length > 0 && part !== ".");
  return parts.length > 0 && !parts.some((part) => part === "..") && parts[0] !== ".git";
}

function finiteNumber(input: unknown): input is number {
  return typeof input === "number" && Number.isFinite(input);
}

function effectiveToolCallLimit(budget: { maxToolCalls: number; sourceExtension?: { maxToolCalls: number } }): number {
  return budget.maxToolCalls + Math.max(0, budget.sourceExtension?.maxToolCalls ?? 0);
}

function toolBudgetState(input: {
  toolCallsUsed: number;
  investigationRounds: number;
  resultCharsUsed: number;
  budget: {
    maxToolCalls: number;
    maxInvestigationRounds: number;
    maxResultChars: number;
    maxSingleToolResultChars?: number;
    reservedSourceResultChars?: number;
    sourceExtension?: {
      maxToolCalls: number;
      maxResultChars: number;
    };
  };
  toolName: string;
  extension?: ToolBudgetExtensionState;
}): ToolBudgetState {
  const remainingResultChars = Math.max(0, input.budget.maxResultChars - input.resultCharsUsed);
  const reservedSourceResultChars = input.budget.reservedSourceResultChars ?? 0;
  const sourceTool = isSourceReadTool(input.toolName);
  const budgetCeilingForTool = sourceTool
    ? input.budget.maxResultChars
    : Math.max(0, input.budget.maxResultChars - reservedSourceResultChars);
  const remainingForTool = Math.max(0, Math.min(remainingResultChars, budgetCeilingForTool - input.resultCharsUsed));
  const toolResultCharLimit =
    input.budget.maxSingleToolResultChars === undefined
      ? remainingForTool
      : Math.min(remainingForTool, input.budget.maxSingleToolResultChars);
  return {
    toolCallsUsed: input.toolCallsUsed,
    maxToolCalls: input.budget.maxToolCalls,
    investigationRoundsUsed: input.investigationRounds,
    maxInvestigationRounds: input.budget.maxInvestigationRounds,
    resultCharsUsed: input.resultCharsUsed,
    maxResultChars: input.budget.maxResultChars,
    remainingResultChars,
    ...(input.budget.maxSingleToolResultChars !== undefined ? { maxSingleToolResultChars: input.budget.maxSingleToolResultChars } : {}),
    ...(input.budget.reservedSourceResultChars !== undefined ? { reservedSourceResultChars: input.budget.reservedSourceResultChars } : {}),
    toolResultCharLimit,
    ...(input.budget.sourceExtension !== undefined
      ? {
          sourceExtensionCallsUsed: input.extension?.toolCallsUsed ?? 0,
          sourceExtensionMaxCalls: input.budget.sourceExtension.maxToolCalls,
          sourceExtensionResultCharsUsed: input.extension?.resultCharsUsed ?? 0,
          sourceExtensionMaxResultChars: input.budget.sourceExtension.maxResultChars,
          sourceExtensionRemainingResultChars: Math.max(0, input.budget.sourceExtension.maxResultChars - (input.extension?.resultCharsUsed ?? 0))
        }
      : {})
  };
}

function isSourceReadTool(toolName: string): boolean {
  return toolName === "read_symbol" || toolName === "read_range" || toolName === "find_definition" || toolName === "read_diff_blocks";
}

function fitToolResultText(text: string, remainingChars: number): string {
  if (text.length <= remainingChars) {
    return text;
  }
  if (remainingChars <= 0) {
    return "";
  }
  const marker = "\n[tool result truncated by codegenie tool budget]";
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
    lookupStatus: meta.lookupStatus,
    deliveryStatus: meta.deliveryStatus,
    recovery: meta.recovery,
    budgetState: outcome.budgetState,
    cacheStatus: outcome.cacheStatus,
    backendExecuted: outcome.backendExecuted,
    cacheHitKind: outcome.cacheHitKind,
    cacheEvictedEntries: outcome.cacheEvictedEntries,
    resultChars: outcome.result.text.length,
    durationMs: outcome.durationMs,
    status: outcome.status,
    errorCode: outcome.errorCode
  }) as Parameters<CreateRunnerOptions["telemetry"]["recordToolCall"]>[0];
  opts.telemetry.recordToolCall(record);
  writeToolCallDebug(opts, request, modelCallId, toolCall, outcome, record);

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
  if (outcome.status === "rejected" && outcome.rejectionReason !== undefined) {
    opts.telemetry.event(definedRecord({
      stage: request.stage,
      level: "warn",
      message: "tool_call_rejected",
      workerId: request.telemetryContext?.workerId,
      packetId: request.telemetryContext?.packetId,
      data: definedRecord({
        tool: toolCall.name,
        modelCallId,
        reason: outcome.rejectionReason,
        candidateId: request.telemetryContext?.candidateId,
        budgetState: outcome.budgetState
      })
    }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
  }
}

function recordToolBudgetExtensionGranted(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  modelCallId: string,
  toolCall: PiToolCall,
  decision: Extract<ToolBudgetExtensionDecision, { status: "granted" }>,
  resultChars: number
): void {
  opts.telemetry.event(definedRecord({
    stage: request.stage,
    level: "info",
    message: "tool_budget_extension_granted",
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    data: definedRecord({
      tool: toolCall.name,
      modelCallId,
      triggerReason: decision.triggerReason,
      resultChars,
      resultCharLimit: decision.resultCharLimit,
      remainingResultCharsBeforeCall: decision.remainingResultChars,
      candidateId: request.telemetryContext?.candidateId
    })
  }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
}

function recordToolBudgetExtensionDenied(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  modelCallId: string,
  toolCall: PiToolCall,
  decision: Extract<ToolBudgetExtensionDecision, { status: "denied" }>,
  budgetState: ToolBudgetState
): void {
  opts.telemetry.event(definedRecord({
    stage: request.stage,
    level: "debug",
    message: "tool_budget_extension_denied",
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    data: definedRecord({
      tool: toolCall.name,
      modelCallId,
      triggerReason: decision.triggerReason,
      denyReason: decision.denyReason,
      candidateId: request.telemetryContext?.candidateId,
      budgetState
    })
  }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
}

function writeToolCallDebug(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  modelCallId: string,
  toolCall: PiToolCall,
  outcome: ToolRunOutcome,
  record: Omit<ToolCallRecord, "runId" | "toolCallId" | "timestamp">
): void {
  const id = `${modelCallId}.${toolCall.id || safeFenceLabelPart(toolCall.name)}`;
  writeDebugRecord(opts, request, "tool-calls", id, {
    schemaVersion: DEBUG_ARTIFACT_SCHEMA_VERSION,
    artifactKind: "tool_call",
    stage: request.stage,
    role: roleForStage(request.stage),
    modelCallId,
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    candidateId: request.telemetryContext?.candidateId,
    toolCall: {
      id: toolCall.id,
      name: toolCall.name,
      arguments: stripCredentials(toolCall.arguments)
    },
    outcome: {
      status: outcome.status,
      errorCode: outcome.errorCode,
      rejectionReason: outcome.rejectionReason,
      degradationReason: record.degradationReason,
      lookupStatus: record.lookupStatus,
      deliveryStatus: record.deliveryStatus,
      recovery: record.recovery,
      resultChars: record.resultChars,
      cacheStatus: record.cacheStatus,
      backendExecuted: record.backendExecuted,
      cacheHitKind: record.cacheHitKind,
      cacheEvictedEntries: record.cacheEvictedEntries,
      durationMs: record.durationMs,
      budgetState: outcome.budgetState
    }
  });
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

function schemaRepairInput(input: {
  request: LlmStructuredRequest<unknown>;
  submitToolName: string;
  error: string;
  submitCalls: PiToolCall[];
  extraToolNames: string[];
  schemaRepairUsed: boolean;
}): LlmSchemaInvalidSubmitRecoveryInput {
  return {
    stage: input.request.stage,
    submitTool: input.submitToolName,
    error: truncatePromptDiagnostic(input.error),
    submitCalls: input.submitCalls.map((call) => ({ id: call.id, arguments: call.arguments })),
    extraToolNames: input.extraToolNames,
    schemaRepairUsed: input.schemaRepairUsed
  };
}

function tryRecoverInvalidSubmit(input: {
  opts: CreateRunnerOptions;
  adapter: PiAiAdapter;
  request: LlmStructuredRequest<unknown>;
  submitTool: ToolDefinition;
  repairInput: LlmSchemaInvalidSubmitRecoveryInput;
  cause: unknown;
}): unknown | undefined {
  const recovered = input.request.schemaRepair?.recoverInvalidSubmit?.(input.repairInput);
  if (recovered === undefined) {
    return undefined;
  }
  try {
    const validated = input.adapter.validateToolCall([toolSpec(input.submitTool)], {
      type: "toolCall",
      id: `${input.repairInput.submitTool}-recovered`,
      name: input.repairInput.submitTool,
      arguments: recovered
    });
    input.opts.telemetry.event(definedRecord({
      stage: input.request.stage,
      level: "info",
      message: "schema_invalid_submit_recovered",
      workerId: input.request.telemetryContext?.workerId,
      packetId: input.request.telemetryContext?.packetId,
      data: definedRecord({
        submitTool: input.repairInput.submitTool,
        invalidSubmitCallCount: input.repairInput.submitCalls.length,
        schemaRepairUsed: input.repairInput.schemaRepairUsed,
        candidateId: input.request.telemetryContext?.candidateId
      })
    }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
    return validated;
  } catch (recoveryCause) {
    input.opts.telemetry.event(definedRecord({
      stage: input.request.stage,
      level: "warn",
      message: "schema_invalid_submit_recovery_invalid",
      workerId: input.request.telemetryContext?.workerId,
      packetId: input.request.telemetryContext?.packetId,
      data: definedRecord({
        submitTool: input.repairInput.submitTool,
        schemaRepairUsed: input.repairInput.schemaRepairUsed,
        error: truncatePromptDiagnostic(recoveryCause instanceof Error ? recoveryCause.message : String(recoveryCause)),
        originalError: truncatePromptDiagnostic(input.cause instanceof Error ? input.cause.message : String(input.cause)),
        candidateId: input.request.telemetryContext?.candidateId
      })
    }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
    return undefined;
  }
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
  repairClassification?: Stage7SchemaInvalidKind;
  replaceConversationOverride?: boolean;
  cause?: unknown;
}): void {
  const error = truncatePromptDiagnostic(input.error);
  if (input.schemaRepairUsed) {
    if (input.request.stage === 7) {
      recordStage7SchemaRepairFailed(
        input.opts,
        input.request,
        input.submitToolName,
        input.repairClassification ?? classifyStage7SchemaInvalid(input.error, input.submitCalls),
        error
      );
    }
    throw new CodegenieError("llm_schema_invalid", "model submit payload failed schema validation after repair", {
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
  const stage7CompactRepair = input.request.stage === 7 && input.replaceConversationOverride === true;
  const content = stage7CompactRepair
    ? stage7CompactSchemaRepairPrompt(input.submitToolName, error, input.repairClassification ?? "unsafe_candidate_like_payload", repairInput)
    : input.request.schemaRepair?.buildPrompt(repairInput) ??
      defaultSchemaRepairPrompt(input.request, input.submitToolName, error);
  const replaceConversation = input.replaceConversationOverride ?? (input.request.schemaRepair?.replaceConversation === true);
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
  if (stage7CompactRepair) {
    input.opts.telemetry.event(definedRecord({
      stage: 7,
      level: "warn",
      message: "stage7_schema_compact_repair_scheduled",
      workerId: input.request.telemetryContext?.workerId,
      packetId: input.request.telemetryContext?.packetId,
      data: definedRecord({
        submitTool: input.submitToolName,
        invalidSubmitCallCount: input.submitCalls.length,
        extraToolNames: input.extraToolNames,
        classification: input.repairClassification ?? "unsafe_candidate_like_payload",
        repairPromptChars: content.length,
        replaceConversation,
        candidateId: input.request.telemetryContext?.candidateId,
        error
      })
    }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
  }
}

function defaultSchemaRepairPrompt(
  request: LlmStructuredRequest<unknown>,
  submitToolName: string,
  error: string
): string {
  if (request.stage === 7) {
    return [
      "Repair the Stage 7 packet-review response for codegenie.",
      "",
      `Validation problem: ${error}`,
      "",
      "Required action:",
      `- Call \`${submitToolName}\` exactly once with schema-valid arguments.`,
      "- Do not output XML.",
      "- Do not write `<parameter>` tags.",
      "- Do not describe the schema.",
      "- Do not answer in plain text.",
      "- Do not call repository tools or ask for more context.",
      `- ${noResultInstruction(request)}`
    ].join("\n");
  }
  return `${error}. Call ${submitToolName} again with exactly one corrected schema-valid set of arguments.`;
}

function recordStage7SchemaRepairAttempted(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  submitTool: string,
  submitCalls: PiToolCall[],
  extraToolCalls: PiToolCall[],
  classification: Stage7SchemaInvalidKind,
  cause: unknown
): void {
  opts.telemetry.event(definedRecord({
    stage: 7,
    level: "warn",
    message: "stage7_schema_repair_attempted",
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    data: definedRecord({
      submitTool,
      invalidSubmitCallCount: submitCalls.length,
      originalCallIds: submitCalls.map((call) => call.id),
      extraToolNames: extraToolCalls.map((toolCall) => toolCall.name),
      payloadKind: stage7SubmitPayloadKind(submitCalls),
      classification,
      error: truncatePromptDiagnostic(cause instanceof Error ? cause.message : String(cause)),
      candidateId: request.telemetryContext?.candidateId
    })
  }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
}

function recordStage7SchemaCleanupAttempted(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  submitTool: string,
  decision: Stage7SubmitRepairDecision
): void {
  opts.telemetry.event(definedRecord({
    stage: 7,
    level: "info",
    message: "stage7_schema_cleanup_attempted",
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    data: definedRecord({
      submitTool,
      cleanupKind: decision.cleanupKind,
      classification: decision.classification,
      strippedKeys: decision.strippedKeys,
      cleanedFields: decision.cleanedFields,
      truncatedFields: decision.truncatedFields,
      rejectReason: decision.rejectReason,
      candidateId: request.telemetryContext?.candidateId
    })
  }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
}

function recordStage7SchemaCleanupRecovered(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  decision: Stage7SubmitRepairDecision,
  recoveredCallId: string
): void {
  opts.telemetry.event(definedRecord({
    stage: 7,
    level: "info",
    message: "stage7_schema_cleanup_recovered",
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    data: definedRecord({
      cleanupKind: decision.cleanupKind,
      classification: decision.classification,
      strippedKeys: decision.strippedKeys,
      cleanedFields: decision.cleanedFields,
      truncatedFields: decision.truncatedFields,
      recoveredCallId,
      candidateId: request.telemetryContext?.candidateId
    })
  }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
  if (decision.truncatedNoFindingReason) {
    opts.telemetry.event(definedRecord({
      stage: 7,
      level: "info",
      message: "stage7_no_finding_reason_truncated",
      workerId: request.telemetryContext?.workerId,
      packetId: request.telemetryContext?.packetId,
      data: definedRecord({
        cleanupKind: decision.cleanupKind,
        classification: decision.classification,
        cleanedFields: decision.cleanedFields,
        truncatedFields: decision.truncatedFields,
        recoveredCallId,
        candidateId: request.telemetryContext?.candidateId
      })
    }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
  }
}

function recordStage7SchemaCleanupRejected(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  submitTool: string,
  decision: Stage7SubmitRepairDecision,
  cause: unknown
): void {
  opts.telemetry.event(definedRecord({
    stage: 7,
    level: "warn",
    message: "stage7_schema_cleanup_rejected",
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    data: definedRecord({
      submitTool,
      cleanupKind: decision.cleanupKind,
      classification: decision.classification,
      strippedKeys: decision.strippedKeys,
      cleanedFields: decision.cleanedFields,
      truncatedFields: decision.truncatedFields,
      rejectReason: decision.rejectReason,
      error: truncatePromptDiagnostic(cause instanceof Error ? cause.message : String(cause)),
      candidateId: request.telemetryContext?.candidateId
    })
  }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
}

function recordStage7SchemaRepairRecovered(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  classification: Stage7SchemaInvalidKind | "schema_valid_after_retry"
): void {
  opts.telemetry.event(definedRecord({
    stage: 7,
    level: "info",
    message: "stage7_schema_repair_recovered",
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    data: definedRecord({
      classification,
      candidateId: request.telemetryContext?.candidateId
    })
  }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
}

function recordStage7SchemaRepairFailed(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  submitTool: string,
  classification: Stage7SchemaInvalidKind,
  error: string
): void {
  opts.telemetry.event(definedRecord({
    stage: 7,
    level: "warn",
    message: "stage7_schema_repair_failed",
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    data: definedRecord({
      submitTool,
      classification,
      error,
      candidateId: request.telemetryContext?.candidateId
    })
  }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
}

function modelCallCacheDiagnostics(
  canonicalRequest: Record<string, unknown>,
  cacheKey: string,
  promptChars: number,
  providerPromptCache: ProviderPromptCacheOptions
): ModelCallCacheDiagnostics {
  const tools = Array.isArray(canonicalRequest.tools) ? canonicalRequest.tools : [];
  const runFingerprint = typeof canonicalRequest.runFingerprint === "string" ? canonicalRequest.runFingerprint : undefined;
  return {
    keyPrefix: cacheKey.slice(0, 12),
    requestHash: cacheKey,
    ...(runFingerprint !== undefined ? { runFingerprintHash: sha256Hex(runFingerprint) } : {}),
    runnerMessageVersion: String(canonicalRequest.runnerMessageVersion ?? ""),
    stage: canonicalRequest.stage as ReviewStage,
    kind: canonicalRequest.kind as ModelCallKind,
    templateVersion: String(canonicalRequest.templateVersion ?? ""),
    schemaName: String(canonicalRequest.schemaName ?? ""),
    schemaVersion: Number(canonicalRequest.schemaVersion ?? 0),
    toolChoiceHash: sha256Hex(stableJson(canonicalRequest.toolChoice)),
    toolBudgetHash: sha256Hex(stableJson(canonicalRequest.toolBudget)),
    messageHash: sha256Hex(stableJson(canonicalRequest.messages)),
    messageCount: Array.isArray(canonicalRequest.messages) ? canonicalRequest.messages.length : 0,
    toolSpecHash: sha256Hex(stableJson(tools)),
    toolCount: tools.length,
    promptChars,
    providerPromptCache: providerPromptCacheDebug(providerPromptCache)
  };
}

function emitModelCallCacheDiagnostic(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  missReason: ModelCallCacheMissReason,
  diagnostics: ModelCallCacheDiagnostics
): void {
  opts.telemetry.event(definedRecord({
    stage: request.stage,
    level: "debug",
    message: "model_call_cache_key_diagnostic",
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    data: definedRecord({
      ...diagnostics,
      missReason,
      role: roleForStage(request.stage),
      candidateId: request.telemetryContext?.candidateId
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
    finalizeMode?: "compact" | "full" | undefined;
    finalizeTarget?: "no_findings" | "candidate_or_unknown" | undefined;
    attempt: number;
    cacheStatus: ModelCallCacheStatus;
    cacheKey: string;
    cacheDiagnostics: ModelCallCacheDiagnostics;
    promptText: string;
    messages: ConversationMessage[];
    tools: ToolDefinition[];
    toolChoice: ToolChoiceMode;
    providerPromptCache: ProviderPromptCacheOptions;
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
    finalizeMode: meta.finalizeMode,
    finalizeTarget: meta.finalizeTarget,
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
      key: opts.cache ? meta.cacheKey : undefined,
      diagnostics: opts.cache ? meta.cacheDiagnostics : undefined
    }),
    request: {
      runnerMessageVersion: RUNNER_MESSAGE_VERSION,
      promptTemplateVersion: request.templateVersion,
      schemaName,
      schemaVersion: SCHEMA_VERSIONS[schemaName],
      toolBudget: request.toolBudget ?? NO_REPOSITORY_TOOL_BUDGET,
      toolChoice: meta.toolChoice,
      providerPromptCache: providerPromptCacheDebug(meta.providerPromptCache),
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
    finalizeMode?: "compact" | "full" | undefined;
    finalizeTarget?: "no_findings" | "candidate_or_unknown" | undefined;
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
      finalizeMode: meta.finalizeMode,
      finalizeTarget: meta.finalizeTarget,
      attempt: meta.attempt,
      promptChars: meta.promptText.length,
      promptHash: sha256Hex(meta.promptText),
      toolCount: meta.toolNames.length,
      toolNames: meta.toolNames,
      candidateId: request.telemetryContext?.candidateId
    })
  }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
}

function recordProviderRetryEvent(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  meta: { callId: string; attempt: number; maxAttempts: number; reason: string; nextDelayMs: number }
): void {
  opts.telemetry.event(definedRecord({
    stage: request.stage,
    level: "warn",
    message: "provider_retry_scheduled",
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    data: definedRecord({
      callId: meta.callId,
      role: roleForStage(request.stage),
      attempt: meta.attempt,
      maxAttempts: meta.maxAttempts,
      retryReason: meta.reason,
      nextDelayMs: meta.nextDelayMs,
      candidateId: request.telemetryContext?.candidateId
    }) as Record<string, unknown>
  }) as Parameters<CreateRunnerOptions["telemetry"]["event"]>[0]);
}

function recordProviderRetryExhaustedEvent(
  opts: CreateRunnerOptions,
  request: LlmStructuredRequest<unknown>,
  meta: { callId: string; attempt: number; maxAttempts: number; reason: string }
): void {
  opts.telemetry.event(definedRecord({
    stage: request.stage,
    level: "warn",
    message: "provider_retry_exhausted",
    workerId: request.telemetryContext?.workerId,
    packetId: request.telemetryContext?.packetId,
    data: definedRecord({
      callId: meta.callId,
      role: roleForStage(request.stage),
      attempt: meta.attempt,
      maxAttempts: meta.maxAttempts,
      retryReason: meta.reason,
      candidateId: request.telemetryContext?.candidateId
    }) as Record<string, unknown>
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
    finalizeMode?: "compact" | "full" | undefined;
    finalizeTarget?: "no_findings" | "candidate_or_unknown" | undefined;
    attempt: number;
    cacheStatus: ModelCallCacheStatus;
    promptText: string;
    durationMs: number;
    usage?: StoredProviderResponse["usage"];
    schemaValid?: boolean;
    status?: "ok" | "schema_invalid" | "transient_error" | "auth_error" | "timeout" | "aborted";
    errorCode?: CodegenieErrorCode;
    errorMessage?: string;
    retryable?: boolean;
    retryReason?: string;
    maxAttempts?: number;
    retryExhausted?: boolean;
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
    finalizeMode: meta.finalizeMode,
    finalizeTarget: meta.finalizeTarget,
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
    errorMessage: meta.errorMessage ?? providerErrorMessage(message),
    retryable: meta.retryable,
    retryReason: meta.retryReason,
    maxAttempts: meta.maxAttempts,
    retryExhausted: meta.retryExhausted
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
    finalizeMode?: "compact" | "full" | undefined;
    finalizeTarget?: "no_findings" | "candidate_or_unknown" | undefined;
    attempt: number;
    cacheStatus: ModelCallCacheStatus;
    promptText: string;
    durationMs: number;
    status: "transient_error" | "auth_error" | "timeout" | "aborted";
    errorCode: CodegenieErrorCode;
    errorMessage?: string;
    retryable?: boolean;
    retryReason?: string;
    maxAttempts?: number;
    retryExhausted?: boolean;
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
    finalizeMode: meta.finalizeMode,
    finalizeTarget: meta.finalizeTarget,
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
    errorMessage: meta.errorMessage,
    retryable: meta.retryable,
    retryReason: meta.retryReason,
    maxAttempts: meta.maxAttempts,
    retryExhausted: meta.retryExhausted
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
  if (request.stage !== 5 && request.stage !== 10) {
    return undefined;
  }
  if (submitCalls.length === 1) {
    return undefined;
  }
  const stageName = request.stage === 5 ? "planner" : "composer";
  return `Stage ${request.stage} ${stageName} responses must call ${submitToolName} exactly once; received ${submitCalls.length} ${submitToolName} call${submitCalls.length === 1 ? "" : "s"}.`;
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

type ProviderRetryClassification = {
  retryable: boolean;
  reason: string;
};

function classifyProviderRetry(cause: unknown, attempt: number): ProviderRetryClassification {
  if (isAbortError(cause)) {
    return { retryable: false, reason: "aborted" };
  }
  if (errorStatus(cause) === "auth_error") {
    return { retryable: false, reason: "auth_error" };
  }
  const status = errorHttpStatus(cause);
  if (status !== undefined) {
    if (status === 429) {
      return { retryable: true, reason: "rate_limited" };
    }
    if (status >= 500) {
      return { retryable: true, reason: "server_error" };
    }
    return { retryable: false, reason: "request_error" };
  }
  const messageReason = transientProviderMessageReason(cause);
  if (messageReason !== undefined) {
    return { retryable: true, reason: messageReason };
  }
  if (isLikelyNetworkError(cause)) {
    return { retryable: true, reason: "network_error" };
  }
  return attempt === 1
    ? { retryable: true, reason: "unknown_initial" }
    : { retryable: false, reason: "unknown_non_retryable" };
}

function toLlmError(
  cause: unknown,
  status: "transient_error" | "auth_error" | "timeout" | "aborted",
  timedOut: boolean
): CodegenieError {
  if (status === "auth_error") {
    return new CodegenieError("llm_call_failed", "LLM provider authentication failed", {
      recoverable: false,
      context: { reason: "auth" },
      cause
    });
  }
  const reason = timedOut ? "timeout" : requestErrorReason(cause, status);
  const retry = status === "transient_error" ? classifyProviderRetry(cause, MAX_PROVIDER_ATTEMPTS) : undefined;
  return new CodegenieError("llm_call_failed", timedOut ? "LLM provider call timed out" : "LLM provider call failed", {
    recoverable: true,
    context: definedRecord({ reason, retryReason: retry?.reason }) as Record<string, unknown>,
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

function transientProviderMessageReason(cause: unknown): string | undefined {
  const text = providerErrorText(cause);
  if (text.length === 0) {
    return undefined;
  }
  if (/\boverloaded(?:_error)?\b/iu.test(text)) {
    return "provider_overloaded";
  }
  if (/\brate[ _-]?limit(?:ed|ing)?\b|\btoo many requests\b/iu.test(text)) {
    return "rate_limited";
  }
  if (/\btemporarily unavailable\b|\btry again later\b|\bservice unavailable\b/iu.test(text)) {
    return "temporarily_unavailable";
  }
  if (/\bserver error\b|\binternal server error\b/iu.test(text)) {
    return "server_error";
  }
  return undefined;
}

function providerErrorText(cause: unknown): string {
  if (cause instanceof Error) {
    const parts = [cause.message];
    const record = cause as unknown as Record<string, unknown>;
    collectProviderErrorText(record, parts);
    return parts.filter((part) => part.trim().length > 0).join("\n");
  }
  if (!cause || typeof cause !== "object") {
    return String(cause ?? "");
  }
  const parts: string[] = [];
  collectProviderErrorText(cause as Record<string, unknown>, parts);
  return parts.join("\n");
}

function collectProviderErrorText(record: Record<string, unknown>, parts: string[]): void {
  for (const key of ["type", "code", "message", "errorMessage"]) {
    const value = record[key];
    if (typeof value === "string") {
      parts.push(value);
    }
  }
  const nested = record.error ?? record.response;
  if (nested && typeof nested === "object") {
    collectProviderErrorText(nested as Record<string, unknown>, parts);
  }
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

function taskAbortError(timedOut: boolean): CodegenieError {
  return new CodegenieError("llm_call_failed", timedOut ? "LLM model task timed out" : "LLM model task aborted", {
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
    deliveryStatus: "truncated",
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
    if (isDeprecatedProviderModel(resolvedProvider, resolvedModel)) {
      return undefined;
    }
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
    const models = filterDeprecatedProviderModels(getModels(resolvedProvider as KnownProvider));
    const first = models[0];
    return first ? { provider: resolvedProvider, id: first.id, raw: first, ...auth } : undefined;
  }

  for (const providerId of getProviders()) {
    const auth = resolveProviderAuth(providerId, authStorage);
    if (!auth) {
      continue;
    }
    const models = filterDeprecatedProviderModels(getModels(providerId));
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

function resolveProviderAuth(provider: string, authStorage = createFileAuthStorage(getCodegeniePaths())): Pick<PiModelRef, "apiKey" | "oauthProvider"> | undefined {
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

  const authStorage = deps.authStorage ?? createFileAuthStorage(getCodegeniePaths());
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
