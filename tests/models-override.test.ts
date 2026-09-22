import { describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { applyModelOverrides, modelProviderRouting, requiresAutomaticSubmitToolChoice } from "../src/provider/models-override.js";
import { getCodegeniePiModels } from "../src/provider/pi-ai-models.js";
import { createRealPiAiAdapter } from "../src/llm/pi-runner.js";

const routing = { only: ["deepseek"], order: ["deepseek"], allow_fallbacks: false };
const catalogModel = () => getCodegeniePiModels().getModel("openrouter", "deepseek/deepseek-v4.1-flash")!;

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
    { id: "z-ai/glm-5.3" },
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

  it.each([false, true])("serializes routing in the actual Pi request body (forced submit: %s)", async (forced) => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-only-key");
    try {
      const catalogBefore = structuredClone(catalogModel());
      const adapter = createRealPiAiAdapter();
      const model = adapter.resolveModel({ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" })!;
      expect(modelProviderRouting(model.raw)).toMatchObject(routing);
      let payload: unknown;
      // Inspect Pi's serialized request before transport; never send a paid call.
      await adapter.complete(model, { messages: [{ role: "user", content: "test", timestamp: 0 }], tools: [{ name: "submit_review", description: "Submit", parameters: { type: "object", properties: {} } }] }, {
        submitToolName: "submit_review", reasoning: "low", maxRetries: 0,
        ...(forced ? { toolChoice: { type: "tool", name: "submit_review" } } : {}),
        onPayload: (body: unknown) => { payload = body; throw new Error("stop before network"); }
      });
      expect(payload).toMatchObject({ model: model.id, provider: routing, stream: true, reasoning: { effort: "low" } });
      expect((payload as { provider: object }).provider).not.toHaveProperty("require_parameters");
      if (forced) expect(payload).toMatchObject({ tool_choice: "auto" });
      expect((payload as { tools: unknown[] }).tools).toHaveLength(1);
      expect(getCodegeniePiModels().getModel(model.provider, model.id)).toEqual(catalogBefore);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
