import { describe, expect, it } from "vitest";
import { summarizeAdaptiveReviews } from "../src/util/adaptive-review.js";
import { scoreEvalRun } from "../src/evals/eval-scoring.js";
import type { AdaptiveReviewOutcome, EvalArtifacts, PacketReviewResult } from "../src/types.js";

const result = (adaptiveReview?: AdaptiveReviewOutcome): PacketReviewResult => ({ packetId: "p", lenses: [], findings: [],
  followUpHints: [], uncertainties: [], status: "completed", ...(adaptiveReview ? { adaptiveReview } : {}) });

describe("supplemental investigation accounting", () => {
  it("keeps known zero work distinct from legacy unrecorded outcomes", () => {
    expect(summarizeAdaptiveReviews([result()])).toBeUndefined();
    expect(summarizeAdaptiveReviews([result({ outcome: "not_triggered", attempts: 0 })])?.counts)
      .toMatchObject({ scheduled: 0, completed: 0, failed: 0 });
  });

  it("counts each pass once, retaining terminal outcomes, review status and retry attempts", () => {
    const outcomes: AdaptiveReviewOutcome[] = [
      { outcome: "completed", reviewStatus: "completed", attempts: 2 },
      { outcome: "completed", reviewStatus: "incomplete", attempts: 1 },
      { outcome: "failed", errorCode: "llm_schema_invalid", attempts: 2 },
      { outcome: "timed_out", attempts: 1 }, { outcome: "cancelled", attempts: 0 },
      { outcome: "not_dispatched", attempts: 0 }, { outcome: "capped", attempts: 0 }
    ];
    const summary = summarizeAdaptiveReviews(outcomes.map(result))!;
    expect(summary.counts).toEqual({ triggered: 7, scheduled: 6, completed: 1, incomplete: 1, failed: 1,
      timedOut: 1, cancelled: 1, notDispatched: 1, capped: 1, retries: 2 });
    expect(summary.passes).toEqual(outcomes.map(outcome => ({ packetId: "p", ...outcome })));
  });

  it("does not describe a failed attempt followed by a blocked retry as wholly undispatched", () => {
    const summary = summarizeAdaptiveReviews([result({ outcome: "not_dispatched", attempts: 1, errorCode: "llm_schema_invalid" })])!;
    expect(summary.counts).toMatchObject({ scheduled: 1, failed: 1, notDispatched: 0, retries: 0 });
    expect(summary.passes[0]).toMatchObject({ outcome: "not_dispatched", attempts: 1, errorCode: "llm_schema_invalid" });
  });

  it("exports the same counts in eval metrics without changing completeness or inventing legacy success", () => {
    const artifacts: EvalArtifacts = { candidates: [], verification: [], finalSelection: [], finalFindings: [], packets: [], hintEvents: [], metricsSources: {},
      coverage: { totalHunks: 1, reviewedHunks: 1, skippedHunks: 0, failedHunks: 0, coverageByLevel: { normal: 1, deep: 0, light: 0, skip: 0 },
        degradedPlanning: false, budgetStopped: false, verificationIncompleteCount: 0, partial: false, reasons: [] } };
    const evalCase = { name: "supplemental", artifacts: { path: "unused" } };
    expect(scoreEvalRun(evalCase, artifacts, "replay").metrics.adaptiveReviews).toBeUndefined();
    const summary = summarizeAdaptiveReviews([result({ outcome: "timed_out", attempts: 1 })])!;
    artifacts.coverage!.adaptiveReviews = summary;
    const metrics = scoreEvalRun(evalCase, artifacts, "replay").metrics;
    expect(metrics.adaptiveReviews).toEqual(summary.counts);
    expect(metrics.reviewCompleteness).toBe("complete");
  });
});
