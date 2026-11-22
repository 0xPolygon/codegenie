import { describe, expect, it } from "vitest";
import { textRepository } from "./helpers/text-repository.js";
import { git } from "./helpers/git.js";
import { SourceResolver } from "../src/repo/source-resolver.js";
import { LanguageAdapterRegistry } from "../src/repo/language-adapter.js";
import { TreeSitterService } from "../src/repo/tree-sitter/tree-sitter-service.js";
import { findUsages } from "../src/repo/usage-search.js";
import { packUsagePage } from "../src/llm/usage-result-packing.js";
import { packUsageToolResult } from "../src/llm/usage-result-packing.js";
import { buildFindUsagesTool } from "../src/llm/usage-tool.js";
import { createToolResultCache } from "../src/llm/tool-result-cache.js";

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
      const viaFacade = await fixture.tools.findUsages("run", { pathGlob: "src/caller.ts" });
      expect(viaFacade.page.rows).toEqual(caller.rows);
      expect(viaFacade.meta).toMatchObject({ lookupStatus: "found", sourceUsed: "head" });
      expect(caller.rows.find(row => row.role === "call")?.bindingEvidence).toMatchObject({
        candidateModulePath: "src/worker.ts", binding: "unresolved"
      });
      const fullText = packUsagePage(caller, "run", 100_000);
      expect(fullText.text.match(/src\/caller\.ts"@head: 2 lines/gu)).toHaveLength(1);
      expect(fullText.text).toContain('2\texport function caller() { invoke(); invoke(); }');
      const cut = Array.from({ length: fullText.text.length }, (_, n) => packUsagePage(caller, "run", n))
        .find(delivery => !delivery.isError && delivery.deliveredCount > 0 && delivery.deliveredCount < caller.entries.length)!;
      expect(cut.nextCursor).toBe(caller.entries[cut.deliveredCount]?.cursor);
      const resumed = await findUsages(resolver, registry, "run", { pathGlob: "src/caller.ts", cursor: cut.nextCursor! });
      expect(resumed.entries[0]?.row).toEqual(caller.entries[cut.deliveredCount]?.row);
      expect(packUsagePage(caller, "run", 1)).toMatchObject({ isError: true, errorCode: "budget_exhausted", deliveredCount: 0 });
      const tool = buildFindUsagesTool(fixture.tools);
      const args = { name: "run", pathGlob: "src/caller.ts" };
      const cache = createToolResultCache();
      const execute = () => tool.execute(args, new AbortController().signal);
      const first = await cache.execute({ toolName: tool.name, args, run: execute });
      const budgeted = packUsageToolResult(first.result, 1);
      expect(budgeted).toMatchObject({ isError: true, errorCode: "budget_exhausted", meta: { deliveryStatus: "budget_rejected" } });
      const cached = await cache.execute({ toolName: tool.name, args, run: execute });
      expect(cached.status).toBe("hit");
      expect(packUsageToolResult(cached.result, 100_000).text).toBe(first.result.text);
      expect(first.result.isError).toBeUndefined();
      const old = await findUsages(resolver, registry, "run", { source: { kind: "base" }, pathGlob: "src/worker.ts" });
      expect(old.rows[0]).toMatchObject({ revision: "base", excerpt: "export function run() {}" });
    } finally { fixture.dispose(); }
  });
});
