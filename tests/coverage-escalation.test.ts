import { describe, expect, it } from "vitest";
import { applyCoverageEscalations, coverageEscalationReason } from "../src/pipeline/coverage-escalation.js";
import { isAdaptiveNearMissSignal } from "../src/pipeline/uncertainty-promotion.js";
import type { ReviewPacket, ReviewPlan, TelemetryEvent } from "../src/types.js";
import { nullTelemetry } from "./helpers/git.js";

function packet(id: string, overrides: Record<string, unknown> = {}): ReviewPacket {
  return {
    id,
    path: "workers/balance_test.go",
    coverage: "normal",
    reviewProfile: "standard",
    reviewPriority: "normal",
    lenses: ["core/tests"],
    hunks: [{
      hunkId: "h1",
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 1,
      contentWithLineNumbers: "",
      lines: [
        { kind: "delete", content: "func TestErc20BalanceBoundary(t *testing.T) {", oldLine: 1 },
        { kind: "add", content: "func TestVerify(t *testing.T) {", newLine: 1 }
      ],
      changedNewLineNumbers: [1],
      changedOldLineNumbers: [1]
    }],
    symbolFacts: [{
      path: "workers/balance_test.go",
      hunkId: "h1",
      enclosingSymbol: "erc20BalanceAt",
      changedLines: [1],
      changedLinesSide: "new",
      source: "fallback",
      confidence: "heuristic"
    }],
    ...overrides
  } as unknown as ReviewPacket;
}

const plan: ReviewPlan = {
  diffUnderstanding: { declaredIntent: "", inferredBehavior: "" },
  coverage: []
};

describe("plan 92 layer 2: coverage escalators", () => {
  const orphanedDelta = {
    deletedTestSymbols: [{ name: "TestErc20BalanceBoundary", side: "LEFT", kind: "test", source: "diff" }],
    addedTestSymbols: [],
    deletedHelperSymbols: [],
    addedHelperSymbols: [],
    deletedImports: [],
    addedImports: [],
    deletedProductionRefs: ["erc20BalanceAt"],
    addedProductionRefs: [],
    boundaryIndicators: [],
    summary: "deleted boundary test"
  } as unknown as NonNullable<ReviewPacket["testCoverageDelta"]>;

  it("flags orphaned test-coverage deltas for the deep floor (E1)", () => {
    expect(coverageEscalationReason(orphanedDelta)).toContain("TestErc20BalanceBoundary");
    expect(coverageEscalationReason({ ...orphanedDelta, deletedProductionRefs: [] })).toBeUndefined();
    expect(coverageEscalationReason(undefined)).toBeUndefined();
  });

  it("summarizes packets escalated during packet building without changing them", () => {
    const events: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">> = [];
    const telemetry = {
      ...nullTelemetry(),
      event: (event: Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">) => {
        events.push(event);
      }
    };
    const escalated = packet("packet-orphaned", { coverage: "deep", coverageEscalation: { rule: "test_coverage_delta", reason: "deleted tests" } });
    const plain = packet("packet-plain");

    const results = applyCoverageEscalations([escalated, plain], plan, telemetry);

    expect(results).toEqual([escalated, plain]);
    expect(events).toContainEqual(expect.objectContaining({
      message: "coverage_escalations",
      data: { escalated: 1, rule: "test_coverage_delta" }
    }));
  });
});

describe("plan 92 layer 3: adaptive near-miss trigger (T1)", () => {
  it("accepts a run-50-shaped concrete predicate hint tied to changed scope", () => {
    expect(isAdaptiveNearMissSignal(packet("p"), {
      question: "Can origin token decimals be 0 for a real token in the fee path, causing a wrong zero fallback result?",
      files: ["workers/balance_test.go"],
      symbols: ["erc20BalanceAt"],
      reason: "The changed path divides by decimals without a zero guard."
    })).toBe(true);
  });

  it("rejects vague verify-style hints and off-scope questions", () => {
    expect(isAdaptiveNearMissSignal(packet("p"), {
      question: "Please review the change and confirm it looks good.",
      files: ["workers/balance_test.go"],
      symbols: [],
      reason: "general check"
    })).toBe(false);
    expect(isAdaptiveNearMissSignal(packet("p"), {
      question: "Does the unrelated cache layer handle nil entries incorrectly?",
      files: ["lib/other/cache.go"],
      symbols: ["cacheGet"],
      reason: "unrelated"
    })).toBe(false);
  });
});
