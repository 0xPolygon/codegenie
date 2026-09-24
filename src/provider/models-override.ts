import type { Api, Model, OpenAICompletionsCompat, OpenRouterRouting } from "@earendil-works/pi-ai";

// Apply family-specific upstream routing on OpenRouter. Preserve Pi's catalog
// capabilities, prices, and reasoning mappings.
export function applyModelOverrides(model: Model<Api>): Model<Api> {
  if (model.provider !== "openrouter" || model.api !== "openai-completions") {
    return model;
  }
  const deepseek = model.id.startsWith("deepseek/");
  const upstreams = model.id.startsWith("z-ai/") ? ["together", "fireworks", "cloudflare"] : undefined;
  if (!deepseek && !upstreams) return model;
  const compat = model.compat as OpenAICompletionsCompat | undefined;
  const openRouterRouting: OpenRouterRouting = { ...compat?.openRouterRouting };
  if (deepseek) {
    // Prefer the official upstream, but do not hard-pin it. only + no fallback
    // fails every call when that upstream is excluded or returns 4xx.
    delete openRouterRouting.only;
    delete openRouterRouting.allow_fallbacks;
    openRouterRouting.order = ["deepseek"];
  } else {
    openRouterRouting.only = [...upstreams!];
    openRouterRouting.order = [...upstreams!];
    openRouterRouting.allow_fallbacks = false;
  }
  return {
    ...model,
    compat: {
      ...compat,
      ...(deepseek ? { thinkingFormat: "openrouter" as const } : {}),
      openRouterRouting
    }
  };
}

export function modelProviderRouting(raw: unknown): OpenRouterRouting | undefined {
  const model = raw as Model<Api>;
  if (model.provider !== "openrouter" || model.api !== "openai-completions") return undefined;
  return (model.compat as OpenAICompletionsCompat | undefined)?.openRouterRouting;
}

// V4.1 Flash rejected named forced tool_choice in run 78. Keep auto for every
// openrouter deepseek/ model, including when another upstream serves the call.
export function requiresAutomaticSubmitToolChoice(model: Model<Api>): boolean {
  return model.provider === "openrouter" && model.api === "openai-completions" && model.id.startsWith("deepseek/");
}
