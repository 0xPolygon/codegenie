import { randomUUID } from "node:crypto";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { loadConfig } from "../config/config-loader.js";
import type { CodegenieConfig, EvalCaseResult, EvalInvocationManifest, EvalLossLabel } from "../types.js";
import { CodegenieError } from "../util/errors.js";
import { CliDisplayExit } from "../cli/review-command.js";
import { writeEvalInvocationManifest } from "./eval-artifacts.js";
import { loadEvalSuite, replayFromArtifacts, resolveLogsDir, runEvalCase } from "./eval-runner.js";

export type EvalCommandOptions = {
  evalDir?: string;
  fromArtifacts?: string;
  cache?: boolean;
};

type ExecuteEvalCommandOptions = {
  repoRoot?: string;
  homeOverride?: string;
  env?: NodeJS.ProcessEnv;
  allowOutput?: boolean;
  writeOutput?: (text: string) => void;
};

type CommanderEvalOptions = {
  evalDir?: string;
  fromArtifacts?: string;
  cache?: boolean;
};

export async function executeEvalCommand(argv: string[], opts: ExecuteEvalCommandOptions = {}): Promise<number> {
  const parsed = parseEvalCommand(argv, opts);
  const loaded = loadConfig({
    repoRoot: path.resolve(opts.repoRoot ?? process.cwd()),
    loadRepoConfig: false,
    ...(opts.homeOverride !== undefined ? { homeOverride: opts.homeOverride } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {})
  });
  return runEvalCommand(parsed, loaded.config, opts.writeOutput !== undefined ? { writeOutput: opts.writeOutput } : {});
}

export async function runEvalCommand(
  options: EvalCommandOptions,
  config: CodegenieConfig,
  runtime: { writeOutput?: (text: string) => void } = {}
): Promise<0 | 1 | 2> {
  validateEvalOptions(options, config);
  const write = runtime.writeOutput ?? (() => undefined);
  if (options.fromArtifacts !== undefined) {
    const result = await replayFromArtifacts(options.fromArtifacts, {
      config,
      ...(options.cache !== undefined ? { cacheOverride: options.cache } : {})
    });
    write(renderCaseResult(result));
    write(renderSuiteTotals([result]));
    return result.status === "pass" ? 0 : 1;
  }

  const evalDir = options.evalDir ?? config.eval.defaultEvalDir;
  if (evalDir === undefined) {
    throw new CodegenieError("invalid_args", "--eval-dir is required when eval.defaultEvalDir is not configured");
  }
  const suite = await loadEvalSuite(evalDir);
  const invocationId = randomUUID();
  const startedAt = new Date().toISOString();
  const manifestRelativePath = `invocations/${invocationId}.json`;
  const manifest: EvalInvocationManifest = {
    schemaVersion: 1,
    invocationId,
    suiteDir: suite.dir,
    status: "running",
    startedAt,
    cases: suite.cases.map((entry, caseIndex) => ({
      caseIndex,
      caseName: entry.evalCase.name,
      caseHash: entry.caseHash,
      caseFile: entry.file
    })),
    runs: []
  };
  const manifestRoots = [...new Set(suite.cases.map((entry) => resolveLogsDir(suite.dir, entry.evalCase, config)))];
  const persistManifest = async (): Promise<void> => {
    await Promise.all(manifestRoots.map((logsDir) => writeEvalInvocationManifest(logsDir, manifest)));
  };
  await persistManifest();
  const results: EvalCaseResult[] = [];
  for (const [caseIndex, entry] of suite.cases.entries()) {
    const result = await runEvalCase(suite, entry, {
      config,
      invocation: { id: invocationId, caseIndex, manifest: manifestRelativePath },
      ...(options.cache !== undefined ? { cacheOverride: options.cache } : {})
    });
    results.push(result);
    const logsRoot = resolveLogsDir(suite.dir, entry.evalCase, config);
    const runPath = path.relative(logsRoot, result.runDir);
    manifest.runs.push({
      caseIndex,
      caseName: entry.evalCase.name,
      caseHash: entry.caseHash,
      runNumber: result.info.runNumber,
      logsRoot,
      runPath
    });
    await persistManifest();
    write(renderCaseResult(result));
  }
  manifest.status = "complete";
  manifest.completedAt = new Date().toISOString();
  await persistManifest();
  write(renderSuiteTotals(results));
  return results.every((result) => result.status === "pass") ? 0 : 1;
}

export function parseEvalCommand(
  argv: string[],
  opts: { allowOutput?: boolean } = {}
): EvalCommandOptions {
  let parsed: EvalCommandOptions | undefined;
  const program = new Command();
  program.name("codegenie").exitOverride();

  if (!opts.allowOutput) {
    program.configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined
    });
  }

  program
    .command("eval")
    .description("run codegenie eval suites")
    .option("--eval-dir <path>", "eval suite directory")
    .option("--from-artifacts <path>", "re-score a previous eval run directory")
    .option("--cache", "enable local model-call cache for live cases; provider prompt caching is reported separately")
    .option("--no-cache", "disable local model-call cache for live cases; provider prompt caching is reported separately")
    .action((options: CommanderEvalOptions) => {
      parsed = {
        ...(options.evalDir !== undefined ? { evalDir: options.evalDir } : {}),
        ...(options.fromArtifacts !== undefined ? { fromArtifacts: options.fromArtifacts } : {}),
        ...(options.cache !== undefined ? { cache: options.cache } : {})
      };
    });

  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    if (isCommanderDisplayExit(error)) {
      throw new CliDisplayExit(error.exitCode);
    }
    throw commanderToCodegenieError(error);
  }

  if (!parsed) {
    throw new CodegenieError("invalid_args", "expected eval command");
  }
  if (argv.includes("--cache") && argv.includes("--no-cache")) {
    throw new CodegenieError("invalid_args", "--cache and --no-cache are mutually exclusive");
  }
  return parsed;
}

function validateEvalOptions(options: EvalCommandOptions, config: CodegenieConfig): void {
  if (options.evalDir !== undefined && options.fromArtifacts !== undefined) {
    throw new CodegenieError("invalid_args", "--eval-dir and --from-artifacts are mutually exclusive");
  }
  if (options.evalDir === undefined && options.fromArtifacts === undefined && config.eval.defaultEvalDir === undefined) {
    throw new CodegenieError("invalid_args", "--eval-dir is required when eval.defaultEvalDir is not configured");
  }
}

export function renderCaseResult(result: EvalCaseResult): string {
  const score = result.info.score;
  const metrics = score.metrics;
  const expectationParts = expectationSummaryParts(score);
  const parts = [
    `${result.caseName} run ${result.info.runNumber}: ${result.status}`,
    `${metrics.reportedFindings} reported`,
    ...expectationParts
  ];
  if (metrics.costUSD !== undefined) {
    parts.push(`$${metrics.costUSD.toFixed(4)}`);
  }
  if (metrics.elapsedSeconds !== undefined) {
    parts.push(`${metrics.elapsedSeconds.toFixed(1)}s`);
  }
  if (metrics.reviewCompleteness !== undefined) {
    parts.push(`${metrics.reviewCompleteness} review`);
  }
  if (metrics.budgetOverruns !== undefined) {
    parts.push(`${metrics.budgetOverruns} budget overruns`);
  }
  const concurrencySummary = effectiveConcurrencySummary(result.info.effectiveConfig);
  if (concurrencySummary !== undefined) {
    parts.push(concurrencySummary);
  }
  const contextPressureParts = contextPressureSummaryParts(metrics);
  if (contextPressureParts.length > 0) {
    parts.push(`context pressure ${contextPressureParts.join(", ")}`);
  }
  const schemaRecoverySummary = schemaRecoverySummaryPart(metrics);
  if (schemaRecoverySummary !== undefined) {
    parts.push(schemaRecoverySummary);
  }
  const localCacheHits = metrics.localModelCallCacheHits ?? metrics.cacheHits;
  const localCacheMisses = metrics.localModelCallCacheMisses ?? metrics.cacheMisses;
  if (localCacheHits !== undefined) {
    parts.push(`${localCacheHits} local model-call cache hits${localCacheMisses !== undefined ? `/${localCacheMisses} misses` : ""}`);
  }
  if (metrics.providerPromptCacheReadTokens !== undefined || metrics.providerPromptCacheWriteTokens !== undefined) {
    parts.push(`provider prompt cache ${metrics.providerPromptCacheReadTokens ?? 0} read/${metrics.providerPromptCacheWriteTokens ?? 0} write tokens`);
  }
  const lines = [parts.join(" | ")];
  if (result.info.repeats !== undefined) {
    const repeats = result.info.repeats;
    lines.push(`  REPEAT x${repeats.repeat}: ${repeats.executions.map((execution) => execution.status).join(",")} | total $${repeats.totals.costUSD.toFixed(2)} ${repeats.totals.elapsedSeconds.toFixed(0)}s${repeats.totals.errors > 0 ? ` | ${repeats.totals.errors} errored` : ""}`);
    for (const expectation of repeats.expectations) {
      const loss = Object.entries(expectation.lossHistogram)
        .filter(([, count]) => count > 0)
        .map(([label, count]) => `${label}=${count}`)
        .join(", ");
      const gate = expectation.gate === undefined
        ? "measured"
        : expectation.gate.passed
          ? "gate pass"
          : "gate FAIL";
      const fingerprint = expectation.fingerprintsStable === false ? " | FINGERPRINT UNSTABLE" : "";
      lines.push(
        `  ${expectation.expectationId}: finalRecall ${expectation.finalMatched}/${repeats.repeat} (${expectation.finalRecallRate.toFixed(2)}) | candidate ${expectation.candidateMatched}/${repeats.repeat} | note ${expectation.noteSurfaced}/${repeats.repeat} | ${gate}${loss.length > 0 ? ` | loss{${loss}}` : ""}${fingerprint}`
      );
    }
  }
  for (const failure of score.expectationResults.filter((item) => item.status === "fail")) {
    lines.push(`  FAIL ${failure.expectationId}: ${failure.loss?.label ?? "expectation failed"}${failure.loss?.subReason ? ` (${failure.loss.subReason})` : ""}`);
  }
  for (const violation of score.violations) {
    lines.push(`  VIOLATION ${violation.expectationId}: ${violation.findingId} ${violation.publication}`);
  }
  for (const budget of score.budgetResults.filter((item) => item.status === "fail")) {
    lines.push(`  BUDGET ${budget.check}${budget.stage !== undefined ? `:${budget.stage}` : ""}: ${formatBudgetComparison(budget)}`);
  }
  if (score.error !== undefined) {
    lines.push(`  ERROR ${score.error.code}: ${score.error.message}`);
  }
  return `${lines.join("\n")}\n`;
}

function expectationSummaryParts(score: EvalCaseResult["info"]["score"]): string[] {
  const optional = score.expectationResults.filter((item) => item.tier === "optional");
  if (optional.length === 0) {
    return [`${score.expectationResults.filter((item) => item.status === "pass").length}/${score.expectationResults.length} expectations`];
  }
  const required = score.expectationResults.filter((item) => item.tier !== "optional");
  return [
    `${required.filter((item) => item.status === "pass").length}/${required.length} required expectations`,
    `${optional.filter((item) => item.status === "pass").length}/${optional.length} optional expectations`
  ];
}

function effectiveConcurrencySummary(effectiveConfig: EvalCaseResult["info"]["effectiveConfig"]): string | undefined {
  if (effectiveConfig === undefined) {
    return undefined;
  }
  return `concurrency ${effectiveConfig.review.concurrency} workers/${effectiveConfig.llm.maxConcurrentCalls} provider calls`;
}

function contextPressureSummaryParts(metrics: EvalCaseResult["info"]["score"]["metrics"]): string[] {
  const parts: string[] = [];
  if ((metrics.toolBudgetRejections ?? 0) > 0) {
    parts.push(`${metrics.toolBudgetRejections} tool-budget rejections`);
  }
  if ((metrics.toolBudgetExtensions ?? 0) > 0 || (metrics.toolBudgetExtensionDenials ?? 0) > 0) {
    parts.push(`${metrics.toolBudgetExtensions ?? 0} source-budget extensions${(metrics.toolBudgetExtensionDenials ?? 0) > 0 ? `/${metrics.toolBudgetExtensionDenials} denied` : ""}`);
  }
  if ((metrics.degradedHunks ?? 0) > 0) {
    parts.push(`${metrics.degradedHunks} degraded hunks`);
  }
  if ((metrics.unresolvedNotesSuppressed ?? 0) > 0) {
    parts.push(`${metrics.unresolvedNotesSuppressed} unresolved notes suppressed`);
  }
  return parts;
}

function schemaRecoverySummaryPart(metrics: EvalCaseResult["info"]["score"]["metrics"]): string | undefined {
  const invalid = metrics.schemaInvalidCalls ?? 0;
  if (invalid <= 0) {
    return undefined;
  }
  const recovered = metrics.schemaInvalidRecovered ?? 0;
  const unrecovered = metrics.schemaInvalidUnrecovered ?? Math.max(0, invalid - recovered);
  if (unrecovered <= 0 && recovered > 0) {
    return `schema recovered ${recovered}/${invalid}`;
  }
  return `schema invalid ${invalid}, recovered ${recovered}, unrecovered ${unrecovered}`;
}

function formatBudgetComparison(budget: EvalCaseResult["info"]["score"]["budgetResults"][number]): string {
  if (budget.direction === "equals") {
    return `${budget.actualText ?? "n/a"} != ${budget.expected ?? "n/a"}`;
  }
  const actual = budget.actual ?? "n/a";
  const operator = budget.direction === "minimum" ? "<" : ">";
  return `${actual} ${operator} ${budget.limit ?? "n/a"}`;
}

function renderSuiteTotals(results: EvalCaseResult[]): string {
  const passed = results.filter((result) => result.status === "pass").length;
  const failed = results.filter((result) => result.status === "fail").length;
  const errored = results.filter((result) => result.status === "error").length;
  const losses = aggregateLosses(results);
  return [
    `Suite: ${passed} passed, ${failed} failed, ${errored} errored`,
    `Losses: ${Object.entries(losses).map(([label, count]) => `${label}=${count}`).join(", ")}`
  ].join("\n") + "\n";
}

function aggregateLosses(results: EvalCaseResult[]): Record<EvalLossLabel, number> {
  const totals: Record<EvalLossLabel, number> = {
    "missed-before-candidate-generation": 0,
    "lost-at-verification": 0,
    "lost-at-composition": 0,
    "partial-match": 0
  };
  for (const result of results) {
    for (const [label, count] of Object.entries(result.info.score.metrics.stageLossCounts) as Array<[EvalLossLabel, number]>) {
      totals[label] += count;
    }
  }
  return totals;
}

function isCommanderDisplayExit(error: unknown): error is CommanderError {
  return error instanceof CommanderError && error.exitCode === 0;
}

function commanderToCodegenieError(error: unknown): CodegenieError {
  if (error instanceof CommanderError) {
    return new CodegenieError("invalid_args", error.message, {
      context: { code: error.code, exitCode: error.exitCode }
    });
  }
  if (error instanceof CodegenieError) {
    return error;
  }
  return new CodegenieError("invalid_args", "failed to parse eval command line", { cause: error });
}
