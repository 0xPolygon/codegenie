import type {
  ExistingReviewThread,
  FinalFinding,
  FindingDuplicateDecision
} from "../types.js";
import { isProsePath } from "../util/path-roles.js";
import { sha256Hex } from "../util/hashing.js";
import { sanitizeGitHubCommentBody } from "./comment-sanitizer.js";

export const CODEGENIE_MARKER_PATTERN =
  /<!--\s*codegenie:fingerprint=([0-9a-f]{64});run=([A-Za-z0-9._-]+)(?:;content=([0-9a-f]{64}))?\s*-->/u;

export type CodegenieMarker = {
  fingerprint: string;
  runId: string;
  contentFingerprint?: string;
};

export function parseCodegenieMarker(body: string): CodegenieMarker | undefined {
  const match = CODEGENIE_MARKER_PATTERN.exec(body);
  if (!match) {
    return undefined;
  }
  return {
    fingerprint: match[1] ?? "",
    runId: match[2] ?? "",
    ...(match[3] ? { contentFingerprint: match[3] } : {})
  };
}

export function formatCodegenieMarker(fingerprint: string, runId: string, contentFingerprint?: string): string {
  return `<!-- codegenie:fingerprint=${fingerprint};run=${runId}${contentFingerprint ? `;content=${contentFingerprint}` : ""} -->`;
}

/** Match unchanged published text, not model wording similarity or diff geometry. */
export function proseContentFingerprint(body: string): string | undefined {
  const content = sanitizeGitHubCommentBody(body).replace(/\r\n?/gu, "\n").trim();
  return content ? sha256Hex(content) : undefined;
}

export function detectDuplicateFindings(
  findings: FinalFinding[],
  comments: ExistingReviewThread[]
): FindingDuplicateDecision[] {
  const codegenieComments = comments.filter((comment) => comment.isCodegenie);
  const fingerprints = new Map(
    codegenieComments
      .filter((comment) => comment.fingerprint !== undefined)
      .map((comment) => [comment.fingerprint as string, comment])
  );
  return findings.map((finding): FindingDuplicateDecision => {
    if (isProsePath(finding.path)) {
      const contentFingerprint = proseContentFingerprint(finding.finalBody);
      const unchanged = finding.anchor !== undefined && contentFingerprint && codegenieComments.find(comment =>
        comment.path === finding.path && comment.side === finding.anchor?.side &&
        (comment.contentFingerprint ?? proseContentFingerprint(comment.body ?? "")) === contentFingerprint
      );
      // Geometry-based fingerprints and proximity alone cannot distinguish prose defects.
      // Legacy comments can match by their full body; missing or changed content stays eligible.
      return unchanged ? {
        findingId: finding.id,
        action: "skip_unchanged_content",
        matchedCommentId: unchanged.id,
        reason: "unchanged codegenie comment content already exists on the same path and side"
      } : { findingId: finding.id, action: "post", reason: "no unchanged codegenie prose comment found" };
    }
    const exact = fingerprints.get(finding.fingerprint);
    if (exact !== undefined) {
      return {
        findingId: finding.id,
        action: "skip_exact_fingerprint",
        matchedCommentId: exact.id,
        reason: "matching codegenie fingerprint already exists on the PR"
      };
    }

    const fuzzy = codegenieComments.find((comment) =>
      finding.anchor !== undefined &&
      comment.path === finding.anchor.path &&
      comment.side === finding.anchor.side &&
      typeof comment.line === "number" &&
      Math.abs(comment.line - finding.anchor.line) <= 5
    );
    if (fuzzy !== undefined) {
      return {
        findingId: finding.id,
        action: "skip_fuzzy_proximity",
        matchedCommentId: fuzzy.id,
        reason: "nearby codegenie comment already exists on the PR"
      };
    }

    return {
      findingId: finding.id,
      action: "post",
      reason: "no prior codegenie duplicate detected"
    };
  });
}
