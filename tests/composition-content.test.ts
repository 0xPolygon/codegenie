import { describe, expect, it } from "vitest";
import { compositionSources, renderCompositionSections, renderRetainedComposition, validateCompositionSubmission, type CompositionSection } from "../src/pipeline/composition-content.js";
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
  return { sections: (["impact", "verification", "fix", "test"] as const).map(kind => ({ kind, text: sources.filter(source => source.kind === kind).map(source => source.text).filter((text, index, all) => all.indexOf(text) === index).join("\n"), sourceRefs: sources.filter(source => source.kind === kind).map(source => source.id) })),
    evidenceRefs: sources.filter(source => source.kind === "evidence").map(source => source.id) };
}

describe("attributed composition", () => {
  it("renders the rounding chain once, retaining zero rejection and contract uncertainty", () => {
    const findings = Array.from({ length: 5 }, (_, index) => finding(`f${index}`));
    const proposal = composed(findings);
    const full = renderCompositionSections(findings, proposal.sections, proposal.evidenceRefs);
    const body = full.split("\n\n<details>")[0]!;
    for (const text of [findings[0]!.failureMode, findings[0]!.suggestedFix!, findings[0]!.suggestedTest!, findings[0]!.verification, "amount.Div(amount, factor)"]) expect(body.split(text)).toHaveLength(2);
    expect(full).toContain("591-602");
    expect(body).not.toContain("```go\n591-602");
    expect(full).toContain("Zero is rejected downstream.");
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
    expect(diagnostic).toContain("db6512fa-a2f1/suggestedTest");
    expect(diagnostic).toContain(omitted);
    proposal.evidenceRefs.push(omitted);
    proposal.sections.pop();
    expect(() => validateCompositionSubmission({ composedFindings: [{ findingIds: [input.id], ...proposal }] }, [input])).not.toThrow();
    expect(() => validateCompositionSubmission({ composedFindings: [] }, [input])).toThrow(/omitted findings/);
    expect(() => validateCompositionSubmission({ composedFindings: [
      { findingIds: [input.id], ...proposal }, { findingIds: [input.id], ...proposal }
    ] }, [input])).toThrow(/repeated finding/);
  });

  it("organizes retained disagreements and evidence without deleting contributions", () => {
    const first = finding("first");
    const second = finding("second");
    first.verification = "No cross-decimal tests were found in the inspected excerpt.";
    second.verification = "The full source has cross-decimal tests, but only divisible amounts.";
    second.failureMode = "Additional condition: the requested amount has a remainder.";
    second.evidence.relatedCode![0]!.whyRelevant = "A different explanation of the same source location.";
    const body = renderRetainedComposition([first, second]);
    expect(body.match(/\*\*Impact:/g)).toHaveLength(1);
    expect(body).toContain("591-602");
    for (const text of [first.verification, second.verification, second.failureMode, second.evidence.relatedCode![0]!.whyRelevant]) expect(body).toContain(text);
    expect(body).toContain("<details>");
    expect(body).toContain("may overlap or disagree");
  });

  it("rejects omitted, invented, duplicate, and wrong-kind source references", () => {
    const findings = [finding("one")];
    const { sections, evidenceRefs } = composed(findings);
    expect(() => renderCompositionSections(findings, sections.slice(1), evidenceRefs)).toThrow(/omitted/);
    expect(() => renderCompositionSections(findings, sections, [...evidenceRefs, "invented"])).toThrow(/Invalid/);
    expect(() => renderCompositionSections(findings, sections, [...evidenceRefs, evidenceRefs[0]!])).toThrow(/duplicate/);
    expect(() => renderCompositionSections(findings, [{ ...sections[0]!, kind: "test" }, ...sections.slice(1)] as CompositionSection[], evidenceRefs)).toThrow(/Invalid/);
  });

  it("preserves proof and caveats even if composed verification text erases them", () => {
    const findings = [finding("one")];
    const proposal = composed(findings);
    proposal.sections.find(section => section.kind === "verification")!.text = "Always proven.";
    expect(renderCompositionSections(findings, proposal.sections, proposal.evidenceRefs)).toContain(findings[0]!.verification);
  });

  it("preserves distinct evidence branches, explanations, and separate testing obligations", () => {
    const first = finding("rounding");
    const second = finding("testing");
    second.category = "testing";
    second.failureMode = "The changed assertion never exercises truncation.";
    second.suggestedTest = "Assert an exact-output bound across decimal pairs.";
    second.evidence.changedCode = "assert.Equal(want, actual)";
    second.evidence.relatedCode![0]!.whyRelevant = "The new test must account for zero rejection.";
    const proposal = composed([first, second]);
    const body = renderCompositionSections([first, second], proposal.sections, proposal.evidenceRefs);
    expect(body).toContain(first.evidence.changedCode);
    expect(body).toContain(second.evidence.changedCode);
    expect(body).toContain(second.failureMode);
    expect(body).toContain(second.suggestedTest);
    expect(body).toContain(first.evidence.relatedCode![0]!.whyRelevant);
    expect(body).toContain(second.evidence.relatedCode![0]!.whyRelevant);
  });
});
