import { describe, expect, it } from "vitest";
import { validateToolCall } from "./helpers/pi-validation.js";
import { SuggestionAssessmentSchema } from "../src/llm/schemas.js";
import { composePresentation, compositionSources, renderRetainedComposition, validateCompositionSubmission } from "../src/pipeline/composition-content.js";
import { assessFinalSuggestions } from "../src/pipeline/suggestion-assessment.js";
import { contractComposition } from "./fixtures/composition/contract-review.js";
import { authorizationComposition } from "./fixtures/composition/authorization-review.js";

describe("report synthesis and requirement support", () => {
  it.each([
    { wrong: "The access guard accepts a revoked membership.",
      correct: "The guard rejects revoked membership; the defect is the read path bypassing that guard.",
      code: "if (!membership.active) throw Forbidden();" },
    { wrong: "Separate reported-size and stored-size equalities cannot both pass when stored content is shorter.",
      correct: "Both equalities can pass independently; they do not assert that the stored size covers the reported size.",
      code: "expect(reportedSize).toBe(requestedSize); expect(storedSize).toBe(expectedStoredSize);" }
  ])("retains original contradictory explanations while publishing the supplied evidence-backed correction: $wrong", example => {
    // Scripted synthesis tests attribution/preservation, not automatic semantic judgment.
    const fixture = authorizationComposition();
    const first = fixture.findings[0]!;
    first.verification = example.wrong;
    const corrected = { ...structuredClone(first), id: "corrected", verification: example.correct };
    corrected.evidence.relatedCode = [{ path: "policy.test.ts", lines: example.code, whyRelevant: example.correct }];
    const findings = [first, corrected];
    const sources = compositionSources(findings);
    const sections = fixture.sections.map(section => ({ ...section,
      text: section.kind === "verification" ? example.correct : section.text,
      sourceRefs: sources.filter(source => source.kind === section.kind && source.id !== "authorization/verification").map(source => source.id)
    }));
    const { body } = composePresentation(findings, sections, sources.filter(source => source.kind === "evidence").map(source => source.id), undefined, {
      retainedSourceRefs: ["authorization/verification"], reconciliations: [{ sourceRefs: ["authorization/verification"],
        supportingRefs: ["corrected/evidence/relatedCode/0"], disposition: "superseded", rationale: example.correct }]
    });
    const primary = body.split("\n\n<details>")[0]!;
    expect(primary).toContain(example.correct);
    expect(primary).not.toContain(example.wrong);
    expect(body).toContain(example.wrong);
    expect(body).toContain(example.code);
  });

  it("projects six retained proofs to distinct conditions without losing their narratives", () => {
    const seed = authorizationComposition().findings[0]!;
    const findings = Array.from({ length: 6 }, (_, index) => ({ ...structuredClone(seed), id: `auth-${index}`,
      proofAssessment: { status: index === 5 ? "unresolved" as const : "established" as const, evidence: `Proof ${index}: ` + "Detailed inspected authorization evidence. ".repeat(40),
        assumptions: [{ question: "Is this endpoint deployed?", essential: true },
          { question: "How long is cached membership retained?", essential: false },
          { question: `Does client ${index} refresh its session?`, essential: false }] }
    }));
    let accounted = 0;
    const body = renderRetainedComposition(findings, undefined, text => text, metrics => { accounted = metrics.accountedSourceComponents; });
    const primary = body.split("\n\n<details>")[0]!;
    expect(primary.split("Is this endpoint deployed?")).toHaveLength(2);
    expect(primary.split("How long is cached membership retained?")).toHaveLength(2);
    for (const finding of findings) {
      expect(body).toContain(finding.proofAssessment.evidence);
      expect(body).toContain(finding.id + "/proofAssessment");
      expect(primary).toContain(finding.proofAssessment.assumptions[2]!.question);
    }
    expect(primary).not.toContain(findings[0]!.proofAssessment.evidence);
    expect(primary).toContain(findings[5]!.proofAssessment.evidence);
    expect(primary.split(findings[5]!.proofAssessment.evidence)).toHaveLength(2);
    expect(accounted).toBe(compositionSources(findings).length);
    expect(primary.split(/\s+/).length).toBeLessThan(body.split(/\s+/).length / 2);
  });

  it("can withhold a supported but disputed remedy without losing its source or changing its assessment", () => {
    const { findings, sections, evidenceRefs } = authorizationComposition();
    const finding = findings[0]!;
    finding.suggestedFix = "Return no documents to any principal.";
    finding.suggestionAssessments!.suggestedFix = { ...finding.suggestionAssessments!.suggestedFix!, suggestionText: finding.suggestedFix,
      rationale: "No document can leak if every request returns nothing." };
    const retainedSourceRefs = sections.filter(section => section.kind === "fix").flatMap(section => section.sourceRefs);
    const finished = sections.filter(section => section.kind !== "fix");
    finished.find(section => section.kind === "verification")!.text += " The proposed blanket denial does not establish that active members retain required read access; remedy compatibility remains unresolved.";
    const { body } = composePresentation(findings, finished, evidenceRefs, undefined, { retainedSourceRefs });
    expect(body.split("\n\n<details>")[0]).not.toContain("**Suggested fix:**");
    expect(body).toContain(finding.suggestedFix);
    expect(finding.suggestionAssessments!.suggestedFix!.status).toBe("supported");
    const canRead = (active: boolean) => active;
    const denyAll = (_active: boolean) => false;
    // A denial-only test passes a remedy which removes required successful behavior.
    expect(denyAll(false)).toBe(false);
    expect([denyAll(true), denyAll(false)]).not.toEqual([true, false]);
    expect([canRead(true), canRead(false)]).toEqual([true, false]);
  });
  it.each([contractComposition, authorizationComposition])("keeps supplied synthesis concise without deleting original secondary questions", fixture => {
    const { findings, sections, evidenceRefs, presentation } = fixture();
    const { body, metrics } = composePresentation(findings, sections, evidenceRefs, undefined, presentation);
    const primary = body.split("\n\n<details>")[0]!;
    expect(primary).toContain(sections.find(section => section.kind === "verification")!.text);
    expect(primary).not.toContain("**Open conditions:**");
    for (const finding of findings) for (const assumption of finding.proofAssessment!.assumptions) expect(body).toContain(assumption.question);
    expect(metrics.uncertaintyWords).toBe(0);
    expect(metrics.evidenceWords).toBeGreaterThan(0);
    expect(metrics.accountedSourceComponents).toBe(compositionSources(findings).length);
    // Suggestions are retained once per source, not repeated in assessment JSON.
    expect(body).not.toContain('"suggestionText":');
    expect(body).not.toContain('"assumptions":');
  });

  it("requires unresolved secondary sources in visible verification and supported supersession", () => {
    const { findings, sections, evidenceRefs } = authorizationComposition();
    sections[1]!.sourceRefs = ["authorization/verification"];
    const presentation = { retainedSourceRefs: ["authorization/proofAssessment"] };
    expect(() => composePresentation(findings, sections, evidenceRefs, undefined, presentation)).toThrow(/visible verification/);
    expect(() => composePresentation(findings, sections, evidenceRefs, undefined, { ...presentation, reconciliations: [{
      sourceRefs: ["authorization/proofAssessment"], supportingRefs: ["authorization/evidence/relatedCode/0"],
      disposition: "superseded", rationale: "Supplied policy evidence settles the secondary question."
    }] })).not.toThrow();
    expect(() => composePresentation(findings, sections, evidenceRefs, undefined, { ...presentation, reconciliations: [{
      sourceRefs: ["authorization/proofAssessment"], supportingRefs: [], disposition: "unresolved", rationale: "Still open."
    }] })).toThrow(/visible verification/);
  });

  it.each([true, false])("fallback attributes unsynthesized conditions without inventing disagreement, anchor: %s", anchored => {
    const { findings } = authorizationComposition();
    if (anchored) findings[0]!.anchor = { path: "documents.ts", line: 2, side: "RIGHT", hunkId: "h" };
    const second = structuredClone(findings[0]!);
    second.id = "second";
    second.proofAssessment!.assumptions = [{ question: "Does the audit logger retain the revoked principal?", essential: false }];
    const body = renderRetainedComposition([...findings, second]);
    const primary = body.split("\n\n<details>")[0]!;
    expect(primary).toContain("synthesis was unavailable");
    expect(primary).toContain("How long is a cached membership retained?");
    expect(primary).toContain("Does the audit logger retain the revoked principal?");
    expect(primary).not.toContain("Original verification assessments differ");
    expect(body).toContain("second/proofAssessment");
    expect(renderRetainedComposition(findings)).not.toContain("Original verification assessments differ");
  });

  it.each([undefined, { status: "unresolved", requirement: "Active membership is required." },
    { status: "established", requirement: "   " }] as const)("downgrades missing/unresolved/blank checks locally: %j", check => {
    const finding = authorizationComposition().findings[0]!;
    const assessment = finding.suggestionAssessments!.suggestedFix!;
    delete assessment.contractCheck;
    if (check) assessment.contractCheck = check;
    expect(() => validateToolCall([{ name: "assess", description: "", parameters: SuggestionAssessmentSchema }],
      { type: "toolCall", id: "test", name: "assess", arguments: assessment })).not.toThrow();
    expect(assessFinalSuggestions(finding, finding.suggestionAssessments)).toMatchObject({
      suggestedFix: { status: "unverified" }, suggestedTest: { status: "supported" }
    });
  });

  it("requires complete evidence and keeps malformed optional types strict", () => {
    const finding = authorizationComposition().findings[0]!;
    const assessment = finding.suggestionAssessments!.suggestedFix!;
    assessment.evidence = [{ path: "", lines: " ", whyRelevant: "" }];
    expect(() => validateToolCall([{ name: "assess", description: "", parameters: SuggestionAssessmentSchema }],
      { type: "toolCall", id: "blank", name: "assess", arguments: assessment })).not.toThrow();
    expect(assessFinalSuggestions(finding, finding.suggestionAssessments).suggestedFix!.status).toBe("unverified");
    expect(() => validateToolCall([{ name: "assess", description: "", parameters: SuggestionAssessmentSchema }],
      { type: "toolCall", id: "test", name: "assess", arguments: { ...assessment, contractCheck: { status: "established", requirement: { invalid: true } } } })).toThrow();
  });

  it("cannot endorse identical proposals by selecting only a favorable assessment", () => {
    const { findings } = authorizationComposition();
    const conflicting = structuredClone(findings[0]!);
    conflicting.id = "conflicting";
    conflicting.suggestionAssessments!.suggestedFix!.status = "incompatible";
    conflicting.suggestionAssessments!.suggestedFix!.rationale = "This branch requires a separate capability, not membership.";
    const sources = compositionSources([...findings, conflicting]);
    expect(sources.find(source => source.id === "authorization/suggestedFix")!.suggestionAssessment!.status).toBe("unverified");
    expect(sources.find(source => source.id === "conflicting/suggestedFix")!.suggestionAssessment!.status).toBe("incompatible");
    const body = renderRetainedComposition([...findings, conflicting]);
    expect(body).toContain("**Submitted assessment status:** supported");
    const primary = body.split("\n\n<details>")[0]!;
    expect(primary).toContain("Remediation remains unverified");
    expect(primary).not.toContain(findings[0]!.suggestedFix);
    expect(primary).toContain("Compatibility assessments conflict");
    delete conflicting.suggestionAssessments!.suggestedFix;
    expect(compositionSources([...findings, conflicting]).find(source => source.id === "authorization/suggestedFix")!.suggestionAssessment!.status).toBe("supported");
  });

  it("permits consolidation across clusters but retains independent contracts and testing defects", () => {
    const first = contractComposition();
    const auth = authorizationComposition();
    const merged = { findingIds: first.findings.map(f => f.id), sections: first.sections, evidenceRefs: first.evidenceRefs, ...first.presentation };
    const separate = { findingIds: auth.findings.map(f => f.id), sections: auth.sections, evidenceRefs: auth.evidenceRefs };
    expect(() => validateCompositionSubmission({ composedFindings: [merged, separate] }, [...first.findings, ...auth.findings])).not.toThrow();
    // Same file/helper is not an identity rule: an independent policy stays accounted.
    auth.findings[0]!.path = first.findings[0]!.path;
    expect(() => validateCompositionSubmission({ composedFindings: [merged, separate] }, [...first.findings, ...auth.findings])).not.toThrow();
    expect(() => validateCompositionSubmission({ composedFindings: [merged] }, [...first.findings, ...auth.findings])).toThrow(/omitted findings/);
  });

  it("checks observable requirements without excluding valid alternative implementations", () => {
    // Handcrafted behavioral oracles, not production numeric policy or model scores.
    const requested = 17;
    const factor = 10;
    const floor = Math.floor(requested / factor) * factor;
    const ceiling = Math.ceil(requested / factor) * factor;
    expect(requested % factor).not.toBe(0);
    expect(floor).toBeGreaterThan(0); // The fixture reaches successful delivery, not a zero guard.
    const satisfiesRequest = (delivered: number, promised: number) => delivered >= promised && promised >= requested;
    expect(satisfiesRequest(floor, floor)).toBe(false);
    expect(satisfiesRequest(ceiling, requested)).toBe(true);
    expect(ceiling === requested).toBe(false); // An equality-only test would reject this valid remedy.
    expect((20 % factor)).toBe(0); // A divisible input misses the remainder boundary.
    expect(Math.floor(7 / factor)).toBe(0); // A zero-guard case misses successful underdelivery.

    // Authorization requires denial after revocation, not one particular denial transport.
    const outcomes = [{ status: 403, disclosed: false }, { status: 404, disclosed: false }];
    expect(outcomes.every(result => !result.disclosed)).toBe(true);
    expect(outcomes.every(result => result.status === 403)).toBe(false);
    expect(!({ status: 200, disclosed: true }).disclosed).toBe(false);
  });

  it("demonstrates that an internally consistent wrong fix fails the original requirement", () => {
    const requested = 17;
    const wrongFix = { delivered: 10, minimum: 10 };
    const weakAssertion = (quote: typeof wrongFix) => quote.minimum <= quote.delivered;
    const contractAssertion = (quote: typeof wrongFix) => weakAssertion(quote) && quote.minimum >= requested;
    expect(weakAssertion(wrongFix)).toBe(true);
    expect(contractAssertion(wrongFix)).toBe(false);
    expect(contractAssertion({ delivered: 20, minimum: requested })).toBe(true);
    // Authorization counterpart: matching two local booleans does not test denial.
    const wronglyAllowed = { cachedMember: true, allowed: true };
    expect(wronglyAllowed.allowed === wronglyAllowed.cachedMember).toBe(true);
    expect(wronglyAllowed.allowed === false).toBe(false);
  });
});
