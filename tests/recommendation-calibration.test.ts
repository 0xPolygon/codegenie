import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { calibrate, calibrationCasesSchema, compareJudgment } from "../scripts/calibrate-recommendations.js";
import * as judgeModule from "../src/evals/recommendation-judge.js";
import type { RecommendationJudgment } from "../src/evals/recommendation-judge.js";

const fixture = { id: "gold-label-must-not-leak", report: "Published review text", expected: { remedy: "incorrect" as const }, reason: "SECRET gold explanation" };
const judgment: RecommendationJudgment = { status: "completed", judge: { provider: "test", model: "judge", reasoning: "medium" },
  promptVersion: "test", results: [{ id: "remedy", status: "correct", rationale: "Test response", quotes: ["review"] }], costUSD: 0.01 };
afterEach(() => vi.restoreAllMocks());

async function inputs() {
  const dir = await mkdtemp(path.join(tmpdir(), "codegenie-calibration-"));
  const config = { provider: "test", model: "judge", reasoning: "medium", checks: [{ id: "remedy", rubric: "Honor the caller requirement." }] };
  await writeFile(path.join(dir, "eval.yml"), JSON.stringify({ name: "test", artifacts: { path: "unused" }, recommendationJudge: config }));
  const cases = path.join(dir, "cases.json");
  await writeFile(cases, JSON.stringify([fixture]));
  const out = path.join(dir, "results");
  return { dir, config, cases, out, args: ["--eval-dir", dir, "--cases", cases, "--out", out, "--repeats", "2"] };
}

describe("recommendation calibration runner", () => {
  it("counts disagreements and judge errors separately, never as matches", () => {
    expect(compareJudgment(fixture, judgment)).toEqual([{ id: "remedy", expected: "incorrect", actual: "correct", outcome: "mismatch" }]);
    expect(compareJudgment(fixture, { ...judgment, status: "error" })[0]!.outcome).toBe("error");
    expect(compareJudgment(fixture, { ...judgment, results: [] })[0]!.outcome).toBe("error");
    expect(compareJudgment(fixture, { ...judgment, results: [...judgment.results, ...judgment.results] })[0]!.outcome).toBe("error");
    expect(compareJudgment(fixture, { ...judgment, results: [{ ...judgment.results[0]!, status: "incorrect" }] })[0]!.outcome).toBe("match");
  });
  it("validates cases in dry-run mode without model calls or output writes", async () => {
    const input = await inputs();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const call = vi.spyOn(judgeModule, "judgeRecommendations");
    expect(await calibrate(input.args)).toBe(0);
    expect(call).not.toHaveBeenCalled();
    await expect(access(input.out)).rejects.toThrow();
  });
  it("keeps expected labels private, records every repetition, and refuses to overwrite results", async () => {
    const input = await inputs();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const call = vi.spyOn(judgeModule, "judgeRecommendations").mockResolvedValue({ judgment, prompt: "auditable prompt" });
    expect(await calibrate([...input.args, "--live"])).toBe(1);
    expect(call).toHaveBeenCalledTimes(2);
    for (const args of call.mock.calls) expect(args).toEqual([input.config, fixture.report]);
    const summary = JSON.parse(await readFile(path.join(input.out, "summary.json"), "utf8"));
    expect(summary).toMatchObject({ matches: 0, mismatches: 2, errors: 0, knownCostUSD: 0.02, unknownCostCalls: 0 });
    expect(summary.executions).toHaveLength(2);
    const manifest = JSON.parse(await readFile(path.join(input.out, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ repeats: 2, judgeConfig: input.config, cases: [fixture] });
    await expect(calibrate([...input.args, "--live"])).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("rejects missing check labels, unsafe case IDs, and duplicate cases", async () => {
    const input = await inputs();
    await writeFile(input.cases, JSON.stringify([{ ...fixture, expected: { wrong: "correct" } }]));
    const call = vi.spyOn(judgeModule, "judgeRecommendations");
    await expect(calibrate([...input.args, "--live"])).rejects.toThrow("exactly the rubric IDs");
    expect(call).not.toHaveBeenCalled();
    expect(calibrationCasesSchema.safeParse([{ ...fixture, id: "../escape" }]).success).toBe(false);
    expect(calibrationCasesSchema.safeParse([fixture, fixture]).success).toBe(false);
  });
});
