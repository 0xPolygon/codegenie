import { describe, expect, it, vi } from "vitest";
import { captureTransportAdmission, TransportAdmissionError } from "../src/llm/transport-admission.js";
import { createRealPiAiAdapter } from "../src/llm/pi-runner.js";

describe("physical transport seam", () => {
  it("sees Pi's retry as two physical requests and keeps the first usage unknown", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "synthetic-key");
    try {
      const adapter = createRealPiAiAdapter();
      const model = (await adapter.resolveModel({ provider: "openrouter", model: "openai/gpt-6-luna" }))!;
      const calls: Array<{ body: string; usage: number | null }> = [];
      const fetchFixture: typeof globalThis.fetch = async (_input, init) => {
        const body = String(init?.body);
        calls.push({ body, usage: null });
        if (calls.length === 1) return new Response(JSON.stringify({ error: { message: "transient", type: "server_error" } }), { status: 500, headers: { "content-type": "application/json", "retry-after": "0" } });
        const chunks = [
          { id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] },
          { id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
        ];
        return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
      };
      const result = await adapter.complete(model, { messages: [{ role: "user", content: "fixture", timestamp: 0 }], tools: [] }, { submitToolName: "submit_review", fetch: fetchFixture, maxRetries: 1 });
      expect(calls).toHaveLength(2);
      expect(calls[0]?.body).toBe(calls[1]?.body);
      expect(result.usage?.totalTokens).toBe(15);
      // The native usage event belongs to the successful physical attempt.
      calls[1]!.usage = result.usage?.totalTokens ?? null;
      expect(calls.map((call) => call.usage)).toEqual([null, 15]);
    } finally { vi.unstubAllEnvs(); }
  });
  it("uses the default global fetch with identical request bytes when no override is supplied", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "synthetic-key");
    const bodies: string[] = [];
    const syntheticFetch: typeof globalThis.fetch = async (_input, init) => {
      bodies.push(String(init?.body));
      return new Response("synthetic failure", { status: 400 });
    };
    vi.stubGlobal("fetch", syntheticFetch);
    try {
      const adapter = createRealPiAiAdapter();
      const model = (await adapter.resolveModel({ provider: "openrouter", model: "openai/gpt-6-luna" }))!;
      const context = { messages: [{ role: "user", content: "fixture", timestamp: 0 }], tools: [] };
      const options = { submitToolName: "submit_review", maxRetries: 0 };
      await adapter.complete(model, context, options);
      await adapter.complete(model, context, { ...options, fetch: syntheticFetch });
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toBe(bodies[1]);
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });

  it("does not turn a normal fetch failure into a local admission denial", async () => {
    const wrapped = captureTransportAdmission(async () => { throw new Error("synthetic network failure"); });
    await expect(wrapped.fetch("https://synthetic.invalid")).rejects.toThrow("synthetic network failure");
    expect(wrapped.denial()).toBeUndefined();
  });
  it("retains a typed denial of a native retry after one failed physical POST", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "synthetic-key");
    try {
      const adapter = createRealPiAiAdapter();
      const model = (await adapter.resolveModel({ provider: "openrouter", model: "openai/gpt-6-luna" }))!;
      let admitted = 0, denied = 0;
      const wrapped = captureTransportAdmission(async () => {
        if (admitted === 1) { denied++; throw new TransportAdmissionError("campaign_budget"); }
        admitted++;
        return new Response(JSON.stringify({ error: { message: "transient", type: "server_error" } }), { status: 500, headers: { "content-type": "application/json", "retry-after": "0" } });
      });
      await adapter.complete(model, { messages: [{ role: "user", content: "fixture", timestamp: 0 }], tools: [] }, { submitToolName: "submit_review", fetch: wrapped.fetch, maxRetries: 1 });
      expect(admitted).toBe(1);
      expect(denied).toBe(1);
      expect(wrapped.denial()).toMatchObject({ code: "budget_exhausted", recoverable: false, context: { reason: "campaign_budget" } });
    } finally { vi.unstubAllEnvs(); }
  });

});
