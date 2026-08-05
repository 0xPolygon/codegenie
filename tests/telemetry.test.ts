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
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { ARTIFACT_LOCATION, KNOWN_ARTIFACTS, canonicalArtifactPath, createRunTelemetry } from "../src/telemetry/run-artifacts.js";
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
        enabled: true,
        logLevel: "debug",
        retainRuns: 20
      },
      runMetadata: {
        argv: ["codegenie", "review", "--branch", "feature"],
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
        candidates: {
          generated: 4,
          gateRejected: 1,
          verificationScheduled: 3,
          verificationBudgetLimited: 1,
          clusteredDuplicates: 2,
          verificationRepresentatives: 3,
          lowConfidenceSuppressed: 1,
          lowConfidenceEvidenceEligible: 2,
          lowConfidenceEvidenceScheduled: 1,
          lowConfidenceEvidenceLaneLimited: 1,
          lowConfidenceEvidenceKept: 1,
          lowConfidenceEvidenceRejected: 1,
          lowConfidenceEvidenceIncomplete: 0
        },
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
      cacheStatus: "disabled",
      backendExecuted: true,
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
    await run.finalize({ status: "completed_full", exitCode: 0 });

    expect(toolCallId).toBe("tc-000001");
    expect(existsSync(path.join(repoRoot, ".codegenie", ".gitignore"))).toBe(true);
    expect(readFileSync(path.join(repoRoot, ".codegenie", ".gitignore"), "utf8")).toContain("runs/");
    expect(readFileSync(path.join(repoRoot, ".codegenie", ".gitignore"), "utf8")).toContain("cache/");
    expect(readFileSync(path.join(repoRoot, ".codegenie", ".gitignore"), "utf8")).toContain("locks/");

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
      expect(existsSync(runFilePath(attached.runDir, relPath)), relPath).toBe(true);
    }
    expect(existsSync(path.join(attached.runDir, "coverage.json"))).toBe(false);
    expect(existsSync(path.join(attached.runDir, "model-calls-summary.json"))).toBe(false);
    expect(existsSync(path.join(attached.runDir, "tool-calls-summary.json"))).toBe(false);
    expect(existsSync(path.join(attached.runDir, "cost-profile.json"))).toBe(false);
    expect(existsSync(path.join(attached.runDir, "packets"))).toBe(false);

    const allRunText = readRunFiles(attached.runDir);
    expect(allRunText).not.toContain("super-secret-token");
    expect(allRunText).toContain("[redacted:secret]");

    const runJson = readJson(path.join(attached.runDir, "run.json"));
    expect(runJson).toMatchObject({
      schemaVersion: 1,
      codegenieVersion: expect.any(String),
      codegenieRuntime: {
        packageVersion: expect.any(String),
        source: expect.stringMatching(/^(build_env|git|package|unknown)$/)
      },
      nodeVersion: process.version,
      argv: ["codegenie", "review", "--branch", "feature"],
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
        status: "completed_full",
        errorCode: null,
        exitCode: 0,
        budgetStop: null
      }
    });
    expect(runJson.finishedAt).toEqual(expect.any(String));
    expect(runJson.codegenieRuntime.packageVersion).toBe(runJson.codegenieVersion);
    expect(runJson.durationMs).toEqual(expect.any(Number));
    expect(runJson.totals).toMatchObject({
      events: 4,
      modelCallRecords: 3,
      modelCalls: 2,
      providerCalls: 2,
      toolCalls: 1,
      toolResultCache: {
        hits: 0,
        misses: 0,
        writes: 0,
        disabled: 1,
        inflightHits: 0,
        evictions: 0,
        backendExecutions: 1,
        savedBackendCalls: 0
      },
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      totalCostUSD: 0.01,
      unknownCostCalls: 1,
      cache: { hit: 1, miss: 2, disabled: 0, write: 1 },
      localModelCallCache: { hit: 1, miss: 2, disabled: 0, write: 1 },
      providerPromptCache: { readTokens: 0, writeTokens: 0, readCostUSD: 0, writeCostUSD: 0 },
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
      candidates: {
        generated: 4,
        gateRejected: 1,
        verificationScheduled: 3,
        verificationBudgetLimited: 1,
        clusteredDuplicates: 2,
        verificationRepresentatives: 3,
        lowConfidenceSuppressed: 1,
        lowConfidenceEvidenceEligible: 2,
        lowConfidenceEvidenceScheduled: 1,
        lowConfidenceEvidenceLaneLimited: 1,
        lowConfidenceEvidenceKept: 1,
        lowConfidenceEvidenceRejected: 1,
        lowConfidenceEvidenceIncomplete: 0
      },
      verdicts: { accept: 1, revise: 1, reject: 1, incomplete: 1 },
      dedup: { clusters: 2, duplicates: 1, suppressed: 1 },
      finalSelection: { published: 1, merged: 1, suppressed: 1, finalFindings: 1 },
      posting: { attempted: 1, postedComments: 1, skippedDuplicates: 1, failed: 0 }
    });

    const modelSummary = readJson(runFilePath(attached.runDir, "model-calls-summary.json"));
    expect(modelSummary).toMatchObject({
      totalRecords: 3,
      totalCalls: 2,
      providerCalls: 2,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costUSD: 0.01,
      unknownCostCalls: 1,
      cache: { hit: 1, miss: 2, disabled: 0, write: 1 },
      localModelCallCache: { hit: 1, miss: 2, disabled: 0, write: 1 },
      providerPromptCache: { readTokens: 0, writeTokens: 0, readCostUSD: 0, writeCostUSD: 0 },
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
      cache: { hit: 1, miss: 2, disabled: 0, write: 1 },
      localModelCallCache: { hit: 1, miss: 2, disabled: 0, write: 1 },
      providerPromptCache: { readTokens: 0, writeTokens: 0, readCostUSD: 0, writeCostUSD: 0 },
      retryAttempts: 1,
      repairCalls: 1,
      schemaInvalidCalls: 1
    });
    const coverageJson = readFileSync(runFilePath(attached.runDir, "coverage.json"), "utf8");
    expect(coverageJson.indexOf('"aFirst"')).toBeLessThan(coverageJson.indexOf('"status"'));
    expect(coverageJson.indexOf('"status"')).toBeLessThan(coverageJson.indexOf('"zLast"'));
    const manifest = readJson(runFilePath(attached.runDir, "artifact-manifest.json"));
    expect(manifest).toMatchObject({ schemaVersion: 1, layoutVersion: 2 });
    expect(manifest.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "coverage", stage: 10, stageName: "composing review", kind: "json", path: ARTIFACT_LOCATION["coverage.json"] }),
      expect.objectContaining({ id: "model-calls-summary", stage: 0, stageName: "run", kind: "json", path: ARTIFACT_LOCATION["model-calls-summary.json"] }),
      expect.objectContaining({ id: "run", stage: 0, stageName: "run", kind: "json", path: "run.json" }),
      expect.objectContaining({ id: "events", stage: 0, stageName: "run", kind: "jsonl", path: "events.jsonl" }),
      expect.objectContaining({ id: "artifact-manifest", stage: 0, stageName: "run", kind: "json", path: "artifact-manifest.json" })
    ]));
    expect(stderr).not.toHaveBeenCalled();
    stderr.mockRestore();
    clearRegisteredSecretsForTests();
  });

  it("uses stage_failed as a lifecycle endpoint for stage runtime telemetry", async () => {
    const repoRoot = tempDir();
    let now = Date.parse("2026-06-17T10:00:00.000Z");
    const run = createRunTelemetry({
      telemetryConfig: {
        ...defaultConfig.telemetry,
        enabled: true,
        logLevel: "debug"
      },
      idFactory: () => "20260617-100000-stage-failed",
      clock: () => new Date(now)
    });
    const attached = await run.attachRunDirectory(repoRoot);

    run.recorder.event({
      stage: 10,
      level: "info",
      message: "stage_started",
      data: { name: "composition" }
    });
    now += 4321;
    run.recorder.event({
      stage: 10,
      level: "error",
      message: "stage_failed",
      data: { errorCode: "llm_schema_invalid" }
    });
    await run.finalize({ status: "failed", errorCode: "llm_schema_invalid", exitCode: 1 });

    const telemetryJson = readJson(path.join(attached.runDir, "telemetry.json"));
    expect(telemetryJson.stages["10"]).toMatchObject({
      events: 2,
      runtimeMs: 4321
    });
  });

  it("does not double-count runtime when a stage emits duplicate lifecycle endpoints", async () => {
    const repoRoot = tempDir();
    let now = Date.parse("2026-06-17T10:00:00.000Z");
    const run = createRunTelemetry({
      telemetryConfig: {
        ...defaultConfig.telemetry,
        enabled: true,
        logLevel: "debug"
      },
      idFactory: () => "20260617-100000-stage-duplicate",
      clock: () => new Date(now)
    });
    const attached = await run.attachRunDirectory(repoRoot);

    run.recorder.event({
      stage: 6,
      level: "info",
      message: "stage_started"
    });
    now += 1000;
    run.recorder.event({
      stage: 6,
      level: "info",
      message: "stage_completed"
    });
    now += 2000;
    run.recorder.event({
      stage: 6,
      level: "info",
      message: "stage_completed"
    });
    await run.finalize({ status: "completed_full", exitCode: 0 });

    const telemetryJson = readJson(path.join(attached.runDir, "telemetry.json"));
    expect(telemetryJson.stages["6"]).toMatchObject({
      events: 3,
      runtimeMs: 1000
    });
  });

  it("reports deterministic schema recovery beside raw schema-invalid model calls", async () => {
    const repoRoot = tempDir();
    const run = createRunTelemetry({
      telemetryConfig: {
        ...defaultConfig.telemetry,
        enabled: true,
        logLevel: "debug"
      },
      idFactory: () => "20260617-100001-schema-recovered"
    });
    const attached = await run.attachRunDirectory(repoRoot);

    run.recorder.recordModelCall({
      callId: "mc-schema-invalid",
      stage: 10,
      role: "composer",
      model: "model",
      provider: "provider",
      kind: "initial",
      attempt: 1,
      promptChars: 12,
      promptHash: "prompt",
      outputChars: 5,
      outputHash: "output",
      durationMs: 10,
      cacheStatus: "miss",
      schemaValid: false,
      stopReason: "submit",
      status: "schema_invalid",
      errorCode: "llm_schema_invalid"
    });
    run.recorder.event({
      stage: 10,
      level: "info",
      message: "schema_invalid_submit_recovered",
      data: { submitTool: "submit_composition", invalidSubmitCallCount: 1 }
    });
    run.recorder.event({
      stage: 10,
      level: "info",
      message: "stage_completed"
    });
    await run.finalize({ status: "completed_full", exitCode: 0 });

    const modelSummary = readJson(runFilePath(attached.runDir, "model-calls-summary.json"));
    expect(modelSummary).toMatchObject({
      schemaInvalidCalls: 1,
      schemaRecovery: {
        schemaInvalidCalls: 1,
        schemaInvalidRecovered: 1,
        schemaInvalidUnrecovered: 0,
        schemaRepairAttempts: 0,
        schemaRepairRecovered: 0,
        deterministicSchemaRecovered: 1,
        schemaRecoveryFailed: 0
      }
    });
    expect(modelSummary.byStage["10"]).toMatchObject({
      schemaInvalidCalls: 1,
      statuses: { schema_invalid: 1 },
      schemaRecovery: {
        schemaInvalidCalls: 1,
        schemaInvalidRecovered: 1,
        schemaInvalidUnrecovered: 0,
        deterministicSchemaRecovered: 1
      }
    });

    const telemetryJson = readJson(path.join(attached.runDir, "telemetry.json"));
    expect(telemetryJson.schemaRecovery).toMatchObject({
      schemaInvalidCalls: 1,
      schemaInvalidRecovered: 1,
      schemaInvalidUnrecovered: 0,
      deterministicSchemaRecovered: 1
    });
    expect(telemetryJson.stages["10"].schemaRecovery).toMatchObject({
      schemaInvalidCalls: 1,
      schemaInvalidRecovered: 1,
      schemaInvalidUnrecovered: 0,
      deterministicSchemaRecovered: 1
    });
  });

  it("keeps unrecovered schema-invalid repair failures visible", async () => {
    const repoRoot = tempDir();
    const run = createRunTelemetry({
      telemetryConfig: {
        ...defaultConfig.telemetry,
        enabled: true,
        logLevel: "debug"
      },
      idFactory: () => "20260617-100002-schema-unrecovered"
    });
    const attached = await run.attachRunDirectory(repoRoot);

    run.recorder.recordModelCall({
      callId: "mc-planner-invalid",
      stage: 5,
      role: "planner",
      model: "model",
      provider: "provider",
      kind: "initial",
      attempt: 1,
      promptChars: 12,
      promptHash: "prompt-1",
      outputChars: 5,
      outputHash: "output-1",
      durationMs: 10,
      cacheStatus: "miss",
      schemaValid: false,
      stopReason: "submit",
      status: "schema_invalid",
      errorCode: "llm_schema_invalid"
    });
    run.recorder.recordModelCall({
      callId: "mc-planner-repair-invalid",
      stage: 5,
      role: "planner",
      model: "model",
      provider: "provider",
      kind: "repair",
      attempt: 2,
      promptChars: 18,
      promptHash: "prompt-2",
      outputChars: 5,
      outputHash: "output-2",
      durationMs: 11,
      cacheStatus: "write",
      schemaValid: false,
      stopReason: "submit",
      status: "schema_invalid",
      errorCode: "llm_schema_invalid"
    });
    await run.finalize({ status: "failed", errorCode: "llm_schema_invalid", exitCode: 1 });

    const modelSummary = readJson(runFilePath(attached.runDir, "model-calls-summary.json"));
    expect(modelSummary.schemaRecovery).toMatchObject({
      schemaInvalidCalls: 2,
      schemaInvalidRecovered: 0,
      schemaInvalidUnrecovered: 2,
      schemaRepairAttempts: 1,
      schemaRepairRecovered: 0,
      deterministicSchemaRecovered: 0,
      schemaRecoveryFailed: 1
    });
    expect(modelSummary.byStage["5"].schemaRecovery).toMatchObject({
      schemaInvalidCalls: 2,
      schemaInvalidUnrecovered: 2,
      schemaRepairAttempts: 1,
      schemaRecoveryFailed: 1
    });
  });

  it("counts successful model schema repair as recovered without rewriting raw calls", async () => {
    const repoRoot = tempDir();
    const run = createRunTelemetry({
      telemetryConfig: {
        ...defaultConfig.telemetry,
        enabled: true,
        logLevel: "debug"
      },
      idFactory: () => "20260617-100003-schema-model-repair"
    });
    const attached = await run.attachRunDirectory(repoRoot);

    run.recorder.recordModelCall({
      callId: "mc-verifier-invalid",
      stage: 9,
      role: "verifier",
      model: "model",
      provider: "provider",
      kind: "initial",
      attempt: 1,
      promptChars: 12,
      promptHash: "prompt-1",
      outputChars: 5,
      outputHash: "output-1",
      durationMs: 10,
      cacheStatus: "miss",
      schemaValid: false,
      stopReason: "submit",
      status: "schema_invalid",
      errorCode: "llm_schema_invalid"
    });
    run.recorder.recordModelCall({
      callId: "mc-verifier-repair-ok",
      stage: 9,
      role: "verifier",
      model: "model",
      provider: "provider",
      kind: "repair",
      attempt: 2,
      promptChars: 18,
      promptHash: "prompt-2",
      outputChars: 5,
      outputHash: "output-2",
      durationMs: 11,
      cacheStatus: "write",
      schemaValid: true,
      stopReason: "submit",
      status: "ok"
    });
    await run.finalize({ status: "completed_full", exitCode: 0 });

    const modelCalls = readJsonl(path.join(attached.runDir, "model-calls.jsonl"));
    expect(modelCalls.map((call) => call.status)).toEqual(["schema_invalid", "ok"]);
    const modelSummary = readJson(runFilePath(attached.runDir, "model-calls-summary.json"));
    expect(modelSummary.schemaRecovery).toMatchObject({
      schemaInvalidCalls: 1,
      schemaInvalidRecovered: 1,
      schemaInvalidUnrecovered: 0,
      schemaRepairAttempts: 1,
      schemaRepairRecovered: 1,
      deterministicSchemaRecovered: 0,
      schemaRecoveryFailed: 0
    });
  });

  it("summarizes only bounded final-argument provenance and repair outcomes", async () => {
    const repoRoot = tempDir();
    const run = createRunTelemetry({
      telemetryConfig: { ...defaultConfig.telemetry, enabled: true, logLevel: "debug" },
      idFactory: () => "20260805-final-argument-provenance"
    });
    const attached = await run.attachRunDirectory(repoRoot);
    const base = {
      stage: 7 as const,
      role: "packetReview" as const,
      model: "model",
      provider: "provider",
      promptChars: 12,
      promptHash: "prompt",
      outputChars: 0,
      outputHash: "bounded-output-hash",
      durationMs: 10,
      stopReason: "submit" as const
    };
    run.recorder.recordModelCall({
      ...base,
      callId: "mc-1",
      kind: "initial",
      attempt: 1,
      cacheStatus: "miss",
      schemaValid: false,
      status: "schema_invalid",
      submitTool: "submit_review",
      finalArgumentState: "partial",
      finalArgumentErrorKind: "unterminated",
      finalArgumentCorrelationId: "mc-1:submit"
    });
    run.recorder.recordModelCall({
      ...base,
      callId: "mc-2",
      kind: "repair",
      attempt: 1,
      cacheStatus: "write",
      schemaValid: true,
      status: "ok",
      submitTool: "submit_review",
      finalArgumentState: "repaired",
      finalArgumentRepairKind: "pi_narrow_string_repair",
      finalArgumentCorrelationId: "mc-2:submit"
    });
    run.recorder.event({
      stage: 7,
      level: "info",
      message: "final_argument_repair_outcome",
      data: { correlationId: "mc-1:submit", outcome: "recovered" }
    });
    await run.finalize({ status: "completed_full", exitCode: 0 });

    const summary = readJson(runFilePath(attached.runDir, "model-calls-summary.json"));
    expect(summary.finalArgumentStates).toMatchObject({ partial: 1, repaired: 1, strict: 0 });
    expect(summary.finalArgumentErrorKinds).toMatchObject({ unterminated: 1, invalid_syntax: 0 });
    expect(summary.finalArgumentOutcomes).toEqual({ recovered: 1, terminal_invalid: 0, not_dispatched: 0 });
    const serialized = readRunFiles(attached.runDir);
    expect(serialized).not.toContain("raw-event-repository-secret");
    expect(serialized).not.toContain("Unexpected token from parser");
  });

  it("aggregates tool-result cache telemetry in run artifacts", async () => {
    const repoRoot = tempDir();
    const run = createRunTelemetry({
      telemetryConfig: {
        ...defaultConfig.telemetry,
        enabled: true,
        logLevel: "debug"
      },
      idFactory: () => "20260611-120001-tool-result-cache-summary"
    });
    const attached = await run.attachRunDirectory(repoRoot);
    const common = {
      stage: 7 as const,
      initiator: "model" as const,
      tool: "read_range",
      args: { path: "src/index.ts", startLine: 1, endLine: 2 },
      backend: "text" as const,
      precision: "exact" as const,
      degraded: false,
      resultChars: 20,
      durationMs: 5
    };

    run.recorder.recordToolCall({
      ...common,
      cacheStatus: "write",
      backendExecuted: true,
      cacheEvictedEntries: 2,
      status: "ok"
    });
    run.recorder.recordToolCall({
      ...common,
      cacheStatus: "hit",
      cacheHitKind: "stored",
      backendExecuted: false,
      durationMs: 1,
      status: "ok"
    });
    run.recorder.recordToolCall({
      ...common,
      cacheStatus: "hit",
      cacheHitKind: "inflight",
      backendExecuted: false,
      durationMs: 1,
      status: "ok"
    });
    run.recorder.recordToolCall({
      ...common,
      cacheStatus: "miss",
      backendExecuted: true,
      status: "error",
      errorCode: "llm_call_failed"
    });
    run.recorder.recordToolCall({
      ...common,
      cacheStatus: "disabled",
      backendExecuted: true,
      status: "ok"
    });

    await run.finalize({ status: "completed_full", exitCode: 0 });

    const expected = {
      hits: 2,
      misses: 2,
      writes: 1,
      disabled: 1,
      inflightHits: 1,
      evictions: 2,
      backendExecutions: 3,
      savedBackendCalls: 2
    };
    const runJson = readJson(path.join(attached.runDir, "run.json"));
    expect(runJson.totals.toolResultCache).toEqual(expected);
    const toolSummary = readJson(runFilePath(attached.runDir, "tool-calls-summary.json"));
    expect(toolSummary.resultCache).toEqual(expected);
    expect(toolSummary.byTool.read_range).toMatchObject({
      count: 5,
      errors: 1,
      backendExecutions: 3,
      savedBackendCalls: 2,
      resultCache: expected
    });
    expect(toolSummary.byStage["7"]).toMatchObject({
      count: 5,
      errors: 1,
      backendExecutions: 3,
      savedBackendCalls: 2,
      resultCache: expected
    });
  });

  it("aggregates prompt-cache token and cost telemetry without counting cache-hit replays", async () => {
    const repoRoot = tempDir();
    const run = createRunTelemetry({
      telemetryConfig: {
        ...defaultConfig.telemetry,
        enabled: true,
        logLevel: "debug"
      },
      idFactory: () => "20260611-120002-cache-token-summary"
    });
    const attached = await run.attachRunDirectory(repoRoot);

    run.recorder.recordModelCall({
      callId: "mc-provider",
      stage: 7,
      role: "packetReview",
      model: "model",
      provider: "anthropic",
      kind: "initial",
      attempt: 1,
      promptChars: 12,
      promptHash: "prompt",
      outputChars: 5,
      outputHash: "output",
      inputTokens: 112,
      uncachedInputTokens: 10,
      cacheReadTokens: 100,
      cacheWriteTokens: 2,
      billableInputTokens: 112,
      outputTokens: 5,
      totalTokens: 117,
      costUSD: 0.037,
      inputCostUSD: 0.01,
      outputCostUSD: 0.02,
      cacheReadCostUSD: 0.003,
      cacheWriteCostUSD: 0.004,
      durationMs: 10,
      cacheStatus: "miss",
      stopReason: "submit",
      status: "ok"
    });
    run.recorder.recordModelCall({
      callId: "mc-cache-hit",
      stage: 7,
      role: "packetReview",
      model: "model",
      provider: "anthropic",
      kind: "initial",
      attempt: 1,
      promptChars: 12,
      promptHash: "prompt",
      outputChars: 5,
      outputHash: "output",
      inputTokens: 999,
      uncachedInputTokens: 999,
      cacheReadTokens: 999,
      cacheWriteTokens: 999,
      billableInputTokens: 999,
      outputTokens: 999,
      totalTokens: 3996,
      costUSD: 9.99,
      inputCostUSD: 9.99,
      outputCostUSD: 9.99,
      cacheReadCostUSD: 9.99,
      cacheWriteCostUSD: 9.99,
      durationMs: 0,
      cacheStatus: "hit",
      stopReason: "submit",
      status: "ok"
    });

    await run.finalize({ status: "completed_full", exitCode: 0 });

    const runJson = readJson(path.join(attached.runDir, "run.json"));
    expect(runJson.totals).toMatchObject({
      modelCallRecords: 2,
      providerCalls: 1,
      inputTokens: 112,
      uncachedInputTokens: 10,
      cacheReadTokens: 100,
      cacheWriteTokens: 2,
      billableInputTokens: 112,
      outputTokens: 5,
      totalTokens: 117,
      totalCostUSD: 0.037,
      inputCostUSD: 0.01,
      outputCostUSD: 0.02,
      cacheReadCostUSD: 0.003,
      cacheWriteCostUSD: 0.004,
      cache: { hit: 1, miss: 1, disabled: 0, write: 0 },
      localModelCallCache: { hit: 1, miss: 1, disabled: 0, write: 0 },
      providerPromptCache: { readTokens: 100, writeTokens: 2, readCostUSD: 0.003, writeCostUSD: 0.004 }
    });

    const modelSummary = readJson(runFilePath(attached.runDir, "model-calls-summary.json"));
    expect(modelSummary).toMatchObject({
      totalRecords: 2,
      providerCalls: 1,
      inputTokens: 112,
      uncachedInputTokens: 10,
      cacheReadTokens: 100,
      cacheWriteTokens: 2,
      billableInputTokens: 112,
      outputTokens: 5,
      totalTokens: 117,
      costUSD: 0.037,
      inputCostUSD: 0.01,
      outputCostUSD: 0.02,
      cacheReadCostUSD: 0.003,
      cacheWriteCostUSD: 0.004,
      localModelCallCache: { hit: 1, miss: 1, disabled: 0, write: 0 },
      providerPromptCache: { readTokens: 100, writeTokens: 2, readCostUSD: 0.003, writeCostUSD: 0.004 }
    });
    expect(modelSummary.byStage["7"]).toMatchObject({
      providerCalls: 1,
      inputTokens: 112,
      uncachedInputTokens: 10,
      cacheReadTokens: 100,
      cacheWriteTokens: 2,
      billableInputTokens: 112,
      localModelCallCache: { hit: 1, miss: 1, disabled: 0, write: 0 },
      providerPromptCache: { readTokens: 100, writeTokens: 2, readCostUSD: 0.003, writeCostUSD: 0.004 }
    });

    const costProfile = readJson(runFilePath(attached.runDir, "cost-profile.json"));
    expect(costProfile).toMatchObject({
      totalCostUSD: 0.037,
      localModelCallCache: { hit: 1, miss: 1, disabled: 0, write: 0 },
      providerPromptCache: { readTokens: 100, writeTokens: 2, readCostUSD: 0.003, writeCostUSD: 0.004 },
      costBreakdown: {
        uncachedInput: { tokens: 10, costUSD: 0.01 },
        providerPromptCacheRead: { tokens: 100, costUSD: 0.003 },
        providerPromptCacheWrite: { tokens: 2, costUSD: 0.004 },
        output: { tokens: 5, costUSD: 0.02 },
        total: { tokens: 117, costUSD: 0.037 }
      },
      tokens: {
        inputTokens: 112,
        uncachedInputTokens: 10,
        cacheReadTokens: 100,
        cacheWriteTokens: 2,
        billableInputTokens: 112,
        outputTokens: 5,
        totalTokens: 117
      },
      cost: {
        inputCostUSD: 0.01,
        outputCostUSD: 0.02,
        cacheReadCostUSD: 0.003,
        cacheWriteCostUSD: 0.004,
        totalCostUSD: 0.037
      }
    });
    const groupedCost = costProfile.costBreakdown.uncachedInput.costUSD +
      costProfile.costBreakdown.providerPromptCacheRead.costUSD +
      costProfile.costBreakdown.providerPromptCacheWrite.costUSD +
      costProfile.costBreakdown.output.costUSD;
    expect(groupedCost).toBeCloseTo(costProfile.totalCostUSD);
    expect(costProfile.byStage["7"]).toMatchObject({
      localModelCallCache: { hit: 1, miss: 1, disabled: 0, write: 0 },
      providerPromptCache: { readTokens: 100, writeTokens: 2, readCostUSD: 0.003, writeCostUSD: 0.004 },
      costBreakdown: {
        uncachedInput: { tokens: 10, costUSD: 0.01 },
        providerPromptCacheRead: { tokens: 100, costUSD: 0.003 },
        providerPromptCacheWrite: { tokens: 2, costUSD: 0.004 },
        output: { tokens: 5, costUSD: 0.02 },
        total: { tokens: 117, costUSD: 0.037 }
      }
    });
  });

  it("counts miss-then-write model-call records once even when write events are emitted", async () => {
    const repoRoot = tempDir();
    const run = createRunTelemetry({
      telemetryConfig: {
        ...defaultConfig.telemetry,
        enabled: true,
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
      cacheStatus: "write",
      stopReason: "submit",
      status: "ok"
    });
    run.recorder.event({
      stage: 7,
      level: "debug",
      message: "model_call_cache_write",
      cacheStatus: "write"
    });

    await run.finalize({ status: "completed_full", exitCode: 0 });

    const modelSummary = readJson(runFilePath(attached.runDir, "model-calls-summary.json"));
    expect(modelSummary.cache).toMatchObject({ hit: 0, miss: 1, disabled: 0, write: 1 });
    expect(modelSummary.localModelCallCache).toMatchObject({ hit: 0, miss: 1, disabled: 0, write: 1 });
    expect(modelSummary.byStage["7"].cache).toMatchObject({ hit: 0, miss: 1, disabled: 0, write: 1 });
    expect(modelSummary.byStage["7"].localModelCallCache).toMatchObject({ hit: 0, miss: 1, disabled: 0, write: 1 });
  });

  it("summarizes source budget extension events as context pressure", () => {
    const run = createRunTelemetry({
      telemetryConfig: {
        ...defaultConfig.telemetry,
        enabled: true,
        logLevel: "debug"
      },
      idFactory: () => "source-extension-pressure"
    });

    run.recorder.event({
      stage: 9,
      level: "info",
      message: "tool_budget_extension_granted",
      workerId: "worker-verify",
      data: { tool: "read_range", triggerReason: "tool_result_budget_exhausted", resultChars: 321 }
    });
    run.recorder.event({
      stage: 7,
      level: "debug",
      message: "tool_budget_extension_denied",
      packetId: "packet-1",
      data: { tool: "search_files", triggerReason: "tool_result_budget_exhausted", denyReason: "not_exact_source_tool" }
    });

    expect(run.recorder.snapshotContextPressure?.().toolBudgetExtensions).toEqual({
      granted: 1,
      denied: 1,
      resultChars: 321,
      grantedByStage: { 9: 1 },
      deniedByStage: { 7: 1 }
    });
  });

  it("drops buffered debug/info before warnings and records overflow", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const repoRoot = tempDir();
    const run = createRunTelemetry({
      telemetryConfig: {
        ...defaultConfig.telemetry,
        enabled: true,
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
    await run.finalize({ status: "completed_full", exitCode: 0 });

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
    const runsRoot = path.join(repoRoot, ".codegenie", "runs");
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
        enabled: true,
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

  it("prunes crashed run directories without requiring run.json", async () => {
    const repoRoot = tempDir();
    const runsRoot = path.join(repoRoot, ".codegenie", "runs");
    mkdirSync(runsRoot, { recursive: true });
    const crashed = path.join(runsRoot, "crashed-before-run-json");
    mkdirSync(crashed);
    const retained = path.join(runsRoot, "retained-finished-run");
    mkdirSync(retained);
    writeFileSync(path.join(retained, "run.json"), "{}");
    const oldTime = new Date(Date.now() - 10_000);
    const newTime = new Date(Date.now() - 1000);
    utimesSync(crashed, oldTime, oldTime);
    utimesSync(retained, newTime, newTime);

    const run = createRunTelemetry({
      telemetryConfig: {
        ...defaultConfig.telemetry,
        enabled: true,
        retainRuns: 1
      },
      idFactory: () => "active-crash-prune"
    });
    await run.attachRunDirectory(repoRoot);

    expect(readdirSync(runsRoot).sort()).toEqual(["active-crash-prune", "retained-finished-run"]);
  });

  it("does not mutate an existing .codegenie gitignore", async () => {
    const repoRoot = tempDir();
    const codegenieDir = path.join(repoRoot, ".codegenie");
    mkdirSync(codegenieDir, { recursive: true });
    const gitignorePath = path.join(codegenieDir, ".gitignore");
    writeFileSync(gitignorePath, "skills/\n");

    const run = createRunTelemetry({
      telemetryConfig: { ...defaultConfig.telemetry, enabled: true },
      idFactory: () => "existing-policy-dir"
    });
    await run.attachRunDirectory(repoRoot);

    expect(readFileSync(gitignorePath, "utf8")).toBe("skills/\n");
  });

  it("records pruning failures as warnings without aborting startup", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const repoRoot = tempDir();
    const runsRoot = path.join(repoRoot, ".codegenie", "runs");
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
          enabled: true,
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

describe("run artifact allowlist", () => {
  // Guards against the class of bug where a pipeline stage adds a writeArtifact("foo.json")
  // call but forgets to register "foo.json" in KNOWN_ARTIFACTS. assertAllowedArtifactPath only
  // throws at runtime when that code path is hit (e.g. Stage 8 with tasks), so an unregistered
  // artifact can ship undetected and abort a whole review. This scans source for the literal
  // call sites and fails at test time instead.
  const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

  it("writes logical artifacts to their canonical stage locations", async () => {
    const repoRoot = tempDir();
    const run = createRunTelemetry({
      telemetryConfig: {
        ...defaultConfig.telemetry,
        enabled: true
      },
      idFactory: () => "canonical-stage-layout"
    });
    const attached = await run.attachRunDirectory(repoRoot);

    await run.recorder.writeArtifact("review-plan.json", { ok: true });
    await run.recorder.writeArtifact("packets/packet-1.json", { id: "packet-1" });
    await run.recorder.writeArtifact("final-review.md", "Final report");
    await run.finalize({ status: "completed_full", exitCode: 0 });

    expect(existsSync(runFilePath(attached.runDir, "review-plan.json"))).toBe(true);
    expect(existsSync(path.join(attached.runDir, "review-plan.json"))).toBe(false);
    expect(existsSync(runFilePath(attached.runDir, "packets/packet-1.json"))).toBe(true);
    expect(existsSync(path.join(attached.runDir, "packets", "packet-1.json"))).toBe(false);
    expect(existsSync(path.join(attached.runDir, "final-review.md"))).toBe(true);

    const manifest = readJson(runFilePath(attached.runDir, "artifact-manifest.json"));
    expect(manifest.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "review-plan", stage: 5, path: ARTIFACT_LOCATION["review-plan.json"] }),
      expect.objectContaining({ id: "packet:packet-1", stage: 6, path: "stages/06-packets/packets/packet-1.json" }),
      expect.objectContaining({ id: "final-review", stage: 0, path: "final-review.md" })
    ]));
  });

  it("rejects physical stage paths from public artifact writes", async () => {
    const repoRoot = tempDir();
    const run = createRunTelemetry({
      telemetryConfig: {
        ...defaultConfig.telemetry,
        enabled: true
      },
      idFactory: () => "reject-physical-artifact-paths"
    });
    await run.attachRunDirectory(repoRoot);

    await expect(run.recorder.writeArtifact("stages/05-planner/review-plan.json", {}))
      .rejects.toThrow("unknown run artifact path");
  });

  it("keeps the canonical artifact partition exhaustive and one-to-one", () => {
    const logicalNames = Object.keys(ARTIFACT_LOCATION);
    const physicalPaths = Object.values(ARTIFACT_LOCATION);
    expect(new Set(logicalNames).size).toBe(logicalNames.length);
    expect(new Set(physicalPaths).size).toBe(physicalPaths.length);
    expect([...KNOWN_ARTIFACTS].sort()).toEqual(logicalNames.sort());
    expect(KNOWN_ARTIFACTS.has("review-questions.json")).toBe(false);
  });

  function collectTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...collectTsFiles(full));
      } else if (entry.name.endsWith(".ts")) {
        out.push(full);
      }
    }
    return out;
  }

  it("registers every writeArtifact() literal call site in KNOWN_ARTIFACTS", () => {
    const callSiteRe = /writeArtifact\(\s*["'`]([^"'`]+)["'`]/g;
    const unregistered: Array<{ file: string; artifact: string }> = [];
    for (const file of collectTsFiles(srcDir)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(callSiteRe)) {
        const artifact = match[1];
        if (artifact === undefined) {
          continue;
        }
        if (!KNOWN_ARTIFACTS.has(artifact) && !/^packets\/[^/]+\.json$/.test(artifact)) {
          unregistered.push({ file: path.relative(srcDir, file), artifact });
        }
      }
    }
    expect(unregistered).toEqual([]);
  });
});

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "codegenie-"));
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

function runFilePath(runDir: string, relPath: string): string {
  return path.join(runDir, KNOWN_ARTIFACTS.has(relPath) || /^packets\/[^/]+\.json$/u.test(relPath)
    ? canonicalArtifactPath(relPath)
    : relPath);
}

function readJson(filePath: string): any {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readJsonl(filePath: string): any[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}
