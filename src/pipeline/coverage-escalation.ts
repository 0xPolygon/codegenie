import type { CodegenieConfig, ReviewPacket, ReviewPlan } from "../types.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import { toolBudget } from "./packet-builder.js";
import { scaleToolBudget } from "../util/budget.js";

// Plan 92 layer 2: deterministic structural coverage escalators. The planner's
// deep/normal assignment is a one-draw LLM judgment with measured run-to-run
// variance (the erc20 packet: normal in runs 46-50, deep in 51); these rules
// floor structurally suspicious packets to deep so attention amplification
// (budgets, ensemble passes) stops depending on the planner's mood. Rules are
// codebase-agnostic by policy — structural signals only, never path/keyword
// domain patterns.

const TEST_PATH_PATTERN = /(?:^|\/)(?:__tests__|tests?|spec)(?:\/|$)|(?:\.test|\.spec|_test)\.[^/]+$/iu;

export function applyCoverageEscalations(
  packets: ReviewPacket[],
  plan: ReviewPlan,
  config: CodegenieConfig,
  telemetry: TelemetryRecorder
): ReviewPacket[] {
  let escalatedCount = 0;
  const escalated = packets.map((packet) => {
    if (packet.coverage === "deep") {
      return packet;
    }
    const reason = orphanedTestCoverageDeltaReason(packet);
    if (reason === undefined) {
      return packet;
    }
    escalatedCount += 1;
    telemetry.event({
      stage: 6,
      level: "info",
      message: "coverage_escalated",
      packetId: packet.id,
      file: packet.path,
      data: { rule: "test_coverage_delta", from: packet.coverage, reason }
    });
    return {
      ...packet,
      coverage: "deep" as const,
      coverageEscalation: { rule: "test_coverage_delta" as const, reason },
      toolBudget: scaleToolBudget(toolBudget("deep", config.review.depth, packet.reviewProfile), config.review.budgetBoost)
    };
  });

  // E2 (intent mismatch) ships telemetry-only in v1: a run claimed as a
  // refactor / behavior-preserving whose packets delete production lines is
  // the fable "refactor that isn't" shape, but the packet-level signal is too
  // weak to bind deterministically yet — record candidates for Layer-1 data.
  const intent = plan.intentSignals;
  if (intent !== undefined && (intent.refactorLike || intent.explicitlyBehaviorPreserving)) {
    for (const packet of escalated) {
      if (packet.coverage === "deep" || TEST_PATH_PATTERN.test(packet.path)) {
        continue;
      }
      const deletesProductionLines = packet.hunks.some((hunk) => hunk.lines.some((line) => line.kind === "delete"));
      if (deletesProductionLines) {
        telemetry.event({
          stage: 6,
          level: "debug",
          message: "coverage_escalation_candidate",
          packetId: packet.id,
          file: packet.path,
          data: { rule: "intent_mismatch", coverage: packet.coverage }
        });
      }
    }
  }

  if (escalatedCount > 0) {
    telemetry.event({
      stage: 6,
      level: "info",
      message: "coverage_escalations",
      data: { escalated: escalatedCount, rule: "test_coverage_delta" }
    });
  }
  return escalated;
}

// E1: tests were deleted for production code that still exists — a
// borderline-finding factory in any language (the erc20 shape, structurally).
function orphanedTestCoverageDeltaReason(packet: ReviewPacket): string | undefined {
  const delta = packet.testCoverageDelta;
  if (delta === undefined || delta.deletedTestSymbols.length === 0) {
    return undefined;
  }
  const survivingRefs = delta.deletedProductionRefs.length > 0 || delta.replacementRisk !== undefined;
  if (survivingRefs === false) {
    return undefined;
  }
  return `deleted test symbols (${delta.deletedTestSymbols.slice(0, 3).map((symbol) => symbol.name).join(", ")}) with surviving production references — coverage floor raised to deep`;
}
