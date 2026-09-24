import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { cleanupSubmitShape, focusedRepairDiagnostics, preservationViolations } from "../src/llm/submit-preservation.js";
import { SubmitPacketReviewSchema, SubmitVerificationVerdictSchema } from "../src/llm/schemas.js";

const review = (extra: Record<string, unknown>, side = "RIGHT") => ({ findings: [{ path: "amount.go", anchor: { path: "amount.go", side, line: 1 }, evidence: { changedCode: "return 0", ...extra } }] });
const risk = { verdict: "keep", reason: "Caller proves reachability", requiredEvidencePresent: true, falsePositiveRisk: "low" };

describe("local submit shape cleanup", () => {
  it("reconstructs complete misplaced sibling envelopes without losing items or mutating input", () => {
    const schema = Type.Object({ findings: Type.Array(Type.Object({ proof: Type.String() }, { additionalProperties: false })), hints: Type.Array(Type.String()) }, { additionalProperties: false });
    const expected = { findings: [{ proof: "first" }, { proof: "second" }], hints: ["check caller"] };
    const raw = { findings: JSON.stringify(expected).slice('{"findings":'.length) };
    const snapshot = structuredClone(raw);
    const fixed = cleanupSubmitShape(schema, raw);
    expect(fixed.arguments).toEqual(expected);
    expect(fixed.edits).toEqual([{ path: "findings", rule: "misplaced_sibling_envelope" }]);
    expect(fixed.unusablePaths).toEqual([]);
    expect(raw).toEqual(snapshot);
    expect(preservationViolations(schema, raw, expected)).toEqual([]);
    expect(preservationViolations(schema, raw, { ...expected, findings: [] })).toContain("findings");
    expect(cleanupSubmitShape(schema, { ...raw, hints: expected.hints }).arguments).toEqual(expected);
    expect(cleanupSubmitShape(schema, { ...raw, hints: ["conflict"] }).unusablePaths).toEqual(["findings"]);
  });

  it.each([
    '[{"proof":"first","proof":"second"}],"hints":[]}',
    '[{"proof":"first","pr\\u006fof":"second"}],"hints":[]}',
    '[{"proof":"first"}],"hints":[],"hints":["conflict"]}',
    '[{"proof":"first"}],"hints":[',
    '[{"proof":"first"}],"hints":[]} trailing',
    '[{"proof":"first"}] trailing',
    '[{"proof":"first","proof":"second"}]'
  ])("rejects ambiguous or incomplete structured text: %s", findings => {
    const schema = Type.Object({ findings: Type.Array(Type.Object({ proof: Type.String() })), hints: Type.Array(Type.String()) }, { additionalProperties: false });
    const raw = { findings };
    expect(cleanupSubmitShape(schema, raw).arguments).toEqual(raw);
    expect(cleanupSubmitShape(schema, raw).unusablePaths).toEqual(["findings"]);
    expect(preservationViolations(schema, raw, { findings: [{ proof: "second" }], hints: [] })).toContain("findings");
  });

  it("unwraps nested complete containers and leaves schema strings literal", () => {
    const schema = Type.Object({ rows: Type.Array(Type.Object({ proof: Type.String() }, { additionalProperties: false })), text: Type.String() });
    const raw = { rows: [JSON.stringify({ proof: 'Literal \"key\": [}]', extra: 1 })], text: '{"literal":true}' };
    const result = cleanupSubmitShape(schema, raw);
    expect(result.arguments).toEqual({ rows: [{ proof: 'Literal \"key\": [}]' }], text: raw.text });
    expect(result.unusablePaths).toEqual([]);
    expect(result.edits.map(edit => edit.rule)).toEqual(["complete_json_string", "unknown_property"]);
  });

  it.each([{ maxItems: 10 }, { changedCodeSide: "new" }, { changedCodeNote: "" }])("accounts for run-80 evidence correction %j without mutating the source", extra => {
    const original = review(extra), snapshot = structuredClone(original);
    const result = cleanupSubmitShape(SubmitPacketReviewSchema, original);
    expect(result.arguments).toEqual(review({}));
    expect(result.edits).toHaveLength(1);
    expect(original).toEqual(snapshot);
    expect(preservationViolations(SubmitPacketReviewSchema, original, result.arguments)).toEqual([]);
  });
  it("renames only the exact valid verifier alias locally", () => {
    const { falsePositiveRisk, ...rest } = risk;
    for (const original of [{ ...rest, falsePositivesRisk: falsePositiveRisk }, { ...risk, falsePositivesRisk: falsePositiveRisk }]) {
      expect(cleanupSubmitShape(SubmitVerificationVerdictSchema, original).arguments).toEqual(risk);
      expect(preservationViolations(SubmitVerificationVerdictSchema, original, risk)).toEqual([]);
    }
  });
  it.each([{ falsePositivesRisk: "extreme" }, { falsePositivesRisk: "high" }, { falsePositivesRisk: null }])("discards conflicting or invalid unexpected risk aliases %j", extra => {
    const original = { ...risk, ...extra };
    expect(cleanupSubmitShape(SubmitVerificationVerdictSchema, original).arguments).toEqual(risk);
    expect(preservationViolations(SubmitVerificationVerdictSchema, original, risk)).toEqual([]);
  });
  it.each([{ maxItems: "material evidence" }, { maxItems: -1 }, { changedCodeSide: "old" }, { changedCodeNote: "Independent proof" }])("discards unexpected fields regardless of content %j", extra => {
    const original = review(extra);
    expect(cleanupSubmitShape(SubmitPacketReviewSchema, original).arguments).toEqual(review({}, original.findings[0]!.anchor.side));
    expect(preservationViolations(SubmitPacketReviewSchema, original, review({}))).toEqual([]);
  });
  it("discards unsupported side and metadata keys while preserving known anchor side", () => {
    const original = review({ changedCodeSide: "new" }, "LEFT");
    expect(cleanupSubmitShape(SubmitPacketReviewSchema, original).arguments).toEqual(review({}, original.findings[0]!.anchor.side));
    const misplaced = { ...review({}), maxItems: 10 };
    expect(cleanupSubmitShape(SubmitPacketReviewSchema, misplaced).arguments).toEqual(review({}));
  });
  it("honors closed nested tuples, open objects and ambiguous branches", () => {
    const closed = Type.Object({ text: Type.String() }, { additionalProperties: false });
    const schema = Type.Object({ tuple: Type.Tuple([closed]), open: Type.Object({}, { additionalProperties: true }), union: Type.Union([closed, Type.Null()]) });
    const original = { tuple: [{ text: "proof", extra: "" }], open: { extra: "" }, union: { text: "proof", extra: "" } };
    expect(cleanupSubmitShape(schema, original).arguments).toEqual({ ...original, tuple: [{ text: "proof" }] });
    expect(preservationViolations(schema, original, { ...original, open: {} })).toContain("open.extra");
  });
  it("preserves known optional fields and open values while removing only closed extras", () => {
    const item = Type.Object({ text: Type.String(), note: Type.Optional(Type.String()) }, { additionalProperties: false });
    const schema = Type.Object({ items: Type.Array(item), open: Type.Object({}, { additionalProperties: true }) }, { additionalProperties: false });
    const original = { items: [{ text: "first", note: "known optional", extra: { proof: "discardable" } }, { text: "second" }], open: { unknownButAllowed: ["retain"] } };
    const cleaned = cleanupSubmitShape(schema, original).arguments;
    expect(cleaned).toEqual({ items: [{ text: "first", note: "known optional" }, { text: "second" }], open: original.open });
    expect(preservationViolations(schema, original, cleaned)).toEqual([]);
    expect(preservationViolations(schema, original, { items: [], open: original.open })).toContain("items");
    expect(preservationViolations(schema, original, { items: [{ text: "first" }, { text: "second" }], open: original.open })).toEqual([]);
    const pattern = Type.Object({}, { patternProperties: { "^allowed": Type.String() }, additionalProperties: false });
    expect(cleanupSubmitShape(pattern, { allowedKey: "retain", extra: "do not guess schema" }).edits).toEqual([]);
  });

  it("provides missing, unexpected-value, wrong-type and constraint diagnostics together", () => {
    const schema = Type.Object({ requiredKey: Type.String(), count: Type.Integer(), items: Type.Array(Type.String(), { maxItems: 1 }) }, { additionalProperties: false });
    expect(focusedRepairDiagnostics(schema, { requirdKey: "retain this", count: "oops", items: ["one", "two"] }).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "requiredKey", kind: "missing", expected: expect.objectContaining({ type: "string" }) }),

      expect.objectContaining({ path: "count", kind: "invalid" }), expect.objectContaining({ path: "items", kind: "invalid" })
    ]));
    expect(focusedRepairDiagnostics(schema, { requirdKey: "retain this" }).removedUnexpectedFields).toEqual([{ path: "requirdKey", originalValue: "retain this" }]);
    expect(focusedRepairDiagnostics(schema, { "extra.key": { proof: "retain diagnostic" } }).removedUnexpectedFields).toEqual([{ path: "extra.key", originalValue: { proof: "retain diagnostic" } }]);
    expect(focusedRepairDiagnostics(Type.Object({}, { minProperties: 1 }), {}).issues).toContainEqual(expect.objectContaining({ kind: "invalid" }));
  });
  it("allows missing required fields to be populated without a fuzzy rename obligation", () => {
    const { falsePositiveRisk, ...rest } = risk;
    const original = { ...rest, falsePostiveRisk: falsePositiveRisk };
    expect(cleanupSubmitShape(SubmitVerificationVerdictSchema, original).arguments).toEqual(rest);
    expect(preservationViolations(SubmitVerificationVerdictSchema, original, risk)).toEqual([]);
    expect(preservationViolations(SubmitVerificationVerdictSchema, original, { ...risk, reason: "Changed proof" })).not.toEqual([]);
    expect(preservationViolations(SubmitVerificationVerdictSchema, { ...risk, unrelatedRisk: "high" }, { ...risk, falsePositiveRisk: "high" })).toContain("falsePositiveRisk");
  });
  it("does not fill missing fields or repair invalid canonical values by deleting extras", () => {
    const { falsePositiveRisk: _risk, ...missing } = risk;
    const original = { ...missing, falsePostiveRisk: "low", notes: { content: "extra" } };
    expect(cleanupSubmitShape(SubmitVerificationVerdictSchema, original).arguments).toEqual(missing);
    expect(focusedRepairDiagnostics(SubmitVerificationVerdictSchema, original).issues).toContainEqual(expect.objectContaining({ path: "falsePositiveRisk", kind: "missing" }));
    const invalid = { ...risk, falsePositiveRisk: "invalid", falsePositivesRisk: "low" };
    expect(cleanupSubmitShape(SubmitVerificationVerdictSchema, invalid).arguments).toEqual({ ...risk, falsePositiveRisk: "invalid" });
    expect(focusedRepairDiagnostics(SubmitVerificationVerdictSchema, invalid).issues).toContainEqual(expect.objectContaining({ path: "falsePositiveRisk", kind: "invalid" }));
  });
});
