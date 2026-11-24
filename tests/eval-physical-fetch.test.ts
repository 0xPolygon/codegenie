import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TransportAdmissionError } from "../src/llm/transport-admission.js";
// @ts-expect-error Dev-only ESM has no emitted types.
import { CampaignLedger } from "../evals/runner/ledger.mjs";
// @ts-expect-error Dev-only ESM has no emitted types.
import { makePhysicalTransport } from "../evals/runner/physical-fetch.mjs";

const call = { callId: "mc-1", provider: "openrouter", modelId: "model", reasoningSelected: "high", templateVersion: "p7", kind: "initial" };
const expected = { ...call, destination: "https://synthetic.invalid/chat", wireEffort: "high" };
const init = { method: "POST", body: JSON.stringify({ model: "model", reasoning: { effort: "high" } }) };
const chunkZero = { source: "provider_chunk", usagePresent: true, costPresent: false, reasoningTokensPresent: false, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const terminal = { source: "terminal", usagePresent: false, costPresent: false, reasoningTokensPresent: false, terminal: "error", costFromProvider: false };

describe("physical fetch settlement", () => {
  it("retains the first retry hold and settles only the response producing usage", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const ledger = new CampaignLedger(path.join(dir, "db"), { binding: "test", limitMicros: 2_000_000 });
      const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("error", { status: 500 })).mockResolvedValueOnce(new Response("ok", { status: 200 }));
      const transport = makePhysicalTransport({ ledger, call, expected, fetchImpl, AdmissionError: TransportAdmissionError });
      await transport.fetch(expected.destination, init); await transport.fetch(expected.destination, init);
      transport.onUsage({ ...terminal, terminal: "done", costFromProvider: true, providerCost: 0.000123 });
      expect(ledger.db.prepare("SELECT logical_id,state,charge FROM physical ORDER BY id").all()).toEqual([
        { logical_id: "mc-1", state: "unknown", charge: 400_000 }, { logical_id: "mc-1", state: "priced", charge: 123 }
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
      const transport = makePhysicalTransport({ ledger, call, expected, fetchImpl: async () => new Response("ok", { status: 200 }), AdmissionError: TransportAdmissionError });
      await transport.fetch(expected.destination, init);
      if (hasUsage) transport.onUsage(chunkZero);
      transport.onUsage(terminal);
      expect(ledger.totals().chargedMicros).toBe(hasUsage ? 50_000 : 400_000);
      ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects a wrong wire before any physical start and latches a provider denial", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-physical-"));
    try {
      const ledger = new CampaignLedger(path.join(dir, "db"), { binding: "test", limitMicros: 2_000_000 });
      const fetchImpl = vi.fn(async () => new Response("denied", { status: 429 }));
      const bad = makePhysicalTransport({ ledger, call, expected, fetchImpl, AdmissionError: TransportAdmissionError });
      await expect(bad.fetch(expected.destination, { ...init, body: JSON.stringify({ model: "other", reasoning: { effort: "high" } }) })).rejects.toMatchObject({ code: "config_error" });
      expect(fetchImpl).not.toHaveBeenCalled(); expect(ledger.totals().starts).toBe(0);
      const good = makePhysicalTransport({ ledger, call: { ...call, callId: "mc-2" }, expected, fetchImpl, AdmissionError: TransportAdmissionError });
      await expect(good.fetch(expected.destination, init)).rejects.toMatchObject({ context: { reason: "provider_denied", physicalId: "mc-2/physical-1" } });
      expect(ledger.totals()).toMatchObject({ starts: 1, chargedMicros: 400_000, stopped: "provider_429" });
      ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
