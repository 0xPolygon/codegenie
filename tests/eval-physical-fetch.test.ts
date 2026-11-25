import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { projectProviderUsage, TransportAdmissionError } from "../src/llm/transport-admission.js";
// @ts-expect-error Dev-only ESM has no emitted types.
import { CampaignLedger } from "../evals/runner/ledger.mjs";
// @ts-expect-error Dev-only ESM has no emitted types.
import { makePhysicalTransport } from "../evals/runner/physical-fetch.mjs";
// @ts-expect-error Dev-only ESM has no emitted types.
import { resolveExpectedCall } from "../evals/runner/packet-templates.mjs";

const call = { callId: "mc-1", provider: "openrouter", modelId: "model", reasoningSelected: "high", templateVersion: "p7", kind: "initial" };
const expected = { ...call, api: "openai-completions", destination: "https://synthetic.invalid/chat", wireEffort: "high" };
const init = { method: "POST", headers: { authorization: "Bearer test-key" }, body: JSON.stringify({ model: "model", reasoning: { effort: "high" } }) };
const chunkZero = { source: "provider_chunk", usagePresent: true, costPresent: false, reasoningTokensPresent: false, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const terminal = { source: "terminal", usagePresent: false, costPresent: false, reasoningTokensPresent: false, terminal: "error", costFromProvider: false };

function testLedger(file: string, config: { binding: string; limitMicros: number }) {
  const ledger = new CampaignLedger(file, config);
  if (!ledger.db.prepare("SELECT 1 FROM key_baseline").get()) {
    const keyFingerprint = ledger.fingerprint("test-key");
    ledger.bindKeyBaseline({ usageMicros: 0, keyFingerprint, evidenceSHA256: "a".repeat(64) });
    ledger.recordKeySnapshot({ boundaryId: 'boundary', usageMicros: 0, observedMs: 0, keyFingerprint, evidenceSHA256: "b".repeat(64) });
  }
  return ledger;
}

describe("physical fetch settlement", () => {
  it.each([{ stage: 9, kind: 'repair', purpose: undefined }, { stage: 7, kind: 'initial', purpose: 'location_clarification' }] as const)(
    'admits uniform-high $kind and refuses a mismatched physical effort', async ({ stage, kind, purpose }) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'codegenie-uniform-effort-'));
      try {
        const expectedCall = { ...expected, stage, kind, ...(purpose ? { purpose } : {}) };
        const current = { ...call, stage, kind, ...(purpose ? { purpose } : {}) };
        const ledger = testLedger(path.join(dir, 'ok'), { binding: 'ok', limitMicros: 2_000_000 });
        const fetchImpl = vi.fn(async () => new Response('ok'));
        const admitted = makePhysicalTransport({ ledger, call: current, expected: resolveExpectedCall([expectedCall], current), attemptPrefix: 'slot/attempt-01', fetchImpl, AdmissionError: TransportAdmissionError });
        await admitted.fetch(expected.destination, init);
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(ledger.totals().starts).toBe(1); ledger.close();
        const deniedLedger = testLedger(path.join(dir, 'denied'), { binding: 'denied', limitMicros: 2_000_000 });
        const wrong = { ...current, reasoningSelected: 'low' };
        const denied = makePhysicalTransport({ ledger: deniedLedger, call: wrong, expected: resolveExpectedCall([expectedCall], wrong), attemptPrefix: 'slot/attempt-01', fetchImpl, AdmissionError: TransportAdmissionError });
        await expect(denied.fetch(expected.destination, init)).rejects.toMatchObject({ context: { reason: 'binding_mismatch' } });
        expect(fetchImpl).toHaveBeenCalledOnce(); expect(deniedLedger.totals().starts).toBe(0); deniedLedger.close();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  it("refuses a health probe before a key baseline exists", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-health-baseline-"));
    try {
      const ledger = new CampaignLedger(path.join(dir, "db"), { binding: "test", limitMicros: 2_000_000 });
      const fetchImpl = vi.fn(async () => new Response("ok"));
      const transport = makePhysicalTransport({ ledger, call, expected, healthBoundary: "boundary", healthPurpose: "admission", attemptPrefix: "health/attempt-01", fetchImpl, AdmissionError: TransportAdmissionError });
      await expect(transport.fetch(expected.destination, init)).rejects.toMatchObject({ context: { reason: "binding_mismatch" } });
      expect(fetchImpl).not.toHaveBeenCalled(); expect(ledger.totals()).toMatchObject({ starts: 0, stopped: "binding_mismatch" }); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(["Bearer key-b", ""])("rejects an incorrect or absent key before physical start", async (authorization) => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-key-binding-"));
    try {
      const ledger = new CampaignLedger(path.join(dir, "db"), { binding: "test", limitMicros: 2_000_000 });
      const fingerprint = ledger.fingerprint("key-a");
      ledger.bindKeyBaseline({ usageMicros: 0, keyFingerprint: fingerprint, evidenceSHA256: "a".repeat(64) });
      const fetchImpl = vi.fn(async () => new Response("ok"));
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix: "slot/attempt-01", fetchImpl, AdmissionError: TransportAdmissionError });
      const headers = authorization ? { authorization } : {};
      await expect(transport.fetch(expected.destination, { ...init, headers })).rejects.toMatchObject({ context: { reason: "binding_mismatch" } });
      expect(fetchImpl).not.toHaveBeenCalled(); expect(ledger.totals()).toMatchObject({ starts: 0, stopped: "binding_mismatch" });
      ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([false, true])("stops and preserves the physical charge if settlement fails %s commit", async (afterCommit) => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const file = path.join(dir, "db"), config = { binding: "test", limitMicros: 2_000_000 };
      let ledger = testLedger(file, config);
      const settle = ledger.settlePhysical.bind(ledger);
      ledger.settlePhysical = (entry: unknown) => { if (afterCommit) settle(entry); throw new Error("synthetic settlement failure"); };
      const fetchImpl = vi.fn(async () => new Response("ok"));
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix: "slot/attempt-01", fetchImpl, AdmissionError: TransportAdmissionError });
      await transport.fetch(expected.destination, init);
      expect(() => transport.onUsage({ ...terminal, terminal: "done", costFromProvider: true, providerCost: 0.01 })).toThrow();
      ledger.close(); ledger = testLedger(file, config);
      expect(ledger.totals()).toMatchObject({ starts: 1, chargedMicros: afterCommit ? 10_000 : 400_000, stopped: "accounting_failed" });
      const restart = makePhysicalTransport({ ledger, call, expected, attemptPrefix: "slot/attempt-02", fetchImpl, AdmissionError: TransportAdmissionError });
      await expect(restart.fetch(expected.destination, init)).rejects.toMatchObject({ context: { reason: "accounting_failed" } });
      expect(fetchImpl).toHaveBeenCalledTimes(1); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps delayed stream callbacks bound to the original physical attempt', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codegenie-stale-stream-')), db = path.join(dir, 'db');
    let ledger = testLedger(db, { binding: 'test', limitMicros: 2_000_000 });
    try {
      const fetchImpl = vi.fn(async () => new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix: 'slot/attempt-01', fetchImpl, AdmissionError: TransportAdmissionError });
      const first = await transport.fetch(expected.destination, init), second = await transport.fetch(expected.destination, init);
      await first.text(); await second.text(); transport.onUsage({ ...terminal, terminal: 'done' });
      ledger.close(); ledger = testLedger(db, { binding: 'test', limitMicros: 2_000_000 });
      expect(ledger.db.prepare('SELECT id,stream_terminal,state,charge FROM physical ORDER BY id').all()).toEqual([
        { id: 'slot/attempt-01/mc-1/physical-1', stream_terminal: null, state: 'unknown', charge: 400_000 },
        { id: 'slot/attempt-01/mc-1/physical-2', stream_terminal: 'done', state: 'unknown', charge: 400_000 }
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(2); ledger.assertRestartSafe();
      ledger.recordStreamTerminal('slot/attempt-01/mc-1/physical-2', 'done');
      expect(() => ledger.recordStreamTerminal('slot/attempt-01/mc-1/physical-2', 'body_reset')).toThrow('reconciliation');
      ledger.db.prepare("UPDATE physical SET stream_terminal='unrecognized' WHERE id=?").run('slot/attempt-01/mc-1/physical-2');
      expect(() => ledger.assertRestartSafe()).toThrow('reconciliation');
    } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('stops further starts when terminal evidence cannot be committed', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codegenie-stream-write-')), db = path.join(dir, 'db');
    let ledger = testLedger(db, { binding: 'test', limitMicros: 2_000_000 });
    try {
      const fetchImpl = vi.fn(async () => new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix: 'slot/attempt-01', fetchImpl, AdmissionError: TransportAdmissionError });
      ledger.recordStreamTerminal = () => { throw new Error('synthetic sqlite failure'); };
      const result = await transport.fetch(expected.destination, init);
      await expect(result.text()).rejects.toThrow();
      expect(() => transport.onUsage({ ...terminal, terminal: 'done' })).toThrow();
      await expect(transport.fetch(expected.destination, init)).rejects.toMatchObject({ context: { reason: 'accounting_failed' } });
      ledger.close(); ledger = testLedger(db, { binding: 'test', limitMicros: 2_000_000 });
      expect(ledger.totals()).toMatchObject({ starts: 1, chargedMicros: 400_000, open: 1, stopped: 'accounting_failed' });
      expect(fetchImpl).toHaveBeenCalledTimes(1); expect(() => ledger.assertRestartSafe()).toThrow('unmatched physical');
    } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("retains the first retry hold and settles only the response producing usage", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const ledger = testLedger(path.join(dir, "db"), { binding: "test", limitMicros: 2_000_000 });
      const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("error", { status: 500 })).mockResolvedValueOnce(new Response("ok", { status: 200 }));
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix: "slot/attempt-01", fetchImpl, AdmissionError: TransportAdmissionError });
      await transport.fetch(expected.destination, init); await transport.fetch(expected.destination, init);
      transport.onUsage({ ...terminal, terminal: "done", costFromProvider: true, providerCost: 0.000123 });
      expect(ledger.db.prepare("SELECT logical_id,state,charge FROM physical ORDER BY id").all()).toEqual([
        { logical_id: "slot/attempt-01/mc-1", state: "unknown", charge: 400_000 }, { logical_id: "slot/attempt-01/mc-1", state: "priced", charge: 123 }
      ]);
      transport.onUsage({ ...terminal, terminal: "done", costFromProvider: true, providerCost: 0.000123 });
      expect(ledger.totals().starts).toBe(2);
      ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([false, true])("distinguishes missing usage from an explicit zero error (%s)", async (hasUsage) => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const ledger = testLedger(path.join(dir, "db"), { binding: "test", limitMicros: 2_000_000 });
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix: "slot/attempt-01", fetchImpl: async () => new Response("ok", { status: 200 }), AdmissionError: TransportAdmissionError });
      await transport.fetch(expected.destination, init);
      if (hasUsage) transport.onUsage(chunkZero);
      transport.onUsage(terminal);
      expect(ledger.totals().chargedMicros).toBe(hasUsage ? 50_000 : 400_000);
      ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([
    [{ cost: 0.1, is_byok: true, cost_details: { upstream_inference_cost: 0.2 } }, "priced", 300_001, null],
    [{ cost: 0, is_byok: false }, "priced", 0, null],
    [{ cost: 0.1, is_byok: true }, "unknown", 400_000, null],
    [{ cost: 0.45, is_byok: true }, "unknown", 450_000, "unpriced_lower_bound"]
  ] as const)("preserves raw provider cost on an error terminal %#", async (usage, state, charge, stopped) => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const file = path.join(dir, "db"); const config = { binding: "test", limitMicros: 2_000_000 };
      let ledger = testLedger(file, config);
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix: "slot/attempt-01", fetchImpl: async () => new Response("ok", { status: 200 }), AdmissionError: TransportAdmissionError });
      await transport.fetch(expected.destination, init);
      transport.onUsage(projectProviderUsage({ usage }));
      transport.onUsage(terminal); ledger.close(); ledger = testLedger(file, config);
      expect(ledger.db.prepare("SELECT state,charge FROM physical").get()).toEqual({ state, charge });
      expect(ledger.totals().stopped).toBe(stopped); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("does not treat an earlier zero as final after later provider output", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const ledger = testLedger(path.join(dir, "db"), { binding: "test", limitMicros: 2_000_000 });
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix: "slot/attempt-01", fetchImpl: async () => new Response("ok"), AdmissionError: TransportAdmissionError });
      await transport.fetch(expected.destination, init);
      transport.onUsage(chunkZero);
      transport.onUsage(projectProviderUsage({ choices: [{ delta: { content: "later" } }] }));
      transport.onUsage(terminal);
      expect(ledger.totals()).toMatchObject({ chargedMicros: 400_000, unknown: 1 }); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("does not qualify a later zero when an earlier usage block reported tokens", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const ledger = testLedger(path.join(dir, "db"), { binding: "test", limitMicros: 2_000_000 });
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix: "slot/attempt-01", fetchImpl: async () => new Response("ok"), AdmissionError: TransportAdmissionError });
      await transport.fetch(expected.destination, init);
      transport.onUsage({ ...chunkZero, inputTokens: 10, totalTokens: 10 });
      transport.onUsage(chunkZero); transport.onUsage(terminal);
      expect(ledger.totals()).toMatchObject({ chargedMicros: 400_000, unknown: 1 }); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("charges independently known BYOK components as an unknown lower bound", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const file = path.join(dir, "db"), config = { binding: "test", limitMicros: 2_000_000 };
      let ledger = testLedger(file, config);
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix: "slot/attempt-01", fetchImpl: async () => new Response("ok"), AdmissionError: TransportAdmissionError });
      await transport.fetch(expected.destination, init);
      transport.onUsage(projectProviderUsage({ usage: { cost: 0.01, is_byok: true, cost_details: { upstream_inference_cost: null, upstream_inference_prompt_cost: 0.44 } } }));
      transport.onUsage(terminal); ledger.close(); ledger = testLedger(file, config);
      const row = ledger.db.prepare("SELECT state,charge,evidence_json FROM physical").get();
      expect(row).toMatchObject({ state: "unknown", charge: 450_000 });
      expect(JSON.parse(row.evidence_json)).toMatchObject({ usagePresent: true, costPresent: true, isByok: true });
      expect(ledger.totals().stopped).toBe("unpriced_lower_bound"); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps an earlier higher incomplete lower bound when terminal cost contradicts it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const file = path.join(dir, "db"), config = { binding: "test", limitMicros: 2_000_000 };
      let ledger = testLedger(file, config);
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix: "slot/attempt-01", fetchImpl: async () => new Response("ok"), AdmissionError: TransportAdmissionError });
      await transport.fetch(expected.destination, init);
      transport.onUsage(projectProviderUsage({ usage: { cost: 0.45, is_byok: true } }));
      expect(() => transport.onUsage({ ...terminal, costFromProvider: true, providerCost: 0.1 })).toThrow();
      ledger.close(); ledger = testLedger(file, config);
      expect(ledger.db.prepare("SELECT state,charge FROM physical").get()).toEqual({ state: "unknown", charge: 450_000 });
      expect(ledger.totals().stopped).toBe("unpriced_lower_bound"); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("settles a raw billed cost before a later native attempt starts", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const file = path.join(dir, "db"), config = { binding: "test", limitMicros: 2_000_000 };
      let ledger = testLedger(file, config);
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix: "slot/attempt-01", fetchImpl: async () => new Response("ok"), AdmissionError: TransportAdmissionError });
      await transport.fetch(expected.destination, init);
      transport.onUsage(projectProviderUsage({ usage: { cost: 0.45, is_byok: false } }));
      expect(ledger.totals()).toMatchObject({ starts: 1, chargedMicros: 450_000, open: 1, stopped: "unpriced_lower_bound" });
      // A provider total above the reservation latches further admission.
      await expect(transport.fetch(expected.destination, init)).rejects.toMatchObject({ context: { reason: "accounting_failed" } });
      ledger.close(); ledger = testLedger(file, config);
      expect(ledger.db.prepare("SELECT state,charge FROM physical").all()).toEqual([{ state: "priced", charge: 450_000 }]);
      expect(ledger.totals()).toMatchObject({ starts: 1, stopped: "unpriced_lower_bound" }); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("halts with the hold retained when raw and terminal provider totals conflict", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const ledger = testLedger(path.join(dir, "db"), { binding: "test", limitMicros: 2_000_000 });
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix: "slot/attempt-01", fetchImpl: async () => new Response("ok"), AdmissionError: TransportAdmissionError });
      await transport.fetch(expected.destination, init);
      transport.onUsage(projectProviderUsage({ usage: { cost: 0.1, is_byok: false } }));
      expect(() => transport.onUsage({ ...terminal, terminal: "done", costFromProvider: true, providerCost: 0.2 })).toThrow();
      expect(ledger.totals()).toMatchObject({ starts: 1, chargedMicros: 400_000, open: 0, unknown: 1, stopped: "accounting_failed" });
      ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([["binding_mismatch", "binding_mismatch"], ["operator_stop", "campaign_stopped"], ["accounting_failed", "accounting_failed"]] as const)("preserves the meaning of a latched %s stop", async (latched, reason) => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const ledger = testLedger(path.join(dir, "db"), { binding: "test", limitMicros: 2_000_000 });
      ledger.stop(latched);
      const fetchImpl = vi.fn(async () => new Response("ok"));
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix: "slot/attempt-01", fetchImpl, AdmissionError: TransportAdmissionError });
      await expect(transport.fetch(expected.destination, init)).rejects.toMatchObject({ code: "config_error", context: { reason } });
      expect(ledger.totals().starts).toBe(0); expect(fetchImpl).not.toHaveBeenCalled();
      expect(ledger.db.prepare("SELECT reason FROM local_refusal").get()).toEqual({ reason: latched }); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects unsupported APIs before any physical start", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const ledger = testLedger(path.join(dir, "db"), { binding: "test", limitMicros: 2_000_000 });
      const fetchImpl = vi.fn(async () => new Response("ok"));
      const transport = makePhysicalTransport({ ledger, call, expected: { ...expected, api: "anthropic-messages" }, attemptPrefix: "slot/attempt-01", fetchImpl, AdmissionError: TransportAdmissionError });
      await expect(transport.fetch(expected.destination, init)).rejects.toMatchObject({ context: { reason: "binding_mismatch" } });
      expect(fetchImpl).not.toHaveBeenCalled(); expect(ledger.totals().starts).toBe(0); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects a wrong wire before any physical start and latches a provider denial", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const ledger = testLedger(path.join(dir, "db"), { binding: "test", limitMicros: 2_000_000 });
      const fetchImpl = vi.fn(async () => new Response("denied", { status: 429 }));
      const bad = makePhysicalTransport({ ledger, call, expected, attemptPrefix: "slot/attempt-01", fetchImpl, AdmissionError: TransportAdmissionError });
      await expect(bad.fetch(expected.destination, { ...init, body: JSON.stringify({ model: "other", reasoning: { effort: "high" } }) })).rejects.toMatchObject({ code: "config_error" });
      expect(fetchImpl).not.toHaveBeenCalled(); expect(ledger.totals().starts).toBe(0);
      const good = makePhysicalTransport({ ledger, call: { ...call, callId: "mc-2" }, expected, attemptPrefix: "slot/attempt-01", fetchImpl, AdmissionError: TransportAdmissionError });
      await expect(good.fetch(expected.destination, init)).rejects.toMatchObject({ context: { reason: "provider_denied", physicalId: "slot/attempt-01/mc-2/physical-1" } });
      expect(ledger.totals()).toMatchObject({ starts: 1, chargedMicros: 400_000, stopped: "provider_429" });
      const next = makePhysicalTransport({ ledger, call: { ...call, callId: "mc-3" }, expected, attemptPrefix: "slot/attempt-01", fetchImpl, AdmissionError: TransportAdmissionError });
      await expect(next.fetch(expected.destination, init)).rejects.toMatchObject({ code: "config_error", context: { reason: "provider_denied" } });
      expect(ledger.totals().starts).toBe(1);
      expect(ledger.db.prepare("SELECT reason FROM local_refusal WHERE id=?").get("slot/attempt-01/mc-3/physical-1")).toEqual({ reason: "provider_429" });
      ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
