import { describe, expect, it } from "vitest";
import type { RunCoverageStatus } from "../src/types.js";
import { renderBudgetStopNotice } from "../src/util/coverage-summary.js";

describe("coverage summary", () => {
  it.each([
    [45.5, "45.5"],
    [0.1, "0.1"]
  ])("preserves a configured max time of %s minutes in the budget notice", (minutes, expected) => {
    const notice = renderBudgetStopNotice(runtimeStoppedCoverage(minutes * 60_000));

    expect(notice).toContain(`max time of ${expected} minutes`);
  });
});

function runtimeStoppedCoverage(timeoutMs: number): RunCoverageStatus {
  return {
    totalHunks: 1,
    reviewedHunks: 0,
    skippedHunks: 0,
    failedHunks: 1,
    coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
    degradedPlanning: false,
    budgetStopped: true,
    budgetStop: {
      reason: "runtime_reserved_tail",
      stage: 7,
      elapsedMs: timeoutMs,
      timeoutMs,
      hardTimeoutMs: timeoutMs * 2,
      remainingRuntimeMs: 0,
      reservedTailRuntimeMs: 0,
      modelCalls: 0,
      inFlightModelCalls: 0,
      projectedModelCalls: 0,
      totalTokens: 0,
      inFlightTokens: 0,
      projectedTokens: 0
    },
    verificationIncompleteCount: 0,
    partial: true,
    reasons: []
  };
}
