import type { RunCoverageStatus } from "../types.js";
import { isDisclosableCoverageReason } from "./coverage-reasons.js";

export function renderCoverageSummaryLines(coverage: RunCoverageStatus): string[] {
  const lines = [coverageHeadline(coverage)];
  if (coverage.partial) {
    lines.push(`Reviewed ${coverage.reviewedHunks}/${coverage.totalHunks} hunks before stopping.`);
  }
  const statusLine = coverageStatusLine(coverage);
  if (statusLine !== undefined) {
    lines.push(statusLine);
  }
  lines.push(`Coverage levels: deep ${coverage.coverageByLevel.deep}, normal ${coverage.coverageByLevel.normal}, light ${coverage.coverageByLevel.light}, skip ${coverage.coverageByLevel.skip}.`);
  if (coverage.degradedPlanning) {
    lines.push("Planning was degraded and deterministic fallbacks were used.");
  }
  if (coverage.verificationSkipped) {
    lines.push("Verification was skipped by configuration.");
  }
  if (coverage.unreviewedHunksByPath && coverage.unreviewedHunksByPath.length > 0) {
    lines.push("Unreviewed hunks by file:");
    for (const gap of coverage.unreviewedHunksByPath.slice(0, 12)) {
      lines.push(`- ${gap.path}: ${gap.hunks} hunk${gap.hunks === 1 ? "" : "s"} (${humanizeCoverageReason(gap.reason)})`);
    }
    const omitted = coverage.unreviewedHunksByPath.length - 12;
    if (omitted > 0) {
      lines.push(`- ${omitted} additional file${omitted === 1 ? "" : "s"} omitted.`);
    }
  }
  for (const reason of coverageDisclosureLines(coverage)) {
    lines.push(reason);
  }
  return uniqueLines(lines);
}

export function renderBudgetStopNotice(coverage: RunCoverageStatus): string {
  const stop = coverage.budgetStop;
  if (!coverage.budgetStopped || stop === undefined) {
    return "";
  }
  if (stop.reason === "runtime_reserved_tail" || stop.reason === "hard_timeout") {
    const minutes = Math.round(stop.timeoutMs / 60_000);
    return (
      `> **Sorry, this review is incomplete.** The allotted max time of ${minutes} minutes was reached ` +
      "and the review has been degraded. Re-run with `--max-time <minutes>` " +
      "(config `review.timeoutMs`, or `review.maxTimeMinutes` in eval cases) for a higher time allotment."
    );
  }
  const limit = stop.reason === "max_model_calls"
    ? `max model calls limit of ${stop.maxModelCalls ?? "?"} (config \`review.maxModelCalls\`)`
    : `max token limit of ${stop.maxBudgetTokens ?? "?"} (config \`review.maxBudgetTokens\`)`;
  return (
    `> **Sorry, this review is incomplete.** The allotted ${limit} was reached ` +
    "and the review has been degraded. Raise the limit for a complete review."
  );
}

export function coverageDisclosureLines(coverage: RunCoverageStatus): string[] {
  const lines: string[] = [];
  if (coverage.budgetStopped) {
    lines.push(`- Budget stopped review work${coverage.budgetStop ? ` (${humanizeBudgetReason(coverage.budgetStop.reason)})` : ""}.`);
  }
  if (coverage.verificationIncompleteCount > 0) {
    lines.push(`- Verification incomplete for ${coverage.verificationIncompleteCount} candidate${coverage.verificationIncompleteCount === 1 ? "" : "s"}.`);
  }
  if (coverage.verificationSkipped === true) {
    lines.push("- Verification was skipped by configuration.");
  }
  for (const reason of coverage.reasons.filter((item) => shouldRenderCoverageReason(item, coverage))) {
    lines.push(`- ${reason}`);
  }
  return uniqueLines(lines);
}

function coverageHeadline(coverage: RunCoverageStatus): string {
  if (!coverage.partial) {
    return `Reviewed ${coverage.reviewedHunks}/${coverage.totalHunks} hunks.`;
  }
  const unreviewed = unreviewedHunkCount(coverage);
  if (coverage.budgetStopped && unreviewed > 0) {
    return `Partial review: ${unreviewed} ${hunkNoun(unreviewed)} ${unreviewed === 1 ? "was" : "were"} not reviewed because budget was exhausted before dispatch.`;
  }
  if (coverage.budgetStopped) {
    return "Partial review: budget was exhausted after dispatched review work completed.";
  }
  if (unreviewed === 0 && coverage.verificationIncompleteCount > 0) {
    return `Review completed with incomplete verification for ${coverage.verificationIncompleteCount} candidate${coverage.verificationIncompleteCount === 1 ? "" : "s"}.`;
  }
  if (unreviewed === 0 && coverage.degradedPlanning) {
    return "Review completed with degraded planning.";
  }
  return `Partial review: ${unreviewed} ${hunkNoun(unreviewed)} did not complete review.`;
}

function hunkNoun(count: number): string {
  return count === 1 ? "hunk" : "hunks";
}

function coverageStatusLine(coverage: RunCoverageStatus): string | undefined {
  const parts: string[] = [];
  if (coverage.skippedHunks > 0) {
    parts.push(`skipped ${coverage.skippedHunks}`);
  }
  if (coverage.failedHunks > 0) {
    parts.push(`failed ${coverage.failedHunks}`);
  }
  if (coverage.verificationIncompleteCount > 0) {
    parts.push(`verification incomplete ${coverage.verificationIncompleteCount}`);
  }
  return parts.length > 0 ? `Incomplete work: ${parts.join(", ")}.` : undefined;
}

function unreviewedHunkCount(coverage: RunCoverageStatus): number {
  return Math.max(0, coverage.totalHunks - coverage.reviewedHunks - coverage.skippedHunks);
}

function humanizeCoverageReason(reason: string): string {
  if (reason === "budget_stopped before dispatch") {
    return "budget stopped before dispatch";
  }
  return reason.replaceAll("_", " ");
}

function shouldRenderCoverageReason(reason: string, coverage: RunCoverageStatus): boolean {
  if (!isDisclosableCoverageReason(reason)) {
    return false;
  }
  if (coverage.budgetStopped && reason === "budget exhausted before all review work completed") {
    return false;
  }
  if (coverage.unreviewedHunksByPath && /^\d+ hunk\(s\) could not be reviewed$/u.test(reason)) {
    return false;
  }
  if (coverage.verificationIncompleteCount > 0 && /^\d+ candidate verification\(s\) were incomplete$/u.test(reason)) {
    return false;
  }
  return true;
}

function humanizeBudgetReason(reason: string): string {
  switch (reason) {
    case "runtime_reserved_tail":
      return "runtime reserve reached";
    case "max_model_calls":
      return "model-call limit reached";
    case "max_budget_tokens":
      return "token limit reached";
    case "hard_timeout":
      return "hard timeout reached";
    default:
      return reason.replaceAll("_", " ");
  }
}

function uniqueLines(lines: string[]): string[] {
  return [...new Set(lines)];
}
