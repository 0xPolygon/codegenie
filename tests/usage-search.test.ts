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
import type { RepositoryTools } from "../src/types.js";

describe("pinned usage search", () => {
  it("intersects dotted-name segments before the file-scan cap, including multiline chains", async () => {
    const decoys = Object.fromEntries(Array.from({ length: 501 }, (_, index) =>
      [`src/decoy-${String(index).padStart(3, "0")}.ts`, "export function unrelated() { cache.load(); }\n"]));
    const fixture = await textRepository({ ...decoys,
      "src/first.ts": "export function first() { lm.sessions.load(); }\n",
      "src/second.ts": "export function second() { lm.sessions.\n  load(); }\n" });
    try {
      const page = (await fixture.tools.findUsages("sessions.load")).page;
      expect(page).toMatchObject({ candidateFiles: 2, filesScanned: 2, filesParsed: 2, scanComplete: true, coverageComplete: true });
      expect(page.rows.map(row => row.path)).toEqual(["src/first.ts", "src/second.ts"]);
      expect(packUsagePage(page, "sessions.load", 4_000).text).toContain("candidate file 2 of 2");
      const plain = (await fixture.tools.findUsages("load")).page;
      expect(plain.candidateFiles).toBe(503);
    } finally { fixture.dispose(); }
  });

  it("reports an empty bounded scan as incomplete with a continuation", async () => {
    const paths = Array.from({ length: 501 }, (_, index) => `src/${String(index).padStart(3, "0")}.ts`);
    const source = { kind: "head" as const };
    const parsed = await new TreeSitterService().parse({ path: paths[0]!, language: "typescript", content: "// run\n", source });
    const resolver = { resolveSource: () => "pinned", grepFiles: async () => paths,
      readFile: async (file: string) => ({ path: file, source, content: "// run\n", contentSha: "same", commit: "pinned" }) } as unknown as SourceResolver;
    const registry = { forPath: () => ({ parse: async () => parsed }), languageForPath: () => "typescript" } as unknown as LanguageAdapterRegistry;
    const page = await findUsages(resolver, registry, "run");
    expect(page).toMatchObject({ filesScanned: 500, candidateFiles: 501, scanComplete: false, coverageComplete: false });
    expect(page.entries).toHaveLength(0);
    await expect(findUsages(resolver, registry, "run", { source: { kind: "base" }, cursor: page.nextCursor! }))
      .rejects.toMatchObject({ code: "invalid_args" });
    const delivery = packUsagePage(page, "run", 4_000);
    expect(delivery).toMatchObject({ isError: true, errorCode: "budget_exhausted", nextCursor: page.nextCursor });
    expect(delivery.text).toContain("file-scan limit");
    expect(delivery.text).toContain('Next candidate file "src/500.ts"@head.');
    const mockTools = { findUsages: async () => ({ page, meta: { backend: "tree-sitter" as const, precision: "syntactic" as const, degraded: false } }) } as unknown as RepositoryTools;
    const outcome = await buildFindUsagesTool(mockTools).execute({ name: "run" }, new AbortController().signal);
    expect(outcome).toMatchObject({ isError: true, errorCode: "budget_exhausted", meta: { deliveryStatus: "budget_rejected", degradationReason: "usage_scan_limit" } });
  });

  it("pages source-backed calls and text leads without gaps, and binds cursors to the lookup", async () => {
    const fixture = await textRepository({
      "src/caller.ts": 'import { run as invoke } from "./worker";\nexport function caller() { invoke(); invoke(); }\n',
      "src/worker.ts": 'export function run() {}\n',
      "src/esm.ts": 'import { run } from "./worker.js";\nexport function call() { run(); }\n',
      "src/long.ts": `export function long() { run(); /* ${"x".repeat(2_100)} */ }\n`,
      "src/nested.ts": 'function outer() {\n  run();\n  consume(() => run());\n  run();\n}\n',
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
      let finalCoverage = true;
      const positions: string[] = [];
      do {
        const page = await findUsages(resolver, registry, "run", { source: { kind: "head" }, maxRows: 1, ...(cursor ? { cursor } : {}) });
        for (const row of [...page.rows, ...page.textMatches]) positions.push(`${row.path}:${row.line}:${row.column}`);
        if (page.nextCursor) await expect(findUsages(resolver, registry, "other", { cursor: page.nextCursor })).rejects.toMatchObject({ code: "invalid_args" });
        finalCoverage = page.coverageComplete;
        cursor = page.nextCursor;
      } while (cursor);
      expect(new Set(positions).size).toBe(positions.length);
      expect(positions.filter(x => x.startsWith("src/caller.ts:2:"))).toHaveLength(2);
      expect(positions.some(x => x.startsWith("docs/guide.md:1:"))).toBe(true);
      expect(finalCoverage).toBe(false);
      const nested = positions.filter(x => x.startsWith("src/nested.ts:"));
      expect(nested).toEqual(["src/nested.ts:2:3", "src/nested.ts:4:3", "src/nested.ts:3:17"]);
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
      const esm = await findUsages(resolver, registry, "run", { pathGlob: "src/esm.ts" });
      expect(esm.rows.find(row => row.role === "call")?.bindingEvidence).toMatchObject({
        moduleSpecifier: "./worker.js", candidateModulePath: "src/worker.ts", binding: "unresolved"
      });
      const long = await findUsages(resolver, registry, "run", { pathGlob: "src/long.ts" });
      expect(long.rows.find(row => row.role === "call")).toMatchObject({ excerptOmitted: true, line: 1 });
      expect(packUsagePage(long, "run", 4_000).text).toContain("source line omitted: too long to deliver");
      const fullText = packUsagePage(caller, "run", 100_000);
      expect(fullText.text.match(/src\/caller\.ts"@head: 2 lines/gu)).toHaveLength(1);
      expect(fullText.text).toContain('2\texport function caller() { invoke(); invoke(); }');
      const cut = Array.from({ length: fullText.text.length }, (_, n) => packUsagePage(caller, "run", n))
        .find(delivery => !delivery.isError && delivery.deliveredCount > 0 && delivery.deliveredCount < caller.entries.length)!;
      expect(cut.nextCursor).toBe(caller.entries[cut.deliveredCount]?.cursor);
      expect(cut.text).toContain(`Next row "src/caller.ts"@head:${caller.entries[cut.deliveredCount]!.row.line}:${caller.entries[cut.deliveredCount]!.row.column}`);
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
      const noMatch = await findUsages(resolver, registry, "neverAppearsHere");
      expect(noMatch).toMatchObject({ entries: [], scanComplete: true, coverageComplete: true, candidateFiles: 0 });
      expect(packUsagePage(noMatch, "neverAppearsHere", 4_000).isError).toBeUndefined();
      const aborted = new AbortController();
      aborted.abort();
      await expect(tool.execute(args, aborted.signal)).rejects.toMatchObject({ code: "llm_call_failed" });
    } finally { fixture.dispose(); }
  });
});
