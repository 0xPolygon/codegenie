import { describe, expect, it, vi } from "vitest";
import { observeOpenRouterResponse } from "../src/llm/openrouter-response-observer.js";

describe("OpenRouter response observer", () => {
  it("forwards split bytes unchanged and treats an oversized frame as uncertain", async () => {
    const original = new TextEncoder().encode(`data: ${JSON.stringify({ text: "x".repeat(70_000) })}\r\n\r\ndata: {"provider":"Azure"}\r\n\r\n`);
    let offset = 0;
    const source = new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset === original.length) { controller.close(); return; }
      controller.enqueue(original.subarray(offset, Math.min(offset + 317, original.length)));
      offset = Math.min(offset + 317, original.length);
    } }, { highWaterMark: 0 });
    const observe = vi.fn();
    const response = observeOpenRouterResponse(new Response(source, { headers: { "content-type": "text/event-stream" } }), observe);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(original);
    expect(observe).not.toHaveBeenCalled();
  });

  it("stops at the first error even when later frames share its chunk", async () => {
    const observe = vi.fn();
    const frames = 'data: {"error":{"message":"ordinary"}}\n\ndata: {"provider":"Wrong","error":{"message":"content policy"}}\n\n';
    await observeOpenRouterResponse(new Response(frames, { headers: { "content-type": "text/event-stream" } }), observe).text();
    expect(observe).toHaveBeenCalledExactlyOnceWith({ error: { message: "ordinary" } }, true);
  });

  it("ignores thread envelopes and identifies a named error without an error field", async () => {
    const observe = vi.fn();
    const frames = 'event: thread.foo\ndata: {"error":{"message":"content policy"}}\n\nevent: error\ndata: {"message":"ordinary"}\n\n';
    await observeOpenRouterResponse(new Response(frames, { headers: { "content-type": "text/event-stream" } }), observe).text();
    expect(observe).toHaveBeenCalledExactlyOnceWith({ message: "ordinary" }, true);
  });

  it("does not attribute a later error after a named event with no data", async () => {
    const observe = vi.fn();
    const frames = 'event: ping\n\ndata: {"provider":"Wrong","error":{"message":"content policy"}}\n\n';
    await observeOpenRouterResponse(new Response(frames, { headers: { "content-type": "text/event-stream" } }), observe).text();
    expect(observe).not.toHaveBeenCalled();
  });

  it("keeps an over-limit comment in the same frame until a real blank line", async () => {
    const observe = vi.fn();
    const frame = `:${"x".repeat(65_536)}\ndata: {"provider":"Azure"}\n\n`;
    await observeOpenRouterResponse(new Response(frame, { headers: { "content-type": "text/event-stream" } }), observe).text();
    expect(observe).not.toHaveBeenCalled();
  });

  it("propagates consumer cancellation without draining the source", async () => {
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => controller.enqueue(new TextEncoder().encode("data: ")));
    const source = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const reader = observeOpenRouterResponse(new Response(source, { headers: { "content-type": "text/event-stream" } }), vi.fn()).body!.getReader();
    await reader.read();
    await reader.cancel("finished");
    expect(pull).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledExactlyOnceWith("finished");
  });
});
