import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Development-only ESM has no emitted types.
import { CampaignLedger } from "../evals/runner/ledger.mjs";
// @ts-expect-error Development-only ESM has no emitted types.
import { operationalError, runWorker } from "../evals/runner/worker.mjs";
// @ts-expect-error Development-only ESM has no emitted types.
import { boundaryDecision, boundaryRefusalReason, BoundaryBindingError } from "../evals/runner/boundary.mjs";

const checkout = process.cwd();
function evidence(dir: string, receipt: object) {
  const text = JSON.stringify(receipt), hash = createHash("sha256").update(text).digest("hex"), file = path.join(dir, hash);
  writeFileSync(file, text); return { hash, file };
}

describe("development eval worker", () => {
  it("classifies provider and harness failures without exposing response text", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-worker-error-"));
    try {
      const ledger = new CampaignLedger(path.join(dir, "ledger"), { binding: "synthetic", limitMicros: 2_000_000 });
      expect(operationalError(ledger, 'slot/attempt-01')).toBe('harness_exception');
      ledger.reservePhysical({ id: 'slot/attempt-01/mc-1/physical-1', logicalId: 'slot/attempt-01/mc-1', kind: 'initial', provider: 'openrouter' });
      ledger.settlePhysical({ id: 'slot/attempt-01/mc-1/physical-1', httpStatus: 503 });
      expect(operationalError(ledger, 'slot/attempt-01')).toBe('provider_failure'); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("keeps unadmitted boundaries and accounting failures distinct from a campaign stop", () => {
    for (const reason of ["key_wait", "health_probe", "health_reconcile"]) expect(boundaryRefusalReason(reason)).toBe("boundary_not_admitted");
    expect(boundaryRefusalReason("accounting_failed")).toBe("accounting_failed");
    expect(boundaryRefusalReason("binding_mismatch")).toBe("binding_mismatch");
    expect(boundaryRefusalReason("provider_429")).toBe("provider_denied");
  });
  it("does not admit a boundary with missing or changed meter and health evidence", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-worker-boundary-"));
    try {
      const ledger = new CampaignLedger(path.join(dir, "ledger.sqlite"), { binding: "synthetic", limitMicros: 15_000_000 });
      const fingerprint = ledger.fingerprint('synthetic-key');
      const baseline = evidence(dir, { kind: "key_baseline", usageNanos: 0, fingerprint });
      const snapshot = evidence(dir, { kind: "key_snapshot", usageNanos: 0, observedMs: 1, fingerprint, boundaryId: "one" });
      const health = evidence(dir, { kind: "health", purpose: "admission", physicalId: "health", boundaryId: "one", provider: "openrouter", outcome: "clean", observedMs: 1 });
      ledger.bindKeyBaseline({ usageMicros: 0, keyFingerprint: fingerprint, evidenceSHA256: baseline.hash });
      const args = { ledger, boundaryId: "one", provider: "openrouter", evidenceFiles: { [baseline.hash]: baseline.file, [snapshot.hash]: snapshot.file, [health.hash]: health.file }, nowMs: 2 };
      expect(boundaryDecision(args)).toMatchObject({ source: "key", action: "snapshot" });
      ledger.recordKeySnapshot({ boundaryId: "one", usageMicros: 0, observedMs: 1, keyFingerprint: fingerprint, evidenceSHA256: snapshot.hash });
      expect(boundaryDecision(args)).toMatchObject({ source: "health", action: "probe" });
      ledger.reservePhysical({ id: "health", logicalId: "health", kind: "health", provider: "openrouter", healthBoundary: "one" });
      ledger.settlePhysical({ id: "health", httpStatus: 200, providerCostMicros: 0, costConfirmed: true });
      ledger.recordHealth({ physicalId: "health", outcome: "clean", observedMs: 1, evidenceSHA256: health.hash });
      expect(boundaryDecision(args)).toMatchObject({ action: "admit" });
      expect(boundaryDecision({ ...args, boundaryId: "two" })).toMatchObject({ action: "snapshot" });
      const wrongHealth = evidence(dir, { kind: "health", purpose: "admission", physicalId: "other", boundaryId: "one", provider: "openrouter", outcome: "clean", observedMs: 1 });
      ledger.db.prepare('UPDATE health_receipt SET evidence_sha256=?').run(wrongHealth.hash);
      expect(() => boundaryDecision({ ...args, evidenceFiles: { ...args.evidenceFiles, [wrongHealth.hash]: wrongHealth.file } })).toThrow(BoundaryBindingError);
      ledger.db.prepare('UPDATE health_receipt SET evidence_sha256=?').run(health.hash);
      ledger.db.prepare('UPDATE key_baseline SET evidence_sha256=?').run(snapshot.hash);
      expect(() => boundaryDecision(args)).toThrow(BoundaryBindingError);
      ledger.db.prepare('UPDATE key_baseline SET evidence_sha256=?').run(baseline.hash);
      expect(() => boundaryDecision({ ...args, evidenceFiles: { [baseline.hash]: path.join(checkout, "package.json") } })).toThrow(BoundaryBindingError);
      expect(() => boundaryDecision({ ...args, evidenceFiles: { [baseline.hash]: path.join(dir, "missing") } })).toThrowError(expect.objectContaining({ code: "ENOENT" }));
      writeFileSync(baseline.file, "changed");
      expect(() => boundaryDecision(args)).toThrow(BoundaryBindingError); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("requires reconciliation of an interrupted physical start before running an attempt", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-worker-restart-"));
    try {
      const db = path.join(dir, "ledger.sqlite");
      let ledger = new CampaignLedger(db, { binding: "synthetic", limitMicros: 15_000_000 });
      ledger.reservePhysical({ id: "previous/physical-1", logicalId: "previous", kind: "initial", provider: "openrouter" });
      ledger.close();
      const fetchImpl = vi.fn();
      await expect(runWorker({ caseConfig: path.join(dir, "missing.json"), ledgerPath: db, ledgerBinding: "synthetic", limitMicros: 15_000_000,
        attemptPrefix: "next/attempt-01", expectedCalls: [] }, { fetchImpl })).rejects.toThrow("unmatched physical start");
      expect(fetchImpl).not.toHaveBeenCalled();
      ledger = new CampaignLedger(db, { binding: "synthetic", limitMicros: 15_000_000 });
      expect(ledger.totals()).toMatchObject({ starts: 1, open: 1, chargedMicros: 400_000 }); ledger.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("runs the built fake fixture with an external ledger and digest-bound worker config", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-worker-"));
    try {
      const caseFile = path.join(dir, "case.json"), workerFile = path.join(dir, "worker.json"), ledgerPath = path.join(dir, "ledger.sqlite");
      writeFileSync(caseFile, JSON.stringify({ caseDir: path.join(checkout, "evals/fixtures"), caseName: "fixture-core-lens", outputDir: path.join(dir, "output") }));
      const worker = JSON.stringify({ caseConfig: caseFile, caseConfigSHA256: createHash("sha256").update(readFileSync(caseFile)).digest("hex"), ledgerPath, ledgerBinding: "synthetic", limitMicros: 15_000_000, attemptPrefix: "slot/attempt-01", expectedCalls: [] });
      writeFileSync(workerFile, worker);
      const digest = createHash("sha256").update(worker).digest("hex");
      const command = [path.join(checkout, "evals/runner/worker.mjs"), workerFile, digest];
      const out = execFileSync("node", command, { encoding: "utf8", env: { ...process.env, CODEGENIE_HOME: path.join(dir, "home") }, timeout: 60_000 });
      expect(JSON.parse(out)).toMatchObject({ caseName: "fixture-core-lens", status: "pass" });
      expect(readFileSync(ledgerPath).byteLength).toBeGreaterThan(0);
      const badWorker = spawnSync("node", [command[0]!, workerFile, "0".repeat(64)], { encoding: "utf8" });
      expect(badWorker.status).toBe(1); expect(JSON.parse(badWorker.stdout)).toEqual({ error: "binding_mismatch" });
      writeFileSync(caseFile, JSON.stringify({ caseDir: path.join(checkout, "evals/fixtures"), caseName: "different", outputDir: path.join(dir, "output") }));
      const badCase = spawnSync("node", command, { encoding: "utf8" });
      expect(badCase.status).toBe(1); expect(JSON.parse(badCase.stdout)).toEqual({ error: "binding_mismatch" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);

  it("runs a real adapter against an injected transport only after bound health and key evidence", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-worker-guard-"));
    const db = path.join(dir, "ledger.sqlite"), suite = path.join(dir, "suite");
    const ledger = new CampaignLedger(db, { binding: "synthetic", limitMicros: 15_000_000, reserveMicros: 300_000, errorHoldMicros: 25_000 });
    const fingerprint = ledger.fingerprint('synthetic-key');
    const baseline = evidence(dir, { kind: "key_baseline", usageNanos: 0, fingerprint });
    const snapshot = evidence(dir, { kind: "key_snapshot", usageNanos: 0, observedMs: 1, fingerprint, boundaryId: "boundary-1" });
    const health = evidence(dir, { kind: "health", purpose: "admission", physicalId: "health-1", boundaryId: "boundary-1", provider: "openrouter", outcome: "clean", observedMs: 1 });
    const evidenceFiles = { [baseline.hash]: baseline.file, [snapshot.hash]: snapshot.file, [health.hash]: health.file };
    const supervisorPath = path.join(dir, "supervisor.sqlite"), workerToken = "b".repeat(64), workerConfigSHA256 = "c".repeat(64);
    const supervisorDb = new DatabaseSync(supervisorPath);
    supervisorDb.exec("CREATE TABLE campaign(binding TEXT); INSERT INTO campaign VALUES('synthetic'); CREATE TABLE worker_claim(slot_id TEXT,attempt_no INTEGER,config_sha256 TEXT,token_sha256 TEXT,activated INTEGER); CREATE TABLE attempt(slot_id TEXT,attempt_no INTEGER,state TEXT); INSERT INTO attempt VALUES('other-slot',1,'started'),('slot',1,'started')");
    const tokenHash = createHash("sha256").update(workerToken).digest("hex");
    supervisorDb.prepare("INSERT INTO worker_claim VALUES(?,?,?,?,0)").run("other-slot", 1, workerConfigSHA256, tokenHash);
    supervisorDb.prepare("INSERT INTO worker_claim VALUES(?,?,?,?,0)").run("slot", 1, workerConfigSHA256, tokenHash); supervisorDb.close();
    vi.stubEnv("OPENROUTER_API_KEY", "synthetic-key"); vi.stubEnv("CODEGENIE_HOME", path.join(dir, "home"));
    const originalFetch = vi.fn(async () => { throw new Error("unexpected network"); }); vi.stubGlobal("fetch", originalFetch);
    try {
      mkdirSync(path.join(suite, "repos"), { recursive: true });
      cpSync(path.join(checkout, "evals/fixtures/repos/core"), path.join(suite, "repos/core"), { recursive: true });
      const source = readFileSync(path.join(checkout, "evals/fixtures/core.yml"), "utf8").replace("provider: fake", "provider: openrouter").replace("model: fake-model", "model: openai/gpt-6-luna");
      writeFileSync(path.join(suite, "core.yml"), source);
      const caseFile = path.join(dir, "case.json"); writeFileSync(caseFile, JSON.stringify({ caseDir: suite, caseName: "fixture-core-lens", outputDir: path.join(dir, "output") }));
      ledger.bindKeyBaseline({ usageMicros: 0, keyFingerprint: fingerprint, evidenceSHA256: baseline.hash }); ledger.recordKeySnapshot({ boundaryId: "boundary-1", usageMicros: 0, observedMs: 1, keyFingerprint: fingerprint, evidenceSHA256: snapshot.hash });
      ledger.reservePhysical({ id: "health-1", logicalId: "health", kind: "health", provider: "openrouter", healthBoundary: "boundary-1" });
      ledger.settlePhysical({ id: "health-1", httpStatus: 200, providerCostMicros: 0, costConfirmed: true });
      ledger.recordHealth({ physicalId: "health-1", outcome: "clean", observedMs: 1, evidenceSHA256: health.hash }); ledger.close();
      const expected = { stage: 5, kind: "initial", provider: "openrouter", modelId: "openai/gpt-6-luna", reasoningSelected: "high", templateVersion: "p5.9", api: "openai-completions", destination: "https://openrouter.ai/api/v1/chat/completions", wireEffort: "high" };
      const fetchImpl = vi.fn(async () => new Response("synthetic failure", { status: 400 }));
      const rejectedCase = path.join(dir, "rejected-case.json");
      writeFileSync(rejectedCase, JSON.stringify({ caseDir: suite, caseName: "fixture-core-lens", outputDir: path.join(dir, "rejected-output") }));
      await expect(runWorker({ caseConfig: rejectedCase, caseConfigSHA256: createHash("sha256").update(readFileSync(rejectedCase)).digest("hex"), supervisorPath, ledgerPath: db, ledgerBinding: "synthetic", limitMicros: 15_000_000, reserveMicros: 300_000, errorHoldMicros: 25_000,
        attemptPrefix: "missing/attempt-01", expectedCalls: [expected], boundaryId: "boundary-1", evidenceFiles }, { fetchImpl, workerConfigSHA256, workerToken })).rejects.toMatchObject({ context: { reason: "binding_mismatch" } });
      await expect(runWorker({ caseConfig: rejectedCase, caseConfigSHA256: createHash("sha256").update(readFileSync(rejectedCase)).digest("hex"), supervisorPath, ledgerPath: db, ledgerBinding: "synthetic", limitMicros: 15_000_000, reserveMicros: 300_000, errorHoldMicros: 25_000,
        attemptPrefix: "slot/attempt-01", expectedCalls: [expected], boundaryId: "boundary-1", evidenceFiles }, { fetchImpl, workerConfigSHA256, workerToken: "d".repeat(64) })).rejects.toMatchObject({ context: { reason: "binding_mismatch" } });
      expect(fetchImpl).not.toHaveBeenCalled();
      const rejected = await runWorker({ caseConfig: rejectedCase, caseConfigSHA256: createHash("sha256").update(readFileSync(rejectedCase)).digest("hex"), supervisorPath, ledgerPath: db, ledgerBinding: "synthetic", limitMicros: 15_000_000, reserveMicros: 300_000, errorHoldMicros: 25_000,
        attemptPrefix: "other-slot/attempt-01", expectedCalls: [expected], boundaryId: "unprobed-boundary", evidenceFiles }, { fetchImpl, workerConfigSHA256, workerToken });
      expect(rejected).toMatchObject({ status: "error", operationalError: "boundary_not_admitted" }); expect(fetchImpl).not.toHaveBeenCalled();
      const afterRejection = new CampaignLedger(db, { binding: "synthetic", limitMicros: 15_000_000, reserveMicros: 300_000, errorHoldMicros: 25_000 });
      expect(afterRejection.totals()).toMatchObject({ starts: 1, unknown: 0 });
      expect(afterRejection.db.prepare("SELECT reason FROM local_refusal").get()).toEqual({ reason: "key_snapshot" }); afterRejection.close();
      const result = await runWorker({ caseConfig: caseFile, caseConfigSHA256: createHash("sha256").update(readFileSync(caseFile)).digest("hex"), supervisorPath, ledgerPath: db, ledgerBinding: "synthetic", limitMicros: 15_000_000, reserveMicros: 300_000, errorHoldMicros: 25_000,
        attemptPrefix: "slot/attempt-01", expectedCalls: [expected], boundaryId: "boundary-1", evidenceFiles }, { fetchImpl, workerConfigSHA256, workerToken });
      expect(result).toMatchObject({ status: "error", operationalError: "binding_mismatch" }); expect(fetchImpl).toHaveBeenCalledTimes(1); expect(originalFetch).not.toHaveBeenCalled();
      await expect(runWorker({ caseConfig: caseFile, caseConfigSHA256: createHash("sha256").update(readFileSync(caseFile)).digest("hex"), supervisorPath, ledgerPath: db, ledgerBinding: "synthetic", limitMicros: 15_000_000, reserveMicros: 300_000, errorHoldMicros: 25_000,
        attemptPrefix: "slot/attempt-01", expectedCalls: [expected], boundaryId: "boundary-1", evidenceFiles }, { fetchImpl, workerConfigSHA256, workerToken })).rejects.toMatchObject({ context: { reason: "binding_mismatch" } });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const reopened = new CampaignLedger(db, { binding: "synthetic", limitMicros: 15_000_000, reserveMicros: 300_000, errorHoldMicros: 25_000 });
      expect(reopened.totals()).toMatchObject({ starts: 2, unknown: 1, chargedMicros: 300_000 }); reopened.close();
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);

  it("retains a completed review even when the eval score fails", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-worker-fail-"));
    try {
      const suite = path.join(dir, "suite"), fixture = path.join(suite, "repos/core"); mkdirSync(path.dirname(fixture), { recursive: true });
      cpSync(path.join(checkout, "evals/fixtures/repos/core"), fixture, { recursive: true });
      const source = readFileSync(path.join(checkout, "evals/fixtures/core.yml"), "utf8").replace("minFindings: 1", "minFindings: 99").replace("maxFindings: 1", "maxFindings: 100");
      writeFileSync(path.join(suite, "core.yml"), source);
      const caseFile = path.join(dir, "case.json"), workerFile = path.join(dir, "worker.json");
      writeFileSync(caseFile, JSON.stringify({ caseDir: suite, caseName: "fixture-core-lens", outputDir: path.join(dir, "output") }));
      const worker = JSON.stringify({ caseConfig: caseFile, caseConfigSHA256: createHash("sha256").update(readFileSync(caseFile)).digest("hex"), ledgerPath: path.join(dir, "ledger.sqlite"), ledgerBinding: "synthetic", limitMicros: 15_000_000, attemptPrefix: "slot/attempt-01", expectedCalls: [] });
      writeFileSync(workerFile, worker); const digest = createHash("sha256").update(worker).digest("hex");
      const out = execFileSync("node", [path.join(checkout, "evals/runner/worker.mjs"), workerFile, digest], { encoding: "utf8", env: { ...process.env, CODEGENIE_HOME: path.join(dir, "home") }, timeout: 60_000 });
      expect(JSON.parse(out)).toMatchObject({ caseName: "fixture-core-lens", status: "fail" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
});
