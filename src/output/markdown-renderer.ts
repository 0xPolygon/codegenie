import type { BudgetLimitEvent, BudgetSummary, FinalFinding, ReviewResult, ReviewRunStats, RunCoverageStatus } from "../types.js";
import { renderBudgetStopNotice, renderCoverageSummaryLines } from "../util/coverage-summary.js";

export function renderMarkdownReview(result: ReviewResult): string {
  const sections = [
    "# codegenie review",
    "",
    renderBudgetStopNotice(result.coverage),
    result.summary.trim() || "Review completed.",
    "",
    renderCoverage(result.coverage),
    renderFindings("Findings", result.findings),
    renderFindings("Summary-Only Findings", result.summaryOnlyFindings),
    renderNeedsHumanAttention(result),
    renderStats(result.runStats, result.budgetSummary),
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

function renderStats(stats: ReviewRunStats | undefined, summary: BudgetSummary | undefined): string {
  const statLines = renderRunStatLines(stats);
  const budgetLines = renderBudgetSummaryLines(summary);
  if (statLines.length === 0 && budgetLines.length === 0) {
    return "";
  }

  return ["## Stats", "", ...statLines, ...budgetLines].join("\n");
}

function renderRunStatLines(stats: ReviewRunStats | undefined): string[] {
  if (stats === undefined) {
    return [];
  }

  const lines: string[] = [];
  const model = renderModel(stats.model);
  if (model !== undefined) {
    lines.push(`Model: ${model}`);
  }
  if (stats.elapsedMs !== undefined) {
    lines.push(`Elapsed time: ${formatElapsed(stats.elapsedMs)}`);
  }
  if (stats.git !== undefined) {
    lines.push(`Git: ${stats.git.repo} from ${stats.git.base} to ${renderGitHead(stats.git)}`);
  }
  return lines;
}

function renderGitHead(git: NonNullable<ReviewRunStats["git"]>): string {
  const shortHash = shortHashForDisplay(git.headSha);
  if (shortHash === undefined || git.head.startsWith(shortHash)) {
    return git.head;
  }
  return `${git.head} (${shortHash})`;
}

function shortHashForDisplay(sha: string | undefined): string | undefined {
  const trimmed = sha?.trim();
  return trimmed !== undefined && trimmed.length >= 10 ? trimmed.slice(0, 10) : undefined;
}

function renderBudgetSummaryLines(summary: BudgetSummary | undefined): string[] {
  if (!summary || !shouldRenderBudgetSummary(summary)) {
    return [];
  }

  const lines: string[] = [];
  lines.push(`Review completeness: ${summary.completeness}.`);
  const pressure = renderContextPressure(summary);
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
  if (pressure.length > 0) {
    lines.push(`Local context pressure: ${pressure.join(", ")}.`);
  }
  return lines;
}

function shouldRenderBudgetSummary(summary: BudgetSummary): boolean {
  return summary.usage.modelCalls > 0 ||
    summary.usage.totalTokens > 0 ||
    summary.usage.costUSD !== undefined ||
    summary.multiplier !== 1 ||
    summary.effective.maxModelCalls !== undefined ||
    summary.effective.maxBudgetTokens !== undefined ||
    summary.overruns.length > 0 ||
    summary.dispatchBlocks.length > 0 ||
    renderContextPressure(summary).length > 0;
}

function budgetCapParts(summary: BudgetSummary): string[] {
  const parts: string[] = [];
  if (summary.effective.maxModelCalls !== undefined) {
    parts.push(`model calls ${summary.effective.maxModelCalls}${capSource(summary.configured.maxModelCalls, summary.multiplier)}`);
  }
  if (summary.effective.maxBudgetTokens !== undefined) {
    parts.push(`tokens ${summary.effective.maxBudgetTokens}${capSource(summary.configured.maxBudgetTokens, summary.multiplier)}`);
  }
  if (summary.multiplier !== 1 && parts.length === 0) {
    parts.push(`budget multiplier ${summary.multiplier}`);
  }
  return parts;
}

function capSource(configured: number | undefined, multiplier: number): string {
  if (configured === undefined || multiplier === 1) {
    return "";
  }
  return ` (configured ${configured}, multiplier ${multiplier})`;
}

function renderBudgetEvent(event: BudgetLimitEvent): string {
  return `stage ${event.stage} ${event.kind} ${event.actual}/${event.limit}`;
}

function renderContextPressure(summary: BudgetSummary): string[] {
  const pressure = summary.contextPressure;
  if (pressure === undefined) {
    return [];
  }
  const parts: string[] = [];
  if (pressure.toolBudgetRejections > 0) {
    parts.push(`${pressure.toolBudgetRejections} tool-budget rejection${pressure.toolBudgetRejections === 1 ? "" : "s"}`);
  }
  if (pressure.toolBudgetExtensions !== undefined && (pressure.toolBudgetExtensions.granted > 0 || pressure.toolBudgetExtensions.denied > 0)) {
    const extensionParts = [`${pressure.toolBudgetExtensions.granted} source-budget extension${pressure.toolBudgetExtensions.granted === 1 ? "" : "s"}`];
    if (pressure.toolBudgetExtensions.denied > 0) {
      extensionParts.push(`${pressure.toolBudgetExtensions.denied} denied`);
    }
    if (pressure.toolBudgetExtensions.resultChars > 0) {
      extensionParts.push(`${pressure.toolBudgetExtensions.resultChars} chars`);
    }
    parts.push(extensionParts.join(" / "));
  }
  if (pressure.degradedToolResults > 0) {
    parts.push(`${pressure.degradedToolResults} degraded tool result${pressure.degradedToolResults === 1 ? "" : "s"}`);
  }
  if (pressure.degradedHunks > 0) {
    parts.push(`${pressure.degradedHunks} degraded hunk${pressure.degradedHunks === 1 ? "" : "s"}`);
  }
  if (pressure.unresolvedNotes.omitted > 0) {
    parts.push(`${pressure.unresolvedNotes.omitted} unresolved note${pressure.unresolvedNotes.omitted === 1 ? "" : "s"} suppressed`);
  }
  return parts;
}

function renderModel(model: ReviewRunStats["model"]): string | undefined {
  if (model === undefined) {
    return undefined;
  }
  const provider = model.provider?.trim();
  const id = model.id?.trim();
  const reasoning = model.reasoning?.trim();
  const parts: string[] = [];
  if (provider && id) {
    parts.push(provider, id);
  } else if (provider) {
    parts.push(provider);
  } else if (id) {
    parts.push(id);
  }
  if (reasoning) {
    parts.push(reasoning);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function formatElapsed(elapsedMs: number): string {
  const ms = Math.max(0, Math.round(elapsedMs));
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
