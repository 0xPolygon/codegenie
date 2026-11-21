import { describe, expect, it } from "vitest";
import { composePresentation, compositionSources, eligibleCompositionSource, renderCompositionSections, renderRetainedComposition, validateCompositionSubmission, type CompositionSection } from "../src/pipeline/composition-content.js";
import type { CandidateFinding } from "../src/types.js";

// Minimal sanitized run-79 rounding/zero/caller chain plus the independently
// actionable testing issue observed in comparison reports 67/68.
function finding(id: string): CandidateFinding {
  return { id, title: "Scaling can under-deliver", severity: "medium", confidence: "medium", path: "amount.go", category: "correctness", changedLine: true,
    producedBy: { packetId: "packet", lensId: "core/code-review", kind: "packet", stage: 7, skillIds: ["core/code-review"] },
    failureMode: "Integer division truncates before destination scaling.", whyThisMatters: "The quoted destination amount can exceed the delivered bound.",
    verification: "A zero amount is rejected; nonzero truncation and caller-contract uncertainty remain.",
    suggestedFix: "Round upward for exact output or reject unrepresentable amounts.", suggestedTest: "Exercise non-divisible amounts and zero output.",
    evidence: { changedCode: "amount.Div(amount, factor)", relatedCode: [{ path: "contract.go", lines: "591-602", whyRelevant: "Zero is rejected downstream." }] } };
}
function composed(findings: CandidateFinding[]) {
  const sources = compositionSources(findings);
  const sections = (["impact", "verification", "fix", "test"] as const).map(kind => {
    const eligible = sources.filter(source => eligibleCompositionSource(source, kind));
    return { kind, text: [...new Set(eligible.map(source => source.text))].join("\n"), sourceRefs: eligible.map(source => source.id) };
  }).filter(section => section.sourceRefs.length);
  const used = new Set(sections.flatMap(section => section.sourceRefs));
  return { sections, evidenceRefs: sources.filter(source => source.kind === "evidence").map(source => source.id),
    retainedSourceRefs: sources.filter(source => source.kind !== "evidence" && !used.has(source.id)).map(source => source.id) };
}

describe("attributed composition", () => {
  it("can publish a testing remedy once while retaining the duplicate fix and every source", () => {
    const item = finding("testing");
    item.category = "testing";
    item.suggestedFix = item.suggestedTest = "Assert that a revoked session cannot read the document.";
    const assessment = { status: "supported" as const, suggestionText: item.suggestedTest, rationale: "Tests the required access boundary.",
      contractCheck: { status: "established" as const, requirement: "Revoked sessions cannot read documents." },
      evidence: [{ path: "contract.go", lines: "deny revoked sessions", whyRelevant: "Established requirement." }] };
    item.suggestionAssessments = { suggestedFix: assessment, suggestedTest: assessment };
    const proposal = composed([item]);
    const fix = proposal.sections.find(section => section.kind === "fix")!;
    proposal.sections = proposal.sections.filter(section => section.kind !== "fix");
    proposal.retainedSourceRefs.push(...fix.sourceRefs);
    const { body, metrics } = composePresentation([item], proposal.sections, proposal.evidenceRefs, undefined, proposal);
    expect(body.split(item.suggestedTest)).toHaveLength(2);
    expect(body).not.toContain("remains unverified");
    expect(metrics.retainedSuggestionSources).toEqual(["testing/suggestedFix"]);
    expect(body).not.toContain("<details>");
  });

  it("renders the rounding chain once, retaining zero rejection and contract uncertainty", () => {
    const findings = Array.from({ length: 5 }, (_, index) => finding(`f${index}`));
    const proposal = composed(findings);
    const body = renderCompositionSections(findings, proposal.sections, proposal.evidenceRefs, undefined, proposal);
    for (const text of [findings[0]!.failureMode, findings[0]!.verification, "amount.Div(amount, factor)"]) expect(body.split(text)).toHaveLength(2);
    for (const field of ["suggestedFix", "suggestedTest"] as const) {
      expect(body).not.toContain(findings[0]![field]);
    }
    expect(body).not.toContain("591-602");
    expect(body.match(/\*\*Impact:/g)).toHaveLength(1);
  });

  it("rejects the run-87 nonexistent optional source before accepting composition", () => {
    const input = finding("db6512fa-a2f1");
    delete input.suggestedTest;
    const proposal = composed([input]);
    proposal.sections = proposal.sections.filter(section => section.sourceRefs.length);
    proposal.sections.push({ kind: "test", text: "Invented test attribution", sourceRefs: ["db6512fa-a2f1/suggestedTest"] });
    const omitted = proposal.evidenceRefs.pop()!;
    let diagnostic = "";
    try { validateCompositionSubmission({ composedFindings: [{ findingIds: [input.id], ...proposal }] }, [input]); } catch (error) { diagnostic = String(error); }
    expect(diagnostic).toContain("absent optional fields");
    // The invented ID is model text: it is located by path, not echoed (#96).
    expect(diagnostic).toContain(`"path":"composedFindings.0.sections.${proposal.sections.length - 1}.sourceRefs.0"`);
    expect(diagnostic).toContain("unknown_source");
    expect(diagnostic).not.toContain("db6512fa-a2f1/suggestedTest");
    expect(diagnostic).toContain(omitted);
    proposal.evidenceRefs.push(omitted);
    proposal.sections.pop();
    expect(() => validateCompositionSubmission({ composedFindings: [{ findingIds: [input.id], ...proposal }] }, [input])).not.toThrow();
    expect(() => validateCompositionSubmission({ composedFindings: [] }, [input])).toThrow(/omitted findings/);
    expect(() => validateCompositionSubmission({ composedFindings: [
      { findingIds: [input.id], ...proposal }, { findingIds: [input.id], ...proposal }
    ] }, [input])).toThrow(/repeated finding/);
  });

  it("publishes the lead and alternate legacy verification when synthesis is unavailable", () => {
    const first = finding("first");
    const second = finding("second");
    first.verification = "No cross-decimal tests were found in the inspected excerpt.";
    second.verification = "The full source has cross-decimal tests, but only divisible amounts.";
    second.failureMode = "Additional condition: the requested amount has a remainder.";
    second.evidence.relatedCode![0]!.whyRelevant = "A different explanation of the same source location.";
    const body = renderRetainedComposition([first, second]);
    expect(body.match(/\*\*Impact:/g)).toHaveLength(1);
    expect(body).toContain(first.verification);
    expect(body).toContain("**Recorded verification:**\n\n" + second.verification);
    expect(body).toContain("synthesis was unavailable");
    expect(body).not.toContain("<details>");
  });

  it("shows a legacy verification once when fallback appends proof status to the section", () => {
    const lead = finding("lead");
    lead.verification = "The arithmetic truncates.\n\nThe original bound still applies.";
    const structured = finding("structured");
    structured.proofAssessment = {
      status: "established",
      evidence: "The conversion is rounded down.",
      assumptions: [{ question: "Can callers pass a fractional amount?", essential: false }]
    };
    const alternate = finding("alternate");
    alternate.verification = "Only the callers with an exact-output contract are affected.";

    const body = renderRetainedComposition([lead, structured, alternate]);
    expect(body).toContain("Retained proof status (not synthesized): established.");
    expect(body.split(lead.verification)).toHaveLength(2);
    expect(body).toContain("**Recorded verification:**\n\n" + alternate.verification);
  });

  it("rejects omitted, invented, duplicate, and wrong-kind source references", () => {
    const findings = [finding("one")];
    const { sections, evidenceRefs } = composed(findings);
    expect(() => renderCompositionSections(findings, sections.slice(1), evidenceRefs)).toThrow(/missing_source/);
    expect(() => renderCompositionSections(findings, sections, [...evidenceRefs, "invented"])).toThrow(/unknown_source|wrong_section/);
    expect(() => renderCompositionSections(findings, sections, [...evidenceRefs, evidenceRefs[0]!])).toThrow(/duplicate/);
    expect(() => renderCompositionSections(findings, [{ ...sections[0]!, kind: "test" }, ...sections.slice(1)] as CompositionSection[], evidenceRefs)).toThrow(/unknown_source|wrong_section/);
  });

  it("preserves proof and caveats even if composed verification text erases them", () => {
    const legacy = finding("legacy");
    const structured = finding("structured");
    structured.verification = "The function-level difference is established.";
    structured.proofAssessment = {
      status: "established",
      evidence: structured.verification,
      assumptions: [{ question: "Do production callers provide this input?", essential: false }]
    };
    const findings = [legacy, structured];
    const proposal = composed(findings);
    proposal.sections.find(section => section.kind === "verification")!.text = "Always proven.";

    const body = renderCompositionSections(findings, proposal.sections, proposal.evidenceRefs, undefined, proposal);
    expect(body).toContain("**Open conditions:**");
    expect(body).toContain("Secondary assumption: Do production callers provide this input?");
    expect(body).toContain(legacy.verification);
    expect(body).not.toContain("Original assessments and supporting evidence");
  });

  it("renders the selected evidence branches and the distinct testing impact", () => {
    const first = finding("rounding");
    const second = finding("testing");
    second.category = "testing";
    second.failureMode = "The changed assertion never exercises truncation.";
    second.suggestedTest = "Assert an exact-output bound across decimal pairs.";
    second.evidence.changedCode = "assert.Equal(want, actual)";
    second.evidence.relatedCode![0]!.whyRelevant = "The new test must account for zero rejection.";
    const proposal = composed([first, second]);
    const primaryEvidenceRefs = ["rounding/evidence/changedCode", "testing/evidence/changedCode", "testing/evidence/relatedCode/0"];
    const body = renderCompositionSections([first, second], proposal.sections, proposal.evidenceRefs, undefined, { ...proposal, primaryEvidenceRefs });
    expect(body).toContain(first.evidence.changedCode);
    expect(body).toContain(second.evidence.changedCode);
    expect(body).toContain(second.failureMode);
    expect(body).not.toContain(second.suggestedTest);
    expect(body).not.toContain(first.evidence.relatedCode![0]!.whyRelevant);
    expect(body).toContain(second.evidence.relatedCode![0]!.whyRelevant);
  });
});
