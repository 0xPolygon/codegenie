import type { LlmRunner, LlmSchemaRepairInput } from "../llm/llm-runner.js";
import { SubmitPlanSchema, type SubmitPlan } from "../llm/schemas.js";
import type { LensDescriptor } from "../skills/lens-registry.js";
import {
  fenceUntrusted,
  plannerDossierPromptProjection,
  plannerDossierProjectionStats,
  stableJson,
  type PromptBuilder
} from "../skills/prompt-builder.js";
import type { Skill } from "../skills/skill-loader.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import { buildIntentSignals } from "./intent-signals.js";
import type {
  CodeninjaConfig,
  CoverageLevel,
  DossierDirectoryRollup,
  DossierFileEntry,
  DiffFile,
  DiffLine,
  FileFacts,
  FileFilterDecision,
  HunkCoverageDecision,
  HunkSymbolFacts,
  PlannerDossier,
  RepositoryIndex,
  ReviewPriority,
  ReviewQuestion,
  ReviewPlan,
  StaticSignal
} from "../types.js";
import { isFatalLlmError } from "./pipeline-utils.js";

type PlannerOptions = {
  lenses?: LensDescriptor[];
  allFiles?: DiffFile[];
};

type RunPlannerOptions = {
  runner: LlmRunner;
  promptBuilder: PromptBuilder;
  lenses: LensDescriptor[];
  skills: Skill[];
};

type PlannerChunk = {
  full: PlannerDossier;
  prompt: PlannerDossier;
};

export type PlannerRunResult = {
  plan: ReviewPlan;
  degradedPlanning: boolean;
  chunked: boolean;
};

const STATIC_SIGNALS_PER_HUNK = 5;
export const MAX_DOSSIER_PROMPT_CHARS = 120_000;
const MAX_REVIEW_QUESTIONS = 12;
const MAX_REVIEW_QUESTION_FILES = 20;
const MAX_REVIEW_QUESTION_SYMBOLS = 20;

export async function buildPlannerDossier(
  resolved: { mode: PlannerDossier["mode"]; baseRef?: string; headRef?: string; headSha?: string; mergeBase?: string; pr?: PlannerDossier["pr"]; commits: Array<{ sha: string; title: string; body: string }> },
  filtered: DiffFile[],
  fileFacts: FileFacts[],
  decisions: FileFilterDecision[],
  repoIndex: RepositoryIndex,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  opts: PlannerOptions = {}
): Promise<PlannerDossier> {
  const factsByPath = new Map(fileFacts.map((facts) => [facts.path, facts]));
  const symbolFactsByHunk = new Map(repoIndex.symbolFacts.map((facts) => [facts.hunkId, facts]));
  const staticSignalsByHunk = groupStaticSignals(repoIndex.staticSignals, filtered);
  const keptPaths = new Set(filtered.map((file) => file.path));
  const skipped = decisions.filter((decision) => decision.action === "skip");
  const totals = totalChangedLines(filtered);
  const lenses = (opts.lenses ?? []).filter((lens) => lens.enabled);
  const policyInventory = opts.allFiles ?? filtered;
  const intentSignals = buildIntentSignals({
    ...(resolved.pr !== undefined ? { pr: resolved.pr } : {}),
    commits: resolved.commits
  });

  const dossier: PlannerDossier = {
    runId: telemetry.runId,
    mode: resolved.mode,
    depth: config.review.depth,
    target: {
      ...(resolved.baseRef !== undefined ? { baseRef: truncate(resolved.baseRef, 200) } : {}),
      ...(resolved.headRef !== undefined ? { headRef: truncate(resolved.headRef, 200) } : {}),
      ...(resolved.headSha !== undefined ? { headSha: truncate(resolved.headSha, 80) } : {}),
      ...(resolved.mergeBase !== undefined ? { mergeBase: truncate(resolved.mergeBase, 80) } : {})
    },
    ...(resolved.pr !== undefined
      ? {
          pr: {
            title: truncate(resolved.pr.title, 200),
            body: truncate(resolved.pr.body, 4000),
            url: resolved.pr.url,
            baseRefName: truncate(resolved.pr.baseRefName, 200),
            headRefName: truncate(resolved.pr.headRefName, 200)
          }
        }
      : {}),
    commits: resolved.commits.map((commit) => ({
      sha: commit.sha,
      title: truncate(commit.title, 200),
      body: truncate(commit.body, 1000)
    })),
    intentSignals,
    policyFilesChanged: dedupe([
      ...decisions.map((decision) => decision.path),
      ...policyInventory.flatMap((file) => [file.path, file.oldPath].filter((entry): entry is string => entry !== undefined))
    ])
      .filter(isPolicyPath)
      .sort(),
    files: filtered.map((file) => {
      const facts = factsByPath.get(file.path);
      return {
        path: file.path,
        ...(file.oldPath !== undefined ? { oldPath: file.oldPath } : {}),
        status: file.status,
        language: facts?.language ?? file.language,
        processingMode: facts?.processingMode ?? "per-hunk",
        testStatus: facts?.testStatus ?? "unknown",
        ...(facts?.packageRoot !== undefined ? { packageRoot: facts.packageRoot } : {}),
        labels: [...(facts?.labels ?? [])].sort(),
        reviewPriority: facts?.reviewPriority ?? "normal",
        changedLines: facts?.changedLines ?? countChangedLines(file),
        hunkCount: file.hunks.length,
        ...(facts?.degraded !== undefined ? { degraded: facts.degraded } : {}),
        hunks: file.hunks.map((hunk) => {
          const signals = (staticSignalsByHunk.get(hunk.id) ?? []).slice(0, STATIC_SIGNALS_PER_HUNK);
          return {
            hunkId: hunk.id,
            header: hunk.header,
            oldStart: hunk.oldStart,
            oldLines: hunk.oldLines,
            newStart: hunk.newStart,
            newLines: hunk.newLines,
            changedNewLineNumbers: changedLineNumbers(hunk.lines, "add", "newLineNumber"),
            changedOldLineNumbers: changedLineNumbers(hunk.lines, "delete", "oldLineNumber"),
            ...(symbolFactsByHunk.get(hunk.id) !== undefined ? { symbolFacts: symbolFactsByHunk.get(hunk.id) as HunkSymbolFacts } : {}),
            staticSignals: signals,
            omittedSignalCount: Math.max(0, (staticSignalsByHunk.get(hunk.id) ?? []).length - signals.length),
            excerpt: truncate(changedExcerpt(hunk.lines), 400)
          };
        })
      };
    }),
    directories: [],
    filterSummary: {
      keptFiles: keptPaths.size,
      skippedFiles: skipped.length,
      skipped: skipped.slice(0, 50).map((decision) => ({ path: decision.path, reason: decision.reason }))
    },
    lenses: lenses.map((lens) => ({ id: lens.id, summary: lens.description })),
    totals: {
      files: decisions.length,
      keptFiles: filtered.length,
      hunks: filtered.reduce((sum, file) => sum + file.hunks.length, 0),
      addedLines: totals.added,
      deletedLines: totals.deleted
    },
    compaction: {
      level: "full",
      omitted: skipped.length > 50 ? [{ what: "filter decisions", count: skipped.length - 50, reason: "filter summary cap" }] : []
    }
  };

  telemetry.event({
    stage: 5,
    level: "info",
    message: "planner dossier built",
    data: {
      files: dossier.files.length,
      hunks: dossier.totals.hunks,
      policyFilesChanged: dossier.policyFilesChanged.length,
      intentSignals: {
        refactorLike: intentSignals.refactorLike,
        behaviorChangeLike: intentSignals.behaviorChangeLike,
        explicitlyBehaviorPreserving: intentSignals.explicitlyBehaviorPreserving,
        count: intentSignals.signals.length,
        summary: intentSignals.summary
      }
    }
  });
  await telemetry.writeArtifact("intent-signals.json", intentSignals);
  await telemetry.writeArtifact("planner-dossier.json", dossier);
  return dossier;
}

export async function runPlanner(
  dossier: PlannerDossier,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  opts: RunPlannerOptions
): Promise<PlannerRunResult> {
  telemetry.event({ stage: 5, level: "info", message: "stage_started", data: { name: "planner" } });
  const plannerDossier = compactPlannerDossier(dossier, opts.promptBuilder.renderDossier);
  const renderedDossier = opts.promptBuilder.renderDossier(plannerDossier);
  emitPlannerProjectionTelemetry(dossier, plannerDossier, renderedDossier.length, telemetry);
  if (renderedDossier.length > MAX_DOSSIER_PROMPT_CHARS) {
    return runChunkedPlanner(dossier, config, telemetry, opts);
  }

  try {
    const plan = await runPlannerCall(plannerDossier, config, telemetry, opts);
    await telemetry.writeArtifact("review-plan.json", plan);
    telemetry.event({
      stage: 5,
      level: "info",
      message: "stage_completed",
      data: { degraded: false, compaction: plannerDossier.compaction.level }
    });
    return { plan, degradedPlanning: false, chunked: false };
  } catch (error) {
    if (isFatalLlmError(error)) {
      throw error;
    }
    telemetry.event({
      stage: 5,
      level: "warn",
      message: "planner fallback used",
      data: { error: error instanceof Error ? error.message : String(error) }
    });
    const plan = defaultPlan(dossier, opts.lenses, "degraded planning: deterministic default");
    await telemetry.writeArtifact("review-plan.json", plan);
    return { plan, degradedPlanning: true, chunked: false };
  }
}

function emitPlannerProjectionTelemetry(
  fullDossier: PlannerDossier,
  promptDossier: PlannerDossier,
  renderedPromptDossierChars: number,
  telemetry: TelemetryRecorder
): void {
  const rawDossierChars = stableJson(fullDossier).length;
  const projectedDossierChars = stableJson(plannerDossierPromptProjection(promptDossier)).length;
  const stats = plannerDossierProjectionStats(promptDossier);
  telemetry.event({
    stage: 5,
    level: "info",
    message: "planner_prompt_projection",
    data: {
      rawDossierChars,
      projectedDossierChars,
      renderedPromptDossierChars,
      compaction: promptDossier.compaction.level,
      files: stats.files,
      hunks: stats.hunks,
      directoryRollupHunks: stats.directoryRollupHunks,
      richHunks: stats.richHunks,
      compactHunks: stats.compactHunks,
      hunkExcerptsIncluded: stats.hunkExcerptsIncluded,
      hunkExcerptsCompacted: stats.hunkExcerptsCompacted,
      hunkExcerptsOmitted: stats.hunkExcerptsOmitted,
      staticSignalHunksPreserved: stats.staticSignalHunksPreserved,
      staticSignalsIncluded: stats.staticSignalsIncluded,
      staticSignalsOmitted: stats.staticSignalsOmitted,
      symbolFactsIncluded: stats.symbolFactsIncluded,
      highPriorityHunks: stats.highPriorityHunks,
      testHunks: stats.testHunks,
      labeledHunks: stats.labeledHunks,
      pureDeletionHunks: stats.pureDeletionHunks
    }
  });
}

async function runPlannerCall(
  dossier: PlannerDossier,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  opts: RunPlannerOptions
): Promise<ReviewPlan> {
  const prompt = opts.promptBuilder.buildPlannerPrompt({
    dossier,
    lenses: opts.lenses,
    skills: opts.skills
  });
  const submitted = await opts.runner.runStructured<SubmitPlan>({
    stage: 5,
    prompt: prompt.prompt,
    schema: SubmitPlanSchema,
    templateVersion: prompt.templateVersion,
    timeoutMs: config.review.perPassTimeoutMs,
    schemaRepair: {
      replaceConversation: true,
      failAfterRepair: true,
      buildPrompt: (input) => buildPlannerSchemaRepairPrompt(dossier, opts.lenses, input)
    }
  });
  return validatePlan(submitted as ReviewPlan, dossier, opts.lenses, telemetry);
}

function buildPlannerSchemaRepairPrompt(
  dossier: PlannerDossier,
  lenses: LensDescriptor[],
  input: LlmSchemaRepairInput
): string {
  const invalidSubmissions = input.submitCalls.map((call, index) => ({
    index: index + 1,
    id: call.id,
    arguments: call.arguments
  }));
  const repairDossier = plannerRepairDossierSummary(dossier, lenses);
  return [
    "Repair the Stage 5 review plan output.",
    `Validation error: ${input.error}`,
    "You must call submit_plan exactly once with one complete schema-valid ReviewPlan.",
    "Do not split the plan across multiple submit_plan calls. Do not answer in plain text.",
    "If the invalid submit_plan calls contain useful risk areas, reviewQuestions, or coverage entries, merge them into the single corrected plan.",
    input.extraToolNames.length > 0
      ? `The invalid response also called non-submit tools, which are ignored in Stage 5 repair: ${input.extraToolNames.join(", ")}.`
      : "No repository tools are available in Stage 5 repair.",
    fenceUntrusted(truncate(stableJson(invalidSubmissions), 50_000), "invalid-submit-plan-calls"),
    fenceUntrusted(truncate(stableJson(repairDossier), 60_000), "planner-repair-dossier"),
    "Finish now by calling submit_plan exactly once."
  ].join("\n\n");
}

function plannerRepairDossierSummary(dossier: PlannerDossier, lenses: LensDescriptor[]): Record<string, unknown> {
  return {
    mode: dossier.mode,
    depth: dossier.depth,
    target: dossier.target,
    pr: dossier.pr === undefined
      ? undefined
      : {
          title: dossier.pr.title,
          body: truncate(dossier.pr.body, 1200),
          baseRefName: dossier.pr.baseRefName,
          headRefName: dossier.pr.headRefName
        },
    commits: dossier.commits.map((commit) => ({
      sha: commit.sha,
      title: commit.title,
      body: truncate(commit.body, 400)
    })),
    intentSignals: dossier.intentSignals,
    policyFilesChanged: dossier.policyFilesChanged,
    totals: dossier.totals,
    compaction: dossier.compaction,
    enabledLenses: lenses
      .filter((lens) => lens.enabled)
      .map((lens) => ({ id: lens.id, languages: lens.languages, summary: lens.description })),
    files: dossier.files.map((file) => ({
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      language: file.language,
      processingMode: file.processingMode,
      testStatus: file.testStatus,
      packageRoot: file.packageRoot,
      labels: file.labels,
      reviewPriority: file.reviewPriority,
      changedLines: file.changedLines,
      hunkCount: file.hunkCount,
      hunks: file.hunks.map((hunk) => ({
        hunkId: hunk.hunkId,
        header: hunk.header,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        changedNewLineNumbers: hunk.changedNewLineNumbers,
        changedOldLineNumbers: hunk.changedOldLineNumbers,
        enclosingSymbol: hunk.symbolFacts?.enclosingSymbol,
        staticSignalRuleIds: hunk.staticSignals.map((signal) => signal.ruleId)
      }))
    })),
    directories: dossier.directories.map((directory) => ({
      root: directory.root,
      fileCount: directory.fileCount,
      hunkCount: directory.hunkCount,
      changedLines: directory.changedLines,
      languages: directory.languages,
      labels: directory.labels,
      maxReviewPriority: directory.maxReviewPriority,
      testFileCount: directory.testFileCount,
      representativePaths: directory.representativePaths,
      hunkIds: directory.hunkIds,
      hunkLanguages: directory.hunkLanguages
    }))
  };
}

async function runChunkedPlanner(
  dossier: PlannerDossier,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  opts: RunPlannerOptions
): Promise<PlannerRunResult> {
  const chunks = buildPlannerChunks(dossier, opts.promptBuilder.renderDossier);
  if (chunks.length === 0) {
    const plan = defaultPlan(dossier, opts.lenses, "degraded planning: deterministic default");
    await telemetry.writeArtifact("review-plan.json", plan);
    return { plan, degradedPlanning: true, chunked: false };
  }

  await telemetry.writeArtifact("planner-dossier-chunks.json", chunks.map((chunk) => chunk.prompt));
  const plans: ReviewPlan[] = [];
  const failedRoots: string[] = [];

  for (const chunk of chunks) {
    const chunkRoot = chunk.prompt.compaction.chunkRoot ?? `chunk-${String(chunk.prompt.compaction.chunkIndex ?? plans.length + 1)}`;
    if (opts.promptBuilder.renderDossier(chunk.prompt).length > MAX_DOSSIER_PROMPT_CHARS) {
      failedRoots.push(chunkRoot);
      plans.push(defaultPlan(chunk.full, opts.lenses, `degraded planning: chunk ${chunkRoot} exceeded planner prompt budget`));
      continue;
    }
    try {
      plans.push(await runPlannerCall(chunk.prompt, config, telemetry, opts));
    } catch (error) {
      if (isFatalLlmError(error)) {
        throw error;
      }
      failedRoots.push(chunkRoot);
      telemetry.event({
        stage: 5,
        level: "warn",
        message: "planner chunk fallback used",
        data: { chunkRoot, error: error instanceof Error ? error.message : String(error) }
      });
      plans.push(defaultPlan(chunk.full, opts.lenses, `degraded planning: chunk ${chunkRoot} deterministic default`));
    }
  }

  const plan = mergeChunkPlans(plans, chunks, telemetry);
  await telemetry.writeArtifact("review-plan.json", plan);
  telemetry.event({
    stage: 5,
    level: "info",
    message: "stage_completed",
    data: { degraded: failedRoots.length > 0, chunked: true, chunks: chunks.length, failedRoots }
  });
  return { plan, degradedPlanning: failedRoots.length > 0, chunked: true };
}

export function compactPlannerDossier(
  dossier: PlannerDossier,
  renderDossier: (dossier: PlannerDossier) => string
): PlannerDossier {
  let current = dossier;
  if (fitsPlannerBudget(current, renderDossier)) {
    return current;
  }

  const excerptCount = current.files.reduce(
    (sum, file) => sum + file.hunks.filter((hunk) => hunk.excerpt !== undefined).length,
    0
  );
  if (excerptCount > 0) {
    current = recordCompaction(dropHunkExcerpts(current), {
      what: "hunk excerpts",
      count: excerptCount,
      reason: "planner prompt budget"
    });
    if (fitsPlannerBudget(current, renderDossier)) {
      return current;
    }
  }

  const omittedSignals = current.files.reduce(
    (sum, file) => sum + file.hunks.reduce((inner, hunk) => inner + Math.max(0, hunk.staticSignals.length - 1), 0),
    0
  );
  if (omittedSignals > 0) {
    current = recordCompaction(reduceStaticSignals(current), {
      what: "static signals",
      count: omittedSignals,
      reason: "planner prompt budget"
    });
    if (fitsPlannerBudget(current, renderDossier)) {
      return current;
    }
  }

  for (const file of filesByCompactionOrder(current.files)) {
    if (file.hunks.length === 0) {
      continue;
    }
    current = collapseHunkDetail(current, file.path);
    if (fitsPlannerBudget(current, renderDossier)) {
      return current;
    }
  }

  for (const file of filesByCompactionOrder(current.files)) {
    current = collapseFileDetail(current, file.path);
    if (fitsPlannerBudget(current, renderDossier)) {
      return current;
    }
  }

  return current;
}

function buildPlannerChunks(
  dossier: PlannerDossier,
  renderDossier: (dossier: PlannerDossier) => string
): PlannerChunk[] {
  const rootGroups = groupFilesByRoot(dossier.files);
  const candidates: Array<{ roots: string[]; files: DossierFileEntry[] }> = [];

  for (const group of rootGroups) {
    candidates.push(...splitPlannerRootCandidate(dossier, group.root, group.files, renderDossier));
  }

  const chunks = packPlannerChunkCandidates(dossier, candidates, renderDossier);
  return chunks.map((chunk, index) => {
    const root = chunk.prompt.compaction.chunkRoot ?? `chunk-${String(index + 1)}`;
    return {
      full: markChunkDossier(chunk.full, root, chunks.length, index + 1),
      prompt: markChunkDossier(chunk.prompt, root, chunks.length, index + 1)
    };
  });
}

function splitPlannerRootCandidate(
  dossier: PlannerDossier,
  root: string,
  files: DossierFileEntry[],
  renderDossier: (dossier: PlannerDossier) => string
): Array<{ roots: string[]; files: DossierFileEntry[] }> {
  const candidate = { roots: [root], files };
  if (plannerChunkCandidateFitsFullDetail(dossier, candidate, renderDossier) || files.length === 1) {
    return [candidate];
  }

  const subdirectoryGroups = groupFilesBySubdirectory(root, files);
  if (subdirectoryGroups.length > 1) {
    return subdirectoryGroups.flatMap((group) => {
      const subdirectoryCandidate = { roots: [group.root], files: group.files };
      if (plannerChunkCandidateFitsFullDetail(dossier, subdirectoryCandidate, renderDossier) || group.files.length === 1) {
        return [subdirectoryCandidate];
      }
      return group.files.map((file) => ({ roots: [file.path], files: [file] }));
    });
  }

  return [...files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => ({ roots: [file.path], files: [file] }));
}

function plannerChunkCandidateFitsFullDetail(
  dossier: PlannerDossier,
  candidate: { roots: string[]; files: DossierFileEntry[] },
  renderDossier: (dossier: PlannerDossier) => string
): boolean {
  return fitsPlannerBudget(chunkDossier(dossier, candidate.files, chunkRootName(candidate.roots)), renderDossier);
}

function packPlannerChunkCandidates(
  dossier: PlannerDossier,
  candidates: Array<{ roots: string[]; files: DossierFileEntry[] }>,
  renderDossier: (dossier: PlannerDossier) => string
): PlannerChunk[] {
  const chunks: PlannerChunk[] = [];
  let current: Array<{ roots: string[]; files: DossierFileEntry[] }> = [];

  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    chunks.push(buildPlannerChunk(dossier, combineChunkCandidates(current), renderDossier));
    current = [];
  };

  for (const candidate of candidates) {
    const candidateFits = plannerChunkCandidateFitsFullDetail(dossier, candidate, renderDossier);
    if (!candidateFits) {
      flush();
      chunks.push(buildPlannerChunk(dossier, candidate, renderDossier));
      continue;
    }
    const combined = combineChunkCandidates([...current, candidate]);
    if (current.length === 0 || plannerChunkCandidateFitsFullDetail(dossier, combined, renderDossier)) {
      current.push(candidate);
      continue;
    }
    flush();
    current.push(candidate);
  }
  flush();
  return chunks;
}

function buildPlannerChunk(
  dossier: PlannerDossier,
  candidate: { roots: string[]; files: DossierFileEntry[] },
  renderDossier: (dossier: PlannerDossier) => string
): PlannerChunk {
  const root = chunkRootName(candidate.roots);
  const full = chunkDossier(dossier, candidate.files, root);
  const prompt = fitsPlannerBudget(full, renderDossier)
    ? markChunkDossier(full, root, 1, 1)
    : markChunkDossier(compactPlannerDossier(full, renderDossier), root, 1, 1);
  return { full, prompt };
}

function combineChunkCandidates(
  candidates: Array<{ roots: string[]; files: DossierFileEntry[] }>
): { roots: string[]; files: DossierFileEntry[] } {
  return {
    roots: dedupe(candidates.flatMap((candidate) => candidate.roots)).sort(),
    files: candidates.flatMap((candidate) => candidate.files).sort((a, b) => a.path.localeCompare(b.path))
  };
}

function chunkRootName(roots: string[]): string {
  const sorted = dedupe(roots).sort();
  if (sorted.length <= 3) {
    return sorted.join("+");
  }
  const first = sorted[0] ?? "chunk";
  const last = sorted[sorted.length - 1] ?? first;
  return `${first}..${last}`;
}

function mergeChunkPlans(
  plans: ReviewPlan[],
  chunks: PlannerChunk[],
  telemetry: TelemetryRecorder
): ReviewPlan {
  const coverage: ReviewPlan["coverage"] = [];
  const seenHunks = new Set<string>();
  for (const plan of plans) {
    for (const decision of plan.coverage) {
      if (seenHunks.has(decision.hunkId)) {
        telemetry.event({
          stage: 5,
          level: "warn",
          message: "planner_duplicate_chunk_hunk",
          file: decision.path,
          data: { hunkId: decision.hunkId }
        });
        continue;
      }
      coverage.push(decision);
      seenHunks.add(decision.hunkId);
    }
  }

  const riskAreas = dedupeByJson(plans.flatMap((plan) => plan.riskAreas));
  const reviewQuestions = dedupeReviewQuestions(plans.flatMap((plan) => plan.reviewQuestions ?? [])).slice(0, MAX_REVIEW_QUESTIONS);
  const behaviors = dedupe(
    plans.map((plan, index) => {
      const root = chunks[index]?.prompt.compaction.chunkRoot ?? `chunk-${String(index + 1)}`;
      return `${root}: ${plan.diffUnderstanding.inferredBehavior}`;
    })
  );
  const intents = dedupe(plans.map((plan) => plan.diffUnderstanding.declaredIntent));
  const partialPlans = plans.flatMap((plan) => (plan.partialReview ? [plan.partialReview] : []));

  return {
    diffUnderstanding: {
      declaredIntent: intents[0] ?? "Review local diff.",
      inferredBehavior: behaviors.join("\n")
    },
    ...(plans[0]?.intentSignals !== undefined ? { intentSignals: plans[0].intentSignals } : {}),
    riskAreas,
    ...(reviewQuestions.length > 0 ? { reviewQuestions } : {}),
    coverage,
    ...(partialPlans.length > 0
      ? {
          partialReview: {
            isPartial: partialPlans.some((partial) => partial.isPartial),
            reason: dedupe(partialPlans.map((partial) => partial.reason)).join("; "),
            reviewedHunks: partialPlans.reduce((sum, partial) => sum + partial.reviewedHunks, 0),
            totalHunks: partialPlans.reduce((sum, partial) => sum + partial.totalHunks, 0)
          }
        }
      : {})
  };
}

function fitsPlannerBudget(dossier: PlannerDossier, renderDossier: (dossier: PlannerDossier) => string): boolean {
  return renderDossier(dossier).length <= MAX_DOSSIER_PROMPT_CHARS;
}

function recordCompaction(
  dossier: PlannerDossier,
  omitted: PlannerDossier["compaction"]["omitted"][number]
): PlannerDossier {
  return {
    ...dossier,
    compaction: {
      ...dossier.compaction,
      level: dossier.compaction.level === "chunked" ? "chunked" : "compacted",
      omitted: [...dossier.compaction.omitted, omitted]
    }
  };
}

function dropHunkExcerpts(dossier: PlannerDossier): PlannerDossier {
  return {
    ...dossier,
    files: dossier.files.map((file) => ({
      ...file,
      hunks: file.hunks.map((hunk) => {
        const { excerpt: _excerpt, ...withoutExcerpt } = hunk;
        return withoutExcerpt;
      })
    }))
  };
}

function reduceStaticSignals(dossier: PlannerDossier): PlannerDossier {
  return {
    ...dossier,
    files: dossier.files.map((file) => ({
      ...file,
      hunks: file.hunks.map((hunk) => ({
        ...hunk,
        staticSignals: hunk.staticSignals.slice(0, 1),
        omittedSignalCount: hunk.omittedSignalCount + Math.max(0, hunk.staticSignals.length - 1)
      }))
    }))
  };
}

function collapseHunkDetail(dossier: PlannerDossier, filePath: string): PlannerDossier {
  const file = dossier.files.find((candidate) => candidate.path === filePath);
  if (!file || file.hunks.length === 0) {
    return dossier;
  }
  const hunkIds = file.hunks.map((hunk) => hunk.hunkId);
  return recordCompaction(
    {
      ...dossier,
      files: dossier.files.map((candidate) => (candidate.path === filePath ? { ...candidate, hunks: [] } : candidate)),
      directories: mergeDirectoryRollup(dossier.directories, file, hunkIds)
    },
    {
      what: "per-hunk detail",
      count: hunkIds.length,
      reason: "planner prompt budget"
    }
  );
}

function collapseFileDetail(dossier: PlannerDossier, filePath: string): PlannerDossier {
  const file = dossier.files.find((candidate) => candidate.path === filePath);
  if (!file) {
    return dossier;
  }
  const hunkIds = file.hunks.map((hunk) => hunk.hunkId);
  return recordCompaction(
    {
      ...dossier,
      files: dossier.files.filter((candidate) => candidate.path !== filePath),
      directories: hunkIds.length > 0 ? mergeDirectoryRollup(dossier.directories, file, hunkIds) : dossier.directories
    },
    {
      what: "per-file detail",
      count: 1,
      reason: "planner prompt budget"
    }
  );
}

function mergeDirectoryRollup(
  directories: DossierDirectoryRollup[],
  file: DossierFileEntry,
  hunkIds: string[]
): DossierDirectoryRollup[] {
  const root = dossierFileRoot(file);
  const existing = directories.find((directory) => directory.root === root);
  const addition: DossierDirectoryRollup = {
    root,
    fileCount: 1,
    hunkCount: file.hunkCount,
    changedLines: file.changedLines,
    languages: [file.language],
    labels: file.labels,
    maxReviewPriority: file.reviewPriority,
    testFileCount: file.testStatus === "test" ? 1 : 0,
    representativePaths: [file.path],
    hunkIds,
    hunkLanguages: Object.fromEntries(hunkIds.map((hunkId) => [hunkId, file.language]))
  };
  const merged = existing ? mergeRollups(existing, addition) : normalizeRollup(addition);
  return [
    ...directories.filter((directory) => directory.root !== root),
    merged
  ].sort((a, b) => a.root.localeCompare(b.root));
}

function mergeRollups(a: DossierDirectoryRollup, b: DossierDirectoryRollup): DossierDirectoryRollup {
  return normalizeRollup({
    root: a.root,
    fileCount: a.fileCount + b.fileCount,
    hunkCount: a.hunkCount + b.hunkCount,
    changedLines: a.changedLines + b.changedLines,
    languages: [...a.languages, ...b.languages],
    labels: [...a.labels, ...b.labels],
    maxReviewPriority: strongestPriority(a.maxReviewPriority, b.maxReviewPriority),
    testFileCount: a.testFileCount + b.testFileCount,
    representativePaths: [...a.representativePaths, ...b.representativePaths],
    hunkIds: [...a.hunkIds, ...b.hunkIds],
    hunkLanguages: { ...a.hunkLanguages, ...b.hunkLanguages }
  });
}

function normalizeRollup(rollup: DossierDirectoryRollup): DossierDirectoryRollup {
  return {
    ...rollup,
    languages: dedupe(rollup.languages).sort(),
    labels: dedupe(rollup.labels).sort(),
    representativePaths: dedupe(rollup.representativePaths).sort().slice(0, 5),
    hunkIds: dedupe(rollup.hunkIds).sort(),
    hunkLanguages: Object.fromEntries(Object.entries(rollup.hunkLanguages).sort(([a], [b]) => a.localeCompare(b)))
  };
}

function groupFilesByRoot(files: DossierFileEntry[]): Array<{ root: string; files: DossierFileEntry[] }> {
  const groups = new Map<string, DossierFileEntry[]>();
  for (const file of files) {
    const root = dossierFileRoot(file);
    groups.set(root, [...(groups.get(root) ?? []), file]);
  }
  return [...groups.entries()]
    .map(([root, groupFiles]) => ({ root, files: [...groupFiles].sort((a, b) => a.path.localeCompare(b.path)) }))
    .sort((a, b) => a.root.localeCompare(b.root));
}

function groupFilesBySubdirectory(root: string, files: DossierFileEntry[]): Array<{ root: string; files: DossierFileEntry[] }> {
  const groups = new Map<string, DossierFileEntry[]>();
  for (const file of files) {
    const subdirectory = dossierSubdirectoryRoot(root, file.path);
    groups.set(subdirectory, [...(groups.get(subdirectory) ?? []), file]);
  }
  return [...groups.entries()]
    .map(([groupRoot, groupFiles]) => ({ root: groupRoot, files: [...groupFiles].sort((a, b) => a.path.localeCompare(b.path)) }))
    .sort((a, b) => a.root.localeCompare(b.root));
}

function chunkDossier(base: PlannerDossier, files: DossierFileEntry[], root: string): PlannerDossier {
  return {
    ...base,
    files,
    directories: [],
    compaction: {
      level: "chunked",
      omitted: [...base.compaction.omitted],
      chunkCount: 1,
      chunkIndex: 1,
      chunkRoot: root
    }
  };
}

function markChunkDossier(dossier: PlannerDossier, root: string, chunkCount: number, chunkIndex: number): PlannerDossier {
  return {
    ...dossier,
    compaction: {
      ...dossier.compaction,
      level: "chunked",
      chunkCount,
      chunkIndex,
      chunkRoot: root
    }
  };
}

function filesByCompactionOrder(files: DossierFileEntry[]): DossierFileEntry[] {
  return [...files].sort((a, b) => priorityCompactionRank(a.reviewPriority) - priorityCompactionRank(b.reviewPriority) || a.path.localeCompare(b.path));
}

function dossierFileRoot(file: DossierFileEntry): string {
  if (file.packageRoot && file.packageRoot.trim().length > 0) {
    return file.packageRoot;
  }
  const slash = file.path.indexOf("/");
  return slash === -1 ? "." : file.path.slice(0, slash);
}

function dossierSubdirectoryRoot(root: string, filePath: string): string {
  if (root === ".") {
    const slash = filePath.indexOf("/");
    if (slash === -1) {
      return filePath;
    }
    const nextSlash = filePath.indexOf("/", slash + 1);
    return nextSlash === -1 ? filePath : filePath.slice(0, nextSlash);
  }
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (!filePath.startsWith(prefix)) {
    return filePath;
  }
  const remainder = filePath.slice(prefix.length);
  const slash = remainder.indexOf("/");
  return slash === -1 ? filePath : `${root}/${remainder.slice(0, slash)}`;
}

function priorityCompactionRank(priority: ReviewPriority): number {
  return { low: 0, normal: 1, high: 2, critical: 3 }[priority];
}

function strongestPriority(a: ReviewPriority, b: ReviewPriority): ReviewPriority {
  return priorityCompactionRank(a) >= priorityCompactionRank(b) ? a : b;
}

function dedupeByJson<T>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = JSON.stringify(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function defaultPlan(
  dossier: PlannerDossier,
  lenses: LensDescriptor[],
  reason: string
): ReviewPlan {
  return {
    diffUnderstanding: {
      declaredIntent: deterministicDeclaredIntent(dossier),
      inferredBehavior: "unavailable (degraded planning)"
    },
    ...(dossier.intentSignals !== undefined ? { intentSignals: dossier.intentSignals } : {}),
    riskAreas: [],
    coverage: dossier.files.flatMap((file) =>
      file.hunks.map((hunk) => ({
        hunkId: hunk.hunkId,
        path: file.path,
        coverage: "normal" as CoverageLevel,
        lenses: defaultLensesForFile(file.language, lenses),
        surroundingContextHints: [],
        reason
      }))
    )
  };
}

function deterministicDeclaredIntent(dossier: PlannerDossier): string {
  const prTitle = dossier.pr?.title?.trim();
  if (prTitle && prTitle.length > 0) {
    return prTitle;
  }
  const commitTitle = dossier.commits[0]?.title?.trim();
  if (commitTitle && commitTitle.length > 0) {
    return commitTitle;
  }
  return "Review local diff.";
}

function validatePlan(
  plan: ReviewPlan,
  dossier: PlannerDossier,
  lenses: LensDescriptor[],
  telemetry: TelemetryRecorder
): ReviewPlan {
  const knownHunks = new Set([
    ...dossier.files.flatMap((file) => file.hunks.map((hunk) => hunk.hunkId)),
    ...dossier.directories.flatMap((directory) => directory.hunkIds)
  ]);
  const enabledLensIds = new Set(lenses.filter((lens) => lens.enabled).map((lens) => lens.id));
  const hunkLanguageById = new Map([
    ...dossier.files.flatMap((file) => file.hunks.map((hunk) => [hunk.hunkId, file.language] as const)),
    ...dossier.directories.flatMap((directory) => Object.entries(directory.hunkLanguages))
  ]);
  const coverageByHunk = new Map<string, HunkCoverageDecision>();
  const coverageOrder: string[] = [];
  const reviewQuestions = normalizeReviewQuestions(plan.reviewQuestions ?? [], dossier, telemetry);

  for (const decision of plan.coverage ?? []) {
    if (!knownHunks.has(decision.hunkId)) {
      telemetry.event({
        stage: 5,
        level: "warn",
        message: "planner_unknown_hunk",
        file: decision.path,
        data: { hunkId: decision.hunkId }
      });
      continue;
    }
    if (decision.coverage === "skip" && decision.reason.trim().length === 0) {
      telemetry.event({
        stage: 5,
        level: "warn",
        message: "planner_invalid_skip",
        file: decision.path,
        data: { hunkId: decision.hunkId }
      });
      const normalizedDecision: HunkCoverageDecision = {
        ...decision,
        coverage: "normal",
        lenses: defaultLensesForFile(hunkLanguageById.get(decision.hunkId) ?? "", lenses),
        surroundingContextHints: decision.surroundingContextHints ?? [],
        reason: "planner_invalid_skip"
      };
      const existing = coverageByHunk.get(decision.hunkId);
      if (existing) {
        coverageByHunk.set(decision.hunkId, mergeDuplicateDecision(existing, normalizedDecision, true));
      } else {
        coverageByHunk.set(decision.hunkId, normalizedDecision);
        coverageOrder.push(decision.hunkId);
      }
      continue;
    }
    const survivingLenses = decision.lenses.filter((lens) => {
      const known = enabledLensIds.has(lens);
      if (!known) {
        telemetry.event({
          stage: 5,
          level: "warn",
          message: "planner_unknown_lens",
          lensId: lens,
          file: decision.path,
          data: { hunkId: decision.hunkId }
        });
      }
      return known;
    });
    const normalizedDecision = { ...decision, lenses: survivingLenses };
    const existing = coverageByHunk.get(decision.hunkId);
    if (existing) {
      const conflict = !sameCoverageDecision(existing, normalizedDecision);
      telemetry.event({
        stage: 5,
        level: "warn",
        message: conflict ? "planner_conflicting_duplicate_hunk" : "planner_duplicate_hunk",
        file: decision.path,
        data: { hunkId: decision.hunkId, degraded: conflict }
      });
      coverageByHunk.set(decision.hunkId, mergeDuplicateDecision(existing, normalizedDecision, conflict));
      continue;
    }
    coverageByHunk.set(decision.hunkId, normalizedDecision);
    coverageOrder.push(decision.hunkId);
  }

  return {
    diffUnderstanding: plan.diffUnderstanding,
    ...(dossier.intentSignals !== undefined ? { intentSignals: dossier.intentSignals } : {}),
    riskAreas: (plan.riskAreas ?? []).map((area) => ({
      ...area,
      suggestedLenses: area.suggestedLenses.filter((lens) => enabledLensIds.has(lens))
    })),
    ...(reviewQuestions.length > 0 ? { reviewQuestions } : {}),
    coverage: coverageOrder.flatMap((hunkId) => {
      const decision = coverageByHunk.get(hunkId);
      return decision === undefined ? [] : [decision];
    }),
    ...(plan.partialReview !== undefined ? { partialReview: plan.partialReview } : {})
  };
}

function sameCoverageDecision(a: HunkCoverageDecision, b: HunkCoverageDecision): boolean {
  return a.path === b.path &&
    a.coverage === b.coverage &&
    JSON.stringify([...a.lenses].sort()) === JSON.stringify([...b.lenses].sort()) &&
    JSON.stringify(dedupeByJson(a.surroundingContextHints)) === JSON.stringify(dedupeByJson(b.surroundingContextHints)) &&
    a.reason === b.reason;
}

function normalizeReviewQuestions(
  questions: ReviewQuestion[],
  dossier: PlannerDossier,
  telemetry: TelemetryRecorder
): ReviewQuestion[] {
  const knownFiles = new Set(dossier.files.flatMap((file) => [file.path, ...(file.oldPath !== undefined ? [file.oldPath] : [])]));
  const knownSymbols = new Set(dossier.files.flatMap((file) =>
    file.hunks.flatMap((hunk) => [
      hunk.symbolFacts?.enclosingSymbol,
      hunk.symbolFacts?.signature
    ]).filter((value): value is string => value !== undefined && value.trim().length > 0)
  ));
  const normalized: ReviewQuestion[] = [];
  const seen = new Set<string>();

  for (const question of questions.slice(0, MAX_REVIEW_QUESTIONS * 2)) {
    const text = normalizeWhitespace(question.question);
    const whyItMatters = normalizeWhitespace(question.whyItMatters);
    const files = cleanStrings(question.files)
      .map(stripLocationSuffix)
      .filter((file) => knownFiles.has(file))
      .slice(0, MAX_REVIEW_QUESTION_FILES);
    const symbols = cleanStrings(question.symbols)
      .filter((symbol) => knownSymbols.size === 0 || knownSymbols.has(symbol) || symbolMentionedInDossier(symbol, dossier))
      .slice(0, MAX_REVIEW_QUESTION_SYMBOLS);
    const evidenceHint = question.evidenceHint === undefined ? undefined : normalizeWhitespace(question.evidenceHint);
    const id = normalizeQuestionId(question.id, text, normalized.length + 1);
    const dropReason =
      text.length === 0
        ? "empty_question"
        : whyItMatters.length === 0
          ? "empty_why_it_matters"
          : files.length === 0 && symbols.length === 0
            ? "no_known_files_or_symbols"
            : isVagueReviewQuestion(text)
              ? "vague_question"
              : undefined;
    if (dropReason !== undefined) {
      telemetry.event({
        stage: 5,
        level: "warn",
        message: "planner_review_question_dropped",
        data: {
          reason: dropReason,
          id: question.id,
          question: text,
          files: question.files,
          symbols: question.symbols
        }
      });
      continue;
    }

    const key = `${normalizeQuestionForDedupe(text)}|${files.join(",")}|${symbols.join(",")}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({
      id,
      question: text,
      whyItMatters,
      files,
      symbols,
      ...(evidenceHint !== undefined && evidenceHint.length > 0 ? { evidenceHint } : {})
    });
    if (normalized.length >= MAX_REVIEW_QUESTIONS) {
      break;
    }
  }

  if (questions.length > 0) {
    telemetry.event({
      stage: 5,
      level: "info",
      message: "planner_review_questions",
      data: {
        submitted: questions.length,
        kept: normalized.length,
        maxQuestions: MAX_REVIEW_QUESTIONS
      }
    });
  }

  return normalized;
}

function dedupeReviewQuestions(questions: ReviewQuestion[]): ReviewQuestion[] {
  const seen = new Set<string>();
  const result: ReviewQuestion[] = [];
  for (const question of questions) {
    const key = `${normalizeQuestionForDedupe(question.question)}|${cleanStrings(question.files).join(",")}|${cleanStrings(question.symbols).join(",")}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(question);
  }
  return result;
}

function normalizeQuestionId(id: string, question: string, index: number): string {
  const normalized = id.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  if (normalized.length > 0) {
    return normalized;
  }
  const words = question.toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .slice(0, 8)
    .join("-");
  return words.length > 0 ? `q${String(index)}-${words}`.slice(0, 80) : `q${String(index)}`;
}

function normalizeQuestionForDedupe(question: string): string {
  return normalizeWhitespace(question)
    .toLowerCase()
    .replace(/[`"'’]/gu, "")
    .replace(/[^a-z0-9_./:-]+/gu, " ")
    .trim();
}

function normalizeWhitespace(input: string): string {
  return input.trim().replace(/\s+/gu, " ");
}

function cleanStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

function stripLocationSuffix(value: string): string {
  return value.trim().replace(/:\d+(?:-\d+)?$/u, "");
}

function symbolMentionedInDossier(symbol: string, dossier: PlannerDossier): boolean {
  const needle = symbol.toLowerCase();
  return dossier.files.some((file) =>
    file.hunks.some((hunk) =>
      hunk.header.toLowerCase().includes(needle) ||
      (hunk.excerpt ?? "").toLowerCase().includes(needle) ||
      (hunk.symbolFacts?.enclosingSymbol ?? "").toLowerCase().includes(needle) ||
      (hunk.symbolFacts?.signature ?? "").toLowerCase().includes(needle)
    )
  );
}

function isVagueReviewQuestion(question: string): boolean {
  const normalized = normalizeQuestionForDedupe(question).replace(/[?.!]+$/u, "");
  return /^(review|check|verify|inspect)\s+(this|the)\s+(file|change|diff|code|hunk)s?$/u.test(normalized) ||
    /^(is|are)\s+(this|these)\s+(safe|ok|correct)$/u.test(normalized);
}

function mergeDuplicateDecision(
  a: HunkCoverageDecision,
  b: HunkCoverageDecision,
  conflict: boolean
): HunkCoverageDecision {
  const coverage = strongestCoverage(a.coverage, b.coverage);
  const selected = coverage === b.coverage && coverage !== a.coverage ? b : a;
  return {
    ...selected,
    coverage,
    lenses: dedupe([...a.lenses, ...b.lenses]),
    surroundingContextHints: dedupeByJson([...a.surroundingContextHints, ...b.surroundingContextHints]),
    reason: conflict ? `planner duplicate coverage decisions merged: ${dedupe([a.reason, b.reason]).join("; ")}` : selected.reason
  };
}

function strongestCoverage(a: CoverageLevel, b: CoverageLevel): CoverageLevel {
  return coverageRank(a) <= coverageRank(b) ? a : b;
}

function coverageRank(coverage: CoverageLevel): number {
  return { deep: 0, normal: 1, light: 2, skip: 3 }[coverage];
}

function defaultLensesForFile(language: string, lenses: LensDescriptor[]): string[] {
  const enabled = lenses.filter((lens) => lens.enabled);
  const selected = enabled.filter((lens) => lens.id.startsWith("core/"));
  const languageLens = enabled.find((lens) => {
    if (language === "go") {
      return lens.id === "lang/go";
    }
    if (["typescript", "javascript", "ts", "js", "tsx", "jsx"].includes(language)) {
      return lens.id === "lang/typescript";
    }
    return lens.languages.includes(language);
  });
  if (languageLens) {
    selected.push(languageLens);
  }
  return dedupe(selected.map((lens) => lens.id));
}

function groupStaticSignals(signals: StaticSignal[], files: DiffFile[]): Map<string, StaticSignal[]> {
  const hunkByPath = new Map<string, Array<{ id: string; side: "RIGHT" | "LEFT"; start: number; end: number }>>();
  for (const file of files) {
    for (const hunk of file.hunks) {
      const right = {
        id: hunk.id,
        side: "RIGHT" as const,
        start: hunk.newStart,
        end: Math.max(hunk.newStart, hunk.newStart + hunk.newLines - 1)
      };
      const left = {
        id: hunk.id,
        side: "LEFT" as const,
        start: hunk.oldStart,
        end: Math.max(hunk.oldStart, hunk.oldStart + hunk.oldLines - 1)
      };
      hunkByPath.set(file.path, [...(hunkByPath.get(file.path) ?? []), right]);
      const leftPath = file.oldPath ?? file.path;
      hunkByPath.set(leftPath, [...(hunkByPath.get(leftPath) ?? []), left]);
      if (leftPath !== file.path) {
        hunkByPath.set(file.path, [...(hunkByPath.get(file.path) ?? []), left]);
      }
    }
  }

  const grouped = new Map<string, StaticSignal[]>();
  for (const signal of signals) {
    const hunk = (hunkByPath.get(signal.path) ?? []).find((candidate) =>
      signal.line === undefined
        ? false
        : (signal.side === undefined || signal.side === candidate.side) &&
          signal.line >= candidate.start &&
          signal.line <= candidate.end
    );
    if (!hunk) {
      continue;
    }
    const list = grouped.get(hunk.id) ?? [];
    list.push(signal);
    grouped.set(hunk.id, list);
  }
  for (const list of grouped.values()) {
    list.sort(compareStaticSignals);
  }
  return grouped;
}

function compareStaticSignals(a: StaticSignal, b: StaticSignal): number {
  const confidenceOrder = { high: 0, medium: 1, low: 2 };
  return confidenceOrder[a.confidence] - confidenceOrder[b.confidence] || a.ruleId.localeCompare(b.ruleId);
}

function totalChangedLines(files: DiffFile[]): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "add") {
          added += 1;
        } else if (line.kind === "delete") {
          deleted += 1;
        }
      }
    }
  }
  return { added, deleted };
}

function countChangedLines(file: DiffFile): number {
  return file.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.kind !== "context").length, 0);
}

function changedLineNumbers<K extends "oldLineNumber" | "newLineNumber">(
  lines: DiffLine[],
  kind: DiffLine["kind"],
  key: K
): number[] {
  return lines.flatMap((line) => (line.kind === kind && line[key] !== undefined ? [line[key] as number] : []));
}

function changedExcerpt(lines: DiffLine[]): string {
  return lines
    .filter((line) => line.kind !== "context")
    .map((line) => `${line.kind === "add" ? "+" : "-"}${line.content}`)
    .join("\n");
}

function isPolicyPath(filePath: string): boolean {
  return filePath === "codeninja.toml" || filePath.startsWith(".codeninja/skills/");
}

function truncate(input: string, maxChars: number): string {
  return input.length <= maxChars ? input : input.slice(0, maxChars).trimEnd();
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}
