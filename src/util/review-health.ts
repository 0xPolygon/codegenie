import type { ReviewDiagnostic, ReviewHealth, ReviewResult, RunCoverageStatus } from "../types.js";
import type { LlmToolResultSummary } from "../llm/llm-runner.js";
import { isCodegenieError } from "./errors.js";
import { stripCredentials } from "../telemetry/redaction.js";
import { isLocalToolBudgetRejectionReason } from "./context-pressure.js";

export function reviewDiagnostic(stage: number, error: unknown, workItem?: string, outcome?: string): ReviewDiagnostic {
  const code = isCodegenieError(error) ? error.code : "unknown_execution_error";
  const limited = code === "timeout" || code === "budget_exhausted" || outcome === "timed_out" || outcome === "not_dispatched"
    || (isCodegenieError(error) && error.context?.reason === "timeout");
  const headline = error instanceof Error ? error.message : "The underlying cause was not captured.";
  const context = isCodegenieError(error) ? error.context : undefined;
  const { providerMessage, providerErrorCode, workerId, callId } = context ?? {};
  return { stage, ...(workItem ? { workItem } : {}), kind: limited ? "incomplete" : "failure", code,
    ...(typeof providerErrorCode === "string" ? { providerErrorCode } : {}),
    ...(typeof workerId === "string" ? { workerId } : {}),
    ...(typeof callId === "string" ? { callId } : {}),
    reason: safeDiagnosticLine(`${headline}${typeof providerMessage === "string" ? `: ${providerMessage}` : ""}${typeof providerErrorCode === "string" ? ` (${providerErrorCode})` : ""}`),
    recoveryExhausted: outcome !== "not_dispatched" };
}

export function safeDiagnosticLine(message: string): string {
  return stripCredentials(message).replace(/[\s\u0000-\u001f\u007f-\u009f]+/gu, " ").trim().slice(0, 600);
}

export function deriveReviewHealth(
  coverage: RunCoverageStatus,
  unresolvedCount: number,
  verificationNeeded = false,
  verificationCandidateCount?: number
): ReviewHealth {
  // Health and coverage are serialized together; shared objects are redacted as circular references.
  const diagnostics = (coverage.diagnostics ?? []).map(diagnostic => ({ ...diagnostic }));
  const status = diagnostics.some(d => d.kind === "failure") ? "failed"
    : coverage.partial || coverage.failedHunks > 0 || coverage.verificationIncompleteCount > 0 || coverage.budgetStopped
      || (coverage.verificationSkipped && verificationNeeded) || diagnostics.some(d => d.kind === "incomplete") ? "incomplete"
    : unresolvedCount > 0 ? "unresolved" : "completed";
  return {
    status,
    diagnostics,
    unresolvedCount,
    ...(coverage.verificationIncompleteCount > 0 && verificationCandidateCount !== undefined
      && verificationCandidateCount >= coverage.verificationIncompleteCount ? { verificationCandidateCount } : {})
  };
}

export function healthForResult(result: ReviewResult): ReviewHealth {
  return result.health ?? deriveReviewHealth(result.coverage,
    result.needsHumanAttention.length + (result.needsHumanAttentionOmittedCount ?? 0),
    result.findings.length + result.summaryOnlyFindings.length > 0);
}

export function renderReviewHealth(
  health: ReviewHealth,
  composition: ReviewResult["composition"],
  details: { shown: number; omitted: number; inFullReview?: boolean; verificationIncompleteCount: number }
): string {
  const synthesis = composition?.fallbackReason ? `> **Report synthesis failed (stage 10).** Verified findings are shown using source-based fallback. ${safeText(composition.fallbackReason)}` : "";
  if (health.status === "completed") return synthesis ? `> [!WARNING]\n${synthesis}` : "";
  const title = health.status === "failed" ? "Review failed" : health.status === "incomplete" ? "Review incomplete" : "Review completed with unresolved questions";
  const counts = `${details.shown} shown, ${details.omitted} omitted.`;
  const { verificationIncompleteCount } = details;
  const total = health.verificationCandidateCount;
  const verification = verificationIncompleteCount > 0 && total !== undefined && total >= verificationIncompleteCount
    ? ` Verification did not finish for ${verificationIncompleteCount} of ${total} candidates selected for verification.` : "";
  const detail = health.status === "unresolved"
    ? `${details.inFullReview ? "In the full review, " : ""}${counts} Absence of a confirmed finding does not establish safety.`
    : `Required work did not complete reliably. Findings below are partial results.${verification}` +
      (details.shown + details.omitted > 0
        ? ` Unresolved questions${details.inFullReview ? " in the full review" : ""} — ${counts}`
        : "");
  const diagnostics = [...health.diagnostics].sort((a, b) => Number(b.kind === "failure") - Number(a.kind === "failure")).slice(0, 5).map(d =>
    `> - Stage ${d.stage}${d.workItem ? ` (${safeText(d.workItem)})` : ""}: ${safeText(d.code)} — ${safeText(d.reason)}${d.recoveryExhausted ? " Recovery exhausted." : ""}`);
  return [`> [!WARNING]`, `> **${title}.** ${detail}`, ...(synthesis ? [synthesis] : []), ...diagnostics].join("\n");
}

export function factualReviewSummary(health: ReviewHealth, count: number): string {
  return `${count} confirmed finding${count === 1 ? "" : "s"} retained from completed work. ${health.status === "unresolved" ? "Unresolved questions require attention." : "Incomplete required work prevents a clean conclusion."}`;
}

function safeText(text: string): string {
  return stripCredentials(text).replace(/[\r\n]+/g, " ").replace(/[<>&`*\[\]]/g, "").slice(0, 600);
}

// Keep the original diagnostic in the coverage shown to the composer. Apply the
// completed-packet exception only when deciding what remains required work.
const completedPacketDiagnosticReplacements = new WeakMap<ReviewDiagnostic, ReviewDiagnostic[]>();

export function requiredDiagnosticsAfterComposition(diagnostic: ReviewDiagnostic): ReviewDiagnostic[] {
  return completedPacketDiagnosticReplacements.get(diagnostic) ?? [diagnostic];
}

/** Operational recovery requires the same complete request to succeed, not just a valid final payload. */
export function unresolvedToolDiagnostic(stage: number, results: LlmToolResultSummary[], workItem: string, completedPacket = false): ReviewDiagnostic | undefined {
  const failures = results.filter((result, index) => result.errorCode &&
    !["invalid_args", "path_outside_repo"].includes(result.errorCode) &&
    !results.slice(index + 1).some(later => result.requestKey !== undefined && later.requestKey === result.requestKey && later.status === "ok" && !later.truncated));
  const failed = failures.find(result => result.errorCode !== "budget_exhausted" && result.errorCode !== "timeout") ?? failures[0];
  if (!failed) return undefined;
  const diagnostic = toolFailureDiagnostic(stage, failed, workItem);
  if (completedPacket && isLocalToolBudgetRejectionReason(failed.rejectionReason)) {
    const requiredFailure = failures.find(result => !isLocalToolBudgetRejectionReason(result.rejectionReason));
    completedPacketDiagnosticReplacements.set(diagnostic, requiredFailure ? [toolFailureDiagnostic(stage, requiredFailure, workItem)] : []);
  }
  return diagnostic;
}

function toolFailureDiagnostic(stage: number, failed: LlmToolResultSummary, workItem: string): ReviewDiagnostic {
  return { stage, workItem, origin: "tool", code: failed.errorCode!, kind: failed.errorCode === "budget_exhausted" || failed.errorCode === "timeout" ? "incomplete" : "failure",
    reason: stripCredentials(failed.preview ?? "A tool failed and required evidence remains unresolved; recovery could not be established.").slice(0, 600), recoveryExhausted: true };
}
