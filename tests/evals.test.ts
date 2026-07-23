import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { loadEvalArtifacts } from "../src/evals/eval-artifacts.js";
import { compareToPrevious, renderEvalCompareText } from "../src/evals/eval-compare.js";
import { executeEvalCommand, renderCaseResult, runEvalCommand } from "../src/evals/eval-command.js";
import { loadEvalSuite, replayFromArtifacts, runEvalCase } from "../src/evals/eval-runner.js";
import { aggregateRepeatScores, assignExpectations, matchExpectation, scoreEvalRun } from "../src/evals/eval-scoring.js";
import type {
  CandidateFinding,
  EvalArtifacts,
  EvalCase,
  EvalRunInfo,
  EvalRunMetrics,
  EvalScore,
  FinalFinding
} from "../src/types.js";
import { canonicalArtifactPath } from "../src/telemetry/run-artifacts.js";
import { CodegenieError } from "../src/util/errors.js";
import { commitAll, git, initRepo, writeRepoFile } from "./helpers/git.js";

describe("eval suite validation", () => {
  it("rejects unknown keys, duplicate expectation ids, and invalid source shapes", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-eval-suite-"));
    writeFileSync(path.join(suiteDir, "bad.yml"), [
      "name: bad",
      "repo:",
      "  fixture: repo",
      "artifacts:",
      "  path: old-run",
      "shoud_find: []",
      "should_find:",
      "  - id: duplicate",
      "    path: src/app.ts",
      "should_not_find:",
      "  - id: duplicate",
      "    category: correctness"
    ].join("\n"));

    await expect(loadEvalSuite(suiteDir)).rejects.toMatchObject({
      code: "config_error"
    });
  });

  it("rejects command fields on artifact-backed cases", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-eval-artifact-command-"));
    writeFileSync(path.join(suiteDir, "bad.yml"), [
      "name: artifact-command",
      "artifacts:",
      "  path: logs/1",
      "command:",
      "  branch: feature",
      "should_find:",
      "  - id: expected",
      "    path: src/app.ts"
    ].join("\n"));

    await expect(loadEvalSuite(suiteDir)).rejects.toMatchObject({
      code: "config_error",
      context: expect.objectContaining({
        errors: expect.arrayContaining([
          expect.stringContaining("command is only valid for repo-backed eval cases")
        ])
      })
    });
  });

  it("rejects relative repo.external paths", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-eval-relative-external-"));
    writeFileSync(path.join(suiteDir, "bad.yml"), [
      "name: relative-external",
      "repo:",
      "  external: ../repo",
      "should_find:",
      "  - id: expected",
      "    path: src/app.ts"
    ].join("\n"));

    await expect(loadEvalSuite(suiteDir)).rejects.toMatchObject({
      code: "config_error",
      context: expect.objectContaining({
        errors: expect.arrayContaining([
          expect.stringContaining("repo.external must be an absolute path")
        ])
      })
    });
  });

  it("accepts budget multiplier and budget/completeness expectations", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-eval-budget-fields-"));
    writeFileSync(path.join(suiteDir, "budget.yml"), [
      "name: budget-fields",
      "artifacts:",
      "  path: logs/1",
      "review:",
      "  budgetBoost: 1.5",
      "  maxTimeMinutes: 60",
      "expect:",
      "  reviewCompleteness: complete",
      "  maxBudgetOverruns: 0",
      "  maxToolBudgetRejections: 0",
      "  maxDegradedHunks: 0",
      "  maxUnresolvedNotesSuppressed: 0",
      "should_find:",
      "  - id: expected",
      "    path: src/app.ts"
    ].join("\n"));

    const suite = await loadEvalSuite(suiteDir);

    expect(suite.cases[0]?.evalCase.review?.budgetBoost).toBe(1.5);
    expect(suite.cases[0]?.evalCase.review?.maxTimeMinutes).toBe(60);
    expect(suite.cases[0]?.evalCase.expect).toMatchObject({
      reviewCompleteness: "complete",
      maxBudgetOverruns: 0,
      maxToolBudgetRejections: 0,
      maxDegradedHunks: 0,
      maxUnresolvedNotesSuppressed: 0
    });
  });

  it("accepts pinned head/base eval commands", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-eval-head-base-"));
    writeFileSync(path.join(suiteDir, "head.yml"), [
      "name: head-base",
      "repo:",
      "  fixture: repo",
      "command:",
      "  head: 49f4645b40e3e17f3a7f7c243d4d1de0a0a6e95c",
      "  base: master",
      "expect:",
      "  minFindings: 1"
    ].join("\n"));

    const suite = await loadEvalSuite(suiteDir);

    expect(suite.cases[0]?.evalCase.command).toEqual({
      head: "49f4645b40e3e17f3a7f7c243d4d1de0a0a6e95c",
      base: "master"
    });
  });

  it("rejects three-dot command.target ranges with a clear message", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-eval-three-dot-target-"));
    writeFileSync(path.join(suiteDir, "target.yml"), [
      "name: three-dot-target",
      "repo:",
      "  fixture: repo",
      "command:",
      "  target: abc123...def456",
      "expect:",
      "  minFindings: 1"
    ].join("\n"));

    await expect(loadEvalSuite(suiteDir)).rejects.toMatchObject({
      code: "config_error",
      context: expect.objectContaining({
        errors: expect.arrayContaining([
          expect.stringContaining("three-dot ranges are not supported")
        ])
      })
    });
  });

  it("rejects head eval commands without a base ref", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-eval-head-missing-base-"));
    writeFileSync(path.join(suiteDir, "head.yml"), [
      "name: head-missing-base",
      "repo:",
      "  fixture: repo",
      "command:",
      "  head: 49f4645b40e3e17f3a7f7c243d4d1de0a0a6e95c",
      "expect:",
      "  minFindings: 1"
    ].join("\n"));

    await expect(loadEvalSuite(suiteDir)).rejects.toMatchObject({
      code: "config_error",
      context: expect.objectContaining({
        errors: expect.arrayContaining([
          expect.stringContaining("command.head requires command.base")
        ])
      })
    });
  });

  it("accepts optional positive expectations without failing the suite when unmatched", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-eval-optional-expectation-"));
    writeFileSync(path.join(suiteDir, "optional.yml"), [
      "name: optional-expectation",
      "artifacts:",
      "  path: logs/1",
      "should_find:",
      "  - id: optional",
      "    tier: optional",
      "    path: src/app.ts",
      "  - id: required",
      "    path: src/app.ts"
    ].join("\n"));

    const suite = await loadEvalSuite(suiteDir);
    expect(suite.cases[0]?.evalCase.should_find?.[0]).toMatchObject({ id: "optional", tier: "optional" });

    const score = scoreEvalRun(suite.cases[0]!.evalCase, {
      candidates: [],
      verification: [],
      finalSelection: [],
      finalFindings: [finalFinding("required-finding", "src/app.ts", 4)],
      packets: [],
      hintEvents: [],
      metricsSources: {}
    }, "live");

    expect(score.status).toBe("pass");
    expect(score.expectationResults.find((result) => result.expectationId === "optional")).toMatchObject({
      tier: "optional",
      status: "skipped",
      skipReason: "optional-unmatched"
    });
    expect(score.metrics.stageLossCounts["missed-before-candidate-generation"]).toBe(0);
    expect(renderCaseResult({
      caseName: "optional-expectation",
      runDir: "unused",
      status: "pass",
      info: {
        runNumber: 1,
        caseName: "optional-expectation",
        caseHash: "hash",
        caseSnapshot: suite.cases[0]!.evalCase,
        mode: "live",
        cache: { enabled: false, source: "config" },
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        score
      }
    })).toContain("1/1 required expectations | 0/1 optional expectations");
  });

  it("tracks optional should_not_find matches without failing the suite", () => {
    const score = scoreEvalRun({
      name: "optional-negative-expectation",
      artifacts: { path: "unused" },
      should_not_find: [{
        id: "optional-false-positive-watch",
        tier: "optional",
        path: "src/app.ts"
      }]
    }, {
      candidates: [],
      verification: [],
      finalSelection: [],
      finalFindings: [finalFinding("reported-finding", "src/app.ts", 4)],
      packets: [],
      hintEvents: [],
      metricsSources: {}
    }, "live");

    expect(score.status).toBe("pass");
    expect(score.violations).toEqual([]);
    expect(score.nearViolations).toEqual([{
      expectationId: "optional-false-positive-watch",
      findingId: "reported-finding",
      artifact: "final-findings"
    }]);
    expect(score.expectationResults[0]).toMatchObject({
      tier: "optional",
      status: "skipped",
      skipReason: "optional-matched"
    });
  });

  it("accepts eval llm overrides and preserves legacy review llm fields", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-eval-llm-fields-"));
    writeFileSync(path.join(suiteDir, "llm.yml"), [
      "name: llm-fields",
      "artifacts:",
      "  path: logs/1",
      "review:",
      "  provider: legacy-provider",
      "  model: legacy-model",
      "  reasoning: low",
      "  concurrency: 6",
      "llm:",
      "  provider: fake",
      "  model: fake-model",
      "  reasoning: high",
      "  maxConcurrentCalls: 6",
      "should_find:",
      "  - id: expected",
      "    path: src/app.ts"
    ].join("\n"));

    const suite = await loadEvalSuite(suiteDir);

    expect(suite.cases[0]?.evalCase.review).toMatchObject({
      provider: "legacy-provider",
      model: "legacy-model",
      reasoning: "low",
      concurrency: 6
    });
    expect(suite.cases[0]?.evalCase.llm).toMatchObject({
      provider: "fake",
      model: "fake-model",
      reasoning: "high",
      maxConcurrentCalls: 6
    });
  });

  it("rejects non-positive eval llm maxConcurrentCalls", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-eval-llm-invalid-"));
    writeFileSync(path.join(suiteDir, "bad.yml"), [
      "name: invalid-llm-concurrency",
      "artifacts:",
      "  path: logs/1",
      "llm:",
      "  maxConcurrentCalls: 0",
      "should_find:",
      "  - id: expected",
      "    path: src/app.ts"
    ].join("\n"));

    await expect(loadEvalSuite(suiteDir)).rejects.toMatchObject({
      code: "config_error",
      context: expect.objectContaining({
        errors: expect.arrayContaining([
          expect.stringContaining("llm.maxConcurrentCalls")
        ])
      })
    });
  });
});

describe("eval scoring", () => {
  it("matches fields, assigns deterministically, attributes losses, and scores budgets", () => {
    const finding = finalFinding("final-1", "src/app.ts", 12, {
      title: "Fake finding in src/app.ts",
      severity: "high",
      category: "correctness",
      publication: "inline",
      mergedCandidateIds: ["cand-1"]
    });
    expect(matchExpectation({
      id: "hit",
      path: "src/*.ts",
      lineRange: [10, 14],
      severityAtLeast: "medium",
      titlePattern: "fake finding"
    }, finding)).toMatchObject({ matched: true });

    const assignment = assignExpectations(
      [
        { id: "a", path: "src/app.ts", category: "correctness" },
        { id: "b", path: "src/app.ts", category: "correctness" }
      ],
      [finding]
    );
    expect(assignment.pairs).toEqual([{ expectationId: "a", findingId: "final-1" }]);
    expect(assignment.unmatchedExpectationIds).toEqual(["b"]);

    const rejected = candidate("cand-rejected", "src/rejected.ts", 5, {
      category: "security",
      severity: "high",
      failureMode: "missing authorization check"
    });
    const score = scoreEvalRun({
      name: "scoring",
      artifacts: { path: "unused" },
      expect: { minFindings: 1, maxFindings: 2, maxDuplicateGroups: 1 },
      should_find: [
        { id: "reported", path: "src/app.ts", lineRange: [12, 12], category: "correctness" },
        { id: "verification-loss", path: "src/rejected.ts", category: "security", severityAtLeast: "high" },
        { id: "partial", path: "src/app.ts", category: "security" }
      ],
      should_find_candidate: [
        { id: "candidate-hit", path: "src/rejected.ts", failureModePattern: "authorization" }
      ],
      should_not_find: [
        { id: "ban-fake", titlePattern: "Fake finding" }
      ]
    }, {
      candidates: [candidate("cand-1", "src/app.ts", 12), rejected],
      verification: [
        { candidateId: "cand-1", gate: "passed", verdict: { candidateId: "cand-1", verdict: "keep", reason: "ok", requiredEvidencePresent: true, falsePositiveRisk: "low" } },
        { candidateId: "cand-rejected", gate: "passed", verdict: { candidateId: "cand-rejected", verdict: "reject", reason: "false positive", requiredEvidencePresent: false, falsePositiveRisk: "high" } }
      ],
      finalSelection: [{ findingId: "cand-1", decision: "published", reason: "composer-selected" }],
      finalFindings: [finding],
      packets: [],
      hintEvents: [],
      metricsSources: {}
    }, "live");

    expect(score.status).toBe("fail");
    expect(score.expectationResults.find((result) => result.expectationId === "verification-loss")?.loss?.label).toBe("lost-at-verification");
    expect(score.expectationResults.find((result) => result.expectationId === "partial")?.loss?.label).toBe("partial-match");
    expect(score.violations).toHaveLength(1);
    expect(score.budgetResults.every((result) => result.status === "pass")).toBe(true);
  });

  it("renders minimum and maximum budget failures with the correct comparison direction", () => {
    const score = scoreEvalRun({
      name: "budget-direction",
      artifacts: { path: "unused" },
      expect: { minFindings: 2, maxFindings: 0 }
    }, {
      candidates: [candidate("cand-1", "src/app.ts", 3)],
      verification: [
        { candidateId: "cand-1", gate: "passed", verdict: { candidateId: "cand-1", verdict: "keep", reason: "ok", requiredEvidencePresent: true, falsePositiveRisk: "low" } }
      ],
      finalSelection: [{ findingId: "cand-1", decision: "published", reason: "composer-selected" }],
      finalFindings: [finalFinding("cand-1", "src/app.ts", 3)],
      packets: [],
      hintEvents: [],
      metricsSources: {}
    }, "live");

    expect(score.budgetResults).toEqual([
      expect.objectContaining({ check: "minFindings", status: "fail", actual: 1, limit: 2, direction: "minimum" }),
      expect.objectContaining({ check: "maxFindings", status: "fail", actual: 1, limit: 0, direction: "maximum" })
    ]);
    expect(renderCaseResult({
      caseName: "budget-direction",
      runDir: "unused",
      status: "fail",
      info: {
        runNumber: 1,
        caseName: "budget-direction",
        caseHash: "hash",
        caseSnapshot: { name: "budget-direction", artifacts: { path: "unused" } },
        mode: "live",
        cache: { enabled: false, source: "config" },
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        score
      }
    })).toContain("BUDGET minFindings: 1 < 2");
    expect(renderCaseResult({
      caseName: "budget-direction",
      runDir: "unused",
      status: "fail",
      info: {
        runNumber: 1,
        caseName: "budget-direction",
        caseHash: "hash",
        caseSnapshot: { name: "budget-direction", artifacts: { path: "unused" } },
        mode: "live",
        cache: { enabled: false, source: "config" },
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        score
      }
    })).toContain("BUDGET maxFindings: 1 > 0");
  });

  it("scores and renders review completeness and budget overrun expectations", () => {
    const score = scoreEvalRun({
      name: "budget-completeness",
      artifacts: { path: "unused" },
      expect: { reviewCompleteness: "complete", maxBudgetOverruns: 0 }
    }, {
      candidates: [],
      verification: [],
      finalSelection: [],
      finalFindings: [],
      packets: [],
      hintEvents: [],
      metricsSources: {
        budgetSummary: {
          completeness: "partial",
          partialReasons: ["budget exhausted before all review work completed"],
          multiplier: 1,
          configured: { timeoutMs: 1000, maxModelCalls: 2 },
          effective: { timeoutMs: 1000, maxModelCalls: 2 },
          usage: { modelCalls: 3, totalTokens: 100, byStage: [{ stage: 7, modelCalls: 3, totalTokens: 100 }] },
          overruns: [
            { stage: 7, reason: "max_model_calls", elapsedMs: 1, kind: "model_calls", actual: 3, limit: 2, totalTokens: 100, modelCalls: 3, afterDispatchedCall: true },
            { stage: 9, reason: "max_budget_tokens", elapsedMs: 2, kind: "tokens", actual: 125, limit: 100, totalTokens: 125, modelCalls: 3, afterDispatchedCall: true }
          ],
          dispatchBlocks: []
        }
      }
    }, "live");

    expect(score.budgetResults).toEqual([
      expect.objectContaining({ check: "reviewCompleteness", status: "fail", expected: "complete", actualText: "partial", direction: "equals" }),
      expect.objectContaining({ check: "maxBudgetOverruns", status: "fail", actual: 2, limit: 0, direction: "maximum" })
    ]);
    const rendered = renderCaseResult({
      caseName: "budget-completeness",
      runDir: "unused",
      status: "fail",
      info: {
        runNumber: 1,
        caseName: "budget-completeness",
        caseHash: "hash",
        caseSnapshot: { name: "budget-completeness", artifacts: { path: "unused" } },
        mode: "live",
        cache: { enabled: false, source: "config" },
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        score
      }
    });

    expect(rendered).toContain("partial review");
    expect(rendered).toContain("2 budget overruns");
    expect(rendered).toContain("BUDGET reviewCompleteness: partial != complete");
    expect(rendered).toContain("BUDGET maxBudgetOverruns: 2 > 0");
  });

  it("scores local context pressure metrics and optional thresholds from budget artifacts", () => {
    const score = scoreEvalRun({
      name: "context-pressure",
      artifacts: { path: "unused" },
      expect: {
        maxToolBudgetRejections: 10,
        maxDegradedHunks: 50,
        maxUnresolvedNotesSuppressed: 10
      }
    }, {
      candidates: [],
      verification: [],
      finalSelection: [],
      finalFindings: [],
      packets: [],
      hintEvents: [],
      metricsSources: {
        budgetSummary: {
          completeness: "complete",
          partialReasons: [],
          multiplier: 1,
          configured: { timeoutMs: 1000 },
          effective: { timeoutMs: 1000 },
          usage: { modelCalls: 3, totalTokens: 100, byStage: [{ stage: 7, modelCalls: 3, totalTokens: 100 }] },
          overruns: [],
          dispatchBlocks: [],
          contextPressure: {
            toolBudgetRejections: 23,
            toolBudgetRejectionsByStage: { 7: 18, 9: 5 },
            degradedToolResults: 4,
            degradedToolResultsByStage: { 9: 4 },
            degradedHunks: 77,
            rejectionReasons: [{ reason: "tool_result_budget_exhausted", count: 23 }],
            unresolvedNotes: { emitted: 5, omitted: 50 }
          }
        }
      }
    }, "live");

    expect(score.metrics).toMatchObject({
      toolBudgetRejections: 23,
      degradedHunks: 77,
      unresolvedNotesSuppressed: 50
    });
    expect(score.budgetResults).toEqual([
      expect.objectContaining({ check: "maxToolBudgetRejections", status: "fail", actual: 23, limit: 10, direction: "maximum" }),
      expect.objectContaining({ check: "maxDegradedHunks", status: "fail", actual: 77, limit: 50, direction: "maximum" }),
      expect.objectContaining({ check: "maxUnresolvedNotesSuppressed", status: "fail", actual: 50, limit: 10, direction: "maximum" })
    ]);

    const rendered = renderCaseResult({
      caseName: "context-pressure",
      runDir: "unused",
      status: "fail",
      info: {
        runNumber: 1,
        caseName: "context-pressure",
        caseHash: "hash",
        caseSnapshot: { name: "context-pressure", artifacts: { path: "unused" } },
        mode: "live",
        cache: { enabled: false, source: "config" },
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        score
      }
    });

    expect(rendered).toContain("context pressure 23 tool-budget rejections, 77 degraded hunks, 50 unresolved notes suppressed");
    expect(rendered).toContain("BUDGET maxToolBudgetRejections: 23 > 10");
    expect(rendered).toContain("BUDGET maxDegradedHunks: 77 > 50");
    expect(rendered).toContain("BUDGET maxUnresolvedNotesSuppressed: 50 > 10");
  });

  it("matches reported final findings through merged source candidate locations", () => {
    const source = candidate("source-routing", "src/caller.ts", 42, {
      title: "Explicit preference fallback is skipped",
      category: "correctness",
      severity: "high",
      failureMode: "The explicit provider preference no longer falls back when the preferred route is unavailable."
    });
    const final = finalFinding("final-routing", "src/shared.ts", 10, {
      title: source.title,
      category: source.category,
      severity: source.severity,
      failureMode: source.failureMode,
      fingerprint: "routing-root-cause",
      mergedCandidateIds: ["source-routing"],
      evidence: {
        changedCode: "+ return fallbackProvider",
        relatedCode: [{
          path: "src/caller.ts",
          lines: "42: routeWithPreference(preferred)",
          whyRelevant: "This caller supplies the explicit preference affected by the shared fallback."
        }]
      }
    });

    const score = scoreEvalRun({
      name: "merged-final-location",
      artifacts: { path: "unused" },
      should_find: [{
        id: "routing",
        path: "src/caller.ts",
        lineRange: [42, 42],
        category: "correctness",
        severityAtLeast: "medium",
        titlePattern: "preference fallback"
      }]
    }, {
      candidates: [source],
      verification: [
        { candidateId: "source-routing", gate: "passed", verdict: { candidateId: "source-routing", verdict: "keep", reason: "ok", requiredEvidencePresent: true, falsePositiveRisk: "low" } }
      ],
      finalSelection: [{ findingId: "source-routing", decision: "merged", reason: "composer-merged", mergedIntoFingerprint: "routing-root-cause" }],
      finalFindings: [final],
      packets: [],
      hintEvents: [],
      metricsSources: {}
    }, "live");

    expect(score.status).toBe("pass");
    expect(score.expectationResults[0]).toMatchObject({
      status: "pass",
      matched: [{ findingId: "final-routing", artifact: "final-findings" }]
    });
    expect(score.metrics.stageLossCounts["lost-at-composition"]).toBe(0);
  });

  it("credits merged source candidate categories without reporting a composition loss", () => {
    const source = candidate("source-routing", "src/caller.ts", 42, {
      title: "Explicit preference fallback is skipped",
      category: "correctness",
      severity: "high",
      failureMode: "The explicit provider preference no longer falls back when the preferred route is unavailable."
    });
    const final = finalFinding("final-routing", "src/shared.ts", 10, {
      title: "Preferred route selection can skip fallback",
      category: "logic_bug",
      severity: "high",
      failureMode: "The merged routing behavior now skips fallback for explicit provider preferences.",
      fingerprint: "routing-root-cause",
      mergedCandidateIds: ["source-routing"],
      mergedCategories: ["correctness", "logic_bug"],
      mergedTitles: ["Explicit preference fallback is skipped", "Preferred route selection can skip fallback"],
      finalBody: "The explicit provider preference no longer falls back in both route versions."
    });

    const score = scoreEvalRun({
      name: "merged-category-credit",
      artifacts: { path: "unused" },
      should_find: [{
        id: "routing",
        path: "src/caller.ts",
        category: "correctness",
        severityAtLeast: "medium",
        titlePattern: "explicit.*preference.*fallback"
      }]
    }, {
      candidates: [source],
      verification: [
        { candidateId: "source-routing", gate: "passed", verdict: { candidateId: "source-routing", verdict: "keep", reason: "ok", requiredEvidencePresent: true, falsePositiveRisk: "low" } }
      ],
      finalSelection: [{ findingId: "source-routing", decision: "merged", reason: "composer-merged", mergedIntoFingerprint: "routing-root-cause" }],
      finalFindings: [final],
      packets: [],
      hintEvents: [],
      metricsSources: {}
    }, "live");

    expect(score.expectationResults[0]).toMatchObject({
      status: "pass",
      matched: [{ findingId: "final-routing", artifact: "final-findings" }]
    });
    expect(score.metrics.stageLossCounts["lost-at-composition"]).toBe(0);
    const outcome = matchExpectation({
      id: "routing",
      path: "src/caller.ts",
      category: "correctness",
      titlePattern: "explicit.*preference.*fallback"
    }, final, {
      candidates: [source],
      verification: [],
      finalSelection: [],
      finalFindings: [final],
      packets: [],
      hintEvents: [],
      metricsSources: {}
    });
    expect(outcome.fields.find((field) => field.field === "category")).toMatchObject({
      matched: true,
      via: "merged-candidate"
    });
  });

  it("uses conservative category compatibility for logic bug and correctness findings", () => {
    const final = finalFinding("final-logic", "src/app.ts", 12, {
      title: "Amount conversion rejects a valid value",
      category: "logic_bug",
      failureMode: "The conversion now rejects a valid amount that the old path accepted."
    });

    const compatible = matchExpectation({
      id: "compatible",
      path: "src/app.ts",
      category: "correctness",
      titlePattern: "amount conversion"
    }, final);
    expect(compatible.fields.find((field) => field.field === "category")).toMatchObject({
      matched: true,
      via: "category-compatible"
    });
    expect(compatible.matched).toBe(true);

    const strict = matchExpectation({
      id: "strict",
      path: "src/app.ts",
      category: "security",
      titlePattern: "amount conversion"
    }, final);
    expect(strict.fields.find((field) => field.field === "category")).toMatchObject({
      matched: false
    });
    expect(strict.matched).toBe(false);
  });

  it("matches simple title patterns through body text and token order fallback", () => {
    const nativePrice = finalFinding("native-price", "fees.go", 100, {
      title: "Refactor introduces a fatal error path for non-positive native token price",
      category: "correctness",
      failureMode: "A zero native token price now turns a quote into a hard failure.",
      finalBody: "The fee calculation can now fail a quote that previously continued."
    });

    const titleOutcome = matchExpectation({
      id: "native-price",
      path: "fees.go",
      category: "correctness",
      titlePattern: "zero.*native.*price|native.*price.*hard"
    }, nativePrice);
    expect(titleOutcome.fields.find((field) => field.field === "titlePattern")).toMatchObject({
      matched: true,
      via: "tokenFallback"
    });
    expect(titleOutcome.matched).toBe(true);

    const bodyOutcome = matchExpectation({
      id: "body",
      path: "fees.go",
      category: "correctness",
      titlePattern: "fee.*calculation.*fail"
    }, nativePrice);
    expect(bodyOutcome.fields.find((field) => field.field === "titlePattern")).toMatchObject({
      matched: true,
      via: "body"
    });
    expect(bodyOutcome.matched).toBe(true);
  });

  it("does not let related-path matching override mismatched expectation fields", () => {
    const final = finalFinding("final-related", "src/root.ts", 10, {
      title: "Cache invalidation can be skipped",
      category: "performance",
      failureMode: "The shared cache path can return stale values.",
      evidence: {
        changedCode: "+ cache.set(key, value)",
        relatedCode: [{
          path: "src/caller.ts",
          lines: "18: loadThroughCache(key)",
          whyRelevant: "This caller observes the stale cache value."
        }]
      }
    });

    const outcome = matchExpectation({
      id: "wrong-category",
      path: "src/caller.ts",
      category: "security",
      titlePattern: "cache"
    }, final, {
      candidates: [],
      verification: [],
      finalSelection: [],
      finalFindings: [final],
      packets: [],
      hintEvents: [],
      metricsSources: {}
    });

    expect(outcome.fields.find((field) => field.field === "path")?.matched).toBe(true);
    expect(outcome.fields.find((field) => field.field === "category")?.matched).toBe(false);
    expect(outcome.matched).toBe(false);
  });

  it("does not credit a different root cause just because title tokens overlap", () => {
    const final = finalFinding("final-related", "src/root.ts", 10, {
      title: "Native token price cache can return stale values",
      category: "performance",
      failureMode: "The cache can return stale values.",
      finalBody: "This is about cache staleness, not fee calculation failures.",
      evidence: {
        changedCode: "+ cache.set(key, value)",
        relatedCode: [{
          path: "src/fees.go",
          lines: "18: CalculateIntentFees(ctx)",
          whyRelevant: "This caller reads the cached value."
        }]
      }
    });

    const outcome = matchExpectation({
      id: "wrong-root-cause",
      path: "src/fees.go",
      category: "correctness",
      titlePattern: "native.*price.*hard"
    }, final, {
      candidates: [],
      verification: [],
      finalSelection: [],
      finalFindings: [final],
      packets: [],
      hintEvents: [],
      metricsSources: {}
    });

    expect(outcome.fields.find((field) => field.field === "path")?.matched).toBe(true);
    expect(outcome.fields.find((field) => field.field === "category")?.matched).toBe(false);
    expect(outcome.fields.find((field) => field.field === "titlePattern")?.matched).toBe(false);
    expect(outcome.matched).toBe(false);
  });

  it("attributes planner skips and failed packet reviews, and scores merged duplicate final findings", () => {
    const skipped = scoreEvalRun({
      name: "planner-skip",
      artifacts: { path: "unused" },
      should_find: [{ id: "planner-skip", path: "src/planner.ts" }]
    }, {
      candidates: [],
      verification: [],
      finalSelection: [],
      finalFindings: [],
      reviewPlan: {
        diffUnderstanding: { declaredIntent: "test", inferredBehavior: "test" },
        coverage: [{
          hunkId: "h-skip",
          path: "src/planner.ts",
          coverage: "skip",
          lenses: [],
          surroundingContextHints: [],
          reason: "planner skipped generated hunk"
        }]
      },
      packets: [],
      hintEvents: [],
      coverage: {
        totalHunks: 1,
        reviewedHunks: 0,
        skippedHunks: 1,
        failedHunks: 0,
        coverageByLevel: { deep: 0, normal: 0, light: 0, skip: 1 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: false,
        reasons: [],
        hunks: [{ hunkId: "h-skip", path: "src/planner.ts", coverage: "skip", source: "planner", status: "skipped", reason: "planner skipped generated hunk" }]
      },
      metricsSources: {}
    }, "live");
    expect(skipped.expectationResults[0]?.loss?.subReason).toBe("hunk-skipped-by-planner");

    const failed = scoreEvalRun({
      name: "packet-failed",
      artifacts: { path: "unused" },
      should_find: [{ id: "packet-failed", path: "src/failed.ts" }]
    }, {
      candidates: [],
      verification: [],
      finalSelection: [],
      finalFindings: [],
      packets: [],
      hintEvents: [],
      coverage: {
        totalHunks: 1,
        reviewedHunks: 0,
        skippedHunks: 0,
        failedHunks: 1,
        coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
        degradedPlanning: false,
        budgetStopped: false,
        verificationIncompleteCount: 0,
        partial: true,
        reasons: [],
        hunks: [{ hunkId: "h-failed", path: "src/failed.ts", coverage: "normal", source: "planner", status: "review_failed", reason: "worker failed" }]
      },
      metricsSources: {}
    }, "live");
    expect(failed.expectationResults[0]?.loss?.subReason).toBe("packet-review-failed");

    const representative = candidate("rep", "src/representative.ts", 10);
    const duplicate = candidate("dup", "src/duplicate.ts", 12, {
      duplicateOf: "rep"
    });
    const duplicateScore = scoreEvalRun({
      name: "duplicate-verification",
      artifacts: { path: "unused" },
      should_find: [{ id: "duplicate-merged", path: "src/duplicate.ts" }]
    }, {
      candidates: [representative, duplicate],
      verification: [
        { candidateId: "rep", gate: "passed", verdict: { candidateId: "rep", verdict: "keep", reason: "ok", requiredEvidencePresent: true, falsePositiveRisk: "low" } }
      ],
      finalSelection: [{ findingId: "dup", decision: "merged", reason: "composer-merged", mergedIntoFingerprint: "fp-rep" }],
      finalFindings: [finalFinding("rep", "src/representative.ts", 10, { fingerprint: "fp-rep", mergedCandidateIds: ["rep", "dup"] })],
      packets: [],
      hintEvents: [],
      metricsSources: {}
    }, "live");
    expect(duplicateScore.expectationResults[0]).toMatchObject({
      status: "pass",
      matched: [{ findingId: "rep", artifact: "final-findings" }]
    });
  });

  it("keeps all exact loss instances ordered by outcome rank", () => {
    const merged = candidate("merged", "src/shared.ts", 10);
    const rejected = candidate("rejected", "src/shared.ts", 12);
    const score = scoreEvalRun({
      name: "multi-instance-loss",
      artifacts: { path: "unused" },
      should_find: [{ id: "multi", path: "src/shared.ts", category: "correctness" }]
    }, {
      candidates: [merged, rejected],
      verification: [
        { candidateId: "merged", gate: "passed", verdict: { candidateId: "merged", verdict: "keep", reason: "ok", requiredEvidencePresent: true, falsePositiveRisk: "low" } },
        { candidateId: "rejected", gate: "passed", verdict: { candidateId: "rejected", verdict: "reject", reason: "false positive", requiredEvidencePresent: false, falsePositiveRisk: "high" } }
      ],
      finalSelection: [{ findingId: "merged", decision: "merged", reason: "composer-merged", mergedIntoFingerprint: "absorber" }],
      finalFindings: [finalFinding("absorber", "src/other.ts", 10, { fingerprint: "absorber", publication: "suppressed", mergedCandidateIds: ["merged"] })],
      packets: [],
      hintEvents: [],
      metricsSources: {}
    }, "live");

    const loss = score.expectationResults[0]?.loss;
    expect(loss).toMatchObject({ label: "lost-at-composition", subReason: "composer-merged" });
    expect(loss?.nearestInstances.map((instance) => instance.findingId)).toEqual(["absorber", "merged", "rejected"]);
    expect(loss?.nearestInstances[2]?.outcome).toContain("verdict=reject");
  });

  it("separates local model-call cache metrics from provider prompt-cache metrics", () => {
    const fresh = scoreEvalRun({
      name: "fresh-cache-metrics",
      artifacts: { path: "unused" }
    }, {
      candidates: [],
      verification: [],
      finalSelection: [],
      finalFindings: [],
      packets: [],
      hintEvents: [],
      metricsSources: {
        modelCallsSummary: {
          localModelCallCache: { hit: 2, miss: 1, disabled: 0, write: 1 },
          providerPromptCache: { readTokens: 100, writeTokens: 4, readCostUSD: 0.003, writeCostUSD: 0.004 }
        }
      }
    }, "live");

    expect(fresh.metrics).toMatchObject({
      localModelCallCacheHits: 2,
      localModelCallCacheMisses: 1,
      localModelCallCacheWrites: 1,
      providerPromptCacheReadTokens: 100,
      providerPromptCacheWriteTokens: 4,
      providerPromptCacheReadCostUSD: 0.003,
      providerPromptCacheWriteCostUSD: 0.004,
      cacheHits: 2,
      cacheMisses: 1
    });

    const costProfileOnly = scoreEvalRun({
      name: "cost-profile-cache-metrics",
      artifacts: { path: "unused" }
    }, {
      candidates: [],
      verification: [],
      finalSelection: [],
      finalFindings: [],
      packets: [],
      hintEvents: [],
      metricsSources: {
        costProfile: {
          localModelCallCache: { hit: 4, miss: 6, disabled: 0, write: 2 },
          costBreakdown: {
            providerPromptCacheRead: { tokens: 77, costUSD: 0.007 },
            providerPromptCacheWrite: { tokens: 8, costUSD: 0.008 }
          }
        }
      }
    }, "live");

    expect(costProfileOnly.metrics).toMatchObject({
      localModelCallCacheHits: 4,
      localModelCallCacheMisses: 6,
      localModelCallCacheWrites: 2,
      providerPromptCacheReadTokens: 77,
      providerPromptCacheWriteTokens: 8,
      providerPromptCacheReadCostUSD: 0.007,
      providerPromptCacheWriteCostUSD: 0.008
    });

    const legacy = scoreEvalRun({
      name: "legacy-cache-metrics",
      artifacts: { path: "unused" }
    }, {
      candidates: [],
      verification: [],
      finalSelection: [],
      finalFindings: [],
      packets: [],
      hintEvents: [],
      metricsSources: {
        modelCallsSummary: {
          cache: { hit: 3, miss: 2, disabled: 0, write: 1 },
          cacheReadTokens: 44,
          cacheWriteTokens: 5,
          cacheReadCostUSD: 0.1,
          cacheWriteCostUSD: 0.2
        }
      }
    }, "replay");

    expect(legacy.metrics).toMatchObject({
      localModelCallCacheHits: 3,
      localModelCallCacheMisses: 2,
      localModelCallCacheWrites: 1,
      providerPromptCacheReadTokens: 44,
      providerPromptCacheWriteTokens: 5,
      providerPromptCacheReadCostUSD: 0.1,
      providerPromptCacheWriteCostUSD: 0.2,
      cacheHits: 3,
      cacheMisses: 2
    });
  });

  it("scores and renders recovered schema-invalid telemetry distinctly from raw call status", () => {
    const score = scoreEvalRun({
      name: "schema-recovery-metrics",
      artifacts: { path: "unused" }
    }, {
      candidates: [],
      verification: [],
      finalSelection: [],
      finalFindings: [],
      packets: [],
      hintEvents: [],
      metricsSources: {
        modelCallsSummary: {
          totalCalls: 4,
          schemaInvalidCalls: 2,
          schemaRecovery: {
            schemaInvalidCalls: 2,
            schemaInvalidRecovered: 2,
            schemaInvalidUnrecovered: 0,
            schemaRepairAttempts: 1,
            schemaRepairRecovered: 1,
            deterministicSchemaRecovered: 1,
            schemaRecoveryFailed: 0
          }
        }
      }
    }, "live");

    expect(score.metrics).toMatchObject({
      modelCalls: 4,
      schemaInvalidCalls: 2,
      schemaInvalidRecovered: 2,
      schemaInvalidUnrecovered: 0,
      schemaRepairAttempts: 1,
      schemaRepairRecovered: 1,
      deterministicSchemaRecovered: 1,
      schemaRecoveryFailed: 0
    });

    const rendered = renderCaseResult({
      caseName: "schema-recovery-metrics",
      runDir: "unused",
      status: score.status,
      info: evalRunInfoWithMetrics(1, score.metrics)
    });
    expect(rendered).toContain("schema recovered 2/2");
  });
});

describe("eval compare", () => {
  it("renders explicit cache metric names and hides duplicate legacy aliases when available", () => {
    const previous = evalRunInfoWithMetrics(1, {
      cacheHits: 1,
      cacheMisses: 5,
      providerPromptCacheReadTokens: 0,
      providerPromptCacheWriteTokens: 0
    });
    const current = evalRunInfoWithMetrics(2, {
      localModelCallCacheHits: 3,
      localModelCallCacheMisses: 2,
      cacheHits: 3,
      cacheMisses: 2,
      providerPromptCacheReadTokens: 100,
      providerPromptCacheWriteTokens: 4
    });

    const report = compareToPrevious(
      { info: current, finalFindings: [] },
      { info: previous, finalFindings: [] }
    );
    const text = renderEvalCompareText(report);

    expect(report.metricDeltas.cacheHits).toBeUndefined();
    expect(report.metricDeltas.localModelCallCacheHits).toMatchObject({ previous: 1, current: 3, delta: 2 });
    expect(text).toContain("Cache metrics:");
    expect(text).toContain("local model-call cache hits: 1 -> 3 (+2)");
    expect(text).toContain("local model-call cache misses: 5 -> 2 (-3)");
    expect(text).toContain("provider prompt cache read tokens: 0 -> 100 (+100)");
    expect(text).not.toContain("cacheHits");
  });
});

describe("eval artifacts", () => {
  it("loads packet ids from top-level hint telemetry events", async () => {
    const telemetry = mkdtempSync(path.join(tmpdir(), "codegenie-hints-"));
    writeArtifactSet(telemetry, [], []);
    writeFileSync(path.join(telemetry, "events.jsonl"), `${JSON.stringify({
      runId: "run",
      eventId: "ev-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      stage: 7,
      level: "info",
      message: "follow_up_hint",
      packetId: "packet-top-level",
      data: {
        question: "Check this path",
        files: ["src/app.ts"],
        symbols: [],
        confidence: "medium"
      }
    })}\n`);

    const artifacts = await loadEvalArtifacts(telemetry);

    expect(artifacts.hintEvents[0]).toMatchObject({ packetId: "packet-top-level" });
  });

  it("loads pre-layout-v2 artifacts stored at the telemetry root", async () => {
    const telemetry = mkdtempSync(path.join(tmpdir(), "codegenie-old-layout-"));
    const candidates = [candidate("cand-1", "src/app.ts", 3)];
    const finalFindings = [finalFinding("final-1", "src/app.ts", 3)];
    writeFileSync(path.join(telemetry, "candidate-findings.json"), JSON.stringify(candidates));
    writeFileSync(path.join(telemetry, "final-findings.json"), JSON.stringify(finalFindings));
    writeFileSync(path.join(telemetry, "verification.json"), JSON.stringify([]));
    writeFileSync(path.join(telemetry, "events.jsonl"), "");

    const artifacts = await loadEvalArtifacts(telemetry);

    expect(artifacts.candidates).toHaveLength(1);
    expect(artifacts.finalFindings).toHaveLength(1);
    expect(artifacts.missingArtifacts).toEqual([]);
  });

  it("discloses unreadable previous findings in compare reports", () => {
    const info = (runNumber: number): EvalRunInfo => ({
      runNumber,
      caseName: "case",
      caseHash: "hash",
      mode: "live",
      cache: { enabled: false, source: "cli" },
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
      score: {
        status: "pass",
        expectationResults: [],
        budgetResults: [],
        violations: [],
        nearViolations: [],
        metrics: {
          reportedFindings: 0,
          inlineFindings: 0,
          summaryOnlyFindings: 0,
          suppressedFindings: 0,
          candidateFindings: 0,
          duplicateGroups: 0
        }
      }
    } as unknown as EvalRunInfo);

    const report = compareToPrevious(
      { info: info(2), finalFindings: [finalFinding("final-1", "src/app.ts", 3)] },
      { info: info(1), finalFindings: [], findingsUnreadable: true }
    );

    expect(report.previousFindingsUnreadable).toBe(true);
    const text = renderEvalCompareText(report);
    expect(text).toContain("Previous findings unreadable");
  });

  it("tolerates missing scoring artifacts instead of crashing, and discloses them", async () => {
    const telemetry = mkdtempSync(path.join(tmpdir(), "codegenie-missing-artifacts-"));
    writeFileSync(path.join(telemetry, "events.jsonl"), "");

    const artifacts = await loadEvalArtifacts(telemetry);

    expect(artifacts.candidates).toEqual([]);
    expect(artifacts.finalFindings).toEqual([]);
    expect(artifacts.missingArtifacts).toEqual(
      expect.arrayContaining(["candidate-findings.json", "final-findings.json"])
    );
  });

  it("loads canonical staged artifacts and root telemetry streams", async () => {
    const telemetry = mkdtempSync(path.join(tmpdir(), "codegenie-staged-artifacts-"));
    const candidates = [candidate("cand-1", "src/app.ts", 3)];
    const finalFindings = [finalFinding("final-1", "src/app.ts", 3)];
    writeArtifactSet(telemetry, candidates, finalFindings);
    writeTelemetryArtifact(telemetry, "review-plan.json", { coverage: [{ hunkId: "h1", path: "src/app.ts", coverage: "normal" }] });
    writeTelemetryArtifact(telemetry, "coverage.json", { status: { totalHunks: 1, reviewedHunks: 1 }, records: [{ hunkId: "h1" }] });
    writeTelemetryArtifact(telemetry, "packets/packet-1.json", { id: "packet-1", filePath: "src/app.ts" });
    writeTelemetryArtifact(telemetry, "cost-profile.json", { totalCostUSD: 1.23 });
    writeTelemetryArtifact(telemetry, "model-calls-summary.json", { totalCalls: 2 });
    writeTelemetryArtifact(telemetry, "tool-calls-summary.json", { totalCalls: 3 });
    writeTelemetryArtifact(telemetry, "budget-summary.json", { usage: { total: 4 } });
    writeFileSync(path.join(telemetry, "run.json"), "{\"runId\":\"run-1\"}\n");
    writeFileSync(path.join(telemetry, "telemetry.json"), "{\"events\":1}\n");
    writeFileSync(path.join(telemetry, "model-calls.jsonl"), "{\"callId\":\"mc-1\"}\n");
    writeFileSync(path.join(telemetry, "tool-calls.jsonl"), "{\"toolCallId\":\"tc-1\"}\n");
    writeFileSync(path.join(telemetry, "events.jsonl"), `${JSON.stringify({
      runId: "run-1",
      eventId: "ev-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      stage: 7,
      level: "info",
      message: "uncertainty",
      data: { question: "Check staged event", files: ["src/app.ts"], symbols: [] }
    })}\n`);

    const artifacts = await loadEvalArtifacts(telemetry);

    expect(artifacts.candidates).toHaveLength(1);
    expect(artifacts.finalFindings).toHaveLength(1);
    expect(artifacts.finalSelection).toHaveLength(1);
    expect(artifacts.verification).toHaveLength(1);
    expect(artifacts.reviewPlan).toMatchObject({ coverage: [expect.objectContaining({ hunkId: "h1" })] });
    expect(artifacts.coverage).toMatchObject({ totalHunks: 1, hunks: [expect.objectContaining({ hunkId: "h1" })] });
    expect(artifacts.packets).toEqual([expect.objectContaining({ id: "packet-1" })]);
    expect(artifacts.hintEvents).toEqual([expect.objectContaining({ question: "Check staged event" })]);
    expect(artifacts.metricsSources).toMatchObject({
      costProfile: { totalCostUSD: 1.23 },
      modelCallsSummary: { totalCalls: 2 },
      toolCallsSummary: { totalCalls: 3 },
      budgetSummary: { usage: { total: 4 } },
      runJson: { runId: "run-1" },
      telemetry: { events: 1 },
      modelCalls: [{ callId: "mc-1" }],
      toolCalls: [{ toolCallId: "tc-1" }]
    });
  });
});

describe("artifact replay", () => {
  it("re-scores saved artifacts, writes a new run, and compares to the previous run", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-replay-suite-"));
    const logsDir = path.join(suiteDir, "logs");
    const sourceRun = path.join(logsDir, "1");
    const telemetry = path.join(sourceRun, "telemetry");
    mkdirSync(telemetry, { recursive: true });
    const evalCase: EvalCase = {
      name: "replay-case",
      artifacts: { path: "logs/1" },
      should_find: [{ id: "reported", path: "src/app.ts", titlePattern: "Fake" }]
    };
    writeFileSync(path.join(suiteDir, "case.yml"), [
      "name: replay-case",
      "artifacts:",
      "  path: logs/1",
      "should_find:",
      "  - id: reported",
      "    path: src/app.ts",
      "    titlePattern: Fake"
    ].join("\n"));
    writeArtifactSet(telemetry, [candidate("cand-1", "src/app.ts", 3)], [finalFinding("final-1", "src/app.ts", 3)]);
    const sourceInfo: EvalRunInfo = {
      runNumber: 1,
      caseName: "replay-case",
      caseFile: "case.yml",
      caseHash: "old",
      caseSnapshot: evalCase,
      mode: "replay",
      cache: { enabled: false, source: "config", dir: ".codegenie/cache" },
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      score: passingScore()
    };
    writeFileSync(path.join(sourceRun, "info.json"), `${JSON.stringify(sourceInfo, null, 2)}\n`);

    const result = await replayFromArtifacts(sourceRun, { config: defaultConfig });

    expect(result.status).toBe("pass");
    expect(result.info.runNumber).toBe(2);
    expect(result.info.replay).toMatchObject({ caseSource: "yaml" });
    expect(existsSync(path.join(logsDir, "2", "compare-to-previous.json"))).toBe(true);
    const info = JSON.parse(readFileSync(path.join(logsDir, "2", "info.json"), "utf8")) as EvalRunInfo;
    expect(info.score.expectationResults[0]).toMatchObject({ status: "pass", fromReplayedArtifacts: true });
  });

  it("errors --from-artifacts replay for old root-level artifact layouts", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-old-layout-replay-"));
    const logsDir = path.join(suiteDir, "logs");
    const sourceRun = path.join(logsDir, "1");
    const telemetry = path.join(sourceRun, "telemetry");
    mkdirSync(telemetry, { recursive: true });
    const evalCase: EvalCase = {
      name: "old-layout-replay",
      artifacts: { path: "logs/1" },
      should_find: [{ id: "reported", path: "src/app.ts", titlePattern: "Reported" }]
    };
    writeFileSync(path.join(suiteDir, "case.yml"), [
      "name: old-layout-replay",
      "artifacts:",
      "  path: logs/1",
      "should_find:",
      "  - id: reported",
      "    path: src/app.ts",
      "    titlePattern: Reported"
    ].join("\n"));
    writeFileSync(path.join(telemetry, "candidate-findings.json"), "[]\n");
    writeFileSync(path.join(telemetry, "final-findings.json"), "[]\n");
    writeFileSync(path.join(telemetry, "verification.json"), "[]\n");
    writeFileSync(path.join(telemetry, "final-selection.json"), "{\"records\":[],\"groups\":[]}\n");
    writeFileSync(path.join(sourceRun, "info.json"), `${JSON.stringify({
      runNumber: 1,
      caseName: "old-layout-replay",
      caseFile: "case.yml",
      caseHash: "old",
      caseSnapshot: evalCase,
      mode: "replay",
      cache: { enabled: false, source: "config", dir: ".codegenie/cache" },
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      score: passingScore()
    } satisfies EvalRunInfo, null, 2)}\n`);

    const result = await replayFromArtifacts(sourceRun, { config: defaultConfig });

    expect(result.status).toBe("error");
    expect(result.info.score.error?.message).toContain("old layout unsupported");
    expect(existsSync(path.join(logsDir, "2", "info.json"))).toBe(true);
  });

  it("writes compare artifacts for errored case regressions", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-error-compare-"));
    const logsDir = path.join(suiteDir, "logs");
    const sourceRun = path.join(logsDir, "1");
    const telemetry = path.join(sourceRun, "telemetry");
    mkdirSync(telemetry, { recursive: true });
    writeArtifactSet(telemetry, [candidate("cand-1", "src/app.ts", 3)], [finalFinding("final-1", "src/app.ts", 3)]);
    const evalCase: EvalCase = {
      name: "error-case",
      repo: { fixture: "missing-repo" },
      should_find: [{ id: "reported", path: "src/app.ts" }]
    };
    writeFileSync(path.join(sourceRun, "info.json"), `${JSON.stringify({
      runNumber: 1,
      caseName: "error-case",
      caseFile: "error.yml",
      caseHash: "old",
      caseSnapshot: evalCase,
      mode: "live",
      cache: { enabled: false, source: "config", dir: ".codegenie/cache" },
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      score: passingScore()
    } satisfies EvalRunInfo, null, 2)}\n`);
    writeFileSync(path.join(suiteDir, "error.yml"), [
      "name: error-case",
      "repo:",
      "  fixture: missing-repo",
      "should_find:",
      "  - id: reported",
      "    path: src/app.ts"
    ].join("\n"));

    const suite = await loadEvalSuite(suiteDir);
    const result = await runEvalCase(suite, suite.cases[0]!, { config: defaultConfig });

    expect(result.status).toBe("error");
    expect(existsSync(path.join(logsDir, "2", "compare-to-previous.json"))).toBe(true);
    const compare = JSON.parse(readFileSync(path.join(logsDir, "2", "compare-to-previous.json"), "utf8")) as {
      statusChange?: { from: string; to: string };
    };
    expect(compare.statusChange).toEqual({ from: "pass", to: "error" });
  });

  it("persists errored --from-artifacts replay runs when required artifacts are missing", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-replay-error-"));
    const logsDir = path.join(suiteDir, "logs");
    const sourceRun = path.join(logsDir, "1");
    const telemetry = path.join(sourceRun, "telemetry");
    mkdirSync(telemetry, { recursive: true });
    writeTelemetryArtifact(telemetry, "candidate-findings.json", []);
    const evalCase: EvalCase = {
      name: "broken-replay",
      artifacts: { path: "logs/1" },
      should_find: [{ id: "reported", path: "src/app.ts" }]
    };
    writeFileSync(path.join(sourceRun, "info.json"), `${JSON.stringify({
      runNumber: 1,
      caseName: "broken-replay",
      caseHash: "old",
      caseSnapshot: evalCase,
      mode: "replay",
      cache: { enabled: false, source: "config", dir: ".codegenie/cache" },
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      score: passingScore()
    } satisfies EvalRunInfo, null, 2)}\n`);

    const result = await replayFromArtifacts(sourceRun, { config: defaultConfig });

    expect(result.status).toBe("error");
    expect(existsSync(path.join(logsDir, "2", "info.json"))).toBe(true);
    expect(existsSync(path.join(logsDir, "2", "compare-to-previous.json"))).toBe(true);
    const info = JSON.parse(readFileSync(path.join(logsDir, "2", "info.json"), "utf8")) as EvalRunInfo;
    expect(info.replay).toMatchObject({ sourceArtifacts: sourceRun, caseSource: "snapshot" });
    const compare = JSON.parse(readFileSync(path.join(logsDir, "2", "compare-to-previous.json"), "utf8")) as {
      statusChange?: { from: string; to: string };
    };
    expect(compare.statusChange).toEqual({ from: "pass", to: "error" });
  });

  it("records replay source metadata for errored artifact-backed suite cases", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-artifact-error-source-"));
    const artifactRun = path.join(suiteDir, "artifacts", "broken");
    mkdirSync(path.join(artifactRun, "telemetry"), { recursive: true });
    writeTelemetryArtifact(path.join(artifactRun, "telemetry"), "candidate-findings.json", []);
    writeFileSync(path.join(suiteDir, "broken.yml"), [
      "name: broken-artifact",
      "artifacts:",
      "  path: artifacts/broken",
      "should_find:",
      "  - id: expected",
      "    path: src/app.ts"
    ].join("\n"));

    const suite = await loadEvalSuite(suiteDir);
    const result = await runEvalCase(suite, suite.cases[0]!, { config: defaultConfig });

    expect(result.status).toBe("error");
    expect(result.info.replay).toEqual({ sourceArtifacts: artifactRun, caseSource: "yaml" });
  });
});

describe("eval command fixture suite", () => {
  it("ships repo-backed fake-runner cases in the public fixture suite", async () => {
    const suite = await loadEvalSuite(path.join(process.cwd(), "evals", "fixtures"));

    expect(suite.cases.map((entry) => entry.evalCase.name).sort()).toEqual([
      "fixture-core-lens",
      "fixture-go-lens",
      "fixture-python-lens",
      "fixture-rust-lens",
      "fixture-solidity-lens",
      "fixture-tests-lens",
      "fixture-typescript-lens"
    ]);
    for (const entry of suite.cases) {
      expect(entry.evalCase.artifacts).toBeUndefined();
      expect(entry.evalCase.repo?.fixture).toMatch(/^repos\//u);
      expect(entry.evalCase.review).toMatchObject({ provider: "fake", model: "fake-model" });
    }
    expect(suite.cases.find((entry) => entry.evalCase.name === "fixture-rust-lens")?.evalCase.should_not_find).toEqual([
      expect.objectContaining({ id: "rust-marker-free-negative-control", path: "src/negative.rs" })
    ]);
    expect(suite.cases.find((entry) => entry.evalCase.name === "fixture-python-lens")?.evalCase.should_not_find).toEqual([
      expect.objectContaining({ id: "python-marker-free-negative-control", path: "src/negative.py" })
    ]);
    expect(suite.cases.find((entry) => entry.evalCase.name === "fixture-solidity-lens")?.evalCase.should_not_find).toEqual([
      expect.objectContaining({ id: "solidity-marker-free-negative-control", path: "contracts/Negative.sol" })
    ]);
    expect(findNestedGitDirs(path.join(process.cwd(), "evals", "fixtures", "repos"))).toEqual([]);
  });

  it("materializes public fixture source dirs into live fake-runner repos", async () => {
    const sourceDir = path.join(process.cwd(), "evals", "fixtures");
    const suiteDir = path.join(mkdtempSync(path.join(tmpdir(), "codegenie-public-fixtures-")), "fixtures");
    cpSync(sourceDir, suiteDir, {
      recursive: true,
      filter: (source) =>
        path.basename(source) !== ".git" &&
        path.basename(source) !== "logs" &&
        !source.includes(`${path.sep}.git${path.sep}`) &&
        !source.includes(`${path.sep}logs${path.sep}`)
    });

    let output = "";
    const exitCode = await runEvalCommand({ evalDir: suiteDir, cache: false }, defaultConfig, {
      writeOutput: (text) => {
        output += text;
      }
    });

    expect(exitCode).toBe(0);
    expect(output).toContain("Suite: 7 passed, 0 failed, 0 errored");
    expect(existsSync(path.join(suiteDir, "logs", "1", "fixture-repo", ".git"))).toBe(true);
  }, 60_000);

  it("does not leak the invocation directory repo config into live cases", async () => {
    const invocationDir = mkdtempSync(path.join(tmpdir(), "codegenie-eval-invocation-"));
    const home = mkdtempSync(path.join(tmpdir(), "codegenie-eval-home-"));
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-eval-leak-suite-"));
    const repo = initRepo();
    writeFileSync(path.join(invocationDir, "codegenie.toml"), [
      "[[classification.pathRules]]",
      "pattern = \"src/app.js\"",
      "processingMode = \"skip\"",
      "reason = \"this cwd policy must not affect eval cases\""
    ].join("\n"));
    writeRepoFile(repo, "src/app.js", "export const base = true;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "src/app.js", "export const value = 'CODEGENIE_FAKE_FINDING';\n");
    commitAll(repo, "feature");
    writeFileSync(path.join(suiteDir, "case.yml"), [
      "name: no-cwd-config-leak",
      "repo:",
      `  external: ${JSON.stringify(repo)}`,
      "command:",
      "  branch: feature",
      "  base: main",
      "review:",
      "  provider: fake",
      "  model: fake-model",
      "  cache: false",
      "  lenses:",
      "    - core/code-review",
      "should_find:",
      "  - id: fake-finding",
      "    path: src/app.js",
      "    titlePattern: Fake finding"
    ].join("\n"));

    let output = "";
    const exitCode = await executeEvalCommand(["eval", "--eval-dir", suiteDir, "--no-cache"], {
      repoRoot: invocationDir,
      homeOverride: home,
      writeOutput: (text) => {
        output += text;
      }
    });

    expect(exitCode).toBe(0);
    expect(output).toContain("no-cwd-config-leak run 1: pass");
  }, 60_000);

  it("uses the supplied config as the base layer for live cases", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-config-live-suite-"));
    const repo = initRepo();
    writeRepoFile(repo, "src/app.js", "export const base = true;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "src/app.js", "export const value = 'CODEGENIE_FAKE_FINDING';\n");
    commitAll(repo, "feature");
    writeFileSync(path.join(suiteDir, "config-live.yml"), [
      "name: config-live",
      "repo:",
      `  external: ${JSON.stringify(repo)}`,
      "command:",
      "  branch: feature",
      "  base: main",
      "review:",
      "  lenses:",
      "    - core/code-review",
      "should_find:",
      "  - id: fake-finding",
      "    path: src/app.js",
      "    titlePattern: Fake finding"
    ].join("\n"));

    const config = {
      ...defaultConfig,
      llm: { ...defaultConfig.llm, provider: "fake", model: "fake-model" },
      cache: { ...defaultConfig.cache, enabled: true }
    };
    const suite = await loadEvalSuite(suiteDir);
    const result = await runEvalCase(suite, suite.cases[0]!, { config });

    expect(result.status).toBe("pass");
    expect(result.info.cache).toMatchObject({ enabled: true, source: "config" });
  });

  it("applies eval llm overrides over legacy review llm fields and records effective concurrency", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-eval-llm-override-suite-"));
    const repo = initRepo();
    writeRepoFile(repo, "src/app.js", "export const base = true;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "src/app.js", "export const value = 'CODEGENIE_FAKE_FINDING';\n");
    commitAll(repo, "feature");
    writeFileSync(path.join(suiteDir, "llm-override.yml"), [
      "name: llm-override",
      "repo:",
      `  external: ${JSON.stringify(repo)}`,
      "command:",
      "  branch: feature",
      "  base: main",
      "review:",
      "  provider: not-real",
      "  model: not-real-model",
      "  reasoning: low",
      "  concurrency: 3",
      "  lenses:",
      "    - core/code-review",
      "llm:",
      "  provider: fake",
      "  model: fake-model",
      "  reasoning: high",
      "  maxConcurrentCalls: 2",
      "should_find:",
      "  - id: fake-finding",
      "    path: src/app.js",
      "    titlePattern: Fake finding"
    ].join("\n"));

    const suite = await loadEvalSuite(suiteDir);
    const config = {
      ...defaultConfig,
      llm: { ...defaultConfig.llm, provider: "not-real", model: "not-real-model", maxConcurrentCalls: 1 },
      review: { ...defaultConfig.review, concurrency: 1 }
    };
    const result = await runEvalCase(suite, suite.cases[0]!, { config });

    expect(result.status).toBe("pass");
    expect(result.info.effectiveConfig).toMatchObject({
      review: { concurrency: 3 },
      llm: { provider: "fake", model: "fake-model", reasoning: "high", maxConcurrentCalls: 2 }
    });
    expect(result.info.codegenieRuntime).toMatchObject({
      packageVersion: expect.any(String),
      source: expect.stringMatching(/^(build_env|git|package|unknown)$/)
    });
    const runJson = JSON.parse(readFileSync(path.join(result.runDir, "telemetry", "run.json"), "utf8")) as {
      runId: string;
      codegenieRuntime: { packageVersion: string };
      codegenieVersion: string;
      review: { concurrency: number; llmMaxConcurrentCalls: number };
    };
    expect(result.info.reviewRunId).toBe(runJson.runId);
    expect(result.info.reviewRunId).not.toBe("telemetry");
    expect(runJson.codegenieRuntime.packageVersion).toBe(runJson.codegenieVersion);
    expect(runJson.review).toMatchObject({ concurrency: 3, llmMaxConcurrentCalls: 2 });
    const events = readJsonl(path.join(result.runDir, "telemetry", "events.jsonl"));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "concurrency_mismatch",
        data: expect.objectContaining({
          reviewConcurrency: 3,
          llmMaxConcurrentCalls: 2
        })
      })
    ]));
    expect(renderCaseResult(result)).toContain("concurrency 3 workers/2 provider calls");
  }, 60_000);

  it("does not emit concurrency mismatch telemetry when provider slots match workers", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-eval-concurrency-match-suite-"));
    const repo = initRepo();
    writeRepoFile(repo, "src/app.js", "export const base = true;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "src/app.js", "export const value = 'CODEGENIE_FAKE_FINDING';\n");
    commitAll(repo, "feature");
    writeFileSync(path.join(suiteDir, "concurrency-match.yml"), [
      "name: concurrency-match",
      "repo:",
      `  external: ${JSON.stringify(repo)}`,
      "command:",
      "  branch: feature",
      "  base: main",
      "review:",
      "  concurrency: 2",
      "  lenses:",
      "    - core/code-review",
      "llm:",
      "  provider: fake",
      "  model: fake-model",
      "  maxConcurrentCalls: 2",
      "should_find:",
      "  - id: fake-finding",
      "    path: src/app.js",
      "    titlePattern: Fake finding"
    ].join("\n"));

    const suite = await loadEvalSuite(suiteDir);
    const result = await runEvalCase(suite, suite.cases[0]!, { config: defaultConfig });

    expect(result.status).toBe("pass");
    const events = readJsonl(path.join(result.runDir, "telemetry", "events.jsonl"));
    expect(events.some((event) => isTelemetryMessage(event, "concurrency_mismatch"))).toBe(false);
    expect(renderCaseResult(result)).toContain("concurrency 2 workers/2 provider calls");
  }, 60_000);

  it("records eval llm overrides on live eval errors after case config is applied", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-eval-llm-error-suite-"));
    const repo = initRepo();
    writeRepoFile(repo, "src/app.js", "export const base = true;\n");
    commitAll(repo, "base");
    writeFileSync(path.join(suiteDir, "llm-error.yml"), [
      "name: llm-error",
      "repo:",
      `  external: ${JSON.stringify(repo)}`,
      "command:",
      "  branch: missing-branch",
      "  base: main",
      "review:",
      "  concurrency: 2",
      "  cache: false",
      "llm:",
      "  provider: fake",
      "  model: fake-model",
      "  reasoning: high",
      "  maxConcurrentCalls: 3",
      "should_find:",
      "  - id: fake-finding",
      "    path: src/app.js",
      "    titlePattern: Fake finding"
    ].join("\n"));

    const suite = await loadEvalSuite(suiteDir);
    const config = {
      ...defaultConfig,
      llm: { ...defaultConfig.llm, provider: "not-real", model: "not-real-model", maxConcurrentCalls: 1 },
      review: { ...defaultConfig.review, concurrency: 1 },
      cache: { ...defaultConfig.cache, enabled: true }
    };
    const result = await runEvalCase(suite, suite.cases[0]!, { config });

    expect(result.status).toBe("error");
    expect(result.info.effectiveConfig).toMatchObject({
      review: { concurrency: 2 },
      llm: { provider: "fake", model: "fake-model", reasoning: "high", maxConcurrentCalls: 3 }
    });
    expect(result.info.cache).toMatchObject({ enabled: false, source: "case" });
  });

  it("applies the reviewed repository codegenie.toml layer before eval YAML overrides", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-repo-config-suite-"));
    const repo = initRepo();
    writeRepoFile(repo, "src/app.js", "export const base = true;\n");
    writeRepoFile(repo, "codegenie.toml", [
      "[[classification.pathRules]]",
      "pattern = \"src/app.js\"",
      "processingMode = \"skip\"",
      "reason = \"repo policy skip\""
    ].join("\n"));
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "src/app.js", "export const value = 'CODEGENIE_FAKE_FINDING';\n");
    commitAll(repo, "feature");
    writeFileSync(path.join(suiteDir, "repo-config.yml"), [
      "name: repo-config",
      "repo:",
      `  external: ${JSON.stringify(repo)}`,
      "command:",
      "  branch: feature",
      "  base: main",
      "expect:",
      "  maxFindings: 1"
    ].join("\n"));

    const config = {
      ...defaultConfig,
      llm: { ...defaultConfig.llm, provider: "fake", model: "fake-model" }
    };
    const suite = await loadEvalSuite(suiteDir);
    const result = await runEvalCase(suite, suite.cases[0]!, { config });

    expect(result.status).toBe("pass");
    expect(result.info.score.metrics.reportedFindings).toBe(0);
  });

  it("runs fixture-backed fake-provider cases for core, tests, Go, and TypeScript lenses", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-fixture-suite-"));
    const cases = [
      { name: "core-lens", file: "src/app.js", lens: "core/code-review", body: "export const value = 'CODEGENIE_FAKE_FINDING';\n" },
      { name: "tests-lens", file: "src/app.test.ts", lens: "core/tests", body: "test('x', () => { const value = 'CODEGENIE_FAKE_FINDING'; });\n" },
      { name: "go-lens", file: "service/main.go", lens: "lang/go", body: "package main\n\nfunc main() { _ = \"CODEGENIE_FAKE_FINDING\" }\n" },
      { name: "typescript-lens", file: "src/app.ts", lens: "lang/typescript", body: "export const value: string = 'CODEGENIE_FAKE_FINDING';\n" }
    ];

    for (const evalCase of cases) {
      const repo = initRepo();
      writeRepoFile(repo, evalCase.file, "export const base = true;\n");
      commitAll(repo, "base");
      git(repo, ["checkout", "-b", "feature"]);
      writeRepoFile(repo, evalCase.file, evalCase.body);
      commitAll(repo, "feature");
      writeFileSync(path.join(suiteDir, `${evalCase.name}.yml`), [
        `name: ${evalCase.name}`,
        "repo:",
        `  external: ${JSON.stringify(repo)}`,
        "command:",
        "  branch: feature",
        "  base: main",
        "review:",
        "  provider: fake",
        "  model: fake-model",
        "  verify: true",
        "  cache: false",
        "  lenses:",
        `    - ${evalCase.lens}`,
        "expect:",
        "  minFindings: 1",
        "  maxFindings: 3",
        "should_find:",
        "  - id: fake-finding",
        `    path: ${evalCase.file}`,
        "    category: correctness",
        "    severityAtLeast: medium",
        "    titlePattern: Fake finding"
      ].join("\n"));
    }

    let output = "";
    const exitCode = await runEvalCommand({ evalDir: suiteDir, cache: false }, defaultConfig, {
      writeOutput: (text) => {
        output += text;
      }
    });

    expect(exitCode).toBe(0);
    expect(output).toContain("Suite: 4 passed, 0 failed, 0 errored");
  }, 60_000);
});

function writeArtifactSet(telemetryDir: string, candidates: CandidateFinding[], finalFindings: FinalFinding[]): void {
  writeTelemetryArtifact(telemetryDir, "candidate-findings.json", candidates);
  writeTelemetryArtifact(telemetryDir, "final-findings.json", finalFindings);
  writeTelemetryArtifact(telemetryDir, "verification.json", candidates.map((item) => ({
    candidateId: item.id,
    gate: "passed",
    verdict: { candidateId: item.id, verdict: "keep", reason: "ok", requiredEvidencePresent: true, falsePositiveRisk: "low" }
  })));
  writeTelemetryArtifact(telemetryDir, "final-selection.json", {
    records: finalFindings.flatMap((item) => item.mergedCandidateIds.map((id) => ({ findingId: id, decision: "published", reason: "composer-selected" }))),
    groups: []
  });
}

function writeTelemetryArtifact(telemetryDir: string, logicalName: string, data: unknown): void {
  const target = path.join(telemetryDir, canonicalArtifactPath(logicalName));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
}

describe("eval repeats (plan 79)", () => {
  const emptyArtifacts = (overrides: Partial<EvalArtifacts> = {}): EvalArtifacts => ({
    candidates: [],
    verification: [],
    finalSelection: [],
    finalFindings: [],
    packets: [],
    hintEvents: [],
    metricsSources: {},
    ...overrides
  });

  it("rejects repeat > 1 without cache: false and on artifact-backed cases", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-repeat-guard-"));
    writeFileSync(path.join(suiteDir, "guard.yml"), [
      "name: repeat-guard",
      "repeat: 3",
      "repo:",
      "  fixture: repo",
      "command:",
      "  branch: feature",
      "  base: main",
      "should_find:",
      "  - id: x",
      "    path: src/app.ts"
    ].join("\n"));

    await expect(loadEvalSuite(suiteDir)).rejects.toMatchObject({
      code: "config_error",
      context: expect.objectContaining({
        errors: expect.arrayContaining([expect.stringContaining("repeat > 1 requires review.cache: false")])
      })
    });

    const artifactsSuite = mkdtempSync(path.join(tmpdir(), "codegenie-repeat-artifacts-"));
    writeFileSync(path.join(artifactsSuite, "guard.yml"), [
      "name: repeat-artifacts",
      "repeat: 2",
      "review:",
      "  cache: false",
      "artifacts:",
      "  path: logs/1",
      "should_find:",
      "  - id: x",
      "    path: src/app.ts"
    ].join("\n"));

    await expect(loadEvalSuite(artifactsSuite)).rejects.toMatchObject({
      code: "config_error",
      context: expect.objectContaining({
        errors: expect.arrayContaining([expect.stringContaining("incompatible with artifact-backed cases")])
      })
    });
  });

  it("runs a repeated case N times with the fake provider and aggregates rates", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codegenie-repeat-live-"));
    const repo = initRepo();
    writeRepoFile(repo, "src/app.js", "export const base = true;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "src/app.js", "export const value = 'CODEGENIE_FAKE_FINDING';\n");
    commitAll(repo, "feature");
    writeFileSync(path.join(suiteDir, "repeat-live.yml"), [
      "name: repeat-live",
      "repeat: 3",
      "repo:",
      `  external: ${JSON.stringify(repo)}`,
      "command:",
      "  branch: feature",
      "  base: main",
      "review:",
      "  provider: fake",
      "  model: fake-model",
      "  cache: false",
      "  lenses:",
      "    - core/code-review",
      "should_find:",
      "  - id: fake-finding",
      "    path: src/app.js",
      "    titlePattern: Fake finding"
    ].join("\n"));

    const suite = await loadEvalSuite(suiteDir);
    const result = await runEvalCase(suite, suite.cases[0]!, { config: defaultConfig });

    expect(result.status).toBe("pass");
    expect(result.info.repeats).toMatchObject({
      repeat: 3,
      totals: expect.objectContaining({ errors: 0 })
    });
    expect(result.info.repeats?.executions.map((execution) => execution.status)).toEqual(["pass", "pass", "pass"]);
    const aggregate = result.info.repeats?.expectations.find((entry) => entry.expectationId === "fake-finding");
    expect(aggregate).toMatchObject({
      finalMatched: 3,
      finalRecallRate: 1,
      fingerprintsStable: true
    });
    for (const k of [1, 2, 3]) {
      expect(existsSync(path.join(result.runDir, "repeats", String(k), "telemetry"))).toBe(true);
      expect(existsSync(path.join(result.runDir, "repeats", String(k), "score.json"))).toBe(true);
    }
    expect(existsSync(path.join(result.runDir, "eval-aggregate.json"))).toBe(true);
    expect(renderCaseResult(result)).toContain("finalRecall 3/3 (1.00)");
  }, 60_000);

  it("aggregates recall rates, notes, and threshold gates across executions", () => {
    const evalCase: EvalCase = {
      name: "agg",
      repo: { external: "/tmp/unused" },
      should_find: [{ id: "wc", path: "src/app.ts", titlePattern: "stale value", minRecallRate: 0.5 }]
    };
    const matchingFinal = finalFinding("final-1", "src/app.ts", 4, { title: "stale value returned" });
    const matchingCandidate = candidate("cand-1", "src/app.ts", 4, { title: "stale value returned" });
    const passArtifacts = emptyArtifacts({ finalFindings: [matchingFinal], candidates: [matchingCandidate] });
    const candidateOnlyArtifacts = emptyArtifacts({ candidates: [matchingCandidate] });
    const noteArtifacts = emptyArtifacts({
      humanAttentionNotes: [{ question: "Does the changed path serve a stale value?", files: ["src/app.ts"], reasons: ["stale value risk"] }]
    });

    const executions = [
      { runDir: "repeats/1", score: scoreEvalRun(evalCase, passArtifacts, "live"), artifacts: passArtifacts },
      { runDir: "repeats/2", score: scoreEvalRun(evalCase, candidateOnlyArtifacts, "live"), artifacts: candidateOnlyArtifacts },
      { runDir: "repeats/3", score: scoreEvalRun(evalCase, noteArtifacts, "live"), artifacts: noteArtifacts }
    ];
    const { aggregate, score } = aggregateRepeatScores(evalCase, executions);

    const wc = aggregate.expectations.find((entry) => entry.expectationId === "wc");
    expect(wc).toMatchObject({
      finalMatched: 1,
      candidateMatched: 2,
      noteSurfaced: 1,
      fingerprintsStable: true,
      distinctFingerprints: 1
    });
    expect(wc?.finalRecallRate).toBeCloseTo(1 / 3);
    expect(wc?.noteRate).toBeCloseTo(1 / 3);
    expect(Object.values(wc?.lossHistogram ?? {}).reduce((sum, count) => sum + count, 0)).toBe(2);
    expect(wc?.gate).toMatchObject({ minRecallRate: 0.5, passed: false });
    expect(score.status).toBe("fail");

    const ungated: EvalCase = { ...evalCase, should_find: [{ id: "wc", path: "src/app.ts", titlePattern: "stale value" }] };
    const measuredOnly = aggregateRepeatScores(ungated, executions);
    expect(measuredOnly.score.status).toBe("pass");
    expect(measuredOnly.score.expectationResults[0]?.note).toContain("measured only");

    const boundary: EvalCase = { ...evalCase, should_find: [{ id: "wc", path: "src/app.ts", titlePattern: "stale value", minRecallRate: 1 / 3 }] };
    expect(aggregateRepeatScores(boundary, executions).score.status).toBe("pass");
  });

  it("marks a missed expectation that resurfaced as a human-attention note", () => {
    const score = scoreEvalRun(
      {
        name: "note-case",
        repo: { external: "/tmp/unused" },
        should_find: [{ id: "wc", path: "src/app.ts", titlePattern: "stale value" }]
      },
      emptyArtifacts({
        humanAttentionNotes: [{ question: "Is a stale value served here?", files: ["src/app.ts"], reasons: [] }]
      }),
      "live"
    );

    const result = score.expectationResults.find((entry) => entry.expectationId === "wc");
    expect(result?.status).toBe("fail");
    expect(result?.loss?.surfacedAsNote).toBe(true);
  });

  it("isolates the relay wrong-chain bug from the zero-guard and duration look-alikes", () => {
    const relayCase: EvalCase = {
      name: "relay-wc",
      repo: { external: "/tmp/unused" },
      should_find: [{
        id: "relay-gas-wrong-chain",
        path: "lib/routes/relay/relay.go",
        lineRange: [82, 105],
        category: "logic_bug",
        severityAtLeast: "medium",
        titlePattern: "(origin).*(destination)|destination chain",
        failureModePattern: "gas.*(origin).*(destination)|priced (on|via|using) .*origin|destination.*(fill|executes|chain)"
      }],
      should_not_find: [{
        id: "relay-gas-not-zero-guard",
        path: "lib/routes/relay/relay.go",
        lineRange: [82, 105],
        titlePattern: "chain 0|== 0|OriginChainID > 0|no rpc provider"
      }]
    };
    const wcFinding = finalFinding("wc", "lib/routes/relay/relay.go", 92, {
      title: "Relay fill gas priced on origin chain instead of destination chain",
      failureMode: "The fill executes on the destination chain but gas is priced on the origin chain via EstimateGasCostUSD(req.OriginChainID, ...).",
      category: "logic_bug",
      severity: "medium"
    });
    const zgFinding = finalFinding("zg", "lib/routes/relay/relay.go", 91, {
      title: "EstimateGasCostUSD errors when OriginChainID == 0",
      failureMode: "A zero origin chain id has no rpc provider and returns an error.",
      category: "correctness",
      severity: "low"
    });
    const durFinding = finalFinding("dur", "lib/routes/relay/relay.go", 61, {
      title: "defaultDurationSeconds increased from 10s to 30s",
      failureMode: "Snapshot durations now report 30 seconds via relayFillGasEstimate-adjacent constants.",
      category: "correctness",
      severity: "low"
    });

    const withWc = scoreEvalRun(relayCase, emptyArtifacts({ finalFindings: [wcFinding, durFinding] }), "live");
    expect(withWc.expectationResults.find((entry) => entry.expectationId === "relay-gas-wrong-chain")?.status).toBe("pass");
    expect(withWc.violations).toEqual([]);

    const withoutWc = scoreEvalRun(relayCase, emptyArtifacts({ finalFindings: [zgFinding, durFinding] }), "live");
    expect(withoutWc.expectationResults.find((entry) => entry.expectationId === "relay-gas-wrong-chain")?.status).toBe("fail");
    expect(withoutWc.violations).toEqual([
      expect.objectContaining({ expectationId: "relay-gas-not-zero-guard", findingId: "zg" })
    ]);
  });
});

function candidate(id: string, filePath: string, line: number, overrides: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    id,
    title: `Fake finding in ${filePath}`,
    severity: "medium",
    confidence: "high",
    path: filePath,
    anchor: { path: filePath, line, side: "RIGHT", hunkId: "h1" },
    changedLine: true,
    category: "correctness",
    evidence: { changedCode: "+ CODEGENIE_FAKE_FINDING" },
    failureMode: "The fake runner was asked to produce a deterministic finding for this changed line.",
    whyThisMatters: "It verifies eval scoring.",
    verification: "The trigger text appears in a changed line.",
    producedBy: { kind: "packet", stage: 7, packetId: "packet-1", lensId: "core/code-review", skillIds: [] },
    ...overrides
  };
}

function finalFinding(id: string, filePath: string, line: number, overrides: Partial<FinalFinding> = {}): FinalFinding {
  const base = candidate(id, filePath, line, overrides);
  return {
    ...base,
    fingerprint: `${filePath}:${line}:${id}`,
    finalBody: base.failureMode,
    publication: "inline",
    mergedCandidateIds: [id],
    ...overrides
  };
}

function passingScore(): EvalScore {
  return {
    status: "pass",
    expectationResults: [],
    budgetResults: [],
    violations: [],
    nearViolations: [],
    metrics: {
      reportedFindings: 1,
      inlineFindings: 1,
      summaryOnlyFindings: 0,
      suppressedFindings: 0,
      candidateFindings: 1,
      duplicateGroups: 0,
      stageLossCounts: {
        "missed-before-candidate-generation": 0,
        "lost-at-verification": 0,
        "lost-at-composition": 0,
        "partial-match": 0
      }
    }
  };
}

function evalRunInfoWithMetrics(runNumber: number, metrics: Partial<EvalRunMetrics>): EvalRunInfo {
  return {
    runNumber,
    caseName: "cache-compare",
    caseHash: "same",
    caseSnapshot: {
      name: "cache-compare",
      artifacts: { path: "unused" }
    },
    mode: "replay",
    cache: { enabled: false, source: "config", dir: ".codegenie/cache" },
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    score: {
      ...passingScore(),
      metrics: {
        ...passingScore().metrics,
        ...metrics
      }
    }
  };
}

function readJsonl(filePath: string): unknown[] {
  const raw = readFileSync(filePath, "utf8").trim();
  if (raw.length === 0) {
    return [];
  }
  return raw.split("\n").map((line) => JSON.parse(line) as unknown);
}

function isTelemetryMessage(value: unknown, message: string): boolean {
  return typeof value === "object" && value !== null && "message" in value && value.message === message;
}

function findNestedGitDirs(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory() && entry.name === ".git") {
      found.push(entryPath);
      continue;
    }
    if (entry.isDirectory()) {
      found.push(...findNestedGitDirs(entryPath));
    }
  }
  return found;
}
