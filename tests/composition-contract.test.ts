import { describe, expect, it } from "vitest";
import { validateToolCall } from "./helpers/pi-validation.js";
import type { Tool } from "@earendil-works/pi-ai";
function validateWithSchema(schema: Tool["parameters"], value: unknown) {
  return validateToolCall([{ name: "submit", description: "fixture", parameters: schema }], { type: "toolCall", id: "fixture", name: "submit", arguments: value as Record<string, unknown> });
}
import { contractReview, contractComposition as proposal } from "./fixtures/composition/contract-review.js";
import { composePresentation, compositionSources, renderRetainedComposition, validateCompositionSubmission } from "../src/pipeline/composition-content.js";
import { composerSubmissionSchema } from "../src/pipeline/composer.js";
import { assessFinalSuggestions } from "../src/pipeline/suggestion-assessment.js";
import { SubmitCompositionSchema, SubmitVerificationVerdictSchema } from "../src/llm/schemas.js";


describe("contract-aware concise composition", () => {
  it("publishes the corrected conclusion and supported remedy while retaining every original", () => {
    const { findings, sections, evidenceRefs, presentation } = proposal();
    findings[1]!.severity = "medium";
    const { body, metrics } = composePresentation(findings, sections, evidenceRefs, undefined, presentation);
    const primary = body.split("\n\n<details>")[0]!;
    expect(primary).toContain(findings[1]!.verification);
    expect(primary).not.toContain(findings[0]!.verification);
    expect(primary).not.toContain(findings[0]!.suggestedFix);
    expect(primary).not.toContain(findings[0]!.suggestedTest);
    expect(primary).toContain("**Suggested fix:** Round");
    expect(primary).toContain("Regression-test guidance remains unverified");
    expect(primary).not.toContain(findings[1]!.suggestedTest);
    expect(primary).toContain("size of the loss depends");
    expect(primary).not.toContain("Original severity assessments differ");
    expect(body).toContain("`rounding`: severity high");
    expect(body).toContain("`boundary-tests`: severity medium");
    expect(body).toContain("**superseded:**");
    for (const source of compositionSources(findings)) { if (!source.id.endsWith("/proofAssessment")) expect(body).toContain(source.text); expect(body).toContain(source.id); }
    expect(metrics.accountedSourceComponents).toBe(compositionSources(findings).length);
    expect(metrics.primaryEvidenceComponents).toBe(1);
    expect(metrics.primaryWords).toBeLessThan(metrics.provenanceWords);
    expect(metrics.semanticPreservation).toBe("not_machine_proven");
  });

  it("requires full accounting independently of evidence prominence and reconciliation", () => {
    const { findings, sections, evidenceRefs, presentation } = proposal();
    const render = () => composePresentation(findings, sections, evidenceRefs, undefined, presentation);
    evidenceRefs.pop();
    expect(render).toThrow(/missing_source/);
    presentation.retainedSourceRefs!.push("boundary-tests/evidence/relatedCode/1");
    expect(render).not.toThrow();
    presentation.primaryEvidenceRefs = ["boundary-tests/evidence/relatedCode/1"];
    expect(render).toThrow(/accounted evidence/);
  });

  it("rejects incompatible endorsements, duplicate sections and unsupported supersessions", () => {
    const { findings, sections, evidenceRefs, presentation } = proposal();
    const render = () => composePresentation(findings, sections, evidenceRefs, undefined, presentation);
    sections.push({ kind: "fix", text: "Lower the guarantee", sourceRefs: ["rounding/suggestedFix"] });
    expect(render).toThrow(/unsupported_suggestion/);
    expect(render).toThrow(/Duplicate section/);
    sections.pop();
    presentation.reconciliations![0]!.supportingRefs = [];
    expect(render).toThrow(/requires supporting/);
    presentation.reconciliations![0]!.supportingRefs = ["invented"];
    expect(render).toThrow(/Invalid independent/);
  });

  it("keeps unresolved essential conditions visible and cannot supersede them", () => {
    const { findings, sections, evidenceRefs, presentation } = proposal();
    findings[0]!.proofAssessment = { status: "unresolved", evidence: "Caller reachability remains unknown.", assumptions: [{ question: "Can public callers reach this branch?", essential: true }] };
    const primary = composePresentation(findings, sections, evidenceRefs, undefined, presentation).body.split("\n\n<details>")[0]!;
    expect(primary).toContain("Essential assumption: Can public callers reach this branch?");
    expect(primary).toContain("Caller reachability remains unknown.");
    presentation.reconciliations![0]!.sourceRefs = ["rounding/proofAssessment"];
    expect(() => composePresentation(findings, sections, evidenceRefs, undefined, presentation)).toThrow(/cannot supersede/);
  });

  it("retains a defect when its remedy is incompatible in deterministic fallback", () => {
    const findings = contractReview();
    let accounted = 0;
    const body = renderRetainedComposition(findings, undefined, text => text, metrics => { accounted = metrics.accountedSourceComponents; });
    expect(accounted).toBe(compositionSources(findings).length);
    const primary = body.split("\n\n<details>")[0]!;
    expect(primary).toContain(findings[0]!.failureMode);
    expect(primary).not.toContain(findings[0]!.suggestedFix);
    expect(primary).toContain(findings[1]!.suggestedFix);
    expect(primary).toContain("synthesis was unavailable");
    expect(body).toContain(findings[0]!.suggestedFix);
    expect(body).toContain("incompatible");
  });

  it("contains model HTML and unclosed fences while preserving immutable originals", () => {
    const { findings, sections, evidenceRefs, presentation } = proposal();
    sections[0]!.text = "</details>\n<details><summary>Injected</summary>\n```go\nunclosed";
    findings[0]!.evidence.changedCode = "</details>\n```\n<details>raw source";
    const body = composePresentation(findings, sections, evidenceRefs, undefined, presentation).body;
    const primary = body.split("\n\n<details>")[0]!;
    expect(primary).not.toContain("<details>");
    expect(primary).toContain("&lt;/details>");
    expect(primary).toContain("unclosed\n```");
    expect(body).toContain("````go\n" + findings[0]!.evidence.changedCode + "\n````");
  });

  it("keeps independent production and testing findings when composed separately", () => {
    const findings = contractReview();
    const groups = findings.map(f => {
      const sources = compositionSources([f]);
      return { findingIds: [f.id], sections: [
        { kind: "impact" as const, text: f.failureMode, sourceRefs: [f.id + "/failureMode", f.id + "/whyThisMatters"] },
        { kind: "verification" as const, text: f.verification, sourceRefs: [f.id + "/verification", f.id + "/proofAssessment"] }
      ], evidenceRefs: sources.filter(s => s.kind === "evidence").map(s => s.id), retainedSourceRefs: [f.id + "/suggestedFix", f.id + "/suggestedTest"] };
    });
    expect(() => validateCompositionSubmission({ composedFindings: groups }, findings)).not.toThrow();
    expect(() => validateCompositionSubmission({ composedFindings: groups.slice(1) }, findings)).toThrow(/omitted findings/);
  });

  it("exposes sections-only live writing with deliberate legacy artifact compatibility", () => {
    const { findings, sections, evidenceRefs, presentation } = proposal();
    const schema = composerSubmissionSchema([{ fingerprint: "fixture", representative: findings[0]!, findings }]);
    expect(schema.properties.composedFindings.items.properties).not.toHaveProperty("finalBody");
    const live = { summary: "Two boundaries require attention.", composedFindings: [{ findingIds: findings.map(f => f.id), sections, evidenceRefs, ...presentation, publication: "inline" }] };
    expect(() => validateWithSchema(schema, live)).not.toThrow();
    const legacy = { summary: "Historical", composedFindings: [{ findingIds: ["rounding"], finalBody: "Historical body", publication: "inline" }] };
    expect(() => validateWithSchema(SubmitCompositionSchema, legacy)).not.toThrow();
    expect(() => validateWithSchema(schema, legacy)).toThrow();
  });

  it("does not require optional suggestion assessments or share support between fix and test", () => {
    expect(() => validateWithSchema(SubmitVerificationVerdictSchema, { verdict: "keep", reason: "Proven defect", requiredEvidencePresent: true, falsePositiveRisk: "low" })).not.toThrow();
    const finding = contractReview()[1]!;
    expect(assessFinalSuggestions(finding, finding.suggestionAssessments)).toMatchObject({ suggestedFix: { status: "supported" }, suggestedTest: { status: "unverified" } });
    const changed = { ...finding, suggestedFix: "Lower the minimum instead." };
    expect(assessFinalSuggestions(changed, finding.suggestionAssessments).suggestedFix?.status).toBe("unverified");
    finding.suggestionAssessments!.suggestedFix!.evidence = [];
    expect(assessFinalSuggestions(finding, finding.suggestionAssessments).suggestedFix?.status).toBe("unverified");
    expect(assessFinalSuggestions({})).toEqual({});
  });
});
