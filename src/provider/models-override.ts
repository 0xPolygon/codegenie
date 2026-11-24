import {
  clampThinkingLevel,
  type Api, type Model, type ModelThinkingLevel,
  type OpenAICompletionsCompat, type OpenAIResponsesCompat, type OpenRouterRouting
} from "@earendil-works/pi-ai";

const DEEPSEEK_UPSTREAMS = ["deepseek", "fireworks", "together"];

function usesOpenAIResponses(model: Model<Api>): boolean {
  return (model.provider === "openai" && model.api === "openai-responses") ||
    (model.provider === "openai-codex" && model.api === "openai-codex-responses");
}

// Apply request compatibility overrides without mutating Pi's catalog.
export function applyModelOverrides(model: Model<Api>): Model<Api> {
  if (usesOpenAIResponses(model)) {
    // Luna can skip reasoning when Codex declares tools in input (#375).
    // Direct OpenAI also echoes medium when effort is sent as an update (#431).
    // Request-level effort avoids in-band effort updates
    // (earendil-works/pi#12361 and openai/codex#47843).
    // Remove the direct OpenAI workaround once Pi pins effort on openai-responses
    // (earendil-works/pi#12464, tracked in #432).
    return {
      ...model,
      compat: {
        ...model.compat,
        supportsAdditionalTools: false,
        supportsToolSearch: false,
        supportsMidConvoEffort: false
      }
    };
  }
  if (model.provider !== "openrouter" || model.api !== "openai-completions") {
    return model;
  }
  const deepseek = model.id.startsWith("deepseek/");
  const upstreams = deepseek ? DEEPSEEK_UPSTREAMS
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

type ResponsesWireProtocol = {
  wireEffort?: string;
  toolPlacement: "top_level" | "none";
  configurationUpdate: false;
};

export function responsesWireProtocol(raw: unknown, effort: string, toolCount: number): ResponsesWireProtocol | undefined {
  const model = raw as Model<Api>;
  if (!usesOpenAIResponses(model)) return undefined;
  const compat = model.compat as OpenAIResponsesCompat | undefined;
  if (compat?.supportsAdditionalTools !== false || compat.supportsToolSearch !== false
    || compat.supportsMidConvoEffort !== false) return undefined;

  const selected = clampThinkingLevel(model, effort as ModelThinkingLevel);
  const levels = model.thinkingLevelMap;
  const wireEffort = selected === "off"
    ? model.reasoning && levels?.off !== null ? levels?.off ?? "none" : undefined
    : levels?.[selected] ?? selected;
  return {
    ...(wireEffort === undefined ? {} : { wireEffort }),
    toolPlacement: toolCount > 0 ? "top_level" : "none",
    configurationUpdate: false
  };
}

export function modelProviderRouting(raw: unknown): OpenRouterRouting | undefined {
  const model = raw as Model<Api>;
  if (model.provider !== "openrouter" || model.api !== "openai-completions") return undefined;
  return (model.compat as OpenAICompletionsCompat | undefined)?.openRouterRouting;
}

// Use automatic selection for the pinned DeepSeek family (the V4.1 Flash
// endpoint rejected named forced tool_choice in run 78) and for models on
// Anthropic Messages that cannot disable thinking (below). Finalization
// exposes only the submit tool and validates its arguments before acceptance.
export function requiresAutomaticSubmitToolChoice(model: Model<Api>): boolean {
  if (anthropicThinkingAlwaysOn(model)) return true;
  const routing = modelProviderRouting(model);
  return model.provider === "openrouter" && model.id.startsWith("deepseek/")
    && routing?.only?.length === DEEPSEEK_UPSTREAMS.length
    && DEEPSEEK_UPSTREAMS.every((upstream, i) => routing.only?.[i] === upstream)
    && routing.allow_fallbacks === false;
}

// Anthropic forced submit (plan 86 step 3) means a named tool_choice with
// thinking disabled. A model whose Pi catalog entry cannot turn thinking off
// (thinkingLevelMap.off === null) cannot run that protocol, and Opus 5.5,
// Sonnet 5.5 and Fable 5.1/5.2 reject a named or "any" tool_choice outright
// with HTTP 400 (issue #46). Those models submit with automatic selection,
// the same path llm.forceSubmitToolChoice = false runs.
// Known deviation: Fable 5 also has off: null and accepts forced choice; it
// takes the automatic path too. Models without off: null (e.g. Opus 5,
// Haiku 5.5) keep forced submit.
function anthropicThinkingAlwaysOn(model: Model<Api>): boolean {
  if (model.api !== "anthropic-messages" || model.reasoning !== true) return false;
  // Pi's Vercel catalog omits the off restriction for these GPT models.
  // They require reasoning on OpenAI, so keep Pi's normal thinking payload
  // when the gateway translates Anthropic Messages requests (issue #94).
  return model.thinkingLevelMap?.off === null || (model.provider === "vercel-ai-gateway" &&
    /^openai\/(?:gpt-6-astra|gpt-6\.1-sol|gpt-6\.2-(?:astra|sol))(?:-(?:fast|batch))?$/u.test(model.id));
}
