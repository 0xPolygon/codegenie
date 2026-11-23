import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEvalSuite, type EvalSuite } from "../src/evals/eval-runner.js";

const root = path.resolve(import.meta.dirname, "../evals/public");
const caseDirs = existsSync(root)
  ? readdirSync(root, { withFileTypes: true }).filter((repo) => repo.isDirectory()).flatMap((repo) =>
    readdirSync(path.join(root, repo.name), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(root, repo.name, entry.name, "eval.yml")))
      .map((entry) => ({ repo: repo.name, id: entry.name, dir: path.join(root, repo.name, entry.name) })))
  : [];

type EvalCase = EvalSuite["cases"][number]["evalCase"];

function frontMatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(text);
  if (!match) return {};
  return Object.fromEntries(match[1]!.split("\n").map((line) => line.split(/:\s*/u, 2) as [string, string]).filter(([key]) => key.length > 0));
}

// Matchers are pre-filters: every expectation, in every list, states its
// severity floor (the suite schema validates the value) and none relies on a
// title pattern. A clean change is only contradicted by a material finding.
function matcherContractViolations(evalCase: EvalCase, role: string | undefined): string[] {
  const lists = { should_find: evalCase.should_find ?? [], should_find_candidate: evalCase.should_find_candidate ?? [], should_not_find: evalCase.should_not_find ?? [] };
  if (role === "contaminated-control" || role === "compatibility-question") {
    return Object.values(lists).some((expectations) => expectations.length > 0)
      ? [`${role} with scored expectations`]
      : [];
  }
  const violations = Object.entries(lists).flatMap(([list, expectations]) => expectations.flatMap((expectation) => [
    ...(expectation.severityAtLeast === undefined ? [`${list}/${expectation.id}: missing severityAtLeast`] : []),
    ...(expectation.titlePattern !== undefined ? [`${list}/${expectation.id}: titlePattern`] : [])
  ]));
  if (Object.values(lists).every((expectations) => expectations.length === 0)) violations.push("no expectations");
  if (role === "negative-control") {
    if (lists.should_not_find.length === 0) violations.push("negative control without should_not_find");
    for (const expectation of lists.should_not_find) {
      if (!["medium", "high", "critical"].includes(expectation.severityAtLeast ?? "")) violations.push(`should_not_find/${expectation.id}: floor below medium`);
    }
  }
  return violations;
}

describe("public eval matcher contract", () => {
  const base: EvalCase = { name: "contract", repo: { external: "/tmp/x" }, command: { base: "a", head: "b" } } as EvalCase;
  it.each([
    ["should_find", { should_find: [{ id: "f", path: "a.ts" }] }, "positive", ["should_find/f: missing severityAtLeast"]],
    ["should_find_candidate", { should_find_candidate: [{ id: "c", path: "a.ts" }] }, "positive", ["should_find_candidate/c: missing severityAtLeast"]],
    ["a low negative-control floor", { should_not_find: [{ id: "n", path: "a.ts", severityAtLeast: "low" }] }, "negative-control", ["should_not_find/n: floor below medium"]],
    ["a missing negative-control floor", { should_not_find: [{ id: "n", path: "a.ts" }] }, "negative-control", ["should_not_find/n: missing severityAtLeast", "should_not_find/n: floor below medium"]],
    ["a scored contaminated control", { should_not_find: [{ id: "n", path: "a.ts", severityAtLeast: "medium" }] }, "contaminated-control", ["contaminated-control with scored expectations"]],
    ["a scored compatibility question", { should_find: [{ id: "q", path: "a.ts", severityAtLeast: "medium" }] }, "compatibility-question", ["compatibility-question with scored expectations"]]
  ] as const)("rejects %s", (_label, lists, role, expected) => {
    expect(matcherContractViolations({ ...base, ...lists } as unknown as EvalCase, role)).toEqual(expected);
  });
});

describe("public eval cases", () => {
  it("has cases", () => {
    expect(caseDirs.length).toBeGreaterThan(0);
  });

  it.each(caseDirs)("$repo/$id loads and pins an oracle outside the reviewed checkout", async ({ repo, id, dir }) => {
    const suite = await loadEvalSuite(dir);
    expect(suite.cases).toHaveLength(1);
    const evalCase = suite.cases[0]!.evalCase;
    expect(evalCase.repo?.external).toBe(`~/.cache/codegenie/public-evals/${repo}/${id}`);
    expect(evalCase.command?.base).toMatch(/^[0-9a-f]{40}$/u);
    expect(evalCase.command?.head).toMatch(/^[0-9a-f]{40}$/u);
    // Owner directive: full debug traces and independent draws on every eval run.
    expect(evalCase.review).toMatchObject({ verify: true, debug: true, cache: false });
    const oracle = frontMatter(readFileSync(path.join(dir, "oracle.md"), "utf8"));
    expect(oracle).toMatchObject({ repo, case: id, intro: evalCase.command?.head, base: evalCase.command?.base });
    expect(oracle.introDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(["positive", "negative-control", "contaminated-control", "compatibility-question", "spare"]).toContain(oracle.role);
    expect(matcherContractViolations(evalCase, oracle.role)).toEqual([]);
  });
});
