import { buildDiffAnchorIndex, parseDiff, validateDiffAnchor } from "../git/diff-parser.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import type {
  CodeninjaConfig,
  DiffAnchor,
  FinalFinding,
  GitHubClient,
  InlineCommentInput,
  ResolvedReviewInput,
  ReviewResult,
  RunPostingRecord,
  UnifiedDiff
} from "../types.js";
import { CodeninjaError, isCodeninjaError } from "../util/errors.js";
import { sanitizeGitHubCommentBody } from "./comment-sanitizer.js";
import { createGitHubClient } from "./github-client.js";
import { detectDuplicateFindings, formatCodeninjaMarker } from "./duplicate-detector.js";

type PublishOptions = {
  github?: GitHubClient;
  diff?: UnifiedDiff;
};

type PreparedInlineComment = {
  finding: FinalFinding;
  anchor: DiffAnchor;
  input: InlineCommentInput;
};

type RejectedCommentDescriptor = {
  path: string;
  line?: number;
  side?: "RIGHT" | "LEFT";
};

const INLINE_BODY_CAP = 10_000;
const REVIEW_BODY_CAP = 60_000;

export async function maybePublishToGitHub(
  finalReview: ReviewResult,
  resolved: ResolvedReviewInput,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  opts: PublishOptions = {}
): Promise<RunPostingRecord | undefined> {
  if (finalReview.postingPlan === undefined) {
    return undefined;
  }
  if (resolved.mode !== "github_pr" || resolved.pr === undefined) {
    throw new CodeninjaError("invalid_args", "GitHub posting requires github_pr review mode");
  }

  const github = opts.github ?? createGitHubClient(resolved.repoRoot);
  const currentPr = await github.viewPr(resolved.pr.number, { refresh: true });
  if (currentPr.headSha !== resolved.pr.headSha || currentPr.baseSha !== resolved.pr.baseSha) {
    throw new CodeninjaError(
      "github_post_failed",
      `PR #${resolved.pr.number} changed while review was running; re-run codeninja before posting comments`,
      {
        context: {
          resolvedBaseSha: resolved.pr.baseSha,
          resolvedHeadSha: resolved.pr.headSha,
          currentBaseSha: currentPr.baseSha,
          currentHeadSha: currentPr.headSha
        }
      }
    );
  }
  const diff = opts.diff ?? parseDiff(resolved.rawDiff);
  const index = buildDiffAnchorIndex(diff);
  const byId = new Map(finalReview.findings.map((finding) => [finding.id, finding]));
  const demoted: FinalFinding[] = [];
  const inlineCandidates: Array<{ finding: FinalFinding; anchor: DiffAnchor }> = [];

  for (const planned of finalReview.postingPlan.inline) {
    const finding = byId.get(planned.findingId);
    if (finding === undefined || finding.publication !== "inline") {
      continue;
    }
    const anchor = finding.anchor ?? planned.anchor;
    if (belowInlineConfidence(finding.confidence, config.review.minInlineConfidence)) {
      demoted.push(finding);
      telemetry.event({
        stage: 11,
        level: "info",
        message: "github_inline_demoted",
        data: { findingId: finding.id, reason: "min-inline-confidence" }
      });
      continue;
    }
    const normalizedAnchor = collapseSingleLineAnchor(anchor);
    const validation = validateDiffAnchor(normalizedAnchor, index);
    if (!validation.valid) {
      demoted.push(finding);
      telemetry.event({
        stage: 11,
        level: "info",
        message: "github_inline_demoted",
        data: { findingId: finding.id, reason: validation.reason ?? "invalid-anchor" }
      });
      continue;
    }
    inlineCandidates.push({ finding, anchor: normalizedAnchor });
  }

  const comments = await github.listOwnComments(resolved.pr.number);
  const duplicateDecisions = detectDuplicateFindings(inlineCandidates.map((candidate) => candidate.finding), comments);
  const duplicateById = new Map(duplicateDecisions.map((decision) => [decision.findingId, decision]));
  const prepared = inlineCandidates
    .filter(({ finding }) => duplicateById.get(finding.id)?.action === "post")
    .map(({ finding, anchor }) => prepareInlineComment(finding, anchor, telemetry.runId));
  const skippedDuplicates = duplicateDecisions.filter((decision) => decision.action !== "post").length;
  const reviewBody = buildPostingBody(finalReview, demoted, config, { includeInlineSummary: prepared.length > 0 });
  const shouldPostBody = reviewBody.trim().length > 0;

  const record: RunPostingRecord = {
    attempted: false,
    status: "failed",
    inlinePosted: 0,
    demotedToBody: demoted.length,
    skippedDuplicates,
    attempts: [],
    duplicateDecisions
  };

  if (prepared.length === 0 && !shouldPostBody) {
    record.status = skippedDuplicates > 0 ? "skipped_all_duplicates" : "skipped_no_findings";
    await persistPostingRecord(record, telemetry);
    return attachPosting(finalReview, record);
  }

  record.attempted = true;
  const body = prepareReviewBody(reviewBody);
  try {
    const result = await postWithRecovery(github, resolved.pr.number, body, prepared, record);
    record.status = result.summaryOnly ? "summary_only_fallback" : "posted";
    record.inlinePosted = result.inlinePosted;
    await persistPostingRecord(record, telemetry);
    telemetry.event({
      stage: 11,
      level: "info",
      message: "github_review_posted",
      data: { status: record.status, inlinePosted: record.inlinePosted, demotedToBody: record.demotedToBody }
    });
    return attachPosting(finalReview, record);
  } catch (error) {
    record.status = "failed";
    record.error = error instanceof Error ? error.message : String(error);
    await persistPostingRecord(record, telemetry);
    telemetry.event({
      stage: 11,
      level: "error",
      message: "github_posting_failed",
      data: { error: record.error }
    });
    if (isCodeninjaError(error)) {
      throw error;
    }
    throw new CodeninjaError("github_post_failed", record.error, { cause: error });
  }
}

async function postWithRecovery(
  github: GitHubClient,
  prNumber: number,
  body: string,
  initialComments: PreparedInlineComment[],
  record: RunPostingRecord
): Promise<{ inlinePosted: number; summaryOnly: boolean }> {
  let comments = [...initialComments];
  let currentBody = body;
  let summaryOnly = false;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await github.createReview(prNumber, {
        body: currentBody,
        event: "COMMENT",
        comments: comments.map((comment) => comment.input)
      });
      record.attempts.push({ commentCount: comments.length, outcome: "ok" });
      return { inlinePosted: comments.length, summaryOnly };
    } catch (error) {
      if (!isGithub422(error)) {
        record.attempts.push({ commentCount: comments.length, outcome: "error" });
        throw error;
      }
      record.attempts.push({ httpStatus: 422, commentCount: comments.length, outcome: "rejected" });
      const rejectedIndexes = extractRejectedCommentIndexes(error, comments);
      const before = comments.length;
      if (rejectedIndexes.length > 0) {
        const rejected = new Set(rejectedIndexes);
        const demoted = comments.filter((_comment, index) => rejected.has(index));
        currentBody = demoteCommentsIntoBody(currentBody, demoted, record);
        comments = comments.filter((_comment, index) => !rejected.has(index));
      } else {
        const localSuspects = nextLocal422SuspectClass(comments);
        if (localSuspects.length > 0) {
          const demoted = new Set(localSuspects);
          currentBody = demoteCommentsIntoBody(currentBody, localSuspects, record);
          comments = comments.filter((comment) => !demoted.has(comment));
        } else {
          currentBody = demoteCommentsIntoBody(currentBody, comments, record);
          comments = [];
          summaryOnly = true;
        }
      }
      if (comments.length === 0 && before > 0) {
        summaryOnly = true;
      }
      if (comments.length === before && !summaryOnly) {
        currentBody = demoteCommentsIntoBody(currentBody, comments, record);
        comments = [];
        summaryOnly = true;
      }
      if (attempt >= 2 && comments.length > 0) {
        currentBody = demoteCommentsIntoBody(currentBody, comments, record);
        comments = [];
        summaryOnly = true;
      }
      if (attempt === 3) {
        throw error;
      }
    }
  }

  await github.createReview(prNumber, { body: currentBody, event: "COMMENT", comments: [] });
  record.attempts.push({ commentCount: 0, outcome: "ok" });
  return { inlinePosted: 0, summaryOnly: true };
}

function nextLocal422SuspectClass(comments: PreparedInlineComment[]): PreparedInlineComment[] {
  const leftSide = comments.filter((comment) => comment.anchor.side === "LEFT");
  if (leftSide.length > 0) {
    return leftSide;
  }
  const multiline = comments.filter((comment) => comment.anchor.startLine !== undefined);
  if (multiline.length > 0) {
    return multiline;
  }
  return [];
}

function prepareInlineComment(finding: FinalFinding, anchor: DiffAnchor, runId: string): PreparedInlineComment {
  const input: InlineCommentInput = {
    path: anchor.path,
    line: anchor.line,
    side: anchor.side,
    body: `${capBody(sanitizeGitHubCommentBody(finding.finalBody), INLINE_BODY_CAP)}\n\n${formatCodeninjaMarker(finding.fingerprint, runId)}`
  };
  if (anchor.startLine !== undefined && anchor.startLine !== anchor.line) {
    input.start_line = anchor.startLine;
    input.start_side = anchor.startSide ?? anchor.side;
  }
  return { finding, anchor, input };
}

function prepareReviewBody(body: string): string {
  return capBody(sanitizeGitHubCommentBody(body), REVIEW_BODY_CAP);
}

function demoteCommentsIntoBody(
  body: string,
  comments: PreparedInlineComment[],
  record: RunPostingRecord
): string {
  if (comments.length === 0) {
    return body;
  }
  record.demotedToBody += comments.length;
  return prepareReviewBody(appendDemotedFindings(body, comments.map((comment) => comment.finding)));
}

function buildPostingBody(
  finalReview: ReviewResult,
  demoted: FinalFinding[],
  config: CodeninjaConfig,
  opts: { includeInlineSummary: boolean }
): string {
  const hasBodyFindings = finalReview.summaryOnlyFindings.length > 0 || demoted.length > 0;
  const shouldIncludeBase = opts.includeInlineSummary ||
    hasBodyFindings ||
    finalReview.needsHumanAttention.length > 0 ||
    finalReview.coverage.partial ||
    config.github.summaryWhenNoFindings;
  if (!shouldIncludeBase) {
    return "";
  }
  return appendDemotedFindings(finalReview.postingPlan?.reviewBody ?? finalReview.summary, demoted);
}

function appendDemotedFindings(body: string, findings: FinalFinding[]): string {
  if (findings.length === 0) {
    return body;
  }
  const lines = [body.trim(), "", "Inline findings included in the review body:"].filter((line) => line.length > 0);
  for (const finding of findings) {
    lines.push("", `- ${finding.title} (${finding.path}${finding.anchor ? `:${finding.anchor.line}` : ""})`);
    lines.push(indent(finding.finalBody.trim() || finding.failureMode));
  }
  return lines.join("\n");
}

function indent(text: string): string {
  return text.split(/\r?\n/u).map((line) => `  ${line}`).join("\n");
}

function collapseSingleLineAnchor(anchor: DiffAnchor): DiffAnchor {
  if (anchor.startLine !== undefined && anchor.startLine === anchor.line) {
    const { startLine: _startLine, startSide: _startSide, ...singleLine } = anchor;
    return singleLine;
  }
  return anchor;
}

function belowInlineConfidence(confidence: FinalFinding["confidence"], min: CodeninjaConfig["review"]["minInlineConfidence"]): boolean {
  return confidenceRank(confidence) > confidenceRank(min);
}

function confidenceRank(confidence: FinalFinding["confidence"]): number {
  return confidence === "high" ? 0 : confidence === "medium" ? 1 : 2;
}

function capBody(body: string, maxChars: number): string {
  if (body.length <= maxChars) {
    return body;
  }
  const suffix = "\n\n... (truncated)";
  const limit = Math.max(0, maxChars - suffix.length);
  const prefix = body.slice(0, limit);
  const paragraphBreak = prefix.lastIndexOf("\n\n");
  return `${prefix.slice(0, paragraphBreak > maxChars * 0.5 ? paragraphBreak : limit).trimEnd()}${suffix}`;
}

function isGithub422(error: unknown): boolean {
  return error instanceof CodeninjaError &&
    error.code === "github_post_failed" &&
    /\b422\b/u.test(`${error.message}\n${JSON.stringify(error.context ?? {})}`);
}

function extractRejectedCommentIndexes(error: unknown, comments: PreparedInlineComment[]): number[] {
  if (!(error instanceof CodeninjaError)) {
    return [];
  }
  const payload = parseGitHubErrorPayload(error);
  if (payload === undefined) {
    return [];
  }
  const explicit = collectIndexes(payload).filter((index) => index >= 0 && index < comments.length);
  const byDescriptor = collectRejectedCommentDescriptors(payload)
    .flatMap((descriptor) => indexesMatchingRejectedDescriptor(descriptor, comments));
  return [...new Set([...explicit, ...byDescriptor])].sort((a, b) => a - b);
}

function parseGitHubErrorPayload(error: CodeninjaError): unknown | undefined {
  const raw = [error.context?.stdout, error.context?.stderr, error.message]
    .map((value) => typeof value === "string" ? value : "")
    .find((value) => value.includes("{"));
  if (raw === undefined) {
    return [];
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) {
    return [];
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function collectIndexes(value: unknown): number[] {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((item) => collectIndexes(item)))].sort((a, b) => a - b);
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const direct = [
    numberField(record.index),
    numberField(record.comment_index),
    numberField(record.commentIndex),
    indexFromField(record.field)
  ].filter((index): index is number => index !== undefined);
  return [...new Set([...direct, ...Object.values(record).flatMap((item) => collectIndexes(item))])].sort((a, b) => a - b);
}

function collectRejectedCommentDescriptors(value: unknown): RejectedCommentDescriptor[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectRejectedCommentDescriptors(item));
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const path = stringField(record.path);
  const descriptor: RejectedCommentDescriptor[] = [];
  if (path !== undefined) {
    const next: RejectedCommentDescriptor = { path };
    const line = numberField(record.line);
    if (line !== undefined) {
      next.line = line;
    }
    const side = sideField(record.side);
    if (side !== undefined) {
      next.side = side;
    }
    descriptor.push(next);
  }
  return [...descriptor, ...Object.values(record).flatMap((item) => collectRejectedCommentDescriptors(item))];
}

function indexesMatchingRejectedDescriptor(
  descriptor: RejectedCommentDescriptor,
  comments: PreparedInlineComment[]
): number[] {
  const matches = comments
    .map((comment, index) => ({ comment, index }))
    .filter(({ comment }) => commentMatchesRejectedDescriptor(comment, descriptor));
  const pathOnly = descriptor.line === undefined && descriptor.side === undefined;
  if (pathOnly && matches.length !== 1) {
    return [];
  }
  return matches.map((match) => match.index);
}

function commentMatchesRejectedDescriptor(
  comment: PreparedInlineComment,
  descriptor: RejectedCommentDescriptor
): boolean {
  return comment.input.path === descriptor.path &&
    (descriptor.line === undefined || comment.input.line === descriptor.line) &&
    (descriptor.side === undefined || comment.input.side === descriptor.side);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function sideField(value: unknown): "RIGHT" | "LEFT" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const upper = value.toUpperCase();
  return upper === "RIGHT" || upper === "LEFT" ? upper : undefined;
}

function indexFromField(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = /comments\[(\d+)\]/u.exec(value) ?? /comments\.(\d+)/u.exec(value);
  return match?.[1] !== undefined ? Number(match[1]) : undefined;
}

async function persistPostingRecord(record: RunPostingRecord, telemetry: TelemetryRecorder): Promise<void> {
  await telemetry.writeArtifact("github-posting.json", record);
  telemetry.event({ stage: 11, level: "info", message: "github_posting_recorded", data: record });
}

function attachPosting(finalReview: ReviewResult, record: RunPostingRecord): RunPostingRecord {
  finalReview.posting = record;
  return record;
}
