import { describe, expect, it } from "vitest";
import { packTextToolResult } from "../src/llm/search-result-packing.js";
import {
  assertRepositoryToolArguments,
  buildRepositoryToolDefinitions,
  buildSixListFilesTool,
  buildSixSearchTool,
  normalizeRepositoryToolArguments
} from "../src/llm/tool-definitions.js";
import { writeRepoFile } from "./helpers/git.js";
import { validateToolCall } from "./helpers/pi-validation.js";
import { textRepository } from "./helpers/text-repository.js";

function nextCursor(text: string): string {
  const cursor = /cursor=([\w-]+)/u.exec(text)?.[1];
  if (!cursor) throw new Error(`Expected a continuation in ${text}`);
  return cursor;
}

describe("six-tool discovery on pinned Git snapshots", () => {
  it.each([
    ["current", ["list_files", "search_files"]],
    ["six", ["find_usages", "list_files", "read_change", "read_definition", "read_range", "search_files"]]
  ] as const)("treats empty cursors as first-page requests for every %s paged tool", async (toolSurface, expectedNames) => {
    const path = "src/guard.ts";
    const fixture = await textRepository({ [path]: "export function guard() { return true; }\nguard();\n" });
    try {
      const definitions = buildRepositoryToolDefinitions(fixture.tools, { toolSurface });
      const argsByTool: Record<string, Record<string, unknown>> = {
        find_usages: { name: "guard" },
        list_files: { glob: "**" },
        read_change: {},
        read_definition: { name: "guard", path },
        read_range: { path },
        search_files: { query: "guard" }
      };
      const paged = definitions.filter(tool => (tool.parameters as { properties?: Record<string, unknown> }).properties?.cursor);
      expect(paged.map(tool => tool.name).sort()).toEqual(expectedNames);
      for (const tool of paged) {
        const omitted = argsByTool[tool.name]!;
        const supplied = { ...omitted, cursor: "" };
        const args = normalizeRepositoryToolArguments(tool, supplied);
        expect(supplied.cursor).toBe("");
        expect(args).toEqual(omitted);
        assertRepositoryToolArguments(tool, args);
        const validated = validateToolCall(definitions, { type: "toolCall", id: "empty-cursor", name: tool.name, arguments: args });
        const signal = new AbortController().signal;
        const first = await tool.execute(omitted, signal);
        expect(first.isError).toBeUndefined();
        expect(await tool.execute(validated as Record<string, unknown>, signal)).toEqual(first);
      }
      if (toolSurface === "current") {
        const bounded = definitions.find(tool => tool.name === "read_range")!;
        const args = { path, startLine: 1, endLine: 1, cursor: "" };
        expect(normalizeRepositoryToolArguments(bounded, args)).toBe(args);
        expect(() => assertRepositoryToolArguments(bounded, args)).toThrow("Invalid arguments");
      }
    } finally {
      fixture.dispose();
    }
  });

  it("positions current search context and binds the cursor to the existing options", async () => {
    const fixture = await textRepository({
      "src/cli/review-command.ts": "// before\nTRACK(1);\n// between\nTRACK(2);\n// end\n",
      "src/git/git-client.ts": "TRACK(3);\n"
    }, { "src/cli/review-command.ts": "// unchanged header\n" });
    try {
      const args = { query: "track\\(", caseSensitive: false, maxResults: 1, contextMode: "lines",
        source: { kind: "base" }, pathGlob: "src/cli/**" };
      const first = await fixture.call("search_files", args);
      expect(first.text).toContain('"src/cli/review-command.ts"@base: 5 lines');
      expect(first.text).toContain("1\t// before\n2:1\tTRACK(1);\n3\t// between");
      expect(first.text).toContain('next: "src/cli/review-command.ts"@base:4, cursor=');
      expect(first.searchResults?.map(hit => hit.line)).toEqual([2]);
      const cursor = nextCursor(first.text);
      const second = await fixture.call("search_files", { ...args, cursor });
      expect(second.text).toContain("4:1\tTRACK(2);");
      expect(second.searchResults?.map(hit => hit.line)).toEqual([4]);
      for (const changed of [{ maxResults: 2 }, { caseSensitive: true }]) {
        expect(await fixture.call("search_files", { ...args, ...changed, cursor })).toMatchObject({ errorCode: "invalid_args" });
      }
    } finally {
      fixture.dispose();
    }
  });

  it("separates literal and regex modes and renders each context line at its pinned position", async () => {
    const fixture = await textRepository({
      "src/example.ts": "const before = 1;\n\ttrack(before);\n// after\ntrack(2);\n"
    }, {
      "src/example.ts": "const before = 2;\n\tother(before);\n// after\ntrack(3);\n"
    });
    try {
      const search = buildSixSearchTool(fixture.tools);
      const signal = new AbortController().signal;
      const args = { query: "track(", mode: "literal", contextMode: "lines", source: { kind: "base" }, pathGlob: "src/**/*.ts" };
      const result = await search.execute(args, signal);
      expect(result.meta?.searchDelivery).toMatchObject({ deliveredCount: 2, backendOmittedCount: 0, scanIncomplete: false });
      expect(result.text.match(/"src\/example\.ts"@base: 4 lines/gu)).toHaveLength(1);
      expect(result.text).toContain("1\tconst before = 1;\n2:2\t\ttrack(before);\n3\t// after");
      expect(result.text).toContain("4:1\ttrack(2);");
      expect(result.text).not.toMatch(/^5\t/mu);

      const rejected = await search.execute({ query: "track(" }, signal);
      expect(rejected).toMatchObject({ isError: true, errorCode: "invalid_args" });
      expect(rejected.text).toContain("name\\(");
      expect(rejected.text).toContain("Use mode=literal to search for source text.");
      const regex = await search.execute({ query: "track\\(" }, signal);
      expect(regex.text).toContain("4:1\ttrack(3);");
      expect(regex.meta?.searchDelivery?.deliveredCount).toBe(1);
    } finally {
      fixture.dispose();
    }
  });

  it("continues at the first undelivered row for caller and backend cuts", async () => {
    const fixture = await textRepository({
      "a.ts": Array.from({ length: 53 }, (_, index) => `hit(${index + 1});\n`).join(""),
      "aa:20:7:\nname.ts": "hit(99);\r\n",
      "b.ts": "hit(100);\n",
      "é.ts": "hit(200);\n"
    });
    try {
      const search = buildSixSearchTool(fixture.tools);
      const signal = new AbortController().signal;
      const args = { query: "hit(", mode: "literal" };
      const full = await search.execute(args, signal);
      expect(full.meta?.searchDelivery).toMatchObject({ deliveredCount: 50, scanIncomplete: true, discoveryOmittedCount: 1 });
      expect(full.text).toContain('"a.ts"@head:51, cursor=');
      const final = await search.execute({ ...args, cursor: nextCursor(full.text) }, signal);
      expect(final.text).toContain("51:1\thit(51);");
      expect(final.text).toContain('"aa:20:7:\\nname.ts"@head: 1 lines\n1:1\thit(99);\r');
      expect(final.text).toContain('"é.ts"@head: 1 lines');
      expect(final.meta?.searchDelivery).toMatchObject({ deliveredCount: 6, scanIncomplete: false });

      const clipped = packTextToolResult(full, 640);
      expect(clipped.isError).toBeUndefined();
      const delivered = clipped.meta!.searchDelivery!.deliveredCount;
      expect(delivered).toBeGreaterThan(0);
      expect(delivered).toBeLessThan(50);
      expect(clipped.meta?.searchDelivery).toMatchObject({ budgetOmittedCount: 50 - delivered, discoveryOmittedCount: 1 });
      const resumed = await search.execute({ ...args, cursor: nextCursor(clipped.text) }, signal);
      expect(resumed.text).toContain(`\n${delivered + 1}:1\thit(${delivered + 1});`);
      expect(resumed.text).not.toContain(`\n${delivered}:1\thit(${delivered});`);

      const refusal = packTextToolResult(full, 1);
      expect(refusal).toMatchObject({ errorCode: "budget_exhausted", meta: { searchDelivery: { deliveredCount: 0, budgetOmittedCount: 50 } } });
      const retry = await search.execute({ ...args, cursor: nextCursor(refusal.text) }, signal);
      expect(retry.text).toBe(full.text);
      for (const change of [{ query: "different" }, { mode: "regex" }, { contextMode: "lines" },
        { pathGlob: "*.ts" }, { source: { kind: "base" } }]) {
        const mismatch = await search.execute({ ...args, ...change, cursor: nextCursor(clipped.text) }, signal);
        expect(mismatch.errorCode).toBe("invalid_args");
      }
    } finally {
      fixture.dispose();
    }
  });

  it("states the backend omission and its position when another match fits", async () => {
    const fixture = await textRepository({ "src/oversized.ts": `hit(${"x".repeat(33_000)});\nhit(2);\n` });
    try {
      const search = buildSixSearchTool(fixture.tools);
      const result = await search.execute({ query: "hit(", mode: "literal" }, new AbortController().signal);
      expect(result.meta?.searchDelivery).toMatchObject({
        deliveredCount: 1, backendOmittedCount: 1, scanIncomplete: false,
        nextRead: { path: "src/oversized.ts", line: 1 }
      });
      expect(result.text).toContain("2:1\thit(2);");
      expect(result.text).toContain('matching lines omitted by the Git output cap: 1; inspect "src/oversized.ts"@head:1');
    } finally {
      fixture.dispose();
    }
  });

  it.each(["current", "six"] as const)("pages whole %s paths in pinned head order and reports exact omissions", async surface => {
    const paths = Array.from({ length: 503 }, (_, index) => `src/path-${String(index).padStart(3, "0")}.ts`);
    const fixture = await textRepository(Object.fromEntries(paths.map(path => [path, "export {};\n"])));
    try {
      writeRepoFile(fixture.repo, "src/untracked.ts", "export {};\n");
      const list = surface === "six" ? buildSixListFilesTool(fixture.tools) : fixture.definitions.find(tool => tool.name === "list_files")!;
      const signal = new AbortController().signal;
      const args = { glob: "src/*.ts" };
      const full = await list.execute(args, signal);
      expect(full.text).toMatch(/Head tree [0-9a-f]{40}, glob "src\/\*\.ts": 503 paths/u);
      expect(full.meta?.pathListDelivery).toEqual({ deliveredCount: 500, backendOmittedCount: 3, budgetOmittedCount: 0 });
      const last = await list.execute({ ...args, cursor: nextCursor(full.text) }, signal);
      expect(last.meta?.pathListDelivery).toEqual({ deliveredCount: 3, backendOmittedCount: 0, budgetOmittedCount: 0 });
      expect(last.text).toContain(paths.slice(500).map(path => JSON.stringify(path)).join("\n"));
      expect(last.text).not.toContain("untracked");

      const clipped = packTextToolResult(full, 600);
      const count = clipped.meta!.pathListDelivery!.deliveredCount;
      expect(count).toBeGreaterThan(0);
      expect(clipped.meta?.pathListDelivery).toEqual({ deliveredCount: count, backendOmittedCount: 3, budgetOmittedCount: 500 - count });
      const next = await list.execute({ ...args, cursor: nextCursor(clipped.text) }, signal);
      expect(next.text.split("\n")[1]).toBe(JSON.stringify(paths[count]));
      const mismatch = await list.execute({ glob: "**/*.ts", cursor: nextCursor(clipped.text) }, signal);
      expect(mismatch.errorCode).toBe("invalid_args");
    } finally {
      fixture.dispose();
    }
  });

  it("keeps complete likely-test entries and locates the first omitted test on both caps", async () => {
    const path = "src/cli/review-command.ts";
    const testPath = "src/cli/review-command.test.ts";
    const fixture = await textRepository({
      [path]: "export function executeReview() {}\n",
      [testPath]: Array.from({ length: 25 }, (_, i) =>
        `test("review command ${String(i).padStart(2, "0")}", () => { executeReview(); });\n`).join("")
    });
    try {
      const full = await fixture.call("find_likely_tests", { path, source: { kind: "base" } });
      expect(full.meta).toMatchObject({ omittedCount: 5, recovery: { path: testPath, source: "base", startLine: 21 } });
      const sourceRows = full.packable!.records as string[];
      expect(sourceRows).toHaveLength(20);
      const packed = packTextToolResult(full, 950);
      expect(packed.isError).toBeUndefined();
      const rows = JSON.parse(packed.text.split("\n\n[tool meta:", 1)[0]!);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(20);
      const firstUnread = JSON.parse(sourceRows[rows.length]!).lineRange[0];
      expect(packed.text).toContain(`next: ${testPath}@base:${firstUnread}`);
      expect(packed.text).not.toContain("first omitted test reference");
      expect(packed.meta?.omittedCount).toBe(25 - rows.length);
    } finally {
      fixture.dispose();
    }
  });
});
