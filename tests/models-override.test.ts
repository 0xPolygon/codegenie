import { describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { applyModelOverrides, modelProviderRouting, requiresAutomaticSubmitToolChoice } from "../src/provider/models-override.js";
import { getCodegeniePiModels } from "../src/provider/pi-ai-models.js";
import { createRealPiAiAdapter } from "../src/llm/pi-runner.js";

const routing = { order: ["deepseek"] };
const catalogModel = () => getCodegeniePiModels().getModel("openrouter", "deepseek/deepseek-v4.1-flash")!;

describe("model routing overrides", () => {
  it("preserves catalog metadata and unrelated compatibility settings without mutation", () => {
    const original: Model<"openai-completions"> = {
      ...catalogModel(), api: "openai-completions",
      compat: { supportsDeveloperRole: false, openRouterRouting: { data_collection: "deny", only: ["other"] } }
    };
    const before = structuredClone(original);
    const result = applyModelOverrides(original);
    expect(modelProviderRouting(result)).toEqual({ ...routing, data_collection: "deny" });
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

  it.each(["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4.1-pro", "deepseek/deepseek-r1", "deepseek/deepseek-chat", "deepseek/future-model:free"])("prefers the official upstream for DeepSeek model IDs on OpenRouter: %s", (id) => {
    const original = { ...catalogModel(), id };
    const result = applyModelOverrides(original);
    expect(modelProviderRouting(result)).toEqual(routing);
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
      const model = adapter.resolveModel({ provider: "openrouter", model: modelId })!;
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
      if (modelId.startsWith("deepseek/")) {
        expect((payload as { provider: object }).provider).not.toHaveProperty("only");
        expect((payload as { provider: object }).provider).not.toHaveProperty("allow_fallbacks");
      }
      if (forced) expect(payload).toMatchObject({ tool_choice: modelId.startsWith("deepseek/") ? "auto" : { type: "function", function: { name: "submit_review" } } });
      expect((payload as { tools: unknown[] }).tools).toHaveLength(1);
      expect(getCodegeniePiModels().getModel(model.provider, model.id)).toEqual(catalogBefore);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
