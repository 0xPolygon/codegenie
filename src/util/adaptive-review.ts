import type { AdaptiveReviewSummary, PacketReviewResult } from "../types.js";

/** Aggregate per-pass outcomes, never per-call errors or inferred wall-clock time. */
export function summarizeAdaptiveReviews(results: PacketReviewResult[]): AdaptiveReviewSummary | undefined {
  if (!results.some(result => result.adaptiveReview !== undefined)) return undefined;
  const passes = results.flatMap(result => result.adaptiveReview && result.adaptiveReview.outcome !== "not_triggered"
    ? [{ packetId: result.packetId, ...result.adaptiveReview }] : []);
  const counts: AdaptiveReviewSummary["counts"] = {
    triggered: passes.length, scheduled: 0, completed: 0, incomplete: 0, failed: 0,
    timedOut: 0, cancelled: 0, notDispatched: 0, capped: 0, retries: 0
  };
  for (const pass of passes) {
    if (pass.outcome === "capped") { counts.capped++; continue; }
    counts.scheduled++;
    counts.retries += Math.max(0, pass.attempts - 1);
    if (pass.outcome === "completed") {
      if (pass.reviewStatus === "completed") counts.completed++;
      else if (pass.reviewStatus === "failed") counts.failed++;
      else if (pass.reviewStatus === "skipped") counts.notDispatched++;
      else counts.incomplete++;
    } else if (pass.outcome === "timed_out" || pass.outcome === "failed" && pass.failureReason === "timeout") counts.timedOut++;
    else if (pass.outcome === "cancelled") counts.cancelled++;
    else if (pass.outcome === "not_dispatched") {
      // The scheduler can stop a retry after an earlier failed attempt. That
      // investigation failed to finish; it was not wholly undispatched.
      if (pass.attempts > 0) counts.failed++;
      else counts.notDispatched++;
    }
    else counts.failed++;
  }
  return { passes, counts };
}
