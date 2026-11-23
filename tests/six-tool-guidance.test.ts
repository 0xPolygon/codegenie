import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDiff } from "../src/git/diff-parser.js";
import { packDefinitionToolResult } from "../src/llm/definition-result-packing.js";
import { packTextToolResult } from "../src/llm/search-result-packing.js";
import { assertRepositoryToolArguments, buildRepositoryToolDefinitions } from "../src/llm/tool-definitions.js";
import { packUsageToolResult } from "../src/llm/usage-result-packing.js";
import { LanguageAdapterRegistry } from "../src/repo/language-adapter.js";
import { RepositoryToolsFacade } from "../src/repo/repository-index.js";
import { SourceResolver } from "../src/repo/source-resolver.js";
import { TreeSitterService } from "../src/repo/tree-sitter/tree-sitter-service.js";
import { git, nullTelemetry } from "./helpers/git.js";
import { validateToolCall } from "./helpers/pi-validation.js";
import { textRepository } from "./helpers/text-repository.js";

const RETIRED_TOOL = /\b(?:find_definition|find_symbol_mentions|read_symbol|read_diff_blocks|read_file_outline|find_likely_tests)\b/u;

describe("six-tool result guidance", () => {
  let fixture: Awaited<ReturnType<typeof textRepository>>;
  let definitions: ReturnType<typeof buildRepositoryToolDefinitions>;
  beforeAll(async () => {
    const path = "src/policy.ts";
    const lines = ["export function choose() {", ...Array.from({ length: 30 }, (_, i) => `  track(${i});`), "}"];
    const original = lines.join("\n") + "\n";
    lines[10] = "  track(100);";
    fixture = await textRepository({
      [path]: original,
      "src/config.ts": "export function choose() { return 2; }\n",
      "docs/notes.txt": "Call track when routing changes.\n",
      ...Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`src/policies/candidate-${i}.ts`, "export {};\n"]))
    }, { [path]: lines.join("\n") + "\n" });
    const repoRoot = fixture.repo;
    const base = git(repoRoot, ["rev-parse", "HEAD^"]).trim();
    const head = git(repoRoot, ["rev-parse", "HEAD"]).trim();
    const rawDiff = git(repoRoot, ["diff", base, head]);
    const resolver = await SourceResolver.create({ mode: "commit_range", repoRoot, startCommit: base,
      endCommit: head, mergeBase: base, headSha: head, commits: [], rawDiff });
    const tools = new RepositoryToolsFacade({ diff: parseDiff(rawDiff), resolver,
      registry: new LanguageAdapterRegistry(new TreeSitterService()), telemetry: nullTelemetry() });
    definitions = buildRepositoryToolDefinitions(tools, { toolSurface: "six" });
  });
  afterAll(() => fixture?.dispose());

  async function run(name: string, args: Record<string, unknown>) {
    const tool = definitions.find(candidate => candidate.name === name)!;
    assertRepositoryToolArguments(tool, args);
    const validated = validateToolCall(definitions, { type: "toolCall", id: "test", name, arguments: args });
    return tool.execute(validated, new AbortController().signal);
  }

  it("describes active tools when source is missing, unparsed, ambiguous, or cut", async () => {
    const missing = await run("read_range", { path: "src/missing.ts", startLine: 1, endLine: 3, source: { kind: "base" } });
    expect(missing.meta?.lookupStatus).toBe("file_missing");
    expect(missing.text).toContain("read_definition with name and source and without path");
    const missingDefinition = await run("read_definition", { name: "choose", path: "src/missing.ts", source: { kind: "base" } });
    expect(missingDefinition.meta?.lookupStatus).toBe("file_missing");
    expect(missingDefinition.text).toContain("read_definition with name and source and without path");

    const textLead = await run("find_usages", { name: "track", pathGlob: "docs/**" });
    expect(textLead.text).toContain("text-only mention");

    const ambiguous = await run("read_definition", { name: "choose" });
    expect(ambiguous.meta?.lookupStatus).toBe("ambiguous");
    expect(ambiguous.text).toContain("Verified declarations:");

    const args = { query: "track", mode: "literal", pathGlob: "src/**", source: { kind: "base" } };
    const search = await run("search_files", args);
    const cut = packTextToolResult(search, 650);
    expect(cut.meta?.deliveryStatus).toBe("truncated");
    const cursor = /cursor=([\w-]+)/u.exec(cut.text)![1]!;
    const next = await run("search_files", { ...args, cursor });
    const firstUnread = search.packable?.records[cut.packable!.records.length];
    expect(firstUnread).toBeDefined();
    expect(next.packable?.records[0]).toContain('"src/policy.ts"@base: 32 lines');
    expect(next.packable?.records[0]?.split("\n").at(-1)).toBe(firstUnread);

    for (const { text } of [missing, missingDefinition, textLead, ambiguous, cut, next]) expect(text).not.toMatch(RETIRED_TOOL);
  });

  it.each([
    { name: "read_change", args: { path: "src/policy.ts" }, pack: packTextToolResult },
    { name: "read_range", args: { path: "src/policy.ts", startLine: 1, endLine: 30 }, pack: packTextToolResult },
    { name: "read_definition", args: { name: "choose" }, pack: packDefinitionToolResult },
    { name: "find_usages", args: { name: "track" }, pack: packUsageToolResult },
    { name: "search_files", args: { query: "track" }, pack: packTextToolResult },
    { name: "list_files", args: { glob: "src/**" }, pack: packTextToolResult }
  ])("preserves a complete typed $name refusal without retired tool names", async ({ name, args, pack }) => {
    const result = pack(await run(name, args), 9);
    expect(result).toMatchObject({ isError: true, errorCode: "budget_exhausted", meta: { deliveryStatus: "budget_rejected" } });
    expect(result.text).not.toMatch(RETIRED_TOOL);
    expect(result.text.length).toBeGreaterThan(9);
  });
});
