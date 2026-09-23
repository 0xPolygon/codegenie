import { describe, expect, it } from "vitest";
import { createFieldRepair } from "../src/llm/field-repair.js";
import { SubmitVerificationVerdictSchema } from "../src/llm/schemas.js";
import { expandVerifierRevision } from "../src/llm/verifier-revision.js";
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
