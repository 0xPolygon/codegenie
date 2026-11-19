import type { ReviewPacket, ReviewPlan } from "../types.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import { isCoverageEscalationTestPath } from "../util/path-roles.js";

// Plan 92 layer 2: deterministic structural coverage escalators. The planner's
// deep/normal assignment is a one-draw LLM judgment with measured run-to-run
// variance (the erc20 packet: normal in runs 46-50, deep in 51); these rules
// floor structurally suspicious packets to deep so attention amplification
// (budgets, ensemble passes) stops depending on the planner's mood. Rules are
// codebase-agnostic by policy — structural signals only, never path/keyword
// domain patterns.

export function applyCoverageEscalations(
  packets: ReviewPacket[],
  plan: ReviewPlan,
  telemetry: TelemetryRecorder
): ReviewPacket[] {
  // E1 is decided while each packet is built (coverageEscalationReason), so
  // its profile, lenses, context and tool budget follow the deep coverage.
  const escalatedCount = packets.filter((packet) => packet.coverageEscalation !== undefined).length;

  // E2 (intent mismatch) ships telemetry-only in v1: a run claimed as a
  // refactor / behavior-preserving whose packets delete production lines is
  // the fable "refactor that isn't" shape, but the packet-level signal is too
  // weak to bind deterministically yet — record candidates for Layer-1 data.
  const intent = plan.intentSignals;
  if (intent !== undefined && (intent.refactorLike || intent.explicitlyBehaviorPreserving)) {
    for (const packet of packets) {
      if (packet.coverage === "deep" || isCoverageEscalationTestPath(packet.path)) {
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
  return packets;
}

// E1: tests were deleted for production code that still exists — a
// borderline-finding factory in any language (the erc20 shape, structurally).
export function coverageEscalationReason(delta: ReviewPacket["testCoverageDelta"]): string | undefined {
  if (delta === undefined || delta.deletedTestSymbols.length === 0) {
    return undefined;
  }
  const survivingRefs = delta.deletedProductionRefs.length > 0 || delta.replacementRisk !== undefined;
  if (survivingRefs === false) {
    return undefined;
  }
  return `deleted test symbols (${delta.deletedTestSymbols.slice(0, 3).map((symbol) => symbol.name).join(", ")}) with surviving production references — coverage floor raised to deep`;
}
