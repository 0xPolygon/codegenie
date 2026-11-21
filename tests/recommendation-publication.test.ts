import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import type { LlmStructuredRequest } from "../src/llm/llm-runner.js";
import { compositionSources, composePresentation, renderRetainedComposition, validateCompositionSubmission, type CompositionMetrics } from "../src/pipeline/composition-content.js";
import { composerSubmissionSchema, dedupeRankAndComposeReview } from "../src/pipeline/composer.js";
import { createCompositionAttributionRepair, normalizeCompositionReferences } from "../src/pipeline/composition-repair.js";
import { createPromptBuilder } from "../src/skills/prompt-builder.js";
import type { CodegenieConfig, RunCoverageStatus } from "../src/types.js";
import { authorizationComposition } from "./fixtures/composition/authorization-review.js";
import { CodegenieError } from "../src/util/errors.js";
import { nullTelemetry } from "./helpers/git.js";

// Lets one test drop the fallback presentation record; every other caller passes through.
const presentation = vi.hoisted(() => ({ dropFallbackMetrics: false }));
vi.mock("../src/pipeline/composition-content.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/pipeline/composition-content.js")>();
  return { ...actual, renderRetainedComposition: (...args: Parameters<typeof actual.renderRetainedComposition>) =>
    actual.renderRetainedComposition(args[0], args[1], args[2], presentation.dropFallbackMetrics ? undefined : args[3], args[4]) };
});

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
  it.each(["suggestedFix", "suggestedTest"] as const)("withholds distinct %s proposals in fallback regardless of ordering", field => {
    const first = fixture().findings[0]!;
    delete first.suggestionAssessments;
    const second = structuredClone(first);
    second.id = "alternative";
    second[field] = field === "suggestedFix" ? "Revalidate the session's membership when loading a document."
      : "Verify active access, then revoke the session and assert no document is returned.";
    const before = structuredClone([first, second]);
    const other = field === "suggestedFix" ? "suggestedTest" : "suggestedFix";
    const label = field === "suggestedFix" ? "Remediation" : "Regression-test guidance";
    for (const findings of [[first, second], [second, first]]) {
      let metrics: CompositionMetrics | undefined;
      const body = renderRetainedComposition(findings, undefined, undefined, value => { metrics = value; });
      expect(body).toContain(label + " remains unreconciled");
      expect(body).not.toContain(label + " remains unverified");
      expect(body).not.toContain(first[field]);
      expect(body).not.toContain(second[field]);
      expect(body).toContain(first[other]);
      expect(metrics?.publishedSuggestionSources.sort()).toEqual(findings.map(f => f.id + "/" + other).sort());
      expect(metrics?.retainedSuggestionSources.sort()).toEqual(findings.map(f => f.id + "/" + field).sort());
      expect(metrics?.accountedSourceComponents).toBe(compositionSources(findings).length);
    }
    expect([first, second]).toEqual(before);
  });

  it("publishes identical proposals once while retaining every originating source", () => {
    const first = fixture().findings[0]!;
    delete first.suggestionAssessments;
    const second = { ...structuredClone(first), id: "duplicate" };
    let metrics: CompositionMetrics | undefined;
    const body = renderRetainedComposition([first, second], undefined, undefined, value => { metrics = value; });
    expect(body).not.toContain("remains unreconciled");
    for (const field of ["suggestedFix", "suggestedTest"] as const) {
      expect(body.split(first[field]!)).toHaveLength(2);
      expect(metrics?.publishedSuggestionSources).toContain(first.id + "/" + field);
      expect(metrics?.publishedSuggestionSources).toContain(second.id + "/" + field);
    }
    expect(metrics?.accountedSourceComponents).toBe(compositionSources([first, second]).length);
  });

  it.each(["supported", "unverified", "incompatible"] as const)("does not let a historical alternative labeled %s block or replace the current proposal", status => {
    const first = fixture().findings[0]!;
    first.originalSuggestions = { suggestedFix: { ...first.suggestionAssessments!.suggestedFix!, status, suggestionText: "Invalidate every session." } };
    delete first.suggestionAssessments;
    const body = renderRetainedComposition([first]);
    expect(body).toContain(first.suggestedFix);
    expect(body).not.toContain("remains unreconciled");
    expect(body).not.toContain(first.originalSuggestions.suggestedFix!.suggestionText);
  });

  it("publishes verifier-final fix and test advice without a label, never a provenance-only original", () => {
    const { findings, group, submission } = fixture();
    const finding = findings[0]!;
    delete finding.suggestionAssessments;
    const historical = { status: "supported" as const, suggestionText: "Use an older membership snapshot.", rationale: "Historical proposal.", evidence: [] };
    finding.originalSuggestions = { suggestedFix: historical, suggestedTest: { ...historical, suggestionText: "Assert the snapshot is reused." } };
    const originals = ["authorization/originalSuggestions/suggestedFix", "authorization/originalSuggestions/suggestedTest"];
    group.retainedSourceRefs.push(...originals);
    expect(() => validateCompositionSubmission(submission, findings)).not.toThrow();
    const composed = composePresentation(findings, group.sections, group.evidenceRefs, undefined, group);
    let metrics: CompositionMetrics | undefined;
    const fallback = renderRetainedComposition(findings, undefined, undefined, value => { metrics = value; });
    for (const [body, published] of [[composed.body, composed.metrics.publishedSuggestionSources], [fallback, metrics!.publishedSuggestionSources]] as const) {
      expect(body).toContain("**Suggested fix:** " + finding.suggestedFix);
      expect(body).toContain("**Suggested test:** " + finding.suggestedTest);
      expect(body).not.toContain("remains unverified");
      for (const original of Object.values(finding.originalSuggestions)) expect(body).not.toContain(original.suggestionText);
      expect([...published].sort()).toEqual(["authorization/suggestedFix", "authorization/suggestedTest"]);
    }
    // Stage 10 sources carry no suggestion label; provenanceOnly alone separates originals.
    const adviceSources = compositionSources(findings).filter(s => s.findingId === finding.id && (s.kind === "fix" || s.kind === "test"));
    expect(adviceSources.map(s => [s.id, s.provenanceOnly === true])).toEqual([
      ["authorization/suggestedFix", false], ["authorization/suggestedTest", false],
      [originals[0], true], [originals[1], true]
    ]);
    for (const source of adviceSources) expect(source).not.toHaveProperty("suggestionAssessment");
    // A provenance-only original cannot be cited as advice even when its historical label claimed support.
    group.sections.find(s => s.kind === "test")!.sourceRefs.push(originals[1]!);
    group.retainedSourceRefs = [originals[0]!];
    expect(() => validateCompositionSubmission(submission, findings)).toThrow(/unsupported_suggestion/);
  });

  it("allows attributed composition to select among distinct proposals", () => {
    const { findings, sections } = fixture();
    delete findings[0]!.suggestionAssessments;
    const second = structuredClone(findings[0]!);
    second.id = "alternative";
    second.suggestedFix = "Revalidate membership when loading a document.";
    findings.push(second);
    const sources = compositionSources(findings);
    sections.find(section => section.kind === "verification")!.sourceRefs.push(...sources.filter(s => s.findingId === second.id && s.kind === "verification").map(s => s.id));
    const rendered = composePresentation(findings, sections, sources.filter(s => s.kind === "evidence").map(s => s.id), undefined, {
      retainedSourceRefs: sources.filter(s => s.findingId === second.id && s.kind !== "evidence" && s.kind !== "verification").map(s => s.id)
    });
    expect(rendered.body).toContain(findings[0]!.suggestedFix);
    expect(rendered.body).not.toContain("remains unreconciled");
    expect(rendered.metrics.accountedSourceComponents).toBe(sources.length);
    // Alternatives in unrelated groups do not compete during fallback.
    expect(renderRetainedComposition([second], undefined, undefined, undefined, findings)).toContain(second.suggestedFix);
  });

  it.each(["same proposal", "different compound proposal"])("can publish cited advice while retaining an alternative %s", variation => {
    const { findings, sections } = fixture();
    delete findings[0]!.suggestionAssessments;
    const alternative = structuredClone(findings[0]!);
    alternative.id = "alternative";
    if (variation === "different compound proposal") alternative.suggestedFix += " Or allow revoked sessions to finish existing requests.";
    findings.push(alternative);
    const sources = compositionSources(findings);
    sections.find(section => section.kind === "verification")!.sourceRefs.push(alternative.id + "/proofAssessment");
    const retainedSourceRefs = sources.filter(source => source.findingId === alternative.id && source.id !== alternative.id + "/proofAssessment").map(source => source.id);
    const result = composePresentation(findings, sections, sources.filter(source => source.kind === "evidence" && source.findingId !== alternative.id).map(source => source.id), undefined, { retainedSourceRefs });
    expect(result.body).toContain(findings[0]!.suggestedFix);
    expect(result.metrics.publishedSuggestionSources).toContain(findings[0]!.id + "/suggestedFix");
    expect(result.metrics.retainedSuggestionSources).toContain(alternative.id + "/suggestedFix");
    expect(result.metrics.accountedSourceComponents).toBe(sources.length);
  });

  it("lets synthesis retain unlabeled proposals without a placeholder, while fallback publishes them", () => {
    const { findings, group } = fixture();
    delete findings[0]!.suggestionAssessments;
    group.retainedSourceRefs = group.sections.filter(s => s.kind === "fix" || s.kind === "test").flatMap(s => s.sourceRefs);
    group.sections = group.sections.filter(s => s.kind !== "fix" && s.kind !== "test");
    const composed = composePresentation(findings, group.sections, group.evidenceRefs, undefined, group);
    const fallback = renderRetainedComposition(findings);
    for (const body of [composed.body, fallback]) {
      expect(body).toContain(findings[0]!.failureMode);
      expect(body).not.toContain("remains unverified");
    }
    for (const field of ["suggestedFix", "suggestedTest"] as const) {
      expect(composed.body).not.toContain(findings[0]![field]);
      expect(fallback.split(findings[0]![field]!)).toHaveLength(2);
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
    expect(rendered.body).not.toContain(original.suggestionText);
    expect(compositionSources(findings)).toContainEqual(expect.objectContaining({
      id: ref, text: original.suggestionText, provenanceOnly: true
    }));
    expect(compositionSources(findings).find(s => s.id === ref)).not.toHaveProperty("suggestionAssessment");
    group.sections.find(s => s.kind === "fix")!.sourceRefs.push(ref);
    expect(() => validateCompositionSubmission(submission, findings)).toThrow(/unsupported_suggestion/);
    expect(normalizeCompositionReferences(submission, findings)).toBeUndefined();
    findings[0]!.originalSuggestions.suggestedFix!.suggestionText = findings[0]!.suggestedFix!;
    expect(compositionSources(findings).some(s => s.provenanceOnly)).toBe(false);
  });

  it("offers only eligible IDs in attribution repairs", () => {
    const { findings, group, submission } = fixture();
    delete findings[0]!.suggestionAssessments;
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

  it("repairs advice citing a provenance-only original by removing its section without losing the source or changing diagnosis", () => {
    const { findings, group, submission } = fixture();
    delete findings[0]!.suggestionAssessments;
    const original = "authorization/originalSuggestions/suggestedFix";
    findings[0]!.originalSuggestions = { suggestedFix: { status: "unverified", suggestionText: "Use an older membership snapshot.", rationale: "Historical proposal.", evidence: [] } };
    group.sections.find(s => s.kind === "fix")!.sourceRefs = [original];
    group.retainedSourceRefs = ["authorization/suggestedFix"];
    expect(() => validateCompositionSubmission(submission, findings)).toThrow(/unsupported_suggestion/);
    const before = structuredClone(submission);
    const repair = createCompositionAttributionRepair(schemaFor(findings), submission, findings)!;
    expect(repair.prompt).toContain("Repair composition advice");
    expect(repair.prompt).toContain("using only current fix/test sources; original suggestions are provenance only");
    const sections = group.sections.filter(s => s.kind !== "fix");
    const updates = { "composedFindings.0.sections": sections, "composedFindings.0.retainedSourceRefs": ["authorization/suggestedFix", original] };
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

describe("#146 Stage 10 advice publication", () => {
  const coverage = (): RunCoverageStatus => ({ totalHunks: 1, reviewedHunks: 1, skippedHunks: 0, failedHunks: 0,
    coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 }, degradedPlanning: false, budgetStopped: false,
    verificationIncompleteCount: 0, partial: false, reasons: [] });
  const config = (): CodegenieConfig => ({ ...defaultConfig, lenses: { enabled: ["core/code-review"], disabled: [], extraSkillPaths: [] },
    telemetry: { ...defaultConfig.telemetry, enabled: false }, llm: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 } });
  const lensRegistry = { allLenses: () => [], enabledLenses: () => [], lens: () => undefined, skillsForLens: () => [], skillsById: () => [], registryHash: () => "fake" };
  const plan = { diffUnderstanding: { declaredIntent: "test intent", inferredBehavior: "test behavior" },
    coverage: [{ hunkId: "h1", path: "documents.ts", coverage: "normal" as const, lenses: ["core/code-review"], surroundingContextHints: [], reason: "test" }] };
  const original = "authorization/originalSuggestions/suggestedFix";
  function withOriginal() {
    const data = fixture();
    data.findings[0]!.originalSuggestions = { suggestedFix: { status: "supported", suggestionText: "Use an older membership snapshot.", rationale: "Historical proposal.", evidence: [] } };
    data.group.retainedSourceRefs = [original];
    return data;
  }
  function citingOriginal(submission: ReturnType<typeof fixture>["submission"]) {
    const invalid = structuredClone(submission);
    const group = invalid.composedFindings[0]!;
    group.sections.find(s => s.kind === "fix")!.sourceRefs = [original];
    group.retainedSourceRefs = ["authorization/suggestedFix"];
    return invalid;
  }
  function compose(findings: ReturnType<typeof fixture>["findings"], runStructured: <T>(request: LlmStructuredRequest<T>) => Promise<T>) {
    return dedupeRankAndComposeReview({ verified: findings, verdicts: [] }, plan, { mode: "branch", repoRoot: "/repo", commits: [], rawDiff: "" },
      coverage(), config(), nullTelemetry(), { runner: { runStructured }, promptBuilder: createPromptBuilder(lensRegistry) });
  }

  it("keeps assessment-label wording out of the composer prompt and both repair prompts", async () => {
    const { findings, submission } = withOriginal();
    const prompts: Record<string, string> = {};
    await compose(findings, async <T>(request: LlmStructuredRequest<T>) => {
      const invalid = citingOriginal(submission);
      prompts.composer = request.prompt;
      prompts.schemaRepair = request.schemaRepair!.buildPrompt!({ stage: 10, submitTool: "submit_composition",
        error: "schema-invalid arguments: missing required property publication", submitCalls: [{ id: "bad", arguments: invalid }], extraToolNames: [] });
      prompts.attributionRepair = request.schemaRepair!.createFieldRepair!(request.schema, invalid)!.prompt ?? "";
      return submission as T;
    });
    expect(prompts.composer).toContain("Fix/test sections may cite only current fix/test sources");
    expect(prompts.schemaRepair).toContain("Fix/test sections may cite only current fix/test sources");
    expect(prompts.attributionRepair).toContain("Repair composition advice");
    expect(prompts.attributionRepair).toContain("unsupported_suggestion");
    for (const prompt of Object.values(prompts)) {
      for (const phrase of ["supported current", "suggestionAssessment", "unverified"]) expect(prompt).not.toContain(phrase);
    }
  });

  it("publishes a cited current fix source and rejects a cited provenance-only original", async () => {
    const { findings, submission } = withOriginal();
    const validations: unknown[] = [];
    const result = await compose(findings, async <T>(request: LlmStructuredRequest<T>) => {
      validations.push(request.validateSubmit!(citingOriginal(submission) as T), request.validateSubmit!(submission as T));
      return submission as T;
    });
    expect(validations[0]).toMatchObject({ ok: false, details: expect.stringContaining("unsupported_suggestion") });
    expect(validations[1]).toEqual({ ok: true });
    const [final] = [...result.findings, ...result.summaryOnlyFindings];
    if (!final) throw new Error("expected one final finding");
    expect(final.suggestedFix).toBe(findings[0]!.suggestedFix);
    expect(final.suggestedTest).toBe(findings[0]!.suggestedTest);
    expect(final.finalBody).toContain(findings[0]!.suggestedFix);
    expect(final.finalBody).not.toContain("Use an older membership snapshot.");
    expect(final.suggestionAssessments).toBeUndefined();
  });

  it("publishes no structured advice for a final finding without a presentation record", async () => {
    const { findings } = fixture();
    const fallback = async () => compose(findings, async () => { throw new CodegenieError("llm_call_failed", "timed out", { recoverable: true }); })
      .then(result => [...result.findings, ...result.summaryOnlyFindings]);
    // Control: with its fallback record the same finding mirrors the cited advice.
    expect((await fallback())[0]!.suggestedFix).toBe(findings[0]!.suggestedFix);
    presentation.dropFallbackMetrics = true;
    try {
      const [final] = await fallback();
      // The fallback body still renders the advice; only the structured mirror lacks a record to follow.
      expect(final!.finalBody).toContain(findings[0]!.suggestedFix);
      expect(final!.suggestedFix).toBeUndefined();
      expect(final!.suggestedTest).toBeUndefined();
      expect(final!.suggestionAssessments).toBeUndefined();
    } finally {
      presentation.dropFallbackMetrics = false;
    }
  });
});
