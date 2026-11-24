import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

const checkout = process.cwd();
beforeAll(() => { execFileSync("pnpm", ["build"], { cwd: checkout, stdio: "pipe" }); }, 60_000);

describe("development eval worker", () => {
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
