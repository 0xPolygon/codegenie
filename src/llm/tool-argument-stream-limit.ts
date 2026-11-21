import type { ReviewStage } from "../types.js";

const VERIFIER_TOOL_ARGUMENT_LIMIT_CHARS = 64_000;
const COMPOSER_TOOL_ARGUMENT_LIMIT_CHARS = 128_000;
const CONSECUTIVE_WHITESPACE_LIMIT_CHARS = 4_096;

export type ToolArgumentStreamLimit = {
  trigger: "whitespace_run" | "total_chars";
  limitChars: number;
  observedChars: number;
  toolArgumentChars: number;
  contentIndex: number;
};

export function createToolArgumentStreamGuard(
  stage: ReviewStage
): ((contentIndex: number, delta: string, toolArgumentChars: number) => ToolArgumentStreamLimit | undefined) | undefined {
  const totalLimit = stage === 9 ? VERIFIER_TOOL_ARGUMENT_LIMIT_CHARS
    : stage === 10 ? COMPOSER_TOOL_ARGUMENT_LIMIT_CHARS : undefined;
  if (totalLimit === undefined) return undefined;

  // Pi can interleave deltas for different tool calls. Whitespace only forms
  // a run within a single argument string, but the total is per response.
  const trailingWhitespace = new Map<number, number>();
  return (contentIndex, delta, toolArgumentChars) => {
    let whitespace = trailingWhitespace.get(contentIndex) ?? 0;
    // Scan only through the first character that exceeds the total limit.
    const scanChars = Math.min(delta.length, totalLimit - (toolArgumentChars - delta.length) + 1);
    for (let index = 0; index < scanChars; index++) {
      const char = delta[index];
      whitespace = char === " " || char === "\n" || char === "\t" || char === "\r" ? whitespace + 1 : 0;
      if (whitespace > CONSECUTIVE_WHITESPACE_LIMIT_CHARS) {
        return {
          trigger: "whitespace_run", limitChars: CONSECUTIVE_WHITESPACE_LIMIT_CHARS,
          observedChars: whitespace, toolArgumentChars, contentIndex
        };
      }
    }
    if (toolArgumentChars > totalLimit) {
      return {
        trigger: "total_chars", limitChars: totalLimit,
        observedChars: toolArgumentChars, toolArgumentChars, contentIndex
      };
    }
    if (whitespace > 0) trailingWhitespace.set(contentIndex, whitespace);
    else trailingWhitespace.delete(contentIndex);
    return undefined;
  };
}
