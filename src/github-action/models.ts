// Model selection for the GitHub Action (plan 125): the `model` / `models`
// inputs, the comment-requested alias, and `llm-api-key` routing. Comment text
// only ever selects an alias the workflow author listed — it never becomes a
// model spec, reasoning level, or flag.
import { isMap, isScalar, LineCounter, parseDocument } from "yaml";
import { getPiApiKeyEnvVarName, getPiCredentialEnvVarNames } from "../provider/pi-ai-models.js";
import { providerKnown } from "../provider/provider-services.js";
import { splitReasoningSuffix } from "../provider/reasoning.js";
import { CodegenieError } from "../util/errors.js";

export type ModelSpec = {
  provider?: string;
  model: string;
  reasoning: string;
};

// The model a run uses; `alias` is set when it was chosen by alias name.
export type ModelSelection = {
  alias?: string;
  spec: ModelSpec;
};

export type ModelConfig = {
  // Lowercased alias → spec, in the order the workflow lists them.
  aliases: Map<string, ModelSpec>;
  defaultModel?: ModelSelection;
};

// Starts and ends with a letter or digit, so the comment-side stripping of
// surrounding punctuation (event-gate) can never make an alias unreachable.
const ALIAS_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,30}[A-Za-z0-9])?$/u;

// One model spec instead of separate provider/model/reasoning inputs:
// `provider/model[:reasoning]`, e.g. `anthropic/claude-opus-5:xhigh`.
// Reasoning defaults to "high" — Action reviews are unattended, so the
// action's posture favors quality over the CLI's interactive default. The
// suffix rule is the shared one (a non-level `:suffix` stays in the model id).
export function parseModelSpec(spec: string): ModelSpec {
  const { model: rest, reasoning = "high" } = splitReasoningSuffix(spec);
  const slash = rest.indexOf("/");
  const provider = slash > 0 ? rest.slice(0, slash) : undefined;
  const model = slash > 0 ? rest.slice(slash + 1) : rest;
  if (model.trim() === "" || (slash === 0)) {
    throw new CodegenieError("invalid_args", `--model must be provider/model[:reasoning], got: ${spec}`);
  }
  return {
    ...(provider !== undefined ? { provider } : {}),
    model,
    reasoning
  };
}

export function formatModelSpec(spec: ModelSpec): string {
  return `${spec.provider !== undefined ? `${spec.provider}/` : ""}${spec.model}:${spec.reasoning}`;
}

// Parses the `models` block: a flat YAML mapping of alias → spec. Errors name
// the line and alias; keys never belong here (see the README), and GitHub
// masks secret values in the log regardless.
export function parseModelAliases(
  text: string,
  providerExists: (provider: string) => boolean = providerKnown
): Map<string, ModelSpec> {
  const aliases = new Map<string, ModelSpec>();
  if (text.trim() === "") {
    return aliases;
  }
  const lineCounter = new LineCounter();
  // failsafe: every scalar is a string, so aliases like `405:` stay names.
  const document = parseDocument(text, { lineCounter, uniqueKeys: false, schema: "failsafe" });
  const [syntaxError] = document.errors;
  if (syntaxError !== undefined) {
    // Our own message: the yaml library's quotes source text.
    throw modelsError(`invalid YAML at line ${lineCounter.linePos(syntaxError.pos[0]).line}`);
  }
  const contents = document.contents;
  if (!isMap(contents)) {
    throw modelsError("must be a mapping of alias: provider/model[:reasoning] lines");
  }
  for (const pair of contents.items) {
    const offset = isScalar(pair.key) ? pair.key.range?.[0] : undefined;
    const line = offset !== undefined ? lineCounter.linePos(offset).line : undefined;
    const where = line !== undefined ? `line ${line}` : "an entry";
    if (!isScalar(pair.key) || typeof pair.key.value !== "string" || !ALIAS_NAME_PATTERN.test(pair.key.value)) {
      throw modelsError(`${where}: alias names must match ${ALIAS_NAME_PATTERN.source}`);
    }
    const alias = pair.key.value.toLowerCase();
    if (aliases.has(alias)) {
      throw modelsError(`${where}: duplicate alias ${alias}`);
    }
    if (!isScalar(pair.value) || typeof pair.value.value !== "string" || pair.value.value.trim() === "") {
      throw modelsError(`${where}: alias ${alias} must map to a provider/model[:reasoning] string`);
    }
    let spec: ModelSpec;
    try {
      spec = parseModelSpec(pair.value.value.trim());
    } catch {
      throw modelsError(`${where}: alias ${alias} must be provider/model[:reasoning]`);
    }
    if (spec.provider === undefined) {
      throw modelsError(`${where}: alias ${alias} needs a provider prefix (provider/model[:reasoning])`);
    }
    if (!providerExists(spec.provider)) {
      throw modelsError(`${where}: alias ${alias} names unknown provider ${spec.provider}`);
    }
    aliases.set(alias, spec);
  }
  return aliases;
}

// Resolves the `model` input against the aliases. Without `models`, `model`
// parsing is exactly the pre-plan-125 behavior.
export function resolveModelConfig(modelInput: string | undefined, aliases: Map<string, ModelSpec>): ModelConfig {
  const trimmed = modelInput?.trim() ?? "";
  if (aliases.size === 0) {
    return trimmed === "" ? { aliases } : { aliases, defaultModel: { spec: parseModelSpec(trimmed) } };
  }
  if (trimmed === "") {
    throw new CodegenieError("invalid_args", "--models requires --model to name the default (an alias or provider/model[:reasoning])");
  }
  if (!trimmed.includes("/")) {
    const alias = trimmed.toLowerCase();
    const spec = aliases.get(alias);
    if (spec === undefined) {
      throw new CodegenieError("invalid_args", `--model ${trimmed} is not one of the configured model aliases`);
    }
    return { aliases, defaultModel: { alias, spec } };
  }
  return { aliases, defaultModel: { spec: parseModelSpec(trimmed) } };
}

// The model for this event. Without aliases, comment text is ignored exactly
// as before; with aliases, an unlisted token is "unknown" (the caller replies).
// `requestedAlias` arrives normalized by the event gate.
export function selectModel(
  config: ModelConfig,
  requestedAlias: string | undefined
): { kind: "selected"; selection?: ModelSelection } | { kind: "unknown_alias" } {
  if (config.aliases.size === 0 || requestedAlias === undefined) {
    return { kind: "selected", ...(config.defaultModel !== undefined ? { selection: config.defaultModel } : {}) };
  }
  const spec = config.aliases.get(requestedAlias);
  return spec === undefined ? { kind: "unknown_alias" } : { kind: "selected", selection: { alias: requestedAlias, spec } };
}

// Fixed text built only from configured alias names (restricted charset), so
// nothing from the triggering comment is echoed.
export function renderUnknownAliasReply(config: ModelConfig): string {
  const names = [...config.aliases.keys()].map((alias) => (
    alias === config.defaultModel?.alias ? `\`${alias}\` (default)` : `\`${alias}\``
  ));
  return `**🧞 Codegenie**: unknown model. Available: ${names.join(", ")}.`;
}

// `llm-api-key` (LLM_API_KEY) is authoritative when set: every selectable
// model must read its key from one env var (usually one provider; a few
// provider pairs share a var, e.g. moonshotai/moonshotai-cn), those providers'
// competing credential vars are cleared, and the key is written
// unconditionally. Unset, provider credentials resolve exactly as they always
// have. Returns the providers the key was routed to (empty when unset).
export function applyLlmApiKey(env: NodeJS.ProcessEnv, config: ModelConfig): string[] {
  const key = env.LLM_API_KEY;
  if (key === undefined || key === "") {
    return [];
  }
  const selectable = [
    ...(config.defaultModel !== undefined ? [config.defaultModel.spec] : []),
    ...config.aliases.values()
  ];
  if (selectable.length === 0 || selectable.some((spec) => spec.provider === undefined)) {
    throw new CodegenieError(
      "invalid_args",
      "LLM_API_KEY requires a model input with a provider prefix (e.g. anthropic/claude-opus-5) so the key can be routed"
    );
  }
  const providers = [...new Set(selectable.map((spec) => spec.provider as string))];
  const envVarNames = new Set(providers.map((provider) => getPiApiKeyEnvVarName(provider)));
  if (envVarNames.size > 1) {
    throw new CodegenieError(
      "invalid_args",
      `llm-api-key is a single key, but models use providers ${providers.join(", ")}. Remove llm-api-key and set each provider's env var (see models.md#credentials).`
    );
  }
  const [envVarName] = envVarNames;
  if (envVarName === undefined) {
    throw new CodegenieError(
      "invalid_args",
      `provider ${providers.join(", ")} does not accept an API key; set its native credentials instead of LLM_API_KEY`
    );
  }
  for (const provider of providers) {
    for (const name of getPiCredentialEnvVarNames(provider)) {
      delete env[name];
    }
  }
  env[envVarName] = key;
  return providers;
}

function modelsError(detail: string): CodegenieError {
  return new CodegenieError("invalid_args", `--models ${detail}`);
}
