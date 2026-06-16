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
import { assignExpectations, matchExpectation, scoreEvalRun } from "../src/evals/eval-scoring.js";
import type {
  CandidateFinding,
  EvalCase,
  EvalRunInfo,
  EvalRunMetrics,
  EvalScore,
  FinalFinding
} from "../src/types.js";
import { CodeninjaError } from "../src/util/errors.js";
import { commitAll, git, initRepo, writeRepoFile } from "./helpers/git.js";

describe("eval suite validation", () => {
  it("rejects unknown keys, duplicate expectation ids, and invalid source shapes", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codeninja-eval-suite-"));
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
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codeninja-eval-artifact-command-"));
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
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codeninja-eval-relative-external-"));
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
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codeninja-eval-budget-fields-"));
    writeFileSync(path.join(suiteDir, "budget.yml"), [
      "name: budget-fields",
      "artifacts:",
      "  path: logs/1",
      "review:",
      "  budgetMultiplier: 1.5",
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

    expect(suite.cases[0]?.evalCase.review?.budgetMultiplier).toBe(1.5);
    expect(suite.cases[0]?.evalCase.expect).toMatchObject({
      reviewCompleteness: "complete",
      maxBudgetOverruns: 0,
      maxToolBudgetRejections: 0,
      maxDegradedHunks: 0,
      maxUnresolvedNotesSuppressed: 0
    });
  });

  it("accepts eval llm overrides and preserves legacy review llm fields", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codeninja-eval-llm-fields-"));
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
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codeninja-eval-llm-invalid-"));
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
            { stage: 9, reason: "max_total_tokens", elapsedMs: 2, kind: "tokens", actual: 125, limit: 100, totalTokens: 125, modelCalls: 3, afterDispatchedCall: true }
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
        riskAreas: [],
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
    const telemetry = mkdtempSync(path.join(tmpdir(), "codeninja-hints-"));
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
});

describe("artifact replay", () => {
  it("re-scores saved artifacts, writes a new run, and compares to the previous run", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codeninja-replay-suite-"));
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
      cache: { enabled: false, source: "config", dir: ".codeninja/cache" },
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

  it("writes compare artifacts for errored case regressions", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codeninja-error-compare-"));
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
      cache: { enabled: false, source: "config", dir: ".codeninja/cache" },
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
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codeninja-replay-error-"));
    const logsDir = path.join(suiteDir, "logs");
    const sourceRun = path.join(logsDir, "1");
    const telemetry = path.join(sourceRun, "telemetry");
    mkdirSync(telemetry, { recursive: true });
    writeFileSync(path.join(telemetry, "candidate-findings.json"), "[]\n");
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
      cache: { enabled: false, source: "config", dir: ".codeninja/cache" },
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
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codeninja-artifact-error-source-"));
    const artifactRun = path.join(suiteDir, "artifacts", "broken");
    mkdirSync(path.join(artifactRun, "telemetry"), { recursive: true });
    writeFileSync(path.join(artifactRun, "telemetry", "candidate-findings.json"), "[]\n");
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
      "fixture-tests-lens",
      "fixture-typescript-lens"
    ]);
    for (const entry of suite.cases) {
      expect(entry.evalCase.artifacts).toBeUndefined();
      expect(entry.evalCase.repo?.fixture).toMatch(/^repos\//u);
      expect(entry.evalCase.review).toMatchObject({ provider: "fake", model: "fake-model" });
    }
    expect(findNestedGitDirs(path.join(process.cwd(), "evals", "fixtures", "repos"))).toEqual([]);
  });

  it("materializes public fixture source dirs into live fake-runner repos", async () => {
    const sourceDir = path.join(process.cwd(), "evals", "fixtures");
    const suiteDir = path.join(mkdtempSync(path.join(tmpdir(), "codeninja-public-fixtures-")), "fixtures");
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
    expect(output).toContain("Suite: 4 passed, 0 failed, 0 errored");
    expect(existsSync(path.join(suiteDir, "logs", "1", "fixture-repo", ".git"))).toBe(true);
  }, 60_000);

  it("does not leak the invocation directory repo config into live cases", async () => {
    const invocationDir = mkdtempSync(path.join(tmpdir(), "codeninja-eval-invocation-"));
    const home = mkdtempSync(path.join(tmpdir(), "codeninja-eval-home-"));
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codeninja-eval-leak-suite-"));
    const repo = initRepo();
    writeFileSync(path.join(invocationDir, "codeninja.toml"), [
      "[[classification.pathRules]]",
      "pattern = \"src/app.js\"",
      "processingMode = \"skip\"",
      "reason = \"this cwd policy must not affect eval cases\""
    ].join("\n"));
    writeRepoFile(repo, "src/app.js", "export const base = true;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "src/app.js", "export const value = 'CODENINJA_FAKE_FINDING';\n");
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
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codeninja-config-live-suite-"));
    const repo = initRepo();
    writeRepoFile(repo, "src/app.js", "export const base = true;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "src/app.js", "export const value = 'CODENINJA_FAKE_FINDING';\n");
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
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codeninja-eval-llm-override-suite-"));
    const repo = initRepo();
    writeRepoFile(repo, "src/app.js", "export const base = true;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "src/app.js", "export const value = 'CODENINJA_FAKE_FINDING';\n");
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
      "  concurrency: 2",
      "  lenses:",
      "    - core/code-review",
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
      review: { ...defaultConfig.review, concurrency: 1 }
    };
    const result = await runEvalCase(suite, suite.cases[0]!, { config });

    expect(result.status).toBe("pass");
    expect(result.info.effectiveConfig).toMatchObject({
      review: { concurrency: 2 },
      llm: { provider: "fake", model: "fake-model", reasoning: "high", maxConcurrentCalls: 3 }
    });
    const runJson = JSON.parse(readFileSync(path.join(result.runDir, "telemetry", "run.json"), "utf8")) as {
      review: { concurrency: number; llmMaxConcurrentCalls: number };
    };
    expect(runJson.review).toMatchObject({ concurrency: 2, llmMaxConcurrentCalls: 3 });
  }, 60_000);

  it("records eval llm overrides on live eval errors after case config is applied", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codeninja-eval-llm-error-suite-"));
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

  it("applies the reviewed repository codeninja.toml layer before eval YAML overrides", async () => {
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codeninja-repo-config-suite-"));
    const repo = initRepo();
    writeRepoFile(repo, "src/app.js", "export const base = true;\n");
    writeRepoFile(repo, "codeninja.toml", [
      "[[classification.pathRules]]",
      "pattern = \"src/app.js\"",
      "processingMode = \"skip\"",
      "reason = \"repo policy skip\""
    ].join("\n"));
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "src/app.js", "export const value = 'CODENINJA_FAKE_FINDING';\n");
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
    const suiteDir = mkdtempSync(path.join(tmpdir(), "codeninja-fixture-suite-"));
    const cases = [
      { name: "core-lens", file: "src/app.js", lens: "core/code-review", body: "export const value = 'CODENINJA_FAKE_FINDING';\n" },
      { name: "tests-lens", file: "src/app.test.ts", lens: "core/tests", body: "test('x', () => { const value = 'CODENINJA_FAKE_FINDING'; });\n" },
      { name: "go-lens", file: "service/main.go", lens: "lang/go", body: "package main\n\nfunc main() { _ = \"CODENINJA_FAKE_FINDING\" }\n" },
      { name: "typescript-lens", file: "src/app.ts", lens: "lang/typescript", body: "export const value: string = 'CODENINJA_FAKE_FINDING';\n" }
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
  writeFileSync(path.join(telemetryDir, "candidate-findings.json"), `${JSON.stringify(candidates, null, 2)}\n`);
  writeFileSync(path.join(telemetryDir, "final-findings.json"), `${JSON.stringify(finalFindings, null, 2)}\n`);
  writeFileSync(path.join(telemetryDir, "verification.json"), `${JSON.stringify(candidates.map((item) => ({
    candidateId: item.id,
    gate: "passed",
    verdict: { candidateId: item.id, verdict: "keep", reason: "ok", requiredEvidencePresent: true, falsePositiveRisk: "low" }
  })), null, 2)}\n`);
  writeFileSync(path.join(telemetryDir, "final-selection.json"), `${JSON.stringify({
    records: finalFindings.flatMap((item) => item.mergedCandidateIds.map((id) => ({ findingId: id, decision: "published", reason: "composer-selected" }))),
    groups: []
  }, null, 2)}\n`);
}

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
    evidence: { changedCode: "+ CODENINJA_FAKE_FINDING" },
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
    cache: { enabled: false, source: "config", dir: ".codeninja/cache" },
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
