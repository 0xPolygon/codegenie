import { Buffer } from "node:buffer";
import type { TelemetryEvent } from "../types.js";
import type { StructuredSubmitFailureDiagnostic } from "../llm/schema-diagnostics.js";
import { sanitizeGitHubCommentBody } from "../github/comment-sanitizer.js";
import { CodegenieError } from "../util/errors.js";
import type { IssueComment, IssueCommentClient } from "./issue-comments.js";
import { appendStatusCommentMarker, hasStatusCommentMarker, STATUS_COMMENT_MARKER } from "./marker.js";
import {
  applyStageEvent,
  capTerminalBody,
  createStageChecklist,
  renderFailureBody,
  renderProgressBody,
  type StageChecklist
} from "./render.js";

type ProgressEvent = Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">;

export type StatusCommentStats = {
  commentId?: number;
  claimed?: "created" | "reclaimed";
  editCount: number;
  throttledCount: number;
  editFailures: number;
  terminalState?: "report" | "report_truncated" | "failure";
  finalBodyBytes?: number;
  finalBodyBytesBeforeCap?: number;
};

export type StatusCommentController = {
  claim(): Promise<{ commentId: number; author: string }>;
  onTelemetryEvent(event: ProgressEvent): void;
  finalizeSuccess(reportMarkdown: string): Promise<void>;
  finalizeFailure(errorCode: string, diagnostic?: StructuredSubmitFailureDiagnostic): Promise<boolean>;
  settle(): Promise<void>;
  stats(): StatusCommentStats;
};

export type StatusCommentOptions = {
  comments: IssueCommentClient;
  prNumber: number;
  // The exact authenticated login (resolved by the entrypoint: bot-login
  // input, /user lookup, or the github-actions[bot] default). Reclaim
  // requires an exact case-insensitive author match — no suffix heuristics,
  // so another app's marker comment is never adopted.
  ownLogin: string;
  runUrl?: string;
  minEditIntervalMs?: number;
  maxConsecutiveEditFailures?: number;
  // Nonfatal edit problems are reported here (CI log); they never fail the run.
  log?: (message: string) => void;
};

const DEFAULT_MIN_EDIT_INTERVAL_MS = 10_000;
const DEFAULT_MAX_CONSECUTIVE_EDIT_FAILURES = 3;

export function createStatusCommentController(options: StatusCommentOptions): StatusCommentController {
  const minEditIntervalMs = options.minEditIntervalMs ?? DEFAULT_MIN_EDIT_INTERVAL_MS;
  const maxConsecutiveEditFailures = options.maxConsecutiveEditFailures ?? DEFAULT_MAX_CONSECUTIVE_EDIT_FAILURES;
  const log = options.log ?? (() => undefined);

  const checklist: StageChecklist = createStageChecklist();
  const stats: StatusCommentStats = { editCount: 0, throttledCount: 0, editFailures: 0 };
  let commentId: number | undefined;
  let lastEditAt = 0;
  let consecutiveFailures = 0;
  let disabled = false;
  let terminal = false;
  let dirty = false;
  let flushTimer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;

  async function claim(): Promise<{ commentId: number; author: string }> {
    const existing = await findReclaimable();
    const body = appendStatusCommentMarker(renderProgressBody(checklist, options.runUrl));
    let claimed: IssueComment;
    if (existing !== undefined) {
      await options.comments.updateComment(existing.id, body);
      claimed = existing;
      stats.claimed = "reclaimed";
    } else {
      claimed = await options.comments.createComment(options.prNumber, body);
      stats.claimed = "created";
    }
    commentId = claimed.id;
    stats.commentId = claimed.id;
    lastEditAt = Date.now();
    return { commentId: claimed.id, author: claimed.author };
  }

  async function findReclaimable(): Promise<IssueComment | undefined> {
    const comments = await options.comments.listComments(options.prNumber);
    // The marker alone is spoofable (any user or app can paste an HTML
    // comment), so reclaim requires the author to be exactly us.
    const owned = comments.filter((comment) =>
      hasStatusCommentMarker(comment.body) &&
      comment.author.toLowerCase() === options.ownLogin.toLowerCase()
    );
    return owned.length > 0 ? owned[owned.length - 1] : undefined;
  }

  function onTelemetryEvent(event: ProgressEvent): void {
    if (terminal) {
      return;
    }
    if (event.message !== "stage_started" && event.message !== "stage_completed") {
      return;
    }
    if (!applyStageEvent(checklist, event.message, event.stage)) {
      return;
    }
    maybeEdit();
  }

  function maybeEdit(): void {
    if (commentId === undefined || disabled) {
      return;
    }
    if (inFlight !== undefined) {
      stats.throttledCount += 1;
      dirty = true;
      // Do not schedule while a PATCH is unresolved. Its finally handler
      // owns the single trailing flush, avoiding a 50 ms polling loop when a
      // network request outlives the throttle interval.
      return;
    }
    if (Date.now() - lastEditAt < minEditIntervalMs) {
      stats.throttledCount += 1;
      dirty = true;
      scheduleFlush();
      return;
    }
    startEdit(commentId);
  }

  // Trailing-edge coalescing: a throttled update is deferred, not dropped —
  // the latest state lands once the interval elapses. Without this, the fast
  // deterministic stages (1-4) all fall inside the first throttle window and
  // the checklist would sit stale through the long planning stage.
  function scheduleFlush(): void {
    if (flushTimer !== undefined) {
      return;
    }
    const delay = Math.max(minEditIntervalMs - (Date.now() - lastEditAt), 50);
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      if (dirty) {
        maybeEdit();
      }
    }, delay);
    flushTimer.unref?.();
  }

  function startEdit(id: number): void {
    const body = appendStatusCommentMarker(renderProgressBody(checklist, options.runUrl));
    dirty = false;
    lastEditAt = Date.now();
    inFlight = options.comments
      .updateComment(id, body)
      .then(() => {
        stats.editCount += 1;
        consecutiveFailures = 0;
      })
      .catch(() => {
        // A failed progress edit never fails the review; after repeated
        // failures the run continues headless and only the terminal edit is
        // still attempted.
        stats.editFailures += 1;
        consecutiveFailures += 1;
        log(`github-action: status comment progress edit failed (${consecutiveFailures} consecutive)\n`);
        if (consecutiveFailures >= maxConsecutiveEditFailures) {
          disabled = true;
          log("github-action: progress edits disabled after repeated failures; review continues headless\n");
        }
      })
      .finally(() => {
        inFlight = undefined;
        if (dirty && !disabled && !terminal) {
          scheduleFlush();
        }
      });
  }

  async function settle(): Promise<void> {
    // Terminal edits supersede any pending progress flush.
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    dirty = false;
    if (inFlight !== undefined) {
      await inFlight.catch(() => undefined);
    }
  }

  async function finalizeSuccess(reportMarkdown: string): Promise<void> {
    if (commentId === undefined) {
      throw new CodegenieError("github_post_failed", "status comment was never claimed");
    }
    terminal = true;
    await settle();
    // Sanitize first, append the marker after — the sanitizer strips HTML
    // comments, so the reverse order would delete the marker.
    const sanitized = sanitizeGitHubCommentBody(reportMarkdown);
    const reserved = STATUS_COMMENT_MARKER.length + 4;
    const capped = capTerminalBody(sanitized, options.runUrl, reserved);
    const body = appendStatusCommentMarker(capped.body);
    const bodyBeforeCap = appendStatusCommentMarker(capped.bodyBeforeCap);
    // Record the attempted terminal state before the PATCH so lifecycle
    // telemetry remains complete when GitHub rejects the final edit.
    stats.terminalState = capped.truncated ? "report_truncated" : "report";
    stats.finalBodyBytes = Buffer.byteLength(body, "utf8");
    stats.finalBodyBytesBeforeCap = Buffer.byteLength(bodyBeforeCap, "utf8");
    try {
      await options.comments.updateComment(commentId, body);
    } catch (error) {
      stats.editFailures += 1;
      log("github-action: terminal report status edit failed\n");
      throw error;
    }
    stats.editCount += 1;
  }

  async function finalizeFailure(errorCode: string, diagnostic?: StructuredSubmitFailureDiagnostic): Promise<boolean> {
    if (commentId === undefined) {
      return false;
    }
    terminal = true;
    await settle();
    const body = appendStatusCommentMarker(renderFailureBody(errorCode, options.runUrl, diagnostic));
    stats.terminalState = "failure";
    const bodyBytes = Buffer.byteLength(body, "utf8");
    stats.finalBodyBytes = bodyBytes;
    stats.finalBodyBytesBeforeCap = bodyBytes;
    try {
      await options.comments.updateComment(commentId, body);
      stats.editCount += 1;
      return true;
    } catch {
      // The review already failed; the original error must stay the outcome.
      stats.editFailures += 1;
      log("github-action: failure-state status edit also failed; the review error stands\n");
      return false;
    }
  }

  return { claim, onTelemetryEvent, finalizeSuccess, finalizeFailure, settle, stats: () => ({ ...stats }) };
}
