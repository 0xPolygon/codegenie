import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error Development-only ESM has no emitted types.
import { CampaignLedger } from "../evals/runner/ledger.mjs";
// @ts-expect-error Development-only ESM has no emitted types.
import { runWorker } from "../evals/runner/worker.mjs";

const checkout = process.cwd();
beforeAll(() => { execFileSync("pnpm", ["build"], { cwd: checkout, stdio: "pipe" }); }, 60_000);

describe("development eval worker", () => {
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
      const worker = JSON.stringify({ caseConfig: caseFile, ledgerPath, ledgerBinding: "synthetic", limitMicros: 15_000_000, attemptPrefix: "slot/attempt-01", expectedCalls: [] });
      writeFileSync(workerFile, worker);
      const digest = createHash("sha256").update(worker).digest("hex");
      const command = [path.join(checkout, "evals/runner/worker.mjs"), workerFile, digest];
      const out = execFileSync("node", command, { encoding: "utf8", env: { ...process.env, CODEGENIE_HOME: path.join(dir, "home") }, timeout: 60_000 });
      expect(JSON.parse(out)).toMatchObject({ caseName: "fixture-core-lens", status: "pass" });
      expect(readFileSync(ledgerPath).byteLength).toBeGreaterThan(0);
      expect(() => execFileSync("node", [command[0]!, workerFile, "0".repeat(64)], { stdio: "pipe" })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);

  it("runs a real adapter against an injected transport only after bound health and key evidence", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "codegenie-worker-guard-"));
    const evidenceText = "synthetic sealed evidence", digest = createHash("sha256").update(evidenceText).digest("hex");
    const evidenceFile = path.join(dir, "evidence.txt"), db = path.join(dir, "ledger.sqlite"), suite = path.join(dir, "suite");
    vi.stubEnv("OPENROUTER_API_KEY", "synthetic-key"); vi.stubEnv("CODEGENIE_HOME", path.join(dir, "home"));
    const originalFetch = vi.fn(async () => { throw new Error("unexpected network"); }); vi.stubGlobal("fetch", originalFetch);
    try {
      mkdirSync(path.join(suite, "repos"), { recursive: true });
      cpSync(path.join(checkout, "evals/fixtures/repos/core"), path.join(suite, "repos/core"), { recursive: true });
      const source = readFileSync(path.join(checkout, "evals/fixtures/core.yml"), "utf8").replace("provider: fake", "provider: openrouter").replace("model: fake-model", "model: openai/gpt-6-luna");
      writeFileSync(path.join(suite, "core.yml"), source); writeFileSync(evidenceFile, evidenceText);
      const caseFile = path.join(dir, "case.json"); writeFileSync(caseFile, JSON.stringify({ caseDir: suite, caseName: "fixture-core-lens", outputDir: path.join(dir, "output") }));
      const ledger = new CampaignLedger(db, { binding: "synthetic", limitMicros: 15_000_000 });
      ledger.bindKeyBaseline({ usageMicros: 0, evidenceSHA256: digest }); ledger.recordKeySnapshot({ usageMicros: 0, observedMs: 1, evidenceSHA256: digest });
      ledger.reservePhysical({ id: "health-1", logicalId: "health", kind: "health", provider: "openrouter", healthBoundary: "boundary-1" });
      ledger.settlePhysical({ id: "health-1", httpStatus: 200, providerCostMicros: 0, costConfirmed: true });
      ledger.recordHealth({ physicalId: "health-1", outcome: "clean", observedMs: 1, evidenceSHA256: digest }); ledger.close();
      const expected = { stage: 5, kind: "initial", provider: "openrouter", modelId: "openai/gpt-6-luna", reasoningSelected: "high", templateVersion: "p5.9", api: "openai-completions", destination: "https://openrouter.ai/api/v1/chat/completions", wireEffort: "high" };
      const fetchImpl = vi.fn(async () => new Response("synthetic failure", { status: 400 }));
      const rejectedCase = path.join(dir, "rejected-case.json");
      writeFileSync(rejectedCase, JSON.stringify({ caseDir: suite, caseName: "fixture-core-lens", outputDir: path.join(dir, "rejected-output") }));
      const rejected = await runWorker({ caseConfig: rejectedCase, ledgerPath: db, ledgerBinding: "synthetic", limitMicros: 15_000_000,
        attemptPrefix: "other-slot/attempt-01", expectedCalls: [expected], boundaryId: "unprobed-boundary", evidenceFiles: { [digest]: evidenceFile } }, { fetchImpl });
      expect(rejected.status).toBe("error"); expect(fetchImpl).not.toHaveBeenCalled();
      const afterRejection = new CampaignLedger(db, { binding: "synthetic", limitMicros: 15_000_000 });
      expect(afterRejection.totals()).toMatchObject({ starts: 1, unknown: 0 }); afterRejection.close();
      const result = await runWorker({ caseConfig: caseFile, ledgerPath: db, ledgerBinding: "synthetic", limitMicros: 15_000_000,
        attemptPrefix: "slot/attempt-01", expectedCalls: [expected], boundaryId: "boundary-1", evidenceFiles: { [digest]: evidenceFile } }, { fetchImpl });
      expect(result.status).toBe("error"); expect(fetchImpl).toHaveBeenCalledTimes(1); expect(originalFetch).not.toHaveBeenCalled();
      const reopened = new CampaignLedger(db, { binding: "synthetic", limitMicros: 15_000_000 });
      expect(reopened.totals()).toMatchObject({ starts: 2, unknown: 1, chargedMicros: 400_000 }); reopened.close();
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
      const worker = JSON.stringify({ caseConfig: caseFile, ledgerPath: path.join(dir, "ledger.sqlite"), ledgerBinding: "synthetic", limitMicros: 15_000_000, attemptPrefix: "slot/attempt-01", expectedCalls: [] });
      writeFileSync(workerFile, worker); const digest = createHash("sha256").update(worker).digest("hex");
      const out = execFileSync("node", [path.join(checkout, "evals/runner/worker.mjs"), workerFile, digest], { encoding: "utf8", env: { ...process.env, CODEGENIE_HOME: path.join(dir, "home") }, timeout: 60_000 });
      expect(JSON.parse(out)).toMatchObject({ caseName: "fixture-core-lens", status: "fail" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
});
