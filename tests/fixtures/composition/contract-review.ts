import { compositionSources, type CompositionSection, type CompositionPresentation } from "../../../src/pipeline/composition-content.js";
import type { CandidateFinding } from "../../../src/types.js";

// Sanitized run-91 failure: an internally consistent reduced quote still
// violates the caller's required EXACT_OUTPUT minimum. No private paths needed.
export function contractReview(): CandidateFinding[] {
  const original: CandidateFinding = {
    id: "rounding", title: "Exact output can under-deliver", severity: "high", confidence: "high",
    path: "provider.go", category: "correctness", changedLine: true,
    producedBy: { packetId: "packet", lensId: "core/code-review", kind: "packet", stage: 7, skillIds: [] },
    failureMode: "Division rounds the transfer down for a non-divisible request.",
    whyThisMatters: "The delivered amount can be below the caller's required minimum.",
    verification: "No cross-decimal tests were found in the inspected excerpt.",
    suggestedFix: "Lower the advertised output to the rounded transfer.",
    suggestedTest: "Assert that the advertised output decreases after rounding.",
    proofAssessment: { status: "established", evidence: "Integer division loses the remainder before scaling back.", assumptions: [{ question: "The size of the loss depends on the decimal pair.", essential: false }] },
    evidence: { changedCode: "transfer = requested / factor", relatedCode: [
      { path: "caller.go", lines: "10-12", whyRelevant: "if quote.Minimum < requested { return ErrInsufficientOutput }" },
      { path: "provider_test.go", lines: "20-30", whyRelevant: "Existing cross-decimal cases use divisible amounts." }
    ] }
  };
  original.suggestionAssessments = Object.fromEntries((["suggestedFix", "suggestedTest"] as const).map(field => [field, {
    status: "incompatible", suggestionText: original[field]!, rationale: "EXACT_OUTPUT requires the original requested minimum, not a lower internally consistent quote.",
    evidence: [{ path: "caller.go", lines: "10-12", whyRelevant: "Rejects output below the requested amount." }]
  }]));
  const corrected: CandidateFinding = {
    ...original, id: "boundary-tests", category: "testing", title: "Test the non-divisible boundary",
    verification: "Cross-decimal tests exist, but they cover divisible amounts and miss the truncation boundary.",
    failureMode: "The changed assertion does not test a nonzero remainder.",
    suggestedFix: "Round the required source transfer upward to meet the requested minimum.",
    suggestedTest: "Use a non-divisible request and assert delivery meets the original requested minimum."
  };
  corrected.suggestionAssessments = { suggestedFix: {
    contractCheck: { status: "established", requirement: "Delivery must meet the original requested minimum." },
    status: "supported", suggestionText: corrected.suggestedFix!, rationale: "Ceiling conversion preserves the caller's minimum.",
    evidence: [{ path: "caller.go", lines: "10-12", whyRelevant: "Original requested minimum is required." }]
  } }; // Test support remains independently unverified.
  return [original, corrected];
}

export function contractComposition() {
  const findings = contractReview();
  const sources = compositionSources(findings);
  const sections: CompositionSection[] = [
    { kind: "impact", text: findings[0]!.failureMode + " " + findings[0]!.whyThisMatters, sourceRefs: sources.filter(s => s.kind === "impact").map(s => s.id) },
    { kind: "verification", text: findings[1]!.verification + " The size of the loss depends on the decimal pair.", sourceRefs: ["boundary-tests/verification", "rounding/proofAssessment", "boundary-tests/proofAssessment"] },
    { kind: "fix", text: findings[1]!.suggestedFix!, sourceRefs: ["boundary-tests/suggestedFix"] }
  ];
  const used = new Set(sections.flatMap(s => s.sourceRefs));
  const evidenceRefs = sources.filter(s => s.kind === "evidence").map(s => s.id);
  const presentation: CompositionPresentation = {
    retainedSourceRefs: sources.filter(s => !used.has(s.id) && s.kind !== "evidence").map(s => s.id),
    primaryEvidenceRefs: ["rounding/evidence/relatedCode/0"],
    reconciliations: [{ sourceRefs: ["rounding/verification"], supportingRefs: ["boundary-tests/verification", "rounding/evidence/relatedCode/1"], disposition: "superseded", rationale: "The full test source corrects the earlier excerpt-based coverage claim." }]
  };
  return { findings, sections, evidenceRefs, presentation };
}
