import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error The development-only runner is intentionally plain ESM.
import { CampaignLedger } from "../evals/runner/ledger.mjs";

describe("development campaign physical ledger", () => {
  it("keeps key fingerprints campaign-specific and stops on snapshot key drift", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-ledger-key-"));
    try {
      const one = new CampaignLedger(path.join(dir, "one"), { binding: "one", limitMicros: 2_000_000 });
      const two = new CampaignLedger(path.join(dir, "two"), { binding: "two", limitMicros: 2_000_000 });
      const fingerprint = one.fingerprint("key-a");
      expect(fingerprint).not.toBe(two.fingerprint("key-a"));
      one.bindKeyBaseline({ usageMicros: 0, keyFingerprint: fingerprint, evidenceSHA256: "a".repeat(64) });
      expect(one.recordKeySnapshot({ usageMicros: 0, observedMs: 1, keyFingerprint: one.fingerprint("key-b"), evidenceSHA256: "b".repeat(64) })).toEqual({ fresh: false, bindingMismatch: true });
      expect(one.totals().stopped).toBe("binding_mismatch");
      expect(one.db.prepare('SELECT COUNT(*) AS count FROM key_snapshot').get()).toEqual({ count: 0 });
      one.close(); two.close();
      const reopened = new CampaignLedger(path.join(dir, "one"), { binding: "one", limitMicros: 2_000_000 });
      expect(reopened.fingerprint("key-a")).toBe(fingerprint);
      expect(reopened.totals().stopped).toBe("binding_mismatch"); reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("keeps unknown holds across restart and records refused starts separately", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-ledger-"));
    try {
      const file = path.join(dir, "calls.sqlite");
      const config = { binding: "fixture", limitMicros: 800_000 };
      let ledger = new CampaignLedger(file, config);
      expect(ledger.reservePhysical({ id: "p1", logicalId: "mc1", kind: "review" })).toEqual({ admitted: true });
      ledger.settlePhysical({ id: "p1", httpStatus: 500 });
      ledger.recordCacheHit("mc-cache");
      expect(() => ledger.reservePhysical({ id: "cache-post", logicalId: "mc-cache", kind: "review" })).toThrow("cache hit");
      expect(() => ledger.recordCacheHit("mc1")).toThrow("already attempted");
      ledger.close();
      ledger = new CampaignLedger(file, config);
      expect(ledger.totals()).toMatchObject({ starts: 1, chargedMicros: 400_000, unknown: 1 });
      expect(ledger.reservePhysical({ id: "p2", logicalId: "mc2", kind: "review" })).toEqual({ admitted: true });
      expect(ledger.reservePhysical({ id: "p3", logicalId: "mc3", kind: "review" })).toMatchObject({ admitted: false });
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
      expect(ledger.reservePhysical({ id: "p1", logicalId: "mc1", kind: "probe" })).toEqual({ admitted: true });
      expect(() => ledger.settlePhysical({ id: "p1", httpStatus: 200, providerCostMicros: 0 })).toThrow();
      expect(ledger.totals()).toMatchObject({ starts: 1, chargedMicros: 400_000, open: 1 });
      ledger.settlePhysical({ id: "p1", httpStatus: 200, quotaDenied: true });
      expect(ledger.totals()).toMatchObject({ starts: 1, chargedMicros: 400_000, unknown: 1, stopped: "provider_quota" });
      expect(ledger.reservePhysical({ id: "p2", logicalId: "mc2", kind: "review" })).toMatchObject({ admitted: false });
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
      const source = `const { parentPort, workerData } = require("node:worker_threads"); import(workerData.moduleUrl).then(({CampaignLedger}) => { const l = new CampaignLedger(workerData.file, workerData.config); const accepted = l.reservePhysical({id: workerData.id, logicalId: workerData.id, kind: "review"}).admitted; l.close(); parentPort.postMessage(accepted); }).catch(e => { throw e; });`;
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

  it("uses whole-key headroom in the atomic reservation after a fresh snapshot", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-ledger-"));
    try {
      const file = path.join(dir, "db"), config = { binding: "fixture", limitMicros: 1_000_000 }, evidence = "a".repeat(64);
      let ledger = new CampaignLedger(file, config);
      ledger.bindKeyBaseline({ usageMicros: 0, keyFingerprint: ledger.fingerprint('synthetic-key'), evidenceSHA256: evidence });
      ledger.recordKeySnapshot({ usageMicros: 950_000, observedMs: 1, keyFingerprint: ledger.fingerprint('synthetic-key'), evidenceSHA256: evidence });
      ledger.close(); ledger = new CampaignLedger(file, config);
      expect(ledger.keyDecision({ verifyEvidence: () => true })).toEqual({ action: "admit" });
      expect(ledger.reservePhysical({ id: "p1", logicalId: "mc1", kind: "review" })).toEqual({ admitted: false, reason: "campaign_budget" });
      expect(ledger.totals().starts).toBe(0); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("does not let an old key delta cover later confirmed spend", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-ledger-"));
    try {
      const file = path.join(dir, "db"), config = { binding: "fixture", limitMicros: 1_000_000 }, evidence = "a".repeat(64);
      let ledger = new CampaignLedger(file, config);
      ledger.bindKeyBaseline({ usageMicros: 0, keyFingerprint: ledger.fingerprint('synthetic-key'), evidenceSHA256: evidence });
      expect(ledger.recordKeySnapshot({ usageMicros: 550_000, observedMs: 1, keyFingerprint: ledger.fingerprint('synthetic-key'), evidenceSHA256: evidence }).fresh).toBe(true);
      expect(ledger.reservePhysical({ id: "p1", logicalId: "mc1", kind: "review" })).toEqual({ admitted: true });
      ledger.settlePhysical({ id: "p1", httpStatus: 200, providerCostMicros: 200_000, costConfirmed: true });
      for (const [usageMicros, observedMs] of [[550_000, 2], [650_000, 3]] as const) {
        expect(ledger.recordKeySnapshot({ usageMicros, observedMs, keyFingerprint: ledger.fingerprint('synthetic-key'), evidenceSHA256: evidence }).fresh).toBe(false);
        expect(ledger.keyDecision({ verifyEvidence: () => true })).toEqual({ action: "wait" });
      }
      ledger.close(); ledger = new CampaignLedger(file, config);
      expect(ledger.reservePhysical({ id: "p2", logicalId: "mc2", kind: "review" })).toEqual({ admitted: false, reason: "campaign_budget" });
      expect(ledger.totals()).toMatchObject({ starts: 1, chargedMicros: 200_000 });
      expect(ledger.recordKeySnapshot({ usageMicros: 750_000, observedMs: 4, keyFingerprint: ledger.fingerprint('synthetic-key'), evidenceSHA256: evidence }).fresh).toBe(true);
      expect(ledger.keyDecision({ verifyEvidence: () => true })).toEqual({ action: "admit" });
      expect(ledger.reservePhysical({ id: "p3", logicalId: "mc3", kind: "review" })).toEqual({ admitted: false, reason: "campaign_budget" });
      expect(ledger.totals().starts).toBe(1); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("uses finer provider precision for freshness while preserving rounded admission charges", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-ledger-"));
    try {
      const ledger = new CampaignLedger(path.join(dir, "db"), { binding: "fixture", limitMicros: 1_000_000 }), evidence = "a".repeat(64);
      ledger.bindKeyBaseline({ usageMicros: 0, keyFingerprint: ledger.fingerprint('synthetic-key'), evidenceSHA256: evidence });
      ledger.recordKeySnapshot({ usageMicros: 0, observedMs: 0, keyFingerprint: ledger.fingerprint('synthetic-key'), evidenceSHA256: evidence });
      for (let n = 0; n < 10; n++) {
        const id = `p${n}`; expect(ledger.reservePhysical({ id, logicalId: id, kind: "review" })).toEqual({ admitted: true });
        ledger.settlePhysical({ id, httpStatus: 200, providerCostMicros: 1, providerCostNanos: 400, costConfirmed: true });
      }
      expect(ledger.totals().chargedMicros).toBe(10);
      expect(ledger.recordKeySnapshot({ usageMicros: 4, usageNanos: 4000, observedMs: 1, keyFingerprint: ledger.fingerprint('synthetic-key'), evidenceSHA256: evidence }).fresh).toBe(true);
      expect(ledger.keyDecision({ verifyEvidence: () => true })).toEqual({ action: "admit" }); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps stale snapshots separate from charged unknown holds and stops on actual cap", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-ledger-"));
    try {
      const file = path.join(dir, "db"), config = { binding: "fixture", limitMicros: 1_000_000 }, evidence = "a".repeat(64);
      let ledger = new CampaignLedger(file, config);
      ledger.bindKeyBaseline({ usageMicros: 10_000_000, keyFingerprint: ledger.fingerprint('synthetic-key'), evidenceSHA256: evidence });
      const decide = () => ledger.keyDecision({ verifyEvidence: (_kind: string, hash: string) => hash === evidence });
      expect(decide()).toEqual({ action: "snapshot" });
      ledger.recordKeySnapshot({ usageMicros: 10_000_000, observedMs: 0, keyFingerprint: ledger.fingerprint('synthetic-key'), evidenceSHA256: evidence });
      ledger.reservePhysical({ id: "p1", logicalId: "mc1", kind: "review" }); ledger.settlePhysical({ id: "p1", httpStatus: 200, providerCostMicros: 100_000, costConfirmed: true });
      ledger.reservePhysical({ id: "p2", logicalId: "mc2", kind: "review" }); ledger.settlePhysical({ id: "p2", httpStatus: 500 });
      expect(ledger.recordKeySnapshot({ usageMicros: 10_050_000, observedMs: 1, keyFingerprint: ledger.fingerprint('synthetic-key'), evidenceSHA256: evidence }).fresh).toBe(false);
      expect(decide()).toEqual({ action: "wait" }); ledger.close(); ledger = new CampaignLedger(file, config);
      expect(decide()).toEqual({ action: "wait" });
      expect(ledger.recordKeySnapshot({ usageMicros: 10_100_000, observedMs: 2, keyFingerprint: ledger.fingerprint('synthetic-key'), evidenceSHA256: evidence }).fresh).toBe(true);
      expect(decide()).toEqual({ action: "admit" });
      expect(ledger.totals()).toMatchObject({ chargedMicros: 500_000, unknown: 1 });
      ledger.recordKeySnapshot({ usageMicros: 11_000_000, observedMs: 3, keyFingerprint: ledger.fingerprint('synthetic-key'), evidenceSHA256: evidence });
      expect(decide()).toEqual({ action: "stop", reason: "budget_limit" }); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("cannot settle a confirmed amount below an earlier raw lower bound", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-ledger-"));
    try {
      const file = path.join(dir, "db"), config = { binding: "fixture", limitMicros: 2_000_000 };
      let ledger = new CampaignLedger(file, config);
      ledger.reservePhysical({ id: "p1", logicalId: "mc1", kind: "review" }); ledger.raiseLowerBound("p1", 450_000);
      expect(() => ledger.settlePhysical({ id: "p1", httpStatus: 200, providerCostMicros: 100_000, costConfirmed: true })).toThrow("contradicts");
      ledger.close(); ledger = new CampaignLedger(file, config);
      expect(ledger.db.prepare("SELECT state,charge FROM physical").get()).toEqual({ state: "unknown", charge: 450_000 });
      expect(ledger.totals().stopped).toBe("unpriced_lower_bound"); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("retains health receipts and requires two clean probes after capacity failure", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-ledger-"));
    try {
      const file = path.join(dir, "calls.sqlite"), config = { binding: "fixture", limitMicros: 2_000_000 };
      let ledger = new CampaignLedger(file, config); const evidence = "a".repeat(64);
      const decide = (nowMs: number) => ledger.healthDecision({ boundaryId: "boundary-1", provider: "openrouter", nowMs, verifyEvidence: (_id: string, hash: string) => hash === evidence });
      const reserve = (id: string) => ledger.reservePhysical({ id, logicalId: id, kind: "health", provider: "openrouter", healthBoundary: "boundary-1" });
      expect(decide(0)).toEqual({ action: "probe" }); expect(reserve("p1")).toEqual({ admitted: true });
      expect(decide(0)).toEqual({ action: "reconcile" });
      ledger.settlePhysical({ id: "p1", httpStatus: 500, providerCostMicros: 0, costConfirmed: true });
      ledger.recordHealth({ physicalId: "p1", outcome: "capacity", observedMs: 0, evidenceSHA256: evidence });
      expect(decide(1)).toEqual({ action: "wait", untilMs: 900_000 }); ledger.close(); ledger = new CampaignLedger(file, config);
      expect(decide(900_000)).toEqual({ action: "probe" });
      for (const id of ["p2", "p3"]) {
        expect(reserve(id)).toEqual({ admitted: true }); ledger.settlePhysical({ id, httpStatus: 200, providerCostMicros: 0, costConfirmed: true });
        ledger.recordHealth({ physicalId: id, outcome: "clean", observedMs: 900_000, evidenceSHA256: evidence });
        if (id === "p2") expect(decide(900_000)).toEqual({ action: "probe" });
      }
      expect(decide(900_000)).toEqual({ action: "admit" });
      expect(ledger.healthDecision({ boundaryId: "boundary-2", provider: "openrouter", nowMs: 900_000, verifyEvidence: () => true })).toEqual({ action: "probe" });
      expect(() => ledger.healthDecision({ boundaryId: "boundary-1", provider: "openrouter", nowMs: 900_000, verifyEvidence: () => false })).toThrow("evidence mismatch");
      expect(ledger.totals().starts).toBe(3); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("uses the smaller hold only with explicit zero-usage error evidence", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-ledger-"));
    try {
      const ledger = new CampaignLedger(path.join(dir, "calls.sqlite"), { binding: "fixture", limitMicros: 1_000_000 });
      expect(ledger.reservePhysical({ id: "p1", logicalId: "mc1", kind: "review" })).toEqual({ admitted: true });
      expect(() => ledger.settlePhysical({ id: "p1", httpStatus: 200, usageEvidence: { usagePresent: true, costPresent: false }, noUsageErrorEvidence: { terminal: "error", usagePresent: true, costPresent: false, providerCostReported: false, inputTokens: 0, outputTokens: 0, totalTokens: 1 } })).toThrow();
      ledger.settlePhysical({ id: "p1", httpStatus: 200, usageEvidence: { usagePresent: true, costPresent: false }, noUsageErrorEvidence: { terminal: "error", usagePresent: true, costPresent: false, providerCostReported: false, inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
      expect(ledger.totals()).toMatchObject({ starts: 1, chargedMicros: 50_000 });
      ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
