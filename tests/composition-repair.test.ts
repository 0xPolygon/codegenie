import { describe, expect, it } from "vitest";
import { createFieldRepair } from "../src/llm/field-repair.js";
import { submissionIssues } from "../src/llm/submit-preservation.js";
import { composerSubmissionSchema } from "../src/pipeline/composer.js";
import { compositionAttributionDiagnostics, compositionSources, proofVisibilityDiagnostics, validateCompositionSubmission, type CompositionPresentation, type CompositionSection } from "../src/pipeline/composition-content.js";
import { createCompositionAttributionRepair, normalizeCompositionReferences } from "../src/pipeline/composition-repair.js";
import { authorizationComposition } from "./fixtures/composition/authorization-review.js";
import { contractComposition } from "./fixtures/composition/contract-review.js";
import { portableSchemaIssues } from "./helpers/portable-schema.js";
import { __piRunnerTestHooks } from "../src/llm/pi-runner.js";

function fixture(build: typeof contractComposition = contractComposition) {
  const { findings, sections, evidenceRefs, presentation } = build();
  const original = { summary: "A verified issue", composedFindings: [{ findingIds: findings.map(f => f.id), sections, evidenceRefs, ...presentation, publication: "inline" }] };
  const schema = composerSubmissionSchema([{ fingerprint: "test", representative: findings[0]!, findings }]);
  return { findings, original, schema, group: original.composedFindings[0]! };
}

describe("absent provenance components", () => {
  it("drops retained references to components a supplied finding does not have, and nothing else", () => {
    const { findings, original, group } = fixture(authorizationComposition);
    const id = findings[0]!.id;
    const absent = [`${id}/originalSuggestions/suggestedFix`, `${id}/evidence/relatedCode/99`];
    group.retainedSourceRefs = [];
    const valid = structuredClone(original);
    group.retainedSourceRefs = [...absent];
    expect(() => validateCompositionSubmission(original, findings)).toThrow();
    const normalized = normalizeCompositionReferences(original, findings)!;
    expect(normalized.removedFields).toEqual(["composedFindings.0.retainedSourceRefs.0", "composedFindings.0.retainedSourceRefs.1"]);
    expect(normalized.value).toEqual(valid);
    expect(() => validateCompositionSubmission(normalized.value as typeof original, findings)).not.toThrow();
    // Unknown findings, non-component suffixes and absent components cited
    // behind published prose are not bookkeeping; they still need repair.
    for (const mutate of [
      (draft: typeof original) => { draft.composedFindings[0]!.retainedSourceRefs = ["other-finding/suggestedFix"]; },
      (draft: typeof original) => { draft.composedFindings[0]!.retainedSourceRefs = [`${id}/notAComponent`]; },
      (draft: typeof original) => { draft.composedFindings[0]!.sections[0]!.sourceRefs.push(absent[0]!); },
      (draft: typeof original) => { draft.composedFindings[0]!.evidenceRefs.push(absent[1]!); }
    ]) {
      const draft = structuredClone(valid);
      mutate(draft);
      const result = normalizeCompositionReferences(draft, findings);
      expect(() => validateCompositionSubmission((result?.value ?? draft) as typeof original, findings)).toThrow();
    }
  });
});

describe("composition attribution repair", () => {
  it("keeps supported test-file fixes visible and offers Test as a repair path", () => {
    const { findings, original, group } = fixture(authorizationComposition);
    const finding = findings[0]!;
    finding.category = "testing";
    finding.path = "documents_test.go";
    const fixRef = finding.id + "/suggestedFix";
    group.sections = group.sections.filter(section => section.kind !== "fix");
    const testIndex = group.sections.findIndex(section => section.kind === "test");
    group.sections[testIndex]!.sourceRefs.push(fixRef);
    const schema = composerSubmissionSchema([{ fingerprint: "test", representative: finding, findings }]);
    expect(normalizeCompositionReferences(original, findings)).toBeUndefined();
    expect(() => validateCompositionSubmission(original, findings)).not.toThrow();
    expect(createCompositionAttributionRepair(schema, original, findings)).toBeUndefined();
    group.sections[testIndex]!.sourceRefs.pop();
    const repair = createCompositionAttributionRepair(schema, original, findings)!;
    const path = `composedFindings.0.sections.${testIndex}.sourceRefs`;
    const emitted = __piRunnerTestHooks.toolSpec({ name: "repair", description: "", parameters: repair.schema, execute: async () => ({ text: "" }) }).parameters;
    expect(portableSchemaIssues("composition-repair", emitted)).toEqual([]);
    expect(() => repair.merge({})).toThrow("Invalid attribution patch");
    expect(() => repair.merge({ [path]: [fixRef, fixRef] })).toThrow(`duplicate reference ${fixRef}`);
    expect(repair.paths).toContain(path);
    const patchSchema = repair.schema as unknown as { properties: Record<string, { items: { enum: string[] } }> };
    expect(patchSchema.properties[path]!.items.enum).toContain(fixRef);
  });

  it("keeps duplicate normalization and diagnostics consistent across allowed placements", () => {
    const { findings, original, group } = fixture(authorizationComposition);
    const finding = findings[0]!;
    const fix = group.sections.find(section => section.kind === "fix")!;
    const test = group.sections.find(section => section.kind === "test")!;
    const fixRef = finding.id + "/suggestedFix";
    finding.category = "testing";
    finding.path = "documents_test.go";
    fix.sourceRefs = [];
    test.sourceRefs.push(fixRef);
    group.retainedSourceRefs = [fixRef];
    const ordinary = structuredClone(original);
    const ordinaryGroup = ordinary.composedFindings[0]!;
    ordinaryGroup.sections.find(section => section.kind === "fix")!.sourceRefs = [fixRef];
    ordinaryGroup.sections.find(section => section.kind === "test")!.sourceRefs = ordinaryGroup.sections.find(section => section.kind === "test")!.sourceRefs.filter(ref => ref !== fixRef);
    expect(normalizeCompositionReferences(original, findings)).toEqual(normalizeCompositionReferences(ordinary, findings));
    // Ignore the intentionally empty Fix section when comparing duplicate errors.
    const duplicateCodes = (value: typeof original) => compositionAttributionDiagnostics(compositionSources(findings), value.composedFindings[0]!.sections, value.composedFindings[0]!.evidenceRefs, value.composedFindings[0]!)
      .filter(issue => issue.reference === fixRef).map(issue => issue.code);
    expect(duplicateCodes(original)).toEqual(duplicateCodes(ordinary));
    group.retainedSourceRefs = [];
    fix.sourceRefs = [fixRef];
    expect(normalizeCompositionReferences(original, findings)).toBeUndefined();
    expect(duplicateCodes(original)).toEqual(["duplicate_reference"]);
  });
  it.each(["wrong-kind", "empty", "unsupported"])("can remove %s advice and restore visible proof without changing diagnosis", kind => {
    const { findings, original, group } = fixture(authorizationComposition);
    const test = group.sections.find(section => section.kind === "test")!;
    const verification = group.sections.find(section => section.kind === "verification")!;
    const proofRef = findings[0]!.id + "/proofAssessment";
    findings[0]!.suggestionAssessments!.suggestedTest!.status = "unverified";
    verification.sourceRefs = verification.sourceRefs.filter(ref => ref !== proofRef);
    const suggestionRef = findings[0]!.id + "/suggestedTest";
    test.sourceRefs = kind === "wrong-kind" ? [proofRef] : kind === "empty" ? [] : [suggestionRef];
    group.retainedSourceRefs = kind === "unsupported" ? [proofRef] : [suggestionRef];
    const schema = composerSubmissionSchema([{ fingerprint: "test", representative: findings[0]!, findings }]);
    const repair = createCompositionAttributionRepair(schema, original, findings)!;
    expect(repair.paths).toContain("composedFindings.0.sections");
    expect(repair.paths).not.toContain("composedFindings.0.sections.3.sourceRefs");
    const sections = structuredClone(group.sections.filter(section => section.kind !== "test"));
    sections.find(section => section.kind === "verification")!.sourceRefs.push(proofRef);
    const patch = { "composedFindings.0.sections": sections, "composedFindings.0.retainedSourceRefs": [suggestionRef] };
    const result = repair.merge(patch) as typeof original;
    expect(submissionIssues(schema, result)).toEqual([]);
    expect(() => validateCompositionSubmission(result, findings)).not.toThrow();
    expect(result.composedFindings[0]!.evidenceRefs).toEqual(group.evidenceRefs);
    const rewritten = structuredClone(patch);
    rewritten["composedFindings.0.sections"][0]!.text = "A different diagnosis.";
    expect(() => repair.merge(rewritten)).toThrow("preserve impact and verification");
    expect(() => repair.merge({ ...patch, "composedFindings.0.retainedSourceRefs": [] })).toThrow();
    expect(() => repair.merge({ ...patch, "composedFindings.0.sections": group.sections })).toThrow();
  });
  it("uses general sparse repair for mixed unfinished prose and reference errors", () => {
    const { findings, original, group, schema } = fixture(authorizationComposition);
    const good = structuredClone(original);
    group.sections[0]!.text = "placeholder";
    group.sections[1]!.text = " TBD ";
    group.sections[0]!.sourceRefs.push("invented/source");
    expect(createCompositionAttributionRepair(schema, original, findings)).toBeUndefined();
    let message = "";
    try { validateCompositionSubmission(original, findings); } catch (error) { message = String(error); }
    expect(message).toContain("composedFindings.0.sections.0.text");
    expect(message).toContain("composedFindings.0.sections.1.text");
    expect(message).toContain("unknown_source");
    const repair = createFieldRepair(schema, original, true)!;
    const progress = repair.merge({ composedFindings: [{ sections: [good.composedFindings[0]!.sections[0]] }] }) as typeof original;
    expect(() => validateCompositionSubmission(progress, findings)).toThrow("composedFindings.0.sections.1.text");
    const next = createFieldRepair(schema, progress, true)!;
    const result = next.merge({ composedFindings: [{ sections: [{}, { text: good.composedFindings[0]!.sections[1]!.text }] }] }) as typeof original;
    expect(result).toEqual(good);
    expect(() => validateCompositionSubmission(result, findings)).not.toThrow();
  });

  it.each(["placeholder", "TODO", "tbd", "   "])("rejects whole-value scaffolding %j but permits mentions and concise prose", marker => {
    const { findings, original, group } = fixture();
    group.sections[0]!.text = marker;
    expect(() => validateCompositionSubmission(original, findings)).toThrow("unfinished_section");
    group.sections[0]!.text = "A placeholder bypasses the permission check.";
    expect(() => validateCompositionSubmission(original, findings)).not.toThrow();
    group.sections[0]!.text = "Access leaks.";
    expect(() => validateCompositionSubmission(original, findings)).not.toThrow();
  });
  it("removes only redundant known references without changing prose or source coverage", () => {
    const { findings, original, group } = fixture();
    const good = structuredClone(original);
    const verification = group.sections.find(section => section.kind === "verification")!.sourceRefs[0]!;
    const fix = group.sections.find(section => section.kind === "fix")!;
    fix.sourceRefs.push(verification, verification, fix.sourceRefs[0]!);
    group.evidenceRefs.push(group.evidenceRefs[0]!);
    const before = structuredClone(original);
    const normalized = normalizeCompositionReferences(original, findings)!;
    expect(normalized.removedFields).toHaveLength(4);
    expect(original).toEqual(before);
    expect(normalized.value).toEqual(good);
    expect(() => validateCompositionSubmission(normalized.value as typeof original, findings)).not.toThrow();
    expect(normalizeCompositionReferences(normalized.value, findings)).toBeUndefined();
  });

  it("retains omitted owned sources without inventing prose links or losing unverified and historical advice", () => {
    const { findings, original, group } = fixture();
    findings[0]!.originalSuggestions = { suggestedFix: { status: "unverified", suggestionText: "An earlier proposal", rationale: "Not inspected", evidence: [] } };
    const missingImpact = group.sections[0]!.sourceRefs.pop()!;
    const omitted = [...group.retainedSourceRefs!, missingImpact, findings[0]!.id + "/originalSuggestions/suggestedFix"];
    group.retainedSourceRefs = [];
    const before = structuredClone(original);
    expect(() => validateCompositionSubmission(original, findings)).toThrow(/missing_source/);
    const normalized = normalizeCompositionReferences(original, findings)!;
    const value = normalized.value as typeof original;
    expect(normalized.removedFields).toEqual([]);
    expect(normalized.addedFields).toHaveLength(omitted.length);
    expect(value.composedFindings[0]!.retainedSourceRefs!.sort()).toEqual(omitted.sort());
    expect(value.composedFindings[0]!.sections).toEqual(before.composedFindings[0]!.sections);
    expect(value.composedFindings[0]!.evidenceRefs).toEqual(group.evidenceRefs);
    expect(original).toEqual(before);
    expect(() => validateCompositionSubmission(value, findings)).not.toThrow();
    expect(normalizeCompositionReferences(value, findings)).toBeUndefined();
  });

  it.each(["duplicate", "unknown"])("does not infer source ownership for %s finding assignments", kind => {
    const { findings, original, group } = fixture();
    group.retainedSourceRefs = [];
    group.findingIds.push(kind === "duplicate" ? findings[0]!.id : "unknown-finding");
    expect(normalizeCompositionReferences(original, findings)).toBeUndefined();
    expect(() => validateCompositionSubmission(original, findings)).toThrow();
  });

  it("does not use retained provenance to replace missing visible proof", () => {
    const { findings, original, group } = fixture();
    group.sections = group.sections.filter(section => section.kind !== "verification");
    const normalized = normalizeCompositionReferences(original, findings)!;
    expect(normalized.addedFields.length).toBeGreaterThan(0);
    expect(() => validateCompositionSubmission(normalized.value as typeof original, findings)).toThrow();
  });

  it("retains unknown references and a source's sole misplaced occurrence", () => {
    const { findings, original, group } = fixture();
    const verification = group.sections.find(section => section.kind === "verification")!.sourceRefs.pop()!;
    group.sections.find(section => section.kind === "fix")!.sourceRefs.push(verification, "unknown/source", "unknown/source");
    expect(normalizeCompositionReferences(original, findings)).toBeUndefined();
    expect(() => validateCompositionSubmission(original, findings)).toThrow(/unknown_source/);
    const diagnostics = compositionAttributionDiagnostics(compositionSources(findings), group.sections, group.evidenceRefs, group, "composedFindings.0.");
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unknown_source", path: expect.stringMatching(/^composedFindings\.0\.sections\.\d+\.sourceRefs\.\d+$/u) }),
      expect.objectContaining({ code: "wrong_section", reference: verification, actualKind: "verification", expectedKind: "fix", accountedAt: undefined }),
      expect.objectContaining({ code: "missing_source", reference: verification })
    ]));
  });

  it("does not accept an empty section after removing its redundant reference", () => {
    const { findings, original, group } = fixture();
    const fix = group.sections.find(section => section.kind === "fix")!;
    group.retainedSourceRefs = [...(group.retainedSourceRefs ?? []), ...fix.sourceRefs];
    fix.sourceRefs = [group.sections.find(section => section.kind === "verification")!.sourceRefs[0]!];
    const normalized = normalizeCompositionReferences(original, findings)!;
    expect(() => validateCompositionSubmission(normalized.value as typeof original, findings)).toThrow(/Empty composition section/);
  });

  it("never uses another composed finding to justify removing a reference", () => {
    const { findings, original, group } = fixture();
    const ref = group.sections[0]!.sourceRefs[0]!;
    original.composedFindings.push({ ...structuredClone(group), findingIds: [], sections: [{ kind: "fix", text: "Other", sourceRefs: [ref] }], evidenceRefs: [] });
    expect(normalizeCompositionReferences(original, findings)).toBeUndefined();
    expect(() => validateCompositionSubmission(original, findings)).toThrow(/unknown_source/);
  });

  it("patches only allowed lists and regenerates missing-source diagnostics from progress", () => {
    const { findings, original, schema, group } = fixture(authorizationComposition);
    const good = structuredClone(original);
    const fixIndex = group.sections.findIndex(section => section.kind === "fix");
    const testIndex = group.sections.findIndex(section => section.kind === "test");
    const fixRefs = group.sections[fixIndex]!.sourceRefs.splice(0);
    const testRefs = group.sections[testIndex]!.sourceRefs.splice(0);
    const repair = createCompositionAttributionRepair(schema, original, findings)!;
    expect(repair.replaceConversation).toBe(true);
    expect(repair.prompt).toContain('"code":"missing_source"');
    expect(repair.prompt).toContain("REPLACES");
    const progress = repair.merge({ [`composedFindings.0.sections.${fixIndex}.sourceRefs`]: fixRefs });
    expect(() => validateCompositionSubmission(progress as typeof original, findings)).toThrow(/missing_source/);
    const next = createCompositionAttributionRepair(schema, progress, findings)!;
    expect(next.paths).not.toContain(`composedFindings.0.sections.${fixIndex}.sourceRefs`);
    const finished = next.merge({ [`composedFindings.0.sections.${testIndex}.sourceRefs`]: testRefs });
    expect(finished).toEqual(good);
    expect(() => validateCompositionSubmission(finished as typeof original, findings)).not.toThrow();
    expect(() => repair.merge({ "composedFindings.0.sections.0.text": "rewrite" })).toThrow();
    expect(() => repair.merge({ composedFindings: [] })).toThrow();
    expect(() => repair.merge({})).toThrow();
    expect(original.composedFindings[0]!.sections[fixIndex]!.sourceRefs).toEqual([]);
  });

  it("offers an explicit replacement for unknown IDs and rejects their reintroduction", () => {
    const { findings, original, schema, group } = fixture();
    const index = group.sections.findIndex(section => section.kind === "fix");
    const correct = [...group.sections[index]!.sourceRefs];
    group.sections[index]!.sourceRefs.push("made-up/fix");
    const repair = createCompositionAttributionRepair(schema, original, findings)!;
    const path = `composedFindings.0.sections.${index}.sourceRefs`;
    expect(repair.prompt).toContain('"code":"unknown_source"');
    expect(() => repair.merge({ [path]: ["made-up/fix"] })).toThrow();
    const result = repair.merge({ [path]: correct });
    expect(() => validateCompositionSubmission(result as typeof original, findings)).not.toThrow();
  });

  it("uses ordinary schema repair when required prose is missing", () => {
    const { findings, original, schema } = fixture();
    const invalid = structuredClone(original) as unknown as Record<string, unknown>;
    delete invalid.summary;
    expect(createCompositionAttributionRepair(schema, invalid, findings)).toBeUndefined();
  });

  it("opens visible-proof repairs in every composed finding, not only one with a schema error (#95)", () => {
    const contract = contractComposition();
    const auth = authorizationComposition();
    const findings = [...contract.findings, ...auth.findings];
    const schema = composerSubmissionSchema([
      { fingerprint: "contract", representative: contract.findings[0]!, findings: contract.findings },
      { fingerprint: "authorization", representative: auth.findings[0]!, findings: auth.findings }
    ]);
    type Composed = CompositionPresentation & { findingIds: string[]; sections: CompositionSection[]; evidenceRefs: string[]; publication: string };
    const original: { summary: string; composedFindings: Composed[] } = { summary: "Two verified issues", composedFindings: [contract, auth].map(build => ({
      findingIds: build.findings.map(f => f.id), sections: build.sections, evidenceRefs: build.evidenceRefs, ...build.presentation, publication: "inline"
    })) };
    const good = structuredClone(original);
    // Group 0: a reference outside the inventory, which schema validation reports first.
    const fixIndex = original.composedFindings[0]!.sections.findIndex(section => section.kind === "fix");
    original.composedFindings[0]!.sections[fixIndex]!.sourceRefs.push("made-up/fix");
    // Group 1: a proof with an open assumption, accounted only in provenance.
    const group = original.composedFindings[1]!;
    const proofRef = auth.findings[0]!.id + "/proofAssessment";
    const verificationIndex = group.sections.findIndex(section => section.kind === "verification");
    group.sections[verificationIndex]!.sourceRefs = group.sections[verificationIndex]!.sourceRefs.filter(ref => ref !== proofRef);
    group.retainedSourceRefs = [...(group.retainedSourceRefs ?? []), proofRef];
    expect(() => validateCompositionSubmission(original, findings)).toThrow(/proof_not_visible/);

    const repair = createCompositionAttributionRepair(schema, original, findings)!;
    expect(repair.paths).toEqual(expect.arrayContaining([
      `composedFindings.0.sections.${fixIndex}.sourceRefs`,
      `composedFindings.1.sections.${verificationIndex}.sourceRefs`,
      "composedFindings.1.retainedSourceRefs"
    ]));
    expect(repair.prompt).toContain('"code":"proof_not_visible"');
    const result = repair.merge({
      [`composedFindings.0.sections.${fixIndex}.sourceRefs`]: good.composedFindings[0]!.sections[fixIndex]!.sourceRefs,
      [`composedFindings.1.sections.${verificationIndex}.sourceRefs`]: good.composedFindings[1]!.sections[verificationIndex]!.sourceRefs,
      "composedFindings.1.retainedSourceRefs": good.composedFindings[1]!.retainedSourceRefs ?? []
    }) as typeof original;
    expect(result.composedFindings.map(entry => entry.sections)).toEqual(good.composedFindings.map(entry => entry.sections));
    expect(result.composedFindings[1]!.retainedSourceRefs ?? []).toEqual(good.composedFindings[1]!.retainedSourceRefs ?? []);
    expect(() => validateCompositionSubmission(result, findings)).not.toThrow();
  });

  it("repairs a proof kept only in provenance when it is the sole defect (#95)", () => {
    const { findings, original, schema, group } = fixture(authorizationComposition);
    const good = structuredClone(original);
    const proofRef = findings[0]!.id + "/proofAssessment";
    const verificationIndex = group.sections.findIndex(section => section.kind === "verification");
    group.sections[verificationIndex]!.sourceRefs = group.sections[verificationIndex]!.sourceRefs.filter(ref => ref !== proofRef);
    group.retainedSourceRefs = [...(group.retainedSourceRefs ?? []), proofRef];
    const repair = createCompositionAttributionRepair(schema, original, findings)!;
    expect(repair.paths).toEqual([`composedFindings.0.sections.${verificationIndex}.sourceRefs`, "composedFindings.0.retainedSourceRefs"]);
    const result = repair.merge({
      [`composedFindings.0.sections.${verificationIndex}.sourceRefs`]: good.composedFindings[0]!.sections[verificationIndex]!.sourceRefs,
      "composedFindings.0.retainedSourceRefs": good.composedFindings[0]!.retainedSourceRefs ?? []
    }) as typeof original;
    expect(result.composedFindings[0]!.sections).toEqual(good.composedFindings[0]!.sections);
    expect(() => validateCompositionSubmission(result, findings)).not.toThrow();
  });

  it("leaves a proof with no verification section to the general repair (#95)", () => {
    const { findings, original, schema, group } = fixture();
    const verificationIndex = group.sections.findIndex(section => section.kind === "verification");
    const [verification] = group.sections.splice(verificationIndex, 1);
    group.retainedSourceRefs = [...(group.retainedSourceRefs ?? []), ...verification!.sourceRefs];
    expect(submissionIssues(schema, original)).toEqual([]);
    expect(() => validateCompositionSubmission(original, findings)).toThrow(/proof_not_visible/);
    // Attribution repair cannot write the missing section's prose.
    expect(createCompositionAttributionRepair(schema, original, findings)).toBeUndefined();
    const general = createFieldRepair(schema, original, true);
    expect(general).toBeDefined();
  });

  it("does not echo unknown model-supplied references into validation errors (#96)", () => {
    const { findings, original, group } = fixture();
    const key = "sk-" + "A1b2C3d4".repeat(4);
    group.retainedSourceRefs = [...(group.retainedSourceRefs ?? []), key];
    group.primaryEvidenceRefs = [key];
    group.findingIds.push(key);
    let message = "";
    try { validateCompositionSubmission(original, findings); } catch (error) { message = String(error); }
    expect(message).toContain("unknown_source");
    expect(message).toContain(`composedFindings.0.findingIds.${group.findingIds.length - 1}`);
    expect(message).not.toContain(key);
    const diagnostics = compositionAttributionDiagnostics(compositionSources(findings), group.sections, group.evidenceRefs, group, "composedFindings.0.");
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "unknown_source", path: `composedFindings.0.retainedSourceRefs.${group.retainedSourceRefs.length - 1}` }));
    expect(JSON.stringify(diagnostics)).not.toContain(key);
  });

  it("neither echoes nor attribution-repairs an invalid unresolved reconciliation source (#95)", () => {
    const { findings, original, schema, group } = fixture();
    const invalid = findings[0]!.id + "/evidence/relatedCode/99";
    group.reconciliations = [{ sourceRefs: [invalid], supportingRefs: [], disposition: "unresolved", rationale: "Sources disagree." }];
    let message = "";
    try { validateCompositionSubmission(original, findings); } catch (error) { message = String(error); }
    expect(message).toContain("Invalid or repeated reconciliation source: an unknown reference");
    expect(message).not.toContain("relatedCode/99");
    expect(proofVisibilityDiagnostics(findings, group.sections, group.evidenceRefs, group, "composedFindings.0.")).toEqual([]);
    // Attribution repair cannot edit reconciliations, so it must not claim this failure.
    expect(createCompositionAttributionRepair(schema, original, findings)).toBeUndefined();
  });
});
