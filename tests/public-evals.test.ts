import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEvalSuite } from "../src/evals/eval-runner.js";

const root = path.resolve(import.meta.dirname, "../evals/public");
const caseDirs = existsSync(root)
  ? readdirSync(root, { withFileTypes: true }).filter((repo) => repo.isDirectory()).flatMap((repo) =>
    readdirSync(path.join(root, repo.name), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(root, repo.name, entry.name, "eval.yml")))
      .map((entry) => ({ repo: repo.name, id: entry.name, dir: path.join(root, repo.name, entry.name) })))
  : [];

function frontMatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(text);
  if (!match) return {};
  return Object.fromEntries(match[1]!.split("\n").map((line) => line.split(/:\s*/u, 2) as [string, string]).filter(([key]) => key.length > 0));
}

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
    expect(["positive", "negative-control", "spare"]).toContain(oracle.role);
    const expectations = [...(evalCase.should_find ?? []), ...(evalCase.should_not_find ?? [])];
    expect(expectations.length).toBeGreaterThan(0);
    for (const expectation of expectations) {
      // Matchers are pre-filters: every expectation states its severity floor
      // (the suite schema validates the value) and none relies on a title pattern.
      expect(expectation.severityAtLeast).toBeDefined();
      expect(expectation.titlePattern).toBeUndefined();
    }
    if (oracle.role === "negative-control") {
      // A clean change is only contradicted by a material finding.
      expect(evalCase.should_not_find?.length).toBeGreaterThan(0);
      for (const expectation of evalCase.should_not_find ?? []) {
        expect(["medium", "high", "critical"]).toContain(expectation.severityAtLeast);
      }
    }
  });
});
