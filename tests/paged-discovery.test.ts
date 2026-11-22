import { describe, expect, it } from "vitest";
import { packTextToolResult } from "../src/llm/search-result-packing.js";
import { buildSixListFilesTool, buildSixSearchTool } from "../src/llm/tool-definitions.js";
import { writeRepoFile } from "./helpers/git.js";
import { textRepository } from "./helpers/text-repository.js";

function nextCursor(text: string): string {
  const cursor = /cursor=([\w-]+)/u.exec(text)?.[1];
  if (!cursor) throw new Error(`Expected a continuation in ${text}`);
  return cursor;
}

describe("six-tool discovery on pinned Git snapshots", () => {
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
      expect(rejected.text).toContain("track\\(, or use mode=literal");
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

  it("pages whole paths in pinned head order and reports exact omissions", async () => {
    const paths = Array.from({ length: 503 }, (_, index) => `src/path-${String(index).padStart(3, "0")}.ts`);
    const fixture = await textRepository(Object.fromEntries(paths.map(path => [path, "export {};\n"])));
    try {
      writeRepoFile(fixture.repo, "src/untracked.ts", "export {};\n");
      const list = buildSixListFilesTool(fixture.tools);
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
});
