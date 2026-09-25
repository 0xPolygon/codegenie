import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { xmlParameterSyntax, xmlSyntaxRepairTargets } from "../src/llm/json-syntax-guidance.js";
import { SubmitVerificationVerdictSchema } from "../src/llm/schemas.js";
import { submissionIssues } from "../src/llm/submit-preservation.js";

describe("XML argument syntax guidance", () => {
  it.each(["proofAssessment", "deliveryPolicy"])("locates the %s key without reconstructing values", field => {
    const raw = `{"reason":"quoted \\\" text", "${field}":\n<parameter name="status">unresolved}`;
    expect(xmlParameterSyntax(raw)).toEqual({ offset: raw.indexOf("<parameter"), field });
  });

  it("ignores XML inside JSON strings, including escaped quotes", () => {
    expect(xmlParameterSyntax(JSON.stringify({ evidence: '<parameter name="status"> is source text', other: "value" }))).toBeUndefined();
    expect(xmlParameterSyntax('{"reason":"unterminated <parameter name=')).toBeUndefined();
    expect(xmlParameterSyntax('{"evidence":"<parameter name=\\"status\\">", "unrelated":}')).toBeUndefined();
    expect(xmlParameterSyntax('<parameter name="verdict">reject')).toEqual({ offset: 0 });
  });

  it.each([
    '{"findingUpdates":{"proofAssessment":<parameter name="status">unresolved}}',
    '[{"proofAssessment":<parameter name="status">unresolved}]'
  ])("does not borrow a root field schema for a nested same-named key", raw => {
    expect(xmlParameterSyntax(raw)).toEqual({ offset: raw.indexOf("<parameter") });
  });

  it("builds a nested proof example from the schema, not the rejected text", () => {
    const targets = xmlSyntaxRepairTargets(SubmitVerificationVerdictSchema, [{ error: "invalid", excerptStart: 0,
      excerpt: "untrusted decision and evidence", xmlParameter: { field: "proofAssessment" } }]);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ field: "proofAssessment", optional: true,
      jsonStructureExample: { proofAssessment: { status: "established", evidence: expect.any(String),
        assumptions: [{ question: expect.any(String), essential: false }] } } });
    expect(submissionIssues(targets[0]!.schema, targets[0]!.jsonStructureExample!.proofAssessment)).toEqual([]);
    expect(JSON.stringify(targets)).not.toContain("untrusted decision");
  });

  it("supports unrelated array fields and excludes unknown or ambiguous shapes", () => {
    const schema = Type.Object({ deliveries: Type.Array(Type.Object({ destination: Type.String(), enabled: Type.Boolean() })),
      variant: Type.Union([Type.Object({ a: Type.String() }), Type.Object({ b: Type.String() })]) });
    const diagnostics = ["deliveries", "variant", "invented", "__proto__"].map(field => ({ error: "invalid", excerptStart: 0, excerpt: "", xmlParameter: { field } }));
    const targets = xmlSyntaxRepairTargets(schema, diagnostics);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ optional: false, jsonStructureExample: { deliveries: [{ destination: expect.any(String), enabled: false }] } });
  });

  it("omits examples that violate schema constraints instead of teaching invalid values", () => {
    const schema = Type.Object({ limits: Type.Object({ attempts: Type.Integer({ minimum: 1 }) }) });
    const targets = xmlSyntaxRepairTargets(schema, [{ error: "invalid", excerptStart: 0, excerpt: "", xmlParameter: { field: "limits" } }]);
    expect(targets).toHaveLength(1);
    expect(targets[0]).not.toHaveProperty("jsonStructureExample");
    expect(targets[0]!.schema).toEqual(schema.properties.limits);
  });
});
