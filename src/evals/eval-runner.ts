import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { applyRepoConfigLayer } from "../config/config-loader.js";
import {
  MAX_DEEP_ENSEMBLE_PASSES,
  packedToolBudgetModeSchema,
  reasoningLevelSchema,
  reviewDepthSchema,
  reviewMaxTimeMinutesSchema,
  severitySchema
} from "../config/schema.js";
import { createGitClient } from "../git/git-client.js";
import { runReview } from "../pipeline/review-runner.js";
import type {
  CodegenieConfig,
  EvalArtifacts,
  EvalCase,
  EvalCaseResult,
  EvalFindingExpectation,
  EvalRunInfo,
  EvalScore,
  FinalFinding,
  ReviewCommandTarget
} from "../types.js";
import { runGit } from "../git/subprocess.js";
import { canonicalArtifactPath } from "../telemetry/run-artifacts.js";
import { CodegenieError, isCodegenieError } from "../util/errors.js";
import { sha256Hex } from "../util/hashing.js";
import { resolveCodegenieRuntimeProvenance } from "../util/runtime-provenance.js";
import {
  allocateRunDir,
  copyReviewOutput,
  copyTelemetryArtifacts,
  findPreviousRun,
  loadEvalArtifacts,
  resolveTelemetryDir,
  writeEvalRunInfo
} from "./eval-artifacts.js";
import { compareToPrevious, renderEvalCompareText } from "./eval-compare.js";
import { aggregateRepeatScores, scoreEvalRun } from "./eval-scoring.js";

export type EvalSuite = {
  dir: string;
  cases: Array<{ file: string; evalCase: EvalCase; caseHash: string }>;
};

export type EvalRunOptions = {
  cacheOverride?: boolean;
  config: CodegenieConfig;
};

const positiveNumberSchema = z.number().positive();
const positiveIntSchema = z.number().int().positive();
const expectationTierSchema = z.enum(["required", "optional"]);
const findingCategorySchema = z.enum([
  "logic_bug",
  "correctness",
  "security",
  "performance",
  "architecture",
  "testing",
  "maintainability"
]);

const expectationSchema = z
  .object({
    id: z.string().min(1),
    tier: expectationTierSchema.optional(),
    path: z.string().min(1).optional(),
    lineRange: z.tuple([positiveIntSchema, positiveIntSchema]).optional(),
    category: findingCategorySchema.optional(),
    severityAtLeast: severitySchema.optional(),
    titlePattern: z.string().min(1).optional(),
    failureModePattern: z.string().min(1).optional(),
    minRecallRate: z.number().min(0).max(1).optional(),
    minCandidateRate: z.number().min(0).max(1).optional()
  })
  .strict()
  .superRefine((expectation, ctx) => {
    if (expectation.lineRange !== undefined && expectation.lineRange[0] > expectation.lineRange[1]) {
      ctx.addIssue({ code: "custom", path: ["lineRange"], message: "lineRange must be [start, end] with start <= end" });
    }
    const matchingFields: Array<keyof EvalFindingExpectation> = [
      "path",
      "lineRange",
      "category",
      "severityAtLeast",
      "titlePattern",
      "failureModePattern"
    ];
    if (matchingFields.every((field) => expectation[field] === undefined)) {
      ctx.addIssue({ code: "custom", message: "expectation must include at least one matching field" });
    }
    for (const field of ["titlePattern", "failureModePattern"] as const) {
      const pattern = expectation[field];
      if (pattern === undefined) {
        continue;
      }
      try {
        new RegExp(pattern, "i");
      } catch {
        ctx.addIssue({ code: "custom", path: [field], message: "pattern must compile as an ECMAScript regular expression" });
      }
    }
  });

const caseSchema = z
  .object({
    name: z.string().min(1),
    repeat: positiveIntSchema.optional(),
    repo: z
      .object({
        external: z.string().min(1).optional(),
        fixture: z.string().min(1).optional()
      })
      .strict()
      .optional(),
    command: z
      .object({
        pr: positiveIntSchema.optional(),
        branch: z.string().min(1).optional(),
        head: z.string().min(1).optional(),
        base: z.string().min(1).optional(),
        target: z.string().min(1).optional()
      })
      .strict()
      .optional(),
    review: z
      .object({
        depth: reviewDepthSchema.optional(),
        lenses: z.array(z.string().min(1)).optional(),
        maxFindings: positiveIntSchema.optional(),
        concurrency: positiveIntSchema.optional(),
        budgetBoost: positiveNumberSchema.optional(),
        packSameFileHunks: z.boolean().optional(),
        packedToolBudgetMode: packedToolBudgetModeSchema.optional(),
        maxTimeMinutes: reviewMaxTimeMinutesSchema.optional(),
        maxBudgetTokens: positiveIntSchema.optional(),
        deepEnsemblePasses: positiveIntSchema.max(MAX_DEEP_ENSEMBLE_PASSES).optional(),
        adaptiveSecondPass: z.boolean().optional(),
        verify: z.boolean().optional(),
        cache: z.boolean().optional(),
        cacheDir: z.string().min(1).optional(),
        debug: z.boolean().optional(),
        provider: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        reasoning: reasoningLevelSchema.optional()
      })
      .strict()
      .optional(),
    llm: z
      .object({
        provider: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        reasoning: reasoningLevelSchema.optional(),
        maxConcurrentCalls: positiveIntSchema.optional()
      })
      .strict()
      .optional(),
    logs: z
      .object({
        dir: z.string().min(1).optional()
      })
      .strict()
      .optional(),
    artifacts: z
      .object({
        path: z.string().min(1)
      })
      .strict()
      .optional(),
    expect: z
      .object({
        minFindings: z.number().nonnegative().optional(),
        maxFindings: positiveNumberSchema.optional(),
        maxDuplicateGroups: positiveNumberSchema.optional(),
        maxCostUSD: positiveNumberSchema.optional(),
        maxElapsedSeconds: positiveNumberSchema.optional(),
        maxModelCalls: positiveNumberSchema.optional(),
        maxToolCalls: positiveNumberSchema.optional(),
        maxPromptCharsByStage: z.record(z.string(), positiveIntSchema).optional(),
        reviewCompleteness: z.enum(["complete", "partial"]).optional(),
        maxBudgetOverruns: z.number().int().nonnegative().optional(),
        maxToolBudgetRejections: z.number().int().nonnegative().optional(),
        maxDegradedHunks: z.number().int().nonnegative().optional(),
        maxUnresolvedNotesSuppressed: z.number().int().nonnegative().optional()
      })
      .strict()
      .optional(),
    should_find: z.array(expectationSchema).optional(),
    should_find_candidate: z.array(expectationSchema).optional(),
    should_not_find: z.array(expectationSchema).optional()
  })
  .strict()
  .superRefine((evalCase, ctx) => {
    const sources = [
      evalCase.repo?.external !== undefined,
      evalCase.repo?.fixture !== undefined,
      evalCase.artifacts?.path !== undefined
    ].filter(Boolean).length;
    if (sources !== 1) {
      ctx.addIssue({ code: "custom", message: "exactly one of repo.external, repo.fixture, or artifacts.path is required" });
    }
    if (evalCase.repo?.external !== undefined && !path.isAbsolute(expandHome(evalCase.repo.external))) {
      ctx.addIssue({ code: "custom", path: ["repo", "external"], message: "repo.external must be an absolute path; use repo.fixture for suite-relative paths" });
    }
    if (evalCase.artifacts?.path !== undefined && evalCase.command !== undefined) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "command is only valid for repo-backed eval cases" });
    }
    const commandModes = [
      evalCase.command?.pr !== undefined,
      evalCase.command?.branch !== undefined,
      evalCase.command?.head !== undefined,
      evalCase.command?.target !== undefined
    ].filter(Boolean).length;
    if (commandModes > 1) {
      ctx.addIssue({ code: "custom", path: ["command"], message: "at most one of command.pr, command.branch, command.head, or command.target may be set" });
    }
    if (evalCase.command?.base !== undefined && evalCase.command.branch === undefined && evalCase.command.head === undefined) {
      ctx.addIssue({ code: "custom", path: ["command", "base"], message: "command.base requires command.branch or command.head" });
    }
    if (evalCase.command?.head !== undefined && evalCase.command.base === undefined) {
      ctx.addIssue({ code: "custom", path: ["command", "base"], message: "command.head requires command.base" });
    }
    if ((evalCase.repeat ?? 1) > 1) {
      if (evalCase.artifacts !== undefined) {
        ctx.addIssue({ code: "custom", path: ["repeat"], message: "repeat > 1 is incompatible with artifact-backed cases (replays are deterministic)" });
      }
      if (evalCase.review?.cache !== false) {
        ctx.addIssue({ code: "custom", path: ["repeat"], message: "repeat > 1 requires review.cache: false — repeats need fresh sampling, not cached model calls" });
      }
    }
    if (evalCase.command?.target !== undefined && evalCase.command.target.includes("..")) {
      if (evalCase.command.target.includes("...")) {
        ctx.addIssue({ code: "custom", path: ["command", "target"], message: "command.target ranges must be <start>..<end> (two dots); three-dot ranges are not supported" });
      } else {
        const parts = evalCase.command.target.split("..");
        if (parts.length !== 2 || (parts[0]?.length ?? 0) === 0 || (parts[1]?.length ?? 0) === 0) {
          ctx.addIssue({ code: "custom", path: ["command", "target"], message: "command.target ranges must be <start>..<end>" });
        }
      }
    }
    for (const stage of Object.keys(evalCase.expect?.maxPromptCharsByStage ?? {})) {
      const parsed = Number(stage);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 11) {
        ctx.addIssue({ code: "custom", path: ["expect", "maxPromptCharsByStage", stage], message: "stage keys must be numeric ids 1-11" });
      }
    }
    const expectationIds = [
      ...(evalCase.should_find ?? []),
      ...(evalCase.should_find_candidate ?? []),
      ...(evalCase.should_not_find ?? [])
    ].map((expectation) => expectation.id);
    const duplicates = expectationIds.filter((id, index) => expectationIds.indexOf(id) !== index);
    for (const id of [...new Set(duplicates)]) {
      ctx.addIssue({ code: "custom", message: `duplicate expectation id: ${id}` });
    }
  });

export async function loadEvalSuite(evalDir: string): Promise<EvalSuite> {
  const dir = path.resolve(expandHome(evalDir));
  const entries = await readdir(dir).catch((cause) => {
    throw new CodegenieError("config_error", `failed to read eval directory: ${dir}`, {
      context: { path: dir },
      cause
    });
  });
  const files = entries.filter((entry) => /\.ya?ml$/u.test(entry)).sort();
  const cases: EvalSuite["cases"] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      cases.push(await loadCaseFile(path.join(dir, file), dir));
    } catch (error) {
      errors.push(...formatCaseLoadErrors(error));
    }
  }
  const duplicateNames = cases
    .map((entry) => entry.evalCase.name)
    .filter((name, index, names) => names.indexOf(name) !== index);
  for (const name of [...new Set(duplicateNames)]) {
    errors.push(`duplicate eval case name: ${name}`);
  }
  if (cases.length === 0 && errors.length === 0) {
    errors.push(`no eval case YAML files found in ${dir}`);
  }
  if (errors.length > 0) {
    throw new CodegenieError("config_error", "invalid eval suite", {
      context: { path: dir, errors }
    });
  }
  return { dir, cases };
}

export async function runEvalCase(
  suite: EvalSuite,
  entry: EvalSuite["cases"][number],
  options: EvalRunOptions
): Promise<EvalCaseResult> {
  const logsDir = resolveLogsDir(suite.dir, entry.evalCase, options.config);
  const allocated = await allocateRunDir(logsDir);
  await mkdir(path.join(allocated.dir, "telemetry"), { recursive: true });
  return entry.evalCase.artifacts !== undefined
    ? runArtifactCase(suite, entry, allocated, options)
    : runLiveCase(suite, entry, allocated, options);
}

export async function replayFromArtifacts(
  sourceRunDir: string,
  options: EvalRunOptions
): Promise<EvalCaseResult> {
  const source = path.resolve(expandHome(sourceRunDir));
  const sourceInfo = await readRunInfo(source);
  const logsDir = path.dirname(source);
  const suiteDir = path.dirname(logsDir);
  const allocated = await allocateRunDir(logsDir);
  const reread = await rereadReplayCase(sourceInfo, suiteDir);
  const startedAt = new Date().toISOString();
  try {
    assertReplayLayoutSupported(source);
    const telemetryDir = await copyTelemetryArtifacts(source, allocated.dir);
    await copyReviewOutput(source, allocated.dir);
    const artifacts = await loadEvalArtifacts(telemetryDir);
    assertReplayArtifactsComplete(artifacts, telemetryDir);
    const score = scoreEvalRun(reread.evalCase, artifacts, "replay");
    const finishedAt = new Date().toISOString();
    const info = buildRunInfo({
      runNumber: allocated.runNumber,
      evalCase: reread.evalCase,
      caseHash: reread.caseHash,
      mode: "replay",
      startedAt,
      finishedAt,
      score,
      config: options.config,
      replay: { sourceArtifacts: source, caseSource: reread.source },
      ...(sourceInfo.caseFile !== undefined ? { caseFile: sourceInfo.caseFile } : {})
    });
    await writeRunOutputs(allocated.dir, logsDir, info, artifacts.finalFindings);
    return { caseName: info.caseName, runDir: allocated.dir, status: info.score.status, info };
  } catch (error) {
    return writeErroredCase(
      allocated,
      {
        evalCase: reread.evalCase,
        caseHash: reread.caseHash,
        ...(sourceInfo.caseFile !== undefined ? { file: sourceInfo.caseFile } : {})
      },
      options.config,
      startedAt,
      error,
      "replay",
      { sourceArtifacts: source, caseSource: reread.source }
    );
  }
}

// Replays take the artifact set as their input: missing core artifacts mean
// the input is invalid and the replay errors. Live-run scoring, by contrast,
// tolerates missing artifacts with disclosure (plan 89 A1) because the review
// already ran and its partial record is the data point.
function assertReplayArtifactsComplete(artifacts: { missingArtifacts?: string[] }, telemetryDir: string): void {
  const missing = artifacts.missingArtifacts ?? [];
  if (missing.length > 0) {
    throw new CodegenieError("invalid_args", `required eval artifact is missing: ${missing.join(", ")} (${telemetryDir})`, {
      context: { missing, telemetryDir }
    });
  }
}

function assertReplayLayoutSupported(sourceRunOrTelemetryDir: string): void {
  const telemetryDir = resolveTelemetryDir(sourceRunOrTelemetryDir);
  const oldLayoutArtifacts = [
    "candidate-findings.json",
    "final-findings.json",
    "verification.json",
    "final-selection.json"
  ].filter((logicalName) => {
    const canonical = canonicalArtifactPath(logicalName);
    return canonical !== logicalName &&
      existsSync(path.join(telemetryDir, logicalName)) &&
      !existsSync(path.join(telemetryDir, canonical));
  });
  if (oldLayoutArtifacts.length === 0) {
    return;
  }
  throw new CodegenieError("invalid_args", `old layout unsupported for --from-artifacts replay: ${oldLayoutArtifacts.join(", ")} (${telemetryDir})`, {
    context: { telemetryDir, oldLayoutArtifacts }
  });
}

async function runArtifactCase(
  suite: EvalSuite,
  entry: EvalSuite["cases"][number],
  allocated: { runNumber: number; dir: string },
  options: EvalRunOptions
): Promise<EvalCaseResult> {
  const startedAt = new Date().toISOString();
  const source = resolveCasePath(suite.dir, entry.evalCase.artifacts?.path ?? "");
  try {
    const telemetryDir = await copyTelemetryArtifacts(source, allocated.dir);
    await copyReviewOutput(source, allocated.dir);
    const artifacts = await loadEvalArtifacts(telemetryDir);
    assertReplayArtifactsComplete(artifacts, telemetryDir);
    const score = scoreEvalRun(entry.evalCase, artifacts, "replay");
    const finishedAt = new Date().toISOString();
    const info = buildRunInfo({
      runNumber: allocated.runNumber,
      evalCase: entry.evalCase,
      caseHash: entry.caseHash,
      caseFile: entry.file,
      mode: "replay",
      startedAt,
      finishedAt,
      score,
      config: options.config,
      replay: { sourceArtifacts: source, caseSource: "yaml" }
    });
    await writeRunOutputs(allocated.dir, path.dirname(allocated.dir), info, artifacts.finalFindings);
    return { caseName: info.caseName, runDir: allocated.dir, status: info.score.status, info };
  } catch (error) {
    return writeErroredCase(
      allocated,
      entry,
      options.config,
      startedAt,
      error,
      "replay",
      { sourceArtifacts: source, caseSource: "yaml" }
    );
  }
}

async function runLiveCase(
  suite: EvalSuite,
  entry: EvalSuite["cases"][number],
  allocated: { runNumber: number; dir: string },
  options: EvalRunOptions
): Promise<EvalCaseResult> {
  if ((entry.evalCase.repeat ?? 1) > 1) {
    return runRepeatedLiveCase(suite, entry, allocated, options, entry.evalCase.repeat ?? 1);
  }
  const startedAt = new Date().toISOString();
  let reviewRunId: string | undefined;
  let errorConfig = options.config;
  let errorCache: EvalRunInfo["cache"] | undefined;
  try {
    const repoRoot = await resolveRepoRoot(suite.dir, entry.evalCase, allocated.dir);
    const git = createGitClient(repoRoot);
    if (!(await git.isInsideWorktree())) {
      throw new CodegenieError("not_git_worktree", `eval case repository is not a git worktree: ${repoRoot}`, {
        context: { repoRoot }
      });
    }
    const actualRepoRoot = await git.repoRoot();
    const repoLayer = applyRepoConfigLayer(options.config, actualRepoRoot);
    const caseConfig = applyCaseReviewConfig(repoLayer.config, entry.evalCase, options.cacheOverride);
    errorConfig = caseConfig.config;
    errorCache = caseConfig.cache;
    const target = targetForCase(entry.evalCase);
    let reviewOutput = "";
    await runReview(target, caseConfig.config, {
      repoRoot: actualRepoRoot,
      runArtifactDir: path.join(allocated.dir, "telemetry"),
      format: "markdown",
      postGithubComments: false,
      configWarnings: repoLayer.warnings,
      onRunStart: (run) => {
        reviewRunId = run.runId;
      },
      writeOutput: (chunk) => {
        reviewOutput += chunk;
      }
    });
    if (reviewOutput.trim().length > 0) {
      await writeFile(path.join(allocated.dir, "codegenie-review.out.md"), reviewOutput);
    }
    const telemetryDir = path.join(allocated.dir, "telemetry");
    const artifacts = await loadEvalArtifacts(telemetryDir);
    const score = scoreEvalRun(entry.evalCase, artifacts, "live");
    const finishedAt = new Date().toISOString();
    const info = buildRunInfo({
      runNumber: allocated.runNumber,
      evalCase: entry.evalCase,
      caseHash: entry.caseHash,
      caseFile: entry.file,
      mode: "live",
      startedAt,
      finishedAt,
      score,
      config: caseConfig.config,
      cache: caseConfig.cache,
      repo: await repoInfo(actualRepoRoot, telemetryDir),
      ...(reviewRunId !== undefined ? { reviewRunId } : {})
    });
    await writeRunOutputs(allocated.dir, path.dirname(allocated.dir), info, artifacts.finalFindings);
    return { caseName: info.caseName, runDir: allocated.dir, status: info.score.status, info };
  } catch (error) {
    return writeErroredCase(allocated, entry, errorConfig, startedAt, error, "live", undefined, errorCache);
  }
}

// Repeated live case (plan 79): N independent executions under
// logs/<run>/repeats/<k>/, aggregated into recall rates and one parent
// info.json. The repo/config are resolved once (fixture repos materialize
// once); each execution gets a fresh telemetry dir and score. A crashed
// execution is recorded as an errored sample and the loop continues.
// Compare-to-previous is skipped: an aggregate has no single finding set.
async function runRepeatedLiveCase(
  suite: EvalSuite,
  entry: EvalSuite["cases"][number],
  allocated: { runNumber: number; dir: string },
  options: EvalRunOptions,
  repeat: number
): Promise<EvalCaseResult> {
  const startedAt = new Date().toISOString();
  let errorConfig = options.config;
  let errorCache: EvalRunInfo["cache"] | undefined;
  try {
    const repoRoot = await resolveRepoRoot(suite.dir, entry.evalCase, allocated.dir);
    const git = createGitClient(repoRoot);
    if (!(await git.isInsideWorktree())) {
      throw new CodegenieError("not_git_worktree", `eval case repository is not a git worktree: ${repoRoot}`, {
        context: { repoRoot }
      });
    }
    const actualRepoRoot = await git.repoRoot();
    const repoLayer = applyRepoConfigLayer(options.config, actualRepoRoot);
    const caseConfig = applyCaseReviewConfig(repoLayer.config, entry.evalCase, options.cacheOverride);
    errorConfig = caseConfig.config;
    errorCache = caseConfig.cache;
    if (caseConfig.cache.enabled) {
      throw new CodegenieError("config_error", "repeat > 1 requires the local model-call cache to be disabled — repeats need fresh sampling (set review.cache: false and do not pass --cache)", {
        context: { repeat, cacheSource: caseConfig.cache.source }
      });
    }
    const target = targetForCase(entry.evalCase);
    const executions: Array<{ runDir: string; score: EvalScore; artifacts?: EvalArtifacts }> = [];
    for (let execution = 1; execution <= repeat; execution += 1) {
      const execDirName = path.join("repeats", String(execution));
      const execDir = path.join(allocated.dir, execDirName);
      await mkdir(execDir, { recursive: true });
      try {
        let reviewOutput = "";
        await runReview(target, caseConfig.config, {
          repoRoot: actualRepoRoot,
          runArtifactDir: path.join(execDir, "telemetry"),
          format: "markdown",
          postGithubComments: false,
          configWarnings: repoLayer.warnings,
          writeOutput: (chunk) => {
            reviewOutput += chunk;
          }
        });
        if (reviewOutput.trim().length > 0) {
          await writeFile(path.join(execDir, "codegenie-review.out.md"), reviewOutput);
        }
        const artifacts = await loadEvalArtifacts(path.join(execDir, "telemetry"));
        const score = scoreEvalRun(entry.evalCase, artifacts, "live");
        await writeFile(path.join(execDir, "score.json"), `${JSON.stringify(score, null, 2)}\n`);
        executions.push({ runDir: execDirName, score, artifacts });
      } catch (error) {
        const score = errorScore(error);
        await writeFile(path.join(execDir, "score.json"), `${JSON.stringify(score, null, 2)}\n`);
        executions.push({ runDir: execDirName, score });
      }
    }
    const { aggregate, score } = aggregateRepeatScores(entry.evalCase, executions);
    const finishedAt = new Date().toISOString();
    const info = buildRunInfo({
      runNumber: allocated.runNumber,
      evalCase: entry.evalCase,
      caseHash: entry.caseHash,
      caseFile: entry.file,
      mode: "live",
      startedAt,
      finishedAt,
      score,
      repeats: aggregate,
      config: caseConfig.config,
      cache: caseConfig.cache,
      repo: await repoInfo(actualRepoRoot, path.join(allocated.dir, "repeats", "1", "telemetry"))
    });
    await writeFile(path.join(allocated.dir, "eval-aggregate.json"), `${JSON.stringify({ aggregate, executions: executions.map((execution) => ({ runDir: execution.runDir, score: execution.score })) }, null, 2)}\n`);
    await writeFile(path.join(allocated.dir, "out.log"), `${JSON.stringify({ level: "info", message: "eval case scored (repeat aggregate)", status: info.score.status, repeat })}\n`);
    await writeEvalRunInfo(allocated.dir, info);
    return { caseName: info.caseName, runDir: allocated.dir, status: info.score.status, info };
  } catch (error) {
    return writeErroredCase(allocated, entry, errorConfig, startedAt, error, "live", undefined, errorCache);
  }
}

async function writeErroredCase(
  allocated: { runNumber: number; dir: string },
  entry: { evalCase: EvalCase; caseHash: string; file?: string },
  config: CodegenieConfig,
  startedAt: string,
  error: unknown,
  mode: "live" | "replay",
  replay?: EvalRunInfo["replay"],
  cache?: EvalRunInfo["cache"]
): Promise<EvalCaseResult> {
  const finishedAt = new Date().toISOString();
  const score = errorScore(error);
  const info = buildRunInfo({
    runNumber: allocated.runNumber,
    evalCase: entry.evalCase,
    caseHash: entry.caseHash,
    mode,
    ...(entry.file !== undefined ? { caseFile: entry.file } : {}),
    ...(replay !== undefined ? { replay } : {}),
    startedAt,
    finishedAt,
    score,
    config,
    ...(cache !== undefined ? { cache } : {})
  });
  await writeFile(path.join(allocated.dir, "out.log"), `${JSON.stringify({ level: "error", message: score.error?.message, code: score.error?.code })}\n`);
  await writeCompareIfAvailable(allocated.dir, path.dirname(allocated.dir), info, []);
  await writeEvalRunInfo(allocated.dir, info);
  return { caseName: info.caseName, runDir: allocated.dir, status: "error", info };
}

async function writeRunOutputs(
  runDir: string,
  logsDir: string,
  info: EvalRunInfo,
  finalFindings: FinalFinding[]
): Promise<void> {
  await writeFile(path.join(runDir, "out.log"), `${JSON.stringify({ level: "info", message: "eval case scored", status: info.score.status })}\n`);
  await writeCompareIfAvailable(runDir, logsDir, info, finalFindings);
  await writeEvalRunInfo(runDir, info);
}

async function writeCompareIfAvailable(
  runDir: string,
  logsDir: string,
  info: EvalRunInfo,
  finalFindings: FinalFinding[]
): Promise<void> {
  const previous = await findPreviousRun(logsDir, info.caseName, info.runNumber);
  if (previous === undefined) {
    return;
  }
  try {
    const previousInfo = await readRunInfo(previous.dir);
    const previousArtifacts = await loadPreviousArtifactsForCompare(previous.dir);
    const report = compareToPrevious(
      { info, finalFindings },
      { info: previousInfo, finalFindings: previousArtifacts.findings, findingsUnreadable: previousArtifacts.unreadable }
    );
    await writeFile(path.join(runDir, "compare-to-previous.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(path.join(runDir, "compare-to-previous.txt"), renderEvalCompareText(report));
  } catch {
    // A damaged previous run should not prevent the current eval result from being written.
  }
}

async function loadPreviousArtifactsForCompare(runDir: string): Promise<{ findings: FinalFinding[]; unreadable: boolean }> {
  try {
    const artifacts = await loadEvalArtifacts(resolveTelemetryDir(runDir));
    const unreadable = (artifacts.missingArtifacts ?? []).some((name) => name.startsWith("final-findings.json"));
    return { findings: artifacts.finalFindings, unreadable };
  } catch {
    return { findings: [], unreadable: true };
  }
}

async function loadCaseFile(filePath: string, suiteDir: string): Promise<EvalSuite["cases"][number]> {
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (cause) {
    throw new CodegenieError("config_error", `failed to parse eval case YAML at ${filePath}`, {
      context: { path: filePath },
      cause
    });
  }
  const result = caseSchema.safeParse(parsed);
  if (!result.success) {
    throw new CodegenieError("config_error", `invalid eval case at ${filePath}`, {
      context: { path: filePath, issues: result.error.issues }
    });
  }
  return {
    file: path.relative(suiteDir, filePath),
    evalCase: result.data as EvalCase,
    caseHash: sha256Hex(raw)
  };
}

async function rereadReplayCase(
  sourceInfo: EvalRunInfo,
  suiteDir: string
): Promise<{ evalCase: EvalCase; caseHash: string; source: "yaml" | "snapshot" }> {
  if (sourceInfo.caseFile !== undefined) {
    const casePath = path.join(suiteDir, sourceInfo.caseFile);
    if (existsSync(casePath)) {
      const entry = await loadCaseFile(casePath, suiteDir);
      return { evalCase: entry.evalCase, caseHash: entry.caseHash, source: "yaml" };
    }
  }
  return { evalCase: sourceInfo.caseSnapshot, caseHash: sourceInfo.caseHash, source: "snapshot" };
}

async function readRunInfo(runDir: string): Promise<EvalRunInfo> {
  const filePath = path.join(runDir, "info.json");
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as EvalRunInfo;
  } catch (cause) {
    throw new CodegenieError("invalid_args", `failed to read eval run info: ${filePath}`, {
      context: { path: filePath },
      cause
    });
  }
}

function buildRunInfo(input: {
  runNumber: number;
  evalCase: EvalCase;
  caseHash: string;
  caseFile?: string;
  mode: "live" | "replay";
  replay?: EvalRunInfo["replay"];
  repeats?: EvalRunInfo["repeats"];
  repo?: EvalRunInfo["repo"];
  reviewRunId?: string;
  startedAt: string;
  finishedAt: string;
  score: EvalScore;
  config: CodegenieConfig;
  cache?: EvalRunInfo["cache"];
}): EvalRunInfo {
  return {
    runNumber: input.runNumber,
    caseName: input.evalCase.name,
    ...(input.caseFile !== undefined ? { caseFile: input.caseFile } : {}),
    caseHash: input.caseHash,
    caseSnapshot: input.evalCase,
    mode: input.mode,
    ...(input.replay !== undefined ? { replay: input.replay } : {}),
    ...(input.repeats !== undefined ? { repeats: input.repeats } : {}),
    ...(input.repo !== undefined ? { repo: input.repo } : {}),
    ...(input.reviewRunId !== undefined ? { reviewRunId: input.reviewRunId } : {}),
    codegenieRuntime: resolveCodegenieRuntimeProvenance(),
    cache: input.cache ?? { enabled: input.config.cache.enabled, source: "config", dir: input.config.cache.dir },
    effectiveConfig: evalEffectiveConfig(input.config),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    score: input.score
  };
}

function errorScore(error: unknown): EvalScore {
  const code = isCodegenieError(error) ? error.code : "invalid_args";
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: "error",
    expectationResults: [],
    budgetResults: [],
    violations: [],
    nearViolations: [],
    metrics: {
      reportedFindings: 0,
      inlineFindings: 0,
      summaryOnlyFindings: 0,
      suppressedFindings: 0,
      candidateFindings: 0,
      duplicateGroups: 0,
      stageLossCounts: {
        "missed-before-candidate-generation": 0,
        "lost-at-verification": 0,
        "lost-at-composition": 0,
        "partial-match": 0
      }
    },
    error: { code, message }
  };
}

function formatCaseLoadErrors(error: unknown): string[] {
  if (isCodegenieError(error) && Array.isArray(error.context?.issues)) {
    return error.context.issues.map((issue) => {
      if (!isRecord(issue)) {
        return error.message;
      }
      const pathText = Array.isArray(issue.path) ? issue.path.join(".") : "";
      const message = typeof issue.message === "string" ? issue.message : "validation failed";
      return pathText.length > 0 ? `${error.message}: ${pathText}: ${message}` : `${error.message}: ${message}`;
    });
  }
  return [error instanceof Error ? error.message : String(error)];
}

function applyCaseReviewConfig(
  loaded: CodegenieConfig,
  evalCase: EvalCase,
  cacheOverride: boolean | undefined
): { config: CodegenieConfig; cache: EvalRunInfo["cache"] } {
  const config = structuredClone(loaded) as CodegenieConfig;
  const review = evalCase.review;
  const llm = evalCase.llm;
  if (review?.depth !== undefined) {
    config.review.depth = review.depth;
  }
  if (review?.maxFindings !== undefined) {
    config.review.maxFindings = review.maxFindings;
  }
  if (review?.concurrency !== undefined) {
    config.review.concurrency = review.concurrency;
  }
  if (review?.budgetBoost !== undefined) {
    config.review.budgetBoost = review.budgetBoost;
  }
  if (review?.packSameFileHunks !== undefined) {
    config.review.packSameFileHunks = review.packSameFileHunks;
  }
  if (review?.packedToolBudgetMode !== undefined) {
    config.review.packedToolBudgetMode = review.packedToolBudgetMode;
  }
  if (review?.maxTimeMinutes !== undefined) {
    config.review.maxTimeMs = Math.round(review.maxTimeMinutes * 60_000);
  }
  if (review?.maxBudgetTokens !== undefined) {
    config.review.maxBudgetTokens = review.maxBudgetTokens;
  }
  if (review?.deepEnsemblePasses !== undefined) {
    config.review.deepEnsemblePasses = review.deepEnsemblePasses;
  }
  if (review?.adaptiveSecondPass !== undefined) {
    config.review.adaptiveSecondPass = review.adaptiveSecondPass;
  }
  if (review?.verify !== undefined) {
    config.review.verify = review.verify;
  }
  if (review?.debug !== undefined) {
    config.telemetry.debugTrace = review.debug;
  }
  if (review?.cacheDir !== undefined) {
    config.cache.dir = review.cacheDir;
  }
  if (review?.lenses !== undefined) {
    config.lenses.restrictTo = [...review.lenses];
  }
  const provider = llm?.provider ?? review?.provider;
  const model = llm?.model ?? review?.model;
  const reasoning = llm?.reasoning ?? review?.reasoning;
  if (provider !== undefined) {
    config.llm.provider = provider;
  }
  if (model !== undefined) {
    config.llm.model = model;
  }
  if (reasoning !== undefined) {
    config.llm.reasoning = reasoning;
  }
  if (llm?.maxConcurrentCalls !== undefined) {
    config.llm.maxConcurrentCalls = llm.maxConcurrentCalls;
  }
  const cacheEnabled = cacheOverride ?? review?.cache ?? config.cache.enabled;
  const cacheSource = cacheOverride !== undefined ? "cli" : review?.cache !== undefined ? "case" : "config";
  config.cache.enabled = cacheEnabled;
  return {
    config,
    cache: { enabled: cacheEnabled, source: cacheSource, dir: config.cache.dir }
  };
}

function evalEffectiveConfig(config: CodegenieConfig): NonNullable<EvalRunInfo["effectiveConfig"]> {
  return {
    review: {
      concurrency: config.review.concurrency,
      timeoutMs: config.review.maxTimeMs,
      packSameFileHunks: config.review.packSameFileHunks,
      packedToolBudgetMode: config.review.packedToolBudgetMode,
      ...(config.review.maxBudgetTokens !== undefined ? { maxBudgetTokens: config.review.maxBudgetTokens } : {})
    },
    llm: {
      ...(config.llm.provider !== undefined ? { provider: config.llm.provider } : {}),
      ...(config.llm.model !== undefined ? { model: config.llm.model } : {}),
      ...(config.llm.reasoning !== undefined ? { reasoning: config.llm.reasoning } : {}),
      maxConcurrentCalls: config.llm.maxConcurrentCalls
    }
  };
}

function targetForCase(evalCase: EvalCase): ReviewCommandTarget {
  const command = evalCase.command;
  if (command?.pr !== undefined) {
    return { mode: "github_pr", prNumber: command.pr };
  }
  if (command?.branch !== undefined) {
    return {
      mode: "branch",
      branchName: command.branch,
      ...(command.base !== undefined ? { baseBranch: command.base } : {})
    };
  }
  if (command?.head !== undefined) {
    return { mode: "head", headRef: command.head, baseRef: command.base! };
  }
  if (command?.target !== undefined) {
    const parts = command.target.split("..");
    if (parts.length === 2) {
      const startCommit = parts[0] ?? "";
      const endCommit = parts[1] ?? "";
      return endCommit.length > 0
        ? { mode: "commit_range", startCommit, endCommit }
        : { mode: "commit_range", startCommit };
    }
    return { mode: "commit_range", startCommit: command.target };
  }
  return { mode: "default_branch" };
}

async function resolveRepoRoot(suiteDir: string, evalCase: EvalCase, runDir: string): Promise<string> {
  if (evalCase.repo?.external !== undefined) {
    return path.resolve(expandHome(evalCase.repo.external));
  }
  const fixturePath = path.resolve(resolveCasePath(suiteDir, evalCase.repo?.fixture ?? ""));
  if (await isGitWorktreeRoot(fixturePath)) {
    return fixturePath;
  }
  return materializeFixtureRepo(fixturePath, runDir);
}

function resolveLogsDir(suiteDir: string, evalCase: EvalCase, config: CodegenieConfig): string {
  const configured = evalCase.logs?.dir ?? config.eval.logsDir;
  return path.isAbsolute(configured) ? configured : path.join(suiteDir, configured);
}

function resolveCasePath(suiteDir: string, input: string): string {
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? expanded : path.join(suiteDir, expanded);
}

async function isGitWorktreeRoot(repoPath: string): Promise<boolean> {
  const git = createGitClient(repoPath);
  if (!(await git.isInsideWorktree())) {
    return false;
  }
  return path.resolve(await git.repoRoot()) === path.resolve(repoPath);
}

async function materializeFixtureRepo(fixturePath: string, runDir: string): Promise<string> {
  const featureDir = path.join(fixturePath, "feature");
  if (!existsSync(featureDir)) {
    throw new CodegenieError("not_git_worktree", `eval fixture is not a git worktree or materializable fixture: ${fixturePath}`, {
      context: { repoRoot: fixturePath }
    });
  }

  const repoRoot = path.join(runDir, "fixture-repo");
  await mkdir(repoRoot, { recursive: true });
  await runGit(repoRoot, ["init", "-b", "main"], { errorCode: "invalid_args" });
  await runGit(repoRoot, ["config", "user.name", "Codegenie Fixture"], { errorCode: "invalid_args" });
  await runGit(repoRoot, ["config", "user.email", "fixture@example.com"], { errorCode: "invalid_args" });

  const baseDir = path.join(fixturePath, "base");
  if (existsSync(baseDir)) {
    await copyFixtureTree(baseDir, repoRoot);
  }
  await runGit(repoRoot, ["add", "."], { errorCode: "invalid_args" });
  await runGit(repoRoot, ["commit", "--allow-empty", "-m", "base"], { errorCode: "invalid_args" });
  await runGit(repoRoot, ["checkout", "-b", "feature"], { errorCode: "invalid_args" });
  await copyFixtureTree(featureDir, repoRoot);
  await runGit(repoRoot, ["add", "."], { errorCode: "invalid_args" });
  await runGit(repoRoot, ["commit", "-m", "fixture feature"], { errorCode: "invalid_args" });
  return repoRoot;
}

async function copyFixtureTree(sourceDir: string, destinationDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch((cause) => {
    throw new CodegenieError("config_error", `failed to read fixture source directory: ${sourceDir}`, {
      context: { path: sourceDir },
      cause
    });
  });
  await mkdir(destinationDir, { recursive: true });
  for (const entry of entries) {
    if (entry.name === ".git") {
      continue;
    }
    const source = path.join(sourceDir, entry.name);
    const destination = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      await copyFixtureTree(source, destination);
    } else if (entry.isFile()) {
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    } else {
      throw new CodegenieError("config_error", `fixture source contains unsupported entry: ${source}`, {
        context: { path: source }
      });
    }
  }
}

function expandHome(input: string): string {
  if (input === "~") {
    return process.env.HOME ?? input;
  }
  return input.startsWith("~/") ? path.join(process.env.HOME ?? "~", input.slice(2)) : input;
}

async function repoInfo(repoRoot: string, telemetryDir: string): Promise<EvalRunInfo["repo"]> {
  try {
    const resolved = JSON.parse(await readFile(path.join(telemetryDir, canonicalArtifactPath("resolved-input.json")), "utf8")) as Record<string, unknown>;
    return {
      root: repoRoot,
      ...(typeof resolved.baseRef === "string" ? { baseSha: resolved.baseRef } : {}),
      ...(typeof resolved.headSha === "string" ? { headSha: resolved.headSha } : {}),
      ...(typeof resolved.mergeBase === "string" ? { mergeBase: resolved.mergeBase } : {})
    };
  } catch {
    return { root: repoRoot };
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}
