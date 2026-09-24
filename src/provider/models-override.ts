import type { Api, Model, OpenAICompletionsCompat, OpenRouterRouting } from "@earendil-works/pi-ai";

// Apply family-specific upstream routing on OpenRouter. Preserve Pi's catalog
// capabilities, prices, and reasoning mappings.
export function applyModelOverrides(model: Model<Api>): Model<Api> {
  if (model.provider !== "openrouter" || model.api !== "openai-completions") {
    return model;
  }
  const deepseek = model.id.startsWith("deepseek/");
  const upstreams = deepseek ? ["deepseek"]
    : model.id.startsWith("z-ai/") ? ["together", "fireworks", "cloudflare"] : undefined;
  if (!upstreams) return model;
  const compat = model.compat as OpenAICompletionsCompat | undefined;
  return {
    ...model,
    compat: {
      ...compat,
      ...(deepseek ? { thinkingFormat: "openrouter" as const } : {}),
      openRouterRouting: {
        ...compat?.openRouterRouting,
        only: [...upstreams],
        order: [...upstreams],
        allow_fallbacks: false
      }
    }
  };
}

export function modelProviderRouting(raw: unknown): OpenRouterRouting | undefined {
  const model = raw as Model<Api>;
  if (model.provider !== "openrouter" || model.api !== "openai-completions") return undefined;
  return (model.compat as OpenAICompletionsCompat | undefined)?.openRouterRouting;
}

// Use automatic selection for the pinned DeepSeek family: the V4.1 Flash
// endpoint rejected named forced tool_choice in run 78. Expose only the submit tool when
// finalizing and validates its arguments before accepting the result.
export function requiresAutomaticSubmitToolChoice(model: Model<Api>): boolean {
  const routing = modelProviderRouting(model);
  return model.provider === "openrouter" && model.id.startsWith("deepseek/")
    && routing?.only?.length === 1 && routing.only[0] === "deepseek"
    && routing.allow_fallbacks === false;
}
