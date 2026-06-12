import type { OutputFormat, ReviewResult } from "../types.js";
import { renderJsonReview } from "./json-renderer.js";
import { renderMarkdownReview } from "./markdown-renderer.js";

export function renderReviewForStdout(result: ReviewResult, format: OutputFormat): string {
  return format === "json" ? renderJsonReview(result) : renderMarkdownReview(result);
}

export function renderPostingSummaryForStdout(
  result: ReviewResult,
  format: OutputFormat,
  opts: { postRequested?: boolean } = {}
): string {
  if (result.posting !== undefined) {
    if (format === "json") {
      return `${JSON.stringify(result.posting, null, 2)}\n`;
    }
    return [
      "codeninja GitHub posting summary",
      `Status: ${result.posting.status}`,
      `Inline comments posted: ${result.posting.inlinePosted}`,
      `Demoted to review body: ${result.posting.demotedToBody}`,
      `Skipped duplicates: ${result.posting.skippedDuplicates}`,
      `Attempts: ${result.posting.attempts.length}`
    ].join("\n") + "\n";
  }

  const summary = {
    summary: result.summary,
    findings: result.findings.length,
    summaryOnlyFindings: result.summaryOnlyFindings.length,
    postingPlan: result.postingPlan ?? null,
    noFindings: result.noFindings,
    postRequested: opts.postRequested === true
  };
  if (format === "json") {
    return `${JSON.stringify(summary, null, 2)}\n`;
  }
  return [
    "codeninja GitHub posting summary",
    `Findings ready to post: ${result.findings.length}`,
    `Summary-only findings: ${result.summaryOnlyFindings.length}`,
    result.postingPlan
      ? `Inline comments: ${result.postingPlan.inline.length}`
      : opts.postRequested === true
        ? "Posting was requested, but no review body or inline comments were created."
        : "Posting was not requested."
  ].join("\n") + "\n";
}
