import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { createRunTelemetry } from "../src/telemetry/run-artifacts.js";
import { clearRegisteredSecretsForTests, registerSecret } from "../src/telemetry/redaction.js";

describe("run telemetry", () => {
  it("redacts mirrored warn and error messages before stderr", () => {
    clearRegisteredSecretsForTests();
    registerSecret("stderr-secret-token");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const run = createRunTelemetry({
      telemetryConfig: {
        ...defaultConfig.telemetry,
        enabled: false
      },
      idFactory: () => "stderr-redaction"
    });

    run.logger.warn({
      runId: run.recorder.runId,
      stage: 0,
      event: "warn_secret",
      message: "warning contains stderr-secret-token"
    });
    run.logger.error({
      runId: run.recorder.runId,
      stage: 0,
      event: "error_secret",
      message: "Authorization: Bearer stderr-secret-token"
    });

    const mirrored = stderr.mock.calls.map((call) => String(call[0])).join("");
    expect(mirrored).not.toContain("stderr-secret-token");
    expect(mirrored).toContain("[redacted:secret]");
    stderr.mockRestore();
    clearRegisteredSecretsForTests();
  });

  it("writes redacted run artifacts", async () => {
    clearRegisteredSecretsForTests();
    registerSecret("super-secret-token");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const repoRoot = tempDir();
    const run = createRunTelemetry({
      telemetryConfig: {
        ...defaultConfig.telemetry,
        logLevel: "debug",
        retainRuns: 20
      },
      runMetadata: {
        argv: ["codeninja", "review", "--branch", "feature"],
        repoRoot,
        review: {
          mode: "branch",
          target: { mode: "branch", branchName: "feature", baseBranch: "main" },
          depth: "deep",
          lenses: ["core/tests"],
          format: "json",
          postGithubComments: false
        }
      },
      idFactory: () => "20260611-120000-test"
    });

    run.logger.info({
      runId: run.recorder.runId,
      stage: 0,
      event: "startup",
      message: "startup super-secret-token",
      data: { header: "Authorization: Bearer super-secret-token" }
    });
    run.recorder.event({
      stage: 0,
      level: "info",
      message: "event super-secret-token",
      data: { token: "super-secret-token" }
    });

    const attached = await run.attachRunDirectory(repoRoot);
    run.recorder.event({
      stage: 5,
      level: "info",
      message: "stage_started"
    });
    run.recorder.event({
      stage: 5,
      level: "info",
      message: "stage_completed",
      cacheStatus: "miss"
    });
    run.recorder.event({
      stage: 7,
      level: "info",
      message: "pipeline_metrics",
      data: {
        totals: {
          filesChanged: 2,
          hunks: 3,
          packets: 2,
          packetReviews: 2,
          candidates: 4,
          verified: 1,
          finalFindings: 1,
          postedComments: 1
        },
        workers: { started: 2, completed: 1, failed: 1, retried: 1, timedOut: 0 },
        packets: { generated: 2, reviewed: 1, failed: 1, degraded: 1 },
        lenses: { selected: 2, byLens: { "core/code-review": 2, "lang/typescript": 1 } },
        coverage: {
          byLevel: { deep: 1, normal: 1, light: 0, skip: 1 },
          hunks: { total: 3, reviewed: 1, skipped: 1, failed: 1, degraded: 1 }
        },
        candidates: { generated: 4, gateRejected: 1, verificationScheduled: 3 },
        verdicts: { accept: 1, revise: 1, reject: 1, incomplete: 1 },
        dedup: { clusters: 2, duplicates: 1, suppressed: 1 },
        finalSelection: { published: 1, merged: 1, suppressed: 1, finalFindings: 1 },
        posting: { attempted: 1, postedComments: 1, skippedDuplicates: 1, failed: 0 }
      }
    });
    run.recorder.recordModelCall({
      callId: "mc-1",
      stage: 5,
      role: "planner",
      model: "model",
      provider: "provider",
      kind: "initial",
      attempt: 1,
      promptChars: 12,
      promptHash: "prompt",
      outputChars: 5,
      outputHash: "super-secret-token",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costUSD: 0.01,
      durationMs: 10,
      cacheStatus: "miss",
      stopReason: "submit",
      status: "ok"
    });
    run.recorder.recordModelCall({
      callId: "mc-2",
      stage: 5,
      role: "planner",
      model: "model",
      provider: "provider",
      kind: "repair",
      attempt: 2,
      promptChars: 20,
      promptHash: "prompt-2",
      outputChars: 0,
      outputHash: "output-2",
      durationMs: 12,
      cacheStatus: "write",
      stopReason: "error",
      status: "schema_invalid",
      errorCode: "llm_schema_invalid"
    });
    run.recorder.recordModelCall({
      callId: "mc-3",
      stage: 5,
      role: "planner",
      model: "model",
      provider: "provider",
      kind: "initial",
      attempt: 1,
      promptChars: 20,
      promptHash: "prompt-3",
      outputChars: 10,
      outputHash: "output-3",
      inputTokens: 999,
      outputTokens: 999,
      totalTokens: 1998,
      costUSD: 9.99,
      durationMs: 1,
      cacheStatus: "hit",
      stopReason: "submit",
      status: "ok"
    });
    const toolCallId = run.recorder.recordToolCall({
      stage: 7,
      initiator: "harness",
      tool: "read_range",
      args: { path: "src/index.ts", query: "super-secret-token" },
      backend: "text",
      precision: "exact",
      degraded: false,
      resultChars: 42,
      durationMs: 3,
      status: "ok"
    });
    await run.recorder.writeArtifact("coverage.json", {
      secret: "super-secret-token",
      status: "not_implemented",
      zLast: true,
      aFirst: true
    });
    await run.finalize({ status: "completed", exitCode: 0 });

    expect(toolCallId).toBe("tc-000001");
    expect(existsSync(path.join(repoRoot, ".codeninja", ".gitignore"))).toBe(true);
    expect(readFileSync(path.join(repoRoot, ".codeninja", ".gitignore"), "utf8")).toContain("runs/");
    expect(readFileSync(path.join(repoRoot, ".codeninja", ".gitignore"), "utf8")).toContain("cache/");
    expect(readFileSync(path.join(repoRoot, ".codeninja", ".gitignore"), "utf8")).toContain("locks/");

    for (const relPath of [
      "run.log",
      "events.jsonl",
      "model-calls.jsonl",
      "tool-calls.jsonl",
      "coverage.json",
      "run.json",
      "telemetry.json",
      "model-calls-summary.json",
      "tool-calls-summary.json",
      "cost-profile.json"
    ]) {
      expect(existsSync(path.join(attached.runDir, relPath)), relPath).toBe(true);
    }

    const allRunText = readRunFiles(attached.runDir);
    expect(allRunText).not.toContain("super-secret-token");
    expect(allRunText).toContain("[redacted:secret]");

    const runJson = readJson(path.join(attached.runDir, "run.json"));
    expect(runJson).toMatchObject({
      schemaVersion: 1,
      codeninjaVersion: expect.any(String),
      nodeVersion: process.version,
      argv: ["codeninja", "review", "--branch", "feature"],
      repoRoot,
      review: {
        mode: "branch",
        prNumber: null,
        baseSha: null,
        headSha: null,
        depth: "deep",
        lenses: ["core/tests"],
        format: "json",
        postGithubComments: false
      },
      outcome: {
        status: "completed",
        errorCode: null,
        exitCode: 0
      }
    });
    expect(runJson.finishedAt).toEqual(expect.any(String));
    expect(runJson.durationMs).toEqual(expect.any(Number));
    expect(runJson.totals).toMatchObject({
      events: 4,
      modelCallRecords: 3,
      modelCalls: 2,
      providerCalls: 2,
      toolCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      totalCostUSD: 0.01,
      unknownCostCalls: 1,
      cache: { hit: 1, miss: 1, disabled: 0, write: 1 },
      retryAttempts: 1,
      repairCalls: 1,
      schemaInvalidCalls: 1,
      filesChanged: 2,
      hunks: 3,
      packets: 2,
      packetReviews: 2,
      candidates: 4,
      verified: 1,
      finalFindings: 1,
      postedComments: 1
    });

    const telemetryJson = readJson(path.join(attached.runDir, "telemetry.json"));
    expect(telemetryJson.totals.modelCalls).toBe(2);
    expect(telemetryJson.totals.modelCallRecords).toBe(3);
    expect(telemetryJson.stages["0"]).toMatchObject({
      events: 1
    });
    expect(telemetryJson.stages["5"]).toMatchObject({
      events: 2,
      cache: { hit: 0, miss: 1, disabled: 0, write: 0 }
    });
    expect(telemetryJson.stages["5"].runtimeMs).toEqual(expect.any(Number));
    expect(telemetryJson.stages["7"]).toMatchObject({
      events: 1
    });
    expect(telemetryJson.workers).toEqual({
      started: 2,
      completed: 1,
      failed: 1,
      retried: 1,
      timedOut: 0
    });
    expect(telemetryJson.coverage).toMatchObject({
      byLevel: { deep: 1, normal: 1, light: 0, skip: 1 },
      hunks: { total: 3, reviewed: 1, skipped: 1, failed: 1, degraded: 1 }
    });
    expect(telemetryJson).toMatchObject({
      packets: { generated: 2, reviewed: 1, failed: 1, degraded: 1 },
      lenses: { selected: 2, byLens: { "core/code-review": 2, "lang/typescript": 1 } },
      candidates: { generated: 4, gateRejected: 1, verificationScheduled: 3 },
      verdicts: { accept: 1, revise: 1, reject: 1, incomplete: 1 },
      dedup: { clusters: 2, duplicates: 1, suppressed: 1 },
      finalSelection: { published: 1, merged: 1, suppressed: 1, finalFindings: 1 },
      posting: { attempted: 1, postedComments: 1, skippedDuplicates: 1, failed: 0 }
    });

    const modelSummary = readJson(path.join(attached.runDir, "model-calls-summary.json"));
    expect(modelSummary).toMatchObject({
      totalRecords: 3,
      totalCalls: 2,
      providerCalls: 2,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costUSD: 0.01,
      unknownCostCalls: 1,
      cache: { hit: 1, miss: 1, disabled: 0, write: 1 },
      retryAttempts: 1,
      repairCalls: 1,
      schemaInvalidCalls: 1
    });
    expect(modelSummary.byStage["5"]).toMatchObject({
      recordCount: 3,
      count: 2,
      providerCalls: 2,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cache: { hit: 1, miss: 1, disabled: 0, write: 1 },
      retryAttempts: 1,
      repairCalls: 1,
      schemaInvalidCalls: 1
    });
    const coverageJson = readFileSync(path.join(attached.runDir, "coverage.json"), "utf8");
    expect(coverageJson.indexOf('"aFirst"')).toBeLessThan(coverageJson.indexOf('"status"'));
    expect(coverageJson.indexOf('"status"')).toBeLessThan(coverageJson.indexOf('"zLast"'));
    expect(stderr).not.toHaveBeenCalled();
    stderr.mockRestore();
    clearRegisteredSecretsForTests();
  });

  it("folds successful cache write events into model-call cache summaries", async () => {
    const repoRoot = tempDir();
    const run = createRunTelemetry({
      telemetryConfig: {
        ...defaultConfig.telemetry,
        logLevel: "debug"
      },
      idFactory: () => "20260611-120001-cache-summary"
    });
    const attached = await run.attachRunDirectory(repoRoot);

    run.recorder.recordModelCall({
      callId: "mc-cold",
      stage: 7,
      role: "packetReview",
      model: "model",
      provider: "provider",
      kind: "initial",
      attempt: 1,
      promptChars: 12,
      promptHash: "prompt",
      outputChars: 5,
      outputHash: "output",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      durationMs: 10,
      cacheStatus: "miss",
      stopReason: "submit",
      status: "ok"
    });
    run.recorder.event({
      stage: 7,
      level: "debug",
      message: "model_call_cache_write",
      cacheStatus: "write"
    });

    await run.finalize({ status: "completed", exitCode: 0 });

    const modelSummary = readJson(path.join(attached.runDir, "model-calls-summary.json"));
    expect(modelSummary.cache).toMatchObject({ hit: 0, miss: 1, disabled: 0, write: 1 });
    expect(modelSummary.byStage["7"].cache).toMatchObject({ hit: 0, miss: 1, disabled: 0, write: 1 });
  });

  it("drops buffered debug/info before warnings and records overflow", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const repoRoot = tempDir();
    const run = createRunTelemetry({
      telemetryConfig: {
        ...defaultConfig.telemetry,
        logLevel: "debug"
      },
      idFactory: () => "log-overflow"
    });

    run.logger.warn({
      runId: run.recorder.runId,
      stage: 0,
      event: "important_warning",
      message: "important warning"
    });
    for (let index = 0; index < 1001; index += 1) {
      run.logger.debug({
        runId: run.recorder.runId,
        stage: 0,
        event: `debug_${index}`,
        message: `debug ${index}`
      });
    }

    const attached = await run.attachRunDirectory(repoRoot);
    await run.finalize({ status: "completed", exitCode: 0 });

    const runLog = readFileSync(path.join(attached.runDir, "run.log"), "utf8");
    expect(runLog).toContain("important warning");
    expect(runLog).toContain("debug 1000");
    expect(runLog).not.toContain("debug 0");

    const telemetryJson = readJson(path.join(attached.runDir, "telemetry.json"));
    expect(telemetryJson.logs.bufferedOverflow.droppedDebugInfo).toBeGreaterThan(0);
    expect(telemetryJson.logs.bufferedOverflow.droppedWarnError).toBe(0);
    stderr.mockRestore();
  });

  it("prunes old runs while keeping the active run", async () => {
    const repoRoot = tempDir();
    const runsRoot = path.join(repoRoot, ".codeninja", "runs");
    mkdirSync(runsRoot, { recursive: true });
    for (const [index, name] of ["old-1", "old-2", "old-3"].entries()) {
      const dir = path.join(runsRoot, name);
      mkdirSync(dir);
      writeFileSync(path.join(dir, "run.json"), "{}");
      const mtime = new Date(Date.now() - (3 - index) * 1000);
      utimesSync(dir, mtime, mtime);
    }

    const run = createRunTelemetry({
      telemetryConfig: {
        ...defaultConfig.telemetry,
        retainRuns: 2
      },
      idFactory: () => "active-run"
    });
    run.recorder.event({
      stage: 0,
      level: "info",
      message: "pre-attach event"
    });
    await run.attachRunDirectory(repoRoot);

    expect(readdirSync(runsRoot).sort()).toEqual(["active-run", "old-2", "old-3"]);
    const events = readFileSync(path.join(runsRoot, "active-run", "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.eventId)).toEqual(["ev-000001", "ev-000002"]);
    expect(events.map((event) => event.message)).toEqual([
      "pre-attach event",
      "old run directories pruned"
    ]);
  });

  it("preserves existing .codeninja gitignore entries while adding required runtime paths", async () => {
    const repoRoot = tempDir();
    const codeninjaDir = path.join(repoRoot, ".codeninja");
    mkdirSync(codeninjaDir, { recursive: true });
    const gitignorePath = path.join(codeninjaDir, ".gitignore");
    writeFileSync(gitignorePath, "skills/\n");

    const run = createRunTelemetry({
      telemetryConfig: defaultConfig.telemetry,
      idFactory: () => "existing-policy-dir"
    });
    await run.attachRunDirectory(repoRoot);

    expect(readFileSync(gitignorePath, "utf8")).toBe("skills/\nruns/\ncache/\nlocks/\n");
  });

  it("records pruning failures as warnings without aborting startup", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const repoRoot = tempDir();
    const runsRoot = path.join(repoRoot, ".codeninja", "runs");
    mkdirSync(runsRoot, { recursive: true });
    const protectedRun = path.join(runsRoot, "old-protected");
    mkdirSync(protectedRun);
    writeFileSync(path.join(protectedRun, "run.json"), "{}");
    writeFileSync(path.join(protectedRun, "locked.txt"), "locked");
    const newerRun = path.join(runsRoot, "newer-finalized");
    mkdirSync(newerRun);
    writeFileSync(path.join(newerRun, "run.json"), "{}");
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(protectedRun, oldTime, oldTime);
    chmodSync(protectedRun, 0o500);

    try {
      const run = createRunTelemetry({
        telemetryConfig: {
          ...defaultConfig.telemetry,
          retainRuns: 1
        },
        idFactory: () => "active-with-prune-warning"
      });
      const attached = await run.attachRunDirectory(repoRoot);

      expect(attached.runDir).toBe(path.join(runsRoot, "active-with-prune-warning"));
      expect(existsSync(attached.runDir)).toBe(true);
      expect(existsSync(protectedRun)).toBe(true);
      expect(readFileSync(path.join(attached.runDir, "events.jsonl"), "utf8")).toContain(
        "failed to prune old run directory"
      );
      expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
        "failed to prune old run directory"
      );
    } finally {
      chmodSync(protectedRun, 0o700);
      stderr.mockRestore();
    }
  });
});

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "codeninja-"));
}

function readRunFiles(runDir: string): string {
  const chunks: string[] = [];
  for (const entry of readdirSync(runDir, { withFileTypes: true })) {
    const fullPath = path.join(runDir, entry.name);
    if (entry.isDirectory()) {
      chunks.push(readRunFiles(fullPath));
    } else {
      chunks.push(readFileSync(fullPath, "utf8"));
    }
  }
  return chunks.join("\n");
}

function readJson(filePath: string): any {
  return JSON.parse(readFileSync(filePath, "utf8"));
}
