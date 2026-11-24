import {
  clampThinkingLevel,
  type AnthropicMessagesCompat, type Api, type Model, type ModelThinkingLevel,
  type OpenAICompletionsCompat, type OpenAIResponsesCompat, type OpenRouterRouting
} from "@earendil-works/pi-ai";

const DEEPSEEK_UPSTREAMS = ["deepseek", "fireworks", "together"];

type RequestLevelEffortCompat = {
  supportsMidConvoEffort: false;
  supportsAdditionalTools?: false;
  supportsToolSearch?: false;
};

const RESPONSES_COMPAT = {
  supportsAdditionalTools: false,
  supportsToolSearch: false,
  supportsMidConvoEffort: false
} as const;

// Luna can skip reasoning with in-band tools and has inconsistent effort
// updates (#375, #431, earendil-works/pi#12361 and openai/codex#47843).
// The Anthropic override addresses low-like Opus reasoning on one fixture (#443).
// Requalify the routes independently on Pi upgrades (earendil-works/pi#12464, #432).
const REQUEST_LEVEL_EFFORT_OVERRIDES = new Map<string, RequestLevelEffortCompat>([
  ["openai/openai-responses", RESPONSES_COMPAT],
  ["openai-codex/openai-codex-responses", RESPONSES_COMPAT],
  ["anthropic/anthropic-messages", { supportsMidConvoEffort: false }]
]);

function requestLevelEffortOverrides(model: Model<Api>): RequestLevelEffortCompat | undefined {
  return REQUEST_LEVEL_EFFORT_OVERRIDES.get(`${model.provider}/${model.api}`);
}

// Apply request compatibility overrides without mutating Pi's catalog.
export function applyModelOverrides(model: Model<Api>): Model<Api> {
  const effortOverrides = requestLevelEffortOverrides(model);
  if (effortOverrides) {
    return { ...model, compat: { ...model.compat, ...effortOverrides } };
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

type EffortWireProtocol = {
  wireEffort?: string;
  toolPlacement?: "top_level" | "none";
  configurationUpdate: false;
};

export function effortWireProtocol(raw: unknown, effort: string | undefined, toolCount: number): EffortWireProtocol | undefined {
  const model = raw as Model<Api>;
  const overrides = requestLevelEffortOverrides(model);
  const compat = model.compat as (AnthropicMessagesCompat & OpenAIResponsesCompat) | undefined;
  if (!overrides || !compat || Object.keys(overrides).some(key => compat[key as keyof RequestLevelEffortCompat] !== false)) {
    return undefined;
  }

  if (model.api === "anthropic-messages") {
    // Pi sends output_config.effort only for adaptive thinking here. The
    // forced-submit path omits reasoning for models that can disable thinking.
    if (!effort || !model.reasoning || !compat.forceAdaptiveThinking) return { configurationUpdate: false };
    const mapped = model.thinkingLevelMap?.[effort as ModelThinkingLevel];
    return {
      wireEffort: mapped ?? (effort === "minimal" || effort === "low" ? "low" : effort === "medium" ? "medium" : "high"),
      configurationUpdate: false
    };
  }

  const selected = clampThinkingLevel(model, (effort ?? "off") as ModelThinkingLevel);
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
