import { describe, expect, it } from "vitest";
import { textRepository } from "./helpers/text-repository.js";
import { git } from "./helpers/git.js";
import { SourceResolver } from "../src/repo/source-resolver.js";
import { LanguageAdapterRegistry } from "../src/repo/language-adapter.js";
import { TreeSitterService } from "../src/repo/tree-sitter/tree-sitter-service.js";
import { findUsages } from "../src/repo/usage-search.js";

describe("pinned usage search", () => {
  it("pages source-backed calls and text leads without gaps, and binds cursors to the lookup", async () => {
    const fixture = await textRepository({
      "src/caller.ts": 'import { run as invoke } from "./worker";\nexport function caller() { invoke(); invoke(); }\n',
      "src/worker.ts": 'export function run() {}\n',
      "src/worker.test.ts": 'import { run } from "./worker";\ntest("run", () => run());\n',
      "docs/guide.md": 'run appears here\n'
    }, { "src/worker.ts": 'export function run() { return 1; }\n' });
    try {
      const head = git(fixture.repo, ["rev-parse", "HEAD"]).trim();
      const base = git(fixture.repo, ["rev-parse", "HEAD^"]).trim();
      const resolver = await SourceResolver.create({ mode: "commit_range", repoRoot: fixture.repo, startCommit: base, endCommit: head,
        mergeBase: base, headSha: head, commits: [], rawDiff: "" });
      const registry = new LanguageAdapterRegistry(new TreeSitterService());
      let cursor: string | undefined;
      const positions: string[] = [];
      do {
        const page = await findUsages(resolver, registry, "run", { source: { kind: "head" }, maxRows: 1, ...(cursor ? { cursor } : {}) });
        for (const row of [...page.rows, ...page.textMatches]) positions.push(`${row.path}:${row.line}:${row.column}`);
        if (page.nextCursor) await expect(findUsages(resolver, registry, "other", { cursor: page.nextCursor })).rejects.toMatchObject({ code: "invalid_args" });
        cursor = page.nextCursor;
      } while (cursor);
      expect(new Set(positions).size).toBe(positions.length);
      expect(positions.filter(x => x.startsWith("src/caller.ts:2:"))).toHaveLength(2);
      expect(positions.some(x => x.startsWith("docs/guide.md:1:"))).toBe(true);
      const tests = await findUsages(resolver, registry, "run", { scope: "tests" });
      expect(tests.rows.length).toBeGreaterThan(0);
      expect(tests.rows.every(row => row.path === "src/worker.test.ts")).toBe(true);
      expect(tests.rows[0]).toMatchObject({ revision: "head", fileLines: 2 });
      const caller = await findUsages(resolver, registry, "run", { pathGlob: "src/caller.ts" });
      expect(caller.rows.find(row => row.role === "call")?.bindingEvidence).toMatchObject({
        candidateModulePath: "src/worker.ts", binding: "unresolved"
      });
      const old = await findUsages(resolver, registry, "run", { source: { kind: "base" }, pathGlob: "src/worker.ts" });
      expect(old.rows[0]).toMatchObject({ revision: "base", excerpt: "export function run() {}" });
    } finally { fixture.dispose(); }
  });
});
