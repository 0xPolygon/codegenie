import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { complete as piComplete, completeSimple as piCompleteSimple, Type, validateToolCall } from "@earendil-works/pi-ai/compat";
import { getOAuthApiKey as piGetOAuthApiKey } from "@earendil-works/pi-ai/oauth";
import { describe, expect, it, vi } from "vitest";
import { createPiRunner, createRealPiAiAdapter } from "../src/llm/pi-runner.js";
import type {
  LlmCallUsage,
  PiAiAdapter,
  PiAssistantMessage,
  PiToolCall,
  StoredProviderResponse
} from "../src/llm/llm-runner.js";
import {
  buildModelCallCacheKey,
  createModelCallCache,
  MODEL_CALL_CACHE_SCHEMA_VERSION,
  modelCallCacheEntryPath
} from "../src/llm/model-call-cache.js";
import { createToolResultCache } from "../src/llm/tool-result-cache.js";
import {
  SCHEMA_VERSIONS,
  SubmitCompositionSchema,
  type SubmitPacketReview,
  SubmitPacketReviewSchema,
  SubmitPlanSchema,
  SubmitVerificationVerdictSchema,
  submitToolNameForStage
} from "../src/llm/schemas.js";
import { buildRepositoryToolDefinitions } from "../src/llm/tool-definitions.js";
import type { Logger, LogEvent, RepositoryTools, TelemetryEvent, ToolCallRecord } from "../src/types.js";
import type { LlmCallRecord, TelemetryRecorder } from "../src/telemetry/telemetry-recorder.js";
import { clearRegisteredSecretsForTests, registerSecret, stripCredentials } from "../src/telemetry/redaction.js";
import type { ToolDefinition } from "../src/llm/llm-runner.js";
import type { PiAuthStorage, ProviderAuthEntry } from "../src/provider/provider-services.js";
import { CodegenieError } from "../src/util/errors.js";
import { scaleToolBudget } from "../src/util/budget.js";

describe("Phase 4 schemas and repository tool definitions", () => {
  it("redacts shared object references without mistaking them for cycles", () => {
    const shared = { token: "sk-shared-secret-value-1234567890" };
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    const redacted = stripCredentials({ first: shared, second: shared, cyclic }) as {
      first: { token: string };
      second: { token: string };
      cyclic: { self: string };
    };

    expect(redacted.first).toEqual({ token: "[redacted:pattern]" });
    expect(redacted.second).toEqual({ token: "[redacted:pattern]" });
    expect(redacted.cyclic.self).toBe("[redacted:circular]");
  });

  it("rejects hallucinated fields and exposes stage submit tool names", () => {
    expect(submitToolNameForStage(5)).toBe("submit_plan");
    expect(submitToolNameForStage(7)).toBe("submit_review");
    expect(submitToolNameForStage(9)).toBe("submit_verdict");
    expect(submitToolNameForStage(10)).toBe("submit_composition");
    expect(SCHEMA_VERSIONS.submit_plan).toBe(5);

    const valid = {
      diffUnderstanding: { declaredIntent: "Small change", inferredBehavior: "The diff makes a small change." },
      coverage: []
    };
    const submitTool = { name: "submit_plan", description: "submit", parameters: SubmitPlanSchema };
    expect(
      validateToolCall([submitTool], {
        type: "toolCall",
        id: "submit-1",
        name: "submit_plan",
        arguments: valid
      })
    ).toEqual(valid);
    expect(() =>
      validateToolCall([submitTool], {
        type: "toolCall",
        id: "submit-2",
        name: "submit_plan",
        arguments: { ...valid, inventedField: true }
      })
    ).toThrow();
    expect(() =>
      validateToolCall([submitTool], {
        type: "toolCall",
        id: "submit-old-understanding",
        name: "submit_plan",
        arguments: { ...valid, diffUnderstanding: { summary: "old", intent: "old" } }
      })
    ).toThrow();
  });

  it("exposes model-facing submit schemas without pipeline-owned fields", () => {
    const review = { findings: [], followUpHints: [], uncertainties: [] };
    const reviewTool = { name: "submit_review", description: "submit", parameters: SubmitPacketReviewSchema };
    expect(
      validateToolCall([reviewTool], {
        type: "toolCall",
        id: "submit-review",
        name: "submit_review",
        arguments: review
      })
    ).toEqual(review);
    expect(() =>
      validateToolCall([reviewTool], {
        type: "toolCall",
        id: "submit-review-owned",
        name: "submit_review",
        arguments: { ...review, packetId: "packet-1", lenses: ["core/code-review"], status: "completed" }
      })
    ).toThrow();

    const verdict = {
      verdict: "keep",
      reason: "evidence is present",
      requiredEvidencePresent: true,
      falsePositiveRisk: "low"
    };
    const verdictTool = { name: "submit_verdict", description: "submit", parameters: SubmitVerificationVerdictSchema };
    expect(
      validateToolCall([verdictTool], {
        type: "toolCall",
        id: "submit-verdict",
        name: "submit_verdict",
        arguments: verdict
      })
    ).toEqual(verdict);
    expect(() =>
      validateToolCall([verdictTool], {
        type: "toolCall",
        id: "submit-verdict-owned",
        name: "submit_verdict",
        arguments: { ...verdict, candidateId: "candidate-1", verificationIncomplete: true }
      })
    ).toThrow();

    const composition = {
      summary: "One verified finding.",
      composedFindings: [{ findingIds: ["finding-1"], finalBody: "The final body.", publication: "inline" }]
    };
    const compositionTool = { name: "submit_composition", description: "submit", parameters: SubmitCompositionSchema };
    expect(
      validateToolCall([compositionTool], {
        type: "toolCall",
        id: "submit-composition",
        name: "submit_composition",
        arguments: composition
      })
    ).toEqual(composition);
    expect(() =>
      validateToolCall([compositionTool], {
        type: "toolCall",
        id: "submit-composition-old",
        name: "submit_composition",
        arguments: {
          ...composition,
          markdown: "old markdown",
          findingOrder: ["finding-1"],
          suppressedFindingIds: [],
          notes: []
        }
      })
    ).toThrow();
  });

  it("defines all nine repository tools and renders tool failures as model-visible errors", async () => {
    const defs = buildRepositoryToolDefinitions(fakeRepositoryTools());
    expect(defs.map((tool) => tool.name)).toEqual([
      "read_range",
      "read_file_outline",
      "read_symbol",
      "find_definition",
      "read_diff_blocks",
      "search_files",
      "find_symbol_mentions",
      "find_likely_tests",
      "list_files"
    ]);

    const readRange = defs.find((tool) => tool.name === "read_range");
    const range = await readRange?.execute({ path: "src/a.ts", startLine: 1, endLine: 2 }, new AbortController().signal);
    expect(range?.text).toContain("line 1");
    expect(range?.meta?.precision).toBe("exact");

    const readSymbol = defs.find((tool) => tool.name === "read_symbol");
    const invalid = await readSymbol?.execute({ path: "src/a.ts" }, new AbortController().signal);
    expect(invalid).toMatchObject({
      isError: true
    });
    expect(invalid?.text).toContain("read_symbol requires exactly one");
  });

  it("can omit likely-test lookup from model-facing repository tools", () => {
    const defs = buildRepositoryToolDefinitions(fakeRepositoryTools(), { includeLikelyTests: false });

    expect(defs.map((tool) => tool.name)).toEqual([
      "read_range",
      "read_file_outline",
      "read_symbol",
      "find_definition",
      "read_diff_blocks",
      "search_files",
      "find_symbol_mentions",
      "list_files"
    ]);
  });

  it("allows auto source for model-facing symbol lookups and renders fallback metadata", async () => {
    const tools: RepositoryTools = {
      ...fakeRepositoryTools(),
      readSymbol: async (_path, _selector, source) => ({
        text: "func DeletedHelper() {}",
        symbol: { path: "src/a.ts", name: "DeletedHelper", kind: "function", lineRange: [1, 1] },
        meta: {
          backend: "tree-sitter",
          precision: "syntactic",
          degraded: false,
          requestedSource: source?.kind ?? "head",
          sourceUsed: "base",
          sourceFallback: true,
          baseOnly: true
        }
      }),
      findDefinition: async (_symbolName, options) => ({
        definitions: [{ symbol: { path: "src/a.ts", name: "DeletedHelper", kind: "function", lineRange: [1, 1] }, text: "func DeletedHelper() {}" }],
        meta: {
          backend: "tree-sitter",
          precision: "syntactic",
          degraded: false,
          requestedSource: options?.source?.kind ?? "head",
          sourceUsed: "base",
          sourceFallback: true,
          baseOnly: true
        }
      })
    };
    const defs = buildRepositoryToolDefinitions(tools);
    const readSymbol = defs.find((tool) => tool.name === "read_symbol");
    const findDefinition = defs.find((tool) => tool.name === "find_definition");

    const symbol = await readSymbol?.execute(
      { path: "src/a.ts", symbolName: "DeletedHelper", source: { kind: "auto" } },
      new AbortController().signal
    );
    const definition = await findDefinition?.execute(
      { symbolName: "DeletedHelper", source: { kind: "auto" } },
      new AbortController().signal
    );

    expect(symbol?.text).toContain("source: requested auto, used base");
    expect(symbol?.text).toContain("source fallback: head to base");
    expect(symbol?.text).toContain("symbol exists only in base");
    expect(definition?.text).toContain("source: requested auto, used base");
  });

  it("suppresses facade recording and preserves path rejection metadata for model tools", async () => {
    const facadeRecords: string[] = [];
    let suppressFacadeRecord = false;
    const tools = {
      ...fakeRepositoryTools(),
      withToolCallContext: async <T>(context: { record?: boolean }, run: () => Promise<T>) => {
        suppressFacadeRecord = context.record === false;
        try {
          return await run();
        } finally {
          suppressFacadeRecord = false;
        }
      },
      readRange: async () => {
        if (!suppressFacadeRecord) {
          facadeRecords.push("read_range");
        }
        throw new CodegenieError("path_outside_repo", "outside repo");
      }
    } satisfies RepositoryTools & {
      withToolCallContext<T>(context: { record?: boolean }, run: () => Promise<T>): Promise<T>;
    };

    const readRange = buildRepositoryToolDefinitions(tools).find((tool) => tool.name === "read_range");
    const result = await readRange?.execute({ path: "../secret", startLine: 1, endLine: 1 }, new AbortController().signal);

    expect(facadeRecords).toEqual([]);
    expect(result).toMatchObject({
      isError: true,
      errorCode: "path_outside_repo"
    });
  });

  it("rejects model-facing repository tools promptly when their signal aborts", async () => {
    const tools = {
      ...fakeRepositoryTools(),
      searchFiles: vi.fn(async () => new Promise<never>(() => undefined))
    } satisfies RepositoryTools;
    const search = buildRepositoryToolDefinitions(tools).find((tool) => tool.name === "search_files");
    if (!search) {
      throw new Error("search_files definition missing");
    }
    const controller = new AbortController();

    const result = search.execute({ query: "needle" }, controller.signal);
    await Promise.resolve();
    expect(tools.searchFiles).toHaveBeenCalledTimes(1);
    controller.abort(new Error("timeout"));

    await expect(result).rejects.toMatchObject({
      code: "llm_call_failed",
      context: { reason: "timeout" }
    });
  });
});

describe("Phase 4 Pi runner and model-call cache", () => {
  it("runs a tool round, fences tool output, validates submit payload, and records telemetry", async () => {
    const telemetry = fakeTelemetry();
    const usage: LlmCallUsage[] = [];
    const adapter = scriptedAdapter([
      assistant([
        {
          type: "toolCall",
          id: "tool-1",
          name: "read_range",
          arguments: { path: "src/a.ts", startLine: 1, endLine: 2 }
        }
      ]),
      assistant([
        {
          type: "toolCall",
          id: "submit-1",
          name: "submit_review",
          arguments: {
            findings: [],
            followUpHints: [],
            uncertainties: []
          }
        }
      ])
    ]);

    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", reasoning: "high", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: {
        checkpoint: () => "ok",
        onUsage: (entry) => usage.push(entry)
      }
    });

    const result = await runner.runStructured({
      stage: 7,
      prompt: "review packet",
      schema: SubmitPacketReviewSchema,
      templateVersion: "test-template",
      tools: buildRepositoryToolDefinitions(fakeRepositoryTools()),
      toolBudget: { maxToolCalls: 2, maxInvestigationRounds: 2, maxResultChars: 2000 },
      timeoutMs: 1000,
      telemetryContext: { workerId: "worker-1", packetId: "packet-1" }
    });

    expect(result).toEqual({
      findings: [],
      followUpHints: [],
      uncertainties: []
    });
    expect(adapter.contexts[1]).toContain("untrusted-data label=tool-result-read_range");
    expect(telemetry.modelCalls.map((call) => call.stopReason)).toEqual(["tool_calls", "submit"]);
    expect(telemetry.modelCalls[1]?.schemaValid).toBe(true);
    const modelCallEvents = telemetry.events.filter((event) =>
      event.message === "model_call_queued" || event.message === "model_call_started"
    );
    expect(modelCallEvents.map((event) => event.message)).toEqual([
      "model_call_queued",
      "model_call_started",
      "model_call_queued",
      "model_call_started"
    ]);
    expect(modelCallEvents[0]).toMatchObject({
      stage: 7,
      level: "debug",
      workerId: "worker-1",
      packetId: "packet-1",
      data: expect.objectContaining({
        callId: "mc-000001",
        role: "packetReview",
        provider: "fake",
        model: "fake-model",
        kind: "initial",
        attempt: 1,
        promptChars: expect.any(Number),
        promptHash: expect.any(String),
        toolNames: expect.arrayContaining(["read_range", "submit_review"])
      })
    });
    expect(telemetry.toolCalls).toHaveLength(1);
    expect(telemetry.toolCalls[0]).toMatchObject({
      stage: 7,
      initiator: "model",
      modelCallId: "mc-000001",
      tool: "read_range",
      status: "ok",
      packetId: "packet-1"
    });
    expect(usage).toHaveLength(2);
  });

  it("writes redacted reconstructable model request and response debug artifacts", async () => {
    clearRegisteredSecretsForTests();
    registerSecret("debug-secret-token");
    const telemetry = fakeTelemetry();
    const usage: LlmCallUsage[] = [];
    const adapter = scriptedAdapter([
      assistant([
        {
          type: "toolCall",
          id: "tool-debug",
          name: "read_range",
          arguments: { path: "src/a.ts", startLine: 1, endLine: 2 }
        }
      ]),
      assistant([validSubmitReviewCall("submit-debug")])
    ]);
    const tools = fakeRepositoryTools();
    tools.readRange = async () => ({
      text: "line 1 debug-secret-token\nline 2",
      meta: { backend: "text", precision: "exact", degraded: false }
    });
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", reasoning: "high", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: {
        checkpoint: () => "ok",
        onUsage: (entry) => usage.push(entry)
      }
    });

    await runner.runStructured({
      stage: 7,
      prompt: "review debug-secret-token",
      schema: SubmitPacketReviewSchema,
      templateVersion: "debug-template",
      tools: buildRepositoryToolDefinitions(tools),
      toolBudget: { maxToolCalls: 2, maxInvestigationRounds: 2, maxResultChars: 2000 },
      timeoutMs: 1000,
      telemetryContext: { workerId: "worker-debug", packetId: "packet-debug" }
    });

    const request1 = debugRecord(telemetry, "mc-000001.request");
    expect(request1).toMatchObject({
      schemaVersion: 1,
      artifactKind: "llm_call_request",
      callId: "mc-000001",
      stage: 7,
      role: "packetReview",
      kind: "initial",
      workerId: "worker-debug",
      packetId: "packet-debug",
      provider: { provider: "fake", model: "fake-model", reasoning: "high" },
      request: {
        runnerMessageVersion: "pi-runner-loop-v3",
        promptTemplateVersion: "debug-template",
        schemaName: "submit_review",
        schemaVersion: 4,
        toolChoice: "auto",
        messageCount: 1
      },
      redaction: {
        applied: true,
        markerCounts: { secret: 1 }
      }
    });
    const request1Text = JSON.stringify(request1);
    expect(request1Text).not.toContain("debug-secret-token");
    expect(request1Text).toContain("[redacted:secret]");
    const request1Payload = request1.request as { messages: unknown[]; tools: Array<Record<string, unknown>> };
    expect(request1Payload.messages).toEqual([
      expect.objectContaining({ role: "user", content: "review [redacted:secret]" })
    ]);
    expect(request1Payload.tools.find((tool) => tool.name === "read_range")).toMatchObject({
      localParametersHash: expect.any(String),
      providerParametersHash: expect.any(String),
      providerParameters: expect.any(Object)
    });
    expect(request1Payload.tools.find((tool) => tool.name === "submit_review")).toMatchObject({
      providerParametersHash: expect.any(String)
    });

    const response1 = debugRecord(telemetry, "mc-000001.response");
    expect(response1).toMatchObject({
      schemaVersion: 1,
      artifactKind: "llm_call_response",
      callId: "mc-000001",
      stage: 7,
      stopReason: "tool_calls",
      response: { role: "assistant" }
    });

    const request2 = debugRecord(telemetry, "mc-000002.request");
    const request2Text = JSON.stringify(request2);
    expect(request2Text).not.toContain("debug-secret-token");
    expect(request2Text).toContain("[redacted:secret]");
    expect(request2Text).toContain("tool-result-read_range");
    const request2Payload = request2.request as { messages: Array<Record<string, unknown>> };
    expect(request2Payload.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "toolResult",
          toolCallId: "tool-debug",
          toolName: "read_range"
        })
      ])
    );
    expect(usage).toHaveLength(2);
    clearRegisteredSecretsForTests();
  });

  it("truncates oversized model debug artifacts and records a warning", async () => {
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([assistant([validSubmitReviewCall("submit-large-debug")])]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", reasoning: "high", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: {
        checkpoint: () => "ok",
        onUsage: () => undefined
      }
    });

    await runner.runStructured({
      stage: 7,
      prompt: "x".repeat(1_500_100),
      schema: SubmitPacketReviewSchema,
      templateVersion: "debug-template",
      timeoutMs: 1000,
      telemetryContext: { packetId: "packet-large-debug" }
    });

    expect(debugRecord(telemetry, "mc-000001.request")).toMatchObject({
      schemaVersion: 1,
      artifactKind: "truncated_debug_artifact",
      stage: 7,
      id: "mc-000001.request",
      kind: "llm-calls",
      originalChars: expect.any(Number),
      maxChars: 1_500_000,
      preview: expect.any(String)
    });
    expect(telemetry.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 7,
          level: "warn",
          message: "debug_artifact_truncated",
          packetId: "packet-large-debug",
          data: expect.objectContaining({
            kind: "llm-calls",
            id: "mc-000001.request",
            originalChars: expect.any(Number),
            maxChars: 1_500_000
          })
        })
      ])
    );
  });

  it("normalizes prompt-cache usage into explicit token and cost fields", async () => {
    const telemetry = fakeTelemetry();
    const usage: LlmCallUsage[] = [];
    const cache = {
      get: vi.fn(async (_key: string) => ({ status: "miss" as const, reason: "not_found" as const })),
      put: vi.fn(async (_key: string, _entry: StoredProviderResponse) => ({ status: "write" as const }))
    };
    const response = assistant([validSubmitReviewCall("submit-cache-usage")]);
    response.usage = {
      input: 10,
      output: 5,
      cacheRead: 100,
      cacheWrite: 2,
      totalTokens: 117,
      cost: {
        input: 0.01,
        output: 0.02,
        cacheRead: 0.003,
        cacheWrite: 0.004,
        total: 0.037
      }
    };
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", reasoning: "high", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter: scriptedAdapter([response]),
      cache,
      hooks: {
        checkpoint: () => "ok",
        onUsage: (entry) => usage.push(entry)
      }
    });

    await runner.runStructured(submitReviewRequest("packet-cache-usage"));

    const expectedUsage = {
      inputTokens: 112,
      uncachedInputTokens: 10,
      cacheReadTokens: 100,
      cacheWriteTokens: 2,
      billableInputTokens: 112,
      outputTokens: 5,
      totalTokens: 117,
      costUSD: 0.037,
      inputCostUSD: 0.01,
      outputCostUSD: 0.02,
      cacheReadCostUSD: 0.003,
      cacheWriteCostUSD: 0.004
    };
    expect(telemetry.modelCalls[0]).toMatchObject(expectedUsage);
    expect(usage[0]).toMatchObject(expectedUsage);
    expect(cache.put.mock.calls[0]?.[1].usage).toMatchObject(expectedUsage);
    expect(debugRecord(telemetry, "mc-000001.response")).toMatchObject({
      usage: {
        usageProvider: "fake",
        usageRaw: response.usage,
        usageNormalized: expectedUsage
      }
    });
  });

  it("continues after a path_outside_repo repository tool rejection and records the rejected tool call", async () => {
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([
      assistant([
        {
          type: "toolCall",
          id: "tool-outside",
          name: "read_range",
          arguments: { path: "../secret", startLine: 1, endLine: 1 }
        }
      ]),
      assistant([validSubmitReviewCall("submit-after-rejected-tool")])
    ]);
    const tools = fakeRepositoryTools();
    tools.readRange = async () => {
      throw new CodegenieError("path_outside_repo", "outside repo");
    };
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", reasoning: "high", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: {
        checkpoint: () => "ok",
        onUsage: () => undefined
      }
    });

    await expect(
      runner.runStructured({
        ...submitReviewRequest("packet-rejected-tool"),
        tools: buildRepositoryToolDefinitions(tools),
        toolBudget: { maxToolCalls: 2, maxInvestigationRounds: 2, maxResultChars: 2000 },
        telemetryContext: { workerId: "worker-reject", packetId: "packet-rejected-tool" }
      })
    ).resolves.toEqual({ findings: [], followUpHints: [], uncertainties: [] });

    expect(adapter.contexts[1]).toContain("\"isError\":true");
    expect(adapter.contexts[1]).toContain("path_outside_repo");
    expect(telemetry.toolCalls).toEqual([
      expect.objectContaining({
        stage: 7,
        tool: "read_range",
        status: "rejected",
        errorCode: "path_outside_repo",
        packetId: "packet-rejected-tool",
        workerId: "worker-reject"
      })
    ]);
    const manipulationEvents = telemetry.events.filter(
      (event) => event.data?.event === "tool_path_outside_repo"
    );
    expect(manipulationEvents).toHaveLength(1);
    expect(manipulationEvents[0]).toMatchObject({
      stage: 7,
      level: "warn",
      workerId: "worker-reject",
      packetId: "packet-rejected-tool",
      data: { event: "tool_path_outside_repo", tool: "read_range" }
    });
  });

  it("redacts provider responses before appending them to the live conversation", async () => {
    clearRegisteredSecretsForTests();
    registerSecret("super-secret-provider-token");
    const adapter = scriptedAdapter([
      assistant([{ type: "text", text: "provider leaked super-secret-provider-token" }]),
      assistant([validSubmitReviewCall("submit-after-redaction")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", reasoning: "high", maxConcurrentCalls: 1 },
      telemetry: fakeTelemetry().recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: {
        checkpoint: () => "ok",
        onUsage: () => undefined
      }
    });

    await runner.runStructured(submitReviewRequest("packet-redaction"));

    expect(adapter.contexts[1]).not.toContain("super-secret-provider-token");
    expect(adapter.contexts[1]).toContain("[redacted:secret]");
    clearRegisteredSecretsForTests();
  });

  it("uses one timeout signal across provider and repository tool steps", async () => {
    const providerSignals: AbortSignal[] = [];
    const toolSignals: AbortSignal[] = [];
    const tool: ToolDefinition = {
      name: "read_range",
      description: "read",
      parameters: Type.Object({ path: Type.String() }),
      execute: vi.fn(async (_args, signal) => {
        toolSignals.push(signal);
        return {
          text: "line 1",
          meta: { backend: "text" as const, precision: "exact" as const, degraded: false }
        };
      })
    };
    const adapter: PiAiAdapter = {
      resolveModel: () => ({ provider: "fake", id: "fake-model", raw: { id: "fake-model" } }),
      complete: vi.fn(async (_model, _context, options) => {
        if (!(options.signal instanceof AbortSignal)) {
          throw new Error("missing abort signal");
        }
        providerSignals.push(options.signal);
        return providerSignals.length === 1
          ? assistant([
              {
                type: "toolCall",
                id: "tool-timeout-signal",
                name: "read_range",
                arguments: { path: "src/a.ts" }
              }
            ])
          : assistant([validSubmitReviewCall("submit-timeout-signal")]);
      }),
      validateToolCall: (tools, toolCall) => validateToolCall(tools, toolCall)
    };
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: fakeTelemetry().recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await runner.runStructured({
      ...submitReviewRequest("packet-timeout-signal"),
      tools: [tool],
      toolBudget: { maxToolCalls: 1, maxInvestigationRounds: 1, maxResultChars: 1000 }
    });

    expect(providerSignals).toHaveLength(2);
    expect(new Set(providerSignals).size).toBe(1);
    expect(toolSignals).toEqual([providerSignals[0]]);
  });

  it("times out provider calls even when the adapter ignores the abort signal", async () => {
    const telemetry = fakeTelemetry();
    const adapter: PiAiAdapter = {
      resolveModel: () => ({ provider: "fake", id: "fake-model", raw: { id: "fake-model" } }),
      complete: vi.fn(async () => new Promise<PiAssistantMessage>(() => undefined)),
      validateToolCall: (tools, toolCall) => validateToolCall(tools, toolCall)
    };
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(
      runner.runStructured({
        ...submitReviewRequest("packet-provider-timeout"),
        timeoutMs: 20
      })
    ).rejects.toMatchObject({
      code: "llm_call_failed",
      context: { reason: "timeout" }
    });

    expect(adapter.complete).toHaveBeenCalledTimes(1);
    expect(telemetry.events.map((event) => event.message)).toEqual(
      expect.arrayContaining(["model_call_queued", "model_call_started"])
    );
    expect(telemetry.modelCalls).toEqual([
      expect.objectContaining({
        status: "timeout",
        stopReason: "error",
        errorCode: "llm_call_failed"
      })
    ]);
    expect(debugRecord(telemetry, "mc-000001.request")).toMatchObject({
      artifactKind: "llm_call_request",
      callId: "mc-000001",
      kind: "initial"
    });
    expect(debugRecord(telemetry, "mc-000001.response")).toMatchObject({
      artifactKind: "llm_call_response",
      callId: "mc-000001",
      status: "timeout",
      errorCode: "llm_call_failed",
      error: { message: "LLM model task timed out" }
    });
  });

  it("routes a pass past its soft deadline to a forced finalize within the grace window", async () => {
    const telemetry = fakeTelemetry();
    const scripted = scriptedAdapter([
      assistant([
        { type: "toolCall", id: "tool-1", name: "read_range", arguments: { path: "src/a.ts", startLine: 1, endLine: 2 } }
      ]),
      assistant([
        { type: "toolCall", id: "submit-1", name: "submit_review", arguments: { findings: [], followUpHints: [], uncertainties: [] } }
      ])
    ]);
    const baseComplete = scripted.complete;
    let firstCall = true;
    const adapter: typeof scripted = {
      ...scripted,
      complete: vi.fn(async (model, context, options) => {
        if (firstCall) {
          firstCall = false;
          // Push past the 150ms soft deadline while staying inside soft+grace.
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return baseComplete(model, context, options);
      })
    };
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    const result = await runner.runStructured({
      ...submitReviewRequest("packet-soft-deadline"),
      tools: buildRepositoryToolDefinitions(fakeRepositoryTools()),
      toolBudget: { maxToolCalls: 3, maxInvestigationRounds: 3, maxResultChars: 2000 },
      timeoutMs: 150,
      telemetryContext: { workerId: "worker-1", packetId: "packet-soft-deadline" }
    });

    expect(result).toEqual({ findings: [], followUpHints: [], uncertainties: [] });
    expect(scripted.toolNames[1]).toEqual(["submit_review"]);
    expect(scripted.contexts[1]).toContain("time budget is exhausted");
    const finalizeStart = telemetry.events.find((event) => event.message === "full_finalize_started");
    expect(finalizeStart?.data).toMatchObject({ reason: "soft_deadline" });
    const graceUsed = telemetry.events.find((event) => event.message === "finalize_grace_used");
    expect(graceUsed?.data).toMatchObject({ graceMsUsed: expect.any(Number) });
    expect(telemetry.modelCalls[1]).toMatchObject({ kind: "finalize", status: "ok" });
  });

  it("records the effective provider protocol on model calls and emits provider_protocol once", async () => {
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([
      assistant([
        { type: "toolCall", id: "submit-1", name: "submit_review", arguments: { findings: [], followUpHints: [], uncertainties: [] } }
      ])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await runner.runStructured(submitReviewRequest("packet-protocol"));

    expect(telemetry.modelCalls[0]).toMatchObject({
      toolChoiceRequested: "forced:submit_review",
      toolChoiceEffective: "required",
      toolChoiceDowngraded: false,
      reasoningRequested: "high",
      reasoningMechanism: "unknown",
      reasoningLevelEffective: "high"
    });
    const protocolEvents = telemetry.events.filter((event) => event.message === "provider_protocol");
    expect(protocolEvents).toHaveLength(1);
    expect(protocolEvents[0]?.data).toMatchObject({
      api: "faux",
      forcedToolChoiceEffective: "required",
      toolChoiceDowngraded: false,
      reasoningMechanism: "unknown"
    });
    expect(telemetry.events.filter((event) => event.message === "tool_choice_downgraded")).toHaveLength(0);
  });

  it("records ttfb and rate-limit headers from the provider response", async () => {
    const telemetry = fakeTelemetry();
    const scripted = scriptedAdapter([
      assistant([
        { type: "toolCall", id: "submit-1", name: "submit_review", arguments: { findings: [], followUpHints: [], uncertainties: [] } }
      ])
    ]);
    const baseComplete = scripted.complete;
    const adapter: typeof scripted = {
      ...scripted,
      complete: vi.fn(async (model, context, options) => {
        const onResponse = (options as { onResponse?: (response: { status: number; headers: Record<string, string> }) => void }).onResponse;
        onResponse?.({
          status: 200,
          headers: {
            "request-id": "req_test123",
            "anthropic-ratelimit-input-tokens-remaining": "39000",
            "anthropic-ratelimit-input-tokens-limit": "40000",
            "content-type": "application/json"
          }
        });
        return baseComplete(model, context, options);
      })
    };
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await runner.runStructured(submitReviewRequest("packet-headers"));

    expect(telemetry.modelCalls[0]).toMatchObject({
      ttfbMs: expect.any(Number),
      providerHttpStatus: 200,
      providerRequestId: "req_test123",
      rateLimit: {
        "anthropic-ratelimit-input-tokens-remaining": "39000",
        "anthropic-ratelimit-input-tokens-limit": "40000"
      }
    });
    expect((telemetry.modelCalls[0] as { rateLimit?: Record<string, string> }).rateLimit).not.toHaveProperty("content-type");
  });

  it("surfaces the anthropic forced-tool-choice downgrade instead of staying silent", async () => {
    const telemetry = fakeTelemetry();
    const scripted = scriptedAdapter([
      assistant([
        { type: "toolCall", id: "submit-1", name: "submit_review", arguments: { findings: [], followUpHints: [], uncertainties: [] } }
      ])
    ]);
    const adapter: typeof scripted = {
      ...scripted,
      resolveModel: () => ({ provider: "anthropic", id: "fake-opus", raw: { id: "fake-opus", api: "anthropic-messages" } })
    };
    const runner = createPiRunner({
      llmConfig: { provider: "anthropic", model: "fake-opus", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await runner.runStructured(submitReviewRequest("packet-anthropic-protocol"));

    expect(telemetry.modelCalls[0]).toMatchObject({
      toolChoiceRequested: "forced:submit_review",
      toolChoiceEffective: "auto",
      toolChoiceDowngraded: true,
      reasoningMechanism: "adaptive-effort"
    });
    const downgraded = telemetry.events.filter((event) => event.message === "tool_choice_downgraded");
    expect(downgraded).toHaveLength(1);
    expect(downgraded[0]?.level).toBe("warn");
  });

  it("enforces maxConcurrentCalls across provider misses", async () => {
    const telemetry = fakeTelemetry();
    let active = 0;
    let maxActive = 0;
    const adapter: PiAiAdapter = {
      resolveModel: () => ({ provider: "fake", id: "fake-model", raw: { id: "fake-model" } }),
      complete: vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(25);
        active -= 1;
        return assistant([validSubmitReviewCall("submit-concurrent")]);
      }),
      validateToolCall: (tools, toolCall) => validateToolCall(tools, toolCall)
    };
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await Promise.all([
      runner.runStructured(submitReviewRequest("one")),
      runner.runStructured(submitReviewRequest("two")),
      runner.runStructured(submitReviewRequest("three"))
    ]);

    expect(maxActive).toBe(1);
  });

  it("passes stage-scoped Pi prompt cache hints and records debug visibility", async () => {
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([
      assistant([validSubmitReviewCall("submit-cache-hint-review")]),
      assistant([validSubmitVerdictCall("submit-cache-hint-verdict")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 2 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await runner.runStructured(submitReviewRequest("cache-hint-review"));
    await runner.runStructured({
      stage: 9,
      prompt: "verify cache hint",
      schema: SubmitVerificationVerdictSchema,
      templateVersion: "test-template",
      timeoutMs: 1000
    });

    expect(adapter.options).toEqual([
      expect.objectContaining({
        sessionId: "codegenie-phase4-llm-stage-7",
        cacheRetention: "short"
      }),
      expect.objectContaining({
        sessionId: "codegenie-phase4-llm-stage-9",
        cacheRetention: "short"
      })
    ]);
    const strategyEvents = telemetry.events.filter((event) => event.message === "provider_prompt_cache_strategy");
    expect(strategyEvents).toHaveLength(2);
    expect(strategyEvents).toEqual([
      expect.objectContaining({
        stage: 7,
        data: expect.objectContaining({
          strategy: "pi-session",
          sessionId: "codegenie-phase4-llm-stage-7",
          cacheRetention: "short",
          scope: "run-stage",
          explicitCacheBlocks: false,
          sessionIdHash: expect.any(String)
        })
      }),
      expect.objectContaining({
        stage: 9,
        data: expect.objectContaining({
          strategy: "pi-session",
          sessionId: "codegenie-phase4-llm-stage-9",
          cacheRetention: "short",
          scope: "run-stage",
          explicitCacheBlocks: false,
          sessionIdHash: expect.any(String)
        })
      })
    ]);
    expect(debugRecord(telemetry, "mc-000001.request")).toMatchObject({
      request: {
        providerPromptCache: {
          strategy: "pi-session",
          sessionId: "codegenie-phase4-llm-stage-7",
          cacheRetention: "short",
          scope: "run-stage",
          explicitCacheBlocks: false
        }
      }
    });
  });

  it("reuses identical deterministic repository tool results within one runner", async () => {
    const telemetry = fakeTelemetry();
    const readRange = vi.fn(async () => ({
      text: "cached source",
      meta: { backend: "text" as const, precision: "exact" as const, degraded: false }
    }));
    const tools: RepositoryTools = { ...fakeRepositoryTools(), readRange };
    const adapter: PiAiAdapter = {
      resolveModel: () => ({ provider: "fake", id: "fake-model", raw: { id: "fake-model" } }),
      complete: vi.fn(async (_model, context) => {
        const messages = context.messages as unknown[];
        if (messages.length === 1) {
          return assistant([
            {
              type: "toolCall",
              id: "read-cache",
              name: "read_range",
              arguments: { path: "src/a.ts", startLine: 1, endLine: 3 }
            }
          ]);
        }
        return assistant([validSubmitReviewCall(`submit-${messages.length}`)]);
      }),
      validateToolCall: (tools, toolCall) => validateToolCall(tools, toolCall)
    };
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 2 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      toolResultCache: createToolResultCache(),
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });
    const request = {
      ...submitReviewRequest("packet-cache"),
      tools: buildRepositoryToolDefinitions(tools),
      toolBudget: { maxToolCalls: 2, maxInvestigationRounds: 2, maxResultChars: 1000 }
    };

    await runner.runStructured(request);
    await runner.runStructured(request);

    expect(readRange).toHaveBeenCalledTimes(1);
    expect(telemetry.toolCalls).toHaveLength(2);
    expect(telemetry.toolCalls.map((call) => call.cacheStatus)).toEqual(["write", "hit"]);
    expect(telemetry.toolCalls.map((call) => call.backendExecuted)).toEqual([true, false]);
    expect(telemetry.toolCalls[1]?.cacheHitKind).toBe("stored");
  });

  it("coalesces concurrent identical repository tool requests in flight", async () => {
    const telemetry = fakeTelemetry();
    const readRange = vi.fn(async () => {
      await delay(50);
      return {
        text: "shared source",
        meta: { backend: "text" as const, precision: "exact" as const, degraded: false }
      };
    });
    const tools: RepositoryTools = { ...fakeRepositoryTools(), readRange };
    const adapter: PiAiAdapter = {
      resolveModel: () => ({ provider: "fake", id: "fake-model", raw: { id: "fake-model" } }),
      complete: vi.fn(async (_model, context) => {
        const messages = context.messages as unknown[];
        if (messages.length === 1) {
          return assistant([
            {
              type: "toolCall",
              id: "read-inflight",
              name: "read_range",
              arguments: { path: "src/a.ts", startLine: 1, endLine: 3 }
            }
          ]);
        }
        return assistant([validSubmitReviewCall(`submit-${messages.length}`)]);
      }),
      validateToolCall: (tools, toolCall) => validateToolCall(tools, toolCall)
    };
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 4 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      toolResultCache: createToolResultCache(),
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });
    const request = {
      ...submitReviewRequest("packet-inflight"),
      tools: buildRepositoryToolDefinitions(tools),
      toolBudget: { maxToolCalls: 1, maxInvestigationRounds: 1, maxResultChars: 1000 }
    };

    await Promise.all([runner.runStructured(request), runner.runStructured(request)]);

    expect(readRange).toHaveBeenCalledTimes(1);
    expect(telemetry.toolCalls).toHaveLength(2);
    expect(telemetry.toolCalls.map((call) => call.cacheStatus).sort()).toEqual(["hit", "write"]);
    expect(telemetry.toolCalls.filter((call) => call.backendExecuted === true)).toHaveLength(1);
    expect(telemetry.toolCalls.some((call) => call.cacheHitKind === "inflight")).toBe(true);
  });

  it("lets an in-flight cache waiter honor its own timeout", async () => {
    const telemetry = fakeTelemetry();
    const readRange = vi.fn(async () => {
      await delay(80);
      return {
        text: "slow shared source",
        meta: { backend: "text" as const, precision: "exact" as const, degraded: false }
      };
    });
    const tools: RepositoryTools = { ...fakeRepositoryTools(), readRange };
    const adapter: PiAiAdapter = {
      resolveModel: () => ({ provider: "fake", id: "fake-model", raw: { id: "fake-model" } }),
      complete: vi.fn(async (_model, context) => {
        const messages = context.messages as unknown[];
        if (messages.length === 1) {
          return assistant([
            {
              type: "toolCall",
              id: "read-inflight-timeout",
              name: "read_range",
              arguments: { path: "src/a.ts", startLine: 1, endLine: 3 }
            }
          ]);
        }
        return assistant([validSubmitReviewCall(`submit-${messages.length}`)]);
      }),
      validateToolCall: (tools, toolCall) => validateToolCall(tools, toolCall)
    };
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 4 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      toolResultCache: createToolResultCache(),
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });
    const request = {
      ...submitReviewRequest("packet-inflight-timeout"),
      tools: buildRepositoryToolDefinitions(tools),
      toolBudget: { maxToolCalls: 1, maxInvestigationRounds: 1, maxResultChars: 1000 },
      timeoutMs: 250
    };
    const first = runner.runStructured(request);
    await delay(5);
    const second = runner.runStructured({ ...request, timeoutMs: 20 });

    await expect(second).rejects.toMatchObject({
      code: "llm_call_failed",
      context: { reason: "timeout" }
    });
    await expect(first).resolves.toMatchObject({
      findings: [],
      followUpHints: [],
      uncertainties: []
    });

    expect(readRange).toHaveBeenCalledTimes(1);
    expect(telemetry.toolCalls).toHaveLength(1);
    expect(telemetry.toolCalls[0]).toMatchObject({
      cacheStatus: "write",
      backendExecuted: true
    });
  });

  it("does not cache repository tool errors", async () => {
    const telemetry = fakeTelemetry();
    const execute = vi.fn(async () => ({
      text: "tool error: invalid_args: bad range",
      isError: true,
      errorCode: "invalid_args" as const,
      meta: { backend: "text" as const, precision: "text" as const, degraded: true, degradationReason: "invalid_args" }
    }));
    const tool: ToolDefinition = {
      name: "read_range",
      description: "read range",
      parameters: Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      execute
    };
    const adapter: PiAiAdapter = {
      resolveModel: () => ({ provider: "fake", id: "fake-model", raw: { id: "fake-model" } }),
      complete: vi.fn(async (_model, context) => {
        const messages = context.messages as unknown[];
        if (messages.length === 1) {
          return assistant([{ type: "toolCall", id: "read-error", name: "read_range", arguments: { path: "src/a.ts" } }]);
        }
        return assistant([validSubmitReviewCall(`submit-${messages.length}`)]);
      }),
      validateToolCall: (tools, toolCall) => validateToolCall(tools, toolCall)
    };
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 2 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      toolResultCache: createToolResultCache(),
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });
    const request = {
      ...submitReviewRequest("packet-error-cache"),
      tools: [tool],
      toolBudget: { maxToolCalls: 1, maxInvestigationRounds: 1, maxResultChars: 1000 }
    };

    await runner.runStructured(request);
    await runner.runStructured(request);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(telemetry.toolCalls.map((call) => call.status)).toEqual(["error", "error"]);
    expect(telemetry.toolCalls.map((call) => call.cacheStatus)).toEqual(["miss", "miss"]);
    expect(telemetry.toolCalls.map((call) => call.backendExecuted)).toEqual([true, true]);
  });

  it("keeps different repository tool arguments in separate cache entries", async () => {
    const telemetry = fakeTelemetry();
    const readRange = vi.fn(async (_path: string, startLine: number) => ({
      text: `source from ${startLine}`,
      meta: { backend: "text" as const, precision: "exact" as const, degraded: false }
    }));
    const tools: RepositoryTools = { ...fakeRepositoryTools(), readRange };
    const requestedStarts = [1, 2];
    const adapter: PiAiAdapter = {
      resolveModel: () => ({ provider: "fake", id: "fake-model", raw: { id: "fake-model" } }),
      complete: vi.fn(async (_model, context) => {
        const messages = context.messages as unknown[];
        if (messages.length === 1) {
          const startLine = requestedStarts.shift() ?? 1;
          return assistant([
            {
              type: "toolCall",
              id: `read-${startLine}`,
              name: "read_range",
              arguments: { path: "src/a.ts", startLine, endLine: startLine + 1 }
            }
          ]);
        }
        return assistant([validSubmitReviewCall(`submit-${messages.length}`)]);
      }),
      validateToolCall: (tools, toolCall) => validateToolCall(tools, toolCall)
    };
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 2 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      toolResultCache: createToolResultCache(),
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });
    const request = {
      ...submitReviewRequest("packet-cache-args"),
      tools: buildRepositoryToolDefinitions(tools),
      toolBudget: { maxToolCalls: 1, maxInvestigationRounds: 1, maxResultChars: 1000 }
    };

    await runner.runStructured(request);
    await runner.runStructured(request);

    expect(readRange).toHaveBeenCalledTimes(2);
    expect(readRange.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    expect(telemetry.toolCalls.map((call) => call.cacheStatus)).toEqual(["write", "write"]);
  });

  it("records schema-invalid submits and does not cache them before repair", async () => {
    const telemetry = fakeTelemetry();
    const cache = {
      get: vi.fn(async (_key: string) => ({ status: "miss" as const, reason: "not_found" as const })),
      put: vi.fn(async (_key: string, _entry: StoredProviderResponse) => ({ status: "write" as const }))
    };
    const adapter = scriptedAdapter([
      assistant([
        {
          type: "toolCall",
          id: "submit-invalid",
          name: "submit_review",
          arguments: { packetId: "packet-1" }
        }
      ]),
      assistant([validSubmitReviewCall("submit-repair")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      cache,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(runner.runStructured(submitReviewRequest("packet-1"))).resolves.toMatchObject({
      findings: [],
      followUpHints: [],
      uncertainties: []
    });

    expect(telemetry.modelCalls.map((call) => call.status)).toEqual(["schema_invalid", "ok"]);
    expect(telemetry.modelCalls[0]).toMatchObject({
      schemaValid: false,
      errorCode: "llm_schema_invalid"
    });
    expect(telemetry.modelCalls.map((call) => call.cacheStatus)).toEqual(["miss", "write"]);
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(cache.put.mock.calls[0]?.[1].message.content).toEqual([validSubmitReviewCall("submit-repair")]);
  });

  it("requires planner responses to submit exactly one plan and repairs with replacement context", async () => {
    const telemetry = fakeTelemetry();
    const cache = {
      get: vi.fn(async (_key: string) => ({ status: "miss" as const, reason: "not_found" as const })),
      put: vi.fn(async (_key: string, _entry: StoredProviderResponse) => ({ status: "write" as const }))
    };
    const adapter = scriptedAdapter([
      assistant([validSubmitPlanCall("submit-plan-a"), validSubmitPlanCall("submit-plan-b")]),
      assistant([validSubmitPlanCall("submit-plan-repaired")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      cache,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });
    const originalPromptMarker = "ORIGINAL_PLANNER_PROMPT_SHOULD_NOT_BE_RESENT";

    await expect(runner.runStructured({
      stage: 5,
      prompt: `${originalPromptMarker} ${"x".repeat(12_000)}`,
      schema: SubmitPlanSchema,
      templateVersion: "test-template",
      timeoutMs: 1000,
      schemaRepair: {
        replaceConversation: true,
        buildPrompt: (input) => {
          expect(input.submitTool).toBe("submit_plan");
          expect(input.submitCalls.map((call) => call.id)).toEqual(["submit-plan-a", "submit-plan-b"]);
          return `compact planner repair for ${input.submitCalls.map((call) => call.id).join(",")}`;
        }
      }
    })).resolves.toMatchObject({
      diffUnderstanding: { declaredIntent: "test", inferredBehavior: "test" },
      coverage: []
    });

    expect(telemetry.modelCalls.map((call) => call.status)).toEqual(["schema_invalid", "ok"]);
    expect(telemetry.modelCalls.map((call) => call.kind)).toEqual(["initial", "repair"]);
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 5,
        message: "planner_schema_repair_scheduled",
        data: expect.objectContaining({
          submitTool: "submit_plan",
          invalidSubmitCallCount: 2,
          repairPromptChars: "compact planner repair for submit-plan-a,submit-plan-b".length,
          replaceConversation: true
        })
      })
    ]));
    expect(adapter.contexts[1]).toContain("compact planner repair");
    expect(adapter.contexts[1]).not.toContain(originalPromptMarker);
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(cache.put.mock.calls[0]?.[1].message.content).toEqual([validSubmitPlanCall("submit-plan-repaired")]);
  });

  it("repairs planner responses that omit submit_plan without generic finalization nudges", async () => {
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([
      assistant([{ type: "text", text: "plain planning text" }]),
      assistant([validSubmitPlanCall("submit-plan-after-missing")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(runner.runStructured({
      stage: 5,
      prompt: "planner",
      schema: SubmitPlanSchema,
      templateVersion: "test-template",
      timeoutMs: 1000,
      schemaRepair: {
        replaceConversation: true,
        buildPrompt: (input) => {
          expect(input.submitCalls).toEqual([]);
          return "compact missing-submit repair";
        }
      }
    })).resolves.toMatchObject({
      diffUnderstanding: { declaredIntent: "test", inferredBehavior: "test" }
    });

    expect(adapter.complete).toHaveBeenCalledTimes(2);
    expect(telemetry.modelCalls.map((call) => call.status)).toEqual(["schema_invalid", "ok"]);
    expect(telemetry.modelCalls.map((call) => call.kind)).toEqual(["initial", "repair"]);
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 5,
        message: "planner_schema_repair_scheduled",
        data: expect.objectContaining({ invalidSubmitCallCount: 0 })
      })
    ]));
  });

  it("can fail fast when planner schema repair is invalid twice", async () => {
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([
      assistant([validSubmitPlanCall("submit-plan-a"), validSubmitPlanCall("submit-plan-b")]),
      assistant([validSubmitPlanCall("submit-plan-c"), validSubmitPlanCall("submit-plan-d")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(runner.runStructured({
      stage: 5,
      prompt: "planner",
      schema: SubmitPlanSchema,
      templateVersion: "test-template",
      timeoutMs: 1000,
      schemaRepair: {
        replaceConversation: true,
        failAfterRepair: true,
        buildPrompt: () => "compact planner repair"
      }
    })).rejects.toMatchObject({
      code: "llm_schema_invalid",
      recoverable: false
    });

    expect(adapter.complete).toHaveBeenCalledTimes(2);
    expect(telemetry.modelCalls.map((call) => call.status)).toEqual(["schema_invalid", "schema_invalid"]);
  });

  it("repairs verifier schema-invalid submits with replacement context and submit-only tools", async () => {
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([
      assistant([{
        type: "toolCall",
        id: "submit-verdict-xml",
        name: "submit_verdict",
        arguments: { parameter: "<parameter>BAD_PRIOR_XML_BODY</parameter>" }
      }]),
      assistant([validSubmitVerdictCall("submit-verdict-repaired")])
    ]);
    const readRange: ToolDefinition = {
      name: "read_range",
      description: "read range",
      parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
      execute: vi.fn(async () => ({ text: "source", meta: { backend: "text" as const, precision: "exact" as const, degraded: false } }))
    };
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", reasoning: "high", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });
    const originalPromptMarker = "ORIGINAL_VERIFIER_PROMPT_SHOULD_NOT_BE_RESENT";

    await expect(runner.runStructured({
      stage: 9,
      prompt: `${originalPromptMarker} ${"x".repeat(4000)}`,
      schema: SubmitVerificationVerdictSchema,
      templateVersion: "test-template",
      tools: [readRange],
      timeoutMs: 1000,
      schemaRepair: {
        replaceConversation: true,
        failAfterRepair: false,
        buildPrompt: (input) => {
          expect(input.submitTool).toBe("submit_verdict");
          expect(input.submitCalls.map((call) => call.id)).toEqual(["submit-verdict-xml"]);
          expect(JSON.stringify(input.submitCalls[0]?.arguments)).toContain("BAD_PRIOR_XML_BODY");
          return [
            "compact verifier repair",
            "Do not output XML.",
            "Do not write `<parameter>` tags.",
            "Call `submit_verdict` exactly once."
          ].join("\n");
        }
      }
    })).resolves.toMatchObject({
      verdict: "reject",
      requiredEvidencePresent: false,
      falsePositiveRisk: "high"
    });

    expect(adapter.toolNames[0]).toEqual(["read_range", "submit_verdict"]);
    expect(adapter.toolNames[1]).toEqual(["submit_verdict"]);
    expect(adapter.options[1]).toMatchObject({ toolChoice: { type: "tool", name: "submit_verdict" } });
    expect(adapter.contexts[1]).toContain("compact verifier repair");
    expect(adapter.contexts[1]).toContain("Do not write `<parameter>` tags.");
    expect(adapter.contexts[1]).not.toContain(originalPromptMarker);
    expect(adapter.contexts[1]).not.toContain("BAD_PRIOR_XML_BODY");
    expect(telemetry.modelCalls.map((call) => call.kind)).toEqual(["initial", "repair"]);
    expect(telemetry.modelCalls.map((call) => call.status)).toEqual(["schema_invalid", "ok"]);
  });

  it("lets stages recover invalid submit arguments before model schema repair", async () => {
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([
      assistant([{
        type: "toolCall",
        id: "submit-composition-xml",
        name: "submit_composition",
        arguments: {
          summary: "summary</parameter><parameter name=\"composedFindings\">[]</parameter>"
        }
      }])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(runner.runStructured({
      stage: 10,
      prompt: "compose",
      schema: SubmitCompositionSchema,
      templateVersion: "test-template",
      timeoutMs: 1000,
      schemaRepair: {
        replaceConversation: true,
        buildPrompt: () => {
          throw new Error("model repair should not be needed");
        },
        recoverInvalidSubmit: (input) => {
          expect(input.submitTool).toBe("submit_composition");
          expect(input.submitCalls.map((call) => call.id)).toEqual(["submit-composition-xml"]);
          return {
            summary: "Recovered summary.",
            composedFindings: [{ findingIds: ["finding-1"], finalBody: "Recovered body.", publication: "inline" }]
          };
        }
      }
    })).resolves.toMatchObject({
      summary: "Recovered summary.",
      composedFindings: [{ findingIds: ["finding-1"], finalBody: "Recovered body.", publication: "inline" }]
    });

    expect(adapter.complete).toHaveBeenCalledTimes(1);
    expect(telemetry.modelCalls.map((call) => call.status)).toEqual(["schema_invalid"]);
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 10,
        message: "schema_invalid_submit_recovered",
        data: expect.objectContaining({ submitTool: "submit_composition" })
      })
    ]));
  });

  it("repairs composer responses that omit submit_composition with replacement context", async () => {
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([
      assistant([{ type: "text", text: "BAD_PRIOR_COMPOSER_TEXT" }]),
      assistant([{
        type: "toolCall",
        id: "submit-composition-repaired",
        name: "submit_composition",
        arguments: {
          summary: "Recovered composition.",
          composedFindings: [{ findingIds: ["finding-1"], finalBody: "Recovered body.", publication: "inline" }]
        }
      }])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });
    const originalPromptMarker = "ORIGINAL_COMPOSER_PROMPT_SHOULD_NOT_BE_RESENT";

    await expect(runner.runStructured({
      stage: 10,
      prompt: `${originalPromptMarker} compose`,
      schema: SubmitCompositionSchema,
      templateVersion: "test-template",
      timeoutMs: 1000,
      schemaRepair: {
        replaceConversation: true,
        buildPrompt: (input) => {
          expect(input.submitTool).toBe("submit_composition");
          expect(input.submitCalls).toEqual([]);
          return [
            "compact composer repair",
            "Do not output XML.",
            "Do not write `<parameter>` tags.",
            "Call `submit_composition` exactly once."
          ].join("\n");
        }
      }
    })).resolves.toMatchObject({
      summary: "Recovered composition.",
      composedFindings: [{ findingIds: ["finding-1"], finalBody: "Recovered body.", publication: "inline" }]
    });

    expect(adapter.complete).toHaveBeenCalledTimes(2);
    expect(adapter.contexts[1]).toContain("compact composer repair");
    expect(adapter.contexts[1]).not.toContain(originalPromptMarker);
    expect(adapter.contexts[1]).not.toContain("BAD_PRIOR_COMPOSER_TEXT");
    expect(telemetry.modelCalls.map((call) => call.kind)).toEqual(["initial", "repair"]);
    expect(telemetry.modelCalls.map((call) => call.status)).toEqual(["schema_invalid", "ok"]);
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 10,
        message: "schema_repair_scheduled",
        data: expect.objectContaining({ invalidSubmitCallCount: 0, replaceConversation: true })
      })
    ]));
  });

  it("makes one budget-exempt finalization provider call after checkpoint exhaustion", async () => {
    const adapter = scriptedAdapter([
      assistant([{ type: "text", text: "plain text instead of submit" }]),
      assistant([validSubmitReviewCall("must-not-run")])
    ]);
    let checkpoints = 0;
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: fakeTelemetry().recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: {
        checkpoint: () => {
          checkpoints += 1;
          return checkpoints === 1 ? "ok" : "exhausted";
        },
        onUsage: vi.fn()
      }
    });

    await expect(runner.runStructured(submitReviewRequest("packet-budget-stop"))).resolves.toMatchObject({
      findings: [],
      followUpHints: [],
      uncertainties: []
    });
    expect(adapter.complete).toHaveBeenCalledTimes(2);
    expect(checkpoints).toBe(2);
  });

  it("does not cache plain-text non-submissions", async () => {
    const cache = {
      get: vi.fn(async (_key: string) => ({ status: "miss" as const, reason: "not_found" as const })),
      put: vi.fn(async (_key: string, _entry: StoredProviderResponse) => ({ status: "write" as const }))
    };
    const adapter = scriptedAdapter([
      assistant([{ type: "text", text: "plain text instead of submit" }]),
      assistant([validSubmitReviewCall("must-not-run")])
    ]);
    let checkpoints = 0;
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: fakeTelemetry().recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      cache,
      hooks: {
        checkpoint: () => {
          checkpoints += 1;
          return checkpoints === 1 ? "ok" : "exhausted";
        },
        onUsage: vi.fn()
      }
    });

    await expect(runner.runStructured(submitReviewRequest("packet-plain-no-cache"))).resolves.toMatchObject({
      findings: [],
      followUpHints: [],
      uncertainties: []
    });
    expect(adapter.complete).toHaveBeenCalledTimes(2);
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(cache.put.mock.calls[0]?.[1].message.content).toEqual([validSubmitReviewCall("must-not-run")]);
  });

  it("includes tool budget in model-call cache keys", async () => {
    const cacheKeys: string[] = [];
    const cache = {
      get: vi.fn(async (key: string) => {
        cacheKeys.push(key);
        return { status: "miss" as const, reason: "not_found" as const };
      }),
      put: vi.fn(async (_key: string, _entry: StoredProviderResponse) => ({ status: "write" as const }))
    };
    const adapter = scriptedAdapter([
      assistant([validSubmitReviewCall("submit-budget-a")]),
      assistant([validSubmitReviewCall("submit-budget-b")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: fakeTelemetry().recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      cache,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await runner.runStructured({
      ...submitReviewRequest("same-packet"),
      toolBudget: { maxToolCalls: 1, maxInvestigationRounds: 1, maxResultChars: 100 }
    });
    await runner.runStructured({
      ...submitReviewRequest("same-packet"),
      toolBudget: { maxToolCalls: 2, maxInvestigationRounds: 1, maxResultChars: 100 }
    });

    expect(cache.get).toHaveBeenCalledTimes(2);
    expect(cacheKeys[0]).not.toBe(cacheKeys[1]);
  });

  it("uses canonical prompt hashes for matching cache misses and hits", async () => {
    const telemetry = fakeTelemetry();
    const entries = new Map<string, StoredProviderResponse>();
    const cache = {
      get: vi.fn(async (key: string) => {
        const entry = entries.get(key);
        return entry ? { status: "hit" as const, response: entry } : { status: "miss" as const, reason: "not_found" as const };
      }),
      put: vi.fn(async (key: string, entry: StoredProviderResponse) => {
        entries.set(key, entry);
        return { status: "write" as const };
      })
    };
    const adapter = scriptedAdapter([assistant([validSubmitReviewCall("submit-canonical-cache")])]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      cache,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await runner.runStructured(submitReviewRequest("packet-canonical"));
    await runner.runStructured(submitReviewRequest("packet-canonical"));

    expect(adapter.complete).toHaveBeenCalledTimes(1);
    expect(telemetry.modelCalls.map((call) => call.cacheStatus)).toEqual(["write", "hit"]);
    expect(telemetry.modelCalls[0]?.promptHash).toBe(telemetry.modelCalls[1]?.promptHash);
    expect(telemetry.modelCalls[0]?.promptChars).toBe(telemetry.modelCalls[1]?.promptChars);
    expect(telemetry.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 7,
          message: "model_call_cache_key_diagnostic",
          data: expect.objectContaining({
            missReason: "not_found",
            keyPrefix: expect.any(String),
            requestHash: expect.any(String),
            templateVersion: "test-template",
            toolBudgetHash: expect.any(String),
            toolSpecHash: expect.any(String),
            messageHash: expect.any(String),
            promptChars: expect.any(Number)
          })
        })
      ])
    );
    expect(debugRecord(telemetry, "mc-000002.request")).toMatchObject({
      artifactKind: "llm_call_request",
      cache: expect.objectContaining({ enabled: true, status: "hit" })
    });
  });

  it("records cacheable provider responses as misses when cache persistence fails", async () => {
    const telemetry = fakeTelemetry();
    const cache = {
      get: vi.fn(async (_key: string) => ({ status: "miss" as const, reason: "not_found" as const })),
      put: vi.fn(async (_key: string, _entry: StoredProviderResponse) => ({ status: "miss" as const, reason: "write_failed" as const }))
    };
    const adapter = scriptedAdapter([assistant([validSubmitReviewCall("submit-cache-write-failed")])]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      cache,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(runner.runStructured(submitReviewRequest("packet-cache-write-failed"))).resolves.toMatchObject({
      findings: [],
      followUpHints: [],
      uncertainties: []
    });

    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(telemetry.modelCalls).toEqual([
      expect.objectContaining({
        status: "ok",
        cacheStatus: "miss"
      })
    ]);
  });

  it("replays cache hits without provider budget usage or checkpoint calls", async () => {
    const telemetry = fakeTelemetry();
    const cache = {
      runFingerprint: "run-hit",
      get: vi.fn(async (_key: string) => ({ status: "hit" as const, response: cacheEntry(7) })),
      put: vi.fn(async (_key: string, _entry: StoredProviderResponse) => ({ status: "write" as const }))
    };
    const adapter: PiAiAdapter = {
      resolveModel: () => ({ provider: "fake", id: "fake-model", raw: { id: "fake-model" } }),
      complete: vi.fn(async () => assistant([validSubmitReviewCall("must-not-call-provider")])),
      validateToolCall: (tools, toolCall) => validateToolCall(tools, toolCall)
    };
    const checkpoint = vi.fn(() => "ok" as const);
    const onUsage = vi.fn();
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      cache,
      hooks: { checkpoint, onUsage }
    });

    await expect(runner.runStructured(submitReviewRequest("packet-hit"))).resolves.toEqual({
      findings: [],
      followUpHints: [],
      uncertainties: []
    });

    expect(adapter.complete).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
    expect(onUsage).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect(telemetry.modelCalls).toEqual([
      expect.objectContaining({
        cacheStatus: "hit",
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        costUSD: 0.01
      })
    ]);
    expect(debugRecord(telemetry, "mc-000001.request")).toMatchObject({
      artifactKind: "llm_call_request",
      cache: expect.objectContaining({ enabled: true, status: "hit", key: expect.any(String) })
    });
    expect(debugRecord(telemetry, "mc-000001.response")).toMatchObject({
      artifactKind: "llm_call_response",
      cacheStatus: "hit",
      response: { role: "assistant" }
    });
  });

  it("includes the run fingerprint in model-call cache keys", async () => {
    const keys: string[] = [];
    const cache = (runFingerprint: string) => ({
      runFingerprint,
      get: vi.fn(async (key: string) => {
        keys.push(key);
        return { status: "miss" as const, reason: "not_found" as const };
      }),
      put: vi.fn(async (_key: string, _entry: StoredProviderResponse) => ({ status: "write" as const }))
    });
    const adapter = scriptedAdapter([
      assistant([validSubmitReviewCall("submit-run-a")]),
      assistant([validSubmitReviewCall("submit-run-b")])
    ]);

    for (const runFingerprint of ["run-a", "run-b"]) {
      const runner = createPiRunner({
        llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
        telemetry: fakeTelemetry().recorder,
        logger: fakeLogger(),
        runSignal: new AbortController().signal,
        adapter,
        cache: cache(runFingerprint),
        hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
      });
      await runner.runStructured(submitReviewRequest("same-packet"));
    }

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("passes auto tool choice during investigation and forces submit-only calls", async () => {
    const tool: ToolDefinition = {
      name: "read_range",
      description: "read",
      parameters: Type.Object({ path: Type.String() }),
      execute: vi.fn(async () => ({
        text: "line 1",
        meta: { backend: "text" as const, precision: "exact" as const, degraded: false }
      }))
    };
    const investigative = scriptedAdapter([
      assistant([
        {
          type: "toolCall",
          id: "tool-choice-round",
          name: "read_range",
          arguments: { path: "src/a.ts" }
        }
      ]),
      assistant([validSubmitReviewCall("submit-forced-after-tool")])
    ]);
    const investigativeRunner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: fakeTelemetry().recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter: investigative,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await investigativeRunner.runStructured({
      ...submitReviewRequest("packet-tool-choice"),
      tools: [tool],
      toolBudget: { maxToolCalls: 1, maxInvestigationRounds: 1, maxResultChars: 1000 }
    });
    expect(investigative.options.map((options) => options.toolChoice)).toEqual([
      "auto",
      { type: "tool", name: "submit_review" }
    ]);

    const submitOnly = scriptedAdapter([assistant([validSubmitReviewCall("submit-forced-initial")])]);
    const submitOnlyRunner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: fakeTelemetry().recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter: submitOnly,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await submitOnlyRunner.runStructured(submitReviewRequest("packet-submit-only"));
    expect(submitOnly.options[0]?.toolChoice).toEqual({ type: "tool", name: "submit_review" });
  });

  it("uses full forced finalization for no-candidate packet closeout", async () => {
    const telemetry = fakeTelemetry();
    const tool: ToolDefinition = {
      name: "read_range",
      description: "read",
      parameters: Type.Object({ path: Type.String() }),
      execute: vi.fn(async () => ({
        text: `function decisive() {\n${"return true;\n".repeat(200)}}`,
        meta: { backend: "text" as const, precision: "exact" as const, degraded: false }
      }))
    };
    const adapter = scriptedAdapter([
      assistant([
        {
          type: "toolCall",
          id: "tool-before-full-finalize",
          name: "read_range",
          arguments: { path: "src/a.ts", startLine: 1, endLine: 80 }
        }
      ]),
      assistant([{
        type: "toolCall",
        id: "submit-full-no-findings",
        name: "submit_review",
        arguments: {
          reviewStatus: "no_findings",
          findings: [],
          followUpHints: [],
          uncertainties: [],
          noFindingReason: "Reviewed changed hunk and helper summary; no concrete failure mode."
        }
      }])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(
      runner.runStructured({
        ...submitReviewRequest("packet-full-finalize"),
        tools: [tool],
        toolBudget: { maxToolCalls: 1, maxInvestigationRounds: 2, maxResultChars: 5000 },
        telemetryContext: { workerId: "worker-full", packetId: "packet-full-finalize" },
        finalization: {
          noResultInstruction: "If there are no findings, submit reviewStatus:\"no_findings\", findings: []."
        }
      })
    ).resolves.toMatchObject({
      reviewStatus: "no_findings",
      findings: [],
      noFindingReason: "Reviewed changed hunk and helper summary; no concrete failure mode."
    });
    expect(adapter.contexts[1]).toContain("function decisive");
    expect(telemetry.modelCalls[1]).toMatchObject({
      kind: "finalize",
      finalizeMode: "full",
      finalizeTarget: "no_findings"
    });
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "full_finalize_started",
        packetId: "packet-full-finalize",
        data: expect.objectContaining({ mode: "full", target: "no_findings", reason: "tool_budget_exhausted" })
      })
    ]));
  });

  it("uses full forced finalization during packet closeout", async () => {
    const telemetry = fakeTelemetry();
    const tool: ToolDefinition = {
      name: "read_range",
      description: "read",
      parameters: Type.Object({ path: Type.String() }),
      execute: vi.fn(async () => ({
        text: "decisive source evidence",
        meta: { backend: "text" as const, precision: "exact" as const, degraded: false }
      }))
    };
    const adapter = scriptedAdapter([
      assistant([{
        type: "toolCall",
        id: "tool-before-full-finalize",
        name: "read_range",
        arguments: { path: "src/a.ts", startLine: 1, endLine: 2 }
      }]),
      assistant([{
        type: "toolCall",
        id: "submit-full-no-findings",
        name: "submit_review",
        arguments: {
          reviewStatus: "no_findings",
          findings: [],
          followUpHints: [{
            question: "Verify whether the changed branch still handles nil input.",
            files: ["src/a.ts"],
            symbols: ["decisive"],
            suggestedLenses: ["core/code-review"],
            reason: "The full transcript kept source context for a concrete unresolved predicate.",
            confidence: "medium"
          }],
          uncertainties: [],
          noFindingReason: "No concrete finding from gathered evidence."
        }
      }])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(
      runner.runStructured({
        ...submitReviewRequest("packet-full-finalize"),
        tools: [tool],
        toolBudget: { maxToolCalls: 1, maxInvestigationRounds: 2, maxResultChars: 5000 },
        telemetryContext: { workerId: "worker-full", packetId: "packet-full-finalize" },
        finalization: {
          noResultInstruction: "If there are no findings, submit reviewStatus:\"no_findings\", findings: []. Concrete unresolved risk may still use followUpHints or uncertainties."
        }
      })
    ).resolves.toMatchObject({
      reviewStatus: "no_findings",
      findings: [],
      followUpHints: [expect.objectContaining({ files: ["src/a.ts"] })]
    });
    expect(adapter.contexts[1]).toContain("decisive source evidence");
    expect(adapter.contexts[1]).toContain("Concrete unresolved risk may still use followUpHints");
    expect(telemetry.modelCalls[1]).toMatchObject({
      kind: "finalize",
      finalizeMode: "full",
      finalizeTarget: "no_findings"
    });
  });

  it("salvages Stage 7 XML-bleed no-finding submits without failing the packet", async () => {
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([
      assistant([{
        type: "toolCall",
        id: "submit-xml-no-findings",
        name: "submit_review",
        arguments: {
          reviewStatus: "no_findings",
          noFindingReason: "Reviewed the packet and found no concrete failure mode.</noFindingReason>\n<parameter name=\"findings\">[]"
        }
      }])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(
      runner.runStructured({
        ...submitReviewRequest("packet-xml-no-findings"),
        telemetryContext: { packetId: "packet-xml-no-findings" }
      })
    ).resolves.toMatchObject({
      reviewStatus: "no_findings",
      findings: [],
      followUpHints: [],
      uncertainties: [],
      noFindingReason: expect.stringContaining("Reviewed the packet")
    });
    expect(adapter.contexts).toHaveLength(1);
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 7,
        message: "stage7_schema_repair_attempted",
        packetId: "packet-xml-no-findings",
        data: expect.objectContaining({ classification: "xml_parameter_bleed" })
      }),
      expect.objectContaining({
        stage: 7,
        message: "stage7_schema_repair_recovered",
        packetId: "packet-xml-no-findings",
        data: expect.objectContaining({ classification: "xml_parameter_bleed" })
      })
    ]));
  });

  it("strips harmless extra candidate fields before model repair", async () => {
    const telemetry = fakeTelemetry();
    const candidate = validCandidateReviewFinding();
    const adapter = scriptedAdapter([
      assistant([{
        type: "toolCall",
        id: "submit-candidate-extra-empty-field",
        name: "submit_review",
        arguments: {
          findings: [{ ...candidate, category_note: "" }],
          followUpHints: [],
          uncertainties: []
        }
      }])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(
      runner.runStructured({
        ...submitReviewRequest("packet-candidate-cleanup"),
        telemetryContext: { packetId: "packet-candidate-cleanup" }
      })
    ).resolves.toMatchObject({
      findings: [expect.objectContaining({ title: candidate.title })]
    });
    expect(adapter.contexts).toHaveLength(1);
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 7,
        message: "stage7_schema_cleanup_attempted",
        packetId: "packet-candidate-cleanup",
        data: expect.objectContaining({
          cleanupKind: "candidate_payload",
          classification: "extra_finding_properties",
          strippedKeys: ["findings.0.category_note"]
        })
      }),
      expect.objectContaining({
        stage: 7,
        message: "stage7_schema_cleanup_recovered",
        packetId: "packet-candidate-cleanup",
        data: expect.objectContaining({
          cleanupKind: "candidate_payload",
          classification: "extra_finding_properties",
          strippedKeys: ["findings.0.category_note"]
        })
      })
    ]));
  });

  it("truncates overlong Stage 7 no-finding reasons before model repair", async () => {
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([
      assistant([{
        type: "toolCall",
        id: "submit-long-no-findings",
        name: "submit_review",
        arguments: {
          reviewStatus: "no_findings",
          findings: [],
          followUpHints: [{
            question: "Does any caller rely on the old edge behavior?",
            files: ["app.ts"],
            symbols: ["handler"],
            suggestedLenses: ["core/code-review"],
            reason: "The packet found a concrete predicate worth checking, but no local failure mode.",
            confidence: "medium"
          }],
          uncertainties: [],
          noFindingReason: `No concrete issue found. ${"detail ".repeat(260)}`
        }
      }])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    const result = (await runner.runStructured({
      ...submitReviewRequest("packet-long-no-findings"),
      telemetryContext: { packetId: "packet-long-no-findings" }
    })) as SubmitPacketReview;

    expect(result).toMatchObject({ reviewStatus: "no_findings", findings: [] });
    expect(result.followUpHints).toEqual([
      expect.objectContaining({
        question: "Does any caller rely on the old edge behavior?",
        confidence: "medium"
      })
    ]);
    expect(result.noFindingReason).toHaveLength(1000);
    expect(result.noFindingReason).toContain("[truncated by codegenie]");
    expect(adapter.contexts).toHaveLength(1);
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 7,
        message: "stage7_schema_cleanup_recovered",
        packetId: "packet-long-no-findings",
        data: expect.objectContaining({ cleanupKind: "no_finding_reason_truncated" })
      }),
      expect.objectContaining({
        stage: 7,
        message: "stage7_no_finding_reason_truncated",
        packetId: "packet-long-no-findings"
      })
    ]));
  });

  it("strips redundant candidate anchor fields before model repair", async () => {
    const telemetry = fakeTelemetry();
    const anchor = { path: "src/a.ts", line: 12, side: "RIGHT", hunkId: "hunk-a" };
    const candidate: Record<string, unknown> = { ...validCandidateReviewFinding(), anchor };
    const adapter = scriptedAdapter([
      assistant([{
        type: "toolCall",
        id: "submit-candidate-extra-anchor-fields",
        name: "submit_review",
        arguments: {
          findings: [{
            ...candidate,
            line: anchor.line,
            hunkId: anchor.hunkId,
            changedLine: true,
            filePath: "src/a.ts"
          }],
          followUpHints: [],
          uncertainties: []
        }
      }])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(
      runner.runStructured({
        ...submitReviewRequest("packet-candidate-anchor-cleanup"),
        telemetryContext: { packetId: "packet-candidate-anchor-cleanup" }
      })
    ).resolves.toMatchObject({
      findings: [expect.objectContaining({ title: "Candidate finding" })]
    });
    expect(adapter.contexts).toHaveLength(1);
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 7,
        message: "stage7_schema_cleanup_recovered",
        packetId: "packet-candidate-anchor-cleanup",
        data: expect.objectContaining({
          cleanupKind: "candidate_payload",
          classification: "extra_finding_properties",
          strippedKeys: [
            "findings.0.changedLine",
            "findings.0.filePath",
            "findings.0.hunkId",
            "findings.0.line"
          ]
        })
      })
    ]));
  });

  it("salvages a no-findings packet whose prose mentions candidate/title without misrouting to candidate repair", async () => {
    // Regression guard for the run-24 misclassification: a no_findings payload whose prose
    // happens to contain words like "candidate" or "title" must NOT be treated as a candidate
    // submission. It should be salvaged deterministically as no_findings (no model re-prompt),
    // with its follow-up hint preserved.
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([
      assistant([{
        type: "toolCall",
        id: "submit-prose-no-findings",
        name: "submit_review",
        arguments: {
          reviewStatus: "no_findings",
          findings: [],
          followUpHints: [{
            question: "Does any caller depend on the old fallback?",
            files: ["app.ts"],
            symbols: ["handler"],
            suggestedLenses: ["core/code-review"],
            reason: "Concrete predicate worth checking, but no local failure mode in this packet.",
            confidence: "medium"
          }],
          uncertainties: [],
          noFindingReason: `This could be a candidate for a future refactor, and the function title changed, but no concrete failure mode exists. ${"detail ".repeat(200)}`
        }
      }])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    const result = (await runner.runStructured({
      ...submitReviewRequest("packet-prose-no-findings"),
      telemetryContext: { packetId: "packet-prose-no-findings" }
    })) as SubmitPacketReview;

    expect(result).toMatchObject({ reviewStatus: "no_findings", findings: [] });
    // Deterministic salvage: no second model call (would-be candidate repair re-prompts).
    expect(adapter.contexts).toHaveLength(1);
    expect(result.followUpHints).toEqual([
      expect.objectContaining({ question: "Does any caller depend on the old fallback?", confidence: "medium" })
    ]);
    // Prose preserved as the no-finding reason rather than stripped as a candidate payload.
    expect(result.noFindingReason).toContain("candidate");
    expect(result.noFindingReason).toHaveLength(1000);
  });

  it("repairs candidate-shaped invalid submissions with compact replacement context", async () => {
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([
      assistant([{
        type: "toolCall",
        id: "submit-invalid-candidate",
        name: "submit_review",
        arguments: {
          findings: [{ title: "candidate was drafted" }],
          followUpHints: [],
          uncertainties: []
        }
      }]),
      assistant([validCandidateSubmitReviewCall("submit-valid-after-candidate-repair")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(
      runner.runStructured({
        ...submitReviewRequest("packet-candidate-repair"),
        telemetryContext: { packetId: "packet-candidate-repair" }
      })
    ).resolves.toMatchObject({ findings: [expect.objectContaining({ title: "Candidate finding" })] });
    expect(adapter.contexts[1]).toContain("Repair only the structured Stage 7 packet-review submit payload");
    expect(adapter.contexts[1]).toContain("stage7-invalid-submit-arguments");
    expect(adapter.contexts[1]).not.toContain("review packet-candidate-repair");
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 7,
        message: "stage7_schema_repair_attempted",
        packetId: "packet-candidate-repair",
        data: expect.objectContaining({ classification: "missing_required_finding_fields" })
      }),
      expect.objectContaining({
        stage: 7,
        message: "stage7_schema_compact_repair_scheduled",
        packetId: "packet-candidate-repair",
        data: expect.objectContaining({
          classification: "missing_required_finding_fields",
          replaceConversation: true
        })
      }),
      expect.objectContaining({
        stage: 7,
        message: "stage7_schema_repair_recovered",
        packetId: "packet-candidate-repair",
        data: expect.objectContaining({ classification: "schema_valid_after_retry" })
      })
    ]));
  });

  it("does not strip substantive unknown candidate fields before compact repair", async () => {
    const telemetry = fakeTelemetry();
    const candidate = validCandidateReviewFinding();
    const adapter = scriptedAdapter([
      assistant([{
        type: "toolCall",
        id: "submit-candidate-extra-substantive-field",
        name: "submit_review",
        arguments: {
          findings: [{ ...candidate, category_note: "Model intended this as a correctness issue." }],
          followUpHints: [],
          uncertainties: []
        }
      }]),
      assistant([validCandidateSubmitReviewCall("submit-repaired-substantive-field")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(
      runner.runStructured({
        ...submitReviewRequest("packet-candidate-substantive-extra"),
        telemetryContext: { packetId: "packet-candidate-substantive-extra" }
      })
    ).resolves.toMatchObject({ findings: [expect.objectContaining({ title: "Candidate finding" })] });

    expect(adapter.contexts).toHaveLength(2);
    expect(adapter.contexts[1]).toContain("category_note");
    expect(adapter.contexts[1]).not.toContain("review packet-candidate-substantive-extra");
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 7,
        message: "stage7_schema_cleanup_rejected",
        packetId: "packet-candidate-substantive-extra",
        data: expect.objectContaining({
          classification: "extra_finding_properties",
          rejectReason: expect.stringContaining("unsafe_unknown_fields")
        })
      }),
      expect.objectContaining({
        stage: 7,
        message: "stage7_schema_compact_repair_scheduled",
        packetId: "packet-candidate-substantive-extra",
        data: expect.objectContaining({ replaceConversation: true })
      })
    ]));
  });

  it("does not guess invalid candidate enum values locally", async () => {
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([
      assistant([{
        type: "toolCall",
        id: "submit-candidate-invalid-enum",
        name: "submit_review",
        arguments: {
          findings: [{ ...validCandidateReviewFinding(), category: "bug" }],
          followUpHints: [],
          uncertainties: []
        }
      }]),
      assistant([validCandidateSubmitReviewCall("submit-repaired-invalid-enum")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(
      runner.runStructured({
        ...submitReviewRequest("packet-candidate-invalid-enum"),
        telemetryContext: { packetId: "packet-candidate-invalid-enum" }
      })
    ).resolves.toMatchObject({ findings: [expect.objectContaining({ category: "correctness" })] });
    expect(adapter.contexts[1]).not.toContain("review packet-candidate-invalid-enum");
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 7,
        message: "stage7_schema_compact_repair_scheduled",
        packetId: "packet-candidate-invalid-enum",
        data: expect.objectContaining({ classification: "invalid_enum_value" })
      })
    ]));
  });

  it("fails Stage 7 schema repair after a second malformed candidate-shaped submit", async () => {
    const telemetry = fakeTelemetry();
    const invalidCandidate = (id: string): PiToolCall => ({
      type: "toolCall",
      id,
      name: "submit_review",
      arguments: {
        findings: [{ title: "candidate was drafted" }],
        followUpHints: [],
        uncertainties: []
      }
    });
    const adapter = scriptedAdapter([
      assistant([invalidCandidate("submit-invalid-candidate-1")]),
      assistant([invalidCandidate("submit-invalid-candidate-2")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(
      runner.runStructured({
        ...submitReviewRequest("packet-candidate-repair-fails"),
        telemetryContext: { packetId: "packet-candidate-repair-fails" }
      })
    ).rejects.toMatchObject({ code: "llm_schema_invalid" });
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 7,
        message: "stage7_schema_repair_failed",
        packetId: "packet-candidate-repair-fails",
        data: expect.objectContaining({ classification: "missing_required_finding_fields" })
      })
    ]));
  });

  it("rejects candidate repair that downgrades malformed findings to no-findings", async () => {
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([
      assistant([{
        type: "toolCall",
        id: "submit-invalid-candidate",
        name: "submit_review",
        arguments: {
          findings: [{ title: "candidate was drafted" }],
          followUpHints: [],
          uncertainties: []
        }
      }]),
      assistant([validSubmitReviewCall("submit-no-findings-after-candidate-repair")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(
      runner.runStructured({
        ...submitReviewRequest("packet-candidate-not-no-findings"),
        telemetryContext: { packetId: "packet-candidate-not-no-findings" }
      })
    ).rejects.toMatchObject({ code: "llm_schema_invalid" });
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 7,
        message: "stage7_schema_repair_failed",
        packetId: "packet-candidate-not-no-findings",
        data: expect.objectContaining({ classification: "unsafe_candidate_like_payload" })
      })
    ]));
  });

  it("does not salvage no-findings after a prior candidate-shaped Stage 7 submit", async () => {
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([
      assistant([{
        type: "toolCall",
        id: "submit-invalid-candidate",
        name: "submit_review",
        arguments: {
          findings: [{ title: "candidate was drafted" }],
          followUpHints: [],
          uncertainties: []
        }
      }]),
      assistant([{
        type: "toolCall",
        id: "submit-xml-no-findings-after-candidate",
        name: "submit_review",
        arguments: {
          reviewStatus: "no_findings",
          noFindingReason: "No findings.</noFindingReason><parameter name=\"findings\">[]"
        }
      }])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(
      runner.runStructured({
        ...submitReviewRequest("packet-no-salvage-after-candidate"),
        telemetryContext: { packetId: "packet-no-salvage-after-candidate" }
      })
    ).rejects.toMatchObject({ code: "llm_schema_invalid" });
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 7,
        message: "stage7_schema_repair_failed",
        packetId: "packet-no-salvage-after-candidate",
        data: expect.objectContaining({ classification: "unsafe_candidate_like_payload" })
      })
    ]));
  });

  it("adds configured post-tool close nudges before continuing packet review", async () => {
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([
      assistant([
        {
          type: "toolCall",
          id: "tool-before-nudge",
          name: "read_range",
          arguments: { path: "src/a.ts" }
        }
      ]),
      assistant([validSubmitReviewCall("submit-after-nudge")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await runner.runStructured({
      ...submitReviewRequest("packet-nudge"),
      tools: [{
        name: "read_range",
        description: "read",
        parameters: Type.Object({ path: Type.String() }),
        execute: vi.fn(async () => ({ text: "line 1", meta: { backend: "text" as const, precision: "exact" as const, degraded: false } }))
      }],
      toolBudget: { maxToolCalls: 3, maxInvestigationRounds: 3, maxResultChars: 1000 },
      finalization: {
        buildPostToolNudge: () => "NUDGE: submit no findings unless the next tool is decisive."
      }
    });
    expect(adapter.contexts[1]).toContain("NUDGE: submit no findings");
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "post_tool_close_nudge" })
    ]));
  });

  it("normalizes tuple schemas to draft 2020-12 for provider tool registration", async () => {
    const providerToolsSeen: Array<Array<{ name: string; parameters: Record<string, unknown> }>> = [];
    const adapter: PiAiAdapter = {
      resolveModel: () => ({ provider: "fake", id: "fake-model", raw: { id: "fake-model" } }),
      complete: vi.fn(async (_model, context) => {
        providerToolsSeen.push(context.tools as Array<{ name: string; parameters: Record<string, unknown> }>);
        return assistant([validSubmitPlanCall("submit-plan-normalized-schema")]);
      }),
      validateToolCall: (tools, toolCall) => validateToolCall(tools, toolCall)
    };
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: fakeTelemetry().recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await runner.runStructured({
      stage: 5,
      prompt: "plan",
      schema: SubmitPlanSchema,
      templateVersion: "test-template",
      timeoutMs: 1000
    });

    const submitPlan = providerToolsSeen[0]?.find((tool) => tool.name === "submit_plan");
    const coverage = (submitPlan?.parameters.properties as Record<string, unknown>).coverage as Record<string, unknown>;
    const coverageItem = coverage.items as Record<string, unknown>;
    const coverageItemRequired = coverageItem.required as string[] | undefined;
    expect(coverageItemRequired ?? []).not.toContain("surroundingContextHints");
    const hints = (coverageItem.properties as Record<string, unknown>).surroundingContextHints as Record<string, unknown>;
    const hintItem = hints.items as Record<string, unknown>;
    const hintProperties = hintItem.properties as Record<string, unknown>;
    expect(hintProperties.kind).toMatchObject({
      description: expect.stringContaining("Mechanical context retrieval mode")
    });
    expect(hintProperties.symbol).toMatchObject({
      description: expect.stringContaining("For call_site, the callee/helper")
    });
    const lineRangeSchema = hintProperties.lineRange as Record<string, unknown>;
    expect(lineRangeSchema).toMatchObject({
      prefixItems: [expect.objectContaining({ type: "integer" }), expect.objectContaining({ type: "integer" })],
      items: false
    });
    expect(lineRangeSchema).not.toHaveProperty("additionalItems");
  });

  it("rejects tools before execution when result-character budget is exhausted", async () => {
    const telemetry = fakeTelemetry();
    const execute = vi.fn(async () => ({
      text: "should not execute",
      meta: { backend: "text" as const, precision: "exact" as const, degraded: false }
    }));
    const tool: ToolDefinition = {
      name: "read_range",
      description: "read",
      parameters: Type.Object({ path: Type.String() }),
      execute
    };
    const adapter = scriptedAdapter([
      assistant([
        {
          type: "toolCall",
          id: "tool-budget",
          name: "read_range",
          arguments: { path: "src/a.ts" }
        }
      ]),
      assistant([validSubmitReviewCall("submit-after-budget")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await runner.runStructured({
      ...submitReviewRequest("packet-budget"),
      tools: [tool],
      toolBudget: { maxToolCalls: 2, maxInvestigationRounds: 2, maxResultChars: 0 }
    });

    expect(execute).not.toHaveBeenCalled();
    expect(telemetry.toolCalls[0]).toMatchObject({
      status: "rejected",
      degradationReason: "tool_result_budget_exhausted",
      budgetState: {
        toolCallsUsed: 0,
        maxToolCalls: 2,
        investigationRoundsUsed: 1,
        maxInvestigationRounds: 2,
        resultCharsUsed: 0,
        maxResultChars: 0,
        remainingResultChars: 0
      },
      resultChars: 0
    });
    expect(telemetry.toolCalls[0]?.degradationReason).not.toBe("budget_or_tool_rejected");
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "tool_call_rejected",
        data: expect.objectContaining({
          tool: "read_range",
          reason: "tool_result_budget_exhausted",
          budgetState: expect.objectContaining({ remainingResultChars: 0 })
        })
      })
    ]));
    expect(toolDebugRecord(telemetry, "mc-000001.tool-budget")).toMatchObject({
      artifactKind: "tool_call",
      outcome: {
        status: "rejected",
        rejectionReason: "tool_result_budget_exhausted",
        degradationReason: "tool_result_budget_exhausted",
        budgetState: expect.objectContaining({ maxResultChars: 0 })
      }
    });
  });

  it("uses source budget extension for exact reads after result budget exhaustion", async () => {
    const telemetry = fakeTelemetry();
    const execute = vi.fn(async () => ({
      text: "decisive helper branch",
      meta: { backend: "text" as const, precision: "exact" as const, degraded: false }
    }));
    const tool: ToolDefinition = {
      name: "read_range",
      description: "read",
      parameters: Type.Object({ path: Type.String(), startLine: Type.Number(), endLine: Type.Number() }),
      execute
    };
    const adapter = scriptedAdapter([
      assistant([
        {
          type: "toolCall",
          id: "tool-extension",
          name: "read_range",
          arguments: { path: "src/a.ts", startLine: 10, endLine: 20 }
        }
      ]),
      assistant([validSubmitReviewCall("submit-after-extension")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await runner.runStructured({
      ...submitReviewRequest("packet-extension"),
      tools: [tool],
      toolBudget: {
        maxToolCalls: 2,
        maxInvestigationRounds: 2,
        maxResultChars: 0,
        sourceExtension: { maxToolCalls: 1, maxResultChars: 1000 }
      }
    });

    expect(execute).toHaveBeenCalledWith(
      { path: "src/a.ts", startLine: 10, endLine: 20 },
      expect.any(AbortSignal)
    );
    expect(telemetry.toolCalls[0]).toMatchObject({
      status: "ok",
      budgetState: expect.objectContaining({
        maxResultChars: 0,
        sourceExtensionActive: true,
        sourceExtensionCallsUsed: 0,
        sourceExtensionMaxCalls: 1,
        sourceExtensionResultCharsUsed: 0,
        sourceExtensionMaxResultChars: 1000,
        toolResultCharLimit: 1000
      }),
      resultChars: "decisive helper branch".length
    });
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "tool_budget_extension_granted",
        data: expect.objectContaining({
          tool: "read_range",
          triggerReason: "tool_result_budget_exhausted",
          resultChars: "decisive helper branch".length
        })
      })
    ]));
    expect(telemetry.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "tool_call_rejected" })
    ]));
  });

  it("does not extend broad tools after local budget exhaustion", async () => {
    const telemetry = fakeTelemetry();
    const execute = vi.fn(async () => ({
      text: "should not execute",
      meta: { backend: "text" as const, precision: "text" as const, degraded: false }
    }));
    const tool: ToolDefinition = {
      name: "search_files",
      description: "search",
      parameters: Type.Object({ query: Type.String() }),
      execute
    };
    const adapter = scriptedAdapter([
      assistant([
        {
          type: "toolCall",
          id: "tool-broad-extension",
          name: "search_files",
          arguments: { query: "helper" }
        }
      ]),
      assistant([validSubmitReviewCall("submit-after-broad-denied")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await runner.runStructured({
      ...submitReviewRequest("packet-broad-extension"),
      tools: [tool],
      toolBudget: {
        maxToolCalls: 2,
        maxInvestigationRounds: 2,
        maxResultChars: 0,
        sourceExtension: { maxToolCalls: 1, maxResultChars: 1000 }
      }
    });

    expect(execute).not.toHaveBeenCalled();
    expect(telemetry.toolCalls[0]).toMatchObject({
      status: "rejected",
      degradationReason: "tool_result_budget_exhausted"
    });
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "tool_budget_extension_denied",
        data: expect.objectContaining({
          tool: "search_files",
          triggerReason: "tool_result_budget_exhausted",
          denyReason: "not_exact_source_tool"
        })
      }),
      expect.objectContaining({
        message: "tool_call_rejected",
        data: expect.objectContaining({
          tool: "search_files",
          reason: "tool_result_budget_exhausted"
        })
      })
    ]));
  });

  it("does not grant source budget extensions after global budget exhaustion", async () => {
    const telemetry = fakeTelemetry();
    const execute = vi.fn(async () => ({
      text: "should not execute",
      meta: { backend: "text" as const, precision: "exact" as const, degraded: false }
    }));
    const tool: ToolDefinition = {
      name: "read_range",
      description: "read",
      parameters: Type.Object({ path: Type.String(), startLine: Type.Number(), endLine: Type.Number() }),
      execute
    };
    const adapter = scriptedAdapter([
      assistant([
        {
          type: "toolCall",
          id: "tool-global-exhausted",
          name: "read_range",
          arguments: { path: "src/a.ts", startLine: 10, endLine: 20 }
        }
      ]),
      assistant([validSubmitReviewCall("submit-after-global-extension-denied")])
    ]);
    const checkpoint = vi.fn()
      .mockReturnValueOnce("ok")
      .mockReturnValue("exhausted");
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint, onUsage: vi.fn() }
    });

    await runner.runStructured({
      ...submitReviewRequest("packet-global-extension-denied"),
      tools: [tool],
      toolBudget: {
        maxToolCalls: 2,
        maxInvestigationRounds: 2,
        maxResultChars: 0,
        sourceExtension: { maxToolCalls: 1, maxResultChars: 1000 }
      }
    });

    expect(execute).not.toHaveBeenCalled();
    expect(telemetry.toolCalls[0]).toMatchObject({
      status: "rejected",
      degradationReason: "tool_result_budget_exhausted"
    });
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "tool_budget_extension_denied",
        data: expect.objectContaining({
          tool: "read_range",
          triggerReason: "tool_result_budget_exhausted",
          denyReason: "global_budget_exhausted"
        })
      })
    ]));
  });

  it("does not grant source budget extensions for unsafe path arguments", async () => {
    const telemetry = fakeTelemetry();
    const execute = vi.fn(async () => ({
      text: "should not execute",
      meta: { backend: "text" as const, precision: "exact" as const, degraded: false }
    }));
    const tool: ToolDefinition = {
      name: "read_range",
      description: "read",
      parameters: Type.Object({ path: Type.String(), startLine: Type.Number(), endLine: Type.Number() }),
      execute
    };
    const adapter = scriptedAdapter([
      assistant([
        {
          type: "toolCall",
          id: "tool-unsafe-extension",
          name: "read_range",
          arguments: { path: "../secret.ts", startLine: 1, endLine: 2 }
        }
      ]),
      assistant([validSubmitReviewCall("submit-after-unsafe-extension-denied")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await runner.runStructured({
      ...submitReviewRequest("packet-unsafe-extension-denied"),
      tools: [tool],
      toolBudget: {
        maxToolCalls: 2,
        maxInvestigationRounds: 2,
        maxResultChars: 0,
        sourceExtension: { maxToolCalls: 1, maxResultChars: 1000 }
      }
    });

    expect(execute).not.toHaveBeenCalled();
    expect(telemetry.toolCalls[0]).toMatchObject({
      status: "rejected",
      degradationReason: "tool_result_budget_exhausted"
    });
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "tool_budget_extension_denied",
        data: expect.objectContaining({
          tool: "read_range",
          triggerReason: "tool_result_budget_exhausted",
          denyReason: "unsafe_path_arg"
        })
      })
    ]));
    expect(telemetry.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "tool_budget_extension_granted" })
    ]));
  });

  it("does not treat repository safety rejections as source budget extensions", async () => {
    const telemetry = fakeTelemetry();
    const execute = vi.fn(async () => ({
      text: "tool error: path outside repository root",
      isError: true,
      errorCode: "path_outside_repo" as const,
      meta: { backend: "text" as const, precision: "text" as const, degraded: true, degradationReason: "path_outside_repo" }
    }));
    const tool: ToolDefinition = {
      name: "read_range",
      description: "read",
      parameters: Type.Object({ path: Type.String(), startLine: Type.Number(), endLine: Type.Number() }),
      execute
    };
    const adapter = scriptedAdapter([
      assistant([
        {
          type: "toolCall",
          id: "tool-path-outside",
          name: "read_range",
          arguments: { path: "../secret.ts", startLine: 1, endLine: 2 }
        }
      ]),
      assistant([validSubmitReviewCall("submit-after-path-outside")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await runner.runStructured({
      ...submitReviewRequest("packet-path-outside-extension"),
      tools: [tool],
      toolBudget: {
        maxToolCalls: 2,
        maxInvestigationRounds: 2,
        maxResultChars: 1000,
        sourceExtension: { maxToolCalls: 1, maxResultChars: 1000 }
      }
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(telemetry.toolCalls[0]).toMatchObject({
      status: "rejected",
      errorCode: "path_outside_repo",
      degradationReason: "path_outside_repo",
      budgetState: expect.not.objectContaining({ sourceExtensionActive: true })
    });
    expect(telemetry.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "tool_budget_extension_granted" })
    ]));
  });

  it("scales source budget extension with the tool budget multiplier", () => {
    expect(scaleToolBudget({
      maxToolCalls: 4,
      maxInvestigationRounds: 2,
      maxResultChars: 10_000,
      sourceExtension: { maxToolCalls: 1, maxResultChars: 4_000 }
    }, 1.5)).toMatchObject({
      maxToolCalls: 6,
      maxInvestigationRounds: 3,
      maxResultChars: 15_000,
      sourceExtension: {
        maxToolCalls: 2,
        maxResultChars: 6_000
      }
    });
  });

  it("records precise tool-call budget rejection reason metadata", async () => {
    const telemetry = fakeTelemetry();
    const execute = vi.fn(async () => ({
      text: "first result",
      meta: { backend: "text" as const, precision: "exact" as const, degraded: false }
    }));
    const tool: ToolDefinition = {
      name: "read_range",
      description: "read",
      parameters: Type.Object({ path: Type.String() }),
      execute
    };
    const adapter = scriptedAdapter([
      assistant([
        { type: "toolCall", id: "tool-ok", name: "read_range", arguments: { path: "src/a.ts" } },
        { type: "toolCall", id: "tool-call-budget", name: "read_range", arguments: { path: "src/b.ts" } }
      ]),
      assistant([validSubmitReviewCall("submit-after-tool-call-budget")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await runner.runStructured({
      ...submitReviewRequest("packet-tool-call-budget"),
      tools: [tool],
      toolBudget: { maxToolCalls: 1, maxInvestigationRounds: 2, maxResultChars: 1000 }
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(telemetry.toolCalls[1]).toMatchObject({
      status: "rejected",
      degradationReason: "tool_call_budget_exhausted",
      budgetState: expect.objectContaining({
        toolCallsUsed: 1,
        maxToolCalls: 1,
        resultCharsUsed: "first result".length,
        maxResultChars: 1000,
        remainingResultChars: 1000 - "first result".length
      })
    });
    expect(telemetry.toolCalls[1]?.degradationReason).not.toBe("budget_or_tool_rejected");
  });

  it("records precise investigation-round budget rejection reason metadata", async () => {
    const telemetry = fakeTelemetry();
    const execute = vi.fn(async () => ({
      text: "should not execute",
      meta: { backend: "text" as const, precision: "exact" as const, degraded: false }
    }));
    const tool: ToolDefinition = {
      name: "read_range",
      description: "read",
      parameters: Type.Object({ path: Type.String() }),
      execute
    };
    const adapter = scriptedAdapter([
      assistant([{ type: "toolCall", id: "tool-round-budget", name: "read_range", arguments: { path: "src/a.ts" } }]),
      assistant([validSubmitReviewCall("submit-after-round-budget")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await runner.runStructured({
      ...submitReviewRequest("packet-round-budget"),
      tools: [tool],
      toolBudget: { maxToolCalls: 2, maxInvestigationRounds: 0, maxResultChars: 1000 }
    });

    expect(execute).not.toHaveBeenCalled();
    expect(telemetry.toolCalls[0]).toMatchObject({
      status: "rejected",
      degradationReason: "investigation_round_budget_exhausted",
      budgetState: expect.objectContaining({
        investigationRoundsUsed: 1,
        maxInvestigationRounds: 0,
        remainingResultChars: 1000
      })
    });
    expect(telemetry.toolCalls[0]?.degradationReason).not.toBe("budget_or_tool_rejected");
  });

  it("records precise unknown-tool rejection reason metadata", async () => {
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([
      assistant([{ type: "toolCall", id: "tool-unknown", name: "read_secret", arguments: { path: "src/a.ts" } }]),
      assistant([validSubmitReviewCall("submit-after-unknown-tool")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await runner.runStructured({
      ...submitReviewRequest("packet-unknown-tool"),
      tools: [],
      toolBudget: { maxToolCalls: 2, maxInvestigationRounds: 2, maxResultChars: 1000 }
    });

    expect(telemetry.toolCalls[0]).toMatchObject({
      tool: "read_secret",
      status: "rejected",
      degradationReason: "unknown_tool",
      budgetState: expect.objectContaining({
        toolCallsUsed: 0,
        maxToolCalls: 2,
        remainingResultChars: 1000
      })
    });
    expect(telemetry.toolCalls[0]?.degradationReason).not.toBe("budget_or_tool_rejected");
  });

  it("caps large verifier tool results so later small helper source can still be delivered", async () => {
    const telemetry = fakeTelemetry();
    const execute = vi.fn(async (args: Record<string, unknown>) => {
      const symbolName = String(args.symbolName ?? "");
      return {
        text: symbolName === "LargeCaller" ? "large-caller\n".repeat(120) : "func SmallHelper() { return decisiveBranch }\n",
        meta: {
          backend: "tree-sitter" as const,
          precision: "syntactic" as const,
          degraded: false,
          lookupStatus: "found" as const,
          deliveryStatus: "full" as const
        }
      };
    });
    const readSymbol: ToolDefinition = {
      name: "read_symbol",
      description: "read symbol",
      parameters: Type.Object({ symbolName: Type.String() }, { additionalProperties: false }),
      execute
    };
    const adapter = scriptedAdapter([
      assistant([{ type: "toolCall", id: "large-read", name: "read_symbol", arguments: { symbolName: "LargeCaller" } }]),
      assistant([{ type: "toolCall", id: "small-read", name: "read_symbol", arguments: { symbolName: "SmallHelper" } }]),
      assistant([validSubmitVerdictCall("submit-after-small-helper")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(
      runner.runStructured({
        stage: 9,
        prompt: "verify helper-dependent finding",
        schema: SubmitVerificationVerdictSchema,
        templateVersion: "test-template",
        tools: [readSymbol],
        toolBudget: {
          maxToolCalls: 3,
          maxInvestigationRounds: 3,
          maxResultChars: 700,
          maxSingleToolResultChars: 300,
          reservedSourceResultChars: 200
        },
        timeoutMs: 1000
      })
    ).resolves.toMatchObject({ verdict: "reject" });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(adapter.contexts[1]).toContain("[tool result truncated by codegenie tool budget]");
    expect(adapter.contexts[2]).toContain("SmallHelper");
    expect(adapter.contexts[2]).toContain("decisiveBranch");
    expect(telemetry.toolCalls[0]).toMatchObject({
      tool: "read_symbol",
      status: "ok",
      truncated: true,
      resultChars: 300,
      budgetState: expect.objectContaining({
        maxSingleToolResultChars: 300,
        toolResultCharLimit: 300
      })
    });
    expect(telemetry.toolCalls[1]).toMatchObject({
      tool: "read_symbol",
      status: "ok",
      deliveryStatus: "full",
      budgetState: expect.objectContaining({
        resultCharsUsed: 300,
        toolResultCharLimit: 300
      })
    });
    expect(telemetry.toolCalls[1]?.truncated).not.toBe(true);
  });

  it("rejects repository tools when request.toolBudget is absent", async () => {
    const telemetry = fakeTelemetry();
    const execute = vi.fn(async () => ({
      text: "should not execute without explicit budget",
      meta: { backend: "text" as const, precision: "exact" as const, degraded: false }
    }));
    const adapter = scriptedAdapter([
      assistant([
        {
          type: "toolCall",
          id: "tool-no-budget",
          name: "read_range",
          arguments: { path: "src/a.ts" }
        }
      ]),
      assistant([validSubmitReviewCall("submit-no-budget")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await runner.runStructured({
      ...submitReviewRequest("packet-no-budget"),
      tools: [
        {
          name: "read_range",
          description: "read",
          parameters: Type.Object({ path: Type.String() }),
          execute
        }
      ]
    });

    expect(execute).not.toHaveBeenCalled();
    expect(telemetry.toolCalls[0]).toMatchObject({
      status: "rejected",
      degradationReason: "tool_result_budget_exhausted",
      resultChars: 0
    });
  });

  it("keeps schema repair available after a plain-text finalization nudge", async () => {
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([
      assistant([{ type: "text", text: "plain text instead of submit" }]),
      assistant([
        {
          type: "toolCall",
          id: "submit-invalid-after-nudge",
          name: "submit_review",
          arguments: { packetId: "packet-plain" }
        }
      ]),
      assistant([validSubmitReviewCall("submit-valid-after-repair")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(runner.runStructured(submitReviewRequest("packet-plain"))).resolves.toMatchObject({
      findings: [],
      followUpHints: [],
      uncertainties: []
    });
    expect(telemetry.modelCalls.map((call) => call.status)).toEqual(["ok", "schema_invalid", "ok"]);
  });

  it("retries once when forced finalization calls a non-submit tool", async () => {
    const telemetry = fakeTelemetry();
    const tool: ToolDefinition = {
      name: "read_range",
      description: "read",
      parameters: Type.Object({ path: Type.String() }),
      execute: vi.fn(async () => ({
        text: "line 1",
        meta: { backend: "text" as const, precision: "exact" as const, degraded: false }
      }))
    };
    const adapter = scriptedAdapter([
      assistant([
        {
          type: "toolCall",
          id: "tool-finalize",
          name: "read_range",
          arguments: { path: "src/a.ts" }
        }
      ]),
      assistant([
        {
          type: "toolCall",
          id: "tool-during-finalize",
          name: "read_file",
          arguments: { path: "lib/quotes/parse.go" }
        }
      ]),
      assistant([validSubmitReviewCall("submit-after-finalize-tool-misfire")])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(
      runner.runStructured({
        ...submitReviewRequest("packet-finalize-text"),
        tools: [tool],
        toolBudget: { maxToolCalls: 1, maxInvestigationRounds: 1, maxResultChars: 1000 }
      })
    ).resolves.toMatchObject({
      findings: [],
      followUpHints: [],
      uncertainties: []
    });
    expect(adapter.complete).toHaveBeenCalledTimes(3);
    expect(adapter.contexts[1]).not.toContain("reviewStatus");
    expect(adapter.contexts[1]).toContain("smallest schema-valid empty or negative result");
    expect(telemetry.modelCalls.map((call) => call.status)).toEqual(["ok", "schema_invalid", "ok"]);
    expect(telemetry.modelCalls[1]).toMatchObject({
      kind: "finalize",
      schemaValid: false,
      errorCode: "llm_schema_invalid"
    });
    expect(telemetry.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 7,
          level: "warn",
          message: "finalize_missing_submit_retry",
          data: expect.objectContaining({
            submitTool: "submit_review",
            unexpectedTools: ["read_file"]
          })
        })
      ])
    );
  });

  it("rejects forced finalization after the submit-only retry is ignored", async () => {
    const tool: ToolDefinition = {
      name: "read_range",
      description: "read",
      parameters: Type.Object({ path: Type.String() }),
      execute: vi.fn(async () => ({
        text: "line 1",
        meta: { backend: "text" as const, precision: "exact" as const, degraded: false }
      }))
    };
    const adapter = scriptedAdapter([
      assistant([
        {
          type: "toolCall",
          id: "tool-before-finalize",
          name: "read_range",
          arguments: { path: "src/a.ts" }
        }
      ]),
      assistant([{ type: "text", text: "plain text during finalization" }]),
      assistant([{ type: "text", text: "still no submit during finalization" }])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: fakeTelemetry().recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(
      runner.runStructured({
        ...submitReviewRequest("packet-finalize-text"),
        tools: [tool],
        toolBudget: { maxToolCalls: 1, maxInvestigationRounds: 1, maxResultChars: 1000 }
      })
    ).rejects.toMatchObject({
      code: "llm_schema_invalid",
      recoverable: true,
      context: { submitTool: "submit_review", kind: "finalize" }
    });
    expect(adapter.complete).toHaveBeenCalledTimes(3);
  });

  it("records submit_with_extra_tools telemetry and ignores extra model tool calls", async () => {
    const telemetry = fakeTelemetry();
    const execute = vi.fn(async () => ({
      text: "should not execute when submit is present",
      meta: { backend: "text" as const, precision: "exact" as const, degraded: false }
    }));
    const tool: ToolDefinition = {
      name: "read_range",
      description: "read",
      parameters: Type.Object({ path: Type.String() }),
      execute
    };
    const adapter = scriptedAdapter([
      assistant([
        validSubmitReviewCall("submit-with-extra-tool"),
        {
          type: "toolCall",
          id: "ignored-tool",
          name: "read_range",
          arguments: { path: "src/a.ts" }
        }
      ])
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(
      runner.runStructured({
        ...submitReviewRequest("packet-extra-tool"),
        tools: [tool],
        toolBudget: { maxToolCalls: 1, maxInvestigationRounds: 1, maxResultChars: 1000 },
        telemetryContext: { workerId: "worker-extra", packetId: "packet-extra" }
      })
    ).resolves.toEqual({
      findings: [],
      followUpHints: [],
      uncertainties: []
    });

    expect(execute).not.toHaveBeenCalled();
    expect(telemetry.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 7,
          level: "warn",
          message: "submit_with_extra_tools",
          workerId: "worker-extra",
          packetId: "packet-extra",
          data: expect.objectContaining({
            submitTool: "submit_review",
            ignoredTools: ["read_range"],
            count: 1
          })
        })
      ])
    );
  });

  it("does not retry non-auth 4xx provider errors", async () => {
    const adapter: PiAiAdapter = {
      resolveModel: () => ({ provider: "fake", id: "fake-model", raw: { id: "fake-model" } }),
      complete: vi.fn(async () => {
        const error = new Error("bad request") as Error & { status: number };
        error.status = 400;
        throw error;
      }),
      validateToolCall: (tools, toolCall) => validateToolCall(tools, toolCall)
    };
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: fakeTelemetry().recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(runner.runStructured(submitReviewRequest("packet-400"))).rejects.toMatchObject({
      code: "llm_call_failed",
      recoverable: true,
      context: { reason: "request_error" }
    });
    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });

  it("does not retry authentication provider errors", async () => {
    const adapter: PiAiAdapter = {
      resolveModel: () => ({ provider: "fake", id: "fake-model", raw: { id: "fake-model" } }),
      complete: vi.fn(async () => {
        const error = new Error("unauthorized api key") as Error & { status: number };
        error.status = 401;
        throw error;
      }),
      validateToolCall: (tools, toolCall) => validateToolCall(tools, toolCall)
    };
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: fakeTelemetry().recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(runner.runStructured(submitReviewRequest("packet-auth"))).rejects.toMatchObject({
      code: "llm_call_failed",
      recoverable: false,
      context: { reason: "auth" }
    });
    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });

  it("treats Pi stopReason error messages as provider failures instead of schema failures", async () => {
    const telemetry = fakeTelemetry();
    const adapter = scriptedAdapter([
      assistantError("400 model claude-opus-4-8 does not exist")
    ]);
    const runner = createPiRunner({
      llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
      telemetry: telemetry.recorder,
      logger: fakeLogger(),
      runSignal: new AbortController().signal,
      adapter,
      hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
    });

    await expect(runner.runStructured(submitReviewRequest("packet-provider-message-error"))).rejects.toMatchObject({
      code: "llm_call_failed",
      context: { reason: "request_error" }
    });

    expect(adapter.complete).toHaveBeenCalledTimes(1);
    expect(telemetry.modelCalls).toEqual([
      expect.objectContaining({
        status: "transient_error",
        stopReason: "error",
        errorCode: "llm_call_failed",
        errorMessage: "400 model claude-opus-4-8 does not exist",
        outputChars: 2
      })
    ]);
  });

  it("retries retryable provider errors three times and preserves trace context", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const telemetry = fakeTelemetry();
    let calls = 0;
    const adapter: PiAiAdapter = {
      resolveModel: () => ({ provider: "fake", id: "fake-model", raw: { id: "fake-model" } }),
      complete: vi.fn(async () => {
        calls += 1;
        if (calls <= 3) {
          const error = new Error("rate limited") as Error & { status: number; headers: Record<string, string> };
          error.status = 429;
          error.headers = { "retry-after": "0" };
          throw error;
        }
        return assistant([validSubmitReviewCall("submit-after-retry")]);
      }),
      validateToolCall: (tools, toolCall) => validateToolCall(tools, toolCall)
    };
    try {
      const runner = createPiRunner({
        llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
        telemetry: telemetry.recorder,
        logger: fakeLogger(),
        runSignal: new AbortController().signal,
        adapter,
        hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
      });

      await runner.runStructured({
        ...submitReviewRequest("packet-retry"),
        telemetryContext: { workerId: "worker-retry", packetId: "packet-retry", candidateId: "candidate-retry" }
      });

      expect(adapter.complete).toHaveBeenCalledTimes(4);
      expect(telemetry.modelCalls.map((call) => call.attempt)).toEqual([1, 2, 3, 4]);
      expect(telemetry.modelCalls.map((call) => call.status)).toEqual(["transient_error", "transient_error", "transient_error", "ok"]);
      expect(telemetry.modelCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            workerId: "worker-retry",
            packetId: "packet-retry",
            candidateId: "candidate-retry"
          })
        ])
      );
      expect(telemetry.modelCalls.every((call) => call.workerId === "worker-retry")).toBe(true);
    } finally {
      random.mockRestore();
    }
  });

  it("retries provider overload messages without an HTTP status for all configured attempts", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const telemetry = fakeTelemetry();
    let calls = 0;
    const adapter: PiAiAdapter = {
      resolveModel: () => ({ provider: "fake", id: "fake-model", raw: { id: "fake-model" } }),
      complete: vi.fn(async () => {
        calls += 1;
        if (calls <= 3) {
          return assistantError('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
        }
        return assistant([validSubmitReviewCall("submit-after-overload")]);
      }),
      validateToolCall: (tools, toolCall) => validateToolCall(tools, toolCall)
    };
    try {
      const runner = createPiRunner({
        llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
        telemetry: telemetry.recorder,
        logger: fakeLogger(),
        runSignal: new AbortController().signal,
        adapter,
        hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
      });

      await runner.runStructured(submitReviewRequest("packet-overload"));

      expect(adapter.complete).toHaveBeenCalledTimes(4);
      expect(telemetry.modelCalls.map((call) => call.attempt)).toEqual([1, 2, 3, 4]);
      expect(telemetry.modelCalls.slice(0, 3).every((call) =>
        call.status === "transient_error" &&
        call.retryable === true &&
        call.retryReason === "provider_overloaded" &&
        call.maxAttempts === 4
      )).toBe(true);
      expect(telemetry.modelCalls[3]).toMatchObject({ status: "ok", attempt: 4 });
      expect(telemetry.events.filter((event) => event.message === "provider_retry_scheduled")).toHaveLength(3);
    } finally {
      random.mockRestore();
    }
  });

  it("treats persistent retryable provider errors as recoverable task failures", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const telemetry = fakeTelemetry();
    const adapter: PiAiAdapter = {
      resolveModel: () => ({ provider: "fake", id: "fake-model", raw: { id: "fake-model" } }),
      complete: vi.fn(async () => {
        const error = new Error("provider unavailable") as Error & { status: number };
        error.status = 503;
        throw error;
      }),
      validateToolCall: (tools, toolCall) => validateToolCall(tools, toolCall)
    };
    try {
      const runner = createPiRunner({
        llmConfig: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
        telemetry: telemetry.recorder,
        logger: fakeLogger(),
        runSignal: new AbortController().signal,
        adapter,
        hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
      });

      await expect(runner.runStructured(submitReviewRequest("packet-provider-down"))).rejects.toMatchObject({
        code: "llm_call_failed",
        recoverable: true,
        context: { reason: "transient_error" }
      });
      expect(adapter.complete).toHaveBeenCalledTimes(4);
      expect(telemetry.modelCalls.at(-1)).toMatchObject({
        attempt: 4,
        retryable: true,
        retryReason: "server_error",
        retryExhausted: true
      });
      expect(telemetry.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "provider_retry_exhausted",
            data: expect.objectContaining({ retryReason: "server_error", maxAttempts: 4 })
          })
        ])
      );
    } finally {
      random.mockRestore();
    }
  });

  it("resolves provider-qualified real models only when auth is usable", () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "plain-provider-qualified-secret";
    clearRegisteredSecretsForTests();
    try {
      const model = createRealPiAiAdapter().resolveModel({ model: "openai/gpt-4.1-mini" });
      expect(model).toMatchObject({
        provider: "openai",
        id: "gpt-4.1-mini",
        apiKey: "plain-provider-qualified-secret"
      });
      expect(stripCredentials("error plain-provider-qualified-secret")).toBe("error [redacted:secret]");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
      clearRegisteredSecretsForTests();
    }
  });

  it("does not resolve deprecated real Pi models even when auth is usable", () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "plain-deprecated-anthropic-secret";
    clearRegisteredSecretsForTests();
    try {
      expect(
        createRealPiAiAdapter().resolveModel({
          provider: "anthropic",
          model: "claude-3-5-haiku-20241022"
        })
      ).toBeUndefined();
      const fallback = createRealPiAiAdapter().resolveModel({ provider: "anthropic" });
      expect(fallback?.id).not.toMatch(/^claude-3/u);
    } finally {
      if (previous === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previous;
      }
      clearRegisteredSecretsForTests();
    }
  });

  it("rejects unknown real model ids during runner construction", () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "plain-unknown-model-secret";
    clearRegisteredSecretsForTests();
    try {
      expect(() =>
        createPiRunner({
          llmConfig: {
            model: "openai/not-a-real-codegenie-test-model",
            maxConcurrentCalls: 1
          },
          telemetry: fakeTelemetry().recorder,
          logger: fakeLogger(),
          runSignal: new AbortController().signal,
          hooks: { checkpoint: () => "ok", onUsage: vi.fn() }
        })
      ).toThrow(CodegenieError);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
      clearRegisteredSecretsForTests();
    }
  });

  it("uses Pi completeSimple so resolved reasoning is provider-mapped", async () => {
    const optionsSeen: Record<string, unknown>[] = [];
    const completeSimple = (async (_model, _context, options) => {
      optionsSeen.push(options as Record<string, unknown>);
      return assistant([validSubmitReviewCall("submit-simple-reasoning")]);
    }) as typeof piCompleteSimple;
    const adapter = createRealPiAiAdapter({ completeSimple });

    await adapter.complete(
      { provider: "fake", id: "fake-model", raw: { id: "fake-model" }, apiKey: "fake-api-key" },
      { messages: [], tools: [] },
      { reasoning: "xhigh", maxRetries: 0 }
    );

    expect(optionsSeen).toEqual([
      expect.objectContaining({
        apiKey: "fake-api-key",
        reasoning: "xhigh"
      })
    ]);
  });

  it("maps forced submit calls to raw Pi provider reasoning and tool choice options", async () => {
    const rawOptionsSeen: Record<string, unknown>[] = [];
    const complete = (async (_model, _context, options) => {
      rawOptionsSeen.push(options as Record<string, unknown>);
      return assistant([validSubmitReviewCall("submit-raw-forced")]);
    }) as typeof piComplete;
    const completeSimple = vi.fn(async () => assistant([validSubmitReviewCall("must-not-use-simple")])) as unknown as typeof piCompleteSimple;
    const adapter = createRealPiAiAdapter({ complete, completeSimple });

    await adapter.complete(
      {
        provider: "openai",
        id: "gpt-test",
        raw: { api: "openai-completions", provider: "openai", id: "gpt-test", maxTokens: 4096, reasoning: true },
        apiKey: "fake-api-key"
      },
      { messages: [], tools: [] },
      { reasoning: "high", toolChoice: { type: "tool", name: "submit_review" }, maxRetries: 0 }
    );

    expect(completeSimple).not.toHaveBeenCalled();
    expect(rawOptionsSeen).toEqual([
      expect.objectContaining({
        apiKey: "fake-api-key",
        reasoningEffort: "high",
        toolChoice: { type: "function", function: { name: "submit_review" } }
      })
    ]);
    expect(rawOptionsSeen[0]).not.toHaveProperty("reasoning");
  });

  it("keeps Anthropic thinking enabled and avoids forced provider tool choice for submit turns", async () => {
    const rawOptionsSeen: Record<string, unknown>[] = [];
    const complete = (async (_model, _context, options) => {
      rawOptionsSeen.push(options as Record<string, unknown>);
      return assistant([validSubmitReviewCall("submit-anthropic-forced")]);
    }) as typeof piComplete;
    const completeSimple = vi.fn(async () => assistant([validSubmitReviewCall("must-not-use-simple")])) as unknown as typeof piCompleteSimple;
    const adapter = createRealPiAiAdapter({ complete, completeSimple });

    await adapter.complete(
      {
        provider: "anthropic",
        id: "claude-test",
        raw: { api: "anthropic-messages", provider: "anthropic", id: "claude-test", maxTokens: 4096, reasoning: true },
        apiKey: "fake-api-key"
      },
      { messages: [], tools: [] },
      { reasoning: "high", toolChoice: { type: "tool", name: "submit_review" }, maxRetries: 0 }
    );

    expect(completeSimple).not.toHaveBeenCalled();
    expect(rawOptionsSeen).toEqual([
      expect.objectContaining({
        apiKey: "fake-api-key",
        thinkingEnabled: true,
        effort: "high",
        toolChoice: "auto"
      })
    ]);
    expect(rawOptionsSeen[0]).not.toHaveProperty("reasoning");
  });

  it("refreshes stored OAuth credentials through Pi helpers and persists updates", async () => {
    clearRegisteredSecretsForTests();
    const oldCredentials = { access: "old-access-token", refresh: "old-refresh-token", expires: 0 };
    const newCredentials = { access: "new-access-token", refresh: "new-refresh-token", expires: Date.now() + 60_000 };
    const entries = new Map<string, ProviderAuthEntry>([
      ["github-copilot", { type: "oauth", credentials: oldCredentials, createdAt: new Date(0).toISOString() }]
    ]);
    const authStorage: PiAuthStorage = {
      loadAll: () => Object.fromEntries(entries.entries()),
      get: (provider) => entries.get(provider),
      set: (provider, entry) => {
        entries.set(provider, entry);
      },
      delete: (provider) => {
        entries.delete(provider);
      },
      clear: () => entries.clear()
    };
    const optionsSeen: Record<string, unknown>[] = [];
    const completeSimple = (async (_model, _context, options) => {
      optionsSeen.push(options as Record<string, unknown>);
      return assistant([validSubmitReviewCall("submit-oauth-refresh")]);
    }) as typeof piCompleteSimple;
    const getOAuthApiKey = vi.fn(async (_provider: string, credentials: Record<string, typeof oldCredentials>) => {
      expect(credentials["github-copilot"]).toEqual(oldCredentials);
      return { newCredentials, apiKey: "new-oauth-api-key" };
    }) as unknown as typeof piGetOAuthApiKey;
    const adapter = createRealPiAiAdapter({ authStorage, completeSimple, getOAuthApiKey });

    await adapter.complete(
      { provider: "github-copilot", id: "fake-model", raw: { id: "fake-model" }, oauthProvider: "github-copilot" },
      { messages: [], tools: [] },
      { maxRetries: 0 }
    );

    expect(getOAuthApiKey).toHaveBeenCalledTimes(1);
    expect(entries.get("github-copilot")).toMatchObject({
      type: "oauth",
      credentials: newCredentials,
      createdAt: new Date(0).toISOString()
    });
    expect(optionsSeen[0]).toMatchObject({ apiKey: "new-oauth-api-key" });
    expect(stripCredentials("new-oauth-api-key")).toBe("[redacted:secret]");
    clearRegisteredSecretsForTests();
  });

  it("derives sensitive cache keys, redacts entries, returns hits, and misses schema-version mismatches", async () => {
    clearRegisteredSecretsForTests();
    const repoRoot = tempGitRepo();
    const telemetry = fakeTelemetry();
    const cache = await createModelCallCache({
      dir: path.join(repoRoot, ".codegenie", "cache"),
      repoRoot,
      runFingerprint: "run-a",
      logger: fakeLogger(),
      telemetry: telemetry.recorder
    });
    const keyA = buildModelCallCacheKey({ prompt: "a", model: "m" });
    const keyB = buildModelCallCacheKey({ prompt: "b", model: "m" });
    expect(keyA).not.toBe(keyB);

    const entry = cacheEntry(7);
    entry.message.content.push({ type: "text", text: "cache contains super-secret-cache-token" });
    registerSecret("super-secret-cache-token");
    await cache.put(keyA, entry);
    expect(existsSync(modelCallCacheEntryPath(path.join(repoRoot, ".codegenie", "cache"), keyA))).toBe(true);
    expect(readCacheText(path.join(repoRoot, ".codegenie", "cache"))).not.toContain("super-secret-cache-token");
    expect(readCacheText(path.join(repoRoot, ".codegenie", "cache"))).toContain("[redacted:secret]");
    const hit = await cache.get(keyA, 7);
    expect(hit).toMatchObject({ status: "hit" });
    expect(JSON.stringify(hit)).not.toContain("super-secret-cache-token");
    expect(JSON.stringify(hit)).toContain("[redacted:secret]");
    const thinkingKey = buildModelCallCacheKey({ runFingerprint: "cache-test", prompt: "thinking" });
    await cache.put(thinkingKey, {
      ...cacheEntry(7),
      message: assistant([
        {
          type: "thinking",
          thinking: "provider reasoning block",
          thinkingSignature: "signed"
        },
        {
          type: "toolCall",
          id: "submit-thinking-cache",
          name: "submit_review",
          arguments: {
            findings: [],
            followUpHints: [],
            uncertainties: []
          }
        }
      ])
    });
    const thinkingHit = await cache.get(thinkingKey, 7);
    expect(thinkingHit).toMatchObject({ status: "hit" });
    expect(JSON.stringify(thinkingHit)).toContain("provider reasoning block");
    await expect(cache.get(keyB, 7)).resolves.toEqual({ status: "miss", reason: "not_found" });
    expect(telemetry.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 7,
          message: "model_call_cache_miss",
          cacheStatus: "miss"
        })
      ])
    );

    await cache.put("old-schema", { ...entry, cacheSchemaVersion: 0 });
    await expect(cache.get("old-schema", 7)).resolves.toEqual({ status: "miss", reason: "schema_mismatch" });
    const malformedKey = "malformed-current-schema";
    const malformedPath = modelCallCacheEntryPath(path.join(repoRoot, ".codegenie", "cache"), malformedKey);
    mkdirSync(path.dirname(malformedPath), { recursive: true });
    writeFileSync(
      malformedPath,
      `${JSON.stringify({
        cacheSchemaVersion: MODEL_CALL_CACHE_SCHEMA_VERSION,
        createdAt: new Date(0).toISOString(),
        stage: 7,
        message: { role: "assistant", provider: "fake", model: "fake-model" },
        finishReason: "submit",
        usage: {}
      })}\n`
    );
    await expect(cache.get(malformedKey, 7)).resolves.toEqual({ status: "miss", reason: "invalid_entry" });
    expect(existsSync(malformedPath)).toBe(false);
    const malformedContentKey = "malformed-current-schema-content";
    const malformedContentPath = modelCallCacheEntryPath(path.join(repoRoot, ".codegenie", "cache"), malformedContentKey);
    mkdirSync(path.dirname(malformedContentPath), { recursive: true });
    writeFileSync(
      malformedContentPath,
      `${JSON.stringify({
        ...cacheEntry(7),
        message: {
          ...cacheEntry(7).message,
          content: [{}]
        }
      })}\n`
    );
    await expect(cache.get(malformedContentKey, 7)).resolves.toEqual({ status: "miss", reason: "invalid_entry" });
    expect(existsSync(malformedContentPath)).toBe(false);
    expect(telemetry.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 7,
          message: "model_call_cache_invalid_miss",
          cacheStatus: "miss"
        })
      ])
    );
    expect(existsSync(path.join(repoRoot, ".codegenie", "cache"))).toBe(true);
    expect(readFileSync(path.join(repoRoot, ".codegenie", ".gitignore"), "utf8")).toContain("cache/");
    expect(readFileSync(path.join(repoRoot, ".codegenie", ".gitignore"), "utf8")).toContain("locks/");
    clearRegisteredSecretsForTests();
  });

  it("evicts stale cache entries at construction and records telemetry", async () => {
    const repoRoot = tempGitRepo();
    const cacheDir = path.join(repoRoot, ".codegenie", "cache");
    const staleKey = buildModelCallCacheKey({ runFingerprint: "old", prompt: "old" });
    const freshKey = buildModelCallCacheKey({ runFingerprint: "new", prompt: "new" });
    const stalePath = modelCallCacheEntryPath(cacheDir, staleKey);
    const freshPath = modelCallCacheEntryPath(cacheDir, freshKey);
    mkdirSync(path.dirname(stalePath), { recursive: true });
    mkdirSync(path.dirname(freshPath), { recursive: true });
    writeFileSync(stalePath, `${JSON.stringify(cacheEntry(7))}\n`);
    writeFileSync(freshPath, `${JSON.stringify(cacheEntry(7))}\n`);
    const staleTime = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    utimesSync(stalePath, staleTime, staleTime);

    const telemetry = fakeTelemetry();
    await createModelCallCache({
      dir: cacheDir,
      repoRoot,
      runFingerprint: "run-evict",
      logger: fakeLogger(),
      telemetry: telemetry.recorder
    });

    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(freshPath)).toBe(true);
    expect(telemetry.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 0,
          message: "model_call_cache_evicted",
          data: expect.objectContaining({ deletedCount: 1 })
        })
      ])
    );
  });

  it("rejects repo-root cache directories before eviction and fails closed on non-git roots", async () => {
    const repoRoot = tempGitRepo();
    const trackedJson = path.join(repoRoot, "tracked.json");
    writeFileSync(trackedJson, "{}\n");
    execFileSync("git", ["add", "tracked.json"], { cwd: repoRoot, stdio: "ignore" });

    await expect(
      createModelCallCache({
        dir: repoRoot,
        repoRoot,
        runFingerprint: "run-root",
        logger: fakeLogger(),
        telemetry: fakeTelemetry().recorder
      })
    ).rejects.toMatchObject({
      code: "config_error"
    });
    expect(existsSync(trackedJson)).toBe(true);

    const nonGitRoot = tempDir();
    await expect(
      createModelCallCache({
        dir: path.join(nonGitRoot, ".codegenie", "cache"),
        repoRoot: nonGitRoot,
        runFingerprint: "run-non-git",
        logger: fakeLogger(),
        telemetry: fakeTelemetry().recorder
      })
    ).rejects.toMatchObject({
      code: "config_error"
    });
  });
});

function scriptedAdapter(messages: PiAssistantMessage[]): PiAiAdapter & { contexts: string[]; options: Record<string, unknown>[]; toolNames: string[][] } {
  const contexts: string[] = [];
  const optionsSeen: Record<string, unknown>[] = [];
  const toolNames: string[][] = [];
  return {
    contexts,
    options: optionsSeen,
    toolNames,
    resolveModel: () => ({ provider: "fake", id: "fake-model", raw: { id: "fake-model", api: "faux" } }),
    complete: vi.fn(async (_model, context, options) => {
      contexts.push(JSON.stringify(context.messages));
      optionsSeen.push(options);
      toolNames.push((context.tools as Array<{ name: string }>).map((tool) => tool.name));
      const next = messages.shift();
      if (!next) {
        throw new Error("no scripted message");
      }
      return next;
    }),
    validateToolCall: (tools, toolCall) => validateToolCall(tools, toolCall)
  };
}

function assistant(content: PiAssistantMessage["content"]): PiAssistantMessage {
  return {
    role: "assistant",
    provider: "fake",
    model: "fake-model",
    content,
    usage: {
      input: 10,
      output: 5,
      totalTokens: 15,
      cost: { total: 0.01 }
    },
    stopReason: content.some((block) => (block as PiToolCall).type === "toolCall") ? "toolUse" : "stop",
    timestamp: 0
  };
}

function assistantError(errorMessage: string): PiAssistantMessage {
  return {
    role: "assistant",
    provider: "fake",
    model: "fake-model",
    content: [],
    usage: {
      input: 0,
      output: 0,
      totalTokens: 0,
      cost: { total: 0 }
    },
    stopReason: "error",
    errorMessage,
    timestamp: 0
  };
}

function validSubmitReviewCall(id: string): PiToolCall {
  return {
    type: "toolCall",
    id,
    name: "submit_review",
    arguments: {
      findings: [],
      followUpHints: [],
      uncertainties: []
    }
  };
}

function validCandidateSubmitReviewCall(id: string): PiToolCall {
  return {
    type: "toolCall",
    id,
    name: "submit_review",
    arguments: {
      findings: [validCandidateReviewFinding()],
      followUpHints: [],
      uncertainties: []
    }
  };
}

function validCandidateReviewFinding(): Record<string, unknown> {
  return {
    title: "Candidate finding",
    severity: "medium",
    confidence: "high",
    path: "src/a.ts",
    category: "correctness",
    evidence: {
      changedCode: "+ return value"
    },
    failureMode: "The changed branch returns the wrong value for a reachable case.",
    whyThisMatters: "Callers can observe incorrect behavior from the changed code.",
    verification: "The packet hunk changes the returned value on the affected branch."
  };
}

function validSubmitVerdictCall(id: string): PiToolCall {
  return {
    type: "toolCall",
    id,
    name: "submit_verdict",
    arguments: {
      verdict: "reject",
      reason: "decisive helper source disproves the finding",
      requiredEvidencePresent: false,
      falsePositiveRisk: "high"
    }
  };
}

function validSubmitPlanCall(id: string): PiToolCall {
  return {
    type: "toolCall",
    id,
    name: "submit_plan",
    arguments: {
      diffUnderstanding: {
        declaredIntent: "test",
        inferredBehavior: "test"
      },
      coverage: []
    }
  };
}

function submitReviewRequest(packetId: string) {
  return {
    stage: 7 as const,
    prompt: `review ${packetId}`,
    schema: SubmitPacketReviewSchema,
    templateVersion: "test-template",
    timeoutMs: 1000
  };
}

function fakeRepositoryTools(): RepositoryTools {
  const meta = { backend: "text" as const, precision: "exact" as const, degraded: false };
  return {
    readRange: async () => ({ text: "line 1\nline 2", meta }),
    readFileOutline: async () => ({
      outline: {
        path: "src/a.ts",
        language: "typescript",
        imports: [],
        topLevelSymbols: [],
        testSymbols: [],
        notes: []
      },
      meta
    }),
    readSymbol: async () => ({ text: "function a() {}", meta }),
    readDiffBlocks: async () => ({ blocks: ["@@ -1 +1 @@"], meta }),
    findDefinition: async () => ({ definitions: [], meta }),
    searchFiles: async () => ({ results: [], meta }),
    findSymbolMentions: async () => ({ results: [], meta }),
    findLikelyTests: async () => ({ tests: [], meta }),
    listFiles: async () => ({ paths: ["src/a.ts"], meta })
  };
}

function fakeTelemetry(): {
  recorder: TelemetryRecorder;
  events: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">>;
  modelCalls: Array<Omit<LlmCallRecord, "runId">>;
  toolCalls: Array<Omit<ToolCallRecord, "runId" | "toolCallId" | "timestamp">>;
  debugWrites: Array<{ kind: "llm-calls" | "tool-calls"; id: string; record: unknown }>;
} {
  const events: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">> = [];
  const modelCalls: Array<Omit<LlmCallRecord, "runId">> = [];
  const toolCalls: Array<Omit<ToolCallRecord, "runId" | "toolCallId" | "timestamp">> = [];
  const debugWrites: Array<{ kind: "llm-calls" | "tool-calls"; id: string; record: unknown }> = [];
  return {
    recorder: {
      runId: "phase4-llm",
      runDir: undefined,
      event: (event) => events.push(event),
      recordModelCall: (record) => modelCalls.push(record),
      recordToolCall: (record) => {
        toolCalls.push(record);
        return `tc-${toolCalls.length}`;
      },
      writeArtifact: vi.fn(async () => undefined),
      writeDebug: vi.fn(async (kind, id, record) => {
        debugWrites.push({ kind, id, record });
      }),
      flush: vi.fn(async () => undefined)
    },
    events,
    modelCalls,
    toolCalls,
    debugWrites
  };
}

function debugRecord(telemetry: ReturnType<typeof fakeTelemetry>, id: string): Record<string, unknown> {
  const write = telemetry.debugWrites.find((entry) => entry.kind === "llm-calls" && entry.id === id);
  expect(write).toBeDefined();
  return write?.record as Record<string, unknown>;
}

function toolDebugRecord(telemetry: ReturnType<typeof fakeTelemetry>, id: string): Record<string, unknown> {
  const write = telemetry.debugWrites.find((entry) => entry.kind === "tool-calls" && entry.id === id);
  expect(write).toBeDefined();
  return write?.record as Record<string, unknown>;
}

function fakeLogger(): Logger {
  const sink = vi.fn();
  return {
    debug: sink,
    info: sink,
    warn: sink,
    error: sink
  };
}

function cacheEntry(stage: 7): StoredProviderResponse {
  return {
    cacheSchemaVersion: MODEL_CALL_CACHE_SCHEMA_VERSION,
    createdAt: new Date(0).toISOString(),
    stage,
    message: assistant([
      {
        type: "toolCall",
        id: "submit-cache",
        name: "submit_review",
        arguments: {
          findings: [],
          followUpHints: [],
          uncertainties: []
        }
      }
    ]),
    finishReason: "submit",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      costUSD: 0.01
    }
  };
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "codegenie-phase4-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, ".keep"), "");
  return dir;
}

function tempGitRepo(): string {
  const dir = tempDir();
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function readCacheText(cacheDir: string): string {
  const parts: string[] = [];
  for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
    const entryPath = path.join(cacheDir, entry.name);
    if (entry.isDirectory()) {
      parts.push(readCacheText(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      parts.push(readFileSync(entryPath, "utf8"));
    }
  }
  return parts.join("\n");
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
