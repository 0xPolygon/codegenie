import type {
  ComparedFileLines,
  ExistingReviewThread,
  FinalFinding,
  GitHubReviewEvent,
  GitHubReviewMode,
  OwnPullRequestReview,
  ReviewHealth
} from "../types.js";

export type OpenReviewIssue = {
  fingerprint: string;
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  /** `previous` lines belong to the prior review commit. `current` lines belong to the new head. */
  lineBasis: "previous" | "current";
};

const VERDICT_MARKER =
  /<!--\s*codegenie:verdict=(comment|approve);commit=([0-9a-f]{7,40});open=([^>]*?)\s*-->/u;

export function selectPostedEvent(input: {
  mode: GitHubReviewMode;
  health: ReviewHealth["status"];
  openIssueCount: number;
}): { event: GitHubReviewEvent; forcePost: boolean } {
  if (input.mode === "comment") {
    return { event: "COMMENT", forcePost: false };
  }
  if (input.openIssueCount > 0) {
    return { event: "REQUEST_CHANGES", forcePost: true };
  }
  if (input.health !== "completed") {
    return { event: "COMMENT", forcePost: true };
  }
  return { event: "APPROVE", forcePost: true };
}

export function staleApproval(reviews: OwnPullRequestReview[], headSha: string): OwnPullRequestReview | undefined {
  const latest = latestSubmittedReview(reviews);
  if (latest?.state !== "APPROVED" || latest.commitId === undefined || latest.commitId === headSha) {
    return undefined;
  }
  return latest;
}

export function latestSubmittedReview(reviews: OwnPullRequestReview[]): OwnPullRequestReview | undefined {
  return reviews
    .filter((review) => review.state !== "PENDING" && review.state !== "DISMISSED" && review.submittedAt !== undefined)
    .sort((left, right) => (left.submittedAt ?? "").localeCompare(right.submittedAt ?? ""))
    .at(-1);
}

export function issuesFromReview(
  review: OwnPullRequestReview,
  comments: ExistingReviewThread[]
): OpenReviewIssue[] {
  const fromComments = comments.flatMap((comment) => {
    if (comment.pullRequestReviewId !== review.id || comment.fingerprint === undefined || comment.path === undefined || comment.line === undefined || comment.side === undefined) {
      return [];
    }
    return [{
      fingerprint: comment.fingerprint,
      path: comment.path,
      line: comment.line,
      side: comment.side,
      lineBasis: comment.lineIsCurrent === true ? "current" as const : "previous" as const
    }];
  });
  const fromBody = parseVerdictMarker(review.body ?? "")?.open ?? [];
  const seen = new Set<string>();
  return [...fromComments, ...fromBody].filter((issue) => {
    if (seen.has(issue.fingerprint)) {
      return false;
    }
    seen.add(issue.fingerprint);
    return true;
  });
}

export function carryForwardIssues(
  prior: OpenReviewIssue[],
  currentFingerprints: ReadonlySet<string>,
  files: ComparedFileLines[] | undefined
): OpenReviewIssue[] {
  return prior.filter((issue) => {
    if (currentFingerprints.has(issue.fingerprint)) {
      return false;
    }
    return anchorSettled(issue, files) !== true;
  });
}

export function formatVerdictMarker(mode: GitHubReviewMode, commit: string, open: OpenReviewIssue[]): string {
  const encoded = open.map((issue) =>
    `${issue.fingerprint}:${encodeURIComponent(issue.path)}:${issue.line}:${issue.side}`
  ).join(",");
  return `<!-- codegenie:verdict=${mode};commit=${commit};open=${encoded} -->`;
}

export function parseVerdictMarker(body: string): { mode: GitHubReviewMode; commit: string; open: OpenReviewIssue[] } | undefined {
  const match = VERDICT_MARKER.exec(body);
  if (match === null) {
    return undefined;
  }
  const mode = match[1];
  const commit = match[2];
  if (mode !== "comment" && mode !== "approve" || commit === undefined) {
    return undefined;
  }
  return { mode, commit, open: parseOpenList(match[3] ?? "") };
}

export function issuesFromFindings(findings: FinalFinding[]): OpenReviewIssue[] {
  return findings.flatMap((finding) => {
    if (finding.anchor === undefined) {
      return [];
    }
    return [{
      fingerprint: finding.fingerprint,
      path: finding.anchor.path,
      line: finding.anchor.line,
      side: finding.anchor.side,
      lineBasis: "current"
    }];
  });
}

export function changedLinesFromPatch(patch: string): { addedLines: number[]; deletedLines: number[] } {
  const addedLines: number[] = [];
  const deletedLines: number[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (line.startsWith("+")) {
      addedLines.push(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      deletedLines.push(oldLine);
      oldLine += 1;
    } else if (line.startsWith("\\")) {
      continue;
    } else if (oldLine > 0 || newLine > 0) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return { addedLines, deletedLines };
}

export function renderCarriedIssues(issues: OpenReviewIssue[]): string {
  if (issues.length === 0) {
    return "";
  }
  const lines = issues.map((issue) => `- \`${issue.path}:${issue.line}\` was not changed since the last request`);
  return ["## Still open from the previous review", "", ...lines].join("\n");
}

function anchorSettled(issue: OpenReviewIssue, files: ComparedFileLines[] | undefined): boolean {
  if (files === undefined) {
    return false;
  }
  const file = files.find((candidate) => candidate.path === issue.path);
  if (file === undefined) {
    return false;
  }
  if (file.status === "added" || file.status === "removed" || file.status === "renamed") {
    return true;
  }
  if (file.patchMissing) {
    return false;
  }
  // A marker line is numbered on the previous commit. Compare deleted lines, not new-head added lines.
  if (issue.lineBasis !== "current") {
    return issue.side === "RIGHT" && file.deletedLines.includes(issue.line);
  }
  const lines = issue.side === "LEFT" ? file.deletedLines : file.addedLines;
  return lines.includes(issue.line);
}

function parseOpenList(raw: string): OpenReviewIssue[] {
  if (raw.trim() === "") {
    return [];
  }
  return raw.split(",").flatMap((entry) => {
    const [fingerprint, encodedPath, line, side] = entry.split(":");
    if (fingerprint === undefined || encodedPath === undefined || line === undefined || (side !== "RIGHT" && side !== "LEFT")) {
      return [];
    }
    if (!/^[0-9a-f]{64}$/u.test(fingerprint) || !/^\d+$/u.test(line)) {
      return [];
    }
    return [{ fingerprint, path: decodeURIComponent(encodedPath), line: Number(line), side, lineBasis: "previous" }];
  });
}
