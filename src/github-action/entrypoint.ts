import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { executeReviewCommand, parseReviewCommand } from "../cli/review-command.js";
import { getCodegeniePaths } from "../config/paths.js";
import { createFileAuthStorage, type PiAuthStorage } from "../provider/provider-services.js";
import { renderMarkdownReview } from "../output/markdown-renderer.js";
import { sanitizeGitHubCommentBody, scrubGitHubSecrets } from "../github/comment-sanitizer.js";
import type { ReviewResult, TelemetryEvent } from "../types.js";
import { CodegenieError, isCodegenieError, type CodegenieErrorCode } from "../util/errors.js";
import {
  structuredSubmitFailureDiagnosticFromError,
  type StructuredSubmitFailureDiagnostic
} from "../llm/schema-diagnostics.js";
import {
  DEFAULT_ALLOWED_ASSOCIATIONS,
  DEFAULT_TRIGGER_PHRASE,
  decideTrigger,
  type TriggerDecision,
  type TriggerRules
} from "./event-gate.js";
import { createIssueCommentClient, type IssueCommentClient } from "./issue-comments.js";
import {
  applyLlmApiKey,
  formatModelSpec,
  parseModelAliases,
  renderUnknownAliasReply,
  resolveModelConfig,
  selectModel,
  type ModelConfig,
  type ModelSelection
} from "./models.js";
import { createStatusCommentController } from "./status-comment.js";
import { renderProviderMessage, renderStructuredSubmitFailure } from "./render.js";

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
  failed?: boolean;
};

export type ExecuteGitHubActionOptions = {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  writeOutput?: (text: string) => void;
  issueComments?: IssueCommentClient;
  runReview?: (reviewArgv: string[], hooks: ReviewHooks) => Promise<RunReviewResult>;
  minEditIntervalMs?: number;
  // Stored codegenie logins on this runner (self-hosted); tests inject one.
  authStorage?: Pick<PiAuthStorage, "get">;
};

type GitHubActionInputs = {
  triggerPhrase: string;
  onPullRequest: boolean;
  allowedAssociations: string[];
  allowedUsers: string[];
  postInlineComments: boolean;
  preflightOnly: boolean;
  botLogin?: string;
  // Raw `model` / `models` inputs, validated only after the trigger gate so
  // a bad block cannot fail unrelated comment events.
  modelInput?: string;
  modelsInput: string;
  reviewPassthrough: string[];
};

type PermissionCheck = "allowlisted" | "write";

type AuthorizedDecision = Extract<TriggerDecision, { run: true }> & {
  permissionCheck: PermissionCheck;
};

export { applyLlmApiKey, parseModelSpec, type ModelSpec } from "./models.js";

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

  // A configuration error still fails every real trigger (including every
  // push), but "LGTM" comments skip above instead of going red.
  const models: ModelConfig = resolveModelConfig(inputs.modelInput, parseModelAliases(inputs.modelsInput));

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
  const decisionFields = {
    eventName,
    lane: decision.lane,
    prNumber: decision.prNumber,
    actor: decision.actor,
    association: decision.association,
    actorAllowlisted: decision.actorAllowlisted,
    permissionCheck
  };

  // Resolved only after authorization, so unauthorized commenters never get
  // a reply. An unlisted alias gets fixed text from the workflow's own list.
  const selected = selectModel(models, decision.requestedAlias);
  if (selected.kind === "unknown_alias") {
    await comments.createComment(decision.prNumber, renderUnknownAliasReply(models));
    const reason = "unknown model alias";
    write(`github-action: skipped — ${reason}\n`);
    writeDecisionRecord(write, { ...decisionFields, run: false, reason });
    writePreflightOutputs(env, false);
    return;
  }
  const selection = selected.selection;
  writePreflightOutputs(env, true, decision.prNumber);
  writeDecisionRecord(write, { ...decisionFields, run: true, ...modelRecordFields(selection) });
  if (inputs.preflightOnly) {
    write(`github-action: preflight authorized ${decision.lane} trigger for PR #${decision.prNumber}\n`);
    return;
  }

  const keyProviders = applyLlmApiKey(env, models);
  if (keyProviders.length > 0) {
    // pi-ai lets a stored login own its provider ahead of env vars, which
    // would silently bypass llm-api-key. Only self-hosted runners can have one.
    const storage = opts.authStorage ?? createFileAuthStorage(getCodegeniePaths(undefined, env));
    const overriding = keyProviders.find((provider) => storage.get(provider) !== undefined);
    if (overriding !== undefined) {
      throw new CodegenieError(
        "invalid_args",
        `a stored codegenie login for ${overriding} on this runner would override llm-api-key; run \`codegenie provider logout ${overriding}\` on the runner, or unset llm-api-key to use the stored login`
      );
    }
  }

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
    ...(selection !== undefined
      ? [
          ...(selection.spec.provider !== undefined ? ["--provider", selection.spec.provider] : []),
          "--model",
          selection.spec.model,
          "--reasoning",
          selection.spec.reasoning
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
    const code = actionErrorCode(error);
    const diagnostic = structuredSubmitFailureDiagnosticFromError(error);
    const providerMessage = providerMessageFromError(error);
    const modelResolution = modelResolutionFromError(error);
    // Our own model-resolution text rides the same explanation slot as a
    // provider message; the failure JSON keeps the two distinct.
    const explanation = providerMessage ?? modelResolution?.message;
    publishFailureFiles({
      errorCode: code,
      decision: authorized,
      env,
      ...(diagnostic !== undefined ? { diagnostic } : {}),
      ...(providerMessage !== undefined ? { providerMessage } : {}),
      ...(modelResolution !== undefined ? { modelResolution } : {}),
      ...(runUrl !== undefined ? { runUrl } : {})
    });
    await controller.finalizeFailure(code, diagnostic, explanation);
    emitActionRecord(attachment?.runDir, eventName, authorized, selection, "review_failed", controller.stats(), env, write, code);
    const detail = diagnostic !== undefined ? renderStructuredSubmitFailure(diagnostic) : code;
    write(
      `github-action: review failed — ${detail}${explanation !== undefined ? `: ${explanation}` : ""}\n`
    );
    throw error;
  }

  // Fallback copies land before the terminal PATCH so the report survives a
  // failed edit (which still fails the run as github_post_failed).
  publishReportFiles(runResult.reportMarkdown, env);
  if (runResult.failed) {
    await controller.finalizeFailure("review_failed", undefined, "Required review work failed. See the saved report for diagnostics.", runResult.reportMarkdown);
    emitActionRecord(runResult.runDir, eventName, authorized, selection, "review_failed", controller.stats(), env, write, "review_failed");
    throw new CodegenieError("review_failed", "Required review work failed; partial report retained.");
  }
  try {
    await controller.finalizeSuccess(runResult.reportMarkdown);
  } catch (error) {
    const code = actionErrorCode(error);
    emitActionRecord(runResult.runDir, eventName, authorized, selection, "terminal_post_failed", controller.stats(), env, write, code);
    throw error;
  }
  emitActionRecord(runResult.runDir, eventName, authorized, selection, "success", controller.stats(), env, write);
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
    failed: result.review.health?.status === "failed",
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
    modelsInput: "",
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
      inputs.modelInput = value;
    } else if (flag === "--models") {
      inputs.modelsInput = value;
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

type ActionFailureRecord = {
  schemaVersion: 1;
  lane: AuthorizedDecision["lane"];
  prNumber: number;
  errorCode: CodegenieErrorCode | "unknown_error";
  runUrl?: string;
  runId?: string;
  structuredSubmitFailure?: StructuredSubmitFailureDiagnostic;
  providerMessage?: string;
  modelResolution?: ModelResolutionDetail;
};

type ModelResolutionDetail = { kind: string; message: string };

const PROVIDER_MESSAGE_MAX_CHARS = 300;

// The provider's explanation rides on the error context set by the LLM layer;
// without lifting it here the artifact and PR comment carry only an error code.
//
// The context was already credential-stripped by the CodegenieError
// constructor, but these surfaces are world-readable, so scrub a second time
// against the Actions secrets before publishing.
function providerMessageFromError(error: unknown): string | undefined {
  if (!(error instanceof CodegenieError)) {
    return undefined;
  }
  const value = error.context?.providerMessage;
  return typeof value === "string" ? boundedPublishedText(value) : undefined;
}

// Scrubbed against the Actions secrets, collapsed to one line, and capped for
// world-readable surfaces (comment, step summary, artifacts, log).
function boundedPublishedText(value: string): string | undefined {
  const collapsed = scrubGitHubSecrets(value).replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return undefined;
  }
  return collapsed.length <= PROVIDER_MESSAGE_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, PROVIDER_MESSAGE_MAX_CHARS - 1).trimEnd()}…`;
}

// Model-resolution errors carry codegenie-authored text (with workflow- or
// CLI-supplied model ids) that tells a CI user what to set. Only these error
// messages are published — other error messages can carry external text.
function modelResolutionFromError(error: unknown): ModelResolutionDetail | undefined {
  if (!(error instanceof CodegenieError)) {
    return undefined;
  }
  const kind = error.context?.modelResolution;
  if (typeof kind !== "string") {
    return undefined;
  }
  const message = boundedPublishedText(error.message);
  return message !== undefined ? { kind, message } : undefined;
}

const FAILURE_JSON_MAX_BYTES = 16 * 1024;
const FAILURE_MARKDOWN_MAX_BYTES = 4 * 1024;

function actionErrorCode(error: unknown): CodegenieErrorCode | "unknown_error" {
  return error instanceof CodegenieError ? error.code : "unknown_error";
}

function publishFailureFiles(input: {
  errorCode: CodegenieErrorCode | "unknown_error";
  diagnostic?: StructuredSubmitFailureDiagnostic;
  providerMessage?: string;
  modelResolution?: ModelResolutionDetail;
  decision: AuthorizedDecision;
  runUrl?: string;
  env: NodeJS.ProcessEnv;
}): void {
  const runId = input.env.GITHUB_RUN_ID;
  const record: ActionFailureRecord = {
    schemaVersion: 1,
    lane: input.decision.lane,
    prNumber: input.decision.prNumber,
    errorCode: input.errorCode,
    ...(input.runUrl !== undefined ? { runUrl: input.runUrl } : {}),
    ...(runId !== undefined && /^\d+$/u.test(runId) ? { runId } : {}),
    ...(input.diagnostic !== undefined ? { structuredSubmitFailure: input.diagnostic } : {}),
    ...(input.providerMessage !== undefined ? { providerMessage: input.providerMessage } : {}),
    ...(input.modelResolution !== undefined ? { modelResolution: input.modelResolution } : {})
  };
  const explanation = input.providerMessage ?? input.modelResolution?.message;
  const json = fitFailureJson(record);
  const markdown = fitFailureMarkdown([
    "# 🧞 Codegenie Review Failed",
    "",
    `Error code: \`${input.errorCode}\``,
    ...(input.diagnostic !== undefined ? ["", renderStructuredSubmitFailure(input.diagnostic)] : []),
    ...(explanation !== undefined ? ["", renderProviderMessage(explanation)] : []),
    ...(input.runUrl !== undefined ? ["", `See the [workflow job](${input.runUrl}) and the failure JSON artifact.`] : [])
  ].join("\n"));
  writeFailureFile(input.env.CODEGENIE_FAILURE_PATH, json);
  writeFailureFile(input.env.CODEGENIE_REPORT_PATH, markdown);
  const stepSummary = input.env.GITHUB_STEP_SUMMARY;
  if (stepSummary !== undefined && stepSummary !== "") {
    try {
      appendFileSync(stepSummary, `${sanitizeGitHubCommentBody(markdown).trimEnd()}\n`);
    } catch {
      // The original review failure remains authoritative.
    }
  }
}

function fitFailureJson(record: ActionFailureRecord): string {
  let candidate = record;
  let serialized = `${JSON.stringify(candidate, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") <= FAILURE_JSON_MAX_BYTES) {
    return serialized;
  }
  candidate = { ...record, ...(record.structuredSubmitFailure !== undefined
    ? { structuredSubmitFailure: { ...record.structuredSubmitFailure, issues: [] } }
    : {}) };
  serialized = `${JSON.stringify(candidate, null, 2)}\n`;
  return Buffer.byteLength(serialized, "utf8") <= FAILURE_JSON_MAX_BYTES
    ? serialized
    : `${JSON.stringify({ schemaVersion: 1, lane: record.lane, prNumber: record.prNumber, errorCode: record.errorCode }, null, 2)}\n`;
}

function fitFailureMarkdown(markdown: string): string {
  if (Buffer.byteLength(markdown, "utf8") <= FAILURE_MARKDOWN_MAX_BYTES) {
    return `${markdown.trimEnd()}\n`;
  }
  return `${Buffer.from(markdown, "utf8").subarray(0, FAILURE_MARKDOWN_MAX_BYTES - 64).toString("utf8").trimEnd()}\n\n[Failure report truncated.]\n`;
}

function writeFailureFile(filePath: string | undefined, contents: string): void {
  if (filePath === undefined || filePath === "") {
    return;
  }
  try {
    writeFileSync(filePath, contents);
  } catch {
    // The original review failure remains authoritative.
  }
}

type AuthorizedRecordFields = {
  eventName: string;
  lane: AuthorizedDecision["lane"];
  prNumber: number;
  actor: string;
  association: string;
};

type DecisionRecord =
  | { eventName: string; run: false; reason: string }
  | (AuthorizedRecordFields & {
      run: true;
      actorAllowlisted: boolean;
      permissionCheck: PermissionCheck;
      modelAlias?: string;
      modelSpec?: string;
    })
  | (AuthorizedRecordFields & {
      run: false;
      reason: string;
      actorAllowlisted: false;
      permissionCheck: "denied";
    })
  | (AuthorizedRecordFields & {
      run: false;
      reason: "unknown model alias";
      actorAllowlisted: boolean;
      permissionCheck: PermissionCheck;
    });

function modelRecordFields(selection: ModelSelection | undefined): { modelAlias?: string; modelSpec?: string } {
  return {
    ...(selection?.alias !== undefined ? { modelAlias: selection.alias } : {}),
    ...(selection !== undefined ? { modelSpec: formatModelSpec(selection.spec) } : {})
  };
}

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
  selection: ModelSelection | undefined,
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
    ...modelRecordFields(selection),
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
