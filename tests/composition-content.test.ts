import { describe, expect, it } from "vitest";
import { compositionSources, renderCompositionSections, type CompositionSection } from "../src/pipeline/composition-content.js";
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
    const body = renderCompositionSections(findings, proposal.sections, proposal.evidenceRefs);
    for (const text of [findings[0]!.failureMode, findings[0]!.suggestedFix!, findings[0]!.suggestedTest!, findings[0]!.verification, "amount.Div(amount, factor)"]) expect(body.split(text)).toHaveLength(2);
    expect(body).toContain("Lines 591-602");
    expect(body).not.toContain("```go\n591-602");
    expect(body).toContain("Zero is rejected downstream.");
    expect(body.match(/\*\*Impact:/g)).toHaveLength(1);
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
