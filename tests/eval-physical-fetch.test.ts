import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { projectProviderUsage, TransportAdmissionError } from "../src/llm/transport-admission.js";
// @ts-expect-error Dev-only ESM has no emitted types.
import { CampaignLedger } from "../evals/runner/ledger.mjs";
// @ts-expect-error Dev-only ESM has no emitted types.
import { makePhysicalTransport } from "../evals/runner/physical-fetch.mjs";

const call = { callId: "mc-1", provider: "openrouter", modelId: "model", reasoningSelected: "high", templateVersion: "p7", kind: "initial" };
const expected = { ...call, api: "openai-completions", destination: "https://synthetic.invalid/chat", wireEffort: "high" };
const init = { method: "POST", body: JSON.stringify({ model: "model", reasoning: { effort: "high" } }) };
const chunkZero = { source: "provider_chunk", usagePresent: true, costPresent: false, reasoningTokensPresent: false, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const terminal = { source: "terminal", usagePresent: false, costPresent: false, reasoningTokensPresent: false, terminal: "error", costFromProvider: false };

describe("physical fetch settlement", () => {
  it("retains the first retry hold and settles only the response producing usage", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const ledger = new CampaignLedger(path.join(dir, "db"), { binding: "test", limitMicros: 2_000_000 });
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
      const ledger = new CampaignLedger(path.join(dir, "db"), { binding: "test", limitMicros: 2_000_000 });
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
      let ledger = new CampaignLedger(file, config);
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix: "slot/attempt-01", fetchImpl: async () => new Response("ok", { status: 200 }), AdmissionError: TransportAdmissionError });
      await transport.fetch(expected.destination, init);
      transport.onUsage(projectProviderUsage({ usage }));
      transport.onUsage(terminal); ledger.close(); ledger = new CampaignLedger(file, config);
      expect(ledger.db.prepare("SELECT state,charge FROM physical").get()).toEqual({ state, charge });
      expect(ledger.totals().stopped).toBe(stopped); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("settles a raw billed cost before a later native attempt starts", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const file = path.join(dir, "db"), config = { binding: "test", limitMicros: 2_000_000 };
      let ledger = new CampaignLedger(file, config);
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix: "slot/attempt-01", fetchImpl: async () => new Response("ok"), AdmissionError: TransportAdmissionError });
      await transport.fetch(expected.destination, init);
      transport.onUsage(projectProviderUsage({ usage: { cost: 0.45, is_byok: false } }));
      // A provider total above the reservation latches further admission.
      await expect(transport.fetch(expected.destination, init)).rejects.toMatchObject({ context: { reason: "accounting_failed" } });
      ledger.close(); ledger = new CampaignLedger(file, config);
      expect(ledger.db.prepare("SELECT state,charge FROM physical").all()).toEqual([{ state: "priced", charge: 450_000 }]);
      expect(ledger.totals()).toMatchObject({ starts: 1, stopped: "charge_above_reservation" }); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("halts with the hold retained when raw and terminal provider totals conflict", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const ledger = new CampaignLedger(path.join(dir, "db"), { binding: "test", limitMicros: 2_000_000 });
      const transport = makePhysicalTransport({ ledger, call, expected, attemptPrefix: "slot/attempt-01", fetchImpl: async () => new Response("ok"), AdmissionError: TransportAdmissionError });
      await transport.fetch(expected.destination, init);
      transport.onUsage(projectProviderUsage({ usage: { cost: 0.1, is_byok: false } }));
      expect(() => transport.onUsage({ ...terminal, terminal: "done", costFromProvider: true, providerCost: 0.2 })).toThrow();
      expect(ledger.totals()).toMatchObject({ starts: 1, chargedMicros: 400_000, open: 1, stopped: "accounting_failed" });
      ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects unsupported APIs before any physical start", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const ledger = new CampaignLedger(path.join(dir, "db"), { binding: "test", limitMicros: 2_000_000 });
      const fetchImpl = vi.fn(async () => new Response("ok"));
      const transport = makePhysicalTransport({ ledger, call, expected: { ...expected, api: "anthropic-messages" }, attemptPrefix: "slot/attempt-01", fetchImpl, AdmissionError: TransportAdmissionError });
      await expect(transport.fetch(expected.destination, init)).rejects.toMatchObject({ context: { reason: "binding_mismatch" } });
      expect(fetchImpl).not.toHaveBeenCalled(); expect(ledger.totals().starts).toBe(0); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects a wrong wire before any physical start and latches a provider denial", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const ledger = new CampaignLedger(path.join(dir, "db"), { binding: "test", limitMicros: 2_000_000 });
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
