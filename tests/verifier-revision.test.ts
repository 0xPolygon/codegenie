import { describe, expect, it } from "vitest";
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
