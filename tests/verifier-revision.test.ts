import { describe, expect, it } from "vitest";
import { createFieldRepair } from "../src/llm/field-repair.js";
import { SubmitVerificationVerdictSchema } from "../src/llm/schemas.js";
import { expandVerifierRevision, promotedCompletionIssues } from "../src/llm/verifier-revision.js";
import { VERIFIER_SUBMIT_EXAMPLE } from "../src/llm/verifier-submit-repair.js";
import type { CandidateFinding } from "../src/types.js";
import type { SubmitVerificationVerdict } from "../src/llm/schemas.js";

const original: CandidateFinding = {
  ...VERIFIER_SUBMIT_EXAMPLE.finalFinding, id: "candidate", changedLine: true,
  producedBy: { kind: "packet", stage: 7, packetId: "p", lensId: "core/code-review", skillIds: [] }
};
const verdict = (findingUpdates: unknown): SubmitVerificationVerdict => ({
  verdict: "revise", reason: "Confirmed", requiredEvidencePresent: true, falsePositiveRisk: "low",
  findingUpdates
} as SubmitVerificationVerdict);

describe("compact verifier revision expansion", () => {
  const promoted: CandidateFinding = { ...original, provenance: {
    source: "uncertainty_promotion", sourceKind: "uncertainty", sourcePacketId: "p",
    question: "Can a revoked member still read documents?", files: [original.path], symbols: [], reason: "Needs investigation"
  } };
  const completion = Object.fromEntries(["title", "failureMode", "whyThisMatters", "verification", "category", "severity", "confidence"]
    .map(key => [key, original[key as keyof CandidateFinding]]));
  const targetedRepair = (input: unknown) => createFieldRepair(SubmitVerificationVerdictSchema, input, true,
    [["finalFinding", "findingUpdates"]], promotedCompletionIssues(promoted, input))!;

  it.each(["findingUpdates", "finalFinding"] as const)("targets missing promoted decisions in %s and refreshes after partial progress", field => {
    const revision = { ...(field === "finalFinding" ? VERIFIER_SUBMIT_EXAMPLE.finalFinding : completion) } as Record<string, unknown>;
    delete revision.severity;
    delete revision.confidence;
    const input = { ...verdict(undefined), [field]: revision };
    if (field === "finalFinding") delete input.findingUpdates;
    const repair = targetedRepair(input);
    expect(repair.paths).toEqual([`${field}.severity`, `${field}.confidence`]);
    const properties = (repair.schema as unknown as { properties: Record<typeof field, {
      properties: { severity: { description: string }; suggestedTest: { description: string } }
    }> }).properties[field].properties;
    expect(properties.severity.description).toContain("Required by stage validation");
    expect(properties.severity.description).not.toContain("Optional in the final result");
    expect(properties.suggestedTest.description).toContain("Optional in the final result");
    expect(repair.diagnostics.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: `${field}.severity`, kind: "missing", expected: expect.objectContaining({ enum: expect.arrayContaining(["low"]) }) })
    ]));
    expect(() => repair.merge({ [`${field}.severity`]: "invalid-level" })).toThrow();
    const progress = repair.merge({ [`${field}.severity`]: "low" });
    expect(() => expandVerifierRevision(promoted, progress as SubmitVerificationVerdict)).toThrow(`${field}.confidence`);
    const next = targetedRepair(progress);
    expect(next.paths).toEqual([`${field}.confidence`]);
    const finished = next.merge({ [field]: { confidence: "high" } });
    expect(expandVerifierRevision(promoted, finished as SubmitVerificationVerdict).finalFinding).toMatchObject({
      severity: "low", confidence: "high", title: revision.title, evidence: original.evidence
    });
    expect(promotedCompletionIssues(promoted, finished)).toEqual([]);
    expect(revision).not.toHaveProperty("severity");
  });

  it("targets a missing revision parent, permits full replacements, and leaves ordinary/rejected verdicts alone", () => {
    const input = verdict(undefined);
    delete input.findingUpdates;
    const repair = targetedRepair(input);
    expect(repair.paths).toEqual(["findingUpdates"]);
    expect((repair.schema as unknown as { properties: { findingUpdates: { description: string } } })
      .properties.findingUpdates.description).toContain("Required by stage validation");
    expect(() => expandVerifierRevision(promoted, repair.merge({ findingUpdates: {} }) as SubmitVerificationVerdict)).toThrow();
    const full = { ...input, finalFinding: VERIFIER_SUBMIT_EXAMPLE.finalFinding };
    expect(expandVerifierRevision(promoted, repair.merge(full) as SubmitVerificationVerdict).finalFinding).toEqual(full.finalFinding);
    expect(promotedCompletionIssues(original, input)).toEqual([]);
    expect(promotedCompletionIssues(promoted, { ...input, verdict: "reject" })).toEqual([]);
    expect(promotedCompletionIssues(promoted, { ...input, findingUpdates: "broken" })).toEqual([]);
  });

  it("combines schema and semantic targets without hiding invalid values or permitting conflicting representations", () => {
    const input = verdict({ ...completion, severity: "invalid", confidence: undefined });
    const repair = targetedRepair(input);
    expect(repair.paths).toEqual(expect.arrayContaining(["findingUpdates.severity", "findingUpdates.confidence"]));
    const full = { ...VERIFIER_SUBMIT_EXAMPLE.finalFinding, title: "A newer complete finding" };
    const replacement = repair.merge({ finalFinding: full });
    expect(replacement).not.toHaveProperty("findingUpdates");
    expect(expandVerifierRevision(promoted, replacement as SubmitVerificationVerdict).finalFinding).toEqual(full);
    const conflicting = repair.merge({ finalFinding: full, findingUpdates: { severity: "low", confidence: "high" } });
    expect(() => expandVerifierRevision(promoted, conflicting as SubmitVerificationVerdict)).toThrow("conflicting");
  });

  it("requires explicit promoted decisions before inheriting provisional values", () => {
    expect(() => expandVerifierRevision(promoted, { ...verdict(undefined), revisedAnchor: { path: original.path, line: 1, side: "RIGHT", hunkId: "h" },
      reason: "Revised category to testing and severity to low" })).toThrow(/findingUpdates.title.*findingUpdates.category.*findingUpdates.severity/);
    expect(() => expandVerifierRevision(original, { ...verdict(undefined), revisedAnchor: { path: original.path, line: 1, side: "RIGHT", hunkId: "h" } })).not.toThrow();
    expect(() => expandVerifierRevision(promoted, { ...verdict(undefined), verdict: "reject" })).not.toThrow();
    const finished = expandVerifierRevision(promoted, verdict(completion)).finalFinding!;
    expect(finished.evidence).toEqual(original.evidence);
    expect(finished.anchor).toBeUndefined();
    expect(expandVerifierRevision(promoted, { ...verdict(undefined), finalFinding: VERIFIER_SUBMIT_EXAMPLE.finalFinding }).finalFinding)
      .toEqual(VERIFIER_SUBMIT_EXAMPLE.finalFinding);
  });

  it("merges missing promoted decisions without resending retained model choices", () => {
    const input = verdict({ title: "Revoked member can still read documents" });
    const repair = createFieldRepair(SubmitVerificationVerdictSchema, input, true, [["finalFinding", "findingUpdates"]])!;
    const { title: _title, ...rest } = completion;
    const merged = repair.merge({ findingUpdates: rest }) as SubmitVerificationVerdict;
    expect(expandVerifierRevision(promoted, merged).finalFinding).toMatchObject({
      title: "Revoked member can still read documents", evidence: original.evidence
    });
    expect(() => expandVerifierRevision(promoted, repair.merge({ findingUpdates: { severity: "low" } }) as SubmitVerificationVerdict))
      .toThrow("findingUpdates.failureMode");
  });
  it("validates the entire merged finding, not just the updates", () => {
    const invalidOriginal = { ...original, failureMode: "" };
    expect(() => expandVerifierRevision(invalidOriginal, verdict({ title: "Updated" }))).toThrow();
    expect(expandVerifierRevision(invalidOriginal, verdict({ failureMode: "Verified failure" })).finalFinding)
      .toMatchObject({ failureMode: "Verified failure", title: original.title });
  });
  it("rejects competing full and compact revisions", () => {
    expect(() => expandVerifierRevision(original, {
      ...verdict({ title: "Updated" }), finalFinding: VERIFIER_SUBMIT_EXAMPLE.finalFinding
    })).toThrow("mutually exclusive");
  });
  it("collapses redundant full and compact revisions without losing full-only changes", () => {
    const full = { ...VERIFIER_SUBMIT_EXAMPLE.finalFinding, title: "Full-only revision" };
    const input = { ...verdict({ verification: full.verification }), finalFinding: full };
    expect(expandVerifierRevision(original, input)).toEqual({ ...verdict(undefined), finalFinding: full });
    expect(input.findingUpdates).toEqual({ verification: full.verification });
  });
  it.each(["finalFinding", "findingUpdates"] as const)("repair explicitly selects %s without resurrecting its alternative", key => {
    const input = { ...verdict({ title: "Conflicting title" }), finalFinding: VERIFIER_SUBMIT_EXAMPLE.finalFinding };
    const repair = createFieldRepair(SubmitVerificationVerdictSchema, input, true, [["finalFinding", "findingUpdates"]])!;
    expect(() => expandVerifierRevision(original, repair.merge({}) as SubmitVerificationVerdict)).toThrow("conflicting: title");
    const patch = key === "findingUpdates" ? { findingUpdates: { title: "Resolved title" } } : { finalFinding: input.finalFinding };
    const merged = repair.merge(patch) as SubmitVerificationVerdict;
    expect(merged[key === "findingUpdates" ? "finalFinding" : "findingUpdates"]).toBeUndefined();
    expect(expandVerifierRevision(original, merged).finalFinding?.title).toBe(key === "findingUpdates" ? "Resolved title" : input.finalFinding.title);
    expect(input.findingUpdates!.title).toBe("Conflicting title");
    expect(merged.reason).toBe(input.reason);
  });
  it.each([{ path: "other.ts" }, { anchor: original.anchor }, { producedBy: {} }, { behaviorChange: "unknown" }, { intentEvidence: ["refactor"] }, null])(
    "rejects identity/placement changes and null updates: %j", (updates) => {
      expect(() => expandVerifierRevision(original, verdict(updates))).toThrow();
    }
  );
  it("preserves top-level assessment alongside a compact revision", () => {
    const result = expandVerifierRevision(original, {
      ...verdict({ title: "Updated" }), behaviorChange: "intentional_needs_confirmation", intentEvidence: ["Change contract"]
    });
    expect(result).toMatchObject({ behaviorChange: "intentional_needs_confirmation", intentEvidence: ["Change contract"], finalFinding: { title: "Updated" } });
  });
  it("replaces evidence as a whole without merging stale related evidence", () => {
    const source = { ...original, evidence: { ...original.evidence, relatedCode: [
      { path: "old.ts", lines: "old()", whyRelevant: "Old proof" }
    ] } };
    const result = expandVerifierRevision(source, verdict({ evidence: { changedCode: "new()" } }));
    expect(result.finalFinding?.evidence).toEqual({ changedCode: "new()" });
    expect(source.evidence.relatedCode).toHaveLength(1);
  });
});
