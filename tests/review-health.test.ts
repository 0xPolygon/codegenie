import { describe, it, expect } from "vitest";
import { deriveReviewHealth, reviewDiagnostic } from "../src/util/review-health.js";
import { renderMarkdownReview } from "../src/output/markdown-renderer.js";
import { renderPostingSummaryForStdout } from "../src/output/stdout-renderer.js";
import { CodegenieError } from "../src/util/errors.js";
import type { ReviewResult, RunCoverageStatus } from "../src/types.js";

const coverage: RunCoverageStatus = { totalHunks: 4, reviewedHunks: 2, skippedHunks: 2, failedHunks: 0,
  coverageByLevel: { deep: 0, normal: 2, light: 0, skip: 2 }, degradedPlanning: false, budgetStopped: false,
  verificationIncompleteCount: 0, partial: false, reasons: [] };
function result(c: RunCoverageStatus = coverage): ReviewResult {
  return { coverage: c, summary: "Everything looks good", findings: [], summaryOnlyFindings: [], needsHumanAttention: [], noFindings: true };
}

describe("review health", () => {
  it("distinguishes unavailable coverage from a known empty review", () => {
    const empty = { ...coverage, totalHunks: 0, reviewedHunks: 0, skippedHunks: 0,
      coverageByLevel: { deep: 0, normal: 0, light: 0, skip: 0 } };
    const unavailable = renderMarkdownReview(result({ ...empty, unavailable: true, partial: true,
      diagnostics: [reviewDiagnostic(1, new CodegenieError("invalid_args", "Unknown revision"))] }));
    expect(unavailable).toContain("Stage 1: invalid_args");
    expect(unavailable).toContain("**Coverage unavailable:");
    expect(unavailable).not.toContain("0/0 hunks");
    expect(unavailable).not.toContain("0 hunks did not complete");
    expect(renderMarkdownReview(result(empty))).toContain("Reviewed 0/0 hunks.");
    expect(renderMarkdownReview(result(empty))).not.toContain("Coverage unavailable");
  });
  it("describes unfinished evidence without claiming zero hunks failed or an early stop", () => {
    const markdown = renderMarkdownReview(result({ ...coverage, partial: true,
      diagnostics: [reviewDiagnostic(7, new CodegenieError("budget_exhausted", "source unavailable"))] }));
    expect(markdown).toContain("required evidence gathering remains incomplete");
    expect(markdown).not.toContain("0 hunks did not complete");
    expect(markdown).not.toContain("before stopping");
  });
  it("gives unrecovered failures precedence and redacts diagnostics before rendering", () => {
    const diagnostic = reviewDiagnostic(9, new CodegenieError("llm_call_failed", "HTTP 402 token=very-secret-value"), "candidate-1", "failed");
    const r = result({ ...coverage, partial: true, diagnostics: [diagnostic] });
    r.health = deriveReviewHealth(r.coverage, 10);
    expect(r.health.status).toBe("failed");
    const markdown = renderMarkdownReview(r);
    expect(markdown.indexOf("**Review failed.")).toBeLessThan(markdown.indexOf("confirmed findings"));
    expect(markdown).toContain("Stage 9 (candidate-1): llm_call_failed");
    expect(markdown).not.toContain("very-secret-value");
    expect(markdown).not.toContain("Everything looks good");
    expect(markdown).not.toContain("## No confirmed findings");
    expect(renderPostingSummaryForStdout(r, "markdown")).toContain("Review failed");
  });
  it.each(["timeout", "budget_exhausted"] as const)("treats required limits as incomplete, not operational failure: %s", code => {
    const r = result({ ...coverage, diagnostics: [reviewDiagnostic(7, new CodegenieError(code, "limit"))] });
    expect(deriveReviewHealth(r.coverage, 0).status).toBe("incomplete");
    expect(renderMarkdownReview(r)).toContain("Review incomplete");
  });
  it("retains bounded provider reasons and puts fundamental errors ahead of limits", () => {
    const diagnostic = reviewDiagnostic(9, new CodegenieError("llm_call_failed", "Provider call failed", { context: { providerMessage: "HTTP 402: no available credits" } }));
    const r = result({ ...coverage, diagnostics: [...Array.from({length: 5}, () => reviewDiagnostic(7, new CodegenieError("budget_exhausted", "limit"))), diagnostic] });
    expect(renderMarkdownReview(r)).toContain("HTTP 402: no available credits");
    expect(renderMarkdownReview(r)).toContain("**Review failed.");
  });
  it("does not label skips under incomplete planning as deliberate exclusions", () => {
    const r = result({ ...coverage, partial: true, excludedHunks: 0 });
    expect(renderMarkdownReview(r)).toContain("skipped under incomplete planning 2");
    expect(renderMarkdownReview(r)).not.toContain("Excluded by configuration/planning");
  });
  it("keeps unresolved status even when presentation hides every question", () => {
    const r = result();
    r.needsHumanAttentionOmittedCount = 3;
    expect(renderMarkdownReview(r)).toContain("Review completed with unresolved questions");
    expect(renderMarkdownReview(r)).not.toContain("Everything looks good");
  });
  it("does not call deliberate exclusions incomplete, and does not fail recovered execution", () => {
    expect(deriveReviewHealth(coverage, 0).status).toBe("completed");
    const markdown = renderMarkdownReview({ ...result(), summary: "No confirmed findings within reviewed scope." });
    expect(markdown).toContain("Excluded by configuration/planning:** 2");
    expect(markdown).not.toContain("Incomplete work");
  });
  it("marks skipped verification incomplete only when candidates needed it", () => {
    expect(deriveReviewHealth({ ...coverage, verificationSkipped: true }, 0, true).status).toBe("incomplete");
    expect(deriveReviewHealth({ ...coverage, verificationSkipped: true }, 0, false).status).toBe("completed");
  });
});
