import type { ReviewStage } from "../types.js";

const TOOL_ARGUMENT_LIMIT_CHARS: Partial<Record<ReviewStage, number>> = {
  5: 128_000,
  7: 64_000,
  9: 64_000,
  10: 128_000
};
const CONSECUTIVE_WHITESPACE_LIMIT_CHARS = 4_096;

export type ToolArgumentStreamLimit = {
  trigger: "whitespace_run" | "total_chars";
  limitChars: number;
  observedChars: number;
  toolArgumentChars: number;
  contentIndex: number;
  toolName?: string;
  // Positions describe only the observed triggering run, not a final snapshot.
  whitespacePositions?: { insideString: number; outsideString: number; indeterminate: number };
};

export function createToolArgumentStreamGuard(
  stage: ReviewStage
): ((contentIndex: number, delta: string, toolArgumentChars: number, startObserved?: boolean) => ToolArgumentStreamLimit | undefined) | undefined {
  const totalLimit = TOOL_ARGUMENT_LIMIT_CHARS[stage];
  if (totalLimit === undefined) return undefined;

  // Pi can interleave deltas for different tool calls. Whitespace only forms
  // a run within a single argument string, but the total is per response.
  type State = {
    whitespace: number;
    positions: { insideString: number; outsideString: number; indeterminate: number };
    inString: boolean;
    escape: boolean;
    unicodeDigits: number;
    indeterminate: boolean;
  };
  const states = new Map<number, State>();
  return (contentIndex, delta, toolArgumentChars, startObserved = false) => {
    const state = states.get(contentIndex) ?? {
      whitespace: 0, positions: { insideString: 0, outsideString: 0, indeterminate: 0 },
      inString: false, escape: false, unicodeDigits: 0, indeterminate: false
    };
    if (!startObserved) state.indeterminate = true;
    // Scan only through the first character that exceeds the total limit.
    const scanChars = Math.min(delta.length, totalLimit - (toolArgumentChars - delta.length) + 1);
    for (let index = 0; index < scanChars; index++) {
      const char = delta[index]!;
      const isWhitespace = char === " " || char === "\n" || char === "\t" || char === "\r";
      if (!state.indeterminate) {
        if (state.unicodeDigits > 0) {
          if (!/[0-9a-fA-F]/u.test(char)) state.indeterminate = true;
          else state.unicodeDigits--;
        } else if (state.escape) {
          state.escape = false;
          if (char === "u") state.unicodeDigits = 4;
          else if (!'"\\/bfnrt'.includes(char)) state.indeterminate = true;
        } else if (state.inString) {
          if (char === "\\") state.escape = true;
          else if (char === '"') state.inString = false;
          else if (char.charCodeAt(0) < 0x20 && !isWhitespace) state.indeterminate = true;
        } else if (char === '"') state.inString = true;
        else if (char === "\\" || char.charCodeAt(0) < 0x20 && !isWhitespace) state.indeterminate = true;
      }
      if (isWhitespace) {
        state.whitespace++;
        const position = state.indeterminate ? "indeterminate" : state.inString ? "insideString" : "outsideString";
        state.positions[position]++;
      } else {
        state.whitespace = 0;
        state.positions = { insideString: 0, outsideString: 0, indeterminate: 0 };
      }
      if (state.whitespace > CONSECUTIVE_WHITESPACE_LIMIT_CHARS) {
        return {
          trigger: "whitespace_run", limitChars: CONSECUTIVE_WHITESPACE_LIMIT_CHARS,
          observedChars: state.whitespace, toolArgumentChars, contentIndex, whitespacePositions: state.positions
        };
      }
    }
    if (toolArgumentChars > totalLimit) {
      return {
        trigger: "total_chars", limitChars: totalLimit,
        observedChars: toolArgumentChars, toolArgumentChars, contentIndex
      };
    }
    if (delta.length > 0) states.set(contentIndex, state);
    return undefined;
  };
}
