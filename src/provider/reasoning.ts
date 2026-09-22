import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { REASONING_LEVELS } from "../config/schema.js";
import type { ReasoningLevel } from "../types.js";
import { CodegenieError, type CodegenieErrorCode } from "../util/errors.js";

// `<low|medium|high|xhigh|max|auto>` — the one usage string every reasoning
// argument prints, so help text cannot drift from the schema.
export const REASONING_USAGE = `<${[...REASONING_LEVELS, "auto"].join("|")}>`;

export function isReasoningLevel(value: string): value is ReasoningLevel {
  return (REASONING_LEVELS as readonly string[]).includes(value);
}

// Parses a reasoning argument; `auto` clears the layer being set.
export function parseReasoningLevel(value: string, flag: string): ReasoningLevel | "auto" {
  if (value === "auto" || isReasoningLevel(value)) {
    return value;
  }
  throw new CodegenieError("invalid_args", `${flag} must be one of: ${[...REASONING_LEVELS, "auto"].join(", ")}`);
}

// `model[:reasoning]`, e.g. `deepseek/deepseek-v4.1-flash:max`. A `:suffix`
// that is not a reasoning level stays part of the model id (ollama-style
// `llama3:8b`); the provider prefix, if any, is left for the caller.
export function splitReasoningSuffix(spec: string): { model: string; reasoning?: ReasoningLevel | "auto" } {
  const colon = spec.lastIndexOf(":");
  const suffix = colon > -1 ? spec.slice(colon + 1) : "";
  if (suffix === "auto" || isReasoningLevel(suffix)) {
    return { model: spec.slice(0, colon), reasoning: suffix };
  }
  return { model: spec };
}

// The reasoning levels a Pi model advertises, minus `off`. Empty for models
// without reasoning and for unknown shapes (test fakes).
export function modelThinkingLevels(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) {
    return [];
  }
  return getSupportedThinkingLevels(raw as Model<Api>).filter((level) => level !== "off");
}

// A level a model does not advertise is an error naming the ones it does; a
// model that advertises none ignores the level, so nothing to check.
export function assertReasoningSupported(
  model: { provider: string; id: string; thinkingLevels: readonly string[] },
  reasoning: ReasoningLevel,
  code: CodegenieErrorCode = "invalid_args"
): void {
  if (model.thinkingLevels.length === 0 || model.thinkingLevels.includes(reasoning)) {
    return;
  }
  throw new CodegenieError(
    code,
    `${model.provider}/${model.id} does not support reasoning ${reasoning}; supported levels: ${model.thinkingLevels.join(", ")}`,
    { context: { provider: model.provider, model: model.id, reasoning, supported: [...model.thinkingLevels] } }
  );
}

export type ReasoningPolicy = "configured" | "one_level_lower" | "lowest_supported";
const ORDERED_REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

// Relative positions are model-local; they do not imply equal capability or
// token budgets across providers. Unknown capabilities retain configuration.
export function selectReasoningEffort(
  configured: string,
  supported: readonly string[],
  policy: ReasoningPolicy
): string {
  if (policy === "configured") return configured;
  const levels = ORDERED_REASONING_LEVELS.filter((level) => supported.includes(level));
  if (levels.length === 0) return configured;
  if (policy === "lowest_supported") return levels[0]!;
  const index = levels.findIndex((level) => level === configured);
  return index < 0 ? configured : levels[Math.max(0, index - 1)]!;
}
