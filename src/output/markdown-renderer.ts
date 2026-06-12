import type { FinalFinding, ReviewResult, RunCoverageStatus } from "../types.js";

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
  const lines = [
    "## Coverage",
    "",
    `Reviewed ${coverage.reviewedHunks}/${coverage.totalHunks} hunks.`,
    `Skipped: ${coverage.skippedHunks}. Failed: ${coverage.failedHunks}. Verification incomplete: ${coverage.verificationIncompleteCount}.`,
    `Coverage levels: deep ${coverage.coverageByLevel.deep}, normal ${coverage.coverageByLevel.normal}, light ${coverage.coverageByLevel.light}, skip ${coverage.coverageByLevel.skip}.`
  ];
  if (coverage.partial) {
    lines.push("Partial review: yes.");
  }
  if (coverage.degradedPlanning) {
    lines.push("Planning was degraded and deterministic fallbacks were used.");
  }
  if (coverage.budgetStopped) {
    lines.push("Budget stopped further review work.");
  }
  if (coverage.verificationSkipped) {
    lines.push("Verification was skipped by configuration.");
  }
  for (const reason of coverage.reasons) {
    lines.push(`- ${reason}`);
  }
  return lines.join("\n");
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
    lines.push("", `Failure mode: ${finding.failureMode}`);
    lines.push(`Why it matters: ${finding.whyThisMatters}`);
    if (finding.suggestedFix) {
      lines.push(`Suggested fix: ${finding.suggestedFix}`);
    }
    if (finding.suggestedTest) {
      lines.push(`Suggested test: ${finding.suggestedTest}`);
    }
  }
  return lines.join("\n");
}

function renderNeedsHumanAttention(result: ReviewResult): string {
  if (result.needsHumanAttention.length === 0) {
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
  return lines.join("\n");
}
