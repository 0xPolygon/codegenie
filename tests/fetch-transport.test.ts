import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error The development-only runner is intentionally plain ESM.
import { CampaignLedger } from "../evals/runner/ledger.mjs";
// @ts-expect-error The development-only runner is intentionally plain ESM.
import { makePhysicalTransport } from "../evals/runner/physical-fetch.mjs";
import { describe, expect, it, vi } from "vitest";
import { captureTransportAdmission, projectProviderUsage, TransportAdmissionError } from "../src/llm/transport-admission.js";
import { createRealPiAiAdapter } from "../src/llm/pi-runner.js";

describe("physical transport seam", () => {
  it("sees Pi's retry as two physical requests and keeps the first usage unknown", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "synthetic-key");
    try {
      const adapter = createRealPiAiAdapter();
      const model = (await adapter.resolveModel({ provider: "openrouter", model: "openai/gpt-6-luna" }))!;
      const dir = mkdtempSync(path.join(tmpdir(), "codegenie-ledger-retry-"));
      const ledger = new CampaignLedger(path.join(dir, "calls.sqlite"), { binding: "synthetic", limitMicros: 15_000_000 });
      const keyFingerprint = ledger.fingerprint("synthetic-key");
      ledger.bindKeyBaseline({ usageMicros: 0, keyFingerprint, evidenceSHA256: "a".repeat(64) });
      ledger.recordKeySnapshot({ boundaryId: 'boundary', usageMicros: 0, observedMs: 0, keyFingerprint, evidenceSHA256: "b".repeat(64) });
      const calls: Array<{ body: string; usage: number | null }> = [];
      const observed: unknown[] = [];
      const fetchFixture: typeof globalThis.fetch = async (_input, init) => {
        const body = String(init?.body);
        calls.push({ body, usage: null });
        if (calls.length === 1) {
          return new Response(JSON.stringify({ error: { message: "transient", type: "server_error" } }), { status: 500, headers: { "content-type": "application/json", "retry-after": "0" } });
        }
        const chunks = [
          { id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] },
          { id: "fixture", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.000123, is_byok: false } }
        ];
        return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
      };
      const call = { callId: "mc-1", provider: "openrouter", modelId: model.id, reasoningSelected: "high", templateVersion: "p7", kind: "initial" };
      const expected = { ...call, api: "openai-completions", destination: "https://openrouter.ai/api/v1/chat/completions", wireEffort: "high" };
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix: "slot/attempt-01", fetchImpl: fetchFixture, AdmissionError: TransportAdmissionError });
      const result = await adapter.complete(model, { messages: [{ role: "user", content: "fixture", timestamp: 0 }], tools: [] }, { submitToolName: "submit_review", fetch: transport.fetch, reasoning: "high", maxRetries: 1,
        onProviderStreamEvent: (chunk: unknown) => { const usage = projectProviderUsage(chunk); if (usage) { observed.push(usage); transport.onUsage(usage); } } });
      expect(calls).toHaveLength(2);
      expect(observed).toEqual([
        { source: "provider_chunk", usagePresent: false, costPresent: false, reasoningTokensPresent: false },
        { source: "provider_chunk", usagePresent: true, costPresent: true, reasoningTokensPresent: false, inputTokens: 10, outputTokens: 5, totalTokens: 15, providerCost: 0.000123, providerBilledCost: 0.000123, providerCostLowerBound: 0.000123, isByok: false }
      ]);
      expect(calls[0]?.body).toBe(calls[1]?.body);
      expect(result.usage?.totalTokens).toBe(15);
      // The native usage event belongs to the successful physical attempt.
      calls[1]!.usage = result.usage?.totalTokens ?? null;
      expect(calls.map((call) => call.usage)).toEqual([null, 15]);
      const cost = result.usage?.cost as { total: number; totalFromProvider?: boolean } | undefined;
      expect(cost?.totalFromProvider).toBe(true);
      transport.onUsage({ source: "terminal", terminal: "done", costFromProvider: cost?.totalFromProvider, providerCost: cost?.total });
      const rows = ledger.db.prepare("SELECT logical_id,state,charge FROM physical ORDER BY id").all();
      expect(rows).toEqual([{ logical_id: "slot/attempt-01/mc-1", state: "unknown", charge: 400_000 }, { logical_id: "slot/attempt-01/mc-1", state: "priced", charge: 123 }]);
      ledger.close(); rmSync(dir, { recursive: true, force: true });
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

  it("distinguishes missing usage from an explicitly reported zero", () => {
    expect(projectProviderUsage({ choices: [{ delta: { content: "do not retain" } }] })).toEqual({ source: "provider_chunk", usagePresent: false, costPresent: false, reasoningTokensPresent: false });
    expect(projectProviderUsage({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0,
      completion_tokens_details: { reasoning_tokens: 0 } }, secret: "do not retain" })).toEqual({
      source: "provider_chunk", usagePresent: true, costPresent: true, reasoningTokensPresent: true,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, providerCost: 0, providerCostLowerBound: 0
    });
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
      const dir = mkdtempSync(path.join(tmpdir(), "codegenie-ledger-denial-"));
      const ledger = new CampaignLedger(path.join(dir, "calls.sqlite"), { binding: "synthetic", limitMicros: 400_000 });
      let admitted = 0, denied = 0, attempts = 0;
      const wrapped = captureTransportAdmission(async () => {
        const id = `mc-2/physical-${++attempts}`;
        if (!ledger.reservePhysical({ id, logicalId: "mc-2", kind: "review" }).admitted) { denied++; throw new TransportAdmissionError("campaign_budget"); }
        admitted++;
        ledger.settlePhysical({ id, httpStatus: 500 });
        return new Response(JSON.stringify({ error: { message: "transient", type: "server_error" } }), { status: 500, headers: { "content-type": "application/json", "retry-after": "0" } });
      });
      await adapter.complete(model, { messages: [{ role: "user", content: "fixture", timestamp: 0 }], tools: [] }, { submitToolName: "submit_review", fetch: wrapped.fetch, maxRetries: 1 });
      expect(admitted).toBe(1);
      expect(denied).toBe(1);
      expect(wrapped.denial()).toMatchObject({ code: "budget_exhausted", recoverable: false, context: { reason: "campaign_budget" } });
      expect(ledger.db.prepare("SELECT logical_id,state,charge FROM physical").all()).toEqual([{ logical_id: "mc-2", state: "unknown", charge: 400_000 }]);
      expect(ledger.db.prepare("SELECT logical_id,reason FROM local_refusal").all()).toEqual([{ logical_id: "mc-2", reason: "campaign_budget" }]);
      ledger.close(); rmSync(dir, { recursive: true, force: true });
    } finally { vi.unstubAllEnvs(); }
  });

});
