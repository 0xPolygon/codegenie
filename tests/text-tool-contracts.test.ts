import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textRepository } from "./helpers/text-repository.js";
import { createToolResultCache } from "../src/llm/tool-result-cache.js";
import { createPackableToolResult, packOutlineToolResult, packSearchToolResult, packTextToolResult } from "../src/llm/search-result-packing.js";
import { withMeta } from "../src/llm/repository-tool-guidance.js";
import type { ToolResultMeta } from "../src/types.js";
import { writeRepoFile } from "./helpers/git.js";

describe("text tools: exact range and model-facing argument contracts", () => {
  it("preserves definition lookup guidance in an uncut result", () => {
    const meta: ToolResultMeta = { backend: "text", precision: "text", degraded: false,
      lookupStatus: "unavailable", lookupNote: "Not checked: use find_symbol_mentions.", deliveryStatus: "empty" };
    const text = withMeta("[]", meta);
    expect(text).toBe("[]\n\n[tool meta: lookup: unavailable; Not checked: use find_symbol_mentions.; delivery: empty]");
  });
  let fixture: Awaited<ReturnType<typeof textRepository>>;
  beforeAll(async () => {
    fixture = await textRepository({
      "schema/policy.ridl": "first\nsecond\nthird", "empty.custom": "", "blank-line.custom": "\n", "crlf.custom": "one\r\ntwo\r\nthree\r\n",
      "unicode.custom": "Café\n用户 🔑\nfin\n", "large.custom": Array.from({ length: 620 }, (_, i) => `line ${i + 1}`).join("\n"),
      "src/shared.ts": `export function SharedCall() {\n${Array.from({ length: 25 }, (_, i) => `  const value${i} = ${i};`).join("\n")}\n}\n`,
      "pkg/shared.go": `package pkg\nfunc SharedCall() {\n${Array.from({ length: 20 }, (_, i) => `  value${i} := ${i}`).join("\n")}\n}\n`,
      "src/long.ts": `export function LongDefinition() {\n${Array.from({ length: 300 }, (_, i) => `  const n${i} = ${i};`).join("\n")}\n}\n`,
      "src/huge.ts": `export const HugeDefinition = "${"x".repeat(11_000)}";\n`,
      "src/whitespace.ts": "export function WhitespaceCase() {\n\n\treturn 1;\n}\n",
      "schema/fallback.custom": "function UnverifiedLead() {\n  return 1;\n}\n",
      "terminated.custom": "one\r\n\tsecond\r\n" + "    rest of source\r\n".repeat(40),
      "character-cap.ts": ["const required = makeRequirements();", "x".repeat(15_000), "y".repeat(15_000), "return required;"].join("\n"),
      "wide.custom": "x".repeat(20_000), "revision.custom": "base-only\nbase-tail"
    }, { "revision.custom": "head-only\nhead-tail" });
    writeRepoFile(fixture.repo, "revision.custom", "dirty-only");
    writeRepoFile(fixture.repo, "untracked.custom", "untracked-only");
  });
  afterAll(() => fixture?.dispose());

  it("numbers definition bodies, keeps raw evidence, and resumes whole lines on a caller-budget cut", async () => {
    const result = await fixture.call("find_definition", { symbolName: "SharedCall", pathGlob: "src/shared.ts" });
    expect(result.definitions).toHaveLength(1);
    const raw = result.definitions![0]!;
    expect(raw.symbol.path).toBe("src/shared.ts");
    expect(raw.totalLines).toBe(27);
    expect(raw.deliveredLineRange).toEqual([1, 27]);
    expect(result.text).toContain("src/shared.ts@head declaration lines 1-27 of 27");
    expect(result.text).toContain("1\texport function SharedCall() {");
    expect(result.text).toContain("2\t  const value0 = 0;");
    expect(raw.text).toContain("  const value0 = 0;");
    expect(raw.text).not.toContain("2\t  const");
    const delivered = result.text.split("\n").filter(line => /^\d+\t/u.test(line)).map(line => line.replace(/^\d+\t/u, "")).join("\n");
    expect(delivered).toBe(raw.text);
    expect(packTextToolResult(result, result.text.length)).toBe(result);
    const cut = packTextToolResult(result, 550);
    expect(cut.isError).not.toBe(true);
    expect(cut.meta).toMatchObject({ truncated: true, deliveryStatus: "truncated" });
    expect(cut.text).toMatch(/last delivered: src\/shared\.ts@head:\d+/u);
    expect(cut.text).toMatch(/next: src\/shared\.ts@head:\d+/u);
    const cutLines = cut.text.split("\n").filter(line => /^\d+\t/u.test(line)).map(line => line.replace(/^\d+\t/u, ""));
    expect(cutLines).toEqual(raw.text!.split("\n").slice(0, cutLines.length));
    const rest = await fixture.tools.readRange("src/shared.ts", cutLines.length + 1, 27, { kind: "head" });
    expect([...cutLines, ...rest.text.split("\n")].join("\n")).toBe(raw.text);
    expect(packTextToolResult(result, 1)).toMatchObject({ isError: true, errorCode: "budget_exhausted" });
    const headerOnlyBudget = result.text.indexOf("\n") + 1;
    const refused = packTextToolResult(result, headerOnlyBudget);
    expect(refused).toMatchObject({ isError: true, errorCode: "budget_exhausted" });
    expect(refused.text).toContain("src/shared.ts@head:1");
  });

  it("labels text-only definition leads as unverified windows", async () => {
    const result = await fixture.call("find_definition", { symbolName: "UnverifiedLead", pathGlob: "schema/fallback.custom" });
    expect(result.meta?.lookupStatus).toBe("unavailable");
    expect(result.text).toContain("schema/fallback.custom@head unverified text window lines 1-3 of 3");
    expect(result.text).toContain("1\tfunction UnverifiedLead() {");
  });

  it("labels multiple definition blocks and the exact next source location on a cut", async () => {
    const result = await fixture.call("find_definition", { symbolName: "SharedCall", source: { kind: "base" } });
    expect(result.definitions).toHaveLength(2);
    expect(result.text).toContain("Definition locations:");
    expect(result.text).toContain("pkg/shared.go@base declaration lines 2-23 of 23");
    expect(result.text).toContain("src/shared.ts@base declaration lines 1-27 of 27");
    const cut = packTextToolResult(result, 750);
    expect(cut.isError).not.toBe(true);
    expect(cut.meta).toMatchObject({ truncated: true });
    expect(cut.text).toMatch(/last delivered: (?:pkg\/shared\.go|src\/shared\.ts)@base:\d+/u);
    expect(cut.text).toMatch(/next: (?:pkg\/shared\.go|src\/shared\.ts)@base:\d+/u);
    const atBoundary = Array.from({ length: result.text.length }, (_, allowance) => allowance)
      .map(allowance => packTextToolResult(result, allowance))
      .find(packed => !packed.isError && packed.text.includes("next: src/shared.ts@base:1"));
    expect(atBoundary?.text).toContain("last delivered: pkg/shared.go@base:23");
    const cache = createToolResultCache();
    const args = { symbolName: "SharedCall", source: { kind: "base" } };
    const first = await cache.execute({ toolName: "find_definition", args, run: async () => result });
    const smaller = packTextToolResult(first.result, 750);
    const again = await cache.execute({ toolName: "find_definition", args, run: async () => result });
    expect(again.status).toBe("hit");
    expect(packTextToolResult(again.result, result.text.length).text).toBe(result.text);
    expect(smaller.meta?.truncated).toBe(true);
  });

  it("reports the first unread source line for a backend-truncated definition", async () => {
    const result = await fixture.call("find_definition", { symbolName: "LongDefinition", pathGlob: "src/long.ts" });
    const hit = result.definitions![0]!;
    expect(result.meta).toMatchObject({ truncated: true, deliveryStatus: "truncated" });
    expect(hit.nextLine).toBe((hit.deliveredLineRange?.[1] ?? 0) + 1);
    expect(result.text).toContain(`source continues at src/long.ts@head:${hit.nextLine}`);
    const callerCut = packTextToolResult(result, 700);
    expect(callerCut.isError).not.toBe(true);
    const firstUnread = Number(callerCut.text.match(/next: src\/long\.ts@head:(\d+)/u)?.[1]);
    expect(firstUnread).toBeGreaterThan(1);
    expect(firstUnread).toBeLessThan(hit.nextLine!);
    expect(callerCut.text).not.toContain(`startLine=${hit.nextLine}`);
    expect(callerCut.meta?.recovery).toBeUndefined();
    const rest = await fixture.tools.readRange("src/long.ts", hit.nextLine!, hit.symbol.lineRange[1], { kind: "head" });
    const source = (await fixture.tools.readRange("src/long.ts", 1, hit.symbol.lineRange[1], { kind: "head" })).text;
    expect(`${hit.text}\n${rest.text}`).toBe(source);
  });

  it("refuses an oversized first definition line without claiming source delivery", async () => {
    const result = await fixture.call("find_definition", { symbolName: "HugeDefinition", pathGlob: "src/huge.ts" });
    expect(result).toMatchObject({ isError: true, errorCode: "budget_exhausted", meta: { deliveryStatus: "budget_rejected" } });
    expect(result.text).toContain("path=src/huge.ts startLine=1");
  });

  it("preserves blank lines and existing tabs after removing generated definition positions", async () => {
    const result = await fixture.call("find_definition", { symbolName: "WhitespaceCase", pathGlob: "src/whitespace.ts" });
    const sourceLines = result.text.split("\n").filter(line => /^\d+\t/u.test(line)).map(line => line.replace(/^\d+\t/u, ""));
    expect(sourceLines.join("\n")).toBe(result.definitions![0]!.text);
    expect(sourceLines).toEqual(["export function WhitespaceCase() {", "", "\treturn 1;", "}"]);
  });

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
    const beyond = await fixture.call("read_range", { path: "crlf.custom", startLine: 4, endLine: 9, source: { kind: "base" } });
    expect(beyond.text).toContain("crlf.custom@base has 3 lines; requested lines 4-9");
    expect(beyond.text).toContain("delivered lines: none");
    expect(beyond.meta).toMatchObject({ totalLines: 3, deliveryStatus: "empty" });
    const throughEof = await fixture.call("read_range", { path: "crlf.custom", startLine: 2, endLine: 9 });
    expect(throughEof.sourceLineRange).toEqual([2, 3]);
    expect(throughEof.text).toBe("crlf.custom@head lines 2-3 of 3\n2\ttwo\r\n3\tthree\r\n\n\n[tool meta: source: requested head, used head; lookup: found; delivery: full]");
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

  it("numbers a blank line and reports the base revision of a complete read", async () => {
    const blank = await fixture.call("read_range", { path: "blank-line.custom", startLine: 1, endLine: 1 });
    expect(blank.meta).toMatchObject({ deliveredLineRange: [1, 1], deliveryStatus: "full", totalLines: 1 });
    expect(blank.text).toContain("blank-line.custom@head lines 1-1 of 1\n1\t\n\n");
    const base = await fixture.call("read_range", { path: "revision.custom", startLine: 2, endLine: 2, source: { kind: "base" } });
    expect(base.text).toContain("revision.custom@base lines 2-2 of 2\n2\tbase-tail\n\n");
    const headerLength = "revision.custom@base lines 2-2 of 2".length;
    const refused = packTextToolResult(base, headerLength);
    expect(refused.meta).toMatchObject({ deliveryStatus: "budget_rejected", totalLines: 2 });
    expect(refused.meta?.deliveredLineRange).toBeUndefined();
    expect(refused.text).toContain("delivered lines: none; next undelivered line: 2");
    expect(refused.text).not.toContain("base-tail");
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
    const bounded = await fixture.call("read_range", { path: "large.custom", startLine: 1, endLine: 800 });
    expect(bounded.text).toContain("delivered lines 1-400 of 620; continue with startLine=401, endLine=800");
    const tail = await fixture.tools.readRange("large.custom", 401, 620);
    expect(tail.text.split("\n")).toHaveLength(220);
    expect(tail.meta.deliveryStatus).toBe("full");
    const wide = await fixture.call("read_range", { path: "wide.custom", startLine: 1, endLine: 1 });
    expect(wide).toMatchObject({ isError: true, errorCode: "budget_exhausted",
      meta: { deliveryStatus: "budget_rejected", truncated: true, omittedCount: 1 } });
    expect(wide.text).toContain("Source line 1 exceeds the source character limit");

    const characterCap = await fixture.call("read_range", { path: "character-cap.ts", startLine: 1, endLine: 8 });
    expect(characterCap.meta).toMatchObject({ deliveryStatus: "truncated", omittedCount: 2, deliveredLineRange: [1, 2] });
    expect(characterCap.text).toContain("delivered lines 1-2 of 4; continue with startLine=3, endLine=8");
    expect(characterCap.text).not.toContain("y".repeat(10));
    const continuation = await fixture.tools.readRange("character-cap.ts", 3, 8);
    expect(continuation.text).toBe("y".repeat(15_000) + "\nreturn required;");
  });

  it("repacks a real range at a smaller allowance and resumes on the first omitted line", async () => {
    const args = { path: "large.custom", startLine: 39, endLine: 166, source: { kind: "base" as const } };
    const canonical = await fixture.call("read_range", args);
    expect(packTextToolResult(canonical, canonical.text.length)).toBe(canonical);
    const packed = packTextToolResult(canonical, 448);
    const range = packed.meta!.deliveredLineRange!;
    expect(range[0]).toBe(39);
    expect(range[1]).toBeLessThan(166);
    const next = await fixture.tools.readRange(args.path, range[1] + 1, args.endLine, args.source);
    const deliveredText = packed.text.split("\n\n[tool meta:")[0];
    const [header, ...deliveredLines] = deliveredText!.split("\n");
    expect(header).toBe(`large.custom@base lines 39-${range[1]} of 620`);
    expect(deliveredLines.join("\n") + "\n" + next.text.split("\n").map((line, i) => `${range[1] + 1 + i}\t${line}`).join("\n"))
      .toBe(canonical.packable!.records.join("\n"));
    expect(packed.text).toContain(`continue with startLine=${range[1] + 1}, endLine=166`);
  });

  it("attributes a second cut of a capped range to the caller budget", async () => {
    const canonical = await fixture.call("read_range", { path: "large.custom", startLine: 1, endLine: 620 });
    expect(canonical.meta).toMatchObject({ degradationReason: "source_line_limit", omittedCount: 220 });

    const packed = packTextToolResult(canonical, 448);
    expect(packed.meta).toMatchObject({ degraded: false, degradationReason: "tool_result_budget", deliveryStatus: "truncated" });
    const lastLine = packed.meta!.deliveredLineRange![1];
    expect(packed.meta?.omittedCount).toBe(620 - lastLine);
    expect(packed.text).toContain(`continue with startLine=${lastLine + 1}, endLine=620`);
    expect(packTextToolResult(canonical, 1).meta).toMatchObject({
      degradationReason: "tool_result_budget", deliveryStatus: "budget_rejected", omittedCount: 620
    });
    expect(canonical.meta?.degradationReason).toBe("source_line_limit");
  });

  it("only retains the terminal separator on the last page", async () => {
    const args = { path: "terminated.custom", startLine: 1, endLine: 100 };
    const canonical = await fixture.call("read_range", args);
    const cut = packTextToolResult(canonical, 500);
    const last = cut.meta!.deliveredLineRange![1];
    expect(last).toBeLessThan(42);
    const rest = await fixture.call("read_range", { ...args, startLine: last + 1 });
    const body = (text: string) => text.split("\n\n[tool meta:")[0]!.slice(text.indexOf("\n") + 1);
    expect(body(cut.text) + "\n" + body(rest.text)).toBe(body(canonical.text));
    expect(body(rest.text).endsWith("\r\n")).toBe(true);
  });

  it.each(["../outside", "/etc/passwd", ".git/config"])("rejects unsafe paths instead of empty reads: %s", async path => {
    expect(await fixture.call("read_range", { path, startLine: 1, endLine: 2 })).toMatchObject({ isError: true, errorCode: "path_outside_repo" });
  });

  it("keeps tool descriptions explicit about required bounds and unavailable syntax", () => {
    const description = (name: string) => fixture.definitions.find(tool => tool.name === name)!.description;
    expect(description("read_range")).toContain("Both startLine and endLine are required");
    expect(description("read_range")).toContain("A start beyond EOF returns no source and gives the file length");
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

const exactSource = {
  backend: "text",
  precision: "exact",
  degraded: false,
  requestedSource: "head",
  sourceUsed: "head",
  lookupStatus: "found",
  deliveryStatus: "full"
} satisfies ToolResultMeta;

describe("search delivery accounting over committed source", () => {
  let fixture: Awaited<ReturnType<typeof textRepository>>;
  beforeAll(async () => {
    // Representative codegenie cg-04 and goinfer go-01 lines and Git paths.
    fixture = await textRepository({
      "src/pipeline/composition-repair.ts": [
        "// " + "context ".repeat(100), "if (proofVisibilityDiagnostics.length > 0) {",
        "  return buildCompositionRepair(proofVisibilityDiagnostics);", "}", "// " + "context ".repeat(100)
      ].join("\n"),
      "cmd/serve/admin.go": [
        "s.regMu.Lock()", "if _, dup := s.models[lm.name]; dup { // raced another load of the same name",
        "\ts.regMu.Unlock()", "\treturn", "}"
      ].join("\n"),
      "src/oversized.ts": ["// needle " + "x".repeat(33_000), "const needle = true;"].join("\n"),
      "src/excerpt.ts": "// " + "x".repeat(600) + " needle"
    });
  });
  afterAll(() => fixture?.dispose());

  it("distinguishes an incomplete scan from exact line skips and true zero matches", async () => {
    const search = (query: string, args = {}) => fixture.call("search_files", { query, ...args });
    const incomplete = packSearchToolResult(await search("regMu", { maxResults: 1 }), 4000);
    expect(incomplete.meta).toMatchObject({
      degraded: false, deliveryStatus: "truncated", degradationReason: "search_discovery_limit", omittedCount: 1,
      omittedCountIsLowerBound: true, searchDelivery: { deliveredCount: 1, scanIncomplete: true, discoveryOmittedCount: 1 }
    });
    expect(JSON.parse(incomplete.text).notice).toContain('Omitted at least 1 matching lines. Scan limited. Next read_range: "cmd/serve/admin.go"@head:3.');
    const exact = packSearchToolResult(await search("needle", { pathGlob: "src/oversized.ts" }), 4000);
    expect(exact.meta).toMatchObject({
      degradationReason: "search_result_limit", omittedCount: 1, omittedCountIsLowerBound: false,
      searchDelivery: { deliveredCount: 1, scanIncomplete: false, discoveryOmittedCount: 0, backendOmittedCount: 1 }
    });
    expect(exact.meta?.discoveryLimited).not.toBe(true);
    expect(JSON.parse(exact.text).results).toMatchObject([{ line: 2 }]);
    expect(JSON.parse(exact.text).notice).toContain('Omitted 1 matching lines. Next read_range: "src/oversized.ts"@head:1.');
    const mixed = packSearchToolResult(await search("needle", { pathGlob: "src/{excerpt,oversized}.ts", maxResults: 1 }), 4000);
    expect(mixed.meta).toMatchObject({
      degradationReason: "search_discovery_limit", discoveryLimited: true, omittedCount: 2, omittedCountIsLowerBound: true,
      searchDelivery: { deliveredCount: 1, scanIncomplete: true, discoveryOmittedCount: 1, backendOmittedCount: 1 }
    });
    const excerpt = packSearchToolResult(await search("needle", { pathGlob: "src/excerpt.ts" }), 4000);
    expect(excerpt.meta).toMatchObject({ deliveryStatus: "truncated", omittedCount: 0, searchDelivery: { shortenedExcerpts: 1 } });
    expect(JSON.parse(excerpt.text).notice).toContain('Next read_range: "src/excerpt.ts"@head:1.');
    const empty = packSearchToolResult(await search("missingNeedle"), 4000);
    expect(empty.meta).toMatchObject({ deliveryStatus: "empty", searchDelivery: { deliveredCount: 0, scanIncomplete: false } });
    expect(JSON.parse(empty.text).results).toEqual([]);
  });

  it("repackages cached results per allowance and counts context or rows separately", async () => {
    const args = { query: "proofVisibilityDiagnostics|regMu", contextMode: "lines" };
    const cache = createToolResultCache();
    const request = { toolName: "search_files", args, run: () => fixture.call("search_files", args) };
    const first = await cache.execute(request);
    const hit = await cache.execute(request);
    expect(hit.status).toBe("hit");
    const full = packSearchToolResult(first.result, 4000);
    expect(full.meta).toMatchObject({ deliveryStatus: "full", searchDelivery: { deliveredCount: 4, budgetContextStripped: false } });
    expect(full.text).not.toContain("searchDelivery");
    const rows = packSearchToolResult(hit.result, 760);
    expect(rows.meta).toMatchObject({
      degraded: false, deliveryStatus: "truncated", degradationReason: "tool_result_budget", omittedCountIsLowerBound: false,
      searchDelivery: { budgetContextStripped: true, scanIncomplete: false }
    });
    expect(rows.meta?.searchDelivery?.deliveredCount).toBe(JSON.parse(rows.text).results.length);
    expect(rows.meta?.searchDelivery?.budgetOmittedCount).toBe(4 - JSON.parse(rows.text).results.length);
    const refused = packSearchToolResult(hit.result, 128);
    expect(refused).toMatchObject({ isError: true, errorCode: "budget_exhausted",
      meta: { deliveryStatus: "budget_rejected", searchDelivery: { deliveredCount: 0, budgetOmittedCount: 4 } } });
    expect(refused.text).toContain('Next read_range: "cmd/serve/admin.go"@head:1.');
    expect(packSearchToolResult((await cache.execute(request)).result, 4000)).toEqual(full);
  });
});

describe("whole-record tool packing", () => {
  it("preserves a full Go source range and reports where a cut range ends", () => {
    // goinfer go-01, cmd/serve/admin.go:76-87.
    const records = [
      "\ts.regMu.Lock()",
      "\tif _, dup := s.models[lm.name]; dup { // raced another load of the same name",
      "\t\ts.regMu.Unlock()",
      '\t\twriteErr(w, http.StatusConflict, fmt.Sprintf("model %q already loaded", lm.name))',
      "\t\treturn",
      "\t}",
      "\ts.models[lm.name] = lm",
      "\ts.regMu.Unlock()",
      '\tif s.cfg.sessionDir != "" && s.cfg.kvSessions > 0 {',
      "\t\tlm.sessions.load(sessionSubdir(s.cfg.sessionDir, lm.fp))",
      "\t}",
      '\twriteJSON(w, http.StatusOK, map[string]any{"id": lm.name, "object": "model", "status": "loaded"})'
    ];
    const result = createPackableToolResult({ open: "", records, separator: "\n", close: "" },
      { ...exactSource, totalLines: 120, deliveredLineRange: [76, 87] });
    result.sourceLineRange = [76, 87];
    expect(result.text).toBe(records.join("\n") + "\n\n[tool meta: source: requested head, used head; lookup: found; delivery: full]");
    expect(packTextToolResult(result, result.text.length)).toBe(result);

    const expected = records.slice(0, 2).join("\n") +
      "\n\n[tool meta: source: requested head, used head; lookup: found; delivery: truncated; truncated: 10 omitted; truncation: tool_result_budget; delivered lines 76-77 of 120; continue with startLine=78]";
    const cut = packTextToolResult(result, expected.length);
    expect(cut.text).toBe(expected);
    expect(cut.sourceLineRange).toEqual([76, 77]);
    expect(cut.meta).toMatchObject({ deliveredLineRange: [76, 77], degraded: false, degradationReason: "tool_result_budget" });
    expect(result.sourceLineRange).toEqual([76, 87]);
  });

  it("keeps serialized likely-test records intact and combines backend and delivery omissions", () => {
    // Pi pi-07, representative symbols from the settings-manager test lookup.
    const tests = [
      { path: "packages/coding-agent/test/settings-manager.test.ts", name: "SettingsManager", kind: "test", lineRange: [8, 601] },
      { path: "packages/coding-agent/test/settings-manager.test.ts", name: "preserves externally added settings", kind: "test", lineRange: [28, 112] }
    ];
    const records = tests.map(test => JSON.stringify(test, null, 2).split("\n").map(line => "  " + line).join("\n"));
    const meta = { backend: "tree-sitter", precision: "heuristic", degraded: false, truncated: true, omittedCount: 39, omittedCountIsLowerBound: true } satisfies ToolResultMeta;
    const result = createPackableToolResult({ open: "[\n", records, separator: ",\n", close: "\n]" }, meta);
    const original = JSON.stringify(tests, null, 2) + "\n\n[tool meta: truncated: at least 39 omitted]";
    expect(packTextToolResult(result, original.length).text).toBe(original);

    const cut = packTextToolResult(result, 355);
    const [body, footer] = cut.text.split("\n\n[tool meta: ");
    expect(JSON.parse(body!)).toEqual(tests.slice(0, 1));
    expect(footer).toContain("truncated: at least 40 omitted");
    expect(cut.meta).toMatchObject({ omittedCount: 40, omittedCountIsLowerBound: true });
    expect(cut.text.length).toBeLessThanOrEqual(355);
  });

  it("keeps complete diff blocks and refuses when the first block cannot fit", () => {
    // Codegenie cg-12, the test literal that exercises generated-file detection.
    const first = 'tests/file-classifier.test.ts @@ -18,2 +18,2 @@\n  writeRepoFile(repo, "src/marker.go", "// Code generated by tool. DO NOT EDIT.\\npackage src\\n");';
    const next = "src/git/git-client.ts @@ -100,3 +100,3 @@\n" + "new\tline\n".repeat(25);
    const labels = ["test hunk, line 20", "Git client hunk, line 100"];
    const result = createPackableToolResult({ open: "", records: [first, next], separator: "\n\n", close: "", labels }, exactSource);
    const packed = packTextToolResult(result, 365);
    expect(packed.text.split("\n\n[tool meta:")[0]).toBe(first);
    expect(packed.text).toContain("last delivered: test hunk, line 20; next: Git client hunk, line 100");
    expect(packed.packable?.labels).toEqual(labels.slice(0, 1));
    expect(result.packable?.labels).toEqual(labels);
    expect(result.text).not.toContain("last delivered:");
    expect(packed.meta).toMatchObject({ deliveryStatus: "truncated", omittedCount: 1 });
    const refused = packTextToolResult(result, first.length);
    expect(refused).toMatchObject({ isError: true, errorCode: "budget_exhausted",
      meta: { deliveryStatus: "budget_rejected", truncated: true, omittedCount: 2 } });
    expect(refused.text).toContain("Narrow the request");
  });

  it("refuses a declaration header when its first source line cannot fit", () => {
    const records = ["file.ts@head declaration lines 1-2 of 2", "1\t" + "x".repeat(500), "2\t" + "y".repeat(500)];
    const meta = { backend: "text", precision: "exact", degraded: false } satisfies ToolResultMeta;
    const result = createPackableToolResult({ open: "", records, separator: "\n", close: "",
      keepWithNext: [true, false, false] }, meta);
    expect(packTextToolResult(result, 127)).toMatchObject({
      isError: true, errorCode: "budget_exhausted", meta: { deliveryStatus: "budget_rejected" }
    });

    const labeled = createPackableToolResult({ ...result.packable!, labels: ["file.ts@head:1", "file.ts@head:1", "file.ts@head:2"] }, meta);
    const refused = packTextToolResult(labeled, 127);
    expect(refused.text).toContain("First unread source: file.ts@head:1.");
    expect(refused.text).not.toContain(records[0]);
  });

  it("cuts before a later block rather than returning its header alone", () => {
    const records = ["a.ts@head declaration lines 5-5 of 5", "5\tconst first = 1;",
      "b.ts@base declaration lines 10-10 of 10", "10\t" + "x".repeat(500)];
    const result = createPackableToolResult({ open: "", records, separator: "\n", close: "",
      labels: ["a.ts@head:5", "a.ts@head:5", "b.ts@base:10", "b.ts@base:10"],
      keepWithNext: [true, false, true, false] }, exactSource);
    expect(packTextToolResult(result, result.text.length)).toBe(result);
    const cut = packTextToolResult(result, 320);
    expect(cut.packable?.records).toEqual(records.slice(0, 2));
    expect(cut.text).toContain("last delivered: a.ts@head:5; next: b.ts@base:10");
    expect(cut.text).not.toContain(records[2]);
  });

  it("repacks canonical symbol results from the cache without losing a complete later delivery", async () => {
    // Codegenie cg-09, classifyVerifierSchemaInvalid in src/pipeline/verifier.ts.
    const records = ["    argumentsValue.verdict === \"revise\" &&",
      '    (!("findingUpdates" in argumentsValue) || argumentsValue.findingUpdates == null) &&',
      '    (!("revisedAnchor" in argumentsValue) || argumentsValue.revisedAnchor == null);'];
    const result = createPackableToolResult({ open: "", records, separator: "\n", close: "" },
      { backend: "text", precision: "text", degraded: true, degradationReason: "syntax fallback" });
    const cache = createToolResultCache();
    const input = { toolName: "read_symbol", args: { path: "src/pipeline/verifier.ts", symbolName: "classifyVerifierSchemaInvalid" }, run: async () => result };
    const first = await cache.execute(input);
    const small = packTextToolResult(first.result, 186);
    expect(small.text).toContain(records[0]);
    expect(small.text).not.toContain(records[1]);
    expect(small.meta).toMatchObject({ degraded: true, degradationReason: "syntax fallback", deliveryStatus: "truncated" });
    const hit = await cache.execute(input);
    expect(hit.status).toBe("hit");
    expect(packTextToolResult(hit.result, result.text.length)).toEqual(result);
  });
});
