import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { executeReviewCommand, parseReviewCommand } from "../cli/review-command.js";
import { getPiApiKeyEnvVarName } from "../provider/pi-ai-models.js";
import { renderMarkdownReview } from "../output/markdown-renderer.js";
import { sanitizeGitHubCommentBody, scrubGitHubSecrets } from "../github/comment-sanitizer.js";
import type { ReviewResult, TelemetryEvent } from "../types.js";
import { CodegenieError, isCodegenieError } from "../util/errors.js";
import {
  DEFAULT_ALLOWED_ASSOCIATIONS,
  DEFAULT_TRIGGER_PHRASE,
  decideTrigger,
  type TriggerDecision,
  type TriggerRules
} from "./event-gate.js";
import { createIssueCommentClient, type IssueCommentClient } from "./issue-comments.js";
import { createStatusCommentController } from "./status-comment.js";

type ProgressEvent = Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">;

type ReviewHooks = {
  onRunStart: (run: RunAttachment) => void;
  onTelemetryEvent: (event: ProgressEvent) => void;
  writeOutput: (text: string) => void;
};

type RunAttachment = {
  runId: string;
  runDir: string;
};

export type RunReviewResult = RunAttachment & {
  // The full markdown review. Never the writeOutput capture: with inline
  // posting enabled, stdout carries the short posting summary, not the report.
  reportMarkdown: string;
};

export type ExecuteGitHubActionOptions = {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  writeOutput?: (text: string) => void;
  issueComments?: IssueCommentClient;
  runReview?: (reviewArgv: string[], hooks: ReviewHooks) => Promise<RunReviewResult>;
  minEditIntervalMs?: number;
};

type GitHubActionInputs = {
  triggerPhrase: string;
  onPullRequest: boolean;
  allowedAssociations: string[];
  allowedUsers: string[];
  postInlineComments: boolean;
  preflightOnly: boolean;
  botLogin?: string;
  model?: ModelSpec;
  reviewPassthrough: string[];
};

type PermissionCheck = "allowlisted" | "write";

type AuthorizedDecision = Extract<TriggerDecision, { run: true }> & {
  permissionCheck: PermissionCheck;
};

export type ModelSpec = {
  provider?: string;
  model: string;
  reasoning: string;
};

const REASONING_LEVELS = new Set(["low", "medium", "high", "xhigh", "auto"]);

// The `codegenie github-action` subcommand: the whole GitHub Actions surface
// (plan 97). Composes the review path through its public seams only — the
// review cannot tell an Action invoked it.
export async function executeGitHubActionCommand(
  argv: string[],
  opts: ExecuteGitHubActionOptions = {}
): Promise<void> {
  const env = opts.env ?? process.env;
  const write = opts.writeOutput ?? ((text: string) => process.stdout.write(text));
  const repoRoot = opts.repoRoot ?? process.cwd();
  const inputs = parseGitHubActionArgs(argv);

  const eventName = requireEnv(env, "GITHUB_EVENT_NAME");
  const eventPath = requireEnv(env, "GITHUB_EVENT_PATH");
  const repoFullName = requireEnv(env, "GITHUB_REPOSITORY");
  const runUrl = buildRunUrl(env, repoFullName);

  const payload = readEventPayload(eventPath);
  const rules: TriggerRules = {
    triggerPhrase: inputs.triggerPhrase,
    onPullRequest: inputs.onPullRequest,
    allowedAssociations: inputs.allowedAssociations,
    allowedUsers: inputs.allowedUsers
  };
  const decision = decideTrigger(eventName, payload, rules);
  if (!decision.run) {
    write(`github-action: skipped — ${decision.reason}\n`);
    writeDecisionRecord(write, { eventName, run: false, reason: decision.reason });
    writePreflightOutputs(env, false);
    return;
  }

  const comments = opts.issueComments ?? createIssueCommentClient(repoRoot, repoFullName);

  // Payload association fields are attacker-visible history; the live
  // permission check is authoritative. Explicitly allowlisted users skip it.
  let permissionCheck: PermissionCheck = "allowlisted";
  if (!decision.actorAllowlisted) {
    const permitted = await hasWritePermission(comments, decision.actor);
    if (!permitted) {
      const reason = `actor ${decision.actor} lacks repository write access`;
      write(`github-action: skipped — ${reason}\n`);
      writeDecisionRecord(write, {
        eventName,
        run: false,
        reason,
        lane: decision.lane,
        prNumber: decision.prNumber,
        actor: decision.actor,
        association: decision.association,
        actorAllowlisted: false,
        permissionCheck: "denied"
      });
      writePreflightOutputs(env, false);
      return;
    }
    permissionCheck = "write";
  }

  const authorized: AuthorizedDecision = { ...decision, permissionCheck };
  writePreflightOutputs(env, true, decision.prNumber);
  writeDecisionRecord(write, {
    eventName,
    run: true,
    lane: decision.lane,
    prNumber: decision.prNumber,
    actor: decision.actor,
    association: decision.association,
    actorAllowlisted: decision.actorAllowlisted,
    permissionCheck
  });
  if (inputs.preflightOnly) {
    write(`github-action: preflight authorized ${decision.lane} trigger for PR #${decision.prNumber}\n`);
    return;
  }

  applyGenericApiKey(env, inputs.model);

  // Identity resolution order: explicit bot-login input (custom GitHub
  // Apps) → /user lookup (PATs) → the GITHUB_TOKEN default. Reclaim and
  // duplicate detection both key off this, so it must be exact.
  const ownLogin = inputs.botLogin ?? (await comments.getViewerLogin()) ?? "github-actions[bot]";

  const controller = createStatusCommentController({
    comments,
    prNumber: decision.prNumber,
    ownLogin,
    log: write,
    ...(runUrl !== undefined ? { runUrl } : {}),
    ...(opts.minEditIntervalMs !== undefined ? { minEditIntervalMs: opts.minEditIntervalMs } : {})
  });
  const claimed = await controller.claim();
  write(`github-action: ${decision.lane} trigger by ${decision.actor} — reviewing PR #${decision.prNumber} (status comment ${claimed.commentId})\n`);

  // Injected into the run's gh-backed client (guarded fallback seam) for
  // duplicate detection under installation tokens. The read-back author of a
  // comment we just created is ground truth, so it wins over the resolved
  // login — self-correcting for a custom app missing its bot-login input.
  env.CODEGENIE_GITHUB_LOGIN = claimed.author !== "" ? claimed.author : ownLogin;

  const reviewArgv = [
    "review",
    "--pr",
    String(decision.prNumber),
    "--ci",
    ...(inputs.postInlineComments ? ["--post-github-comments"] : []),
    ...(inputs.model !== undefined
      ? [
          ...(inputs.model.provider !== undefined ? ["--provider", inputs.model.provider] : []),
          "--model",
          inputs.model.model,
          "--reasoning",
          inputs.model.reasoning
        ]
      : []),
    ...inputs.reviewPassthrough
  ];

  const runReview = opts.runReview ?? defaultRunReview(repoRoot);
  let attachment: RunAttachment | undefined;
  let runResult: RunReviewResult;
  try {
    runResult = await runReview(reviewArgv, {
      onRunStart: (run) => {
        attachment = run;
      },
      onTelemetryEvent: controller.onTelemetryEvent,
      // Pass stdout through to the Actions log; with inline posting on it is
      // the posting summary, which belongs in the log, not the comment.
      writeOutput: write
    });
  } catch (error) {
    const code = error instanceof CodegenieError ? error.code : error instanceof Error ? error.name : "unknown_error";
    await controller.finalizeFailure(code);
    emitActionRecord(attachment?.runDir, eventName, authorized, "review_failed", controller.stats(), env, write, code);
    throw error;
  }

  // Fallback copies land before the terminal PATCH so the report survives a
  // failed edit (which still fails the run as github_post_failed).
  publishReportFiles(runResult.reportMarkdown, env);
  try {
    await controller.finalizeSuccess(runResult.reportMarkdown);
  } catch (error) {
    const code = error instanceof CodegenieError ? error.code : error instanceof Error ? error.name : "unknown_error";
    emitActionRecord(runResult.runDir, eventName, authorized, "terminal_post_failed", controller.stats(), env, write, code);
    throw error;
  }
  emitActionRecord(runResult.runDir, eventName, authorized, "success", controller.stats(), env, write);
  write(`github-action: review complete — report posted to PR #${decision.prNumber}\n`);
}

function defaultRunReview(repoRoot: string): (reviewArgv: string[], hooks: ReviewHooks) => Promise<RunReviewResult> {
  return async (reviewArgv, hooks) => {
    const parsed = parseReviewCommand(reviewArgv, { repoRoot });
    const result = await executeReviewCommand(parsed, {
      onRunStart: hooks.onRunStart,
      onTelemetryEvent: hooks.onTelemetryEvent,
      writeOutput: hooks.writeOutput
    });
    return toRunReviewResult(result);
  };
}

export function toRunReviewResult(result: { runId: string; runDir: string; review: ReviewResult }): RunReviewResult {
  return {
    runId: result.runId,
    runDir: result.runDir,
    reportMarkdown: scrubGitHubSecrets(renderMarkdownReview(result.review))
  };
}

export function parseGitHubActionArgs(argv: string[]): GitHubActionInputs {
  const inputs: GitHubActionInputs = {
    triggerPhrase: DEFAULT_TRIGGER_PHRASE,
    onPullRequest: true,
    allowedAssociations: [...DEFAULT_ALLOWED_ASSOCIATIONS],
    allowedUsers: [],
    postInlineComments: true,
    preflightOnly: false,
    reviewPassthrough: []
  };
  const passthroughFlags = new Set(["--depth", "--lens", "--max-time", "--budget-boost"]);

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] ?? "";
    const value = argv[index + 1];
    if (value === undefined) {
      throw new CodegenieError("invalid_args", `${flag} requires a value`);
    }
    if (flag === "--trigger-phrase") {
      inputs.triggerPhrase = value;
    } else if (flag === "--on-pull-request") {
      inputs.onPullRequest = parseBoolean(flag, value);
    } else if (flag === "--allowed-associations") {
      inputs.allowedAssociations = parseCsv(value);
    } else if (flag === "--allowed-users") {
      inputs.allowedUsers = parseCsv(value);
    } else if (flag === "--post-inline-comments") {
      inputs.postInlineComments = parseBoolean(flag, value);
    } else if (flag === "--preflight-only") {
      inputs.preflightOnly = parseBoolean(flag, value);
    } else if (flag === "--model") {
      if (value.trim() !== "") {
        inputs.model = parseModelSpec(value.trim());
      }
    } else if (flag === "--bot-login") {
      if (value.trim() !== "") {
        inputs.botLogin = value.trim();
      }
    } else if (passthroughFlags.has(flag)) {
      if (value.trim() !== "") {
        inputs.reviewPassthrough.push(flag, value);
      }
    } else {
      throw new CodegenieError("invalid_args", `unknown github-action flag: ${flag}`);
    }
  }
  if (inputs.triggerPhrase.trim() === "") {
    throw new CodegenieError("invalid_args", "--trigger-phrase must not be empty");
  }
  return inputs;
}

// One model spec instead of separate provider/model/reasoning inputs:
// `provider/model[:reasoning]`, e.g. `anthropic/claude-opus-4-8:xhigh`.
// Reasoning defaults to "high" — Action reviews are unattended, so the
// action's posture favors quality over the CLI's interactive default. A
// `:suffix` that is not a reasoning level stays part of the model id
// (ollama-style `provider/llama3:8b`).
export function parseModelSpec(spec: string): ModelSpec {
  let reasoning = "high";
  let rest = spec;
  const colon = spec.lastIndexOf(":");
  if (colon > -1 && REASONING_LEVELS.has(spec.slice(colon + 1))) {
    reasoning = spec.slice(colon + 1);
    rest = spec.slice(0, colon);
  }
  const slash = rest.indexOf("/");
  const provider = slash > 0 ? rest.slice(0, slash) : undefined;
  const model = slash > 0 ? rest.slice(slash + 1) : rest;
  if (model.trim() === "" || (slash === 0)) {
    throw new CodegenieError("invalid_args", `--model must be provider/model[:reasoning], got: ${spec}`);
  }
  return {
    ...(provider !== undefined ? { provider } : {}),
    model,
    reasoning
  };
}

// Routes a generic LLM_API_KEY to the env var the selected provider actually
// reads (the names are not uniform: google reads GEMINI_API_KEY). Explicitly
// set provider-native vars always win; the generic key never overwrites.
export function applyGenericApiKey(env: NodeJS.ProcessEnv, model: ModelSpec | undefined): void {
  const generic = env.LLM_API_KEY;
  if (generic === undefined || generic === "") {
    return;
  }
  if (model?.provider === undefined) {
    throw new CodegenieError(
      "invalid_args",
      "LLM_API_KEY requires a model input with a provider prefix (e.g. anthropic/claude-opus-4-8) so the key can be routed"
    );
  }
  const envVarName = getPiApiKeyEnvVarName(model.provider);
  if (envVarName === undefined) {
    throw new CodegenieError(
      "invalid_args",
      `provider ${model.provider} does not accept an API key; set its native credentials instead of LLM_API_KEY`
    );
  }
  if (env[envVarName] === undefined || env[envVarName] === "") {
    env[envVarName] = generic;
  }
}

async function hasWritePermission(comments: IssueCommentClient, login: string): Promise<boolean> {
  if (login === "") {
    return false;
  }
  try {
    const permission = await comments.getCollaboratorPermission(login);
    // GitHub's legacy permission field: maintain reports as "write".
    return permission === "admin" || permission === "write";
  } catch (error) {
    // Non-collaborators 404 → a denied trigger is a skip, not a failure. Any
    // other error (bad token, gh missing) must surface as a failure — reading
    // it as a denial would hide infrastructure problems behind a green check.
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  if (!isCodegenieError(error)) {
    return false;
  }
  const raw = [error.message, error.context?.stderr, error.context?.stdout]
    .map((value) => (typeof value === "string" ? value : ""))
    .join("\n");
  return /\b404\b|Not Found/iu.test(raw);
}

function readEventPayload(eventPath: string): unknown {
  try {
    return JSON.parse(readFileSync(eventPath, "utf8")) as unknown;
  } catch (error) {
    throw new CodegenieError("invalid_args", `failed to read GitHub event payload at ${eventPath}`, { cause: error });
  }
}

function publishReportFiles(report: string, env: NodeJS.ProcessEnv): void {
  // Step summary and report file are conveniences; failures must not undo a
  // successfully posted review.
  const stepSummary = env.GITHUB_STEP_SUMMARY;
  if (stepSummary !== undefined && stepSummary !== "") {
    try {
      // The job summary is a GitHub-rendered surface just like a comment.
      // Keep the canonical secret-scrubbed Markdown in the downloadable file,
      // but also neutralize mentions and HTML comments in the summary copy.
      appendFileSync(stepSummary, `${sanitizeGitHubCommentBody(report).trimEnd()}\n`);
    } catch {
      // ignore
    }
  }
  const reportPath = env.CODEGENIE_REPORT_PATH;
  if (reportPath !== undefined && reportPath !== "") {
    try {
      writeFileSync(reportPath, report);
    } catch {
      // ignore
    }
  }
}

type DecisionRecord =
  | { eventName: string; run: false; reason: string }
  | {
      eventName: string;
      run: true;
      lane: AuthorizedDecision["lane"];
      prNumber: number;
      actor: string;
      association: string;
      actorAllowlisted: boolean;
      permissionCheck: PermissionCheck;
    }
  | {
      eventName: string;
      run: false;
      reason: string;
      lane: AuthorizedDecision["lane"];
      prNumber: number;
      actor: string;
      association: string;
      actorAllowlisted: false;
      permissionCheck: "denied";
    };

function writeDecisionRecord(write: (text: string) => void, record: DecisionRecord): void {
  write(`github-action: decision ${JSON.stringify(scrubGitHubSecrets(record))}\n`);
}

function writePreflightOutputs(env: NodeJS.ProcessEnv, shouldRun: boolean, prNumber?: number): void {
  const outputPath = env.GITHUB_OUTPUT;
  if (outputPath === undefined || outputPath === "") {
    return;
  }
  try {
    const lines = [`should-run=${shouldRun}`];
    if (prNumber !== undefined) {
      lines.push(`pr-number=${prNumber}`);
    }
    appendFileSync(outputPath, `${lines.join("\n")}\n`);
  } catch {
    // GitHub owns this path. A missing/unwritable output file should fail the
    // preflight because otherwise the authorized review job can never start.
    if (env.GITHUB_ACTIONS === "true") {
      throw new CodegenieError("invalid_args", "failed to write GitHub Action preflight outputs");
    }
  }
}

function emitActionRecord(
  runDir: string | undefined,
  eventName: string,
  decision: AuthorizedDecision,
  outcome: "success" | "review_failed" | "terminal_post_failed",
  stats: ReturnType<ReturnType<typeof createStatusCommentController>["stats"]>,
  env: NodeJS.ProcessEnv,
  write: (text: string) => void,
  errorCode?: string
): void {
  const record = {
    schemaVersion: 1,
    eventName,
    lane: decision.lane,
    prNumber: decision.prNumber,
    actor: decision.actor,
    association: decision.association,
    actorAllowlisted: decision.actorAllowlisted,
    permissionCheck: decision.permissionCheck,
    outcome,
    ...(errorCode !== undefined ? { errorCode } : {}),
    runUrl: buildRunUrl(env, env.GITHUB_REPOSITORY ?? "") ?? null,
    statusComment: stats
  };
  const serialized = JSON.stringify(scrubGitHubSecrets(record));
  // Telemetry is intentionally off by default. The same bounded lifecycle
  // record always reaches the CI log; persistence is an optional extra when
  // the review attached a telemetry run directory.
  write(`github-action: lifecycle ${serialized}\n`);
  if (runDir === undefined || runDir === "") {
    return;
  }
  try {
    writeFileSync(path.join(runDir, "github-action.json"), `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // Module-owned telemetry; never fails the run.
  }
}

function buildRunUrl(env: NodeJS.ProcessEnv, repoFullName: string): string | undefined {
  const runId = env.GITHUB_RUN_ID;
  if (runId === undefined || runId === "" || repoFullName === "") {
    return undefined;
  }
  const server = env.GITHUB_SERVER_URL !== undefined && env.GITHUB_SERVER_URL !== "" ? env.GITHUB_SERVER_URL : "https://github.com";
  return `${server}/${repoFullName}/actions/runs/${runId}`;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new CodegenieError("invalid_args", `${name} is required — codegenie github-action only runs inside GitHub Actions`);
  }
  return value;
}

function parseBoolean(flag: string, value: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new CodegenieError("invalid_args", `${flag} must be "true" or "false"`);
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}
