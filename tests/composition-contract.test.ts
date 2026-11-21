import { describe, expect, it } from "vitest";
import { validateToolCall } from "./helpers/pi-validation.js";
import type { Tool } from "@earendil-works/pi-ai";
function validateWithSchema(schema: Tool["parameters"], value: unknown) {
  return validateToolCall([{ name: "submit", description: "fixture", parameters: schema }], { type: "toolCall", id: "fixture", name: "submit", arguments: value as Record<string, unknown> });
}
import { contractReview, contractComposition as proposal } from "./fixtures/composition/contract-review.js";
import { composePresentation, compositionAttributionDiagnostics, compositionSources, renderRetainedComposition, validateCompositionSubmission } from "../src/pipeline/composition-content.js";
import { composerSubmissionSchema } from "../src/pipeline/composer.js";
import { assessFinalSuggestions } from "../src/pipeline/suggestion-assessment.js";
import { SubmitCompositionSchema, SubmitVerificationVerdictSchema } from "../src/llm/schemas.js";
import { cleanupSubmitShape, submissionIssues } from "../src/llm/submit-preservation.js";
import { createPromptBuilder } from "../src/skills/prompt-builder.js";
import type { LensRegistry } from "../src/skills/lens-registry.js";
import type { RunCoverageStatus } from "../src/types.js";


describe("contract-aware concise composition", () => {
  it("publishes the corrected conclusion and supported remedy without the original assessments appendix", () => {
    const { findings, sections, evidenceRefs, presentation } = proposal();
    findings[1]!.severity = "medium";
    const { body, metrics } = composePresentation(findings, sections, evidenceRefs, undefined, presentation);
    expect(body).toContain(findings[1]!.verification);
    expect(body).not.toContain(findings[0]!.verification);
    expect(body).not.toContain(findings[0]!.suggestedFix);
    expect(body).not.toContain(findings[0]!.suggestedTest);
    expect(body).toContain("**Suggested fix:** Round");
    expect(body).toContain("Regression-test guidance remains unverified");
    expect(body).not.toContain(findings[1]!.suggestedTest);
    expect(body).toContain("size of the loss depends");
    expect(body).not.toContain("Original assessments and supporting evidence");
    expect(body).not.toContain("**superseded:**");
    for (const source of compositionSources(findings)) expect(body).not.toContain(source.id);
    expect(metrics.accountedSourceComponents).toBe(compositionSources(findings).length);
    expect(metrics.primaryEvidenceComponents).toBe(1);
    expect(metrics.provenanceWords).toBe(0);
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
    const body = composePresentation(findings, sections, evidenceRefs, undefined, presentation).body;
    expect(body).toContain("Essential assumption: Can public callers reach this branch?");
    expect(body).toContain("Caller reachability remains unknown.");
    presentation.reconciliations![0]!.sourceRefs = ["rounding/proofAssessment"];
    expect(() => composePresentation(findings, sections, evidenceRefs, undefined, presentation)).toThrow(/cannot supersede/);
  });

  it("retains a defect when its remedy is incompatible in deterministic fallback", () => {
    const findings = contractReview();
    let accounted = 0;
    const body = renderRetainedComposition(findings, undefined, text => text, metrics => { accounted = metrics.accountedSourceComponents; });
    expect(accounted).toBe(compositionSources(findings).length);
    expect(body).toContain(findings[0]!.failureMode);
    expect(body).not.toContain(findings[0]!.suggestedFix);
    expect(body).toContain(findings[1]!.suggestedFix);
    expect(body).toContain("synthesis was unavailable");
  });

  it("contains model HTML and unclosed fences while preserving immutable originals", () => {
    const { findings, sections, evidenceRefs, presentation } = proposal();
    sections[0]!.text = "</details>\n<details><summary>Injected</summary>\n```go\nunclosed";
    findings[0]!.evidence.changedCode = "</details>\n```\n<details>raw source";
    presentation.primaryEvidenceRefs = ["rounding/evidence/changedCode"];
    const body = composePresentation(findings, sections, evidenceRefs, undefined, presentation).body;
    expect(body).not.toContain("<details><summary>Injected");
    expect(body).toContain("&lt;/details>");
    expect(body).toContain("unclosed\n```");
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

  it("states that a source's kind is its field, not its subject (#155)", () => {
    const registry = {} as LensRegistry;
    const coverage = { totalHunks: 1, reviewedHunks: 1, skippedHunks: 0, failedHunks: 0 } as RunCoverageStatus;
    const built = createPromptBuilder(registry).buildComposerPrompt({ groupedFindingsJson: "[]", intent: "Review", coverage });
    expect(built.templateVersion).toBe("p10.28");
    expect(built.prompt).toContain("A source's kind is the field it was supplied in, whatever its text is about: a suggestedFix about tests is still a fix source. Use only matching-kind sourceRefs in each section, and put withheld or other-kind sources in retainedSourceRefs.");
    // Label-free wording survives the removal of suggestion assessment labels.
    expect(built.prompt).not.toMatch(/whatever its text is about[^.]*(?:supported|incompatible|unverified)/);
  });

  it("accepts a test-suite repair in the fix section and rejects the same source under tests (#155)", () => {
    const finding = contractReview()[1]!;
    const repair = "Restore the regression tests that drive the production balance reads through a mock provider.";
    finding.suggestedFix = repair;
    finding.suggestionAssessments!.suggestedFix!.suggestionText = repair;
    const sources = compositionSources([finding]);
    const evidenceRefs = sources.filter(source => source.kind === "evidence").map(source => source.id);
    const base = [
      { kind: "impact" as const, text: finding.failureMode, sourceRefs: [finding.id + "/failureMode", finding.id + "/whyThisMatters"] },
      { kind: "verification" as const, text: finding.verification, sourceRefs: [finding.id + "/verification", finding.id + "/proofAssessment"] }
    ];
    const codes = (kind: "fix" | "test") => compositionAttributionDiagnostics(sources,
      [...base, { kind, text: repair, sourceRefs: [finding.id + "/suggestedFix"] }], evidenceRefs,
      { retainedSourceRefs: [finding.id + "/suggestedTest"] }).map(diagnostic => diagnostic.code);
    expect(codes("fix")).toEqual([]);
    expect(codes("test")).toEqual(["wrong_section", "missing_source"]);
  });

  it("asks for publication on every composedFindings item, not once at the root (#98)", () => {
    const registry = {} as LensRegistry;
    const coverage = { totalHunks: 1, reviewedHunks: 1, skippedHunks: 0, failedHunks: 0 } as RunCoverageStatus;
    const { prompt } = createPromptBuilder(registry).buildComposerPrompt({ groupedFindingsJson: "[]", intent: "Review", coverage });
    expect(prompt).toContain('Each composedFindings[] item needs its own publication ("inline" or "summary-only")');

    const findings = contractReview();
    const schema = composerSubmissionSchema([{ fingerprint: "fixture", representative: findings[0]!, findings }]);
    const items = findings.map(f => {
      const sources = compositionSources([f]);
      return { findingIds: [f.id], sections: [
        { kind: "impact" as const, text: f.failureMode, sourceRefs: [f.id + "/failureMode", f.id + "/whyThisMatters"] },
        { kind: "verification" as const, text: f.verification, sourceRefs: [f.id + "/verification", f.id + "/proofAssessment"] }
      ], evidenceRefs: sources.filter(s => s.kind === "evidence").map(s => s.id), retainedSourceRefs: [f.id + "/suggestedFix", f.id + "/suggestedTest"] };
    });
    const valid = { summary: "Two boundaries require attention.", composedFindings: [{ ...items[0]!, publication: "inline" }, { ...items[1]!, publication: "summary-only" }] };
    expect(() => validateWithSchema(schema, valid)).not.toThrow();
    expect(() => validateCompositionSubmission(valid, findings)).not.toThrow();

    // The observed failure: one root-level publication instead of one per item.
    const misplaced = { summary: valid.summary, publication: "inline", composedFindings: items };
    expect(() => validateWithSchema(schema, misplaced)).toThrow();
    const cleaned = cleanupSubmitShape(schema, misplaced).arguments;
    expect(submissionIssues(schema, cleaned)).toEqual(expect.arrayContaining([
      { path: "composedFindings.0.publication", kind: "missing" },
      { path: "composedFindings.1.publication", kind: "missing" }
    ]));
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
