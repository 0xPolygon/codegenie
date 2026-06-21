import type {
  ExistingReviewThread,
  FinalFinding,
  FindingDuplicateDecision
} from "../types.js";

export const CODEGENIE_MARKER_PATTERN =
  /<!--\s*codegenie:fingerprint=([0-9a-f]{64});run=([A-Za-z0-9._-]+)\s*-->/u;

export type CodegenieMarker = {
  fingerprint: string;
  runId: string;
};

export function parseCodegenieMarker(body: string): CodegenieMarker | undefined {
  const match = CODEGENIE_MARKER_PATTERN.exec(body);
  if (!match) {
    return undefined;
  }
  return {
    fingerprint: match[1] ?? "",
    runId: match[2] ?? ""
  };
}

export function formatCodegenieMarker(fingerprint: string, runId: string): string {
  return `<!-- codegenie:fingerprint=${fingerprint};run=${runId} -->`;
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
