import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error The development-only runner is intentionally plain ESM.
import { CampaignLedger } from "../evals/runner/ledger.mjs";

describe("development campaign physical ledger", () => {
  it("keeps unknown holds across restart and records refused starts separately", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-ledger-"));
    try {
      const file = path.join(dir, "calls.sqlite");
      const config = { binding: "fixture", limitMicros: 800_000 };
      let ledger = new CampaignLedger(file, config);
      expect(ledger.reservePhysical({ id: "p1", logicalId: "mc1", kind: "review" })).toBe(true);
      ledger.settlePhysical({ id: "p1", httpStatus: 500 });
      ledger.recordCacheHit("mc-cache");
      expect(() => ledger.reservePhysical({ id: "cache-post", logicalId: "mc-cache", kind: "review" })).toThrow("cache hit");
      expect(() => ledger.recordCacheHit("mc1")).toThrow("already attempted");
      ledger.close();
      ledger = new CampaignLedger(file, config);
      expect(ledger.totals()).toMatchObject({ starts: 1, chargedMicros: 400_000, unknown: 1 });
      expect(ledger.reservePhysical({ id: "p2", logicalId: "mc2", kind: "review" })).toBe(true);
      expect(ledger.reservePhysical({ id: "p3", logicalId: "mc3", kind: "review" })).toBe(false);
      expect(ledger.db.prepare("SELECT id,logical_id,reason FROM local_refusal").all()).toEqual([{ id: "p3", logical_id: "mc3", reason: "campaign_budget" }]);
      expect(ledger.totals()).toMatchObject({ starts: 2, chargedMicros: 800_000, open: 1 });
      expect(() => ledger.reservePhysical({ id: "p3", logicalId: "mc3", kind: "review" })).toThrow("duplicate attempt identity");
      expect(() => ledger.recordRefusal({ id: "p2", logicalId: "mc2", reason: "campaign_budget" })).toThrow("already started");
      ledger.close();
      ledger = new CampaignLedger(file, config);
      expect(() => ledger.assertRestartSafe()).toThrow("unmatched physical start");
      expect(ledger.totals()).toMatchObject({ starts: 2, chargedMicros: 800_000, open: 1 });
      ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("retains unconfirmed zero usage and latches provider denial on the last completion", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-ledger-"));
    try {
      const ledger = new CampaignLedger(path.join(dir, "calls.sqlite"), { binding: "fixture", limitMicros: 2_000_000 });
      expect(ledger.reservePhysical({ id: "p1", logicalId: "mc1", kind: "probe" })).toBe(true);
      expect(() => ledger.settlePhysical({ id: "p1", httpStatus: 200, providerCostMicros: 0 })).toThrow();
      expect(ledger.totals()).toMatchObject({ starts: 1, chargedMicros: 400_000, open: 1 });
      ledger.settlePhysical({ id: "p1", httpStatus: 200, quotaDenied: true });
      expect(ledger.totals()).toMatchObject({ starts: 1, chargedMicros: 400_000, unknown: 1, stopped: "provider_quota" });
      expect(ledger.reservePhysical({ id: "p2", logicalId: "mc2", kind: "review" })).toBe(false);
      ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reserves atomically across concurrent processes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-ledger-"));
    try {
      const file = path.join(dir, "calls.sqlite");
      const config = { binding: "fixture", limitMicros: 800_000 };
      const initial = new CampaignLedger(file, config); initial.close();
      const moduleUrl = pathToFileURL(path.resolve("evals/runner/ledger.mjs")).href;
      const source = `const { parentPort, workerData } = require("node:worker_threads"); import(workerData.moduleUrl).then(({CampaignLedger}) => { const l = new CampaignLedger(workerData.file, workerData.config); const accepted = l.reservePhysical({id: workerData.id, logicalId: workerData.id, kind: "review"}); l.close(); parentPort.postMessage(accepted); }).catch(e => { throw e; });`;
      const invoke = (id: string) => new Promise<boolean>((resolve, reject) => {
        const worker = new Worker(source, { eval: true, workerData: { file, config, id, moduleUrl } });
        worker.once("message", (value: boolean) => resolve(value)); worker.once("error", reject);
      });
      const accepted = await Promise.all([invoke("one"), invoke("two"), invoke("three")]);
      expect(accepted.filter(Boolean)).toHaveLength(2);
      const ledger = new CampaignLedger(file, config);
      expect(ledger.totals()).toMatchObject({ starts: 2, chargedMicros: 800_000, open: 2 });
      expect(ledger.db.prepare("SELECT count(*) AS n FROM local_refusal").get().n).toBe(1);
      ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("uses the smaller hold only with explicit zero-usage error evidence", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-ledger-"));
    try {
      const ledger = new CampaignLedger(path.join(dir, "calls.sqlite"), { binding: "fixture", limitMicros: 1_000_000 });
      expect(ledger.reservePhysical({ id: "p1", logicalId: "mc1", kind: "review" })).toBe(true);
      expect(() => ledger.settlePhysical({ id: "p1", httpStatus: 200, noUsageErrorEvidence: { terminal: "error", providerCostReported: false, inputTokens: 0, outputTokens: 0, totalTokens: 1 } })).toThrow();
      ledger.settlePhysical({ id: "p1", httpStatus: 200, noUsageErrorEvidence: { terminal: "error", providerCostReported: false, inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
      expect(ledger.totals()).toMatchObject({ starts: 1, chargedMicros: 50_000 });
      ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
