import { execFileSync } from "node:child_process";
import path from "node:path";
import { Command, CommanderError } from "commander";
import { loadConfig, type CliConfigOverrides, type LoadConfigOptions } from "../config/config-loader.js";
import { MAX_REVIEW_TIME_MINUTES } from "../config/schema.js";
import type {
  OutputFormat,
  ParsedReviewCommand,
  ReasoningLevel,
  ReviewCommandTarget,
  ReviewDepth,
  ReviewResult,
  TelemetryEvent
} from "../types.js";
import { CodegenieError } from "../util/errors.js";
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
  onRunStart?: (run: { runId: string; runDir: string }) => void;
  onTelemetryEvent?: (event: Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">) => void;
};

type CommanderReviewOptions = {
  pr?: string;
  branch?: string;
  head?: string;
  base?: string;
  depth?: string;
  budgetBoost?: string;
  maxTime?: string;
  lens?: string[];
  provider?: string;
  model?: string;
  reasoning?: string;
  format?: string;
  postGithubComments?: boolean;
  cache?: boolean;
  ci?: boolean;
  progress?: boolean;
};

export function parseReviewCommand(
  argv: string[],
  opts: ParseReviewCommandOptions = {}
): ParsedReviewCommand {
  let commandOptions: CommanderReviewOptions | undefined;
  let commits: string[] = [];

  const program = new Command();
  program
    .name("codegenie")
    .option("-V, --version", "show codegenie version")
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
    .argument("[target...]", "branch, commit, commit range, or <base>...<head> shorthand to review")
    .option("--pr <number>", "GitHub pull request number")
    .option("--branch <branch>", "branch to review")
    .option("--head <ref>", "head ref or commit to review with --base")
    .option("--base <branch>", "base branch/ref for branch/head/default review")
    .option("--depth <depth>", "review depth: light, normal, or deep")
    .option("--budget-boost <factor>", "scale per-packet tool/result/call budgets by this factor (e.g. 2 doubles them)")
    .option("--max-time <minutes>", "override review.maxTime in minutes for this run (default 30)")
    .option("--lens <lens>", "review lens to enable for this run", collect, [])
    .option("--provider <provider>", "provider override")
    .option("--model <model>", "model override")
    .option("--reasoning <level>", "reasoning level: low, medium, high, xhigh, or auto")
    .option("--format <format>", "output format: markdown or json", "markdown")
    .option("--post-github-comments", "post inline comments to GitHub for --pr runs")
    .option("--ci", "disable interactive progress output for CI-friendly logs")
    .option("--no-progress", "disable the interactive progress spinner")
    .option("--cache", "enable local model-call cache for this run; provider prompt caching is reported separately")
    .option("--no-cache", "disable local model-call cache for this run; provider prompt caching is reported separately")
    .action((commitArgs: string[], options: CommanderReviewOptions) => {
      commits = commitArgs;
      commandOptions = options;
    });
  const provider = program.command("provider").description("manage model providers and defaults");
  provider.command("list").description("list known providers and auth status");
  provider
    .command("login")
    .description("store credentials for a provider")
    .argument("<provider>")
    .option("--api-key", "store an API key instead of using OAuth");
  provider.command("logout").description("remove stored provider credentials").argument("[provider]").option("--yes", "confirm removing all credentials");
  provider.command("auth-status").description("show stored or environment auth status").argument("[provider]");
  provider.command("models").description("list available models").argument("[query]").option("--all", "include unauthenticated providers");
  provider.command("use").description("set the default provider/model by fuzzy model id").argument("<model>");
  const providerConfig = provider.command("config").description("show or update provider defaults");
  providerConfig.command("set-provider").argument("<provider>");
  providerConfig.command("set-model").argument("<provider>").argument("<model>");
  providerConfig.command("set-depth").argument("<light|normal|deep>");
  providerConfig.command("set-reasoning").argument("<low|medium|high|xhigh|auto>");
  program.command("version").description("show codegenie version");
  program.command("eval").description("run codegenie eval suites");

  try {
    program.parse(argv, { from: "user" });
  } catch (error) {
    if (isCommanderDisplayExit(error)) {
      throw new CliDisplayExit(error.exitCode);
    }
    throw commanderToCodegenieError(error);
  }

  if (!commandOptions) {
    throw new CodegenieError("invalid_args", "expected command: codegenie review");
  }

  const repoRoot = resolveInitialRepoRoot(opts.repoRoot);
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
      opts.onRunStart?.(run);
    },
    onInventory: (nextInventory: { filesChanged: number; keptFiles: number }) => {
      inventory = nextInventory;
    },
    ...(opts.onTelemetryEvent !== undefined ? { onTelemetryEvent: opts.onTelemetryEvent } : {})
  };
  const review = await runReview(parsed.target, parsed.config, {
    ...overrides,
    configWarnings: parsed.warnings,
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
  const hasHead = options.head !== undefined;
  const hasCommits = commits.length > 0;
  const targetModeCount = [hasPr, hasBranch, hasHead, hasCommits].filter(Boolean).length;

  if (targetModeCount > 1) {
    throw new CodegenieError(
      "invalid_args",
      "--pr, --branch, --head, and positional commits are mutually exclusive"
    );
  }

  if (commits.length > 2) {
    throw new CodegenieError("invalid_args", "review accepts at most two positional targets");
  }

  if (options.postGithubComments && !hasPr) {
    throw new CodegenieError("invalid_args", "--post-github-comments requires --pr");
  }

  if (options.base !== undefined && (hasPr || (hasCommits && !isSingleRef(commits)))) {
    throw new CodegenieError("invalid_args", "--base is only valid for branch, head, or default review");
  }

  if (hasPr) {
    return { mode: "github_pr", prNumber: parsePrNumber(options.pr) };
  }

  if (hasBranch) {
    const branchName = requireNonEmpty(options.branch, "--branch");
    return withOptionalBase({ mode: "branch", branchName }, options.base);
  }

  if (hasHead) {
    const headRef = requireNonEmpty(options.head, "--head");
    const baseRef = requireNonEmpty(options.base, "--base");
    return { mode: "head", headRef, baseRef };
  }

  if (hasCommits) {
    const shorthand = parseBaseHeadShorthand(commits);
    if (shorthand !== undefined) {
      return shorthand;
    }
    const [startRef, endCommit] = commits;
    if (!startRef) {
      throw new CodegenieError("invalid_args", "review target requires a branch, commit, or range");
    }
    return endCommit === undefined
      ? withOptionalBase({ mode: "single_ref", ref: startRef }, options.base)
      : { mode: "commit_range", startCommit: startRef, endCommit };
  }

  return withOptionalBase({ mode: "default_branch" }, options.base);
}

function isBaseHeadShorthand(commits: string[]): boolean {
  return commits.length === 1 && commits[0]?.includes("...") === true;
}

function isSingleRef(commits: string[]): boolean {
  return commits.length === 1 && !isBaseHeadShorthand(commits);
}

function parseBaseHeadShorthand(commits: string[]): ReviewCommandTarget | undefined {
  if (!isBaseHeadShorthand(commits)) {
    return undefined;
  }
  const raw = commits[0] ?? "";
  const parts = raw.split("...");
  if (parts.length !== 2) {
    throw new CodegenieError(
      "invalid_args",
      "base/head shorthand must be exactly <base>...<head>"
    );
  }
  const [baseRef, headRef] = parts.map((part) => part.trim());
  if (!baseRef || !headRef) {
    throw new CodegenieError(
      "invalid_args",
      "base/head shorthand must be exactly <base>...<head>"
    );
  }
  return { mode: "head", headRef, baseRef };
}

function buildCliOverrides(options: CommanderReviewOptions): CliConfigOverrides {
  const cli: CliConfigOverrides = {};
  if (options.depth !== undefined) {
    cli.depth = parseDepth(options.depth);
  }
  if (options.budgetBoost !== undefined) {
    cli.budgetBoost = parseBudgetBoost(options.budgetBoost);
  }
  if (options.maxTime !== undefined) {
    cli.maxTimeMs = parseMaxTime(options.maxTime);
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
    postGithubComments: options.postGithubComments ?? false,
    progress: options.ci === true ? false : options.progress !== false
  };
  return {
    ...parsed,
    ...(options.cache !== undefined ? { cacheOverride: options.cache } : {}),
  };
}

function resolveInitialRepoRoot(input: string | undefined): string {
  const candidate = path.resolve(input ?? process.cwd());
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: candidate,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0"
      }
    }).trim();
    return root === "" ? candidate : path.resolve(root);
  } catch {
    return candidate;
  }
}

function parsePrNumber(value: string | undefined): number {
  const raw = requireNonEmpty(value, "--pr");
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new CodegenieError("invalid_args", "--pr must be a positive integer");
  }
  return Number(raw);
}

function parseDepth(value: string): ReviewDepth {
  if (value === "light" || value === "normal" || value === "deep") {
    return value;
  }
  throw new CodegenieError("invalid_args", "--depth must be one of: light, normal, deep");
}

function parseBudgetBoost(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CodegenieError("invalid_args", "--budget-boost must be a positive number");
  }
  return parsed;
}

function parseMaxTime(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CodegenieError("invalid_args", "--max-time must be a positive number of minutes");
  }
  if (parsed > MAX_REVIEW_TIME_MINUTES) {
    throw new CodegenieError(
      "invalid_args",
      `--max-time exceeds the supported maximum of ${MAX_REVIEW_TIME_MINUTES} minutes`
    );
  }
  return parsed * 60_000;
}

function parseReasoning(value: string): ReasoningLevel | "auto" {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "auto") {
    return value;
  }
  throw new CodegenieError(
    "invalid_args",
    "--reasoning must be one of: low, medium, high, xhigh, auto"
  );
}

function parseFormat(value: string): OutputFormat {
  if (value === "markdown" || value === "json") {
    return value;
  }
  throw new CodegenieError("invalid_args", "--format must be one of: markdown, json");
}

function requireNonEmpty(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "") {
    throw new CodegenieError("invalid_args", `${flag} requires a value`);
  }
  return value;
}

function withOptionalBase<T extends { mode: "default_branch" | "branch" | "single_ref" }>(
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

function commanderToCodegenieError(error: unknown): CodegenieError {
  if (error instanceof CommanderError) {
    return new CodegenieError("invalid_args", error.message, {
      context: { code: error.code, exitCode: error.exitCode }
    });
  }
  if (error instanceof CodegenieError) {
    return error;
  }
  return new CodegenieError("invalid_args", "failed to parse command line", { cause: error });
}
