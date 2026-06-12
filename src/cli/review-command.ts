import path from "node:path";
import { Command, CommanderError } from "commander";
import { loadConfig, type CliConfigOverrides, type LoadConfigOptions } from "../config/config-loader.js";
import type {
  OutputFormat,
  ParsedReviewCommand,
  ReasoningLevel,
  ReviewCommandTarget,
  ReviewDepth,
  ReviewResult
} from "../types.js";
import { CodeninjaError } from "../util/errors.js";
import { runReview } from "../pipeline/review-runner.js";

type ParseReviewCommandOptions = {
  repoRoot?: string;
  homeOverride?: string;
  env?: NodeJS.ProcessEnv;
  allowOutput?: boolean;
};

type ExecuteReviewCommandResult = {
  runId: string;
  runDir: string;
  filesChanged: number;
  keptFiles: number;
  hunks: number;
  review: ReviewResult;
};

type ExecuteReviewCommandOptions = {
  writeOutput?: (text: string) => void;
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
    .exitOverride();

  if (!opts.allowOutput) {
    program.configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined
    });
  }

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
  const provider = program.command("provider").description("manage model providers and defaults");
  provider.command("list").description("list known providers and auth status");
  provider.command("login").description("store credentials for a provider").argument("<provider>");
  provider.command("logout").description("remove stored provider credentials").argument("[provider]").option("--yes", "confirm removing all credentials");
  provider.command("auth-status").description("show stored or environment auth status").argument("[provider]");
  provider.command("models").description("list available models").argument("[query]").option("--all", "include unauthenticated providers");
  const providerConfig = provider.command("config").description("show or update provider defaults");
  providerConfig.command("set-provider").argument("<provider>");
  providerConfig.command("set-model").argument("<provider>").argument("<model>");
  providerConfig.command("set-depth").argument("<light|normal|deep>");
  providerConfig.command("set-reasoning").argument("<low|medium|high|xhigh|auto>");

  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    if (isCommanderDisplayExit(error)) {
      throw new CliDisplayExit(error.exitCode);
    }
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
  parsed: ParsedReviewCommand,
  opts: ExecuteReviewCommandOptions = {}
): Promise<ExecuteReviewCommandResult> {
  let attached = { runId: "", runDir: "" };
  let inventory = { filesChanged: 0, keptFiles: 0 };
  const overrides = {
    repoRoot: parsed.repoRoot,
    format: parsed.options.format,
    postGithubComments: parsed.options.postGithubComments,
    onRunStart: (run: { runId: string; runDir: string }) => {
      attached = run;
    },
    onInventory: (nextInventory: { filesChanged: number; keptFiles: number }) => {
      inventory = nextInventory;
    }
  };
  const review = await runReview(parsed.target, parsed.config, {
    ...overrides,
    configWarnings: parsed.warnings,
    ...(parsed.options.cliLenses !== undefined ? { cliLenses: parsed.options.cliLenses } : {}),
    ...(opts.writeOutput !== undefined ? { writeOutput: opts.writeOutput } : {})
  });
  return {
    ...attached,
    filesChanged: inventory.filesChanged,
    keptFiles: inventory.keptFiles,
    hunks: review.coverage.totalHunks,
    review
  };
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

export class CliDisplayExit extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super("command displayed output");
    this.name = "CliDisplayExit";
    this.exitCode = exitCode;
  }
}

export function isCliDisplayExit(error: unknown): error is CliDisplayExit {
  return error instanceof CliDisplayExit;
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
  return new CodeninjaError("invalid_args", "failed to parse command line", { cause: error });
}
