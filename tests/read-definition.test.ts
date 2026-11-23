import { describe, expect, it, vi } from "vitest";
import { textRepository } from "./helpers/text-repository.js";
import { buildReadDefinitionTool } from "../src/llm/definition-tool.js";
import { definitionCursor, makeDefinitionPage } from "../src/repo/definition-page.js";
import { packDefinitionPage, packDefinitionToolResult } from "../src/llm/definition-result-packing.js";
import { createToolResultCache } from "../src/llm/tool-result-cache.js";

describe("exact definition lookup", () => {
  it("finds literal object callables without inventing a receiver or changing legacy lookup", async () => {
    const fixture = await textRepository({
      "src/client.ts": `export function makeClient() { return {
  async lsTree() { return 1; },
  plain() { return 2; },
  fn: function () { return 3; },
  arrow: () => 4,
  asyncArrow: async () => 5,
  [dynamic]: () => 6,
  ...spread,
  get computed() { return 7; },
}; }
export const client = { bound() { return 8; } };
export class Service { process() { return 10; } }
`,
      "src/other.ts": "export function lsTree() { return 9; }\n",
      "src/dual.ts": "export function finalize() { return 1; }\nexport const wrapper = { finalize() { return 2; } };\n",
      "src/objects.ts": "export const a = { run() { return 1; } };\nexport const b = { run() { return 2; } };\n",
      "src/store.go": "package store\ntype Store struct{}\nfunc (s *Store) Save() {}\ntype Other struct{}\nfunc (o *Other) Save() {}\n"
    });
    try {
      const tool = buildReadDefinitionTool(fixture.tools);
      for (const name of ["lsTree", "plain", "fn", "arrow", "asyncArrow"]) {
        const result = await tool.execute({ name, path: "src/client.ts" }, new AbortController().signal);
        expect(result.meta?.lookupStatus, name).toBe("found");
        expect(result.definitionPage?.hits).toHaveLength(1);
        expect(result.definitionPage?.hits[0]?.symbol).toMatchObject({ name, nativeKind: "object method" });
        expect(result.definitionPage?.hits[0]?.symbol.ownerType).toBeUndefined();
      }
      const bound = await tool.execute({ name: "client.bound", path: "src/client.ts" }, new AbortController().signal);
      expect(bound.definitionPage?.hits[0]?.symbol).toMatchObject({ name: "bound", ownerType: "client" });
      const classMethod = await tool.execute({ name: "Service.process", path: "src/client.ts" }, new AbortController().signal);
      expect(classMethod.definitionPage?.hits[0]?.symbol).toMatchObject({ name: "process", ownerType: "Service" });
      for (const name of ["Client.lsTree", "dynamic", "computed", "spread"]) {
        const result = await tool.execute({ name, path: "src/client.ts" }, new AbortController().signal);
        expect(result.definitionPage?.hits ?? [], name).toHaveLength(0);
      }
      expect((await fixture.tools.findDefinition("lsTree", { exactPath: "src/client.ts" })).meta.lookupStatus).toBe("not_found");
      const all = await tool.execute({ name: "lsTree" }, new AbortController().signal);
      expect(all.meta?.lookupStatus).toBe("found");
      expect(all.definitionPage?.hits.map(hit => hit.symbol.path)).toEqual(["src/other.ts"]);
      expect(all.text).toContain("src/client.ts@head:2-2");
      expect(all.text).toContain("Use read_range");
      expect(all.text).toContain("additional same-name object member");
      const dual = await tool.execute({ name: "finalize", path: "src/dual.ts" }, new AbortController().signal);
      expect(dual.meta?.lookupStatus).toBe("found");
      expect(dual.definitionPage?.hits).toHaveLength(1);
      expect(dual.text).toContain("src/dual.ts@head:2-2");
      expect(dual.text).toContain("Use read_range");
      expect(dual.text).toContain('read_range({"path":"src/dual.ts","startLine":2,"endLine":2,"source":{"kind":"head"}})');
      const objects = await tool.execute({ name: "run", path: "src/objects.ts" }, new AbortController().signal);
      expect(objects.meta?.lookupStatus).toBe("ambiguous");
      expect(objects.definitionPage?.hits.map(hit => hit.symbol.ownerType)).toEqual(["a", "b"]);
      for (const name of ["Store.Save", "(*Store).Save", "store.Store.Save"]) {
        const method = await tool.execute({ name, path: "src/store.go" }, new AbortController().signal);
        expect(method.meta?.lookupStatus, name).toBe("found");
        expect(method.definitionPage?.hits).toHaveLength(1);
        expect(method.definitionPage?.hits[0]?.symbol).toMatchObject({ name: "Save", ownerType: "Store" });
      }
      const unknownOwner = await tool.execute({ name: "Missing.Save", path: "src/store.go" }, new AbortController().signal);
      expect(unknownOwner.meta?.lookupStatus).toBe("not_found");
      const resolver = (fixture.tools as unknown as { opts: { resolver: { listFiles: (...args: never[]) => unknown } } }).opts.resolver;
      const listFiles = vi.spyOn(resolver, "listFiles");
      const directory = await tool.execute({ name: "lsTree", path: "src" }, new AbortController().signal);
      expect(directory).toMatchObject({ isError: true, errorCode: "invalid_args" });
      expect(directory.text).toContain("is a directory");
      expect(directory.text).toContain("exact file path");
      expect((await tool.execute({ name: "lsTree", path: "missing" }, new AbortController().signal)).meta?.lookupStatus).toBe("file_missing");
      expect(listFiles).toHaveBeenCalledTimes(1);
    } finally { fixture.dispose(); }
  });

  it("bounds member disclosures and keeps the selected revision in actionable reads", async () => {
    const base = "export function run() {}\n" + Array.from({ length: 25 }, (_, i) =>
      `export const item${i} = { run() { return ${i}; } };\n`).join("");
    const fixture = await textRepository({ "src/many-members.ts": base }, {
      "src/many-members.ts": "export function run() { return 'head'; }\n"
    });
    try {
      const tool = buildReadDefinitionTool(fixture.tools);
      const result = await tool.execute({ name: "run", path: "src/many-members.ts", source: { kind: "base" } }, new AbortController().signal);
      expect(result.meta?.lookupStatus).toBe("found");
      expect(result.definitionPage?.hits).toHaveLength(1);
      expect(result.text).toContain("25 additional same-name object member(s)");
      expect(result.text).toContain("5 more not listed");
      expect(result.text).toContain('"source":{"kind":"base"}');
      expect(result.text).not.toContain("src/many-members.ts@head:");
    } finally { fixture.dispose(); }
  });

  it("counts verified object hits separately from unverified text leads without changing the old tier", async () => {
    const fixture = await textRepository({
      "src/client.ts": "export function makeClient() { return { go() { return 1; }, open() { return 2; } }; }\n",
      "src/existing.ts": "export function open() { return 3; }\n",
      "vendor/leads.custom": "function go() {}\nfunction open() {}\n"
    });
    try {
      const tool = buildReadDefinitionTool(fixture.tools);
      const object = await tool.execute({ name: "go" }, new AbortController().signal);
      expect(object.meta?.lookupStatus).toBe("found");
      expect(object.definitionPage?.hits).toHaveLength(2);
      expect(object.text).toContain("Verified declarations:");
      expect(object.text).toContain("Unverified text leads:");
      const oldTier = await fixture.tools.findDefinition("open");
      const sameTier = await tool.execute({ name: "open" }, new AbortController().signal);
      expect(oldTier.meta.lookupStatus).toBe("ambiguous");
      expect(sameTier.meta?.lookupStatus).toBe(oldTier.meta.lookupStatus);
      expect(sameTier.definitionPage?.hits.map(hit => hit.symbol.path)).toEqual(oldTier.definitions.map(hit => hit.symbol.path));
      expect(sameTier.text).toContain("Verified declarations are identified above");
    } finally { fixture.dispose(); }
  });

  it("keeps object lookup ambiguous when a result cap omits a discovered declaration", async () => {
    const longBody = "x".repeat(9_100);
    const fixture = await textRepository({
      "src/a.ts": `export const a = { run() { return '${longBody}'; } };\n`,
      "src/b.ts": `export const b = { run() { return '${longBody}'; } };\n`
    });
    try {
      const result = await buildReadDefinitionTool(fixture.tools).execute({ name: "run" }, new AbortController().signal);
      expect(result.definitionPage?.hits).toHaveLength(1);
      expect(result.meta).toMatchObject({ lookupStatus: "ambiguous", deliveryStatus: "truncated", omittedCount: 1 });
    } finally { fixture.dispose(); }
  });

  it("keeps the verified location when the only object body exceeds the serialization cap", async () => {
    const quotes = '"'.repeat(9_000);
    const fixture = await textRepository({ "src/a.ts": `export const a = { run() { return '${quotes}'; } };\n` });
    try {
      const result = await buildReadDefinitionTool(fixture.tools).execute({ name: "run" }, new AbortController().signal);
      expect(result.meta).toMatchObject({ lookupStatus: "found", deliveryStatus: "truncated", truncated: true, omittedCount: 1 });
      expect(result.definitionPage?.hits).toHaveLength(1);
      expect(result.definitionPage?.hits[0]).toMatchObject({ symbol: { path: "src/a.ts", lineRange: [1, 1] }, nextLine: 1 });
      expect(result.definitionPage?.hits[0]?.text).toBeUndefined();
      expect(result.text).toContain("src/a.ts@head");
      expect(result.text).toContain("read_range");
      expect(result.rawSource).toBeUndefined();
    } finally { fixture.dispose(); }
  });

  it("parses a literal named path directly, distinguishes absent and missing, and never broadens", async () => {
    const fixture = await textRepository({
      "src/[a].ts": "export function Widget() { return 1; }\n",
      "src/a.ts": "export function Widget() { return 2; }\n",
      "src/no-match.ts": "export function Other() {}\n",
      "src/broken.ts": "export const = ;\n",
      "src/quoted.ts": `export function Quoted() { return '${'"'.repeat(9_000)}'; }\n`,
      "data/example.custom": "Widget is mentioned here.\n",
      "data/lead.custom": "function Widget() {}\n"
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
      const missing = await buildReadDefinitionTool(fixture.tools).execute({ name: "Widget", path: "src/missing.ts" }, new AbortController().signal);
      expect(missing.text).toContain("read_definition with name and source and without path");
      expect(missing.text).not.toContain("find_definition");
      expect((await fixture.tools.findDefinition("Widget", { exactPath: "data/example.custom" })).meta.lookupStatus).toBe("unavailable");
      const unavailable = await buildReadDefinitionTool(fixture.tools).execute({ name: "Widget", path: "data/example.custom" }, new AbortController().signal);
      expect(unavailable.meta?.lookupStatus).toBe("unavailable");
      expect(unavailable.text).toContain("use read_range or find_usages");
      expect(unavailable.text).not.toContain("find_symbol_mentions");
      const lead = await buildReadDefinitionTool(fixture.tools).execute({ name: "Widget", path: "data/lead.custom" }, new AbortController().signal);
      expect(lead.text).toContain("Unverified text lead: data/lead.custom@head lines 1-1 of 1");
      expect(packDefinitionToolResult(unavailable, 9)).toMatchObject({ isError: true, errorCode: "budget_exhausted", meta: { lookupStatus: "unavailable" } });
      expect(grep).not.toHaveBeenCalled();
      await expect(fixture.tools.findDefinition("Widget", { exactPath: "../outside.ts" })).rejects.toMatchObject({ code: "path_outside_repo" });
    } finally { fixture.dispose(); }
  });
});

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
      const bounded = makeDefinitionPage("run", {}, { definitions: page.hits, meta: { ...page.meta,
        lookupNote: "Candidate scan was bounded. Narrow pathGlob; this occurrence is not a verified definition." } }, { headCommit: "head", baseCommit: "base" });
      expect(packDefinitionPage(bounded, 100_000).text).toContain("Narrow the path");
      expect(packDefinitionPage(bounded, 100_000).text).not.toContain("pathGlob");
      const unchecked = makeDefinitionPage("run", {}, { definitions: [], meta: { ...page.meta,
        lookupStatus: "unavailable", lookupNote: "Not checked: 1 text mention in docs/example.md; use find_symbol_mentions." } }, { headCommit: "head", baseCommit: "base" });
      expect(packDefinitionPage(unchecked, 100_000).text).toContain("use find_usages");
      expect(packDefinitionPage(unchecked, 100_000).text).not.toContain("find_symbol_mentions");
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
