import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packFileListToolResult, packOutlineToolResult, packSearchToolResult } from "../../src/llm/search-result-packing.js";
import { textRepository } from "../../tests/helpers/text-repository.js";
import { writeRepoFile } from "../../tests/helpers/git.js";

// Exercise discovery -> exact source -> revision comparison using the same
// schemas, tool wrappers, resolver and Git backend supplied to review models.
// The investigation choices are scripted; no model or network is involved.
describe("synthetic: investigating formats without a syntax adapter", () => {
  let fixture: Awaited<ReturnType<typeof textRepository>>;
  const small = "import ./types.custom\nrecord AccessRule {\n  permission = read\n}\n";
  const long = Array.from({ length: 620 }, (_, i) => i === 570 ? "AccessRule permission = write" : `# filler ${i + 1}`).join("\n");
  beforeAll(async () => {
    fixture = await textRepository({
      "schema/access.ridl": small, "schema/medium.custom": "# context\n".repeat(200), "config/access.policy": small, "schemas with spaces/access.custom": small,
      "schema/.hidden.custom": "AccessRule hidden", "schema/long.custom": long,
      "schema/version.custom": "AccessRule permission = read\n", "config/other.policy": "AccessRules OTHER\n",
      "schema/query.custom": "one\nAccessRule 42\naccessrule 7\n// AccessRule comment\ntext = AccessRule\n--option\nend",
      ...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`many/${i}.custom`, "AccessRule\n"]))
    }, { "schema/version.custom": "AccessRule permission = write\n" });
    writeRepoFile(fixture.repo, "schema/version.custom", "DirtyOnly");
    writeRepoFile(fixture.repo, "schema/untracked.custom", "UntrackedOnly");
  });
  afterAll(() => fixture?.dispose());

  it.each(["list_files", "find_definition"])("recovers a guessed filename through %s before reading exact source", async discoveryTool => {
    const missing = await fixture.call("read_range", { path: "schema/AccessRule.ridl", startLine: 1, endLine: 4 });
    expect(missing.meta).toMatchObject({ lookupStatus: "file_missing", deliveryStatus: "empty" });
    expect(missing.text).toContain(discoveryTool);
    expect(missing.text).not.toContain("permission = read");
    let path: string;
    if (discoveryTool === "list_files") {
      const listed = await fixture.call("list_files", { glob: "schema/*.ridl" });
      expect(listed.filePaths).toEqual(["schema/access.ridl"]);
      path = listed.filePaths![0]!;
    } else {
      const definition = await fixture.call("find_definition", { symbolName: "AccessRule", pathGlob: "schema/*.ridl", source: { kind: "head" } });
      expect(definition.definitions).toHaveLength(1);
      path = definition.definitions![0]!.symbol.path;
    }
    const read = await fixture.call("read_range", { path, startLine: 2, endLine: 4 });
    expect(read.meta).toMatchObject({ lookupStatus: "found", deliveryStatus: "full", sourceUsed: "head" });
    expect(read.text).toContain("record AccessRule {\n  permission = read\n}");
    expect(read.sourceLineRange).toEqual([2, 4]);
  });

  it.each(["schema/access.ridl", "config/access.policy", "schemas with spaces/access.custom"])(
    "small %s exposes complete source without claiming symbol extraction", async path => {
      const result = await fixture.call("read_file_outline", { path });
      expect(result.isError).not.toBe(true);
      expect(result.meta).toMatchObject({ backend: "text", degraded: false, deliveryStatus: "full" });
      expect(result.text).toContain('"symbolExtraction": "unavailable"');
      expect(result.text).toContain('"sourceText"');
      // Wrapper appends metadata after the JSON payload.
      expect(result.text).toContain(JSON.stringify(small));
      expect((await fixture.call("read_range", { path, startLine: 2, endLine: 4 })).text).toContain("record AccessRule {\n  permission = read\n}");
    });

  it("delivers a valid bounded outline with a source-read hint instead of cutting JSON/source in half", async () => {
    const canonical = await fixture.call("read_file_outline", { path: "schema/long.custom" });
    const input = await fixture.call("read_file_outline", { path: "schema/medium.custom", source: { kind: "base" } });
    const sourceText = structuredClone(input.outline!.sourceText);
    expect(sourceText?.text).toHaveLength(2000);
    const packed = packOutlineToolResult(input, 900);
    const payload = JSON.parse(packed.text);
    expect(payload.outline.sourceText).toBeUndefined();
    expect(payload.outline.sourceReadHint).toMatchObject({ tool: "read_range", startLine: 1, endLine: 80 });
    expect(packed.meta).toMatchObject({ truncated: true, deliveryStatus: "truncated" });
    expect(packed.text.length).toBeLessThanOrEqual(900);
    expect(input.outline!.sourceText).toEqual(sourceText);
    expect(packed.meta?.sourceUsed).toBe("base");
    expect(packOutlineToolResult(canonical, 1)).toMatchObject({ isError: true, errorCode: "budget_exhausted" });
    const recovery = await fixture.call("read_range", { path: "schema/access.ridl", startLine: 2, endLine: 4 });
    expect(recovery.text).toContain("permission = read");
  });

  it("locates a late section in a large unsupported file and reads that window, not the whole file", async () => {
    const outline = await fixture.call("read_file_outline", { path: "schema/long.custom" });
    expect(outline.meta?.degraded).toBe(false);
    expect(outline.text).toContain('"sourceReadHint"');
    expect(outline.text).not.toContain('"sourceText"');
    const discovery = await fixture.call("search_files", { query: "AccessRule", pathGlob: "schema/long.custom", contextMode: "lines" });
    expect(discovery.meta?.degraded).toBe(false);
    expect(discovery.searchResults).toMatchObject([{ path: "schema/long.custom", line: 571, column: 1 }]);
    const hit = discovery.searchResults![0]!;
    const read = await fixture.call("read_range", { path: hit.path, startLine: hit.line - 1, endLine: hit.line + 1 });
    expect(read.meta?.deliveryStatus).toBe("full");
    expect(read.text).toContain("# filler 570\nAccessRule permission = write\n# filler 572");
    expect(read.text).not.toContain("# filler 1\n");
    expect(read.text.length).toBeLessThan(300);
  });

  it.each(["head", "base"] as const)("search and range agree on the %s revision, excluding working-tree changes", async kind => {
    const expected = kind === "head" ? "write" : "read";
    const search = await fixture.call("search_files", { query: "AccessRule", pathGlob: "schema/version.custom", source: { kind } });
    expect(search.searchResults).toMatchObject([{ line: 1, matchText: `AccessRule permission = ${expected}` }]);
    const read = await fixture.call("read_range", { path: "schema/version.custom", startLine: 1, endLine: 1, source: { kind } });
    expect(read.text).toContain(`AccessRule permission = ${expected}`);
    expect(read.text).not.toContain("DirtyOnly");
    expect((await fixture.call("search_files", { query: "DirtyOnly|UntrackedOnly", source: { kind } })).searchResults).toEqual([]);
  });

  it.each([
    { query: "^AccessRule [0-9]+$", lines: [2] },
    { query: "^AccessRule[[:space:]]42$", lines: [2] },
    { query: "^one$|^end$", lines: [1, 7] },
    { query: "--option", lines: [6] },
    { query: "accessrule", lines: [3] },
    { query: "accessrule", lines: [2, 3, 4, 5], caseSensitive: false },
    { query: "absent", lines: [] }
  ])("honors the advertised grep dialect: $query", async ({ query, lines, ...options }) => {
    const result = await fixture.call("search_files", { query, pathGlob: "schema/query.custom", ...options });
    expect(result.isError).not.toBe(true);
    expect(result.searchResults?.map(hit => hit.line)).toEqual(lines);
    expect(result.meta?.degraded).toBe(false);
  });

  it.each(["[", "(?=AccessRule)", "\\d+"])("invalid query %s is actionable even in a nonexistent scope", async query => {
    const result = await fixture.call("search_files", { query, pathGlob: "absent/**" });
    expect(result).toMatchObject({ isError: true, errorCode: "invalid_args" });
    expect(result.text).toContain("query");
    expect(result.searchResults).toBeUndefined();
    const corrected = await fixture.call("search_files", { query: "AccessRule", pathGlob: "schema/query.custom" });
    expect(corrected.searchResults).toHaveLength(3);
  });

  it("uses one glob dialect for list and search, including braces, spaces and dotfiles", async () => {
    for (const glob of ["{schema,config}/**", "**/*.custom", "schemas with spaces/*.custom", "schema/?.custom", "schema/*[.]ridl"]) {
      const listed = await fixture.call("list_files", { glob });
      expect(listed.isError).not.toBe(true);
      const searched = await fixture.call("search_files", { query: "AccessRule", pathGlob: glob });
      expect(searched.isError).not.toBe(true);
      expect(searched.searchResults?.every(hit => listed.filePaths!.includes(hit.path))).toBe(true);
    }
    const list = await fixture.call("list_files", { glob: "schema/*.custom" });
    expect(list.filePaths).toContain("schema/.hidden.custom");
    expect(list.filePaths).not.toContain("schema/untracked.custom");
    expect((await fixture.call("list_files", { glob: "{schema,config}/**" })).filePaths).toContain("config/access.policy");
    for (const [name, args] of [["list_files", { glob: "schema/{bad" }], ["search_files", { query: "AccessRule", pathGlob: "schema/{bad" }]] as const) {
      expect(await fixture.call(name, args)).toMatchObject({ isError: true, errorCode: "invalid_args" });
    }
  });

  it("labels text-only definition and symbol lookups as text, then follows the location to exact source", async () => {
    const definition = await fixture.call("find_definition", { symbolName: "AccessRule", pathGlob: "schema/access.ridl" });
    expect(definition.meta).toMatchObject({ backend: "text", precision: "text", degraded: false, sourceUsed: "head" });
    expect(definition.text).toContain('"nativeKind": "text match"');
    const symbol = await fixture.call("read_symbol", { path: "schema/access.ridl", symbolName: "AccessRule" });
    expect(symbol.meta).toMatchObject({ backend: "text", precision: "text", degraded: false });
    expect(symbol.text).toContain("permission = read");
    const exact = await fixture.call("read_range", { path: "schema/access.ridl", startLine: 2, endLine: 4 });
    expect(exact.meta?.precision).toBe("exact");
    expect(exact.text).toContain("record AccessRule {\n  permission = read\n}");
    expect(await fixture.call("read_symbol", { path: "schema/access.ridl", symbolName: "AccessRule", line: 2 }))
      .toMatchObject({ isError: true, errorCode: "invalid_args" });
    expect((await fixture.call("find_definition", { symbolName: "AbsentIdentifier", pathGlob: "schema/access.ridl" })).meta?.lookupStatus).toBe("not_found");
  });

  it.each(["none", "lines", "symbols"])("text-only mention discovery remains honest with contextMode=%s", async contextMode => {
    const result = await fixture.call("find_symbol_mentions", { symbolName: "AccessRule", pathGlob: "{schema/query.custom,config/other.policy}", contextMode });
    expect(result.meta).toMatchObject({ backend: "text", precision: "text", degraded: false });
    // Text mode includes comments/strings, excludes AccessRules and the lowercase spelling.
    expect(result.searchResults?.map(hit => hit.line)).toEqual([2, 4, 5]);
    expect(result.searchResults?.every(hit => !hit.enclosingSymbol)).toBe(true);
    if (contextMode === "lines") expect(result.searchResults![0]!.contextBefore).toEqual(["one"]);
  });

  it("bounds broad discovery without losing the route to exact source or poisoning larger deliveries", async () => {
    const canonical = await fixture.call("search_files", { query: "AccessRule", pathGlob: "many/**" });
    expect(canonical.searchResults).toHaveLength(50);
    const small = packSearchToolResult(canonical, 900);
    const payload = JSON.parse(small.text);
    expect(payload.results.length).toBeGreaterThan(0);
    expect(payload.results.length).toBeLessThan(50);
    expect(payload.meta.truncated).toBe(true);
    expect(payload.notice).toContain("not exhaustive");
    expect(small.text.length).toBeLessThanOrEqual(900);
    const hit = payload.results[0];
    expect((await fixture.call("read_range", { path: hit.path, startLine: hit.line, endLine: hit.line })).text).toContain("AccessRule");
    expect(JSON.parse(packSearchToolResult(canonical, 16000).text).results).toHaveLength(50);
    const listing = await fixture.call("list_files", { glob: "many/**" });
    const packed = packFileListToolResult(listing, 600);
    expect(JSON.parse(packed.text).meta.truncated).toBe(true);
    expect(JSON.parse(packed.text).paths.every((path: string) => listing.filePaths!.includes(path))).toBe(true);
    expect(packSearchToolResult(canonical, 1)).toMatchObject({ isError: true, errorCode: "budget_exhausted" });
    expect((await fixture.call("search_files", { query: "absent", pathGlob: "many/**" })).searchResults).toEqual([]);
  });

  it("preserves individually located text candidates when a definition lookup is ambiguous", async () => {
    const result = await fixture.call("find_definition", { symbolName: "AccessRule", pathGlob: "schema/**" });
    expect(result.isError).not.toBe(true);
    expect(result.meta).toMatchObject({ lookupStatus: "ambiguous", sourceUsed: "head", degraded: false });
    expect(result.definitions!.length).toBeGreaterThan(1);
    for (const hit of result.definitions!) {
      expect(hit.symbol.path).toMatch(/^schema\//);
      expect(hit.symbol.lineRange[0]).toBeGreaterThan(0);
      expect(hit.text).toContain("AccessRule");
      expect(result.text).toContain(hit.symbol.path);
    }
  });

});
