import { describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { createFieldRepair, mergeSubmissionDraft } from "../src/llm/field-repair.js";
import { preservationViolations, submissionIssues } from "../src/llm/submit-preservation.js";

const schema = Type.Object({
  findings: Type.Array(Type.Object({ title: Type.String(), why: Type.String(), note: Type.Optional(Type.String()) }, { additionalProperties: false })),
  hints: Type.Array(Type.Object({ question: Type.String(), symbols: Type.Array(Type.String()) }, { additionalProperties: false })),
  reviewStatus: Type.Optional(Type.String()),
  noFindingReason: Type.Optional(Type.String())
}, { additionalProperties: false });
const draft = () => ({ findings: [{ title: "First", why: "Proof" }, { title: "Second", why: "Independent proof" }], hints: [{ question: "Which caller?" }], reviewStatus: "findings", noFindingReason: 'Retain the complete explanation with \\"quoted\\" text.' });

describe("field-only and full-object repair merging", () => {
  it.each(["path", "nested", "full"])("merges %s updates and keeps all omitted content", form => {
    const original = draft();
    const repair = createFieldRepair(schema, original)!;
    expect(repair.paths).toEqual(["hints.0.symbols"]);
    const values = form === "path" ? { "hints.0.symbols": ["Caller"] }
      : form === "nested" ? { hints: [{ symbols: ["Caller"] }] }
      : { ...original, hints: [{ ...original.hints[0], symbols: ["Caller"] }] };
    const merged = repair.merge(values);
    expect(merged).toEqual({ ...original, hints: [{ question: "Which caller?", symbols: ["Caller"] }] });
    expect(submissionIssues(schema, merged)).toEqual([]);
    expect(original).toEqual(draft());
  });

  it("prefers supplied newer values and permits new optional fields", () => {
    const repair = createFieldRepair(schema, draft())!;
    const merged = repair.merge({ "hints.0.symbols": [], findings: [{ title: "Refined title", note: "Optional detail" }], noFindingReason: "Revised explanation" });
    expect(merged).toMatchObject({ findings: [{ title: "Refined title", why: "Proof", note: "Optional detail" }, { title: "Second", why: "Independent proof" }], noFindingReason: "Revised explanation" });
    expect(submissionIssues(schema, merged)).toEqual([]);
  });

  it("retains omitted object-array entries even when the update has an empty array", () => {
    const repair = createFieldRepair(schema, draft())!;
    expect(repair.merge({ findings: [], "hints.0.symbols": [] }).findings).toEqual(draft().findings);
  });

  it("does not erase retained structured evidence with malformed replacements", () => {
    expect(mergeSubmissionDraft(draft(), { findings: null, hints: [false] })).toEqual(draft());
    expect(mergeSubmissionDraft(draft(), { findings: [{ title: "Updated" }] })).toMatchObject({
      findings: [{ title: "Updated", why: "Proof" }, draft().findings[1]]
    });
  });

  it("requires complete newly created objects while allowing updates at retained indices", () => {
    const empty = createFieldRepair(schema, {})!;
    expect(() => empty.merge({ findings: [{ note: "Not a complete finding" }] })).toThrow();
    expect(empty.merge({ findings: [{ title: "New", why: "Evidence" }], hints: [] })).toEqual({
      findings: [{ title: "New", why: "Evidence" }], hints: []
    });
    const repair = createFieldRepair(schema, draft())!;
    expect(() => repair.merge({ findings: [{}, {}, { title: "Incomplete new finding" }] })).toThrow();
    expect(repair.merge({ findings: [{}, {}, { title: "New", why: "Evidence", extra: "discard" }] }).findings).toEqual([
      ...draft().findings, { title: "New", why: "Evidence" }
    ]);
  });

  it("does not invent missing required values and validates supplied types", () => {
    const repair = createFieldRepair(schema, draft())!;
    expect(submissionIssues(schema, repair.merge({}))).toContainEqual({ path: "hints.0.symbols", kind: "missing" });
    expect(() => repair.merge({ "hints.0.symbols": 42 })).toThrow();
    expect(() => repair.merge({ hints: [{ symbols: null }] })).toThrow();
  });

  it("drops unrelated extra keys without letting arbitrary paths mutate the draft", () => {
    const repair = createFieldRepair(schema, draft())!;
    const merged = repair.merge(JSON.parse('{"hints.0.symbols":[],"findings.0.title":"overwrite","__proto__":{"polluted":true}}'));
    expect(merged.findings).toEqual(draft().findings);
    expect(Object.hasOwn(merged, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("accepts identical flat and nested values without losing other repaired fields", () => {
    const repair = createFieldRepair(schema, draft())!;
    const merged = repair.merge({ "hints.0.symbols": ["Caller"], hints: [{ symbols: ["Caller"] }], findings: [{ note: "Concrete new evidence" }] });
    expect(submissionIssues(schema, merged)).toEqual([]);
    expect(merged).toMatchObject({ findings: [{ ...draft().findings[0], note: "Concrete new evidence" }, draft().findings[1]],
      hints: [{ question: "Which caller?", symbols: ["Caller"] }] });
  });

  it("accepts identical scalar repairs and still requires missing fields", () => {
    const s = Type.Object({ updates: Type.Object({ confidence: Type.String(), severity: Type.String() }) });
    const repair = createFieldRepair(s, { updates: {} })!;
    const merged = repair.merge({ "updates.confidence": "high", updates: { confidence: "high" } });
    expect(submissionIssues(s, merged)).toEqual([{ path: "updates.severity", kind: "missing" }]);
  });

  it("rejects conflicting flat and nested representations with their exact path", () => {
    const repair = createFieldRepair(schema, draft())!;
    expect(() => repair.merge({ "hints.0.symbols": ["A"], hints: [{ symbols: ["B"] }] })).toThrow("Conflicting field repair representations at hints.0.symbols");
  });

  it("corrects invalid scalar fields without requesting optional absent ones", () => {
    const s = Type.Object({ count: Type.Integer(), note: Type.Optional(Type.String()) }, { additionalProperties: false });
    const repair = createFieldRepair(s, { count: "invalid" })!;
    expect(repair.paths).toEqual(["count"]);
    expect(repair.merge({ count: 3 })).toEqual({ count: 3 });
    expect(repair.merge({ count: 3, note: "Optional addition" })).toEqual({ count: 3, note: "Optional addition" });
  });

  it("does not create repair plans for unreadable drafts or destructive container constraints", () => {
    expect(createFieldRepair(schema, { ...draft(), findings: '[{"title":' })).toBeUndefined();
    expect(createFieldRepair(Type.Object({ items: Type.Array(Type.String(), { maxItems: 1 }) }), { items: ["first", "second"] })).toBeUndefined();
  });

  it("does not treat optional omissions as preservation failures", () => {
    const s = Type.Object({ required: Type.String(), note: Type.Optional(Type.String()), status: Type.Optional(Type.String()) });
    expect(preservationViolations(s, { required: "keep", note: "explanation", status: "ready" }, { required: "keep" })).toEqual([]);
    expect(preservationViolations(s, { required: "keep" }, {})).toEqual(["required"]);
  });
});
