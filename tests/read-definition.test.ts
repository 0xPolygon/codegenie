import { describe, expect, it, vi } from "vitest";
import { textRepository } from "./helpers/text-repository.js";

describe("exact definition lookup", () => {
  it("parses a literal named path directly, distinguishes absent and missing, and never broadens", async () => {
    const fixture = await textRepository({
      "src/[a].ts": "export function Widget() { return 1; }\n",
      "src/a.ts": "export function Widget() { return 2; }\n",
      "src/no-match.ts": "export function Other() {}\n",
      "src/broken.ts": "export const = ;\n",
      "src/quoted.ts": `export function Quoted() { return '${'"'.repeat(9_000)}'; }\n`,
      "data/example.custom": "Widget is mentioned here.\n"
    });
    try {
      const resolver = (fixture.tools as unknown as { opts: { resolver: { grep: (...args: never[]) => unknown } } }).opts.resolver;
      const grep = vi.spyOn(resolver, "grep");
      const exact = await fixture.tools.findDefinition("Widget", { exactPath: "src/[a].ts" });
      expect(exact.meta.lookupStatus).toBe("found");
      expect(exact.definitions.map(hit => hit.symbol.path)).toEqual(["src/[a].ts"]);
      expect(exact.definitions[0]?.text).toContain("return 1");
      expect((await fixture.tools.findDefinition("Widget", { exactPath: "src/no-match.ts" })).meta.lookupStatus).toBe("not_found");
      expect((await fixture.tools.findDefinition("Widget", { exactPath: "src/broken.ts" })).meta.lookupStatus).toBe("unavailable");
      expect((await fixture.tools.findDefinition("Quoted", { exactPath: "src/quoted.ts" })).definitions).toHaveLength(1);
      expect((await fixture.tools.findDefinition("Widget", { exactPath: "src/missing.ts" })).meta.lookupStatus).toBe("file_missing");
      expect((await fixture.tools.findDefinition("Widget", { exactPath: "data/example.custom" })).meta.lookupStatus).toBe("unavailable");
      expect(grep).not.toHaveBeenCalled();
      await expect(fixture.tools.findDefinition("Widget", { exactPath: "../outside.ts" })).rejects.toMatchObject({ code: "path_outside_repo" });
    } finally { fixture.dispose(); }
  });
});

import { buildReadDefinitionTool } from "../src/llm/definition-tool.js";
import { definitionCursor } from "../src/repo/definition-page.js";
import { packDefinitionPage, packDefinitionToolResult } from "../src/llm/definition-result-packing.js";
import { createToolResultCache } from "../src/llm/tool-result-cache.js";

describe("read_definition delivery", () => {
  it("pages declaration rows separately from body recovery, preserving source and cursors", async () => {
    const fixture = await textRepository({
      "src/methods.ts": `class A { run() { return 1; } }\nclass B { run() {\n${Array.from({ length: 60 }, (_, n) => `    const value${n} = ${n};`).join("\n")}\n    return 2;\n} }\nclass C { run() { return 3; } }\n`,
      "src/one.ts": "export function Alone() { return 7; }\n",
      "src/many.ts": Array.from({ length: 25 }, (_, n) => `class Owner${n} { run() { return ${n}; } }`).join("\n") + "\n",
      "src/long.ts": `export function LongBody() {\n${Array.from({ length: 280 }, (_, n) => `  const x${n} = ${n};`).join("\n")}\n}\n`,
      "src/deleted.ts": "class A { old() {} }\nclass B { old() {} }\n"
    }, { "src/deleted.ts": "export const removed = true;\n" });
    try {
      const tool = buildReadDefinitionTool(fixture.tools);
      const canonical = await tool.execute({ name: "run", path: "src/methods.ts" }, new AbortController().signal);
      const page = canonical.definitionPage!;
      expect(page.hits).toHaveLength(3);
      expect(page.hits.map(hit => hit.symbol.ownerType)).toEqual(["A", "B", "C"]);
      const oneBody = Array.from({ length: canonical.text.length }, (_, budget) => budget)
        .map(budget => packDefinitionPage(page, budget))
        .find(result => result.text.includes("Bodies delivered in full for rows 1-1.") && result.text.includes("For rows 2-3"));
      expect(oneBody?.meta).toMatchObject({ truncated: true, deliveryStatus: "truncated" });
      expect(oneBody?.text).toContain("1. src/methods.ts@head A.run");
      expect(oneBody?.text).toContain("3. src/methods.ts@head C.run");
      expect(oneBody?.text).not.toContain("More declarations:");
      expect(oneBody?.rawSource).toBeUndefined();
      const many = await tool.execute({ name: "run", path: "src/many.ts" }, new AbortController().signal);
      expect(many.definitionPage?.hits).toHaveLength(25);
      const firstPage = packDefinitionPage(many.definitionPage!, 1_000);
      const pageCursor = firstPage?.text.match(/continue with cursor ([\w-]+)/u)?.[1];
      expect(pageCursor).toBeTruthy();
      const pageTwo = await tool.execute({ name: "run", path: "src/many.ts", cursor: pageCursor }, new AbortController().signal);
      expect(pageTwo.definitionPage?.offset).toBeGreaterThan(0);
      expect(pageTwo.text).not.toContain("Owner0.run");
      const next = definitionCursor(page, 1);
      const resumed = await tool.execute({ name: "run", path: "src/methods.ts", cursor: next }, new AbortController().signal);
      expect(resumed.definitionPage?.offset).toBe(1);
      expect(resumed.text).toContain("B.run");
      expect(resumed.text).not.toContain("A.run");
      const bad = await tool.execute({ name: "Alone", path: "src/methods.ts", cursor: next }, new AbortController().signal);
      expect(bad).toMatchObject({ isError: true, errorCode: "invalid_args" });
      const absent = await tool.execute({ name: "Missing", path: "src/one.ts" }, new AbortController().signal);
      expect(absent.meta?.lookupStatus).toBe("not_found");
      expect(packDefinitionToolResult(absent, 9)).toMatchObject({ isError: true, errorCode: "budget_exhausted", meta: { lookupStatus: "not_found" } });
      expect(packDefinitionPage(page, 1)).toMatchObject({ isError: true, errorCode: "budget_exhausted" });
      const single = await tool.execute({ name: "Alone", path: "src/one.ts" }, new AbortController().signal);
      expect(single.rawSource).toBe("export function Alone() { return 7; }");
      expect(single.sourceLineRange).toEqual([1, 1]);
      const cache = createToolResultCache();
      const args = { name: "Alone", path: "src/one.ts" };
      await cache.execute({ toolName: tool.name, args, run: () => tool.execute(args, new AbortController().signal) });
      const hit = await cache.execute({ toolName: tool.name, args, run: () => tool.execute(args, new AbortController().signal) });
      expect(hit.status).toBe("hit");
      expect(packDefinitionToolResult(hit.result, 1)).toMatchObject({ isError: true, errorCode: "budget_exhausted" });
      expect(packDefinitionToolResult(hit.result, 5_000).rawSource).toBe(single.rawSource);
      const long = await tool.execute({ name: "LongBody", path: "src/long.ts" }, new AbortController().signal);
      expect(long.meta?.truncated).toBe(true);
      expect(long.text).toContain("Body continues: read_range src/long.ts@head:251-282");
      expect(long.text).toContain("Bodies delivered in full for rows none.");
      expect(long.rawSource).toBeUndefined();
      const longLocationOnly = packDefinitionToolResult(long, 500);
      expect(longLocationOnly.text).toContain("For rows 1-1, use read_range at their stated intervals.");
      expect(longLocationOnly.text).not.toContain("Recovery: read_range src/long.ts@head:251");
      const auto = await tool.execute({ name: "old", path: "src/deleted.ts", source: { kind: "auto" } }, new AbortController().signal);
      expect(auto.definitionPage?.sourceUsed).toBe("base");
      const autoCursor = definitionCursor(auto.definitionPage!, 1);
      const wrongTree = await tool.execute({ name: "old", path: "src/deleted.ts", source: { kind: "head" }, cursor: autoCursor }, new AbortController().signal);
      expect(wrongTree).toMatchObject({ isError: true, errorCode: "invalid_args" });
    } finally { fixture.dispose(); }
  });
});
