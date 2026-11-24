import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { applyModelOverrides, modelProviderRouting, requiresAutomaticSubmitToolChoice, responsesWireProtocol } from "../src/provider/models-override.js";
import { getCodegeniePiModels } from "../src/provider/pi-ai-models.js";
import { createRealPiAiAdapter } from "../src/llm/pi-runner.js";

const routing = { only: ["deepseek", "fireworks", "together"], order: ["deepseek", "fireworks", "together"], allow_fallbacks: false };
const catalogModel = () => getCodegeniePiModels().getModel("openrouter", "deepseek/deepseek-v4.1-flash")!;

describe("OpenAI Responses tool and effort framing", () => {
  it.each([
    { provider: "openai-codex", auth: "oauth", endpoint: "https://chatgpt.com/backend-api/codex/responses" },
    { provider: "openai", auth: "api_key", endpoint: "https://api.openai.com/v1/responses" },
    { provider: "openai", auth: "oauth", endpoint: "https://api.openai.com/v1/responses" }
  ] as const)("keeps $provider ($auth) tools and effort at the request level", async ({ provider, auth, endpoint }) => {
    const codex = provider === "openai-codex";
    const chatGPTSignIn = provider === "openai" && auth === "oauth";
    const fixtureAccess = codex ? "x." + Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "fixture" }
    })).toString("base64url") + ".x" : "fixture-chatgpt-access";
    const models = getCodegeniePiModels({
      read: async (providerId) => providerId !== provider ? undefined : auth === "oauth"
        ? { type: "oauth", access: fixtureAccess, refresh: "", expires: Date.now() + 3_600_000 }
        : { type: "api_key", key: "sk-fixture-openai-key" },
      list: async () => [{ providerId: provider, type: auth }],
      modify: async () => { throw new Error("offline fixture must not refresh"); },
      delete: async () => undefined
    });
    const adapter = createRealPiAiAdapter({ models });
    const model = (await adapter.resolveModel({ provider, model: "gpt-6-luna" }))!;
    const catalog = models.getModel(provider, model.id)!;
    const original = structuredClone(catalog);
    expect(catalog.compat).toMatchObject({
      supportsAdditionalTools: true, supportsToolSearch: true, supportsMidConvoEffort: true
    });
    expect(model.raw).toMatchObject({ compat: {
      supportsAdditionalTools: false, supportsToolSearch: false, supportsMidConvoEffort: false
    } });

    const menu = [
      { name: "read_range", description: "Read source",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "submit_review", description: "Submit the review",
        parameters: { type: "object", properties: {} } }
    ];
    const user = { role: "user", content: "Review the changed code.", timestamp: 0 };
    const history = [
      user,
      {
        role: "assistant", api: catalog.api, provider: model.provider, model: model.id,
        providerThinkingLevel: "high", content: [{
          type: "toolCall", id: "call_read|fc_read", name: "read_range", arguments: { path: "src/file.ts" }
        }], timestamp: 1, stopReason: "toolUse",
        usage: { totalTokens: 10, input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }
      },
      {
        role: "toolResult", toolCallId: "call_read|fc_read", toolName: "read_range",
        content: [{ type: "text", text: "10\treturn value;" }], isError: false, timestamp: 2
      }
    ];
    const bodies: Array<{
      input: Array<{ type?: string; tools?: unknown[] }>;
      reasoning: { effort?: string };
      tools?: unknown[];
      max_output_tokens?: number;
    }> = [];
    vi.stubGlobal("fetch", async (url: string, request: RequestInit) => {
      expect(url).toBe(endpoint);
      const body = request.body;
      const text = typeof body === "string" ? body : zstdDecompressSync(body as Uint8Array).toString("utf8");
      bodies.push(JSON.parse(text));
      return new Response("offline request captured", { status: 400 });
    });
    try {
      for (const [selected, wireEffort] of [["high", "high"], ["minimal", "low"], ["medium", "medium"], ["low", "low"]] as const) {
        const context = { messages: selected === "high" ? [user] : history, tools: menu };
        const options = {
          reasoning: selected, submitToolName: "submit_review", transport: "sse", maxRetries: 0,
          toolChoice: selected === "minimal" ? { type: "tool", name: "submit_review" } : "auto",
          sessionId: "responses-request-effort-fixture", cacheRetention: "short", maxTokens: 8192
        };
        const beforeCount = bodies.length;
        const legacy = await adapter.complete({ ...model, raw: catalog }, context, options);
        expect(bodies.length, legacy.errorMessage).toBe(beforeCount + 1);
        const updated = await adapter.complete(model, context, options);
        expect(bodies.length, updated.errorMessage).toBe(beforeCount + 2);
        const before = bodies.at(-2)!;
        const after = bodies.at(-1)!;
        expect(before.reasoning.effort).toBe(chatGPTSignIn ? wireEffort : "medium");
        expect(before.input.some(item => item.type === "configuration_update")).toBe(!chatGPTSignIn);
        if (!codex) {
          expect(before.max_output_tokens).toBe(chatGPTSignIn ? undefined : 8192);
        }
        expect(before.tools).toBeUndefined();
        expect(after.reasoning.effort).toBe(wireEffort);
        expect(after.input.some(item => item.type === "configuration_update")).toBe(false);
        expect(after.input.some(item => item.type === "additional_tools")).toBe(false);
        const oldTools = before.input.find(item => item.type === "additional_tools")?.tools;
        expect(oldTools).toHaveLength(menu.length);
        expect(after.tools).toEqual(oldTools);
        expect(responsesWireProtocol(catalog, selected, menu.length)).toBeUndefined();
        expect(responsesWireProtocol(model.raw, selected, menu.length)).toEqual({
          wireEffort, toolPlacement: "top_level", configurationUpdate: false
        });
        const normalize = (body: typeof before) => {
          const copy = structuredClone(body);
          if (!chatGPTSignIn) delete copy.reasoning.effort;
          delete copy.tools;
          copy.input = copy.input.filter(item => item.type !== "configuration_update" && item.type !== "additional_tools");
          return copy;
        };
        expect(normalize(after)).toEqual(normalize(before));
      }
      expect(bodies).toHaveLength(8);
      expect(catalog).toEqual(original);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["openrouter", "openai/gpt-6-luna"],
    ["azure", "gpt-6-luna"]
  ] as const)("leaves %s/%s compatibility unchanged", (provider, id) => {
    const original = getCodegeniePiModels().getModel(provider, id)!;
    expect(applyModelOverrides(original)).toBe(original);
    expect(responsesWireProtocol(original, "high", 1)).toBeUndefined();
  });

  it.each([
    { provider: "openrouter", id: "openai/gpt-6-luna", keyVar: "OPENROUTER_API_KEY",
      endpoint: "https://openrouter.ai/api/v1/chat/completions" },
    { provider: "azure", id: "gpt-6-luna", keyVar: "AZURE_OPENAI_API_KEY",
      endpoint: "https://fixture.openai.azure.com/openai/v1/responses" }
  ])("preserves the $provider transport body byte for byte", async ({ provider, id, keyVar, endpoint }) => {
    vi.stubEnv(keyVar, "test-only-key");
    if (provider === "azure") {
      vi.stubEnv("AZURE_OPENAI_BASE_URL", "https://fixture.openai.azure.com/openai/v1");
      vi.stubEnv("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", undefined);
    }
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (url: string, request: RequestInit) => {
      const { origin, pathname } = new URL(url);
      expect(origin + pathname).toBe(endpoint);
      expect(typeof request.body).toBe("string");
      bodies.push(request.body as string);
      return new Response("offline request captured", { status: 400 });
    });
    try {
      const models = getCodegeniePiModels();
      const adapter = createRealPiAiAdapter({ models });
      const request = { provider, model: id };
      const model = (await adapter.resolveModel(request))!;
      const catalog = models.getModel(provider, model.id)!;
      const context = {
        messages: [{ role: "user", content: "Review the changed code.", timestamp: 0 }],
        tools: [{ name: "submit_review", description: "Submit the review", parameters: {
          type: "object", properties: {}
        } }]
      };
      const options = { submitToolName: "submit_review", reasoning: "high", toolChoice: "auto", maxRetries: 0 };
      const original = await adapter.complete({ ...model, raw: catalog }, context, options);
      expect(bodies.length, original.errorMessage).toBe(1);
      const updated = await adapter.complete(model, context, options);
      expect(bodies.length, updated.errorMessage).toBe(2);
      expect(bodies[1]).toBe(bodies[0]);
      expect(JSON.parse(bodies[0]!)).toMatchObject({
        model: request.model, reasoning: { effort: "high" }, tool_choice: "auto"
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

describe("model routing overrides", () => {
  it("preserves catalog metadata and unrelated compatibility settings without mutation", () => {
    const original: Model<"openai-completions"> = {
      ...catalogModel(), api: "openai-completions",
      compat: { supportsDeveloperRole: false, openRouterRouting: { data_collection: "deny", only: ["other"] } }
    };
    const before = structuredClone(original);
    const result = applyModelOverrides(original);
    expect(result).toMatchObject({ ...before, compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter", openRouterRouting: { ...routing, data_collection: "deny" } } });
    expect(result.thinkingLevelMap).toEqual(original.thinkingLevelMap);
    expect(original).toEqual(before);
    expect(applyModelOverrides(result)).toEqual(result);
  });

  it.each([
    { provider: "deepseek" },
    { id: "other/deepseek-v4.1-flash" },
    { id: "deepseek-other/model" },
    { id: "z-ai-other/glm-5.3" },
    { id: "anthropic/claude-opus-4" },
    { provider: "zai", id: "z-ai/glm-5.3-flash" },
    { api: "openai-responses" as const }
  ])("leaves unmatched models alone: %j", (change) => {
    const model = { ...catalogModel(), ...change };
    expect(applyModelOverrides(model)).toBe(model);
    expect(requiresAutomaticSubmitToolChoice(model)).toBe(false);
  });

  it.each(["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4.1-pro", "deepseek/deepseek-r1", "deepseek/deepseek-chat", "deepseek/future-model:free"])("pins all DeepSeek model IDs on OpenRouter: %s", (id) => {
    const original = { ...catalogModel(), id };
    const result = applyModelOverrides(original);
    expect(modelProviderRouting(result)).toMatchObject(routing);
    expect(requiresAutomaticSubmitToolChoice(result)).toBe(true);
    expect(result.thinkingLevelMap).toEqual(original.thinkingLevelMap);
  });

  it.each(["z-ai/glm-5.3-flash", "z-ai/glm-5.3", "z-ai/future-model:free"])("routes OpenRouter Z.AI models without changing capabilities: %s", id => {
    const original: Model<"openai-completions"> = { ...catalogModel(), api: "openai-completions", id,
      compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter", openRouterRouting: { data_collection: "deny", only: ["old"], allow_fallbacks: true } } };
    const before = structuredClone(original);
    const result = applyModelOverrides(original);
    expect(modelProviderRouting(result)).toEqual({ only: ["together", "fireworks", "cloudflare"], order: ["together", "fireworks", "cloudflare"], allow_fallbacks: false, data_collection: "deny" });
    expect(result).toEqual({ ...before, compat: { ...before.compat, openRouterRouting: modelProviderRouting(result) } });
    expect(original).toEqual(before);
    expect(applyModelOverrides(result)).toEqual(result);
    expect(requiresAutomaticSubmitToolChoice(result)).toBe(false);
  });

  it.each([
    ["deepseek/deepseek-v4.1-flash", false], ["deepseek/deepseek-v4.1-flash", true],
    ["z-ai/glm-5.3-flash", false], ["z-ai/glm-5.3-flash", true]
  ] as const)("serializes %s routing in the actual Pi request body (forced submit: %s)", async (modelId, forced) => {
    const expectedRouting = modelId.startsWith("deepseek/") ? routing : {
      only: ["together", "fireworks", "cloudflare"], order: ["together", "fireworks", "cloudflare"], allow_fallbacks: false
    };
    vi.stubEnv("OPENROUTER_API_KEY", "test-only-key");
    try {
      const catalogBefore = structuredClone(getCodegeniePiModels().getModel("openrouter", modelId));
      const adapter = createRealPiAiAdapter();
      const model = (await adapter.resolveModel({ provider: "openrouter", model: modelId }))!;
      expect(modelProviderRouting(model.raw)).toEqual(expectedRouting);
      let payload: unknown;
      // Inspect Pi's serialized request before transport; never send a paid call.
      await adapter.complete(model, { messages: [{ role: "user", content: "test", timestamp: 0 }], tools: [{ name: "submit_review", description: "Submit", parameters: { type: "object", properties: {} } }] }, {
        submitToolName: "submit_review", reasoning: "low", maxRetries: 0,
        ...(forced ? { toolChoice: { type: "tool", name: "submit_review" } } : {}),
        onPayload: (body: unknown) => { payload = body; throw new Error("stop before network"); }
      });
      expect(payload).toMatchObject({ model: model.id, provider: expectedRouting, stream: true, reasoning: { effort: "low" } });
      expect((payload as { provider: object }).provider).not.toHaveProperty("require_parameters");
      if (forced) expect(payload).toMatchObject({ tool_choice: modelId.startsWith("deepseek/") ? "auto" : { type: "function", function: { name: "submit_review" } } });
      expect((payload as { tools: unknown[] }).tools).toHaveLength(1);
      expect(getCodegeniePiModels().getModel(model.provider, model.id)).toEqual(catalogBefore);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("Anthropic models that cannot disable thinking (issue #46)", () => {
  const anthropicModel = (id: string) => getCodegeniePiModels().getModel("anthropic", id)!;

  // Pi's catalog marks these models thinkingLevelMap.off === null. Opus 5.5,
  // Sonnet 5.5 and Fable 5.1/5.2 reject a forced tool_choice with HTTP 400;
  // Fable 5 accepts it but takes the automatic path too (accepted deviation).
  it.each(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-fable-5-2", "claude-fable-5"])("submits %s with automatic tool choice", (id) => {
    expect(anthropicModel(id).thinkingLevelMap?.off).toBeNull();
    expect(requiresAutomaticSubmitToolChoice(anthropicModel(id))).toBe(true);
  });

  it.each(["claude-opus-5", "claude-opus-4-8", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-5-5"])("keeps forced submit for %s", (id) => {
    expect(requiresAutomaticSubmitToolChoice(anthropicModel(id))).toBe(false);
  });

  it("applies only to the Anthropic Messages API", () => {
    expect(requiresAutomaticSubmitToolChoice({ ...anthropicModel("claude-opus-5-5"), api: "bedrock-converse-stream" })).toBe(false);
  });

  it.each([
    ["claude-opus-5-5", false], ["claude-fable-5-2", false], ["claude-opus-5", true], ["claude-haiku-5-5", true]
  ] as const)("serializes the submit request %s accepts in the actual Pi request body (forced: %s)", async (modelId, forced) => {
    const home = mkdtempSync(path.join(tmpdir(), "codegenie-46-"));
    vi.stubEnv("CODEGENIE_HOME", home);
    vi.stubEnv("ANTHROPIC_API_KEY", "test-only-key");
    try {
      const adapter = createRealPiAiAdapter();
      const model = (await adapter.resolveModel({ provider: "anthropic", model: modelId }))!;
      let payload: unknown;
      // Inspect Pi's serialized request before transport; never send a paid call.
      await adapter.complete(model, { messages: [{ role: "user", content: "test", timestamp: 0 }], tools: [{ name: "submit_plan", description: "Submit", parameters: { type: "object", properties: {} } }] }, {
        submitToolName: "submit_plan", reasoning: "high", maxRetries: 0, toolChoice: { type: "tool", name: "submit_plan" },
        onPayload: (body: unknown) => { payload = body; throw new Error("stop before network"); }
      }).catch(() => undefined);
      if (forced) {
        expect(payload).toMatchObject({ tool_choice: { type: "tool", name: "submit_plan" }, thinking: { type: "disabled" } });
      } else {
        // Default settings: the 400-rejected named choice must not be sent, and
        // the configured effort still reaches the model.
        expect(payload).toMatchObject({ tool_choice: { type: "auto" }, thinking: { type: "adaptive" } });
        expect(JSON.stringify((payload as { messages: unknown[] }).messages)).toContain('"output_config":{"effort":"high"}');
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
