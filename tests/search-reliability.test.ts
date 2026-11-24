import { buildRepositoryToolDefinitions } from "../src/llm/tool-definitions.js";
import { RepositoryToolsFacade } from "../src/repo/repository-index.js";
import { nullTelemetry } from "./helpers/git.js";
import { describe, it, expect, vi } from "vitest";
import { SourceResolver } from "../src/repo/source-resolver.js";
import { SearchService } from "../src/repo/search.js";
import { LanguageAdapterRegistry } from "../src/repo/language-adapter.js";
import { TreeSitterService } from "../src/repo/tree-sitter/tree-sitter-service.js";
import { createGitClient } from "../src/git/git-client.js";
import { packSearchToolResult } from "../src/llm/search-result-packing.js";
import { createToolResultCache } from "../src/llm/tool-result-cache.js";
import { commitAll, git, initRepo, writeRepoFile } from "./helpers/git.js";

async function fixture() {
  const repo = initRepo();
  writeRepoFile(repo, "src/data/a.txt", "Statuses\n");
  writeRepoFile(repo, "src/domain/b.txt", "func List\n");
  writeRepoFile(repo, "src/data/[x].txt", "literal\n");
  writeRepoFile(repo, "src/data/x.txt", "other\n");
  const base = commitAll(repo, "base");
  writeRepoFile(repo, "src/data/a.txt", "Statuses changed\n");
  const head = commitAll(repo, "head");
  const git = createGitClient(repo);
  const resolver = await SourceResolver.create({ mode: "commit_range", repoRoot: repo, startCommit: base, endCommit: head, mergeBase: base, headSha: head, commits: [], rawDiff: "" }, git);
  return { resolver, repo, git, service: new SearchService(resolver, new LanguageAdapterRegistry(new TreeSitterService())) };
}

describe("reliable search", () => {
  it("retains useful matches on both sides of oversized lines with explicit omissions", async () => {
    const { resolver, repo, service } = await fixture();
    writeRepoFile(repo, "big.txt", `needle before\nneedle ${"x".repeat(320_000)}\nneedle after\n`);
    resolver.binding.headCommit = commitAll(repo, "oversized matching line");
    const result = await service.search("needle", { pathGlob: "big.txt" });
    expect(result.results.map(match => match.line)).toEqual([1, 3]);
    expect(result).toMatchObject({ truncated: true, degraded: true, omittedCount: 1, discoveryLimited: false });
    const packed = packSearchToolResult({ text: "", searchResults: result.results, meta: result }, 2000);
    expect(JSON.parse(packed.text).results).toHaveLength(2);
    expect(JSON.parse(packed.text).notice).toContain('Omitted 1 matching lines. Next read_range: "big.txt"@head:2.');
    await expect(service.search("x+", { pathGlob: "big.txt" })).rejects.toMatchObject({
      code: "budget_exhausted",
      meta: { deliveryStatus: "budget_rejected", degradationReason: "search_result_limit", omittedCount: 1, omittedCountIsLowerBound: false,
        searchDelivery: { deliveredCount: 0, scanIncomplete: false, discoveryOmittedCount: 0, backendOmittedCount: 1,
          nextRead: { path: "big.txt", line: 2 } } }
    });
    const recordToolCall = vi.fn(() => "tc-budget");
    const tools = new RepositoryToolsFacade({ resolver, diff: { files: [] }, registry: new LanguageAdapterRegistry(new TreeSitterService()),
      telemetry: { ...nullTelemetry(), recordToolCall } });
    await expect(tools.searchFiles("x+", { pathGlob: "big.txt" })).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "search_files", status: "rejected", errorCode: "budget_exhausted",
      deliveryStatus: "budget_rejected" }));
    expect((await service.search("absent", { pathGlob: "big.txt" })).results).toEqual([]);
  });

  it("shares brace glob scope and POSIX alternation, preserving revisions and literal paths", async () => {
    const { resolver } = await fixture();
    const glob = "src/{data,domain}/**";
    expect(await resolver.listFiles(glob)).toHaveLength(4);
    const matches = await resolver.grep("Statuses|func List", { glob });
    expect(matches.map(m => m.path)).toEqual(["src/data/a.txt", "src/domain/b.txt"]);
    expect((await resolver.grep("Statuses", { glob, source: { kind: "base" } }))[0]?.matchText).toBe("Statuses");
    expect((await resolver.grep("literal|other", { glob: "src/data/[[]x[]].txt" })).map(m => m.path)).toEqual(["src/data/[x].txt"]);
    expect(await resolver.grep("absent", { glob })).toEqual([]);
    const emptyScope = await resolver.grep("valid", { glob: "missing/**" });
    expect(emptyScope).toHaveLength(0);
    expect(emptyScope.emptyScope).toBe(true);
  });

  it("lists literal non-ASCII paths from the selected revision with or without a glob", async () => {
    const { resolver, repo } = await fixture();
    git(repo, ["config", "core.quotePath", "true"]);
    const file = "src/café/entrée.txt";
    writeRepoFile(repo, file, "needle\n");
    resolver.binding.headCommit = commitAll(repo, "non-ASCII filename");

    expect(await resolver.listFiles()).toContain(file);
    await expect(resolver.listFiles("src/café/**")).resolves.toEqual([file]);
    await expect(resolver.listFiles("src/café/**", { kind: "base" })).resolves.toEqual([]);
  });

  it("rejects invalid syntax even in empty scopes and preserves backend failure", async () => {
    const { resolver, git, service } = await fixture();
    for (const query of ["[", "(?=x)"]) await expect(resolver.grep(query, { glob: "missing/**" })).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining("query") });
    await expect(resolver.grep("valid", { glob: "src/{data" })).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining("pathGlob") });
    expect(await resolver.grep("(?=x)", { fixedString: true })).toEqual([]);
    vi.spyOn(git, "lsTree").mockRejectedValueOnce(new Error("backend unavailable"));
    await expect(service.search("func (.*Decode", { pathGlob: "**" })).rejects.toMatchObject({
      code: "invalid_args", message: expect.stringContaining("unclosed parenthesis group")
    });
    await expect(resolver.grep("valid", { glob: "**" })).rejects.toThrow("backend unavailable");
  });
  it("delivers invalid inputs as actionable model-facing errors, not empty matches", async () => {
    const { resolver } = await fixture();
    const tools = new RepositoryToolsFacade({ resolver, diff: { files: [] }, registry: new LanguageAdapterRegistry(new TreeSitterService()), telemetry: nullTelemetry() });
    const search = buildRepositoryToolDefinitions(tools).find(tool => tool.name === "search_files")!;
    const bad = await search.execute({ query: "[", pathGlob: "missing/**" }, new AbortController().signal);
    expect(bad).toMatchObject({ isError: true, errorCode: "invalid_args" });
    expect(bad.text).toContain("query is invalid POSIX ERE");
    expect(bad.text).toContain("Check brackets");
    const valid = await search.execute({ query: "absent", pathGlob: "missing/**" }, new AbortController().signal);
    expect(valid.isError).not.toBe(true);
    expect(valid.searchResults).toEqual([]);
    expect(await resolver.grep("\\(\\?", { glob: "missing/**" })).toHaveLength(0);
  });

  it.each(["current", "six"] as const)("pre-checks unclosed ERE groups and supports a corrected retry on %s", async toolSurface => {
    const { resolver, repo } = await fixture();
    writeRepoFile(repo, "decoder.go", "func (r Decoder) Decode() {}\n");
    resolver.binding.headCommit = commitAll(repo, "receiver declaration");
    const tools = new RepositoryToolsFacade({ resolver, diff: { files: [] }, registry: new LanguageAdapterRegistry(new TreeSitterService()), telemetry: nullTelemetry() });
    const search = buildRepositoryToolDefinitions(tools, { toolSurface }).find(tool => tool.name === "search_files")!;
    const grep = vi.spyOn(resolver, "grep");
    const signal = new AbortController().signal;

    const invalid = await search.execute({ query: "func (.*Decode", pathGlob: "*.go" }, signal);
    expect(invalid).toMatchObject({ isError: true, errorCode: "invalid_args" });
    expect(invalid.text).toContain("unclosed parenthesis group");
    expect(invalid.text).toContain("name\\(");
    expect(invalid.text.includes("mode=literal")).toBe(toolSurface === "six");
    expect(grep).not.toHaveBeenCalled();

    for (const query of ["func \\(.*Decode", "func (.*) Decode", "func [(].*Decode", "func [[:punct:]].*Decode", "Decode()"]) {
      const corrected = await search.execute({ query, pathGlob: "*.go" }, signal);
      expect(corrected.searchResults).toEqual([expect.objectContaining({ path: "decoder.go", line: 1 })]);
    }
    if (toolSurface === "six") {
      const literal = await search.execute({ query: "func (", mode: "literal", pathGlob: "*.go" }, signal);
      expect(literal.searchResults).toEqual([expect.objectContaining({ path: "decoder.go", line: 1 })]);
    }
  });

  it("chunks literal scopes with a single global allowance", async () => {
    const { resolver, repo } = await fixture();
    for (let i = 0; i < 270; i++) writeRepoFile(repo, `many/${String(i).padStart(3, "0")}.txt`, "needle\n");
    const head = commitAll(repo, "many");
    resolver.binding.headCommit = head;
    expect(await resolver.grep("needle", { glob: "many/**", maxResults: 260 })).toHaveLength(260);
    expect(await resolver.grep("needle", { glob: "many/**", maxResults: 2 })).toHaveLength(2);
  });
  it("keeps compact matches for large TypeScript declarations without changing canonical symbols", async () => {
    const { resolver, repo, service } = await fixture();
    writeRepoFile(repo, "locale.ts", `export const translations = { greeting: "${"x".repeat(30000)}" };\nconsole.log(translations);\n`);
    resolver.binding.headCommit = commitAll(repo, "large TypeScript declaration");
    const matches = await service.search("translations", { contextMode: "symbols" });
    expect(matches.results).toHaveLength(2);
    expect(matches.results.map(match => match.line)).toEqual([1, 2]);
    expect(JSON.stringify(matches.results).length).toBeLessThan(1500);
    expect((await resolver.readFile("locale.ts"))!.content.length).toBeGreaterThan(30000);
  });

  it("retains locations instead of large enclosing initializers and filters comments first", async () => {
    const { resolver, repo, service } = await fixture();
    writeRepoFile(repo, "many.go", `package p\nvar values = []string{\n${Array.from({length: 60}, () => '"' + "x".repeat(500) + '",').join("\n")}\n}\n// values is discussed here\nfunc use() { println(values) }\n`);
    writeRepoFile(repo, "long.txt", "x".repeat(5000) + "needle at the end\n");
    resolver.binding.headCommit = commitAll(repo, "large symbols");
    const result = await service.findSymbolMentions("values", { contextMode: "symbols" });
    expect(result.results.map(m => m.line)).toEqual([2, 65]);
    expect(JSON.stringify(result.results).length).toBeLessThan(2000);
    expect(result.results.every(m => !("signature" in (m.enclosingSymbol ?? {})))).toBe(true);
    const long = await service.search("needle");
    expect(long.results[0]).toMatchObject({ column: 5001, excerpt: true });
    expect(long.results[0]?.matchText).toContain("needle");
  });
});

describe("per-consumer result packing", () => {
  it("retains later matches when the first path alone exceeds the delivery allowance", () => {
    const results = [{ path: "x".repeat(2000), line: 1, matchText: "needle" }, { path: "a.ts", line: 2, matchText: "needle" }];
    const output = packSearchToolResult({ text: "", searchResults: results, meta: { backend: "text", precision: "text", degraded: false } }, 800);
    expect(JSON.parse(output.text).results).toEqual([results[1]]);
    expect(JSON.parse(output.text).meta.omittedCount).toBe(1);
  });
  it.each([true, false])("does not poison cached results (small first: %s)", async smallFirst => {
    const cache = createToolResultCache();
    const results = Array.from({length: 15}, (_, i) => ({ path: "src/a.ts", line: i + 1, matchText: "needle " + "x".repeat(100), contextAfter: ["y".repeat(500)] }));
    const canonical = { text: JSON.stringify(results), searchResults: results, meta: { backend: "text" as const, precision: "text" as const, degraded: false } };
    const run = vi.fn(async () => canonical);
    const lookup = () => cache.execute({toolName: "search_files", args: {query: "needle"}, run});
    const [first, concurrent] = await Promise.all([lookup(), lookup()]);
    const small = packSearchToolResult(smallFirst ? first.result : concurrent.result, 1200);
    const large = packSearchToolResult(smallFirst ? concurrent.result : first.result, 16000);
    expect(small.text.length).toBeLessThanOrEqual(1200);
    expect(JSON.parse(small.text).results.length).toBeGreaterThan(0);
    expect(JSON.parse(small.text).meta.omittedCount).toBeGreaterThan(0);
    expect(JSON.parse(large.text).results).toHaveLength(15);
    expect((await lookup()).result.searchResults).toEqual(results);
    expect(run).toHaveBeenCalledTimes(1);
    expect(packSearchToolResult(canonical, 10)).toMatchObject({isError: true, errorCode: "budget_exhausted"});
  });
});
