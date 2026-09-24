import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { judgeRecommendations, publishedRecommendationReport, addRecommendationJudgment, recommendationJudgeSchema } from "../src/evals/recommendation-judge.js";
import type { PiAiAdapter, PiAssistantMessage } from "../src/llm/llm-runner.js";
import type { EvalScore } from "../src/types.js";
import { loadEvalSuite } from "../src/evals/eval-runner.js";
import { parseEvalCommand } from "../src/evals/eval-command.js";

const config = { provider: "test", model: "judge", reasoning: "medium" as const,
  checks: [{ id: "contract", rubric: "A successful response must meet the original requested minimum." }] };
const report = "Suggested fix: preserve the requested minimum using ceiling division.";
const result = { id: "contract", status: "correct", rationale: "Preserves the caller minimum.", quotes: ["preserve the requested minimum using ceiling division"] };
function adapterFor(results: unknown): PiAiAdapter {
  return { resolveModel: () => ({ provider: "test", id: "judge", raw: {} }),
    complete: vi.fn(async () => ({ role: "assistant", provider: "test", model: "judge", stopReason: "toolUse",
      usage: { cost: { total: 0.01 } }, content: [{ type: "toolCall", id: "judge", name: "submit_recommendation_judgment",
        arguments: { results }, argumentParse: { state: "strict" } }] } as PiAssistantMessage)),
    validateToolCall: () => { throw new Error("unused"); } };
}

describe("independent recommendation judge", () => {
  it("scores semantic rubrics with evidence, a fixed model and separate usage", async () => {
    const adapter = adapterFor([result]);
    const judged = await judgeRecommendations(config, report, adapter);
    expect(judged.judgment).toMatchObject({ status: "completed", costUSD: 0.01, judge: { model: "judge", reasoning: "medium" }, results: [result] });
    expect(judged.prompt).toContain(config.checks[0]!.rubric);
    expect(judged.prompt).toContain("not keyword similarity");
    expect(judged.prompt).toContain("A wrong recommendation with a caution to confirm it remains incorrect");
    expect(adapter.complete).toHaveBeenCalledOnce();
    expect(vi.mocked(adapter.complete).mock.calls[0]![2]).toMatchObject({ maxRetries: 0, reasoning: "medium", toolChoice: "auto" });
  });
  it("removes only explicitly historical renderer provenance, retaining primary advice and attention", () => {
    const text = report + '\n<details>\n<summary>Original assessments and supporting evidence (may overlap or disagree)</summary>\nOld advice: lower the minimum\n</details>\nHuman attention: unresolved intent';
    const published = publishedRecommendationReport(text);
    expect(published).toContain(report);
    expect(published).toContain("Human attention");
    expect(published).not.toContain("Old advice");
    expect(publishedRecommendationReport("<details><summary>Other</summary>Primary advice</details>")).toContain("Primary advice");
  });
  it.each([
    [], [result, result], [{ ...result, id: "invented" }], [{ ...result, quotes: [] }],
    [{ ...result, quotes: ["fabricated quote"] }], [{ ...result, status: "pass" }]
  ].map(results => ({ results })))("rejects invalid or unsupported judgments without manufacturing a score", async ({ results }) => {
    const value = await judgeRecommendations(config, report, adapterFor(results));
    expect(value.judgment).toMatchObject({ status: "error", results: [] });
    expect(value.judgment.error).toBeTruthy();
    expect(value.judgment.costUSD).toBe(0.01);
  });
  it.each(["withheld", "uncertain"])("keeps %s distinct from correct and permits absent quotes", async status => {
    expect((await judgeRecommendations(config, report, adapterFor([{ ...result, status, quotes: [] }]))).judgment)
      .toMatchObject({ status: "completed", results: [{ status }] });
  });
  it("rejects unreadable or length-stopped submissions and bounds a hung provider", async () => {
    const adapter = adapterFor([result]);
    vi.mocked(adapter.complete).mockResolvedValueOnce({ role: "assistant", provider: "test", model: "judge", stopReason: "length", content: [] });
    expect((await judgeRecommendations(config, report, adapter)).judgment.status).toBe("error");
    vi.mocked(adapter.complete).mockImplementationOnce(async () => new Promise(() => {}));
    const timed = await judgeRecommendations(config, report, adapter, 5);
    expect(timed.judgment.error).toContain("timed out");
    expect(vi.mocked(adapter.complete).mock.calls[1]![2].signal).toMatchObject({ aborted: true });
  });
  it("never truncates the published report silently", async () => {
    const adapter = adapterFor([result]);
    expect((await judgeRecommendations(config, "x".repeat(120001), adapter)).judgment.status).toBe("error");
    expect(adapter.complete).not.toHaveBeenCalled();
  });
  it("validates YAML judge configuration and rejects duplicate checks", async () => {
    expect(recommendationJudgeSchema.safeParse({ ...config, checks: [config.checks[0], config.checks[0]] }).success).toBe(false);
    const dir = await mkdtemp(path.join(tmpdir(), "codegenie-judge-"));
    await writeFile(path.join(dir, "eval.yml"), JSON.stringify({ name: "example", artifacts: { path: "logs/1" }, recommendationJudge: config }));
    expect((await loadEvalSuite(dir)).cases[0]!.evalCase.recommendationJudge).toEqual(config);
    expect(parseEvalCommand(["eval", "--from-artifacts", "logs/1", "--judge"])).toMatchObject({ judge: true });
  });
  it("persists negative judgments and their audit data without changing pass/fail or review costs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codegenie-judge-result-"));
    await writeFile(path.join(dir, "codegenie-review.out.md"), report);
    const score = { status: "pass", metrics: { costUSD: 5 } } as EvalScore;
    const adapter = adapterFor([{ ...result, status: "incorrect" }]);
    await addRecommendationJudgment({ name: "test", recommendationJudge: config }, score, dir, true, adapter);
    expect(score).toMatchObject({ status: "pass", metrics: { costUSD: 5 }, recommendationQuality: {
      status: "completed", costUSD: 0.01, results: [{ status: "incorrect" }]
    } });
    const saved = JSON.parse(await readFile(path.join(dir, "recommendation-judge.json"), "utf8"));
    expect(saved.prompt).toContain(config.checks[0]!.rubric);
    expect(saved.response).toBeDefined();
    expect(saved.judgment).toEqual(score.recommendationQuality);
  });

  it("keeps offline replay offline and preserves deterministic pass/fail even when judging errors", async () => {
    const score = { status: "pass" } as EvalScore;
    const evalCase = { name: "test", recommendationJudge: config };
    await addRecommendationJudgment(evalCase, score, "/missing", false);
    expect(score).toMatchObject({ status: "pass", recommendationQuality: { status: "not_run" } });
    await addRecommendationJudgment(evalCase, score, "/missing", true);
    expect(score).toMatchObject({ status: "pass", recommendationQuality: { status: "error", results: [] } });
  });
});
