import type { TelemetryEvent } from "../types.js";
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
  finalizeFailure(errorCode: string): Promise<boolean>;
  settle(): Promise<void>;
  stats(): StatusCommentStats;
};

export type StatusCommentOptions = {
  comments: IssueCommentClient;
  prNumber: number;
  runUrl?: string;
  // Own login when resolvable up front; claim() falls back to the "[bot]"
  // suffix rule for reclaim author verification when it is not.
  ownLogin?: string;
  minEditIntervalMs?: number;
  maxConsecutiveEditFailures?: number;
  now?: () => number;
};

const DEFAULT_MIN_EDIT_INTERVAL_MS = 10_000;
const DEFAULT_MAX_CONSECUTIVE_EDIT_FAILURES = 3;

export function createStatusCommentController(options: StatusCommentOptions): StatusCommentController {
  const now = options.now ?? Date.now;
  const minEditIntervalMs = options.minEditIntervalMs ?? DEFAULT_MIN_EDIT_INTERVAL_MS;
  const maxConsecutiveEditFailures = options.maxConsecutiveEditFailures ?? DEFAULT_MAX_CONSECUTIVE_EDIT_FAILURES;

  const checklist: StageChecklist = createStageChecklist();
  const stats: StatusCommentStats = { editCount: 0, throttledCount: 0, editFailures: 0 };
  let commentId: number | undefined;
  let lastEditAt = 0;
  let consecutiveFailures = 0;
  let disabled = false;
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
    lastEditAt = now();
    return { commentId: claimed.id, author: claimed.author };
  }

  async function findReclaimable(): Promise<IssueComment | undefined> {
    const comments = await options.comments.listComments(options.prNumber);
    // The marker alone is spoofable (any user can paste an HTML comment), so
    // reclaim requires the author to be us — or, when our login is not yet
    // resolvable (installation tokens), a "[bot]" login, a suffix GitHub
    // reserves for apps and human accounts cannot register.
    const owned = comments.filter((comment) =>
      hasStatusCommentMarker(comment.body) &&
      (options.ownLogin !== undefined ? comment.author === options.ownLogin : comment.author.endsWith("[bot]"))
    );
    return owned.length > 0 ? owned[owned.length - 1] : undefined;
  }

  function onTelemetryEvent(event: ProgressEvent): void {
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
    if (inFlight !== undefined || now() - lastEditAt < minEditIntervalMs) {
      stats.throttledCount += 1;
      return;
    }
    const body = appendStatusCommentMarker(renderProgressBody(checklist, options.runUrl));
    const id = commentId;
    lastEditAt = now();
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
        if (consecutiveFailures >= maxConsecutiveEditFailures) {
          disabled = true;
        }
      })
      .finally(() => {
        inFlight = undefined;
      });
  }

  async function settle(): Promise<void> {
    if (inFlight !== undefined) {
      await inFlight.catch(() => undefined);
    }
  }

  async function finalizeSuccess(reportMarkdown: string): Promise<void> {
    if (commentId === undefined) {
      throw new CodegenieError("github_post_failed", "status comment was never claimed");
    }
    await settle();
    // Sanitize first, append the marker after — the sanitizer strips HTML
    // comments, so the reverse order would delete the marker.
    const sanitized = sanitizeGitHubCommentBody(reportMarkdown);
    const reserved = STATUS_COMMENT_MARKER.length + 4;
    const capped = capTerminalBody(sanitized, options.runUrl, reserved);
    const body = appendStatusCommentMarker(capped.body);
    await options.comments.updateComment(commentId, body);
    stats.editCount += 1;
    stats.terminalState = capped.truncated ? "report_truncated" : "report";
    stats.finalBodyBytes = body.length;
    stats.finalBodyBytesBeforeCap = capped.bytesBeforeCap;
  }

  async function finalizeFailure(errorCode: string): Promise<boolean> {
    if (commentId === undefined) {
      return false;
    }
    await settle();
    const body = appendStatusCommentMarker(renderFailureBody(errorCode, options.runUrl));
    try {
      await options.comments.updateComment(commentId, body);
      stats.editCount += 1;
      stats.terminalState = "failure";
      return true;
    } catch {
      // The review already failed; the original error must stay the outcome.
      stats.editFailures += 1;
      return false;
    }
  }

  return { claim, onTelemetryEvent, finalizeSuccess, finalizeFailure, settle, stats: () => ({ ...stats }) };
}
