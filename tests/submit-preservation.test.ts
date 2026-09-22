import { describe, expect, it } from "vitest";
import { Type, validateToolCall } from "@earendil-works/pi-ai";
import { normalizePlannerBookkeeping, preservationViolations, submissionIssues } from "../src/llm/submit-preservation.js";
import { SubmitPacketReviewSchema, SubmitPlanSchema, SubmitVerificationVerdictSchema } from "../src/llm/schemas.js";

// Sanitized run-79 shape: three hints, two uncertainties, two missing lens arrays.
export function run79Draft() {
  return {
    reviewStatus: "no_findings", findings: [], noFindingReason: "Unresolved predicates are recorded below.",
    followUpHints: ["Does the contract reject zero?", "Do callers rescale the result?", "Is truncation covered by tests?"].map((question, index) => ({
      question, files: ["amount.go"], symbols: ["ConvertAmount"], reason: "Check this independent predicate.", confidence: "medium", ...(index === 0 ? { suggestedLenses: ["core/code-review"] } : {})
    })),
    uncertainties: ["Can positive input truncate to zero?", "Can supported callers reach this branch?"].map(question => ({ question, files: ["amount.go"], symbols: [] }))
  };
}

describe("lossless submit recovery", () => {
  it("allows valid missing optional fields while protecting existing fields and arrays", () => {
    const schema = Type.Object({ text: Type.String(), hints: Type.Array(Type.String()), note: Type.Optional(Type.String()), nested: Type.Object({ optional: Type.Optional(Type.Integer()) }) }, { additionalProperties: false });
    const before = { text: "proof", hints: ["first", "second"], nested: {} };
    const after = { ...before, note: "new context", nested: { optional: 1 } };
    expect(preservationViolations(schema, before, after)).toEqual([]);
    expect(preservationViolations(schema, before, { ...after, note: 42 })).toContain("note");
    expect(preservationViolations(schema, before, { ...after, text: "changed" })).toContain("text");
    expect(preservationViolations(schema, after, { ...after, note: "changed" })).toContain("note");
    expect(preservationViolations(schema, before, { ...after, hints: [] })).toContain("hints");
    expect(preservationViolations(schema, before, { ...after, hints: ["second", "first"] })).toContain("hints.0");
  });

  it("requires all five run-79 items and preserves their order and valid contents", () => {
    const draft = run79Draft();
    expect(submissionIssues(SubmitPacketReviewSchema, draft)).toEqual([
      { path: "followUpHints.1.suggestedLenses", kind: "missing" }, { path: "followUpHints.2.suggestedLenses", kind: "missing" }
    ]);
    const fixed = { ...draft, followUpHints: draft.followUpHints.map(hint => ({ ...hint, suggestedLenses: ["core/code-review"] })) };
    expect(preservationViolations(SubmitPacketReviewSchema, draft, fixed)).toEqual([]);
    expect(() => validateToolCall([{ name: "submit", description: "", parameters: SubmitPacketReviewSchema }], { type: "toolCall", id: "1", name: "submit", arguments: fixed })).not.toThrow();
    expect(preservationViolations(SubmitPacketReviewSchema, draft, { ...fixed, followUpHints: [], uncertainties: [] })).toEqual(["followUpHints", "uncertainties"]);
    expect(preservationViolations(SubmitPacketReviewSchema, draft, { ...fixed, followUpHints: [...fixed.followUpHints].reverse() })).toContain("followUpHints.0.question");
  });

  it("normalizes only documented planner bookkeeping, preserving all ten deep decisions and explanatory prose", () => {
    const draft = { diffUnderstanding: { declaredIntent: "Scale transfers", inferredBehavior: "Truncates first.", reviewedHunks: 10, totalHunks: 10, isPartial: false, reason: "Caller contract remains uncertain." },
      coverage: Array.from({ length: 10 }, (_, index) => ({ hunkId: `h${index}`, path: "amount.go", coverage: "deep", lenses: ["core/code-review"], reason: "Check conversion", focusNotes: ["Check zero"], relatedSymbols: ["Transfer"], relatedFiles: ["caller.go"] })) };
    const fixed = normalizePlannerBookkeeping(draft);
    expect(fixed.coverage).toEqual(draft.coverage);
    expect(fixed.diffUnderstanding).toEqual({ declaredIntent: "Scale transfers", inferredBehavior: "Truncates first.\nCaller contract remains uncertain." });
    expect(preservationViolations(SubmitPlanSchema, draft, fixed)).toContain("diffUnderstanding.inferredBehavior");
    expect(preservationViolations(SubmitPlanSchema, draft, { declaredIntent: "Scale transfers", inferredBehavior: "Truncates first." })).toContain("coverage");
    const shallower = structuredClone(fixed) as typeof draft;
    shallower.coverage[0]!.coverage = "normal";
    expect(preservationViolations(SubmitPlanSchema, draft, shallower)).toContain("coverage.0.coverage");
  });

  it("allows exact verifier relocation but rejects conflicting destinations and changed verdicts", () => {
    const original = { verdict: "revise", reason: "Preserve judgment", requiredEvidencePresent: true, falsePositiveRisk: "low", findingUpdates: { evidence: { changedCode: "return 0", verification: "Caller uncertain" } } };
    const fixed = { ...original, findingUpdates: { evidence: { changedCode: "return 0" }, verification: "Caller uncertain" } };
    expect(preservationViolations(SubmitVerificationVerdictSchema, original, fixed)).toEqual([]);
    expect(preservationViolations(SubmitVerificationVerdictSchema, { ...original, findingUpdates: { ...original.findingUpdates, verification: "Different proof" } }, fixed)).not.toEqual([]);
    expect(preservationViolations(SubmitVerificationVerdictSchema, original, { ...fixed, verdict: "reject" })).toContain("verdict");
  });

  it("rejects wrong-type substantive arrays and tuple identity changes", () => {
    const schema = Type.Object({ hints: Type.Array(Type.String()), lines: Type.Tuple([Type.Integer(), Type.Integer()]) });
    expect(preservationViolations(schema, { hints: 123, lines: [1, 2] }, { hints: [], lines: [1, 3] })).toEqual(["hints", "lines.1"]);
  });

  it("does not impose preservation obligations on discarded unknown root wrappers", () => {
    const plan = { diffUnderstanding: { declaredIntent: "Intent", inferredBehavior: "Behavior" }, coverage: [] };
    expect(preservationViolations(SubmitPlanSchema, { plan: JSON.stringify(plan) }, plan)).toEqual([]);
    expect(preservationViolations(SubmitPlanSchema, { plan: JSON.stringify(plan).slice(0, -1) }, plan)).toEqual([]);
    expect(preservationViolations(SubmitPlanSchema, { plan, extra: "Discardable unknown context" }, plan)).toEqual([]);
  });

  it("cleans complete object and array wrappers while protecting their known data", () => {
    const item = Type.Object({ changedCode: Type.String() }, { additionalProperties: false });
    const schema = Type.Object({ evidence: item, findings: Type.Array(item) }, { additionalProperties: false });
    const first = { changedCode: "return first;", changedCodeNote: "discard me" };
    const second = { changedCode: "return second;", extra: { diagnostic: "discard me too" } };
    const before = { evidence: JSON.stringify(first), findings: JSON.stringify([first, second]) };
    const fixed = { evidence: { changedCode: "return first;" }, findings: [{ changedCode: "return first;" }, { changedCode: "return second;" }] };
    expect(preservationViolations(schema, before, fixed)).toEqual([]);
    expect(preservationViolations(schema, before, { ...fixed, evidence: {} })).toContain("evidence.changedCode");
    expect(preservationViolations(schema, before, { ...fixed, evidence: { changedCode: "different" } })).toContain("evidence.changedCode");
    expect(preservationViolations(schema, before, { ...fixed, findings: fixed.findings.slice(0, 1) })).toContain("findings");
    expect(preservationViolations(schema, before, { ...fixed, findings: [...fixed.findings].reverse() })).toContain("findings.0.changedCode");
    expect(preservationViolations(schema, { ...before, evidence: before.evidence.slice(0, -1) }, fixed)).toContain("evidence");
    expect(preservationViolations(schema, { ...before, findings: before.findings.slice(0, -1) }, fixed)).toContain("findings");
  });

  it("protects schema-defined decisions and text while discarding unknown data", () => {
    const schema = Type.Object({ severity: Type.Union([Type.Literal("low"), Type.Literal("high")]), text: Type.String({ maxLength: 4 }) }, { additionalProperties: false });
    expect(preservationViolations(schema, { severity: "severe", text: "too long", extra: "material evidence" }, { severity: "high", text: "trim" })).toEqual(["severity", "text"]);
    expect(submissionIssues(schema, { severity: "low", text: "required field missing in caller" }).every(issue => issue.kind === "invalid")).toBe(true);
  });
});
