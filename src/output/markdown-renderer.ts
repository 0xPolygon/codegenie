import type { BudgetLimitEvent, BudgetSummary, FinalFinding, ReviewResult, RunCoverageStatus } from "../types.js";
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
    renderBudgetSummary(result.budgetSummary),
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

function renderBudgetSummary(summary: BudgetSummary | undefined): string {
  if (!summary || !shouldRenderBudgetSummary(summary)) {
    return "";
  }

  const lines = ["## Budget"];
  lines.push("");
  lines.push(`Review completeness: ${summary.completeness}.`);
  const usage = [`model calls ${summary.usage.modelCalls}`, `tokens ${summary.usage.totalTokens}`];
  if (summary.usage.costUSD !== undefined) {
    usage.push(`cost $${summary.usage.costUSD.toFixed(4)}`);
  }
  lines.push(`Usage: ${usage.join(", ")}.`);
  const caps = budgetCapParts(summary);
  if (caps.length > 0) {
    lines.push(`Effective caps: ${caps.join(", ")}.`);
  }
  if (summary.overruns.length > 0) {
    lines.push(`Budget overruns: ${summary.overruns.map(renderBudgetEvent).join("; ")}.`);
  }
  if (summary.dispatchBlocks.length > 0) {
    lines.push(`Budget dispatch blocks: ${summary.dispatchBlocks.map(renderBudgetEvent).join("; ")}.`);
  }
  return lines.join("\n");
}

function shouldRenderBudgetSummary(summary: BudgetSummary): boolean {
  return summary.usage.modelCalls > 0 ||
    summary.usage.totalTokens > 0 ||
    summary.usage.costUSD !== undefined ||
    summary.multiplier !== 1 ||
    summary.effective.maxModelCalls !== undefined ||
    summary.effective.maxTotalTokens !== undefined ||
    summary.overruns.length > 0 ||
    summary.dispatchBlocks.length > 0;
}

function budgetCapParts(summary: BudgetSummary): string[] {
  const parts: string[] = [];
  if (summary.effective.maxModelCalls !== undefined) {
    parts.push(`model calls ${summary.effective.maxModelCalls}${capSource(summary.configured.maxModelCalls, summary.effective.maxModelCalls, summary.multiplier)}`);
  }
  if (summary.effective.maxTotalTokens !== undefined) {
    parts.push(`tokens ${summary.effective.maxTotalTokens}${capSource(summary.configured.maxTotalTokens, summary.effective.maxTotalTokens, summary.multiplier)}`);
  }
  if (summary.multiplier !== 1 && parts.length === 0) {
    parts.push(`budget multiplier ${summary.multiplier}`);
  }
  return parts;
}

function capSource(configured: number | undefined, effective: number, multiplier: number): string {
  if (configured === undefined || multiplier === 1) {
    return "";
  }
  return ` (configured ${configured}, multiplier ${multiplier})`;
}

function renderBudgetEvent(event: BudgetLimitEvent): string {
  return `stage ${event.stage} ${event.kind} ${event.actual}/${event.limit}`;
}
