import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textRepository } from "./helpers/text-repository.js";
import { createToolResultCache } from "../src/llm/tool-result-cache.js";
import { packOutlineToolResult } from "../src/llm/search-result-packing.js";
import { writeRepoFile } from "./helpers/git.js";

describe("text tools: exact range and model-facing argument contracts", () => {
  let fixture: Awaited<ReturnType<typeof textRepository>>;
  beforeAll(async () => {
    fixture = await textRepository({
      "schema/policy.ridl": "first\nsecond\nthird", "empty.custom": "", "crlf.custom": "one\r\ntwo\r\nthree\r\n",
      "unicode.custom": "Café\n用户 🔑\nfin\n", "large.custom": Array.from({ length: 620 }, (_, i) => `line ${i + 1}`).join("\n"),
      "wide.custom": "x".repeat(20_000), "revision.custom": "base-only\nbase-tail"
    }, { "revision.custom": "head-only\nhead-tail" });
    writeRepoFile(fixture.repo, "revision.custom", "dirty-only");
    writeRepoFile(fixture.repo, "untracked.custom", "untracked-only");
  });
  afterAll(() => fixture?.dispose());

  it.each([
    [1, 1, "first"], [2, 2, "second"], [1, 2, "first\nsecond"], [2, 3, "second\nthird"],
    [3, 99, "third"], [4, 99, ""], [10_000, 10_010, ""]
  ])("returns exactly the requested inclusive lines %i..%i", async (startLine, endLine, expected) => {
    const result = await fixture.tools.readRange("schema/policy.ridl", startLine as number, endLine as number);
    expect(result.text).toBe(expected);
    expect(result.meta).toMatchObject({ backend: "text", precision: "exact", degraded: false, lookupStatus: "found", deliveryStatus: expected === "" ? "empty" : "full" });
    expect(result.meta.truncated).not.toBe(true);
  });

  it("retains delivered range bounds through the cache, including EOF clipping", async () => {
    const cache = createToolResultCache();
    const args = { path: "schema/policy.ridl", startLine: 2, endLine: 99 };
    let executions = 0;
    const run = async () => { executions++; return fixture.call("read_range", args); };
    const first = await cache.execute({ toolName: "read_range", args, run });
    expect(first.result.sourceLineRange).toEqual([2, 3]);
    first.result.sourceLineRange![1] = 99;
    const cached = await cache.execute({ toolName: "read_range", args, run });
    expect(cached.result.sourceLineRange).toEqual([2, 3]);
    expect(executions).toBe(1);
    const empty = await fixture.call("read_range", { ...args, startLine: 100, endLine: 110 });
    expect(empty.sourceLineRange).toBeUndefined();
    const truncated = await fixture.call("read_range", { path: "large.custom", startLine: 1, endLine: 600 });
    expect(truncated.sourceLineRange).toBeUndefined();
  });

  it.each(["list_files", "read_file_outline"])("preserves canonical %s payloads across cache hits", async toolName => {
    const cache = createToolResultCache();
    const args = toolName === "list_files" ? { glob: "**/*.ridl" } : { path: "schema/policy.ridl" };
    const result = await fixture.call(toolName, args);
    expect(toolName === "list_files" ? result.filePaths : result.outline).toBeDefined();
    let executions = 0;
    const run = async () => { executions++; return result; };
    const first = await cache.execute({ toolName, args, run });
    expect(first.result).toEqual(result);
    first.result.filePaths?.push("mutated.ridl");
    if (first.result.outline) first.result.outline.path = "mutated.ridl";
    const cached = await cache.execute({ toolName, args, run });
    expect(cached.result).toEqual(result);
    expect(executions).toBe(1);
  });

  it("counts canonical payloads toward cache storage limits", async () => {
    const cache = createToolResultCache({ maxStoredResultChars: 100 });
    const result = { text: "files", filePaths: ["x".repeat(101)] };
    let executions = 0;
    const run = async () => { executions++; return result; };
    const input = { toolName: "list_files", args: {}, run };
    expect((await cache.execute(input)).evictedEntries).toBe(1);
    await cache.execute(input);
    expect(executions).toBe(2);
  });

  it.each([
    { startLine: 0, endLine: 1 }, { startLine: -1, endLine: 2 }, { startLine: 3, endLine: 2 },
    { startLine: 1.5, endLine: 3 }, { startLine: 1, endLine: Number.NaN },
    { startLine: 1, endLine: Infinity }, { startLine: undefined, endLine: 3 },
    { startLine: 1, endLine: undefined }, { startLine: 1, endLine: Number.MAX_SAFE_INTEGER + 1 }
  ])("rejects invalid bounds at the repository boundary: $startLine..$endLine", async bounds => {
    await expect(fixture.tools.readRange("schema/policy.ridl", bounds.startLine as number, bounds.endLine as number))
      .rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining("both startLine and endLine") });
  });

  it.each([{ endLine: 3 }, { startLine: 1 }, { startLine: 0, endLine: 3 }, { startLine: 1.5, endLine: 3 }, { startLine: 4, endLine: 3 }, { startLine: 1, endLine: Number.MAX_SAFE_INTEGER + 1 }])(
    "requires valid bounds in the actual model tool schema: %j", async bounds => {
      await expect(fixture.call("read_range", { path: "schema/policy.ridl", ...bounds })).rejects.toThrow();
    });

  it("distinguishes empty files, ranges beyond EOF, and missing revision paths", async () => {
    expect(await fixture.tools.readRange("empty.custom", 1, 10)).toMatchObject({ text: "", meta: { lookupStatus: "found", deliveryStatus: "empty", degraded: false } });
    expect((await fixture.call("read_range", { path: "schema/policy.ridl", startLine: 100, endLine: 110 })).meta)
      .toMatchObject({ lookupStatus: "found", deliveryStatus: "empty", degraded: false });
    expect((await fixture.call("read_diff_blocks", { path: "schema/policy.ridl" })).meta)
      .toMatchObject({ lookupStatus: "not_found", deliveryStatus: "empty" });
    const missing = await fixture.call("read_range", { path: "missing.custom", startLine: 1, endLine: 2 });
    expect(missing.meta).toMatchObject({ lookupStatus: "file_missing", deliveryStatus: "empty" });
    expect(missing.text).toContain("lookup: file_missing");
    expect((await fixture.tools.readRange("untracked.custom", 1, 2)).meta.lookupStatus).toBe("file_missing");
  });

  it("preserves text and reads the requested committed revision, never dirty content", async () => {
    expect((await fixture.tools.readRange("revision.custom", 1, 1)).text).toBe("head-only");
    expect((await fixture.tools.readRange("revision.custom", 1, 1, { kind: "base" })).text).toBe("base-only");
    expect((await fixture.tools.readRange("unicode.custom", 2, 2)).text).toBe("用户 🔑");
    expect((await fixture.tools.readRange("crlf.custom", 2, 2)).text).toBe("two\r");
  });

  it.each(["head", "base"] as const)("missing-file feedback guides discovery at %s without substituting another file", async kind => {
    for (const [name, args] of [
      ["read_range", { startLine: 1, endLine: 3 }],
      ["read_file_outline", {}],
      ["read_symbol", { symbolName: "second" }]
    ] as const) {
      const result = await fixture.call(name, { path: "schema/missing.ridl", source: { kind }, ...args });
      expect(result.meta).toMatchObject({ lookupStatus: "file_missing", deliveryStatus: "empty", requestedSource: kind });
      expect(result.text).toContain("The requested file does not exist at the selected revision");
      expect(result.text).toContain("list_files (head only)");
      expect(result.text).toContain("search_files/find_definition with the intended source revision");
      expect(result.text).not.toContain("second");
      expect(result.sourceLineRange).toBeUndefined();
      const empty = await fixture.call(name, { path: "empty.custom", source: { kind }, ...args });
      expect(empty.meta?.lookupStatus).not.toBe("file_missing");
      expect(empty.text).not.toContain("The requested file does not exist");
    }
    const beyondEof = await fixture.call("read_range", { path: "schema/policy.ridl", startLine: 100, endLine: 110, source: { kind } });
    expect(beyondEof.meta?.lookupStatus).toBe("found");
    expect(beyondEof.text).not.toContain("The requested file does not exist");
  });

  it("preserves missing-file recovery guidance when a cached outline is packed", async () => {
    const cache = createToolResultCache();
    const args = { path: "schema/missing.ridl", source: { kind: "base" } };
    const run = () => fixture.call("read_file_outline", args);
    await cache.execute({ toolName: "read_file_outline", args, run });
    const cached = await cache.execute({ toolName: "read_file_outline", args, run });
    expect(cached.status).toBe("hit");
    const allowance = cached.result.text.length - 1;
    const packed = packOutlineToolResult(cached.result, allowance);
    expect(packed.isError).not.toBe(true);
    expect(packed.text.length).toBeLessThanOrEqual(allowance);
    expect(packed.meta).toMatchObject({ lookupStatus: "file_missing", deliveryStatus: "empty", sourceUsed: "base" });
    expect(JSON.parse(packed.text).notice).toContain("The requested file does not exist at the selected revision");
    expect(packed.text).toContain("list_files (head only)");
    expect(packed.text).toContain("intended source revision");
    expect(packOutlineToolResult(cached.result, 1)).toMatchObject({ isError: true, errorCode: "budget_exhausted" });
    expect((await cache.execute({ toolName: "read_file_outline", args, run })).result).toEqual(cached.result);
  });

  it("discloses line and character caps and permits a later bounded read", async () => {
    const lines = await fixture.tools.readRange("large.custom", 1, 620);
    expect(lines.text.split("\n")).toHaveLength(400);
    expect(lines.text.endsWith("line 400")).toBe(true);
    expect(lines.meta).toMatchObject({ deliveryStatus: "truncated", truncated: true, omittedCount: 220 });
    const tail = await fixture.tools.readRange("large.custom", 401, 620);
    expect(tail.text.split("\n")).toHaveLength(220);
    expect(tail.meta.deliveryStatus).toBe("full");
    const wide = await fixture.call("read_range", { path: "wide.custom", startLine: 1, endLine: 1 });
    expect(wide.meta).toMatchObject({ deliveryStatus: "truncated", truncated: true });
    expect(wide.text).toContain("delivery: truncated");
    expect((await fixture.tools.readRange("wide.custom", 1, 1)).text).toHaveLength(16_000);
  });

  it.each(["../outside", "/etc/passwd", ".git/config"])("rejects unsafe paths instead of empty reads: %s", async path => {
    expect(await fixture.call("read_range", { path, startLine: 1, endLine: 2 })).toMatchObject({ isError: true, errorCode: "path_outside_repo" });
  });

  it("keeps tool descriptions explicit about required bounds and unavailable syntax", () => {
    const description = (name: string) => fixture.definitions.find(tool => tool.name === name)!.description;
    expect(description("read_range")).toContain("Both startLine and endLine are required");
    expect(description("read_range")).toContain("start beyond EOF returns empty text");
    expect(description("list_files")).toContain("not a regular expression or gitignore file");
    expect(description("search_files")).toContain("POSIX ERE");
    expect(description("search_files")).toContain("Invalid syntax is an error");
    expect(description("read_file_outline")).toContain("symbolExtraction is unavailable");
    for (const name of ["read_range", "read_symbol", "read_file_outline"]) {
      expect(description(name)).toContain("package/import directories and function names do not establish filenames");
      expect(description(name)).toContain("Discover unknown paths with list_files (head only), find_definition or search_files");
    }
    expect(description("find_symbol_mentions")).toContain("including comments/strings");
  });
});
