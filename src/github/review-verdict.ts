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
  // GitHub ignores COMMENTED reviews when deciding a reviewer's standing verdict, so a later comment must not hide an approval.
  const latest = latestSubmittedReview(reviews.filter((review) => review.state !== "COMMENTED"));
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

/**
 * The newest review whose verdict marker records the full open-issue state. Comment-mode reviews carry no marker,
 * and an approve-mode run whose prior-review lookup failed omits it because its state would be incomplete.
 */
export function latestVerdictReview(reviews: OwnPullRequestReview[]): OwnPullRequestReview | undefined {
  return latestSubmittedReview(reviews.filter((review) => parseVerdictMarker(review.body ?? "") !== undefined));
}

/** Markerless change requests newer than the verdict review: runs whose lookup failed, still blocking with their own inline issues. */
export function unrecordedChangeRequests(reviews: OwnPullRequestReview[], verdict: OwnPullRequestReview | undefined): OwnPullRequestReview[] {
  const after = verdict?.submittedAt ?? "";
  return reviews.filter((review) =>
    review.state === "CHANGES_REQUESTED" &&
    review.submittedAt !== undefined &&
    review.submittedAt > after &&
    parseVerdictMarker(review.body ?? "") === undefined
  );
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
  return prior.flatMap((issue) => {
    if (currentFingerprints.has(issue.fingerprint) || anchorSettled(issue, files)) {
      return [];
    }
    return [rebaseOntoHead(issue, files)];
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

/** Line 0 marks a file-level issue: a summary-only finding with no diff anchor. */
const FILE_LEVEL_LINE = 0;

export function issuesFromFindings(findings: FinalFinding[]): OpenReviewIssue[] {
  return findings.flatMap((finding) => {
    if (finding.anchor === undefined) {
      return [{ fingerprint: finding.fingerprint, path: finding.path, line: FILE_LEVEL_LINE, side: "RIGHT" as const, lineBasis: "current" as const }];
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
  const lines = issues.map((issue) =>
    `- \`${issue.line === FILE_LEVEL_LINE ? issue.path : `${issue.path}:${issue.line}`}\` was not changed since the last request`
  );
  return ["## Still open from the previous review", "", ...lines].join("\n");
}

/**
 * Moves a previous-commit RIGHT line onto the new head so the marker's line matches its `commit=`. LEFT lines are
 * numbered on the PR base and current lines already sit on the head. Without a usable patch the line is kept as is.
 */
function rebaseOntoHead(issue: OpenReviewIssue, files: ComparedFileLines[] | undefined): OpenReviewIssue {
  if (issue.side !== "RIGHT" || issue.line === FILE_LEVEL_LINE || issue.lineBasis === "current" || files === undefined) {
    return issue;
  }
  const file = files.find((candidate) => candidate.path === issue.path || candidate.previousPath === issue.path);
  if (file === undefined || file.patchMissing) {
    return issue;
  }
  const added = new Set(file.addedLines);
  const deleted = new Set(file.deletedLines);
  let oldLine = 1;
  let newLine = 1;
  while (oldLine < issue.line) {
    if (added.has(newLine)) {
      newLine += 1;
    } else if (deleted.has(oldLine)) {
      oldLine += 1;
    } else {
      oldLine += 1;
      newLine += 1;
    }
  }
  while (added.has(newLine)) {
    newLine += 1;
  }
  return { ...issue, line: newLine };
}

function anchorSettled(issue: OpenReviewIssue, files: ComparedFileLines[] | undefined): boolean {
  if (files === undefined) {
    return false;
  }
  // A carried issue keeps its pre-rename path, so a rename in this window is found by its previous path.
  const file = files.find((candidate) => candidate.path === issue.path || candidate.previousPath === issue.path);
  if (file === undefined) {
    return false;
  }
  if (file.status === "added" || file.status === "removed" || file.status === "renamed") {
    return true;
  }
  if (file.patchMissing) {
    return false;
  }
  // A LEFT line is numbered on the PR base, which the previous-to-head compare never expresses, and a file-level
  // issue has no line. Treat any change to the file since the last review as settling it; a still-present issue is
  // re-raised by fingerprint.
  if (issue.side === "LEFT" || issue.line === FILE_LEVEL_LINE) {
    return file.addedLines.length > 0 || file.deletedLines.length > 0;
  }
  // A marker line is numbered on the previous commit. Compare deleted lines, not new-head added lines.
  if (issue.lineBasis !== "current") {
    return file.deletedLines.includes(issue.line);
  }
  return file.addedLines.includes(issue.line);
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
    let path: string;
    try {
      path = decodeURIComponent(encodedPath);
    } catch {
      // The marker sits in an editable review body; a bad escape drops this entry like any other malformed field.
      return [];
    }
    return [{ fingerprint, path, line: Number(line), side, lineBasis: "previous" }];
  });
}
