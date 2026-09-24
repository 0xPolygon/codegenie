import { describe, expect, it } from "vitest";
import { createFieldRepair } from "../src/llm/field-repair.js";
import { composerSubmissionSchema } from "../src/pipeline/composer.js";
import { compositionAttributionDiagnostics, compositionSources, validateCompositionSubmission } from "../src/pipeline/composition-content.js";
import { createCompositionAttributionRepair, normalizeCompositionReferences } from "../src/pipeline/composition-repair.js";
import { authorizationComposition } from "./fixtures/composition/authorization-review.js";
import { contractComposition } from "./fixtures/composition/contract-review.js";

function fixture(build: typeof contractComposition = contractComposition) {
  const { findings, sections, evidenceRefs, presentation } = build();
  const original = { summary: "A verified issue", composedFindings: [{ findingIds: findings.map(f => f.id), sections, evidenceRefs, ...presentation, publication: "inline" }] };
  const schema = composerSubmissionSchema([{ fingerprint: "test", representative: findings[0]!, findings }]);
  return { findings, original, schema, group: original.composedFindings[0]! };
}

describe("composition attribution repair", () => {
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
      expect.objectContaining({ code: "unknown_source", reference: "unknown/source" }),
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
});
