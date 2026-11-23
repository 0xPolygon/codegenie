import { describe, expect, it, vi } from "vitest";
import { suppressRefutedPromotedHints } from "../src/pipeline/human-attention.js";
import type { CandidateFinding, PacketReviewResult, VerificationVerdict } from "../src/types.js";
import type { TelemetryRecorder } from "../src/telemetry/telemetry-recorder.js";

const question = "Does quantNone have the zero value? LoadWeights now leaves weightLoadOpts.quant unspecified, whereas its prior call explicitly passed quantNone; a nonzero quantNone would change quantization behavior for this public loader.";
const hint = (text: string) => ({ question: text, files: ["decoder/model.go"], symbols: ["LoadWeights"],
  suggestedLenses: [], reason: "Check the changed default.", confidence: "medium" as const, projectedSkillIds: [] });
const candidate = (id = "candidate"): CandidateFinding => ({
  id, title: "Quantization default", severity: "low", confidence: "medium", path: "decoder/model.go",
  changedLine: false, category: "correctness", evidence: { changedCode: "+ default" },
  failureMode: "Wrong default", whyThisMatters: "Wrong quantization", verification: "Check the default",
  producedBy: { kind: "packet", stage: 9, packetId: "own", lensId: "core/code-review", skillIds: [] }, provenance: { source: "uncertainty_promotion", sourceKind: "follow_up_hint", sourcePacketId: "own",
    question, files: ["decoder/model.go"], symbols: ["LoadWeights"], reason: "Check the changed default.",
    relatedSignals: [{ packetId: "related", sourceKind: "follow_up_hint", question, files: [], symbols: [] }] }
});
const packet = (id: string, questions: string[], findings: CandidateFinding[] = []): PacketReviewResult => ({
  packetId: id, lenses: [], findings, followUpHints: questions.map(hint), uncertainties: [], status: "completed"
});
const verdict = (overrides: Partial<VerificationVerdict> = {}): VerificationVerdict => ({
  candidateId: "candidate", verdict: "reject", reason: "refuted", requiredEvidencePresent: true, falsePositiveRisk: "low",
  proofAssessment: { status: "refuted", evidence: "quantNone is the zero value.", assumptions: [] }, ...overrides
});

describe("refuted promoted attention", () => {
  it("removes own, identical related, and cross-packet copies while keeping different questions", () => {
    const input = [packet("own", [question, "Does another flag stay enabled?"], [candidate()]),
      packet("related", [question, "Does quantNone also affect another caller?"]),
      packet("other", [question.toUpperCase()])];
    const event = vi.fn();
    const output = suppressRefutedPromotedHints(input, [verdict()], { event } as unknown as TelemetryRecorder);
    expect(output.map(p => p.followUpHints.map(h => h.question))).toEqual([["Does another flag stay enabled?"], ["Does quantNone also affect another caller?"], []]);
    expect(input[0]!.followUpHints).toHaveLength(2);
    expect(event.mock.calls.map(([value]) => value.data.kind)).toEqual(["own_source", "related_identical", "other_identical"]);
  });

  it.each([
    { verdict: "incomplete", verificationIncomplete: true },
    { proofAssessment: { status: "unresolved", evidence: "Not established.", assumptions: [] } },
    { proofAssessment: { status: "refuted", evidence: "Some evidence.", assumptions: [{ question: "Does another path exist?", essential: true }] } },
    { unresolvedConcern: { question: "Another path?", files: [], symbols: [], reason: "Open", confidence: "medium", sourcePacketIds: [] } }
  ])("keeps the original question when verification is incomplete or still open: %j", (overrides) => {
    const input = [packet("own", [question], [candidate()])];
    expect(suppressRefutedPromotedHints(input, [verdict(overrides as Partial<VerificationVerdict>)])[0]!.followUpHints).toHaveLength(1);
  });

  it("keeps questions with no verdict or a competing unresolved verdict", () => {
    const second = candidate("other-candidate");
    const input = [packet("own", [question], [candidate(), second])];
    expect(suppressRefutedPromotedHints(input, [])[0]!.followUpHints).toHaveLength(1);
    expect(suppressRefutedPromotedHints(input, [verdict(), verdict({ candidateId: second.id, verdict: "incomplete" })])[0]!.followUpHints).toHaveLength(1);
  });

  it("normalizes formatting but preserves operators in the question identity", () => {
    const first = candidate();
    first.provenance!.question = "Can x <= 0?";
    const input = [packet("own", ["Can `x` <= 0", "Can x >= 0?", "Can x < 0?"], [first])];
    expect(suppressRefutedPromotedHints(input, [verdict()])[0]!.followUpHints.map(h => h.question))
      .toEqual(["Can x >= 0?", "Can x < 0?"]);
    first.provenance!.question = "Can x < 0?";
    expect(suppressRefutedPromotedHints([packet("own", ["Can x <= 0?"], [first])], [verdict()])[0]!.followUpHints).toHaveLength(1);
    first.provenance!.question = "Does café work?";
    expect(suppressRefutedPromotedHints([packet("own", ["Does cafe\u0301 work."], [first])], [verdict()])[0]!.followUpHints).toHaveLength(0);
    first.provenance!.question = 'Does "admin" work?';
    expect(suppressRefutedPromotedHints([packet("own", ["Does admin work?"], [first])], [verdict()])[0]!.followUpHints).toHaveLength(1);
    first.provenance!.question = "Should we preserve `field?`";
    expect(suppressRefutedPromotedHints([packet("own", ["Should we preserve `field`?"], [first])], [verdict()])[0]!.followUpHints).toHaveLength(1);
  });
});
