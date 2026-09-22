import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createStreamProgress, type StreamProgress } from "../src/llm/stream-progress.js";

describe("stream progress diagnostics", () => {
  it("distinguishes lifecycle events from content and measures idle time without retaining text", () => {
    let time = 1000;
    const reports: StreamProgress[] = [];
    const tracker = createStreamProgress((value) => reports.push(value), () => time);
    const emit = (event: unknown) => tracker.observe(event as AssistantMessageEvent);
    time += 100;
    emit({ type: "start" });
    expect(tracker.snapshot().firstContentMs).toBeUndefined();
    time += 200;
    emit({ type: "thinking_delta", delta: "secret" });
    time += 100;
    emit({ type: "text_delta", delta: "hello" });
    emit({ type: "toolcall_delta", delta: '{"ok":' });
    time += 40_000;
    expect(tracker.snapshot()).toMatchObject({
      firstEventMs: 100, firstContentMs: 300, lastContentMs: 400,
      idleMs: 40_000, contentIdleMs: 40_000,
      thinkingChunks: 1, thinkingChars: 6, textChunks: 1, textChars: 5,
      toolArgumentChunks: 1, toolArgumentChars: 6
    });
    emit({ type: "done" });
    expect(tracker.snapshot()).toMatchObject({ terminalEvent: "done", idleMs: 0, contentIdleMs: 40_000 });
    expect(JSON.stringify(reports)).not.toContain("secret");
    expect(reports).toHaveLength(3);
  });

  it("records no-content waits and throttles progress reports", () => {
    let time = 0;
    const reports: StreamProgress[] = [];
    const tracker = createStreamProgress((value) => reports.push(value), () => time);
    time = 180_000;
    expect(tracker.snapshot()).toMatchObject({ eventCount: 0, idleMs: 180_000 });
    for (let i = 0; i < 100; i++) {
      tracker.observe({ type: "text_delta", delta: "a" } as AssistantMessageEvent);
    }
    expect(reports).toHaveLength(1);
    time += 30_000;
    tracker.observe({ type: "text_delta", delta: "b" } as AssistantMessageEvent);
    expect(reports).toHaveLength(2);
    expect(tracker.snapshot().textChunks).toBe(101);
  });
});
