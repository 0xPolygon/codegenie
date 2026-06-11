import path from "node:path";
import { Command, CommanderError } from "commander";
import { loadConfig, type CliConfigOverrides, type LoadConfigOptions } from "../config/config-loader.js";
import type {
  OutputFormat,
  ParsedReviewCommand,
  ReasoningLevel,
  ReviewCommandTarget,
  ReviewDepth
} from "../types.js";
import { CodeninjaError } from "../util/errors.js";
import { createRunTelemetry } from "../telemetry/run-artifacts.js";

type ParseReviewCommandOptions = {
  repoRoot?: string;
  homeOverride?: string;
  env?: NodeJS.ProcessEnv;
};

type ExecuteReviewCommandResult = {
  runId: string;
  runDir: string;
};

type CommanderReviewOptions = {
  pr?: string;
  branch?: string;
  base?: string;
  depth?: string;
  lens?: string[];
  provider?: string;
  model?: string;
  reasoning?: string;
  format?: string;
  postGithubComments?: boolean;
  cache?: boolean;
};

export function parseReviewCommand(
  argv: string[],
  opts: ParseReviewCommandOptions = {}
): ParsedReviewCommand {
  let commandOptions: CommanderReviewOptions | undefined;
  let commits: string[] = [];

  const program = new Command();
  program
    .name("codeninja")
    .exitOverride()
    .configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined
    });

  program
    .command("review")
    .description("review pull-request-style changes")
    .argument("[commits...]", "commit or commit range to review")
    .option("--pr <number>", "GitHub pull request number")
    .option("--branch <branch>", "branch to review")
    .option("--base <branch>", "base branch for branch/default review")
    .option("--depth <depth>", "review depth: light, normal, or deep")
    .option("--lens <lens>", "review lens to enable for this run", collect, [])
    .option("--provider <provider>", "provider override")
    .option("--model <model>", "model override")
    .option("--reasoning <level>", "reasoning level: low, medium, high, xhigh, or auto")
    .option("--format <format>", "output format: markdown or json", "markdown")
    .option("--post-github-comments", "post inline comments to GitHub for --pr runs")
    .option("--cache", "enable model-call cache for this run")
    .option("--no-cache", "disable model-call cache for this run")
    .action((commitArgs: string[], options: CommanderReviewOptions) => {
      commits = commitArgs;
      commandOptions = options;
    });

  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    throw commanderToCodeninjaError(error);
  }

  if (!commandOptions) {
    throw new CodeninjaError("invalid_args", "expected command: codeninja review");
  }

  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const target = resolveTarget(commandOptions, commits);
  const cli = buildCliOverrides(commandOptions);
  const loadOptions: LoadConfigOptions = {
    repoRoot,
    cli
  };
  if (opts.homeOverride !== undefined) {
    loadOptions.homeOverride = opts.homeOverride;
  }
  if (opts.env !== undefined) {
    loadOptions.env = opts.env;
  }
  const loaded = loadConfig(loadOptions);

  const options = buildReviewOptions(commandOptions);
  return {
    target,
    config: loaded.config,
    options,
    repoRoot,
    warnings: loaded.warnings,
    configSources: loaded.sources
  };
}

export async function executeReviewCommand(
  parsed: ParsedReviewCommand
): Promise<ExecuteReviewCommandResult> {
  const run = createRunTelemetry({
    telemetryConfig: parsed.config.telemetry,
    runMetadata: {
      argv: process.argv,
      repoRoot: parsed.repoRoot,
      review: {
        mode: parsed.target.mode,
        target: parsed.target,
        ...(parsed.target.mode === "github_pr" ? { prNumber: parsed.target.prNumber } : {}),
        depth: parsed.config.review.depth,
        lenses: parsed.config.lenses.enabled,
        format: parsed.options.format,
        postGithubComments: parsed.options.postGithubComments
      }
    }
  });

  for (const warning of parsed.warnings) {
    run.logger.warn({
      runId: run.recorder.runId,
      stage: 0,
      event: "config_warning",
      message: warning.message,
      data: { key: warning.key, source: warning.source }
    });
  }

  run.recorder.event({
    stage: 0,
    level: "info",
    message: "review command parsed",
    data: {
      target: parsed.target,
      format: parsed.options.format,
      postGithubComments: parsed.options.postGithubComments
    }
  });

  const attached = await run.attachRunDirectory(parsed.repoRoot);
  await run.recorder.writeArtifact("coverage.json", {
    status: "not_implemented",
    phase: 1,
    reason: "review pipeline stages are implemented in later phases",
    target: parsed.target
  });
  run.recorder.event({
    stage: 0,
    level: "info",
    message: "phase 1 review foundation initialized",
    data: { runDir: attached.runDir }
  });
  await run.finalize({ status: "completed", exitCode: 0 });
  return attached;
}

function resolveTarget(options: CommanderReviewOptions, commits: string[]): ReviewCommandTarget {
  const hasPr = options.pr !== undefined;
  const hasBranch = options.branch !== undefined;
  const hasCommits = commits.length > 0;
  const targetModeCount = [hasPr, hasBranch, hasCommits].filter(Boolean).length;

  if (targetModeCount > 1) {
    throw new CodeninjaError(
      "invalid_args",
      "--pr, --branch, and positional commits are mutually exclusive"
    );
  }

  if (commits.length > 2) {
    throw new CodeninjaError("invalid_args", "commit review accepts at most two positional commits");
  }

  if (options.postGithubComments && !hasPr) {
    throw new CodeninjaError("invalid_args", "--post-github-comments requires --pr");
  }

  if (options.base !== undefined && (hasPr || hasCommits)) {
    throw new CodeninjaError("invalid_args", "--base is only valid for branch review");
  }

  if (hasPr) {
    return { mode: "github_pr", prNumber: parsePrNumber(options.pr) };
  }

  if (hasBranch) {
    const branchName = requireNonEmpty(options.branch, "--branch");
    return withOptionalBase({ mode: "branch", branchName }, options.base);
  }

  if (hasCommits) {
    const [startCommit, endCommit] = commits;
    if (!startCommit) {
      throw new CodeninjaError("invalid_args", "commit review requires a start commit");
    }
    return endCommit === undefined
      ? { mode: "commit_range", startCommit }
      : { mode: "commit_range", startCommit, endCommit };
  }

  return withOptionalBase({ mode: "default_branch" }, options.base);
}

function buildCliOverrides(options: CommanderReviewOptions): CliConfigOverrides {
  const cli: CliConfigOverrides = {};
  if (options.depth !== undefined) {
    cli.depth = parseDepth(options.depth);
  }
  if (options.lens && options.lens.length > 0) {
    cli.lenses = options.lens;
  }
  if (options.provider !== undefined) {
    cli.provider = requireNonEmpty(options.provider, "--provider");
  }
  if (options.model !== undefined) {
    cli.model = requireNonEmpty(options.model, "--model");
  }
  if (options.reasoning !== undefined) {
    cli.reasoning = parseReasoning(options.reasoning);
  }
  if (options.cache !== undefined) {
    cli.cacheEnabled = options.cache;
  }
  return cli;
}

function buildReviewOptions(options: CommanderReviewOptions): ParsedReviewCommand["options"] {
  const parsed = {
    format: parseFormat(options.format ?? "markdown"),
    postGithubComments: options.postGithubComments ?? false
  };
  return {
    ...parsed,
    ...(options.cache !== undefined ? { cacheOverride: options.cache } : {}),
    ...(options.lens && options.lens.length > 0 ? { cliLenses: [...options.lens] } : {})
  };
}

function parsePrNumber(value: string | undefined): number {
  const raw = requireNonEmpty(value, "--pr");
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new CodeninjaError("invalid_args", "--pr must be a positive integer");
  }
  return Number(raw);
}

function parseDepth(value: string): ReviewDepth {
  if (value === "light" || value === "normal" || value === "deep") {
    return value;
  }
  throw new CodeninjaError("invalid_args", "--depth must be one of: light, normal, deep");
}

function parseReasoning(value: string): ReasoningLevel | "auto" {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "auto") {
    return value;
  }
  throw new CodeninjaError(
    "invalid_args",
    "--reasoning must be one of: low, medium, high, xhigh, auto"
  );
}

function parseFormat(value: string): OutputFormat {
  if (value === "markdown" || value === "json") {
    return value;
  }
  throw new CodeninjaError("invalid_args", "--format must be one of: markdown, json");
}

function requireNonEmpty(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "") {
    throw new CodeninjaError("invalid_args", `${flag} requires a value`);
  }
  return value;
}

function withOptionalBase<T extends { mode: "default_branch" | "branch" }>(
  target: T,
  base: string | undefined
): T & { baseBranch?: string } {
  if (base === undefined) {
    return target;
  }
  return { ...target, baseBranch: requireNonEmpty(base, "--base") };
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
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
  return new CodeninjaError("invalid_args", "failed to parse command line", { cause: error });
}
