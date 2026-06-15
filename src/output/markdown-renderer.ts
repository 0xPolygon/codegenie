import type { FinalFinding, ReviewResult, RunCoverageStatus } from "../types.js";
import { renderCoverageSummaryLines } from "../util/coverage-summary.js";

export function renderMarkdownReview(result: ReviewResult): string {
  const sections = [
    "# codeninja review",
    "",
    result.summary.trim() || "Review completed.",
    "",
    renderCoverage(result.coverage),
    renderFindings("Findings", result.findings),
    renderFindings("Summary-Only Findings", result.summaryOnlyFindings),
    renderNeedsHumanAttention(result),
    result.noFindings ? "## No Findings\n\nNo credible findings were found." : ""
  ].filter((section) => section.trim().length > 0);

  return `${sections.join("\n\n")}\n`;
}

function renderCoverage(coverage: RunCoverageStatus): string {
  return ["## Coverage", "", ...renderCoverageSummaryLines(coverage)].join("\n");
}

function renderFindings(title: string, findings: FinalFinding[]): string {
  if (findings.length === 0) {
    return "";
  }

  const lines = [`## ${title}`];
  for (const finding of findings) {
    lines.push("", `### ${finding.severity.toUpperCase()}: ${finding.title}`);
    lines.push(`File: ${finding.path}${finding.anchor ? `:${finding.anchor.line}` : ""}`);
    lines.push(`Confidence: ${finding.confidence}`);
    lines.push("", finding.finalBody.trim() || finding.failureMode);
  }
  return lines.join("\n");
}

function renderNeedsHumanAttention(result: ReviewResult): string {
  const omittedCount = result.needsHumanAttentionOmittedCount ?? 0;
  if (result.needsHumanAttention.length === 0 && omittedCount === 0) {
    return "";
  }

  const lines = ["## Needs Human Attention"];
  for (const note of result.needsHumanAttention) {
    lines.push("", `- ${note.question}`);
    lines.push(`  Files: ${note.files.join(", ") || "n/a"}`);
    if (note.symbols.length > 0) {
      lines.push(`  Symbols: ${note.symbols.join(", ")}`);
    }
    lines.push(`  Reason: ${note.reason}`);
  }
  if (omittedCount > 0) {
    lines.push("", `Additional unresolved notes suppressed: ${omittedCount}.`);
  }
  return lines.join("\n");
}
