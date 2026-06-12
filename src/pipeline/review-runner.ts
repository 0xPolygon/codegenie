import path from "node:path";
import { createRunTelemetry } from "../telemetry/run-artifacts.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import { parseDiff } from "../git/diff-parser.js";
import { classifyChangedFiles, filterDiffFiles } from "../git/file-classifier.js";
import { resolveReviewCommandTarget, resolveReviewInput } from "../git/review-input-resolver.js";
import { createPiRunner } from "../llm/pi-runner.js";
import type { LlmCallUsage, LlmRunner, ModelCallCache, PiAiAdapter } from "../llm/llm-runner.js";
import { createModelCallCache } from "../llm/model-call-cache.js";
import { createFakeRunner, shouldUseFakeRunner } from "../llm/fake-runner.js";
import { buildRepositoryIndex } from "../repo/repository-index.js";
import { buildLensRegistry } from "../skills/lens-registry.js";
import { createPromptBuilder } from "../skills/prompt-builder.js";
import { loadSkills } from "../skills/skill-loader.js";
import type {
  CodeninjaConfig,
  ConfigWarning,
  CoverageLevel,
  DiffFile,
  FileFilterDecision,
  OutputFormat,
  PacketReviewResult,
  RepositoryToolsHost,
  ResolvedReviewInput,
  ReviewCommandTarget,
  ReviewInput,
  ReviewPacket,
  ReviewPlan,
  ReviewResult,
  RunCoverageStatus
} from "../types.js";
import { CodeninjaError, errorExitCode, isCodeninjaError } from "../util/errors.js";
import { buildPlannerDossier, runPlanner } from "./planner.js";
import { buildReviewPackets, packetReviewContextFromDossier } from "./packet-builder.js";
import { runLensPackets } from "./lens-runner.js";
import { verifyFindings } from "./verifier.js";
import { dedupeRankAndComposeReview } from "./composer.js";
import { renderMarkdownReview } from "../output/markdown-renderer.js";
import { renderReviewForStdout, renderPostingSummaryForStdout } from "../output/stdout-renderer.js";
import { sha256Hex } from "../util/hashing.js";

type RunReviewOverrides = {
  repoRoot?: string;
  runArtifactDir?: string;
  format?: OutputFormat;
  postGithubComments?: boolean;
  cliLenses?: string[];
  configWarnings?: ConfigWarning[];
  writeOutput?: (text: string) => void;
  runner?: LlmRunner;
  piAdapter?: PiAiAdapter;
  onRunStart?: (run: { runId: string; runDir: string }) => void;
  onInventory?: (inventory: { filesChanged: number; keptFiles: number }) => void;
};

type RunContext = {
  runId: string;
  telemetry: TelemetryRecorder;
  logger: ReturnType<typeof createRunTelemetry>["logger"];
  budget: BudgetLedger;
  abort: AbortController;
  finalize(outcome: { status: "completed" | "failed"; errorCode?: import("../util/errors.js").CodeninjaErrorCode; exitCode: number }): Promise<void>;
};

type CoverageOptions = {
  allFiles?: DiffFile[];
  packets?: ReviewPacket[];
  degradedPlanning?: boolean;
  budgetStopped?: boolean;
};

export async function runReview(
  input: ReviewInput | ReviewCommandTarget,
  config: CodeninjaConfig,
  overrides: RunReviewOverrides = {}
): Promise<ReviewResult> {
  const repoRoot = path.resolve(overrides.repoRoot ?? process.cwd());
  const run = await startRun(config, input, repoRoot, overrides);

  try {
    const resolved = await resolveInput(input, config, run.telemetry, repoRoot);
    throwIfHardAborted(run);
    const diff = parseDiff(resolved.rawDiff);
    await run.telemetry.writeArtifact("resolved-input.json", summarizeResolvedInput(resolved));
    await run.telemetry.writeArtifact("diff.json", diff);

    const { kept, decisions } = await filterDiffFiles(resolved, diff, config, run.telemetry);
    throwIfHardAborted(run);
    await run.telemetry.writeArtifact("file-filter-decisions.json", decisions);
    overrides.onInventory?.({ filesChanged: diff.files.length, keptFiles: kept.length });
    if (isZeroWork(diff.files, kept)) {
      await validateExplicitCliLensesForZeroWork(config, repoRoot, run, overrides);
    }
    const zeroWork = await maybeZeroWork(diff.files, kept, decisions, run, overrides);
    if (zeroWork) {
      await run.finalize({ status: "completed", exitCode: 0 });
      return zeroWork;
    }

    const fileFacts = await classifyChangedFiles(resolved, kept, decisions, config, run.telemetry);
    throwIfHardAborted(run);
    await run.telemetry.writeArtifact("file-facts.json", fileFacts);
    const repoIndex = await buildRepositoryIndex(resolved, kept, fileFacts, config, run.telemetry);
    throwIfHardAborted(run);
    const services = await createPipelineServices(config, repoRoot, resolved, run, overrides);
    const dossier = await buildPlannerDossier(resolved, kept, fileFacts, decisions, repoIndex, config, run.telemetry, {
      lenses: services.lenses,
      allFiles: diff.files
    });
    const plannerResult = await runPlanner(dossier, config, run.telemetry, {
      runner: services.runner,
      promptBuilder: services.promptBuilder,
      lenses: services.lenses,
      skills: services.skills
    });
    throwIfHardAborted(run);
    const packets = await buildReviewPackets(plannerResult.plan, kept, fileFacts, repoIndex, run.telemetry, {
      config,
      enabledLenses: services.lenses.filter((lens) => lens.enabled).map((lens) => lens.id),
      reviewContext: packetReviewContextFromDossier(dossier)
    });
    throwIfHardAborted(run);
    if (isToolsHost(repoIndex.tools)) {
      repoIndex.tools.bindPackets(packets);
    }
    const packetResults = await runLensPackets(plannerResult.plan, packets, repoIndex.tools, config, run.telemetry, {
      runner: services.runner,
      promptBuilder: services.promptBuilder,
      lensRegistry: services.lensRegistry,
      signal: run.abort.signal,
      checkpoint: (stage) => run.budget.checkpoint(stage),
      diff
    });
    throwIfHardAborted(run);
    const candidateFindings = packetResults.flatMap((result) => result.findings);
    await run.telemetry.writeArtifact("candidate-findings.json", candidateFindings);
    const verified = await verifyFindings({ packetResults, packets }, repoIndex.tools, config, run.telemetry, {
      runner: services.runner,
      promptBuilder: services.promptBuilder,
      lensRegistry: services.lensRegistry,
      signal: run.abort.signal,
      checkpoint: (stage) => run.budget.checkpoint(stage),
      diff
    });
    throwIfHardAborted(run);
    const coverage = aggregateRunCoverage(plannerResult.plan, decisions, packetResults, verified, run.telemetry, {
      allFiles: diff.files,
      packets,
      degradedPlanning: plannerResult.degradedPlanning,
      budgetStopped: run.budget.stopped
    });
    discloseSkillLoadFailures(coverage, services.skillFailures);
    const finalReview = await dedupeRankAndComposeReview(verified, plannerResult.plan, resolved, coverage, config, run.telemetry, {
      runner: services.runner,
      promptBuilder: services.promptBuilder,
      packetResults,
      packets,
      diff,
      ...(overrides.postGithubComments !== undefined ? { postGithubComments: overrides.postGithubComments } : {})
    });
    if (run.budget.stopped) {
      markCoverageBudgetStopped(finalReview.coverage);
    }
    throwIfHardAborted(run);
    await run.telemetry.writeArtifact("coverage.json", {
      status: finalReview.coverage,
      records: buildCoverageRecords(diff.files, decisions, plannerResult.plan, packetResults, packets)
    });
    await renderOutputs(finalReview, overrides, run.telemetry);
    await run.finalize({ status: "completed", exitCode: 0 });
    return finalReview;
  } catch (error) {
    run.telemetry.event({
      stage: 0,
      level: "error",
      message: "review pipeline failed",
      data: {
        errorCode: isCodeninjaError(error) ? error.code : undefined,
        error: error instanceof Error ? error.message : String(error)
      }
    });
    await run.telemetry.flush();
    await run.finalize({
      status: "failed",
      ...(isCodeninjaError(error) ? { errorCode: error.code } : {}),
      exitCode: errorExitCode(error)
    });
    throw error;
  }
}

async function startRun(
  config: CodeninjaConfig,
  input: ReviewInput | ReviewCommandTarget,
  repoRoot: string,
  overrides: RunReviewOverrides
): Promise<RunContext> {
  const runArtifactDir = overrides.runArtifactDir;
  const telemetryConfig = runArtifactDir
    ? {
        ...config.telemetry,
        enabled: true,
        runDir: path.dirname(path.resolve(runArtifactDir))
      }
    : config.telemetry;
  const run = createRunTelemetry({
    telemetryConfig,
    ...(runArtifactDir ? { idFactory: () => path.basename(path.resolve(runArtifactDir)) } : {}),
    runMetadata: {
      argv: process.argv,
      repoRoot,
      review: {
        mode: input.mode,
        target: input,
        depth: config.review.depth,
        lenses: config.lenses.enabled,
        format: overrides.format ?? "markdown",
        postGithubComments: overrides.postGithubComments === true
      }
    }
  });
  const attached = await run.attachRunDirectory(repoRoot);
  overrides.onRunStart?.(attached);
  emitConfigWarnings(overrides.configWarnings ?? [], run.recorder.runId, run.logger, run.recorder);
  const budget = new BudgetLedger(config);
  const abort = new AbortController();
  const hardTimeoutMs = config.review.timeoutMs * 2;
  const hardKillTimer = setTimeout(
    () => abort.abort(new CodeninjaError("timeout", "review run exceeded hard timeout")),
    hardTimeoutMs
  );
  hardKillTimer.unref?.();
  let finalized = false;
  return {
    runId: run.recorder.runId,
    telemetry: run.recorder,
    logger: run.logger,
    budget,
    abort,
    finalize: async (outcome) => {
      if (!finalized) {
        finalized = true;
        clearTimeout(hardKillTimer);
      }
      await run.finalize(outcome);
    }
  };
}

function emitConfigWarnings(
  warnings: ConfigWarning[],
  runId: string,
  logger: ReturnType<typeof createRunTelemetry>["logger"],
  telemetry: TelemetryRecorder
): void {
  for (const warning of warnings) {
    const data = { source: warning.source, key: warning.key };
    logger.warn({
      runId,
      stage: 0,
      event: "config_warning",
      message: warning.message,
      data
    });
    telemetry.event({
      stage: 0,
      level: "warn",
      message: "config_warning",
      data: { ...data, message: warning.message }
    });
  }
}

async function createPipelineServices(
  config: CodeninjaConfig,
  repoRoot: string,
  resolved: ResolvedReviewInput,
  run: RunContext,
  overrides: RunReviewOverrides
): Promise<{
  runner: LlmRunner;
  skills: Awaited<ReturnType<typeof loadSkills>>["skills"];
  skillFailures: Awaited<ReturnType<typeof loadSkills>>["failures"];
  lensRegistry: ReturnType<typeof buildLensRegistry>;
  lenses: ReturnType<ReturnType<typeof buildLensRegistry>["enabledLenses"]>;
  promptBuilder: ReturnType<typeof createPromptBuilder>;
}> {
  const skillsResult = await loadSkills({
    repoRoot,
    extraSkillPaths: config.lenses.extraSkillPaths,
    logger: run.logger,
    telemetry: run.telemetry
  });
  const lensRegistry = buildLensRegistry(skillsResult.skills, config.lenses, overrides.cliLenses, run.logger, run.telemetry);
  const promptBuilder = createPromptBuilder(lensRegistry, { telemetry: run.telemetry });
  const cache = overrides.runner === undefined
    ? await createReviewCache(config, repoRoot, resolved, lensRegistry.registryHash(), run)
    : undefined;
  const runner = overrides.runner ?? createRunner(config, run, cache, overrides.piAdapter);
  return {
    runner,
    skills: skillsResult.skills,
    skillFailures: skillsResult.failures,
    lensRegistry,
    lenses: lensRegistry.enabledLenses(),
    promptBuilder
  };
}

async function validateExplicitCliLensesForZeroWork(
  config: CodeninjaConfig,
  repoRoot: string,
  run: RunContext,
  overrides: RunReviewOverrides
): Promise<void> {
  if (overrides.cliLenses === undefined || overrides.cliLenses.length === 0) {
    return;
  }
  const skillsResult = await loadSkills({
    repoRoot,
    extraSkillPaths: config.lenses.extraSkillPaths,
    logger: run.logger,
    telemetry: run.telemetry
  });
  buildLensRegistry(skillsResult.skills, config.lenses, overrides.cliLenses, run.logger, run.telemetry);
}

async function createReviewCache(
  config: CodeninjaConfig,
  repoRoot: string,
  resolved: ResolvedReviewInput,
  lensState: string,
  run: RunContext
): Promise<ModelCallCache | undefined> {
  if (!config.cache.enabled || shouldUseFakeRunner(config.llm)) {
    return undefined;
  }
  return createModelCallCache({
    dir: config.cache.dir,
    repoRoot,
    runFingerprint: reviewCacheFingerprint(config, repoRoot, resolved, lensState),
    logger: run.logger,
    telemetry: run.telemetry
  });
}

function reviewCacheFingerprint(
  config: CodeninjaConfig,
  repoRoot: string,
  resolved: ResolvedReviewInput,
  lensState: string
): string {
  return sha256Hex(JSON.stringify({
    repoRoot: path.resolve(repoRoot),
    mode: resolved.mode,
    baseRef: resolved.baseRef ?? null,
    headRef: resolved.headRef ?? null,
    startCommit: resolved.startCommit ?? null,
    endCommit: resolved.endCommit ?? null,
    mergeBase: resolved.mergeBase ?? null,
    headSha: resolved.headSha ?? null,
    pr: resolved.pr ? { number: resolved.pr.number, baseSha: resolved.pr.baseSha, headSha: resolved.pr.headSha } : null,
    diffHash: sha256Hex(resolved.rawDiff),
    reviewConfig: {
      lenses: config.lenses,
      review: config.review,
      git: config.git,
      classification: config.classification,
      llm: config.llm
    },
    lensState
  }));
}

function createRunner(config: CodeninjaConfig, run: RunContext, cache?: ModelCallCache, adapter?: PiAiAdapter): LlmRunner {
  if (shouldUseFakeRunner(config.llm)) {
    return createFakeRunner();
  }
  return createPiRunner({
    llmConfig: config.llm,
    telemetry: run.telemetry,
    logger: run.logger,
    ...(cache !== undefined ? { cache } : {}),
    runSignal: run.abort.signal,
    ...(adapter !== undefined ? { adapter } : {}),
    hooks: {
      checkpoint: (stage) => run.budget.checkpoint(stage),
      reserve: (stage, estimatedTokens) => run.budget.reserve(stage, estimatedTokens),
      releaseReservation: (stage, estimatedTokens) => run.budget.releaseReservation(stage, estimatedTokens),
      onUsage: (usage) => run.budget.recordUsage(usage)
    }
  });
}

function throwIfHardAborted(run: RunContext): void {
  if (!run.abort.signal.aborted) {
    return;
  }
  const reason = run.abort.signal.reason;
  if (isCodeninjaError(reason)) {
    throw reason;
  }
  throw new CodeninjaError("timeout", "review run exceeded hard timeout");
}

async function resolveInput(
  input: ReviewInput | ReviewCommandTarget,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  repoRoot: string
): Promise<ResolvedReviewInput> {
  if (input.mode === "default_branch") {
    return resolveReviewCommandTarget(input, config, telemetry, { repoRoot });
  }
  return resolveReviewInput(input, config, telemetry, { repoRoot });
}

async function maybeZeroWork(
  allFiles: DiffFile[],
  kept: DiffFile[],
  decisions: FileFilterDecision[],
  run: RunContext,
  overrides: RunReviewOverrides
): Promise<ReviewResult | undefined> {
  if (!isZeroWork(allFiles, kept)) {
    return undefined;
  }
  const totalHunks = allFiles.reduce((sum, file) => sum + file.hunks.length, 0);
  const reasons = zeroWorkReasons(allFiles, decisions);
  const coverage: RunCoverageStatus = {
    totalHunks,
    reviewedHunks: 0,
    skippedHunks: totalHunks,
    failedHunks: 0,
    coverageByLevel: { deep: 0, normal: 0, light: 0, skip: totalHunks },
    degradedPlanning: false,
    budgetStopped: false,
    verificationIncompleteCount: 0,
    partial: false,
    reasons
  };
  const result: ReviewResult = {
    summary: "Nothing to review.",
    coverage,
    findings: [],
    summaryOnlyFindings: [],
    needsHumanAttention: [],
    noFindings: true
  };
  await run.telemetry.writeArtifact("coverage.json", {
    status: coverage,
    records: buildCoverageRecords(allFiles, decisions, { diffUnderstanding: { declaredIntent: "zero-work", inferredBehavior: "zero-work" }, riskAreas: [], coverage: [] }, [], [])
  });
  await run.telemetry.writeArtifact("candidate-findings.json", []);
  await run.telemetry.writeArtifact("verification.json", []);
  await run.telemetry.writeArtifact("final-selection.json", { records: [], groups: [] });
  await run.telemetry.writeArtifact("final-findings.json", []);
  await renderOutputs(result, overrides, run.telemetry);
  run.telemetry.event({ stage: 2, level: "info", message: "zero_work_short_circuit", data: { totalHunks, reasons } });
  return result;
}

function isZeroWork(allFiles: DiffFile[], kept: DiffFile[]): boolean {
  return allFiles.length === 0 || kept.length === 0;
}

export function aggregateRunCoverage(
  plan: ReviewPlan,
  decisions: FileFilterDecision[],
  packetResults: PacketReviewResult[],
  verified: { incompleteCount: number; verificationSkipped?: boolean },
  _telemetry: TelemetryRecorder,
  opts: CoverageOptions = {}
): RunCoverageStatus {
  const packets = opts.packets ?? [];
  const packetById = new Map(packets.map((packet) => [packet.id, packet]));
  const totalHunks = opts.allFiles?.reduce((sum, file) => sum + file.hunks.length, 0) ?? plan.coverage.length;
  const coverageByLevel: Record<CoverageLevel, number> = { deep: 0, normal: 0, light: 0, skip: 0 };
  const skippedByFilter = filterSkippedHunkCount(opts.allFiles ?? [], decisions);
  coverageByLevel.skip += skippedByFilter;

  let reviewedHunks = 0;
  let failedHunks = 0;
  const reasons: string[] = [];
  for (const result of packetResults) {
    const packet = packetById.get(result.packetId);
    const packetHunks = packet?.hunks.length ?? 0;
    if (packet) {
      coverageByLevel[packet.coverage] += packetHunks;
      if (packet.degraded) {
        reasons.push(`${packet.path}: ${packet.degraded.reason}`);
      }
      for (const reason of plannerFallbackCoverageReasons(packet)) {
        reasons.push(reason);
      }
    }
    if (result.status === "completed") {
      reviewedHunks += packetHunks;
    } else if (result.status === "failed" || result.status === "skipped" || result.status === "incomplete") {
      failedHunks += packetHunks;
    }
  }
  const skippedHunks = plan.coverage.filter((decision) => decision.coverage === "skip").length + skippedByFilter;
  coverageByLevel.skip += plan.coverage.filter((decision) => decision.coverage === "skip").length;
  const unaccountedHunks = Math.max(0, totalHunks - reviewedHunks - failedHunks - skippedHunks);
  failedHunks += unaccountedHunks;
  if (failedHunks > 0) {
    reasons.push(`${failedHunks} hunk(s) could not be reviewed`);
  }
  if (verified.incompleteCount > 0) {
    reasons.push(`${verified.incompleteCount} candidate verification(s) were incomplete`);
  }
  if (verified.verificationSkipped === true) {
    reasons.push("verification disabled by config; candidates were not independently verified");
  }
  if (opts.degradedPlanning) {
    reasons.push("planner degraded; deterministic default plan used");
  }
  if (opts.budgetStopped) {
    reasons.push("budget exhausted before all review work completed");
  }
  if (plan.partialReview?.isPartial === true && plan.partialReview.reason.trim().length > 0) {
    reasons.push(plan.partialReview.reason.trim());
  }
  for (const decision of decisions.filter((decision) => decision.action === "skip").slice(0, 10)) {
    reasons.push(`${decision.path}: ${decision.reason}`);
  }

  return {
    totalHunks,
    reviewedHunks,
    skippedHunks,
    failedHunks,
    coverageByLevel,
    degradedPlanning: opts.degradedPlanning === true,
    budgetStopped: opts.budgetStopped === true,
    verificationIncompleteCount: verified.incompleteCount,
    verificationSkipped: verified.verificationSkipped === true,
    partial: failedHunks > 0 || verified.incompleteCount > 0 || opts.budgetStopped === true || plan.partialReview?.isPartial === true,
    reasons: [...new Set(reasons)]
  };
}

function plannerFallbackCoverageReasons(packet: ReviewPacket): string[] {
  return [...new Set(
    packet.hunks.flatMap((hunk) =>
      hunk.plannerFallbackReason !== undefined && hunk.plannerFallbackReason.length > 0
        ? [`${packet.path}: ${hunk.plannerFallbackReason}`]
        : []
    )
  )];
}

function markCoverageBudgetStopped(coverage: RunCoverageStatus): void {
  coverage.budgetStopped = true;
  coverage.partial = true;
  if (!coverage.reasons.includes("budget exhausted before all review work completed")) {
    coverage.reasons.push("budget exhausted before all review work completed");
  }
}

function discloseSkillLoadFailures(
  coverage: RunCoverageStatus,
  failures: Awaited<ReturnType<typeof loadSkills>>["failures"]
): void {
  for (const failure of failures.slice(0, 10)) {
    coverage.reasons.push(`skill guidance skipped: ${failure.filePath}: ${failure.reason}`);
  }
  if (failures.length > 10) {
    coverage.reasons.push(`skill guidance skipped: ${failures.length - 10} additional skill load failure(s) omitted`);
  }
}

type CoverageRecord = {
  hunkId: string;
  path: string;
  coverage: CoverageLevel;
  status: "reviewed" | "skipped" | "review_failed" | "degraded";
  reason?: string;
};

function buildCoverageRecords(
  files: DiffFile[],
  decisions: FileFilterDecision[],
  plan: ReviewPlan,
  packetResults: PacketReviewResult[],
  packets: ReviewPacket[]
): CoverageRecord[] {
  const decisionByPath = new Map(decisions.map((decision) => [decision.path, decision]));
  const planByHunk = new Map(plan.coverage.map((decision) => [decision.hunkId, decision]));
  const packetByHunk = new Map<string, ReviewPacket>();
  const packetHunkByHunk = new Map<string, ReviewPacket["hunks"][number]>();
  for (const packet of packets) {
    for (const hunk of packet.hunks) {
      packetByHunk.set(hunk.hunkId, packet);
      packetHunkByHunk.set(hunk.hunkId, hunk);
    }
  }
  const resultByPacket = new Map(packetResults.map((result) => [result.packetId, result]));
  const records: CoverageRecord[] = [];

  for (const file of files) {
    const filterDecision = decisionByPath.get(file.path);
    for (const hunk of file.hunks) {
      if (filterDecision?.action === "skip") {
        records.push({ hunkId: hunk.id, path: file.path, coverage: "skip", status: "skipped", reason: filterDecision.reason });
        continue;
      }
      const planDecision = planByHunk.get(hunk.id);
      if (planDecision?.coverage === "skip") {
        records.push({ hunkId: hunk.id, path: file.path, coverage: "skip", status: "skipped", reason: planDecision.reason });
        continue;
      }
      const packet = packetByHunk.get(hunk.id);
      const result = packet ? resultByPacket.get(packet.id) : undefined;
      if (!packet) {
        records.push({ hunkId: hunk.id, path: file.path, coverage: "normal", status: "degraded", reason: "no review packet was built" });
        continue;
      }
      if (result?.status === "completed") {
        const reason = reviewedCoverageReason(packet, packetHunkByHunk.get(hunk.id));
        records.push({
          hunkId: hunk.id,
          path: file.path,
          coverage: packet.coverage,
          status: "reviewed",
          ...(reason !== undefined ? { reason } : {})
        });
      } else {
        records.push({ hunkId: hunk.id, path: file.path, coverage: packet.coverage, status: "review_failed", reason: packetResultFailureReason(result) });
      }
    }
  }

  return records;
}

function reviewedCoverageReason(packet: ReviewPacket, hunk: ReviewPacket["hunks"][number] | undefined): string | undefined {
  const reasons = [packet.degraded?.reason, hunk?.plannerFallbackReason].filter((reason): reason is string => reason !== undefined && reason.length > 0);
  return reasons.length > 0 ? reasons.join("; ") : undefined;
}

function packetResultFailureReason(result: PacketReviewResult | undefined): string {
  if (!result) {
    return "not reviewed";
  }
  if (result.status === "skipped") {
    return "budget_stopped before dispatch";
  }
  return result.status;
}

async function renderOutputs(
  result: ReviewResult,
  overrides: RunReviewOverrides,
  telemetry: TelemetryRecorder
): Promise<void> {
  const markdown = renderMarkdownReview(result);
  await telemetry.writeArtifact("final-review.md", markdown);
  const rendered = overrides.postGithubComments
    ? renderPostingSummaryForStdout(result, overrides.format ?? "markdown", { postRequested: true })
    : renderReviewForStdout(result, overrides.format ?? "markdown");
  overrides.writeOutput?.(rendered);
}

function summarizeResolvedInput(resolved: ResolvedReviewInput): Omit<ResolvedReviewInput, "rawDiff"> & { rawDiffChars: number } {
  return {
    mode: resolved.mode,
    repoRoot: resolved.repoRoot,
    ...(resolved.baseRef !== undefined ? { baseRef: resolved.baseRef } : {}),
    ...(resolved.headRef !== undefined ? { headRef: resolved.headRef } : {}),
    ...(resolved.startCommit !== undefined ? { startCommit: resolved.startCommit } : {}),
    ...(resolved.endCommit !== undefined ? { endCommit: resolved.endCommit } : {}),
    ...(resolved.mergeBase !== undefined ? { mergeBase: resolved.mergeBase } : {}),
    ...(resolved.headSha !== undefined ? { headSha: resolved.headSha } : {}),
    ...(resolved.pr !== undefined ? { pr: resolved.pr } : {}),
    commits: resolved.commits,
    rawDiffChars: resolved.rawDiff.length
  };
}

function filterSkippedHunkCount(allFiles: DiffFile[], decisions: FileFilterDecision[]): number {
  const skipped = new Set(decisions.filter((decision) => decision.action === "skip").map((decision) => decision.path));
  return allFiles.filter((file) => skipped.has(file.path)).reduce((sum, file) => sum + file.hunks.length, 0);
}

function zeroWorkReasons(allFiles: DiffFile[], decisions: FileFilterDecision[]): string[] {
  if (allFiles.length === 0) {
    return ["diff contains no changed files"];
  }
  return decisions.filter((decision) => decision.action === "skip").map((decision) => `${decision.path}: ${decision.reason}`);
}

function isToolsHost(tools: unknown): tools is RepositoryToolsHost {
  return typeof (tools as RepositoryToolsHost).bindPackets === "function";
}

export class BudgetLedger {
  private startedAt = Date.now();
  private modelCalls = 0;
  private totalTokens = 0;
  private inFlightModelCalls = 0;
  private inFlightTokens = 0;
  stopped = false;

  constructor(private readonly config: CodeninjaConfig) {}

  checkpoint(stage: number): "ok" | "exhausted" {
    const elapsed = Date.now() - this.startedAt;
    if (elapsed >= this.config.review.timeoutMs * 2) {
      this.stopped = true;
      throw new CodeninjaError("timeout", "review run exceeded hard timeout");
    }

    const reserveStage = stage >= 9;
    if (this.runtimeExhausted(elapsed, reserveStage) || this.tokensExhausted(reserveStage) || this.modelCallsExhausted(reserveStage)) {
      this.stopped = true;
      return "exhausted";
    }
    return "ok";
  }

  recordUsage(usage: LlmCallUsage): void {
    this.modelCalls += usage.providerCalls;
    this.totalTokens += usage.totalTokens ?? 0;
  }

  reserve(stage: number, estimatedTokens = 0): "ok" | "exhausted" {
    const elapsed = Date.now() - this.startedAt;
    if (elapsed >= this.config.review.timeoutMs * 2) {
      this.stopped = true;
      throw new CodeninjaError("timeout", "review run exceeded hard timeout");
    }

    const reserveStage = stage >= 9;
    if (
      this.runtimeExhausted(elapsed, reserveStage) ||
      this.tokensExhausted(reserveStage, Math.max(0, estimatedTokens)) ||
      this.modelCallsExhausted(reserveStage, 1)
    ) {
      this.stopped = true;
      return "exhausted";
    }
    this.inFlightModelCalls += 1;
    this.inFlightTokens += Math.max(0, estimatedTokens);
    return "ok";
  }

  releaseReservation(_stage: number, estimatedTokens = 0): void {
    this.inFlightModelCalls = Math.max(0, this.inFlightModelCalls - 1);
    this.inFlightTokens = Math.max(0, this.inFlightTokens - Math.max(0, estimatedTokens));
  }

  private runtimeExhausted(elapsed: number, reserveStage: boolean): boolean {
    const limit = reserveStage ? this.config.review.timeoutMs : this.config.review.timeoutMs - runtimeReserveMs(this.config.review.timeoutMs);
    return elapsed > Math.max(0, limit);
  }

  private tokensExhausted(reserveStage: boolean, additionalReservedTokens = 0): boolean {
    const max = this.config.review.maxTotalTokens;
    if (max === undefined) {
      return false;
    }
    const limit = reserveStage ? max : unreservedBudget(max);
    const projected = this.totalTokens + this.inFlightTokens + additionalReservedTokens;
    return additionalReservedTokens > 0 ? projected > limit : projected >= limit;
  }

  private modelCallsExhausted(reserveStage: boolean, additionalReservedCalls = 0): boolean {
    const max = this.config.review.maxModelCalls;
    if (max === undefined) {
      return false;
    }
    const limit = reserveStage ? max : unreservedBudget(max);
    const projected = this.modelCalls + this.inFlightModelCalls + additionalReservedCalls;
    return additionalReservedCalls > 0 ? projected > limit : projected >= limit;
  }
}

function runtimeReserveMs(timeoutMs: number): number {
  const desiredReserve = Math.max(60_000, Math.ceil(timeoutMs * 0.1));
  const minimumPreVerificationRuntime = Math.max(1, Math.ceil(timeoutMs * 0.1));
  return Math.min(desiredReserve, Math.max(0, timeoutMs - minimumPreVerificationRuntime));
}

function unreservedBudget(max: number): number {
  return Math.max(0, max - Math.max(1, Math.ceil(max * 0.15)));
}
