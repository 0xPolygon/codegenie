import { describe, expect, it } from "vitest";
import { buildRepositoryToolDefinitions, normalizeRepositoryToolArguments } from "../src/llm/tool-definitions.js";
import { __piRunnerTestHooks } from "../src/llm/pi-runner.js";
import { createFieldRepair } from "../src/llm/field-repair.js";
import { SubmitPlanSchema, SubmitPacketReviewSchema, SubmitVerificationVerdictSchema, SubmitCompositionSchema } from "../src/llm/schemas.js";
import { LocationSchema } from "../src/pipeline/finding-location.js";
import { recommendationJudgeTool } from "../src/evals/recommendation-judge.js";
import { composerSubmissionSchema } from "../src/pipeline/composer.js";
import { validatePlannerLineRanges } from "../src/pipeline/planner.js";
import { submissionIssues } from "../src/llm/submit-preservation.js";
import { textRepository } from "./helpers/text-repository.js";
import type { RepositoryTools } from "../src/types.js";
import type { ToolDefinition } from "../src/llm/llm-runner.js";
import { portableSchemaIssues } from "./helpers/portable-schema.js";

const serialized = (name: string, parameters: ToolDefinition["parameters"]) => __piRunnerTestHooks.toolSpec({
  name, description: "test", parameters, execute: async () => ({ text: "" })
}).parameters;

describe("portable provider tool schemas", () => {
  it("checks both repository surfaces, stage submissions and location clarification", () => {
    const entries: Array<[string, ToolDefinition["parameters"]]> = [];
    for (const toolSurface of ["current", "six"] as const) {
      for (const tool of buildRepositoryToolDefinitions({} as RepositoryTools, { toolSurface, includeLikelyTests: true })) {
        entries.push([`${toolSurface}:${tool.name}`, tool.parameters]);
      }
    }
    entries.push(["stage5", SubmitPlanSchema], ["stage7", SubmitPacketReviewSchema],
      ["stage9", SubmitVerificationVerdictSchema], ["stage10", composerSubmissionSchema([])], ["location", LocationSchema],
      ["recommendation-judge", recommendationJudgeTool([{ id: "case", rubric: "test" }]).parameters]);
    expect(entries.flatMap(([name, schema]) => portableSchemaIssues(name, serialized(name, schema)))).toEqual([]);
  });

  it("checks generated field repairs for every stage with retained object arrays", () => {
    const cases: Array<[string, ToolDefinition["parameters"], unknown]> = [
      ["stage5", SubmitPlanSchema, { diffUnderstanding: { declaredIntent: "intent" }, coverage: [{ hunkId: "h", path: "a.ts", coverage: "normal", lenses: [], reason: "review" }] }],
      ["stage7", SubmitPacketReviewSchema, { findings: [{ title: "retained" }], followUpHints: [], uncertainties: [] }],
      ["stage9", SubmitVerificationVerdictSchema, { verdict: "keep", reason: "reason", requiredEvidencePresent: true, falsePositiveRisk: "low",
        proofAssessment: { status: "established", evidence: "evidence", assumptions: [{ question: "condition" }] } }],
      ["stage10", SubmitCompositionSchema, { summary: "review", composedFindings: [{ findingIds: ["f"], sections: [{ kind: "impact" }] }] }]
    ];
    for (const [name, schema, draft] of cases) {
      const repair = createFieldRepair(schema, draft);
      expect(repair, name).toBeDefined();
      expect(portableSchemaIssues(`${name}:repair`, serialized(`${name}:repair`, repair!.schema))).toEqual([]);
    }
  });

  it("reports every unsupported path rather than only the first", () => {
    const issues = portableSchemaIssues("tool", { type: "object", minProperties: 1, properties: {
      first: { type: "array", prefixItems: [], items: [] }, second: { type: "string", format: "uri" }
    } });
    expect(issues).toEqual(expect.arrayContaining([
      "tool.minProperties: unsupported keyword", "tool.properties.first.prefixItems: unsupported keyword",
      "tool.properties.first.items: expected schema object", "tool.properties.second.format: unsupported keyword"
    ]));
  });

  it("keeps inclusive two-item line ranges and rejects reversed bounds", async () => {
    const coverage = { hunkId: "h", path: "a.ts", coverage: "normal" as const, lenses: [], reason: "review",
      surroundingContextHints: [{ kind: "line_range" as const, reason: "inspect", expectedUse: "packet_context" as const, lineRange: [2, 4] as [number, number] }] };
    const plan = { diffUnderstanding: { declaredIntent: "intent", inferredBehavior: "behavior" }, coverage: [coverage] };
    expect(submissionIssues(SubmitPlanSchema, plan)).toEqual([]);
    expect(validatePlannerLineRanges(plan)).toEqual({ ok: true });
    expect(validatePlannerLineRanges({ ...plan, coverage: [{ ...coverage, surroundingContextHints: [{ ...coverage.surroundingContextHints[0]!, lineRange: [4, 2] }] }] }))
      .toMatchObject({ ok: false, details: expect.stringContaining("startLine <= endLine") });
    expect(submissionIssues(SubmitPlanSchema, { ...plan, coverage: [{ ...coverage,
      surroundingContextHints: [{ ...coverage.surroundingContextHints[0], lineRange: [1] }] }] })).not.toEqual([]);

    const fixture = await textRepository({ "src/a.ts": "export function a() {}\n" });
    try {
      const tool = fixture.definitions.find(item => item.name === "find_likely_tests")!;
      const symbol = { path: "src/a.ts", name: "a", kind: "function", lineRange: [1, 1], extra: "legacy" };
      expect(normalizeRepositoryToolArguments(tool, { symbol })).toEqual({ symbol: { path: "src/a.ts", name: "a", kind: "function", lineRange: [1, 1] } });
      expect((await tool.execute({ symbol: { ...symbol, lineRange: [4, 2] } }, new AbortController().signal)))
        .toMatchObject({ isError: true, errorCode: "invalid_args", text: expect.stringContaining("startLine <= endLine") });
    } finally { fixture.dispose(); }
  });
});
