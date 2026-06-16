import path from "node:path";
import { Command, CommanderError } from "commander";
import { loadConfig } from "../config/config-loader.js";
import type { CodeninjaConfig, EvalCaseResult, EvalLossLabel } from "../types.js";
import { CodeninjaError } from "../util/errors.js";
import { CliDisplayExit } from "../cli/review-command.js";
import { loadEvalSuite, replayFromArtifacts, runEvalCase } from "./eval-runner.js";

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
  config: CodeninjaConfig,
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
    throw new CodeninjaError("invalid_args", "--eval-dir is required when eval.defaultEvalDir is not configured");
  }
  const suite = await loadEvalSuite(evalDir);
  const results: EvalCaseResult[] = [];
  for (const entry of suite.cases) {
    const result = await runEvalCase(suite, entry, {
      config,
      ...(options.cache !== undefined ? { cacheOverride: options.cache } : {})
    });
    results.push(result);
    write(renderCaseResult(result));
  }
  write(renderSuiteTotals(results));
  return results.every((result) => result.status === "pass") ? 0 : 1;
}

export function parseEvalCommand(
  argv: string[],
  opts: { allowOutput?: boolean } = {}
): EvalCommandOptions {
  let parsed: EvalCommandOptions | undefined;
  const program = new Command();
  program.name("codeninja").exitOverride();

  if (!opts.allowOutput) {
    program.configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined
    });
  }

  program
    .command("eval")
    .description("run codeninja eval suites")
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
    throw commanderToCodeninjaError(error);
  }

  if (!parsed) {
    throw new CodeninjaError("invalid_args", "expected eval command");
  }
  if (argv.includes("--cache") && argv.includes("--no-cache")) {
    throw new CodeninjaError("invalid_args", "--cache and --no-cache are mutually exclusive");
  }
  return parsed;
}

function validateEvalOptions(options: EvalCommandOptions, config: CodeninjaConfig): void {
  if (options.evalDir !== undefined && options.fromArtifacts !== undefined) {
    throw new CodeninjaError("invalid_args", "--eval-dir and --from-artifacts are mutually exclusive");
  }
  if (options.evalDir === undefined && options.fromArtifacts === undefined && config.eval.defaultEvalDir === undefined) {
    throw new CodeninjaError("invalid_args", "--eval-dir is required when eval.defaultEvalDir is not configured");
  }
}

export function renderCaseResult(result: EvalCaseResult): string {
  const score = result.info.score;
  const metrics = score.metrics;
  const parts = [
    `${result.caseName} run ${result.info.runNumber}: ${result.status}`,
    `${metrics.reportedFindings} reported`,
    `${score.expectationResults.filter((item) => item.status === "pass").length}/${score.expectationResults.length} expectations`
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
  const contextPressureParts = contextPressureSummaryParts(metrics);
  if (contextPressureParts.length > 0) {
    parts.push(`context pressure ${contextPressureParts.join(", ")}`);
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

function commanderToCodeninjaError(error: unknown): CodeninjaError {
  if (error instanceof CommanderError) {
    return new CodeninjaError("invalid_args", error.message, {
      context: { code: error.code, exitCode: error.exitCode }
    });
  }
  if (error instanceof CodeninjaError) {
    return error;
  }
  return new CodeninjaError("invalid_args", "failed to parse eval command line", { cause: error });
}
