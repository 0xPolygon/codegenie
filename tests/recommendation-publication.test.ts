import { describe, expect, it } from "vitest";
import { compositionSources, composePresentation, renderRetainedComposition, validateCompositionSubmission, type CompositionMetrics } from "../src/pipeline/composition-content.js";
import { composerSubmissionSchema } from "../src/pipeline/composer.js";
import { createCompositionAttributionRepair, normalizeCompositionReferences } from "../src/pipeline/composition-repair.js";
import { authorizationComposition } from "./fixtures/composition/authorization-review.js";

function fixture() {
  const data = authorizationComposition();
  const group = { findingIds: data.findings.map(f => f.id), sections: data.sections, evidenceRefs: data.evidenceRefs,
    retainedSourceRefs: [] as string[], publication: "inline" };
  return { ...data, group, submission: { summary: "Revoked members can still read documents.", composedFindings: [group] } };
}
function schemaFor(findings: ReturnType<typeof fixture>["findings"]) {
  return composerSubmissionSchema([{ fingerprint: "test", representative: findings[0]!, findings }]);
}

describe("supported recommendation publication", () => {
  it.each(["suggestedFix", "suggestedTest"] as const)("withholds distinct supported %s proposals in fallback regardless of ordering", field => {
    const first = fixture().findings[0]!;
    const second = structuredClone(first);
    second.id = "alternative";
    second[field] = field === "suggestedFix" ? "Revalidate the session's membership when loading a document."
      : "Verify active access, then revoke the session and assert no document is returned.";
    second.suggestionAssessments![field]!.suggestionText = second[field]!;
    const before = structuredClone([first, second]);
    const other = field === "suggestedFix" ? "suggestedTest" : "suggestedFix";
    const label = field === "suggestedFix" ? "Remediation" : "Regression-test guidance";
    for (const findings of [[first, second], [second, first]]) {
      let metrics: CompositionMetrics | undefined;
      const body = renderRetainedComposition(findings, undefined, undefined, value => { metrics = value; });
      const primary = body.split("\n\n<details>")[0]!;
      expect(primary).toContain(label + " remains unreconciled");
      expect(primary).not.toContain(label + " remains unverified");
      expect(primary).not.toContain(first[field]);
      expect(primary).not.toContain(second[field]);
      expect(primary).toContain(first[other]);
      for (const finding of findings) {
        expect(body).toContain(finding[field]);
        expect(body).toContain(finding.suggestionAssessments![field]!.rationale);
      }
      expect(metrics?.publishedSuggestionSources.sort()).toEqual(findings.map(f => f.id + "/" + other).sort());
      expect(metrics?.retainedSuggestionSources.sort()).toEqual(findings.map(f => f.id + "/" + field).sort());
      expect(metrics?.accountedSourceComponents).toBe(compositionSources(findings).length);
    }
    expect([first, second]).toEqual(before);
  });

  it("publishes identical supported proposals once while retaining every originating source", () => {
    const first = fixture().findings[0]!;
    const second = { ...structuredClone(first), id: "duplicate" };
    let metrics: CompositionMetrics | undefined;
    const body = renderRetainedComposition([first, second], undefined, undefined, value => { metrics = value; });
    const primary = body.split("\n\n<details>")[0]!;
    expect(primary).not.toContain("remains unreconciled");
    for (const field of ["suggestedFix", "suggestedTest"] as const) {
      expect(primary.split(first[field]!)).toHaveLength(2);
      expect(metrics?.publishedSuggestionSources).toContain(first.id + "/" + field);
      expect(metrics?.publishedSuggestionSources).toContain(second.id + "/" + field);
    }
    expect(metrics?.accountedSourceComponents).toBe(compositionSources([first, second]).length);
  });

  it.each(["unverified", "incompatible"] as const)("does not let %s or historical alternatives block a single supported proposal", status => {
    const first = fixture().findings[0]!;
    const second = structuredClone(first);
    second.id = "unendorsed";
    second.suggestedFix = "Use a historical session membership.";
    second.suggestionAssessments!.suggestedFix = { ...second.suggestionAssessments!.suggestedFix!, status, suggestionText: second.suggestedFix };
    first.originalSuggestions = { suggestedFix: { ...first.suggestionAssessments!.suggestedFix!, suggestionText: "Invalidate every session." } };
    const body = renderRetainedComposition([first, second]);
    const primary = body.split("\n\n<details>")[0]!;
    expect(primary).toContain(first.suggestedFix);
    expect(primary).not.toContain("remains unreconciled");
    expect(primary).not.toContain(second.suggestedFix);
    expect(primary).not.toContain(first.originalSuggestions.suggestedFix!.suggestionText);
    expect(body).toContain(second.suggestedFix);
    expect(body).toContain(first.originalSuggestions.suggestedFix!.suggestionText);
  });

  it("allows attributed composition to select among distinct supported proposals", () => {
    const { findings, sections } = fixture();
    const second = structuredClone(findings[0]!);
    second.id = "alternative";
    second.suggestedFix = "Revalidate membership when loading a document.";
    second.suggestionAssessments!.suggestedFix!.suggestionText = second.suggestedFix;
    findings.push(second);
    const sources = compositionSources(findings);
    sections.find(section => section.kind === "verification")!.sourceRefs.push(...sources.filter(s => s.findingId === second.id && s.kind === "verification").map(s => s.id));
    const rendered = composePresentation(findings, sections, sources.filter(s => s.kind === "evidence").map(s => s.id), undefined, {
      retainedSourceRefs: sources.filter(s => s.findingId === second.id && s.kind !== "evidence" && s.kind !== "verification").map(s => s.id)
    });
    expect(rendered.body.split("\n\n<details>")[0]).toContain(findings[0]!.suggestedFix);
    expect(rendered.body).not.toContain("remains unreconciled");
    expect(rendered.metrics.accountedSourceComponents).toBe(sources.length);
    // Alternatives in unrelated groups do not compete during fallback.
    expect(renderRetainedComposition([second], undefined, undefined, undefined, findings).split("\n\n<details>")[0]).toContain(second.suggestedFix);
  });

  it.each(["same proposal", "different compound proposal"])("can publish supported advice despite an unverified %s", variation => {
    const { findings, sections } = fixture();
    const alternative = structuredClone(findings[0]!);
    alternative.id = "unverified-alternative";
    if (variation === "different compound proposal") alternative.suggestedFix += " Or allow revoked sessions to finish existing requests.";
    alternative.suggestionAssessments!.suggestedFix = { status: "unverified", suggestionText: alternative.suggestedFix!,
      rationale: "The caller contract has not been inspected for this proposal.", evidence: [] };
    findings.push(alternative);
    const sources = compositionSources(findings);
    sections.find(section => section.kind === "verification")!.sourceRefs.push(alternative.id + "/proofAssessment");
    const retainedSourceRefs = sources.filter(source => source.findingId === alternative.id && source.id !== alternative.id + "/proofAssessment").map(source => source.id);
    const result = composePresentation(findings, sections, sources.filter(source => source.kind === "evidence" && source.findingId !== alternative.id).map(source => source.id), undefined, { retainedSourceRefs });
    expect(result.body.split("\n\n<details>")[0]).toContain(findings[0]!.suggestedFix);
    expect(result.metrics.publishedSuggestionSources).toContain(findings[0]!.id + "/suggestedFix");
    expect(result.metrics.retainedSuggestionSources).toContain(alternative.id + "/suggestedFix");
    expect(result.metrics.accountedSourceComponents).toBe(sources.length);
    // Actual contrary evidence about the same proposal must still block it.
    alternative.suggestedFix = findings[0]!.suggestedFix!;
    alternative.suggestionAssessments!.suggestedFix = { ...alternative.suggestionAssessments!.suggestedFix!,
      suggestionText: alternative.suggestedFix!, status: "incompatible", rationale: "An inspected caller requires a behavior this exact remedy removes." };
    expect(() => composePresentation(findings, sections, [], undefined, { retainedSourceRefs })).toThrow(/unsupported_suggestion/);
  });

  it("retains all unverified proposals without prominently publishing them in synthesis or fallback", () => {
    const { findings, group } = fixture();
    delete findings[0]!.suggestionAssessments;
    group.retainedSourceRefs = group.sections.filter(s => s.kind === "fix" || s.kind === "test").flatMap(s => s.sourceRefs);
    group.sections = group.sections.filter(s => s.kind !== "fix" && s.kind !== "test");
    const composed = composePresentation(findings, group.sections, group.evidenceRefs, undefined, group);
    for (const body of [composed.body, renderRetainedComposition(findings)]) {
      const primary = body.split("\n\n<details>")[0]!;
      expect(primary).toContain(findings[0]!.failureMode);
      for (const field of ["suggestedFix", "suggestedTest"] as const) {
        expect(primary).not.toContain(findings[0]![field]);
        expect(body).toContain(findings[0]![field]);
      }
      expect(primary.match(/Remediation remains unverified/g)).toHaveLength(1);
      expect(primary.match(/Regression-test guidance remains unverified/g)).toHaveLength(1);
    }
    expect(composed.metrics.publishedSuggestionSources).toEqual([]);
    expect(composed.metrics.retainedSuggestionSources).toHaveLength(2);
    expect(composed.metrics.accountedSourceComponents).toBe(compositionSources(findings).length);
  });

  it("needs no recommendation placeholders when a finding has no proposals", () => {
    const { findings } = fixture();
    delete findings[0]!.suggestedFix;
    delete findings[0]!.suggestedTest;
    const body = renderRetainedComposition(findings);
    expect(body).not.toContain("remains unverified");
    expect(body).not.toContain("**Suggested");
  });

  it("keeps historical proposals out of advice even if their old assessment claimed support", () => {
    const { findings, group, submission } = fixture();
    const original = structuredClone(findings[0]!.suggestionAssessments!.suggestedFix!);
    original.suggestionText = "Use an older membership snapshot.";
    findings[0]!.originalSuggestions = { suggestedFix: original };
    const ref = "authorization/originalSuggestions/suggestedFix";
    group.retainedSourceRefs.push(ref);
    const rendered = composePresentation(findings, group.sections, group.evidenceRefs, undefined, group);
    expect(rendered.body.split("\n\n<details>")[0]).not.toContain(original.suggestionText);
    expect(rendered.body).toContain(original.suggestionText);
    expect(rendered.body).toContain("before verification revision; provenance only");
    group.sections.find(s => s.kind === "fix")!.sourceRefs.push(ref);
    expect(() => validateCompositionSubmission(submission, findings)).toThrow(/unsupported_suggestion/);
    expect(normalizeCompositionReferences(submission, findings)).toBeUndefined();
    findings[0]!.originalSuggestions.suggestedFix!.suggestionText = findings[0]!.suggestedFix!;
    expect(compositionSources(findings).some(s => s.provenanceOnly)).toBe(false);
  });

  it("does not bypass conflicting assessments by composing candidates into separate groups", () => {
    const first = fixture();
    const second = fixture();
    second.findings[0]!.id = "conflict";
    second.findings[0]!.suggestionAssessments!.suggestedFix!.status = "incompatible";
    const findings = [...first.findings, ...second.findings];
    const sources = compositionSources(second.findings, findings);
    const secondGroup = { findingIds: ["conflict"], sections: (["impact", "verification"] as const).map(kind => ({
      kind, text: "The defect remains established.", sourceRefs: sources.filter(s => s.kind === kind).map(s => s.id)
    })), evidenceRefs: sources.filter(s => s.kind === "evidence").map(s => s.id),
      retainedSourceRefs: sources.filter(s => s.kind === "fix" || s.kind === "test").map(s => s.id) };
    expect(() => validateCompositionSubmission({ composedFindings: [first.group, secondGroup] }, findings)).toThrow(/unsupported_suggestion/);
    const body = renderRetainedComposition(first.findings, undefined, undefined, undefined, findings);
    expect(body.split("\n\n<details>")[0]).not.toContain(first.findings[0]!.suggestedFix);
  });

  it("offers only eligible IDs in attribution repairs, while retaining unsupported sources", () => {
    const { findings, group, submission } = fixture();
    delete findings[0]!.suggestionAssessments!.suggestedTest;
    const index = group.sections.findIndex(s => s.kind === "test");
    group.sections.splice(index, 1);
    group.retainedSourceRefs = ["authorization/suggestedTest"];
    const fixIndex = group.sections.findIndex(s => s.kind === "fix");
    group.sections[fixIndex]!.sourceRefs.push("invented/fix");
    const repair = createCompositionAttributionRepair(schemaFor(findings), submission, findings)!;
    const path = `composedFindings.0.sections.${fixIndex}.sourceRefs`;
    expect(() => repair.merge({ [path]: ["authorization/suggestedTest"] })).toThrow();
    const result = repair.merge({ [path]: ["authorization/suggestedFix"] });
    expect(() => validateCompositionSubmission(result as typeof submission, findings)).not.toThrow();
  });

  it("repairs unsupported advice by removing its section without losing the source or changing diagnosis", () => {
    const { findings, group, submission } = fixture();
    delete findings[0]!.suggestionAssessments!.suggestedFix;
    const before = structuredClone(submission);
    const repair = createCompositionAttributionRepair(schemaFor(findings), submission, findings)!;
    expect(repair.prompt).toContain("Repair unsupported composition advice");
    const sections = group.sections.filter(s => s.kind !== "fix");
    const updates = { "composedFindings.0.sections": sections, "composedFindings.0.retainedSourceRefs": ["authorization/suggestedFix"] };
    const repaired = repair.merge(updates) as typeof submission;
    expect(() => validateCompositionSubmission(repaired, findings)).not.toThrow();
    expect(repaired.composedFindings[0]!.sections).toHaveLength(3);
    expect(submission).toEqual(before);
    expect(() => repair.merge({ ...updates, "composedFindings.0.retainedSourceRefs": [] })).toThrow(/missing_source/);
    const changed = structuredClone(sections);
    changed[0]!.text = "Rewrite diagnosis";
    expect(() => repair.merge({ ...updates, "composedFindings.0.sections": changed })).toThrow(/preserve impact/);
    expect(() => repair.merge({ "composedFindings": [] })).toThrow();
  });
});
