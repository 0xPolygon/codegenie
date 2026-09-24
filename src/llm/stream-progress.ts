import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

export type StreamProgress = {
  eventCount: number;
  firstEventMs?: number;
  firstContentMs?: number;
  lastEventMs?: number;
  lastContentMs?: number;
  idleMs: number;
  contentIdleMs: number;
  textChunks: number;
  textChars: number;
  thinkingChunks: number;
  thinkingChars: number;
  toolArgumentChunks: number;
  toolArgumentChars: number;
  terminalEvent?: "done" | "error";
};

// Pi events, not raw SSE frames: keep-alives and provider-hidden reasoning
// cannot be observed here. Counts are characters, never token estimates.
export function createStreamProgress(
  report: (progress: StreamProgress) => void,
  now: () => number = Date.now
): { observe(event: AssistantMessageEvent): void; snapshot(): StreamProgress } {
  const started = now();
  const state: Omit<StreamProgress, "idleMs" | "contentIdleMs"> = {
    eventCount: 0, textChunks: 0, textChars: 0, thinkingChunks: 0,
    thinkingChars: 0, toolArgumentChunks: 0, toolArgumentChars: 0
  };
  let lastReport = -Infinity;
  const snapshot = (): StreamProgress => ({
    ...state,
    idleMs: Math.max(0, now() - started - (state.lastEventMs ?? 0)),
    contentIdleMs: Math.max(0, now() - started - (state.lastContentMs ?? 0))
  });
  return {
    snapshot,
    observe(event) {
      const elapsed = now() - started;
      const firstContent = state.firstContentMs === undefined;
      state.eventCount++;
      state.firstEventMs ??= elapsed;
      state.lastEventMs = elapsed;
      if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
        const prefix = event.type === "text_delta" ? "text"
          : event.type === "thinking_delta" ? "thinking" : "toolArgument";
        state[`${prefix}Chunks`]++;
        state[`${prefix}Chars`] += event.delta.length;
        if (event.delta.length > 0) {
          state.firstContentMs ??= elapsed;
          state.lastContentMs = elapsed;
        }
      }
      if (event.type === "done" || event.type === "error") state.terminalEvent = event.type;
      if (state.eventCount === 1 || (firstContent && state.firstContentMs !== undefined)
        || elapsed - lastReport >= 30_000 || state.terminalEvent) {
        lastReport = elapsed;
        report(snapshot());
      }
    }
  };
}
