import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeEvalCohort,
  analyzeRegressionCohorts,
  analyzeReplayComparison,
  computeProductionEconomics,
  finalizeReplayCleanup,
  historicalFlagOffParityView,
  reconstructEvidenceArtifacts,
  runPacketPackingReportCli,
  selectExplicitCohort,
  validateRecordedDiffParity,
  validatePacketPackingArtifact,
  validateReplayArtifacts,
  type CohortSelection,
  type EvalCaseRunInput,
  type EvalExecutionInput,
  type ReplayAnalysisInput,
  type ReportFailure
} from "../scripts/packet-packing-report.js";
import { aggregateRepeatScores, scoreEvalRun } from "../src/evals/eval-scoring.js";
import { defaultConfig } from "../src/config/schema.js";
import {
  reconstructComposerGroupsFromArtifacts,
  reconstructComposerPolicyFromArtifacts
} from "../src/pipeline/composer.js";
import {
  reconstructVerificationGateFactsFromArtifacts,
  reconstructVerifiedFindingsFromArtifacts
} from "../src/pipeline/verifier.js";
import { createRunTelemetry, reconstructRunTelemetryDerivedEvidence } from "../src/telemetry/run-artifacts.js";
import type {
  CandidateFinding,
  EvalArtifacts,
  EvalCase,
  EvalExpectationResult,
  EvalInvocationManifest,
  EvalRunInfo,
  EvalScore,
  FileFacts,
  FinalFinding,
  ReviewPacket,
  ReviewPlan,
  TelemetryEvent,
  ToolBudget,
  UnifiedDiff
} from "../src/types.js";
import { sha256Hex } from "../src/util/hashing.js";

const tempDirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const standardBudget: ToolBudget = {
  maxToolCalls: 4,
  maxInvestigationRounds: 2,
  maxResultChars: 10_000
};

function packet(
  id: string,
  hunkIds: string[],
  overrides: Partial<ReviewPacket> = {}
): ReviewPacket {
  const hunks = hunkIds.map((hunkId, index) => ({
    // Synthetic atoms and their packed form must describe the same source
    // coordinates. Derive the coordinate from canonical hN fixture IDs so a
    // separately constructed h2 does not collide with h1 at line 1.
    ...(() => {
      const match = /(\d+)$/u.exec(hunkId);
      const sourceIndex = match === null ? index : Number(match[1]) - 1;
      const line = sourceIndex * 100 + 1;
      return {
        oldStart: line,
        newStart: line,
        contentWithLineNumbers: `${"".padStart(4)} ${String(line).padStart(4)} +change${sourceIndex}`,
        lines: [{ kind: "add" as const, content: `change${sourceIndex}`, newLine: line }],
        changedNewLineNumbers: [line]
      };
    })(),
    hunkId,
    oldLines: 1,
    newLines: 1,
    changedOldLineNumbers: []
  }));
  return {
    id,
    dispatchRank: [0, -hunks.length],
    kind: hunks.length === 1 ? "hunk" : "coalesced-hunks",
    prSummary: "test",
    path: "app.ts",
    fileStatus: "modified",
    isDeletedContent: false,
    language: "typescript",
    reviewPriority: "normal",
    coverage: "normal",
    reviewProfile: "standard",
    lenses: ["core/code-review", "lang/typescript"],
    hunks,
    symbolFacts: [],
    context: { path: "app.ts" },
    contextText: "context",
    contextQuality: "full",
    relevantTests: [],
    surroundingContextHints: [],
    labels: [],
    attentionNotes: [],
    relatedChangedContext: [],
    toolBudget: structuredClone(standardBudget),
    ...overrides
  };
}

function diffForPackets(packets: ReviewPacket[]): UnifiedDiff {
  const hunks = packets.flatMap((target) => target.hunks.map((hunk) => ({
    id: hunk.hunkId,
    hunkHash: sha256Hex(hunk.hunkId),
    path: target.path,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    header: hunk.header ?? "",
    lines: hunk.lines.map((line) => ({
      kind: line.kind,
      content: line.content,
      ...(line.oldLine === undefined ? {} : { oldLineNumber: line.oldLine }),
      ...(line.newLine === undefined ? {} : { newLineNumber: line.newLine })
    }))
  })));
  return {
    files: [{ path: "app.ts", status: "modified", language: "typescript", hunks }]
  };
}

function atomId(hunkIds: string[]): string {
  return sha256Hex(`hunk-first\n${hunkIds.join("\n")}`);
}

function packingEvent(
  target: ReviewPacket,
  atoms: ReviewPacket[],
  overrides: Record<string, unknown> = {}
): TelemetryEvent {
  const profiles = atoms.map((atom) => atom.reviewProfile);
  const profileFloor = profiles.includes("investigate") ? "investigate" : profiles.includes("standard") ? "standard" : "simple";
  return {
    runId: "eval-run",
    eventId: `event-${target.id}`,
    timestamp: "2026-07-24T00:00:00.000Z",
    stage: 6,
    level: "info",
    message: "same_file_atoms_packed",
    file: target.path,
    data: {
      packetId: target.id,
      atomIds: atoms.map((atom) => atomId(atom.hunks.map((hunk) => hunk.hunkId))),
      standaloneProfiles: profiles,
      sourceAtomCount: atoms.length,
      hunkCount: target.hunks.length,
      effectiveCoverage: target.coverage,
      requestedLensSignature: JSON.stringify(["core/code-review"]),
      capUsage: {
        hunks: target.hunks.length,
        maxHunks: 5,
        patchChars: target.hunks.reduce((total, hunk) => total + hunk.contentWithLineNumbers.length, 0),
        maxPatchChars: 12_000
      },
      derivedPackedProfile: target.reviewProfile,
      profileFloor,
      effectiveProfile: target.reviewProfile,
      profileFloorApplied: false,
      plannerLensesPreserved: true,
      toolBudgetMode: "base",
      baseToolBudget: standardBudget,
      effectiveToolBudget: target.toolBudget,
      ...overrides
    }
  };
}

function replayFixture(): ReplayAnalysisInput {
  const first = packet("off-1", ["h1"]);
  const second = packet("off-2", ["h2"]);
  const combined = packet("on-1", ["h1", "h2"]);
  const diff: UnifiedDiff = {
    files: [{
      path: "app.ts",
      status: "modified",
      language: "typescript",
      hunks: [
        {
          id: "h1",
          hunkHash: "hash1",
          path: "app.ts",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          header: "@@ -1 +1 @@",
          lines: [{ kind: "add", content: "change0", newLineNumber: 1 }]
        },
        {
          id: "h2",
          hunkHash: "hash2",
          path: "app.ts",
          oldStart: 101,
          oldLines: 1,
          newStart: 101,
          newLines: 1,
          header: "@@ -101 +101 @@",
          lines: [{ kind: "add", content: "change1", newLineNumber: 101 }]
        }
      ]
    }]
  };
  const facts: FileFacts[] = [{
    path: "app.ts",
    language: "typescript",
    processingMode: "per-hunk",
    testStatus: "source",
    isGenerated: false,
    isVendored: false,
    isLockfile: false,
    isBinary: false,
    changedLines: 2,
    hunkCount: 2,
    labels: [],
    reviewPriority: "normal",
    reasons: [],
    provenance: []
  }];
  const plan: ReviewPlan = {
    diffUnderstanding: { declaredIntent: "test", inferredBehavior: "test" },
    coverage: [
      { hunkId: "h1", path: "app.ts", coverage: "normal", lenses: ["core/code-review"], surroundingContextHints: [], reason: "test" },
      { hunkId: "h2", path: "app.ts", coverage: "normal", lenses: ["core/code-review"], surroundingContextHints: [], reason: "test" }
    ]
  };
  return {
    runId: "retained-run",
    recordedPackets: [first, second],
    offPackets: [first, second],
    onPackets: [combined],
    onEvents: [packingEvent(combined, [first, second])],
    fileFacts: facts,
    diff,
    plan,
    expectedRefs: { base: "a".repeat(40), head: "b".repeat(40) },
    actualRefs: { base: "a".repeat(40), head: "b".repeat(40) }
  };
}

function failureCodes(failures: ReportFailure[]): string[] {
  return failures.map((entry) => entry.code);
}

describe("packet packing replay analysis", () => {
  it("reports packet shape, profile provenance, caps, and dispatch movement", () => {
    const report = analyzeReplayComparison(replayFixture());
    expect(report.failures).toEqual([]);
    expect(report).toMatchObject({
      offPackets: 2,
      onPackets: 1,
      sourceAtoms: 2,
      packedMultiAtomPackets: 1,
      reviewableHunks: 2,
      newCoveragePromotions: 0,
      capViolations: 0,
      effectiveProfileDowngrades: 0,
      effectiveBudgetDowngrades: 0,
      invalidDispatchRanks: 0
    });
    expect(report.packetMembership[0]?.atomIds).toEqual([atomId(["h1"]), atomId(["h2"])]);
  });

  it("fails closed on stale refs and flag-off artifact drift", () => {
    const input = replayFixture();
    input.actualRefs = { ...input.actualRefs!, head: "c".repeat(40) };
    input.recordedPackets[0] = { ...input.recordedPackets[0]!, contextText: "recorded-only" };
    const report = analyzeReplayComparison(input);
    expect(failureCodes(report.failures)).toEqual(expect.arrayContaining(["stale_replay_refs", "flag_off_parity"]));
  });

  it("never includes proprietary source text in parity failures and rejects replay model calls", () => {
    const proprietary = "PROPRIETARY_SOURCE_NEVER_REPORT_THIS";
    const input = replayFixture();
    input.recordedPackets[0] = { ...input.recordedPackets[0]!, contextText: proprietary };
    input.modelCallsObserved = 1;
    const report = analyzeReplayComparison(input);
    expect(failureCodes(report.failures)).toEqual(expect.arrayContaining(["flag_off_parity", "replay_model_call"]));
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(proprietary);
    expect(serialized).toContain("sha256");
  });

  it("fails closed when replay cleanup cannot remove its worktree", async () => {
    let tempCleanupCalled = false;
    await expect(finalizeReplayCleanup(
      "retained-run",
      true,
      async () => { throw new Error("worktree busy"); },
      async () => { tempCleanupCalled = true; },
      async () => false
    )).rejects.toThrow(/failed to remove replay worktree/u);
    expect(tempCleanupCalled).toBe(true);
  });

  it("unconditionally cleans and verifies a partially-added worktree", async () => {
    let removalAttempted = false;
    let tempCleanupCalled = false;
    await expect(finalizeReplayCleanup(
      "partial-worktree-add",
      true,
      async () => { removalAttempted = true; throw new Error("not registered"); },
      async () => { tempCleanupCalled = true; },
      async () => true
    )).resolves.toBeUndefined();
    expect(removalAttempted).toBe(true);
    expect(tempCleanupCalled).toBe(true);
  });

  it("admits only the pinned pre-Plan100 dispatch-rank artifact migration", () => {
    const input = replayFixture();
    input.runId = "20260724-150405-fe1548ae";
    input.recordedPackets = structuredClone(input.recordedPackets);
    for (const packet of input.recordedPackets) {
      delete (packet as Partial<ReviewPacket>).dispatchRank;
    }
    const parity = historicalFlagOffParityView(input.runId, input.recordedPackets, input.offPackets);
    input.flagOffParityPackets = parity.packets;
    input.flagOffParityMigrations = parity.migrations;
    const report = analyzeReplayComparison(input);
    expect(failureCodes(report.failures)).not.toContain("flag_off_parity");
    expect(report.flagOffParityDifferences.historicalMigrations).toEqual([
      expect.objectContaining({ code: "pre_plan100_dispatch_rank_schema", packets: 2 })
    ]);

    input.recordedPackets[0]!.contextText = "unrecognized historical drift";
    expect(failureCodes(analyzeReplayComparison(input).failures)).toContain("flag_off_parity");
  });

  it("admits the legacy diff schema for exactly the three retained run IDs", () => {
    const rebuilt = replayFixture().diff;
    const legacy = structuredClone(rebuilt);
    for (const hunk of legacy.files.flatMap((file) => file.hunks)) {
      delete (hunk as Partial<typeof hunk>).hunkHash;
    }
    expect(() => validateRecordedDiffParity("20260724-135818-740d73f2", legacy, rebuilt)).not.toThrow();
    expect(() => validateRecordedDiffParity("20260724-000000-unknown000", legacy, rebuilt)).toThrow(/not allowlisted/u);
  });

  it("fails closed on hunk loss, atom reorder, caps, and coverage promotion", () => {
    const input = replayFixture();
    const reversed = packet("bad-on", ["h2", "h1"], { coverage: "deep" });
    input.onPackets = [reversed];
    input.onEvents = [packingEvent(reversed, [input.offPackets[0]!, input.offPackets[1]!], {
      effectiveCoverage: "deep",
      capUsage: { hunks: 6, maxHunks: 5, patchChars: 12_001, maxPatchChars: 12_000 }
    })];
    const report = analyzeReplayComparison(input);
    expect(JSON.stringify(report)).not.toContain("inspect critical boundary");
    expect(failureCodes(report.failures)).toEqual(expect.arrayContaining([
      "source_order",
      "atom_split_or_reorder",
      "packet_cap",
      "coverage_promotion"
    ]));

    const lost = replayFixture();
    lost.onPackets = [lost.onPackets[0] = packet("lost", ["h1"])];
    lost.onEvents = [packingEvent(lost.onPackets[0]!, [lost.offPackets[0]!])];
    expect(failureCodes(analyzeReplayComparison(lost).failures)).toContain("hunk_bijection");
  });

  it("derives eligible-packet patch size from the diff and enforces complete packet source order", () => {
    const falseCap = replayFixture();
    const falseCapEvent = falseCap.onEvents[0]!;
    falseCapEvent.data = {
      ...falseCapEvent.data,
      capUsage: { ...(falseCapEvent.data!.capUsage as object), patchChars: 1 }
    };
    const capReport = analyzeReplayComparison(falseCap);
    expect(failureCodes(capReport.failures)).toContain("packet_cap");
    expect(capReport.distribution.maxEligiblePackingPatchChars).toBeGreaterThan(1);

    const reordered = replayFixture();
    reordered.onPackets = [reordered.offPackets[1]!, reordered.offPackets[0]!];
    reordered.onEvents = [];
    expect(failureCodes(analyzeReplayComparison(reordered).failures)).toContain("source_packet_order");
  });

  it("fails closed on lens/focus/context/profile/budget/rank regressions", () => {
    const input = replayFixture();
    input.offPackets[0] = {
      ...input.offPackets[0]!,
      reviewPriority: "high",
      coverage: "deep",
      reviewProfile: "investigate",
      attentionNotes: ["inspect critical boundary"],
      toolBudget: { ...standardBudget, maxToolCalls: 6, maxResultChars: 12_000 }
    };
    input.recordedPackets = structuredClone(input.offPackets);
    input.onPackets[0] = {
      ...input.onPackets[0]!,
      coverage: "deep",
      reviewProfile: "standard",
      lenses: ["core/code-review"],
      contextQuality: "path_only",
      dispatchRank: [0, -99]
    };
    input.onEvents = [packingEvent(input.onPackets[0]!, input.offPackets, {
      standaloneProfiles: ["investigate", "standard"],
      effectiveCoverage: "deep",
      profileFloor: "investigate",
      effectiveProfile: "standard",
      baseToolBudget: standardBudget,
      effectiveToolBudget: { ...standardBudget, maxToolCalls: 2 }
    })];
    const report = analyzeReplayComparison(input);
    expect(failureCodes(report.failures)).toEqual(expect.arrayContaining([
      "planner_lens_drop",
      "high_priority_focus_omitted",
      "deep_context_downgrade",
      "effective_profile_downgrade",
      "effective_budget_downgrade",
      "invalid_dispatch_rank"
    ]));
  });

  it("rejects motivating counts outside the bounded 74/75/76 reconciliation", () => {
    const input = replayFixture();
    input.runId = "20260724-184952-dca8d870";
    const report = analyzeReplayComparison(input);
    expect(failureCodes(report.failures)).toEqual(expect.arrayContaining(["motivating_off_count", "unpermitted_packet_count"]));
  });

  it("writes a fail-closed report for corrupt retained-run artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "packet-report-corrupt-"));
    tempDirs.push(root);
    const run = path.join(root, "bad-run");
    await mkdir(path.join(run, "stages", "01-input"), { recursive: true });
    await writeFile(path.join(run, "stages", "01-input", "resolved-input.json"), "{not-json\n");
    const output = path.join(root, "report.json");
    const exitCode = await runPacketPackingReportCli(["replay", "--repo", process.cwd(), "--run", run, "--output", output]);
    expect(exitCode).toBe(1);
    const report = JSON.parse(await readFile(output, "utf8")) as { failures: ReportFailure[] };
    expect(failureCodes(report.failures)).toContain("corrupt_artifact");
  });

  it("rejects unknown artifact fields and disagreement across replay refs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "packet-report-schema-"));
    tempDirs.push(root);
    const run = path.join(root, "strict-run");
    await mkdir(path.join(run, "stages", "01-input"), { recursive: true });
    await writeFile(path.join(run, "stages", "01-input", "resolved-input.json"), JSON.stringify({
      mode: "head",
      repoRoot: process.cwd(),
      baseRef: "a".repeat(40),
      headRef: "b".repeat(40),
      commits: [],
      rawDiffChars: 0,
      unexpected: "PROPRIETARY_ARTIFACT_VALUE"
    }));
    const output = path.join(root, "report.json");
    expect(await runPacketPackingReportCli(["replay", "--repo", process.cwd(), "--run", run, "--output", output])).toBe(1);
    const schemaReport = JSON.parse(await readFile(output, "utf8")) as { failures: ReportFailure[] };
    expect(failureCodes(schemaReport.failures)).toContain("corrupt_artifact_schema");
    expect(await readFile(output, "utf8")).not.toContain("PROPRIETARY_ARTIFACT_VALUE");

    const replay = replayFixture();
    expect(() => validateReplayArtifacts(
      "retained-run",
      {
        mode: "head",
        repoRoot: process.cwd(),
        baseRef: "a".repeat(40),
        headRef: "b".repeat(40),
        commits: [],
        rawDiffChars: 0
      },
      replay.diff,
      [{ path: "app.ts", action: "keep", reason: "test", provenance: [] }],
      replay.fileFacts,
      replay.plan,
      {
        runId: "retained-run",
        mode: "head",
        depth: "normal",
        target: { baseRef: "c".repeat(40), headRef: "b".repeat(40) },
        commits: [],
        policyFilesChanged: [],
        hunkIndex: [],
        files: [],
        directories: [],
        filterSummary: { keptFiles: 1, skippedFiles: 0, skipped: [] },
        lenses: [],
        totals: { files: 1, keptFiles: 1, hunks: 2, addedLines: 2, deletedLines: 0 },
        compaction: {} as never
      },
      { runId: "retained-run" }
    )).toThrow(/disagree on base\/head refs/u);
  });

  it("fails closed at every packet/eval telemetry artifact schema boundary", () => {
    for (const kind of [
      "packet", "event", "model-call", "tool-call", "coverage", "eval-info", "attention", "human-attention",
      "budget-summary", "cost-profile", "model-summary", "tool-summary", "run-summary", "telemetry-summary"
    ] as const) {
      expect(() => validatePacketPackingArtifact(kind, { unexpected: true }), kind).toThrow(/invalid .* artifact/u);
    }

    const target = packet("strict-packet", ["h1", "h2"]);
    const event = packingEvent(target, [packet("strict-a", ["h1"]), packet("strict-b", ["h2"])]);
    (event.data as Record<string, unknown>).unexpected = true;
    expect(() => validatePacketPackingArtifact("event", event)).toThrow(/invalid event artifact/u);

    const nestedCase = evalRun("strict", "A", 1, [execution("A", 1)]).info;
    (nestedCase.caseSnapshot.review as Record<string, unknown>).unexpected = true;
    expect(() => validatePacketPackingArtifact("eval-info", nestedCase)).toThrow(/invalid eval-info artifact/u);

    const toolCall = {
      runId: "run",
      toolCallId: "tool-call",
      timestamp: "2026-07-24T00:00:00.000Z",
      stage: 7,
      initiator: "model",
      tool: "read_file",
      args: { path: "app.ts", maxResults: 40 },
      backend: "text",
      precision: "exact",
      degraded: false,
      resultChars: 1,
      durationMs: 1,
      status: "ok"
    };
    expect(() => validatePacketPackingArtifact("tool-call", toolCall)).not.toThrow();
    expect(() => validatePacketPackingArtifact("tool-call", {
      ...toolCall,
      args: { ...toolCall.args, unexpected: "nested" }
    })).toThrow(/invalid tool-call artifact/u);
  });

  it("accepts current producer-shaped model, tool, cost, run, and telemetry summaries", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "packet-report-summary-producer-"));
    tempDirs.push(repoRoot);
    const run = createRunTelemetry({
      telemetryConfig: { ...defaultConfig.telemetry, enabled: true, logLevel: "debug" },
      idFactory: () => "20260725-000000-report-summary"
    });
    const attached = await run.attachRunDirectory(repoRoot);
    run.recorder.event({ stage: 10, level: "info", message: "stage_started", cacheStatus: "write" });
    run.recorder.recordModelCall({
      callId: "summary-call", stage: 10, role: "composer", model: "model", provider: "provider", kind: "initial", attempt: 1,
      promptChars: 12, promptHash: "prompt", outputChars: 5, outputHash: "output", inputTokens: 10, outputTokens: 2,
      reasoningTokens: 1, totalTokens: 13, costUSD: 0.01, durationMs: 10, cacheStatus: "miss", schemaValid: false,
      stopReason: "submit", status: "schema_invalid", errorCode: "llm_schema_invalid"
    });
    run.recorder.event({
      stage: 10, level: "info", message: "schema_invalid_submit_recovered",
      data: { submitTool: "submit_composition", invalidSubmitCallCount: 1 }
    });
    run.recorder.recordToolCall({
      stage: 7, initiator: "harness", tool: "read_file", args: { path: "app.ts" }, backend: "text", precision: "exact",
      degraded: false, cacheStatus: "write", backendExecuted: true, resultChars: 10, durationMs: 2, status: "ok"
    });
    run.recorder.event({ stage: 10, level: "info", message: "stage_completed" });
    await run.finalize({ status: "completed_full", exitCode: 0 });
    for (const [kind, filename] of [
      ["model-summary", "stages/00-run/model-calls-summary.json"],
      ["tool-summary", "stages/00-run/tool-calls-summary.json"],
      ["cost-profile", "stages/00-run/cost-profile.json"],
      ["run-summary", "run.json"],
      ["telemetry-summary", "telemetry.json"]
    ] as const) {
      const value = JSON.parse(await readFile(path.join(attached.runDir, filename), "utf8")) as unknown;
      expect(() => validatePacketPackingArtifact(kind, value), kind).not.toThrow();
    }
  });

  it("persists raw evidence for nonzero buffered log overflow", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "packet-report-log-overflow-"));
    tempDirs.push(repoRoot);
    const run = createRunTelemetry({
      telemetryConfig: { ...defaultConfig.telemetry, enabled: true, logLevel: "debug" },
      idFactory: () => "20260725-000000-log-overflow"
    });
    for (let index = 0; index < 1_010; index += 1) {
      run.logger.debug({ runId: run.recorder.runId, stage: 0, event: "buffered", message: `buffered ${index}` });
    }
    const attached = await run.attachRunDirectory(repoRoot);
    await run.finalize({ status: "completed_full", exitCode: 0 });
    const events = (await readFile(path.join(attached.runDir, "events.jsonl"), "utf8"))
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as TelemetryEvent);
    const derived = reconstructRunTelemetryDerivedEvidence(events, []);
    const summary = JSON.parse(await readFile(path.join(attached.runDir, "telemetry.json"), "utf8")) as {
      logs: { bufferedOverflow: { droppedDebugInfo: number; droppedWarnError: number } };
    };
    expect(derived.logOverflow.droppedDebugInfo).toBeGreaterThan(0);
    expect(derived.logOverflow).toEqual(summary.logs.bufferedOverflow);
  });
});

function evalCase(family: string, arm: "A" | "B" | "C", repeat: number): EvalCase {
  const suffix = arm.toLowerCase();
  return {
    name: `${family}-${suffix}`,
    repeat,
    repo: { fixture: `repos/${family}` },
    review: {
      depth: "normal",
      lenses: ["core/code-review"],
      cache: false,
      packSameFileHunks: arm !== "A",
      packedToolBudgetMode: arm === "C" ? "atom-scaled" : "base"
    },
    should_find: [{ id: "bug", path: "app.ts", lineRange: [1, 1], titlePattern: "boundary" }]
  };
}

function expectation(hit: boolean, loss: EvalExpectationResult["loss"] = undefined): EvalExpectationResult {
  return {
    expectationId: "bug",
    list: "should_find",
    tier: "required",
    status: hit ? "pass" : "fail",
    fromReplayedArtifacts: false,
    matched: hit ? [{ findingId: "finding", artifact: "final-findings" }] : [],
    ...(loss === undefined ? {} : { loss })
  };
}

function score(hit: boolean, cost: number | undefined = 1, lossLabel = "missed-before-candidate-generation"): EvalScore {
  const loss = hit ? undefined : {
    label: lossLabel as "missed-before-candidate-generation",
    nearestInstances: []
  };
  return {
    status: hit ? "pass" : "fail",
    expectationResults: [expectation(hit, loss)],
    budgetResults: cost === undefined ? [] : [{
      check: "maxCostUSD",
      status: "pass",
      actual: cost,
      limit: 100,
      direction: "maximum"
    }],
    violations: [],
    nearViolations: [],
    metrics: {
      reportedFindings: hit ? 1 : 0,
      inlineFindings: hit ? 1 : 0,
      summaryOnlyFindings: 0,
      suppressedFindings: 0,
      candidateFindings: hit ? 1 : 0,
      duplicateGroups: 0,
      ...(cost === undefined ? {} : { costUSD: cost }),
      stageLossCounts: {
        "missed-before-candidate-generation": hit ? 0 : 1,
        "lost-at-verification": 0,
        "lost-at-composition": 0,
        "partial-match": 0
      }
    }
  };
}

function modelCall(packetId: string, repeat: number, costUSD = 0.1) {
  return {
    callId: `call-${packetId}-${repeat}`,
    runId: "eval",
    stage: 7 as const,
    role: "packetReview" as const,
    model: "fake",
    provider: "fake",
    packetId,
    kind: "initial" as const,
    attempt: 1,
    promptChars: 100,
    promptHash: "hash",
    outputChars: 10,
    outputHash: "hash",
    inputTokens: 100,
    outputTokens: 10,
    reasoningTokens: 0,
    totalTokens: 110,
    costUSD,
    durationMs: 1000,
    cacheStatus: "disabled" as const,
    stopReason: "submit" as const,
    status: "ok" as const
  };
}

function candidateFinding(id: string, packetId: string, hunkId: string, line = 1): CandidateFinding {
  return {
    id,
    title: "Boundary bug",
    severity: "medium",
    confidence: "medium",
    path: "app.ts",
    anchor: { path: "app.ts", line, side: "RIGHT", hunkId },
    anchorSource: "model",
    modelAnchorSubmitted: true,
    changedLine: true,
    category: "correctness",
    evidence: { changedCode: "+change" },
    failureMode: "The boundary behavior is incorrect.",
    whyThisMatters: "The changed code produces an incorrect result.",
    verification: "The changed line demonstrates the failure.",
    producedBy: { kind: "packet", stage: 7, packetId, lensId: "core/code-review", skillIds: ["core/code-review"] }
  };
}

function finalFinding(candidate: CandidateFinding, publication: FinalFinding["publication"] = "inline"): FinalFinding {
  return {
    ...structuredClone(candidate),
    fingerprint: `fingerprint-${candidate.id}`,
    finalBody: candidate.failureMode,
    publication,
    mergedCandidateIds: [candidate.id],
    mergedAnchors: candidate.anchor === undefined ? [] : [structuredClone(candidate.anchor)]
  };
}

function findingEvidence(candidate: CandidateFinding | undefined): Pick<EvalExecutionInput, "candidateFindings" | "verification" | "finalSelection" | "finalFindings"> {
  if (candidate === undefined) {
    return { candidateFindings: [], verification: [], finalSelection: [], finalFindings: [] };
  }
  return {
    candidateFindings: [candidate],
    verification: [{
      candidateId: candidate.id,
      gate: "passed",
      gateDecision: "scheduled",
      gateReason: "meets_confidence_threshold",
      verificationLane: "standard",
      gateFacts: {
        anchorSource: "model",
        category: candidate.category,
        changedLine: true,
        confidence: candidate.confidence,
        failureModeConcrete: true,
        hasChangedCode: true,
        hasFailureMode: true,
        modelAnchorSubmitted: true,
        modelAnchorValid: true,
        relatedEvidenceCount: 0,
        severity: candidate.severity,
        validAnchorPresent: true
      },
      verdict: {
        candidateId: candidate.id,
        verdict: "keep",
        reason: "evidence confirmed",
        requiredEvidencePresent: true,
        falsePositiveRisk: "low"
      }
    }],
    finalSelection: [{ findingId: candidate.id, decision: "published", reason: "composer-selected" }],
    finalFindings: [finalFinding(candidate)]
  };
}

function executionArtifacts(execution: EvalExecutionInput): EvalArtifacts {
  const existing = execution.scoringArtifacts as EvalArtifacts | undefined;
  const persisted = {
    ...existing,
    candidates: execution.candidateFindings,
    verification: execution.verification,
    finalSelection: execution.finalSelection,
    finalFindings: execution.finalFindings,
    packets: execution.packets,
    hintEvents: existing?.hintEvents ?? [],
    reviewPlan: execution.plan,
    metricsSources: {
      ...existing?.metricsSources,
      modelCalls: execution.modelCalls,
      toolCalls: execution.toolCalls,
      costProfile: { totalCostUSD: execution.modelCalls.reduce((total, call) => total + (call.costUSD ?? 0), 0) },
      runJson: { durationMs: execution.wallTimeSeconds * 1000 }
    }
  } as EvalArtifacts;
  return reconstructEvidenceArtifacts({ ...execution, scoringArtifacts: persisted });
}

function refreshExecutionEvidence(execution: EvalExecutionInput, policyConfig: typeof defaultConfig = defaultConfig): void {
  const candidateById = new Map(execution.candidateFindings.map((candidate) => [candidate.id, candidate]));
  const packetById = new Map(execution.packets.map((packet) => [packet.id, packet]));
  execution.verification = execution.verification.map((record) => {
    const candidateId = "verdict" in record && record.duplicateOf !== undefined
      ? record.duplicateOf
      : record.candidateId;
    const candidate = candidateById.get(candidateId);
    if (candidate === undefined) {
      return record;
    }
    return {
      ...record,
      gateFacts: reconstructVerificationGateFactsFromArtifacts(
        candidate,
        packetById.get(candidate.producedBy.packetId),
        execution.diff
      )
    };
  });
  const verified = reconstructVerifiedFindingsFromArtifacts(execution.candidateFindings, execution.verification, execution.packets, execution.diff);
  const composer = reconstructComposerGroupsFromArtifacts(verified, execution.packets);
  const publishableById = new Map(composer.publishable.map((finding) => [finding.id, finding]));
  const selectionById = new Map(execution.finalSelection.map((record) => [record.findingId, record]));
  const downgradeReasons = new Set(["min-inline-confidence", "soft-comment-cap", "unanchorable"]);
  const suppressionReasons = new Set(["severity-threshold", "confidence-threshold", "report-cap"]);
  const drafts = execution.finalFindings.map((finding) => {
    const selections = finding.mergedCandidateIds.flatMap((id) => selectionById.get(id) ?? []);
    const isPretrimmed = finding.mergedCandidateIds.some((id) => composer.pretrimSuppressedIds.includes(id));
    const hasDowngrade = selections.some((selection) => downgradeReasons.has(selection.reason));
    const hasPolicyReason = hasDowngrade || selections.some((selection) => suppressionReasons.has(selection.reason));
    return {
      mergedFindings: finding.mergedCandidateIds.flatMap((id) => publishableById.get(id) ?? []),
      finalBody: finding.finalBody,
      requestedPublication: isPretrimmed
        ? "suppressed" as const
        : finding.publication === "inline" || hasDowngrade ? "inline" as const : finding.publication,
      baseSelection: finding.mergedCandidateIds.map((id) => isPretrimmed
        ? { findingId: id, decision: "suppressed" as const, reason: "composer-pre-trim" }
        : id === finding.id
          ? {
              findingId: id,
              decision: "published" as const,
              reason: !hasPolicyReason && selectionById.get(id)?.reason === "composer_omitted_finding"
                ? "composer_omitted_finding"
                : "composer-selected"
            }
          : { findingId: id, decision: "merged" as const, reason: "composer-merged", mergedIntoFingerprint: finding.fingerprint })
    };
  });
  let policy = reconstructComposerPolicyFromArtifacts(
    drafts,
    execution.packets,
    execution.diff,
    policyConfig,
    execution.verification.flatMap((record) =>
      "verdict" in record && (policyConfig.review.verify === false || record.duplicateOf === undefined) ? [record.verdict] : []
    )
  );
  const fingerprintByCandidateId = new Map(policy.findings.flatMap((finding) =>
    finding.mergedCandidateIds.map((id) => [id, finding.fingerprint] as const)
  ));
  if (drafts.some((draft) => draft.baseSelection.some((record) => record.decision === "merged"))) {
    policy = reconstructComposerPolicyFromArtifacts(
      drafts.map((draft) => ({
        ...draft,
        baseSelection: draft.baseSelection.map((record) => record.decision === "merged"
          ? { ...record, mergedIntoFingerprint: fingerprintByCandidateId.get(record.findingId) ?? record.mergedIntoFingerprint ?? "missing" }
          : record)
      })),
      execution.packets,
      execution.diff,
      policyConfig,
      execution.verification.flatMap((record) =>
        "verdict" in record && (policyConfig.review.verify === false || record.duplicateOf === undefined) ? [record.verdict] : []
      )
    );
  }
  execution.finalFindings = policy.findings;
  execution.finalSelection = policy.selection;
  execution.finalSelectionArtifact = {
    composition: { mode: "llm" },
    records: structuredClone(policy.selection),
    publicationAnchors: structuredClone(policy.publicationAnchors),
    confidenceSelections: structuredClone(policy.confidenceSelections),
    groups: composer.groups.map(({ representativeId: _representativeId, ...group }) => group)
  };
  execution.scoringArtifacts = executionArtifacts(execution);
}

function refreshRunEvidenceScores(run: EvalCaseRunInput): void {
  const policyConfig = structuredClone(defaultConfig);
  if (run.info.effectiveConfig !== undefined) {
    policyConfig.review = { ...policyConfig.review, ...run.info.effectiveConfig.review };
  }
  for (const execution of run.executions) {
    refreshExecutionEvidence(execution, policyConfig);
    execution.score = scoreEvalRun(run.declaredCase, executionArtifacts(execution), "live");
    execution.scoringArtifacts = executionArtifacts(execution);
  }
  if (run.executions.length === 1) {
    run.info.score = run.executions[0]!.score;
    delete run.info.repeats;
    return;
  }
  const repeated = aggregateRepeatScores(run.declaredCase, run.executions.map((execution) => ({
    runDir: `repeats/${execution.repeat}`,
    score: execution.score,
    artifacts: executionArtifacts(execution)
  })));
  run.info.score = repeated.score;
  run.info.repeats = repeated.aggregate;
}

function planForHunks(hunkIds: string[]): ReviewPlan {
  return {
    diffUnderstanding: { declaredIntent: "test", inferredBehavior: "test" },
    coverage: hunkIds.map((hunkId) => ({
      hunkId,
      path: "app.ts",
      coverage: "normal" as const,
      lenses: ["core/code-review"],
      surroundingContextHints: [],
      reason: "test"
    }))
  };
}

function execution(
  arm: "A" | "B" | "C",
  repeat: number,
  options: { treated?: boolean; hit?: boolean; cost?: number | undefined; missingTelemetry?: boolean } = {}
): EvalExecutionInput {
  const first = packet(`a1-${repeat}`, ["h1"]);
  const second = packet(`a2-${repeat}`, ["h2"]);
  const treated = options.treated ?? arm !== "A";
  const packets = arm === "A" || !treated
    ? [first, second]
    : [packet(`packed-${arm}-${repeat}`, ["h1", "h2"], {
        toolBudget: arm === "C" ? { ...standardBudget, maxToolCalls: 5, maxResultChars: 12_000 } : standardBudget
      })];
  const events = arm === "A" || options.missingTelemetry === true
    ? []
    : treated
      ? [packingEvent(packets[0]!, [first, second], {
          toolBudgetMode: arm === "C" ? "atom-scaled" : "base",
          effectiveToolBudget: packets[0]!.toolBudget
        })]
      : packets.map((target, index) => packingEvent(target, [index === 0 ? first : second], {
          toolBudgetMode: arm === "C" ? "atom-scaled" : "base"
        }));
  const executionScore = score(options.hit ?? true, options.cost === undefined && "cost" in options ? undefined : options.cost ?? 1);
  const hit = options.hit ?? true;
  const calls = packets.map((target) => modelCall(target.id, repeat, (options.cost ?? 1) / packets.length));
  if ("cost" in options && options.cost === undefined) {
    for (const call of calls) {
      delete (call as Partial<typeof call>).costUSD;
    }
  }
  executionScore.metrics.modelCalls = calls.length;
  executionScore.metrics.verificationCalls = hit ? 1 : 0;
  executionScore.metrics.elapsedSeconds = 60;
  const candidate = hit ? candidateFinding("finding", packets[0]!.id, "h1") : undefined;
  const result = {
    repeat,
    score: executionScore,
    telemetryDir: `/tmp/${arm}/${repeat}`,
    packets,
    events,
    modelCalls: calls,
    toolCalls: [],
    fileFacts: [{
      path: "app.ts",
      language: "typescript",
      processingMode: "per-hunk",
      testStatus: "source",
      isGenerated: false,
      isVendored: false,
      isLockfile: false,
      isBinary: false,
      changedLines: 2,
      hunkCount: 2,
      labels: [],
      reviewPriority: "normal",
      reasons: [],
      provenance: []
    }],
    diff: diffForPackets([first, second]),
    plan: planForHunks(["h1", "h2"]),
    ...findingEvidence(candidate),
    reviewedHunkIds: ["h1", "h2"],
    wallTimeSeconds: 60
  } as unknown as EvalExecutionInput;
  refreshExecutionEvidence(result);
  return result;
}

function evalRun(
  family: string,
  arm: "A" | "B" | "C",
  runNumber: number,
  executions: EvalExecutionInput[]
): EvalCaseRunInput {
  const snapshot = evalCase(family, arm, executions.length);
  for (const entry of executions) {
    refreshExecutionEvidence(entry);
    entry.score = scoreEvalRun(snapshot, entry.scoringArtifacts, "live");
  }
  const repeated = executions.length > 1 ? aggregateRepeatScores(snapshot, executions.map((entry) => ({
    runDir: `repeats/${entry.repeat}`,
    score: entry.score,
    artifacts: executionArtifacts(entry)
  }))) : undefined;
  const info: EvalRunInfo = {
    runNumber,
    caseName: snapshot.name,
    caseFile: `${family}-${arm.toLowerCase()}.yml`,
    caseHash: `hash-${family}-${arm}`,
    caseSnapshot: snapshot,
    mode: "live",
    ...(repeated === undefined ? {} : { repeats: repeated.aggregate }),
    cache: { enabled: false, source: "case" },
    effectiveConfig: {
      review: {
        concurrency: 1,
        timeoutMs: 60_000,
        verify: true,
        maxFindings: defaultConfig.review.maxFindings,
        softCommentCap: defaultConfig.review.softCommentCap,
        minConfidence: defaultConfig.review.minConfidence,
        minInlineConfidence: defaultConfig.review.minInlineConfidence,
        packSameFileHunks: arm !== "A",
        packedToolBudgetMode: arm === "C" ? "atom-scaled" : "base"
      },
      llm: { maxConcurrentCalls: 1 }
    },
    codegenieRuntime: { packageVersion: "0.5.0", commit: "a".repeat(40), source: "git" },
    startedAt: "2026-07-24T00:00:00.000Z",
    finishedAt: "2026-07-24T00:01:00.000Z",
    score: repeated?.score ?? executions[0]?.score ?? score(true)
  };
  return { runNumber, runDir: `/logs/${runNumber}`, info, declaredCase: structuredClone(snapshot), executions };
}

async function attachProducerSummaryEvidence(run: EvalCaseRunInput): Promise<void> {
  const execution = run.executions[0]!;
  const repoRoot = await mkdtemp(path.join(tmpdir(), "packet-report-paid-summary-"));
  tempDirs.push(repoRoot);
  let clockTick = 0;
  const telemetry = createRunTelemetry({
    telemetryConfig: { ...defaultConfig.telemetry, enabled: true, logLevel: "debug" },
    idFactory: () => `paid-summary-${run.runNumber}`,
    clock: () => new Date(Date.UTC(2026, 6, 25, 0, 0, clockTick++))
  });
  const attached = await telemetry.attachRunDirectory(repoRoot);
  telemetry.recorder.event({ stage: 7, level: "info", message: "stage_started" });
  telemetry.recorder.event({
    stage: 7,
    level: "warn",
    message: "stage7_schema_repair_attempted",
    data: { classification: "candidate_payload", payloadKind: "candidate" }
  });
  telemetry.recorder.event({
    stage: 7,
    level: "info",
    message: "stage7_schema_compact_repair_scheduled",
    data: { repairPromptChars: execution.modelCalls[0]?.promptChars ?? 0 }
  });
  for (const [index, call] of execution.modelCalls.entries()) {
    const { runId: _runId, ...record } = call;
    telemetry.recorder.recordModelCall(index === 0 ? { ...record, kind: "repair" } : record);
  }
  telemetry.recorder.event({
    stage: 7,
    level: "info",
    message: "stage7_schema_repair_recovered",
    data: { classification: "schema_valid_after_retry" }
  });
  telemetry.recorder.event({ stage: 7, level: "info", message: "stage_completed" });
  const reviewedHunks = execution.reviewedHunkIds.length;
  telemetry.recorder.event({
    stage: 10,
    level: "info",
    message: "pipeline_metrics",
    data: {
      totals: {
        filesChanged: execution.diff.files.length,
        hunks: execution.diff.files.flatMap((file) => file.hunks).length,
        packets: execution.packets.length,
        packetReviews: execution.packets.length,
        candidates: execution.candidateFindings.length,
        verified: execution.verification.filter((record) => "verdict" in record && record.verdict.verdict !== "reject").length,
        finalFindings: execution.finalFindings.length,
        postedComments: 0
      },
      workers: { started: 2, completed: 2, failed: 0, retried: 0, timedOut: 0 },
      packets: { generated: execution.packets.length, reviewed: execution.packets.length, failed: 0, degraded: 0 },
      lenses: { selected: 1, byLens: { "core/code-review": execution.packets.length } },
      coverage: {
        byLevel: { deep: 0, normal: reviewedHunks, light: 0, skip: 0 },
        hunks: { total: reviewedHunks, reviewed: reviewedHunks, skipped: 0, failed: 0, degraded: 0 }
      },
      candidates: {
        generated: execution.candidateFindings.length,
        gateRejected: 0,
        verificationScheduled: execution.verification.length,
        verificationBudgetLimited: 0,
        clusteredDuplicates: 0,
        verificationRepresentatives: execution.verification.length,
        lowConfidenceSuppressed: 0,
        lowConfidenceEvidenceEligible: 0,
        lowConfidenceEvidenceScheduled: 0,
        lowConfidenceEvidenceLaneLimited: 0,
        lowConfidenceEvidenceKept: 0,
        lowConfidenceEvidenceRejected: 0,
        lowConfidenceEvidenceIncomplete: 0
      },
      verdicts: { accept: execution.verification.length, revise: 0, reject: 0, incomplete: 0 },
      dedup: { clusters: execution.finalFindings.length, duplicates: 0, suppressed: 0 },
      finalSelection: {
        published: execution.finalSelection.filter((record) => record.decision === "published").length,
        merged: execution.finalSelection.filter((record) => record.decision === "merged").length,
        suppressed: execution.finalSelection.filter((record) => record.decision === "suppressed").length,
        finalFindings: execution.finalFindings.length,
        compositionMode: "llm"
      },
      posting: { attempted: 0, postedComments: 0, skippedDuplicates: 0, failed: 0 }
    }
  });
  await telemetry.finalize({ status: "completed_full", exitCode: 0 });
  const readJson = async (relative: string): Promise<unknown> => JSON.parse(await readFile(path.join(attached.runDir, relative), "utf8"));
  const readJsonl = async (relative: string): Promise<unknown[]> => (await readFile(path.join(attached.runDir, relative), "utf8"))
    .trim().split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as unknown);
  execution.events = await readJsonl("events.jsonl") as TelemetryEvent[];
  execution.modelCalls = await readJsonl("model-calls.jsonl") as EvalExecutionInput["modelCalls"];
  execution.toolCalls = await readJsonl("tool-calls.jsonl") as EvalExecutionInput["toolCalls"];
  const runSummary = await readJson("run.json") as { startedAt: string; finishedAt: string; durationMs: number };
  const modelByStage = new Map<number, { modelCalls: number; totalTokens: number }>();
  for (const call of execution.modelCalls.filter((call) => call.cacheStatus !== "hit")) {
    const bucket = modelByStage.get(call.stage) ?? { modelCalls: 0, totalTokens: 0 };
    bucket.modelCalls += 1;
    bucket.totalTokens += call.totalTokens ?? 0;
    modelByStage.set(call.stage, bucket);
  }
  const totalTokens = execution.modelCalls.reduce((total, call) => total + (call.totalTokens ?? 0), 0);
  const totalCostUSD = execution.modelCalls.reduce((total, call) => total + (call.costUSD ?? 0), 0);
  execution.wallTimeSeconds = runSummary.durationMs / 1000;
  execution.summaryArtifacts = {
    attention: execution.packets.map((packet) => ({
      packetId: packet.id,
      path: packet.path,
      coverage: packet.coverage,
      coverageSource: "planner",
      ensemblePasses: 1,
      directCandidates: execution.candidateFindings.filter((candidate) => candidate.producedBy.packetId === packet.id && candidate.provenance === undefined).length,
      promotedCandidates: execution.candidateFindings.filter((candidate) => candidate.producedBy.packetId === packet.id && candidate.provenance !== undefined).length,
      hintsEmitted: 0,
      uncertaintiesEmitted: 0,
      keptVerified: execution.verification.filter((record) => record.candidateId === execution.candidateFindings.find((candidate) => candidate.producedBy.packetId === packet.id)?.id && "verdict" in record).length,
      published: execution.finalFindings.filter((finding) => finding.publication !== "suppressed" &&
        finding.mergedCandidateIds.some((id) => execution.candidateFindings.find((candidate) => candidate.id === id)?.producedBy.packetId === packet.id)).length
    })),
    humanAttention: [],
    budget: {
      completeness: "complete",
      partialReasons: [],
      multiplier: 1,
      configured: { timeoutMs: run.info.effectiveConfig!.review.timeoutMs },
      effective: { timeoutMs: run.info.effectiveConfig!.review.timeoutMs },
      usage: {
        modelCalls: execution.modelCalls.filter((call) => call.cacheStatus !== "hit").length,
        totalTokens,
        ...(totalCostUSD > 0 ? { costUSD: totalCostUSD } : {}),
        byStage: [...modelByStage.entries()].map(([stage, value]) => ({ stage, ...value })).sort((left, right) => left.stage - right.stage)
      },
      overruns: [],
      dispatchBlocks: []
    },
    cost: await readJson("stages/00-run/cost-profile.json"),
    model: await readJson("stages/00-run/model-calls-summary.json"),
    tool: await readJson("stages/00-run/tool-calls-summary.json"),
    run: await readJson("run.json"),
    telemetry: await readJson("telemetry.json")
  };
  run.info.reviewRunId = telemetry.recorder.runId;
  run.info.startedAt = runSummary.startedAt;
  run.info.finishedAt = runSummary.finishedAt;
  refreshRunEvidenceScores(run);
}

function attachInvocation(
  runs: EvalCaseRunInput[],
  invocationId: string,
  status: EvalInvocationManifest["status"] = "complete",
  recordedRuns = runs.length
): EvalCaseRunInput[] {
  const manifest: EvalInvocationManifest = {
    schemaVersion: 1,
    invocationId,
    suiteDir: "/suite",
    status,
    startedAt: "2026-07-24T00:00:00.000Z",
    ...(status === "complete" ? { completedAt: "2026-07-24T00:02:00.000Z" } : {}),
    cases: runs.map((run, caseIndex) => ({
      caseIndex,
      caseName: run.info.caseName,
      caseHash: run.info.caseHash,
      caseFile: run.info.caseFile ?? `${run.info.caseName}.yml`
    })),
    runs: runs.slice(0, recordedRuns).map((run, caseIndex) => ({
      caseIndex,
      caseName: run.info.caseName,
      caseHash: run.info.caseHash,
      runNumber: run.runNumber,
      logsRoot: "/logs",
      runPath: String(run.runNumber)
    }))
  };
  for (const [caseIndex, run] of runs.entries()) {
    run.runDir = `/logs/${run.runNumber}`;
    run.info.invocation = { id: invocationId, caseIndex, manifest: `invocations/${invocationId}.json` };
    run.invocationManifest = manifest;
  }
  return runs;
}

function abcCohort(
  repeat: number,
  mutate?: (arm: "A" | "B" | "C", index: number) => Partial<Parameters<typeof execution>[2]>,
  family = "dilution",
  runOffset = 0
): CohortSelection {
  const arms = (["A", "B", "C"] as const).map((arm, armIndex) => evalRun(
    family,
    arm,
    runOffset + armIndex + 1,
    Array.from({ length: repeat }, (_, index) => execution(arm, index + 1, mutate?.(arm, index) ?? {}))
  ));
  return { id: `1-${arms.length}`, runs: arms };
}

describe("packet packing eval analysis", () => {
  it("selects only the explicit latest complete cohort", () => {
    const old = attachInvocation(abcCohort(1).runs, "old-invocation");
    const latest = attachInvocation(abcCohort(1).runs.map((run) => ({ ...run, runNumber: run.runNumber + 3, info: { ...run.info, runNumber: run.runNumber + 3 } })), "latest-invocation");
    const selected = selectExplicitCohort([...old, ...latest], "latest");
    expect(selected.id).toBe("latest-invocation");
    expect(selected.runs.map((run) => run.runNumber)).toEqual([4, 5, 6]);
    expect(() => selectExplicitCohort([...old, ...attachInvocation(abcCohort(1).runs, "same-ending-run")], "3")).toThrow(/multiple persisted invocations/u);
  });

  it("ignores unselected interrupted history and accepts an exact invocation UUID", () => {
    const interrupted = attachInvocation(abcCohort(1).runs, "historical-interrupted", "running", 2).slice(0, 2);
    const invocationId = "550e8400-e29b-41d4-a716-446655440000";
    const current = attachInvocation(abcCohort(1, undefined, "dilution", 3).runs, invocationId);
    expect(selectExplicitCohort([...interrupted, ...current], "latest").id).toBe(invocationId);
    expect(selectExplicitCohort([...interrupted, ...current], invocationId).runs.map((run) => run.runNumber)).toEqual([4, 5, 6]);
  });

  it("preserves manifest caseIndex order across roots with duplicate run numbers", () => {
    const invocationId = "multi-root-order";
    const runs = attachInvocation([
      evalRun("root-a-one", "A", 1, [execution("A", 1)]),
      evalRun("root-a-two", "A", 2, [execution("A", 1)]),
      evalRun("root-b-one", "A", 1, [execution("A", 1)]),
      evalRun("root-b-two", "A", 2, [execution("A", 1)])
    ], invocationId);
    const locations = [
      { logsRoot: "/rootA", runPath: "1", runNumber: 1 },
      { logsRoot: "/rootA", runPath: "2", runNumber: 2 },
      { logsRoot: "/rootB", runPath: "1", runNumber: 1 },
      { logsRoot: "/rootB", runPath: "2", runNumber: 2 }
    ];
    const manifest = runs[0]!.invocationManifest!;
    for (const [caseIndex, run] of runs.entries()) {
      const location = locations[caseIndex]!;
      Object.assign(manifest.runs[caseIndex]!, location);
      run.runNumber = location.runNumber;
      run.info.runNumber = location.runNumber;
      run.runDir = `${location.logsRoot}/${location.runPath}`;
    }
    const selected = selectExplicitCohort([runs[3]!, runs[1]!, runs[2]!, runs[0]!], invocationId);
    expect(selected.runs.map((run) => run.runDir)).toEqual(["/rootA/1", "/rootA/2", "/rootB/1", "/rootB/2"]);
    expect(selected.runs.map((run) => run.info.invocation!.caseIndex)).toEqual([0, 1, 2, 3]);
  });

  it("rejects an explicit mixed cohort with duplicate cases", () => {
    const runs = attachInvocation([...abcCohort(1).runs, abcCohort(1).runs[0]!].map((run, index) => ({
      ...run,
      runNumber: index + 1,
      info: { ...run.info, runNumber: index + 1 }
    })), "mixed-invocation");
    expect(() => selectExplicitCohort(runs, "1-4")).toThrow(/multiple generations/u);
  });

  it("rejects an interrupted newest invocation instead of mixing it into latest", () => {
    const complete = attachInvocation(abcCohort(1).runs, "complete-invocation");
    const interrupted = attachInvocation(abcCohort(1).runs.map((run) => ({
      ...run,
      runNumber: run.runNumber + 3,
      info: { ...run.info, runNumber: run.runNumber + 3 }
    })), "interrupted-invocation", "running", 2).slice(0, 2);
    expect(() => selectExplicitCohort([...complete, ...interrupted], "latest")).toThrow(/exact ordered case set/u);
  });

  it("proves preflight treatment without selecting an arm and uses relational call cost", () => {
    const report = analyzeEvalCohort(abcCohort(1), 1);
    expect(report.failures).toEqual([]);
    expect(report.cohort.actualCostUSD).toBe(3);
    expect(report.selectedArm).toBeUndefined();
    expect(report.cases?.[0]?.arms.B.treatment).toMatchObject({ treated: 1, total: 1, valid: true });

    const fallback = abcCohort(1);
    delete fallback.runs[0]!.executions[0]!.score.metrics.costUSD;
    expect(analyzeEvalCohort(fallback, 1).cohort.actualCostUSD).toBe(3);

    const failedFallback = abcCohort(1);
    delete failedFallback.runs[0]!.executions[0]!.modelCalls[0]!.costUSD;
    expect(failureCodes(analyzeEvalCohort(failedFallback, 1).failures)).toContain("missing_spend_data");
  });

  it("fails closed on mismatched treatment lenses and effective configuration", () => {
    const lenses = abcCohort(1);
    const event = lenses.runs[1]!.executions[0]!.events[0]!;
    event.data = { ...event.data, requestedLensSignature: "[]" };
    expect(failureCodes(analyzeEvalCohort(lenses, 1).failures)).toContain("target_lens_signature");

    const config = abcCohort(1);
    config.runs[1]!.info.effectiveConfig!.review.packedToolBudgetMode = "invalid" as never;
    expect(() => analyzeEvalCohort(config, 1)).toThrow(/invalid effective packet-packing settings/u);
  });

  it("joins every B/C atom and hunk exactly to A and independently validates telemetry", () => {
    const cohort = abcCohort(1);
    const b = cohort.runs[1]!.executions[0]!;
    const event = b.events[0]!;
    event.data = {
      ...event.data,
      atomIds: ["unknown-atom", ...(event.data?.atomIds as string[]).slice(1)],
      standaloneProfiles: ["investigate", "standard"],
      capUsage: { ...(event.data?.capUsage as object), patchChars: 1 },
      baseToolBudget: { maxToolCalls: 99, maxInvestigationRounds: 99, maxResultChars: 99 }
    };
    b.packets[0]!.dispatchRank = [3, -99];
    const codes = failureCodes(analyzeEvalCohort(cohort, 1).failures);
    expect(codes).toEqual(expect.arrayContaining(["unknown_source_atom", "treatment_invariant", "invalid_dispatch_rank", "atom_bijection"]));
  });

  it("requires a bidirectional expectation join and selects B on equal B/C evidence", () => {
    const tied = analyzeEvalCohort(abcCohort(10), 10);
    expect(tied.failures).toEqual([]);
    expect(tied.cases?.[0]?.selectedArm).toBe("B");

    const missing = abcCohort(1);
    missing.runs[1]!.executions[0]!.score.expectationResults = [];
    expect(failureCodes(analyzeEvalCohort(missing, 1).failures)).toContain("expectation_join");

    const colludingScores = abcCohort(1);
    colludingScores.runs[0]!.declaredCase.should_find![0]!.id = "declared-only";
    expect(failureCodes(analyzeEvalCohort(colludingScores, 1).failures)).toEqual(expect.arrayContaining([
      "declared_expectation_join",
      "expectation_join"
    ]));
  });

  it("joins requested and routed lenses to the persisted Stage-5 plan and A atoms", () => {
    const pruned = abcCohort(1);
    for (const run of pruned.runs) {
      for (const execution of run.executions) {
        for (const decision of execution.plan.coverage) {
          decision.lenses = ["core/code-review", "core/tests"];
        }
        for (const event of execution.events.filter((entry) => entry.message === "same_file_atoms_packed")) {
          event.data = {
            ...event.data,
            requestedLensSignature: JSON.stringify(["core/code-review", "core/tests"])
          };
        }
      }
    }
    expect(failureCodes(analyzeEvalCohort(pruned, 1).failures)).not.toEqual(expect.arrayContaining([
      "requested_lens_join",
      "routed_lens_join"
    ]));

    const planned = abcCohort(1);
    planned.runs[0]!.executions[0]!.plan.coverage[0]!.lenses = ["security/auth"];
    expect(failureCodes(analyzeEvalCohort(planned, 1).failures)).toContain("requested_lens_join");

    const routed = abcCohort(1);
    routed.runs[0]!.executions[0]!.packets[0]!.lenses.push("security/auth");
    expect(failureCodes(analyzeEvalCohort(routed, 1).failures)).toContain("routed_lens_join");

    const missing = abcCohort(1);
    missing.runs[0]!.executions[0]!.plan.coverage.shift();
    expect(failureCodes(analyzeEvalCohort(missing, 1).failures)).toEqual(expect.arrayContaining(["stage5_lens_join", "requested_lens_join"]));

    const empty = abcCohort(1);
    empty.runs[0]!.executions[0]!.plan.coverage[0]!.lenses = [];
    expect(failureCodes(analyzeEvalCohort(empty, 1).failures)).toEqual(expect.arrayContaining(["stage5_lens_join", "requested_lens_join"]));

    const whitespace = abcCohort(1);
    whitespace.runs[0]!.executions[0]!.plan.coverage[0]!.lenses = ["   "];
    expect(failureCodes(analyzeEvalCohort(whitespace, 1).failures)).toEqual(expect.arrayContaining(["stage5_lens_join", "requested_lens_join"]));

    const extra = abcCohort(1);
    extra.runs[1]!.executions[0]!.packets[0]!.lenses.push("security/arbitrary-extra");
    expect(failureCodes(analyzeEvalCohort(extra, 1).failures)).toContain("routed_lens_join");
  });

  it("selects one economical cohort-wide arm and fails conflicting case requirements", () => {
    const economicalRuns = [
      ...abcCohort(10, (arm, index) => ({ hit: arm !== "B" || index > 0, cost: arm === "C" ? 0.5 : 1 }), "first", 0).runs,
      ...abcCohort(10, (arm, index) => ({ hit: arm === "C" || index > 0, cost: arm === "C" ? 0.5 : 1 }), "second", 3).runs
    ];
    for (const run of economicalRuns.filter((candidate) => candidate.info.caseName.endsWith("-c"))) {
      for (const execution of run.executions) {
        for (const call of execution.modelCalls) {
          call.durationMs = 500;
        }
      }
    }
    const economical = analyzeEvalCohort({ id: "economic", runs: economicalRuns }, 10);
    expect(economical.failures).toEqual([]);
    expect(economical.selectedArm).toBe("C");
    expect(economical.cases?.every((entry) => entry.selectedArm === "C")).toBe(true);

    const conflictingRuns = [
      ...abcCohort(10, (arm, index) => ({ hit: arm === "B" ? index < 7 : true }), "requires-c", 0).runs,
      ...abcCohort(10, (arm, index) => ({ hit: arm === "C" ? index < 7 : true }), "requires-b", 3).runs
    ];
    expect(failureCodes(analyzeEvalCohort({ id: "conflicting", runs: conflictingRuns }, 10).failures)).toContain("conflicting_arm_selection");
  });

  it("requires C to improve pressure or recall and retain 85% of packet-count service savings when B fails", () => {
    const tied = analyzeEvalCohort(abcCohort(10), 10);
    expect(tied.selectedArm).toBe("B");

    const lowRetention = abcCohort(10, (arm, index) => ({ hit: arm !== "B" || index < 7 }));
    for (const execution of lowRetention.runs[2]!.executions) {
      execution.modelCalls[0]!.durationMs = 1_900;
    }
    const report = analyzeEvalCohort(lowRetention, 10);
    expect(failureCodes(report.failures)).toEqual(expect.arrayContaining(["atom_scaled_savings_retention", "no_passing_arm"]));
  });

  it("applies savings retention cohort-wide when B is ineligible for pressure rather than recall", () => {
    const cases = [
      abcCohort(10, undefined, "pressure-one", 0),
      abcCohort(10, undefined, "pressure-two", 3)
    ];
    for (const cohort of cases) {
      const b = cohort.runs[1]!;
      for (const execution of b.executions) {
        execution.toolCalls.push({
          runId: "eval",
          toolCallId: `rejected-${b.info.caseName}-${execution.repeat}`,
          timestamp: "2026-07-24T00:00:00.000Z",
          stage: 7,
          initiator: "model",
          packetId: execution.packets[0]!.id,
          tool: "read_file",
          args: { path: "app.ts" },
          backend: "text",
          precision: "exact",
          degraded: false,
          degradationReason: "tool_call_budget_exhausted",
          resultChars: 0,
          durationMs: 0,
          status: "rejected"
        });
      }
      refreshRunEvidenceScores(b);
      for (const execution of cohort.runs[2]!.executions) {
        execution.modelCalls[0]!.durationMs = 1_900;
      }
    }
    const report = analyzeEvalCohort({ id: "cohort-pressure-retention", runs: cases.flatMap((cohort) => cohort.runs) }, 10);
    expect(failureCodes(report.failures)).toEqual(expect.arrayContaining([
      "tool_pressure",
      "atom_scaled_savings_retention",
      "no_passing_arm"
    ]));
  });

  it("reconstructs relational evidence and rejects deletions, altered matches, costs, and repeat aggregates", () => {
    for (const mutate of [
      (run: EvalCaseRunInput) => { run.executions[0]!.verification = []; },
      (run: EvalCaseRunInput) => { run.executions[0]!.finalSelection = []; },
      (run: EvalCaseRunInput) => { run.executions[0]!.score.expectationResults[0]!.matched = [{ findingId: "invented", artifact: "final-findings" }]; },
      (run: EvalCaseRunInput) => { run.executions[0]!.score.metrics.costUSD = 99; }
    ]) {
      const cohort = abcCohort(1);
      mutate(cohort.runs[1]!);
      const codes = failureCodes(analyzeEvalCohort(cohort, 1).failures);
      expect(codes.some((code) => code === "paid_evidence_relations" || code === "paid_evidence_score_reconstruction")).toBe(true);
    }

    const repeated = abcCohort(10);
    repeated.runs[1]!.info.repeats!.totals.costUSD += 1;
    expect(failureCodes(analyzeEvalCohort(repeated, 10).failures)).toContain("paid_evidence_aggregate");
  });

  it("rejects collusive score/summary mutations and non-canonical repeat paths", () => {
    const collusive = abcCohort(1);
    const run = collusive.runs[1]!;
    const target = run.executions[0]!;
    target.scoringArtifacts.metricsSources.costProfile = { totalCostUSD: 99 };
    target.scoringArtifacts.metricsSources.modelCallsSummary = { totalCalls: 99 };
    target.scoringArtifacts.metricsSources.toolCallsSummary = { totalCalls: 99 };
    target.scoringArtifacts.metricsSources.runJson = { durationMs: 99_000 };
    target.score.metrics.costUSD = 99;
    target.score.metrics.modelCalls = 99;
    target.score.metrics.toolCalls = 99;
    target.score.metrics.elapsedSeconds = 99;
    const costBudget = target.score.budgetResults.find((result) => result.check === "maxCostUSD");
    if (costBudget !== undefined) costBudget.actual = 99;
    run.info.score = structuredClone(target.score);
    expect(failureCodes(analyzeEvalCohort(collusive, 1).failures)).toEqual(expect.arrayContaining([
      "paid_evidence_score_reconstruction",
      "evidence_cost_accounting"
    ]));

    const paths = abcCohort(10);
    paths.runs[1]!.info.repeats!.executions[0]!.runDir = "/arbitrary/repeat";
    expect(failureCodes(analyzeEvalCohort(paths, 10).failures)).toContain("paid_evidence_aggregate");

    const reordered = abcCohort(10);
    [reordered.runs[1]!.executions[0], reordered.runs[1]!.executions[1]] =
      [reordered.runs[1]!.executions[1]!, reordered.runs[1]!.executions[0]!];
    expect(failureCodes(analyzeEvalCohort(reordered, 10).failures)).toContain("paid_evidence_repeat_order");
  });

  it("reconciles every accepted producer summary field to raw calls, events, and artifacts", async () => {
    const base = abcCohort(1);
    await attachProducerSummaryEvidence(base.runs[0]!);
    expect(failureCodes(analyzeEvalCohort(base, 1).failures)).not.toContain("paid_summary_reconciliation");

    const reorderedAttention = structuredClone(base);
    reorderedAttention.runs[0]!.executions[0]!.summaryArtifacts!.attention = [
      ...(reorderedAttention.runs[0]!.executions[0]!.summaryArtifacts!.attention as unknown[])
    ].reverse();
    expect(failureCodes(analyzeEvalCohort(reorderedAttention, 1).failures)).not.toContain("paid_summary_reconciliation");

    const paths = [
      ["cost", "costBreakdown", "total", "costUSD"],
      ["run", "totals", "costBreakdown", "total", "costUSD"],
      ["run", "totals", "stage7SchemaRepair", "actualRepairCalls"],
      ["telemetry", "schemaRepair", "stage7", "actualRepairCalls"],
      ["run", "totals", "logOverflow", "droppedDebugInfo"],
      ["telemetry", "logs", "bufferedOverflow", "droppedWarnError"],
      ...["filesChanged", "hunks", "packets", "packetReviews", "candidates", "verified", "finalFindings", "postedComments"]
        .map((field) => ["run", "totals", field]),
      ["telemetry", "workers", "started"],
      ["telemetry", "packets", "generated"],
      ["telemetry", "lenses", "selected"],
      ["telemetry", "coverage", "hunks", "reviewed"],
      ["telemetry", "candidates", "generated"],
      ["telemetry", "verdicts", "accept"],
      ["telemetry", "dedup", "clusters"],
      ["telemetry", "finalSelection", "published"],
      ["telemetry", "posting", "attempted"]
    ];
    for (const fieldPath of paths) {
      const cohort = structuredClone(base);
      const summary = cohort.runs[0]!.executions[0]!.summaryArtifacts as Record<string, unknown>;
      let owner = summary;
      for (const key of fieldPath.slice(0, -1)) {
        owner = owner[key] as Record<string, unknown>;
      }
      const key = fieldPath.at(-1)!;
      owner[key] = Number(owner[key]) + 1;
      expect(
        failureCodes(analyzeEvalCohort(cohort, 1).failures),
        fieldPath.join(".")
      ).toContain("paid_summary_reconciliation");
    }
  });

  it("reconstructs note-bearing repeats and rejects corruption in every persisted score section", () => {
    const notes = abcCohort(10, (arm, index) => ({ hit: arm !== "B" || index > 0 }));
    notes.runs[1]!.executions[0]!.scoringArtifacts.humanAttentionNotes = [{
      question: "Does the boundary bug affect app.ts?",
      files: ["app.ts"],
      reasons: ["boundary behavior"]
    }];
    refreshRunEvidenceScores(notes.runs[1]!);
    expect(notes.runs[1]!.executions[0]!.score.expectationResults[0]!.loss?.surfacedAsNote).toBe(true);
    expect(failureCodes(analyzeEvalCohort(notes, 10).failures)).not.toEqual(expect.arrayContaining([
      "paid_evidence_score_reconstruction",
      "paid_evidence_aggregate"
    ]));

    const corruptions: Array<(score: EvalScore) => void> = [
      (persisted) => { persisted.nearViolations.push({ expectationId: "bug", findingId: "invented", artifact: "final-findings" }); },
      (persisted) => { persisted.budgetResults.push({ check: "maxFindings", status: "pass", limit: 99, actual: 1, direction: "maximum" }); },
      (persisted) => { persisted.metrics.reasoningTokens = 999; },
      (persisted) => { persisted.expectationResults[0]!.note = "corrupted aggregate note"; }
    ];
    for (const corrupt of corruptions) {
      const cohort = abcCohort(1);
      corrupt(cohort.runs[1]!.executions[0]!.score);
      expect(failureCodes(analyzeEvalCohort(cohort, 1).failures)).toContain("paid_evidence_score_reconstruction");
    }

    const aggregate = abcCohort(10);
    aggregate.runs[1]!.info.score.metrics.reasoningTokens = 123;
    expect(failureCodes(analyzeEvalCohort(aggregate, 10).failures)).toContain("paid_evidence_aggregate");
  });

  it("validates every final-selection section and verifier-to-final lineage", () => {
    const mutations: Array<(execution: EvalExecutionInput) => void> = [
      (target) => { target.finalSelectionArtifact.records = []; },
      (target) => { target.finalSelectionArtifact.groups = []; },
      (target) => { target.finalSelectionArtifact.publicationAnchors[0]!.fingerprint = "invented"; },
      (target) => { target.finalSelectionArtifact.confidenceSelections.push({
        findingId: "finding", confidence: "high", representativeConfidence: "medium", reason: "representative"
      }); },
      (target) => {
        const record = target.verification[0]!;
        if ("verdict" in record) {
          record.verdict.finalFinding = { ...structuredClone(target.candidateFindings[0]!), failureMode: "unrelated revised failure" };
        }
      },
      (target) => {
        const record = target.verification[0]!;
        if ("verdict" in record) {
          record.verdict.revisedAnchor = { path: "app.ts", hunkId: "h2", line: 1, side: "RIGHT" };
        }
      },
      (target) => {
        const record = target.verification[0]!;
        record.gate = "gate_anchor_stripped";
        record.gateDecision = "suppressed";
        record.gateReason = "invalid_anchor; fabricated mixed state";
      },
      (target) => {
        target.verification[0]!.gateFacts = { ...target.verification[0]!.gateFacts, changedLine: false };
      }
    ];
    for (const [index, mutate] of mutations.entries()) {
      const cohort = abcCohort(1);
      mutate(cohort.runs[1]!.executions[0]!);
      expect(failureCodes(analyzeEvalCohort(cohort, 1).failures), `mutation ${index}`).toContain("paid_evidence_relations");
    }
  });

  it("accepts Stage 9 producers only for relational uncertainty promotions", () => {
    const promoted = abcCohort(1);
    const promotedRun = promoted.runs[1]!;
    const promotedExecution = promotedRun.executions[0]!;
    const promotedCandidate = promotedExecution.candidateFindings[0]!;
    const provenance = {
      source: "uncertainty_promotion" as const,
      sourceKind: "uncertainty" as const,
      sourcePacketId: promotedCandidate.producedBy.packetId,
      question: "Does this changed boundary remain safe?",
      files: [promotedCandidate.path],
      symbols: [],
      reason: "The packet review left the boundary unresolved."
    };
    promotedCandidate.producedBy.stage = 9;
    promotedCandidate.provenance = provenance;
    promotedExecution.verification[0]!.candidateProvenance = structuredClone(provenance);
    refreshRunEvidenceScores(promotedRun);
    expect(failureCodes(analyzeEvalCohort(promoted, 1).failures)).not.toContain("paid_evidence_relations");

    const arbitraryStage9 = abcCohort(1);
    const arbitraryRun = arbitraryStage9.runs[1]!;
    arbitraryRun.executions[0]!.candidateFindings[0]!.producedBy.stage = 9;
    refreshRunEvidenceScores(arbitraryRun);
    expect(failureCodes(analyzeEvalCohort(arbitraryStage9, 1).failures)).toContain("paid_evidence_relations");
  });

  it("replays verifier gates from raw candidates instead of trusting collusive persisted decisions", () => {
    const scheduledInvalid = abcCohort(1);
    const scheduledRun = scheduledInvalid.runs[1]!;
    scheduledRun.executions[0]!.candidateFindings[0]!.evidence.changedCode = "";
    refreshRunEvidenceScores(scheduledRun);
    expect(failureCodes(analyzeEvalCohort(scheduledInvalid, 1).failures)).toContain("paid_evidence_relations");

    const suppressedValid = abcCohort(1);
    const suppressedRun = suppressedValid.runs[1]!;
    const suppressedExecution = suppressedRun.executions[0]!;
    suppressedExecution.verification = [{
      candidateId: "finding",
      gate: "suppressed",
      gateDecision: "suppressed",
      gateReason: "missing_evidence"
    }];
    suppressedExecution.finalSelection = [];
    suppressedExecution.finalFindings = [];
    refreshRunEvidenceScores(suppressedRun);
    expect(failureCodes(analyzeEvalCohort(suppressedValid, 1).failures)).toContain("paid_evidence_relations");
  });

  it("accepts production anchor backfill and withholds representative-only anchors from inline publication", () => {
    for (const invalidAnchor of [false, true]) {
      const cohort = abcCohort(1);
      const run = cohort.runs[1]!;
      const execution = run.executions[0]!;
      const candidate = execution.candidateFindings[0]!;
      candidate.changedLine = false;
      candidate.modelAnchorSubmitted = invalidAnchor;
      if (invalidAnchor) {
        candidate.anchor = { path: "app.ts", line: 999, side: "RIGHT", hunkId: "h1" };
        candidate.anchorSource = "model";
        execution.verification[0]!.gate = "gate_anchor_stripped";
      } else {
        delete candidate.anchor;
        delete candidate.anchorSource;
      }
      refreshRunEvidenceScores(run);
      expect(execution.finalFindings[0]!.publication).toBe("summary-only");
      expect(execution.finalFindings[0]!.anchor).toBeUndefined();
      expect(execution.finalSelection[0]!.reason).toBe("unanchorable");
      expect(failureCodes(analyzeEvalCohort(cohort, 1).failures)).not.toContain("paid_evidence_relations");
    }
  });

  it("supports production verify:false duplicate records without persisted cluster metadata", () => {
    const cohort = abcCohort(1);
    const run = cohort.runs[1]!;
    run.info.effectiveConfig!.review.verify = false;
    run.declaredCase.review!.verify = false;
    run.info.caseSnapshot.review!.verify = false;
    const execution = run.executions[0]!;
    const duplicate = { ...structuredClone(execution.candidateFindings[0]!), id: "finding-2" };
    execution.candidateFindings.push(duplicate);
    const primaryRecord = execution.verification[0]!;
    if (!("verdict" in primaryRecord)) throw new Error("expected verifier record");
    primaryRecord.verdict = {
      candidateId: "finding",
      verdict: "keep",
      reason: "verification disabled by config",
      requiredEvidencePresent: true,
      falsePositiveRisk: "low"
    };
    execution.verification.push({
      ...structuredClone(primaryRecord),
      candidateId: duplicate.id,
      verdict: { ...structuredClone(primaryRecord.verdict), candidateId: duplicate.id }
    });
    execution.finalFindings[0]!.mergedCandidateIds = ["finding", duplicate.id];
    execution.finalSelection.push({ findingId: duplicate.id, decision: "merged", reason: "composer-merged" });
    refreshRunEvidenceScores(run);
    expect(execution.verification.every((record) => record.duplicateOf === undefined && record.clusterId === undefined)).toBe(true);
    expect(failureCodes(analyzeEvalCohort(cohort, 1).failures)).not.toContain("paid_evidence_relations");
  });

  it("independently applies composer thresholds, caps, and deterministic ordering", () => {
    const thresholdCases: Array<(run: EvalCaseRunInput) => void> = [
      (run) => { run.info.effectiveConfig!.review.minSeverity = "high"; },
      (run) => { run.info.effectiveConfig!.review.minConfidence = "high"; },
      (run) => { run.info.effectiveConfig!.review.minInlineConfidence = "high"; }
    ];
    for (const mutatePolicy of thresholdCases) {
      const cohort = abcCohort(1);
      mutatePolicy(cohort.runs[1]!);
      expect(failureCodes(analyzeEvalCohort(cohort, 1).failures)).toContain("paid_evidence_relations");
    }

    const multi = abcCohort(1);
    const multiRun = multi.runs[1]!;
    const execution = multiRun.executions[0]!;
    const packetWithH2 = execution.packets.find((target) => target.hunks.some((hunk) => hunk.hunkId === "h2"))!;
    const second = candidateFinding("finding-2", packetWithH2.id, "h2", 101);
    second.title = "Independent second boundary defect";
    const evidence = findingEvidence(second);
    execution.candidateFindings.push(...evidence.candidateFindings);
    execution.verification.push(...evidence.verification);
    execution.finalSelection.push(...evidence.finalSelection);
    execution.finalFindings.push(...evidence.finalFindings);
    refreshRunEvidenceScores(multiRun);
    expect(failureCodes(analyzeEvalCohort(multi, 1).failures)).not.toContain("paid_evidence_relations");

    const softCap = structuredClone(multi);
    softCap.runs[1]!.info.effectiveConfig!.review.softCommentCap = 1;
    expect(failureCodes(analyzeEvalCohort(softCap, 1).failures)).toContain("paid_evidence_relations");

    const reportCap = structuredClone(multi);
    reportCap.runs[1]!.info.effectiveConfig!.review.maxFindings = 1;
    expect(failureCodes(analyzeEvalCohort(reportCap, 1).failures)).toContain("paid_evidence_relations");

    const reordered = structuredClone(multi);
    reordered.runs[1]!.executions[0]!.finalFindings.reverse();
    expect(failureCodes(analyzeEvalCohort(reordered, 1).failures)).toContain("paid_evidence_relations");
  });

  it("enforces aggregate recall and atom-count loss attribution instead of allowing one loss per expectation", () => {
    const cohort = abcCohort(10);
    for (const run of cohort.runs) {
      run.declaredCase.should_find![0]!.titlePattern = "^Boundary bug$";
      run.declaredCase.should_find!.push({ id: "bug-2", path: "app.ts", titlePattern: "^Secondary boundary bug$" });
      for (const execution of run.executions) {
        const packetWithH2 = execution.packets.find((target) => target.hunks.some((hunk) => hunk.hunkId === "h2"))!;
        const candidate = candidateFinding("finding-2", packetWithH2.id, "h2", 1);
        candidate.title = "Secondary boundary bug";
        const evidence = findingEvidence(candidate);
        execution.candidateFindings.push(...evidence.candidateFindings);
        execution.verification.push(...evidence.verification);
        execution.finalSelection.push(...evidence.finalSelection);
        execution.finalFindings.push(...evidence.finalFindings);
      }
      refreshRunEvidenceScores(run);
    }
    for (const [repeatIndex, findingId] of [[0, "finding"], [1, "finding-2"]] as const) {
      const execution = cohort.runs[1]!.executions[repeatIndex]!;
      execution.candidateFindings = execution.candidateFindings.filter((finding) => finding.id !== findingId);
      execution.verification = execution.verification.filter((record) => record.candidateId !== findingId);
      execution.finalSelection = execution.finalSelection.filter((record) => record.findingId !== findingId);
      execution.finalFindings = execution.finalFindings.filter((finding) => finding.id !== findingId);
    }
    refreshRunEvidenceScores(cohort.runs[1]!);
    const codes = failureCodes(analyzeEvalCohort(cohort, 10).failures);
    expect(codes).toContain("recall_non_inferiority");

    const bucketed = abcCohort(10, (arm, index) => ({ hit: arm !== "B" || index > 1 }));
    expect(failureCodes(analyzeEvalCohort(bucketed, 10).failures)).toContain("candidate_generation_loss_by_atom_count");
  });

  it("spends the single recall and atom-loss allowance across the entire multi-case cohort", () => {
    const runs = [
      ...abcCohort(10, (arm, index) => ({ hit: arm !== "B" || index > 0 }), "cohort-loss-one", 0).runs,
      ...abcCohort(10, (arm, index) => ({ hit: arm !== "B" || index > 0 }), "cohort-loss-two", 3).runs
    ];
    const codes = failureCodes(analyzeEvalCohort({ id: "cohort-loss", runs }, 10).failures);
    expect(codes).toEqual(expect.arrayContaining([
      "recall_non_inferiority",
      "candidate_generation_loss",
      "candidate_generation_loss_by_atom_count"
    ]));
  });

  it("keeps all executions in intent-to-treat and excludes untreated runs from both treated-only numerator and denominator", () => {
    const report = analyzeEvalCohort(abcCohort(10, (arm, index) => ({
      treated: arm === "B" ? index !== 0 : arm !== "A",
      hit: arm === "B" ? index !== 1 : true
    })), 10);
    expect(report.failures).toEqual([]);
    const b = report.cases?.[0]?.arms.B;
    expect(b?.intentToTreat[0]).toMatchObject({ denominator: 10, candidateHits: 9, finalHits: 9 });
    expect(b?.treatedOnly.rates[0]).toMatchObject({ denominator: 9, candidateHits: 8, finalHits: 8 });
    expect(b?.treatedOnly.denominatorByExpectation["should_find:bug"]).toBe(9);
  });

  it("fails closed below 8/10 treatment and on missing telemetry", () => {
    const underTreated = analyzeEvalCohort(abcCohort(10, (arm, index) => ({
      treated: arm === "B" ? index < 7 : arm !== "A"
    })), 10);
    expect(failureCodes(underTreated.failures)).toContain("insufficient_treatment");

    const missing = analyzeEvalCohort(abcCohort(1, (arm) => ({ missingTelemetry: arm === "C" })), 1);
    expect(failureCodes(missing.failures)).toEqual(expect.arrayContaining(["missing_treatment_telemetry", "insufficient_treatment"]));
  });

  it("fails closed on recall regression and missing spend data", () => {
    const recall = analyzeEvalCohort(abcCohort(10, (arm, index) => ({
      hit: arm === "B" ? index < 7 : true
    })), 10);
    expect(failureCodes(recall.failures)).toEqual(expect.arrayContaining(["recall_non_inferiority"]));

    const noSpend = abcCohort(1, (arm) => arm === "C" ? { cost: undefined } : {});
    delete noSpend.runs[2]!.executions[0]!.score.metrics.costUSD;
    noSpend.runs[2]!.executions[0]!.score.budgetResults = [];
    const spendReport = analyzeEvalCohort(noSpend, 1);
    expect(failureCodes(spendReport.failures)).toContain("missing_spend_data");
  });

  it("writes a failure report when eval artifacts cannot be loaded", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "packet-report-missing-eval-"));
    tempDirs.push(root);
    const output = path.join(root, "report.json");
    const exitCode = await runPacketPackingReportCli([
      "eval",
      "--logs",
      path.join(root, "missing"),
      "--expected-repeats",
      "1",
      "--output",
      output
    ]);
    expect(exitCode).toBe(1);
    const report = JSON.parse(await readFile(output, "utf8")) as { failures: ReportFailure[] };
    expect(failureCodes(report.failures)).toContain("missing_logs");
  });

  it("projects replay, eval, and regression failures through one prose-safe output boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "packet-report-safe-output-"));
    tempDirs.push(root);
    const secret = "PROPRIETARY_FOCUS_AND_CREDENTIAL_NEVER_EMIT";
    const replayRun = path.join(root, secret);
    await mkdir(path.join(replayRun, "stages", "01-input"), { recursive: true });
    await writeFile(path.join(replayRun, "stages", "01-input", "resolved-input.json"), "{bad-json\n");
    const invocations: Array<{ argv: string[]; output: string }> = [
      {
        argv: ["replay", "--repo", process.cwd(), "--run", replayRun, "--output", path.join(root, "replay.json")],
        output: path.join(root, "replay.json")
      },
      {
        argv: ["eval", "--logs", path.join(root, secret, "eval"), "--expected-repeats", "1", "--output", path.join(root, "eval.json")],
        output: path.join(root, "eval.json")
      },
      {
        argv: [
          "regression",
          "--baseline-logs", path.join(root, secret, "baseline"),
          "--selected-logs", path.join(root, secret, "selected"),
          "--expected-repeats", "1",
          "--output", path.join(root, "regression.json")
        ],
        output: path.join(root, "regression.json")
      }
    ];
    for (const invocation of invocations) {
      expect(await runPacketPackingReportCli(invocation.argv)).toBe(1);
      const serialized = await readFile(invocation.output, "utf8");
      expect(serialized).not.toContain(secret);
      expect(serialized).toContain("sha256:");
      expect((JSON.parse(serialized) as { failures: ReportFailure[] }).failures.length).toBeGreaterThan(0);
    }
  });

  it("fingerprints argument, top-level, and report-write failures without raw stderr prose", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "packet-report-safe-top-level-"));
    tempDirs.push(root);
    const secret = "PROPRIETARY_TOP_LEVEL_MESSAGE_NEVER_EMIT";
    const parseOutput = path.join(root, "parse.json");
    expect(await runPacketPackingReportCli([
      "eval", "--logs", path.join(root, secret), "--unsupported", secret,
      "--output", parseOutput
    ])).toBe(1);
    const parseReport = await readFile(parseOutput, "utf8");
    expect(parseReport).not.toContain(secret);
    expect(parseReport).toContain("sha256:");

    const stderrChunks: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      expect(await runPacketPackingReportCli(["unknown-mode", secret])).toBe(1);
      const unwritableOutput = path.join(root, secret);
      await mkdir(unwritableOutput);
      expect(await runPacketPackingReportCli([
        "eval", "--logs", path.join(root, "missing"), "--expected-repeats", "1", "--output", unwritableOutput
      ])).toBe(1);
    } finally {
      stderr.mockRestore();
    }
    const stderrOutput = stderrChunks.join("");
    expect(stderrOutput).not.toContain(secret);
    expect(stderrOutput).toContain("sha256:");
  });
});

describe("production economics", () => {
  function productionExecution(arm: "A" | "B", wallTimeSeconds: number, cost: number): EvalExecutionInput {
    const hunkIds = Array.from({ length: 142 }, (_, index) => `production-hunk-${index + 1}`);
    const atoms = hunkIds.map((hunkId, index) => packet(`production-atom-${index + 1}`, [hunkId]));
    const packets = arm === "A"
      ? atoms
      : Array.from({ length: Math.ceil(atoms.length / 5) }, (_, index) => {
          const members = atoms.slice(index * 5, index * 5 + 5);
          return packet(`production-packed-${index + 1}`, members.flatMap((member) => member.hunks.map((hunk) => hunk.hunkId)));
        });
    const events = arm === "A" ? [] : packets.map((target, index) => packingEvent(target, atoms.slice(index * 5, index * 5 + 5)));
    const executionScore = score(true, cost);
    const callCost = cost / (packets.length + 3);
    const packetCalls = packets.map((target) => modelCall(target.id, 1, callCost));
    const planner = { ...modelCall(packets[0]!.id, 1, callCost), callId: `production-planner-${arm}`, stage: 5 as const, role: "planner" as const };
    delete (planner as Partial<typeof planner>).packetId;
    const verifier = {
      ...modelCall(packets[0]!.id, 1, callCost),
      callId: `production-verifier-${arm}`,
      stage: 9 as const,
      role: "verifier" as const,
      kind: "repair" as const,
      candidateId: "finding"
    };
    delete (verifier as Partial<typeof verifier>).packetId;
    const composer = { ...modelCall(packets[0]!.id, 1, callCost), callId: `production-composer-${arm}`, stage: 10 as const, role: "composer" as const };
    delete (composer as Partial<typeof composer>).packetId;
    const allCalls = [...packetCalls, planner, verifier, composer];
    executionScore.metrics.modelCalls = allCalls.length;
    executionScore.metrics.verificationCalls = 1;
    executionScore.metrics.elapsedSeconds = wallTimeSeconds;
    const candidate = candidateFinding("finding", packets[0]!.id, hunkIds[0]!);
    const result = {
      repeat: 1,
      score: executionScore,
      telemetryDir: `/tmp/production/${arm}`,
      packets,
      events,
      modelCalls: allCalls,
      toolCalls: [],
      fileFacts: [{
        path: "app.ts",
        language: "typescript",
        processingMode: "per-hunk",
        testStatus: "source",
        isGenerated: false,
        isVendored: false,
        isLockfile: false,
        isBinary: false,
        changedLines: 142,
        hunkCount: 142,
        labels: [],
        reviewPriority: "normal",
        reasons: [],
        provenance: []
      }],
      diff: diffForPackets(atoms),
      plan: planForHunks(hunkIds),
      ...findingEvidence(candidate),
      reviewedHunkIds: hunkIds,
      wallTimeSeconds
    } as unknown as EvalExecutionInput;
    refreshExecutionEvidence(result);
    return result;
  }

  function productionCohort(): CohortSelection {
    const cohort = {
      id: "1-2",
      runs: [
        evalRun("production", "A", 1, [productionExecution("A", 200, 20)]),
        evalRun("production", "B", 2, [productionExecution("B", 100, 10)])
      ]
    };
    for (const run of cohort.runs) {
      run.declaredCase.repo = { external: "/home/peter/Dev/0xsequence/trails-api" };
      run.declaredCase.command = { base: "d1c49bdf6a8002ec2ec27faac94a932d736532b2", head: "fbb5f8761c2c296e115af17e919a7c35d9de8373" };
      run.declaredCase.review = {
        ...run.declaredCase.review,
        cache: false,
        concurrency: 6,
        maxTimeMinutes: 60
      };
      run.info.repo = {
        root: "/home/peter/Dev/0xsequence/trails-api",
        baseSha: "d1c49bdf6a8002ec2ec27faac94a932d736532b2",
        mergeBase: "d1c49bdf6a8002ec2ec27faac94a932d736532b2",
        headSha: "fbb5f8761c2c296e115af17e919a7c35d9de8373"
      };
      run.info.effectiveConfig!.review.concurrency = 6;
      run.info.effectiveConfig!.review.timeoutMs = 3_600_000;
      run.info.effectiveConfig!.llm.maxConcurrentCalls = 6;
      run.info.codegenieRuntime = { packageVersion: "0.5.0", commit: "a".repeat(40), dirty: false, source: "git" };
    }
    return cohort;
  }

  it("reports raw and normalized 142-hunk economics with extrapolation and break-even", () => {
    const failures: ReportFailure[] = [];
    const economics = computeProductionEconomics(
      { actualCostUSD: 20, reviewedHunks: 100 },
      { actualCostUSD: 20, reviewedHunks: 142 },
      80,
      "explicit_cumulative_validation_cost",
      failures
    );
    expect(failures).toEqual([]);
    expect(economics).toMatchObject({
      equivalentTargetHunks: 142,
      equivalentReviewSavingsUSD: 8.4,
      breakEvenReviewCount: 10,
      baseline: { equivalentCostExtrapolated: true },
      selected: { equivalentCostExtrapolated: false }
    });
  });

  it("fails closed on missing reviewed work and a non-positive payback denominator", () => {
    const failures: ReportFailure[] = [];
    computeProductionEconomics(
      { actualCostUSD: 10, reviewedHunks: 0 },
      { actualCostUSD: 20, reviewedHunks: 100 },
      50,
      "explicit_cumulative_validation_cost",
      failures
    );
    expect(failureCodes(failures)).toEqual(expect.arrayContaining(["missing_reviewed_hunks", "non_positive_payback_denominator"]));

    const noSavings: ReportFailure[] = [];
    computeProductionEconomics(
      { actualCostUSD: 10, reviewedHunks: 100 },
      { actualCostUSD: 20, reviewedHunks: 100 },
      50,
      "explicit_cumulative_validation_cost",
      noSavings
    );
    expect(failureCodes(noSavings)).toContain("non_positive_payback_denominator");
  });

  it("gates production on the exact 142-hunk set and measured wall/model/token capacity", () => {
    const report = analyzeEvalCohort(productionCohort(), 1, { actualValidationCostUSD: 30 });
    expect(report.failures).toEqual([]);
    const cohort = productionCohort();
    const baselineCalls = cohort.runs[0]!.executions[0]!.modelCalls;
    const allStageReport = analyzeEvalCohort(cohort, 1, { actualValidationCostUSD: 30 });
    expect(report.productionThroughput).toMatchObject({
      baseline: { reviewedHunks: 142, wallTimeSeconds: 200 },
      selected: { reviewedHunks: 142, wallTimeSeconds: 100 }
    });
    expect(allStageReport.productionThroughput?.baseline).toMatchObject({
      modelServiceSeconds: baselineCalls.reduce((total, call) => total + call.durationMs, 0) / 1000,
      totalTokens: baselineCalls.reduce((total, call) => total + call.totalTokens!, 0),
      reasoningTokens: 0,
      reasoningTokensPerReviewedHunk: 0
    });

    const truncated = productionCohort();
    truncated.runs[1]!.executions[0]!.reviewedHunkIds.pop();
    const codes = failureCodes(analyzeEvalCohort(truncated, 1).failures);
    expect(codes).toEqual(expect.arrayContaining(["production_hunk_loss", "production_incomplete"]));
  });

  it("gates reasoning tokens per hunk and continuation savings using all-stage service time", () => {
    const reasoning = productionCohort();
    reasoning.runs[1]!.executions[0]!.modelCalls[0]!.reasoningTokens = 100;
    refreshRunEvidenceScores(reasoning.runs[1]!);
    expect(failureCodes(analyzeEvalCohort(reasoning, 1).failures)).toContain("production_reasoning_tokens");

    const continuation = productionCohort();
    const selectedExecution = continuation.runs[1]!.executions[0]!;
    selectedExecution.modelCalls.push({
      ...modelCall(selectedExecution.packets[0]!.id, 1, 0),
      callId: "production-added-continuation",
      kind: "tool-continuation",
      attempt: 2,
      durationMs: 100_000
    });
    refreshRunEvidenceScores(continuation.runs[1]!);
    expect(failureCodes(analyzeEvalCohort(continuation, 1).failures)).toContain("production_continuation_savings_retention");
  });

  it("fails closed when production model telemetry is coverage-only or does not strictly improve capacity", () => {
    const coverageOnly = productionCohort();
    delete coverageOnly.runs[1]!.executions[0]!.modelCalls[0]!.totalTokens;
    expect(failureCodes(analyzeEvalCohort(coverageOnly, 1).failures)).toContain("production_model_accounting");

    const equalCapacity = productionCohort();
    const selectedCalls = equalCapacity.runs[1]!.executions[0]!.modelCalls;
    const baselineCalls = equalCapacity.runs[0]!.executions[0]!.modelCalls;
    let remainingTokens = baselineCalls.reduce((total, call) => total + call.totalTokens!, 0);
    const baselineServiceMs = baselineCalls.reduce((total, call) => total + call.durationMs, 0);
    for (const [index, call] of selectedCalls.entries()) {
      const totalTokens = index === selectedCalls.length - 1 ? remainingTokens : Math.floor(remainingTokens / (selectedCalls.length - index));
      remainingTokens -= totalTokens;
      call.durationMs = baselineServiceMs / selectedCalls.length;
      call.inputTokens = totalTokens - 10;
      call.outputTokens = 10;
      call.totalTokens = totalTokens;
    }
    expect(failureCodes(analyzeEvalCohort(equalCapacity, 1).failures)).toEqual(expect.arrayContaining([
      "production_model_service",
      "production_tokens"
    ]));
  });

  it("requires pinned clean production provenance and exact finding-artifact preservation", () => {
    const cohort = productionCohort();
    cohort.runs[1]!.info.repo!.headSha = "c".repeat(40);
    cohort.runs[1]!.info.codegenieRuntime!.dirty = true;
    cohort.runs[1]!.executions[0]!.finalFindings = [];
    cohort.runs[1]!.executions[0]!.score.expectationResults[0]!.status = "fail";
    const codes = failureCodes(analyzeEvalCohort(cohort, 1).failures);
    expect(codes).toEqual(expect.arrayContaining([
      "production_refs",
      "production_runtime_provenance",
      "production_finding_artifact_join",
      "production_finding_preservation"
    ]));
  });

  it("requires the exact production repo, cache, concurrency, and 60-minute declared/effective shape", () => {
    const cohort = productionCohort();
    cohort.runs[1]!.declaredCase.repo!.external = "/tmp/wrong-repo";
    cohort.runs[1]!.declaredCase.review!.cache = true;
    cohort.runs[1]!.declaredCase.review!.concurrency = 1;
    cohort.runs[1]!.declaredCase.review!.maxTimeMinutes = 1;
    cohort.runs[1]!.info.effectiveConfig!.review.timeoutMs = 60_000;
    const codes = failureCodes(analyzeEvalCohort(cohort, 1).failures);
    expect(codes).toEqual(expect.arrayContaining(["production_refs", "production_run_shape"]));
  });

  it("requires nonempty required matches and relationally complete production finding artifacts", () => {
    const emptyMatch = productionCohort();
    emptyMatch.runs[1]!.executions[0]!.score.expectationResults[0]!.matched = [];
    expect(failureCodes(analyzeEvalCohort(emptyMatch, 1).failures)).toContain("production_finding_preservation");

    for (const mutate of [
      (execution: EvalExecutionInput) => { execution.candidateFindings[0]!.producedBy.packetId = "unknown-packet"; },
      (execution: EvalExecutionInput) => { execution.finalFindings[0]!.mergedCandidateIds = ["unknown-candidate"]; },
      (execution: EvalExecutionInput) => { execution.finalFindings[0]!.anchor = { hunkId: "unknown-hunk", path: "app.ts", line: 1, side: "RIGHT" }; },
      (execution: EvalExecutionInput) => { execution.score.metrics.candidateFindings = 99; }
    ]) {
      const cohort = productionCohort();
      mutate(cohort.runs[1]!.executions[0]!);
      expect(failureCodes(analyzeEvalCohort(cohort, 1).failures)).toContain("production_finding_relations");
    }
    for (const mutate of [
      (execution: EvalExecutionInput) => { execution.verification = []; },
      (execution: EvalExecutionInput) => { execution.finalSelection = []; }
    ]) {
      const cohort = productionCohort();
      mutate(cohort.runs[1]!.executions[0]!);
      expect(failureCodes(analyzeEvalCohort(cohort, 1).failures)).toContain("paid_evidence_relations");
    }
  });
});

describe("collateral regression analysis", () => {
  function regressionPair(selectedHit = true, selectedError = false) {
    const baseline = evalRun("fixture", "A", 1, [execution("A", 1)]);
    const selected = evalRun("fixture", "B", 1, [execution("B", 1, { hit: selectedHit })]);
    baseline.info.caseSnapshot.name = "fixture-baseline";
    baseline.declaredCase.name = "fixture-baseline";
    baseline.info.caseName = "fixture";
    baseline.info.caseFile = "fixture.yml";
    selected.info.caseSnapshot.name = "fixture-selected";
    selected.declaredCase.name = "fixture-selected";
    selected.info.caseName = "fixture";
    selected.info.caseFile = "fixture.yml";
    selected.info.score = selected.executions[0]!.score;
    if (selectedError) {
      selected.info.score = { ...selected.info.score, status: "error", error: { code: "llm_call_failed", message: "boom" } };
    }
    return {
      baseline: { id: "1-1", runs: [baseline] },
      selected: { id: "1-1", runs: [selected] }
    };
  }

  it("compares explicit roots as one-repeat collateral evidence", () => {
    const pair = regressionPair();
    const report = analyzeRegressionCohorts(pair.baseline, pair.selected, 1);
    expect(report.failures).toEqual([]);
    expect(report).toMatchObject({
      evidence: "one-repeat-collateral-only",
      baselineCohort: { actualCostUSD: 1 },
      selectedCohort: { actualCostUSD: 1 }
    });
  });

  it("accepts a valid collateral case where packing is enabled but no atom is treated", () => {
    const pair = regressionPair();
    pair.selected.runs[0]!.executions[0]!.packets = structuredClone(pair.baseline.runs[0]!.executions[0]!.packets);
    pair.selected.runs[0]!.executions[0]!.events = [];
    const selectedExecution = pair.selected.runs[0]!.executions[0]!;
    selectedExecution.candidateFindings[0]!.producedBy.packetId = selectedExecution.packets[0]!.id;
    selectedExecution.finalFindings[0]!.producedBy.packetId = selectedExecution.packets[0]!.id;
    refreshExecutionEvidence(selectedExecution);
    const report = analyzeRegressionCohorts(pair.baseline, pair.selected, 1);
    expect(report.failures).toEqual([]);
    expect(report.cases[0]?.selectedTreatmentExecutions).toBe(0);
  });

  it("fails closed on collateral expectation transitions and eval errors", () => {
    const regressed = regressionPair(false);
    const report = analyzeRegressionCohorts(regressed.baseline, regressed.selected, 1);
    expect(failureCodes(report.failures)).toContain("collateral_expectation_regression");

    const errored = regressionPair(true, true);
    expect(failureCodes(analyzeRegressionCohorts(errored.baseline, errored.selected, 1).failures)).toContain("eval_error");

    const mutuallyAlteredScore = regressionPair();
    mutuallyAlteredScore.selected.runs[0]!.info.score.expectationResults[0]!.expectationId = "score-only-expectation";
    expect(failureCodes(analyzeRegressionCohorts(mutuallyAlteredScore.baseline, mutuallyAlteredScore.selected, 1).failures)).toContain("expectation_join");
  });

  it("fails when both collateral cohorts identically miss a requirement and when relational evidence is deleted", () => {
    const bothMiss = regressionPair(false);
    const baselineExecution = bothMiss.baseline.runs[0]!.executions[0]!;
    baselineExecution.candidateFindings = [];
    baselineExecution.verification = [];
    baselineExecution.finalSelection = [];
    baselineExecution.finalFindings = [];
    refreshRunEvidenceScores(bothMiss.baseline.runs[0]!);
    const bothMissReport = analyzeRegressionCohorts(bothMiss.baseline, bothMiss.selected, 1);
    expect(bothMissReport.cases[0]!.expectationTransitions).toEqual([]);
    expect(failureCodes(bothMissReport.failures)).toContain("collateral_cohort_expectation_failure");

    const deleted = regressionPair();
    deleted.selected.runs[0]!.executions[0]!.verification = [];
    expect(failureCodes(analyzeRegressionCohorts(deleted.baseline, deleted.selected, 1).failures)).toContain("paid_evidence_relations");
  });

  it("fails closed when baseline and selected YAML differ beyond allowed experiment fields", () => {
    const pair = regressionPair();
    pair.selected.runs[0]!.declaredCase.review!.depth = "deep";
    const report = analyzeRegressionCohorts(pair.baseline, pair.selected, 1);
    expect(failureCodes(report.failures)).toContain("regression_yaml_delta");
  });
});
