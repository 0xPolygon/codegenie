import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { parseDiff } from "../src/git/diff-parser.js";
import { buildRepositoryIndex, withRepositoryToolCallContext } from "../src/repo/repository-index.js";
import { LanguageAdapterRegistry } from "../src/repo/language-adapter.js";
import { containGlob, containPath, containRef } from "../src/repo/path-guard.js";
import type { SourceResolver } from "../src/repo/source-resolver.js";
import { extractStaticSignals } from "../src/repo/static-signals.js";
import { TreeSitterService } from "../src/repo/tree-sitter/tree-sitter-service.js";
import type {
  DiffFile,
  FileFacts,
  LanguageAdapter,
  ParsedFile,
  RepositoryToolsHost,
  ResolvedReviewInput,
  ReviewStage,
  SourceSelector,
  TelemetryEvent,
  ToolCallRecord
} from "../src/types.js";
import type { LlmCallRecord, TelemetryRecorder } from "../src/telemetry/telemetry-recorder.js";
import { commitAll, git, initRepo, writeRepoFile } from "./helpers/git.js";

describe("repository intelligence", () => {
  it("contains paths, globs, and refs at the repo boundary", () => {
    const repoRoot = "/repo";

    expect(containPath(repoRoot, "./a//b/./c.go")).toBe("a/b/c.go");
    expect(containGlob(repoRoot, "src/**/*.go")).toBe("src/**/*.go");
    expect(containRef("feature/repo-intel")).toBe("feature/repo-intel");
    expect(containRef("a".repeat(40))).toBe("a".repeat(40));

    expectThrowsCode(() => containPath(repoRoot, "/etc/passwd"), "path_outside_repo");
    expectThrowsCode(() => containPath(repoRoot, "a/../../b"), "path_outside_repo");
    expectThrowsCode(() => containPath(repoRoot, ".git/config"), "path_outside_repo");
    expectThrowsCode(() => containPath(repoRoot, "src\\file.go"), "path_outside_repo");
    expectThrowsCode(() => containRef("--upload-pack=x"), "invalid_args");
    expectThrowsCode(() => containRef("a..b"), "invalid_args");
  });

  it("loads pinned parser grammars and routes language variants into SymbolInfo summaries", async () => {
    const service = new TreeSitterService();
    const registry = new LanguageAdapterRegistry(service);

    expect(service.routePath("pkg/store.go")).toBe("go");
    expect(service.routePath("src/view.tsx")).toBe("tsx");
    expect(service.routePath("src/types.d.ts")).toBe("typescript");
    expect(service.routePath("src/index.cjs")).toBe("javascript");
    expect(existsSync(path.join("node_modules", "tree-sitter-go", "tree-sitter-go.wasm"))).toBe(true);
    expect(existsSync(path.join("node_modules", "tree-sitter-typescript", "tree-sitter-tsx.wasm"))).toBe(true);

    const go = await service.parse({
      path: "pkg/store.go",
      language: "go",
      content: "package store\n\nfunc SaveUser(name string) string { return name }\n",
      source: { kind: "head" },
      contentSha: "go-fixture"
    });
    const sameBlobAtBase = await service.parse({
      path: "pkg/other.go",
      language: "go",
      content: "package store\n\nfunc SaveUser(name string) string { return name }\n",
      source: { kind: "base" },
      contentSha: "go-fixture"
    });
    const tsx = await service.parse({
      path: "src/view.tsx",
      language: "tsx",
      content: "export function View() { return <div /> }\n",
      source: { kind: "head" },
      contentSha: "tsx-fixture"
    });

    expect(registry.forPath("pkg/store.go").listSymbols(go)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "SaveUser", kind: "function", signature: "func SaveUser(name string) string" })])
    );
    expect(sameBlobAtBase.path).toBe("pkg/other.go");
    expect(sameBlobAtBase.source).toEqual({ kind: "base" });
    expect(registry.forPath("src/view.tsx").listSymbols(tsx)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "View", kind: "function", signature: "function View()" })])
    );
  });

  it("builds index facts, tools, packet context, and telemetry over git revisions", async () => {
    const repo = initRepo();
    const outsideDir = mkdtempSync(path.join(tmpdir(), "codeninja-outside-"));
    writeFileSync(path.join(outsideDir, "secret.txt"), "OutsideSecretLeak\n");
    symlinkSync(outsideDir, path.join(repo, "linked-outside"), "dir");
    writeRepoFile(repo, ".ignore", "ignored*.txt\nignored-dir/\n");
    writeRepoFile(repo, "ignored-tracked.txt", "IgnoredTrackedNeedle\n");
    git(repo, ["add", "-f", "ignored-tracked.txt"]);
    writeRepoFile(repo, "root.go", "package root\n\nfunc Root() {}\n");
    writeRepoFile(repo, "root_test.go", "package root\n\nimport \"testing\"\n\nfunc TestRoot(t *testing.T) {}\n");
    writeRepoFile(
      repo,
      "store/user.go",
      `package store

type Store struct{}

func (s *Store) SaveUser(name string) string {
	return name
}
`
    );
    writeRepoFile(
      repo,
      "store/user_test.go",
      `package store

import "testing"

func TestSaveUser(t *testing.T) {
	s := &Store{}
	if s.SaveUser("a") != "a" {
		t.Fatal("bad")
	}
}
`
    );
    writeRepoFile(repo, "many/many.go", `package many\n\n${manyFunctions(130)}\n`);
    writeRepoFile(repo, "long/long.go", `package long\n\n${longFunction(320)}\n`);
    writeRepoFile(repo, "dups/dups.go", `package dups\n\n${duplicateLongFunctions(5)}\n`);
    writeRepoFile(repo, "dups/many_defs.go", `package dups\n\n${duplicateFunctions("ManyDup", 25)}\n`);
    writeRepoFile(repo, "src/arrow.ts", "export const calc = (x: number) => x + 1\n");
    writeRepoFile(
      repo,
      "src/nested.ts",
      `export class PublicClass {
  save(): unknown {
    class LocalClass {
      hidden(value: string): string {
        return value
      }
    }
    return new LocalClass().hidden("a")
  }
}
`
    );
    writeRepoFile(repo, "src/util.ts", "export function targetSymbol(): string { return 'ok' }\n");
    writeRepoFile(repo, "src/util.test.ts", "const mention = 'targetSymbol'\nexport const helper = mention\n");
    writeRepoFile(repo, "src/mass.ts", "export function massSubject(): void {}\n");
    for (let index = 0; index < 25; index += 1) {
      writeRepoFile(repo, `tests/mass${String(index).padStart(2, "0")}/mass.test.ts`, `test("mass ${index}", () => { massSubject() })\n`);
    }
    writeRepoFile(repo, "src/default-arrow.ts", "export default () => 'arrow'\n");
    writeRepoFile(repo, "src/default-class.ts", "export default class { value(): number { return 1 } }\n");
    writeRepoFile(
      repo,
      "src/default-fn.ts",
      `export default function (value: string): string {
  return value
}
`
    );
    writeRepoFile(
      repo,
      "src/remove.ts",
      `export function removedApi(): string {
  return "removed"
}
`
    );
    writeRepoFile(
      repo,
      "src/field.ts",
      `export class FieldApi {
  private value = 1

  read(): number {
    return this.value
  }
}
`
    );
    writeRepoFile(
      repo,
      "src/handler.ts",
      `export class HandlerApi {
  handler = (value: number) => value + 1
}
`
    );
    writeRepoFile(
      repo,
      "src/api.ts",
      `function internal(value: string): string {
  return value
}

export { internal as Public }
`
    );
    writeRepoFile(
      repo,
      "src/ns.ts",
      `export namespace API {
  export function save(value: string): string {
    return value
  }
}
`
    );
    writeRepoFile(
      repo,
      "unnamed/unnamed.go",
      `package unnamed

type Cache struct{}

func (*Cache) Load() string {
	return "ok"
}
`
    );
    writeRepoFile(
      repo,
      "api/body.go",
      `package api

func ExportedBodyOnly() int {
	value := 1
	_ = value
	return value
}
`
    );
    for (let index = 0; index < 35; index += 1) {
      writeRepoFile(repo, `noise/${String(index).padStart(2, "0")}.go`, `package noise\n\n// RareDef mention ${index}\nfunc Noise${index}() {}\n`);
    }
    writeRepoFile(repo, "zz/target.go", "package target\n\nfunc RareDef() {}\n");
    for (let fileIndex = 0; fileIndex < 30; fileIndex += 1) {
      writeRepoFile(repo, `early/${String(fileIndex).padStart(2, "0")}.go`, `package early\n\n${lateDefMentions(fileIndex, 10)}\n`);
    }
    writeRepoFile(repo, "zzlate/target.go", "package target\n\nfunc LateDef() {}\n");
    for (let index = 0; index < 60; index += 1) {
      writeRepoFile(repo, `search/${String(index).padStart(2, "0")}.go`, `package search\n\n// SearchNeedle ${"x".repeat(450)} ${index}\n`);
    }
    for (let index = 0; index < 30; index += 1) {
      writeRepoFile(repo, `mentioncap/${String(index).padStart(2, "0")}.ts`, `// MentionCap ${index}\nexport const value${index} = ${index}\n`);
    }
    writeRepoFile(repo, "huge/huge.txt", `HugeNeedle ${"x".repeat(100_000)}\n`);
    const base = commitAll(repo, "base");
    writeRepoFile(
      repo,
      "store/user.go",
      `package store

import "context"

type Store struct{}

func (s *Store) SaveUser(ctx context.Context, name string) (string, error) {
	if ctx == nil {
		return "", nil
	}
	return name, nil
}
`
    );
    writeRepoFile(
      repo,
      "api/body.go",
      `package api

func ExportedBodyOnly() int {
	value := 1
	return value
}
`
    );
    writeRepoFile(repo, "src/arrow.ts", "export const calc = (x: number) => x + 2\n");
    writeRepoFile(
      repo,
      "src/default-fn.ts",
      `export default function (value: number): number {
  return value
}
`
    );
    writeRepoFile(
      repo,
      "src/remove.ts",
      `export function replacementApi(): string {
  return "replacement"
}
`
    );
    writeRepoFile(
      repo,
      "src/field.ts",
      `export class FieldApi {
  private value = 2

  read(): number {
    return this.value
  }
}
`
    );
    writeRepoFile(
      repo,
      "src/handler.ts",
      `export class HandlerApi {
  handler = (value: number) => value + 2
}
`
    );
    writeRepoFile(
      repo,
      "src/nested.ts",
      `export class PublicClass {
  save(): unknown {
    class LocalClass {
      hidden(value: number): number {
        return value
      }
    }
    return new LocalClass().hidden(1)
  }
}
`
    );
    writeRepoFile(
      repo,
      "src/api.ts",
      `function internal(value: number): number {
  return value
}

export { internal as Public }
`
    );
    writeRepoFile(
      repo,
      "src/ns.ts",
      `export namespace API {
  export function save(value: number): number {
    return value
  }
}
`
    );
    const head = commitAll(repo, "change save user");
    writeRepoFile(repo, "untracked space.txt", "UniqueUntracked\n");
    writeRepoFile(repo, "ignored-untracked.txt", "IgnoredDirtyOnly\n");
    writeRepoFile(repo, "ignored-dir/secret.txt", "IgnoredDirectoryOnly\n");
    const rawDiff = git(repo, ["diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", base, head]);
    const diff = parseDiff(rawDiff);
    const telemetry = recordingTelemetry();
    const resolved: ResolvedReviewInput = {
      mode: "commit_range",
      repoRoot: repo,
      startCommit: base,
      endCommit: head,
      mergeBase: base,
      headSha: head,
      commits: [],
      rawDiff
    };
    const facts = diff.files.map((file) => fileFacts(file));

    const index = await buildRepositoryIndex(resolved, diff.files, facts, defaultConfig, telemetry);
    const tools = index.tools as RepositoryToolsHost;
    const changedFile = diff.files.find((file) => file.path === "store/user.go");
    expect(changedFile).toBeDefined();

    expect(index.symbolFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "store/user.go",
          enclosingSymbol: "(*Store).SaveUser",
          source: "tree-sitter",
          confidence: "syntactic"
        })
      ])
    );
    expect(index.staticSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core/exported-api-change",
          path: "store/user.go"
        })
      ])
    );
    expect(index.staticSignals.filter((signal) => signal.ruleId === "core/exported-api-change" && signal.path === "store/user.go")).toHaveLength(1);
    expect(index.staticSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core/exported-api-change",
          path: "src/api.ts",
          snippet: expect.stringContaining("internal")
        }),
        expect.objectContaining({
          ruleId: "core/exported-api-change",
          path: "src/ns.ts",
          snippet: expect.stringContaining("save")
        })
      ])
    );
    expect(index.staticSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core/exported-api-change",
          path: "src/default-fn.ts",
          snippet: expect.stringContaining("function (value: number)")
        }),
        expect.objectContaining({
          ruleId: "core/exported-api-change",
          path: "src/remove.ts",
          side: "LEFT",
          snippet: expect.stringContaining("removedApi")
        })
      ])
    );

    const outline = await tools.readFileOutline("store/user.go");
    expect(outline.outline.packageName).toBe("store");
    expect(outline.outline.imports).toContain("context");
    expect(outline.outline.topLevelSymbols.map((symbol) => symbol.name)).toContain("SaveUser");

    const symbol = await tools.readSymbol("store/user.go", { symbolName: "(*Store).SaveUser" });
    expect(symbol.symbol).toMatchObject({ name: "SaveUser", ownerType: "Store", kind: "method" });
    expect(symbol.text).toContain("ctx context.Context");
    expect(symbol.symbol).toBeDefined();
    const apiOutline = await tools.readFileOutline("src/ns.ts");
    expect(apiOutline.outline.topLevelSymbols).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "save", ownerType: "API", kind: "function" })])
    );
    const namespaceSymbol = await tools.readSymbol("src/ns.ts", { symbolName: "API.save" });
    expect(namespaceSymbol.symbol).toMatchObject({ name: "save", ownerType: "API", kind: "function" });
    const nestedOutline = await tools.readFileOutline("src/nested.ts");
    expect(nestedOutline.outline.topLevelSymbols).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ name: "hidden", ownerType: "PublicClass" })])
    );
    const fieldOutline = await tools.readFileOutline("src/field.ts");
    expect(fieldOutline.outline.topLevelSymbols).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ name: "value", ownerType: "FieldApi" })])
    );
    const defaultArrowOutline = await tools.readFileOutline("src/default-arrow.ts");
    expect(defaultArrowOutline.outline.topLevelSymbols).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "default", kind: "function", nativeKind: "arrow function", exported: true })])
    );
    const defaultClassOutline = await tools.readFileOutline("src/default-class.ts");
    expect(defaultClassOutline.outline.topLevelSymbols).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "default", kind: "type", nativeKind: "class", exported: true })])
    );
    const defaultFunctionSymbol = await tools.readSymbol("src/default-fn.ts", { symbolName: "default" });
    expect(defaultFunctionSymbol.symbol).toMatchObject({ name: "default", kind: "function", nativeKind: "function", exported: true });
    const handlerSymbol = await tools.readSymbol("src/handler.ts", { symbolName: "HandlerApi.handler" });
    expect(handlerSymbol.symbol).toMatchObject({ name: "handler", ownerType: "HandlerApi", nativeKind: "class field function" });
    expect(handlerSymbol.symbol?.signature).toBe("handler = (value: number) =>");

    const normalizedDiff = await tools.readDiffBlocks({ path: "./store//user.go" });
    expect(normalizedDiff.blocks.length).toBeGreaterThan(0);

    const qualifiedDefinition = await tools.findDefinition("(*Store).SaveUser");
    expect(qualifiedDefinition.definitions[0]?.symbol).toMatchObject({ name: "SaveUser", ownerType: "Store" });
    const packageQualifiedPointerDefinition = await tools.findDefinition("store.(*Store).SaveUser");
    expect(packageQualifiedPointerDefinition.definitions[0]?.symbol).toMatchObject({ name: "SaveUser", ownerType: "Store" });
    const packageQualifiedValueDefinition = await tools.findDefinition("store.Store.SaveUser");
    expect(packageQualifiedValueDefinition.definitions[0]?.symbol).toMatchObject({ name: "SaveUser", ownerType: "Store" });
    const unnamedReceiverDefinition = await tools.findDefinition("(*Cache).Load");
    expect(unnamedReceiverDefinition.definitions[0]?.symbol).toMatchObject({ name: "Load", ownerType: "Cache", kind: "method" });
    const namespaceDefinition = await tools.findDefinition("API.save", { pathGlob: "src/*.ts" });
    expect(namespaceDefinition.definitions[0]?.symbol).toMatchObject({ name: "save", ownerType: "API" });
    const defaultArrowDefinition = await tools.findDefinition("default", { pathGlob: "src/default-arrow.ts" });
    expect(defaultArrowDefinition.definitions[0]?.symbol).toMatchObject({ name: "default", nativeKind: "arrow function" });

    const omittedCandidateDefinition = await tools.findDefinition("RareDef");
    expect(omittedCandidateDefinition.definitions).toHaveLength(0);
    expect(omittedCandidateDefinition.meta.truncated).toBe(true);
    expect(omittedCandidateDefinition.meta.omittedCount).toBeGreaterThan(0);
    const discoveryCappedDefinition = await tools.findDefinition("LateDef");
    expect(discoveryCappedDefinition.definitions).toHaveLength(0);
    expect(discoveryCappedDefinition.meta.truncated).toBe(true);
    expect(discoveryCappedDefinition.meta.omittedCount).toBeGreaterThan(0);

    const longDefinition = await tools.findDefinition("LongFunction");
    expect(longDefinition.meta.truncated).toBe(true);
    expect(longDefinition.meta.omittedCount).toBeGreaterThan(0);
    const duplicateDefinitions = await tools.findDefinition("BigDup");
    expect(duplicateDefinitions.meta.truncated).toBe(true);
    expect(JSON.stringify(duplicateDefinitions.definitions).length).toBeLessThanOrEqual(16_000);
    const sameFileCappedDefinitions = await tools.findDefinition("ManyDup");
    expect(sameFileCappedDefinitions.definitions).toHaveLength(20);
    expect(sameFileCappedDefinitions.meta).toMatchObject({ truncated: true, omittedCount: 5 });

    const manyOutline = await tools.readFileOutline("many/many.go");
    expect(manyOutline.meta.truncated).toBe(true);
    expect(manyOutline.meta.omittedCount).toBeGreaterThan(0);
    expect(JSON.stringify(manyOutline.outline).length).toBeLessThanOrEqual(8_000);

    const search = await tools.searchFiles("SaveUser", { contextMode: "symbols" });
    expect(search.results.some((result) => result.path === "store/user.go" && result.enclosingSymbol?.name === "SaveUser")).toBe(true);
    const globbedSearch = await tools.searchFiles("SaveUser", { pathGlob: "./store//*.go" });
    expect(globbedSearch.results.some((result) => result.path === "store/user.go")).toBe(true);
    const cappedMentions = await tools.findSymbolMentions("MentionCap", { pathGlob: "./mentioncap//*.ts", source: { kind: "base" } });
    expect(cappedMentions.results).toHaveLength(5);
    expect(cappedMentions.meta.degraded).toBe(true);
    expect(cappedMentions.results.every((result) => Number(result.path.match(/(\d+)\.ts$/u)?.[1] ?? 0) >= 25)).toBe(true);
    const cappedSearch = await tools.searchFiles("Func", { maxResults: 2 });
    expect(cappedSearch.results).toHaveLength(2);
    expect(cappedSearch.meta.truncated).toBe(true);
    const totalCappedSearch = await tools.searchFiles("SearchNeedle", { maxResults: 100 });
    expect(totalCappedSearch.meta.truncated).toBe(true);
    expect(JSON.stringify(totalCappedSearch.results).length).toBeLessThanOrEqual(16_000);
    const hugeLineSearch = await tools.searchFiles("HugeNeedle", { maxResults: 1 });
    expect(hugeLineSearch.meta.degraded).toBe(true);
    expect(hugeLineSearch.meta.truncated).toBe(true);
    expect(hugeLineSearch.meta.omittedCount).toBeGreaterThan(0);
    expect(hugeLineSearch.results[0]?.path).toBe("huge/huge.txt");
    const untrackedSearch = await tools.searchFiles("UniqueUntracked");
    expect(untrackedSearch.results).toEqual([]);
    const ignoredTrackedSearch = await tools.searchFiles("IgnoredTrackedNeedle");
    expect(ignoredTrackedSearch.results.map((result) => result.path)).toContain("ignored-tracked.txt");
    const ignoredUntrackedSearch = await tools.searchFiles("IgnoredDirtyOnly");
    expect(ignoredUntrackedSearch.results).toEqual([]);
    const optionLikeQuerySearch = await tools.searchFiles("--follow", { maxResults: 20 });
    expect(optionLikeQuerySearch.results).toEqual([]);
    const range = await tools.readRange("store/user.go", 1, 2);
    expect(range.meta).toMatchObject({ backend: "text", precision: "exact", degraded: false });
    const pastEofRange = await tools.readRange("store/user.go", 10_000, 10_010);
    expect(pastEofRange.text).toBe("");
    expect(pastEofRange.meta).toMatchObject({
      backend: "text",
      precision: "exact",
      degraded: true,
      degradationReason: "requested range starts after end of file",
      truncated: true,
      omittedCount: 0
    });
    const listed = await tools.listFiles("store/*.go");
    expect(listed.paths).toEqual(expect.arrayContaining(["store/user.go", "store/user_test.go"]));
    expect(listed.meta).toMatchObject({ backend: "text", precision: "exact", degraded: false });

    await withRepositoryToolCallContext(
      index.tools,
      {
        stage: 9,
        initiator: "model",
        workerId: "w9-001",
        packetId: "packet-1",
        modelCallId: "mc-1"
      },
      async () => {
        await tools.readRange("store/user.go", 1, 1);
      }
    );

    const tests = await tools.findLikelyTests({ path: "store/user.go", symbol: symbol.symbol! });
    expect(tests.tests.map((test) => test.path)).toContain("store/user_test.go");
    const rootTests = await tools.findLikelyTests({ path: "root.go" });
    expect(rootTests.tests.map((test) => test.path)).toContain("root_test.go");
    const cappedLikelyTests = await tools.findLikelyTests({ path: "src/mass.ts" });
    expect(cappedLikelyTests.tests).toHaveLength(20);
    expect(cappedLikelyTests.meta.truncated).toBe(true);
    expect(cappedLikelyTests.meta.omittedCount).toBe(5);
    const parseableNonMatchingTests = await tools.findLikelyTests({
      symbol: {
        path: "src/util.ts",
        name: "targetSymbol",
        kind: "function",
        lineRange: [1, 1]
      }
    });
    expect(parseableNonMatchingTests.tests).toEqual([]);

    const context = await tools.buildPacketContext(
      changedFile as DiffFile,
      (changedFile as DiffFile).hunks,
      index.symbolFacts.filter((fact) => fact.path === "store/user.go")
    );
    expect(context.context.enclosingMethod).toMatchObject({ name: "SaveUser", ownerType: "Store" });
    expect(context.context.enclosingType).toMatchObject({ name: "Store" });
    expect(context.relevantTests.map((test) => test.path)).toContain("store/user_test.go");
    expect(index.staticSignals.some((signal) => signal.ruleId === "core/exported-api-change" && signal.path === "api/body.go")).toBe(false);
    expect(index.staticSignals.some((signal) => signal.ruleId === "core/exported-api-change" && signal.path === "src/arrow.ts")).toBe(false);
    expect(index.staticSignals.some((signal) => signal.ruleId === "core/exported-api-change" && signal.path === "src/nested.ts")).toBe(false);
    expect(index.staticSignals.some((signal) => signal.ruleId === "core/exported-api-change" && signal.path === "src/field.ts")).toBe(false);
    expect(index.staticSignals.some((signal) => signal.ruleId === "core/exported-api-change" && signal.path === "src/handler.ts")).toBe(false);

    await expect(tools.readRange("../secret", 1, 2)).rejects.toMatchObject({ code: "path_outside_repo" });
    await expect(tools.findLikelyTests({ path: "../secret" })).rejects.toMatchObject({ code: "path_outside_repo" });
    await expect(tools.searchFiles("SaveUser", { pathGlob: "../bad" })).rejects.toMatchObject({ code: "path_outside_repo" });
    await expect(tools.findSymbolMentions("SaveUser", { pathGlob: "../bad" })).rejects.toMatchObject({ code: "path_outside_repo" });
    await expect(tools.findDefinition("SaveUser", { pathGlob: "../bad" })).rejects.toMatchObject({ code: "path_outside_repo" });
    expect(telemetry.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: "search_files", engine: "git-grep", status: "ok", degraded: true }),
        expect.objectContaining({ tool: "search_files", status: "ok", truncated: true, omittedCount: expect.any(Number) }),
        expect.objectContaining({ tool: "search_files", status: "ok", args: expect.objectContaining({ query: "--follow" }) }),
        expect.objectContaining({ tool: "read_file_outline", status: "ok", args: expect.objectContaining({ path: "many/many.go" }), omittedCount: expect.any(Number) }),
        expect.objectContaining({ tool: "read_diff_blocks", status: "ok", args: expect.objectContaining({ path: "store/user.go" }) }),
        expect.objectContaining({ tool: "search_files", status: "ok", args: expect.objectContaining({ glob: "store/*.go" }) }),
        expect.objectContaining({
          tool: "find_symbol_mentions",
          status: "ok",
          args: expect.objectContaining({ glob: "mentioncap/*.ts", source: "base" })
        }),
        expect.objectContaining({
          tool: "read_range",
          initiator: "model",
          stage: 9,
          workerId: "w9-001",
          packetId: "packet-1",
          modelCallId: "mc-1",
          status: "ok"
        }),
        expect.objectContaining({ tool: "read_range", status: "rejected", errorCode: "path_outside_repo" }),
        expect.objectContaining({ tool: "find_likely_tests", status: "rejected", errorCode: "path_outside_repo" }),
        expect.objectContaining({ tool: "search_files", status: "rejected", errorCode: "path_outside_repo" }),
        expect.objectContaining({ tool: "find_symbol_mentions", status: "rejected", errorCode: "path_outside_repo" }),
        expect.objectContaining({ tool: "find_definition", status: "rejected", errorCode: "path_outside_repo" })
      ])
    );
    expect(telemetry.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: "path containment violation",
          data: expect.objectContaining({ toolName: "find_likely_tests" })
        }),
        expect.objectContaining({
          level: "warn",
          message: "path containment violation",
          data: expect.objectContaining({ toolName: "search_files" })
        }),
        expect.objectContaining({
          level: "warn",
          message: "path containment violation",
          data: expect.objectContaining({ toolName: "find_symbol_mentions" })
        }),
        expect.objectContaining({
          level: "warn",
          message: "path containment violation",
          data: expect.objectContaining({ toolName: "find_definition" })
        })
      ])
    );
  });

  it("falls back to git grep when ignored or untracked paths would make ripgrep walk extra tree content", async () => {
    const repo = initRepo();
    const outsideDir = mkdtempSync(path.join(tmpdir(), "codeninja-outside-"));
    writeFileSync(path.join(outsideDir, "secret.txt"), "OutsideSecretLeak\n");
    writeFileSync(path.join(outsideDir, "secret-file.txt"), "OutsideFileSecretLeak\n");
    symlinkSync(outsideDir, path.join(repo, "linked-outside"), "dir");
    symlinkSync(path.join(outsideDir, "secret-file.txt"), path.join(repo, "linked-outside-file.txt"), "file");
    writeRepoFile(repo, ".ignore", "ignored*.txt\nignored-dir/\n");
    writeRepoFile(repo, "ignored-tracked.txt", "IgnoredTrackedNeedle\n");
    writeRepoFile(repo, "src/app.ts", "export const visible = 'VisibleNeedle'\n");
    git(repo, ["add", "linked-outside-file.txt"]);
    git(repo, ["add", "-f", "ignored-tracked.txt"]);
    const head = commitAll(repo, "base");
    writeRepoFile(repo, "ignored-untracked.txt", "IgnoredDirtyOnly\n");
    writeRepoFile(repo, "ignored-dir/secret.txt", "IgnoredDirectoryOnly\n");

    const { telemetry, tools } = await buildIndexForRange(repo, head, head);

    expect((await tools.searchFiles("VisibleNeedle")).results.map((result) => result.path)).toContain("src/app.ts");
    expect((await tools.searchFiles("IgnoredTrackedNeedle")).results.map((result) => result.path)).toContain("ignored-tracked.txt");
    expect((await tools.searchFiles("IgnoredDirtyOnly")).results).toEqual([]);
    expect((await tools.searchFiles("IgnoredDirectoryOnly")).results).toEqual([]);
    expect((await tools.searchFiles("--follow", { maxResults: 20 })).results).toEqual([]);
    expect((await tools.searchFiles("OutsideSecretLeak", { maxResults: 20 })).results).toEqual([]);
    expect((await tools.searchFiles("OutsideFileSecretLeak", { maxResults: 20 })).results).toEqual([]);
    const symlinkContent = await tools.readRange("linked-outside-file.txt", 1, 1);
    expect(symlinkContent.text).toContain(path.join(outsideDir, "secret-file.txt"));
    expect(symlinkContent.text).not.toContain("OutsideFileSecretLeak");
    expect(telemetry.toolCalls.filter((call) => call.tool === "search_files")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ engine: "git-grep", degraded: false })
      ])
    );
    expect(telemetry.toolCalls.filter((call) => call.tool === "search_files").every((call) => call.degraded === false)).toBe(true);
  });

  it("uses the ripgrep fast path for clean tracked worktrees", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "src/app.ts", "export const visible = 'VisibleNeedle'\n");
    const head = commitAll(repo, "base");
    const { telemetry, tools } = await buildIndexForRange(repo, head, head);

    expect((await tools.searchFiles("VisibleNeedle")).results.map((result) => result.path)).toContain("src/app.ts");
    expect(telemetry.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: "search_files", engine: "ripgrep", status: "ok", degraded: false })
      ])
    );
  });

  it("does not search checked-out submodule contents through the ripgrep fast path", async () => {
    const submodule = initRepo();
    writeRepoFile(submodule, "secret.txt", "SubmoduleSecretNeedle\n");
    commitAll(submodule, "submodule content");

    const repo = initRepo();
    writeRepoFile(repo, "src/app.ts", "export const visible = 'ParentNeedle'\n");
    git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", submodule, "deps/sub"]);
    const head = commitAll(repo, "parent with submodule");
    const { tools } = await buildIndexForRange(repo, head, head);

    expect((await tools.searchFiles("ParentNeedle")).results.map((result) => result.path)).toContain("src/app.ts");
    expect((await tools.searchFiles("SubmoduleSecretNeedle", { maxResults: 20 })).results).toEqual([]);
  });

  it("extracts TypeScript exported API symbols with precise callable semantics", async () => {
    const service = new TreeSitterService();
    const registry = new LanguageAdapterRegistry(service);

    const defaultArrow = await parseForTest(registry, "src/default-arrow.ts", "export default () => 'ok'\n");
    expect(defaultArrow).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "default", kind: "function", nativeKind: "arrow function", exported: true })])
    );

    const namedExports = await parseForTest(
      registry,
      "src/api.ts",
      `function internal(): string {
  return "ok"
}

export { internal as Public }

export namespace API {
  export function save(value: string): string {
    return value
  }
}
`
    );
    expect(namedExports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "internal", exported: true }),
        expect.objectContaining({ name: "save", ownerType: "API", kind: "function", exported: true })
      ])
    );

    const classMembers = await parseForTest(
      registry,
      "src/class.ts",
      `export class Api {
  private value = 1
  private secret(value: string): string {
    return value
  }
  protected helper = (value: string) => value
  handler = (value: number) => value + 1
}
`
    );
    expect(classMembers).toEqual(expect.not.arrayContaining([expect.objectContaining({ name: "value", ownerType: "Api" })]));
    expect(classMembers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "secret", ownerType: "Api", exported: false }),
        expect.objectContaining({ name: "helper", ownerType: "Api", exported: false })
      ])
    );
    expect(classMembers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "handler",
          ownerType: "Api",
          nativeKind: "class field function",
          signature: "handler = (value: number) =>"
        })
      ])
    );
  });

  it("does not treat private or protected TypeScript members as exported API changes", async () => {
    const repo = initRepo();
    writeRepoFile(
      repo,
      "src/api.ts",
      `export class Api {
  private secret(value: string): string {
    return value
  }

  protected helper = (value: string) => value
}
`
    );
    const base = commitAll(repo, "base");
    writeRepoFile(
      repo,
      "src/api.ts",
      `export class Api {
  private secret(value: number): number {
    return value
  }

  protected helper = (value: number) => value
}
`
    );
    const head = commitAll(repo, "change private members");

    const { index } = await buildIndexForRange(repo, base, head);

    expect(index.staticSignals.some((signal) => signal.ruleId === "core/exported-api-change" && signal.path === "src/api.ts")).toBe(false);
  });

  it("reports likely tests for root files, caps large result sets, and skips parseable non-matching fallback files", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "root.go", "package root\n\nfunc Root() {}\n");
    writeRepoFile(repo, "root_test.go", "package root\n\nimport \"testing\"\n\nfunc TestRoot(t *testing.T) {}\n");
    writeRepoFile(repo, "src/module.mjs", "export function moduleSubject() {}\n");
    writeRepoFile(repo, "src/module.test.mjs", "test('module', () => { moduleSubject() })\n");
    writeRepoFile(repo, "src/typed.mts", "export function typedSubject(): void {}\n");
    writeRepoFile(repo, "src/typed.test.mts", "test('typed', () => { typedSubject() })\n");
    writeRepoFile(repo, "src/common.cjs", "exports.commonSubject = () => {}\n");
    writeRepoFile(repo, "src/common.test.cjs", "test('common', () => { commonSubject() })\n");
    writeRepoFile(repo, "src/config.cts", "export function configSubject(): void {}\n");
    writeRepoFile(repo, "src/config.test.cts", "test('config', () => { configSubject() })\n");
    writeRepoFile(repo, "src/mass.ts", "export function massSubject(): void {}\n");
    for (let index = 0; index < 25; index += 1) {
      writeRepoFile(repo, `tests/mass${String(index).padStart(2, "0")}/mass.test.ts`, `test("mass ${index}", () => { massSubject() })\n`);
    }
    writeRepoFile(repo, "src/util.ts", "export function targetSymbol(): string { return 'ok' }\n");
    writeRepoFile(repo, "src/util.test.ts", "const mention = 'targetSymbol'\nexport const helper = mention\n");
    const head = commitAll(repo, "base");
    const { tools } = await buildIndexForRange(repo, head, head);

    expect((await tools.findLikelyTests({ path: "root.go" })).tests.map((test) => test.path)).toContain("root_test.go");
    expect((await tools.findLikelyTests({ path: "src/module.mjs" })).tests.map((test) => test.path)).toContain("src/module.test.mjs");
    expect((await tools.findLikelyTests({ path: "src/typed.mts" })).tests.map((test) => test.path)).toContain("src/typed.test.mts");
    expect((await tools.findLikelyTests({ path: "src/common.cjs" })).tests.map((test) => test.path)).toContain("src/common.test.cjs");
    expect((await tools.findLikelyTests({ path: "src/config.cts" })).tests.map((test) => test.path)).toContain("src/config.test.cts");

    const capped = await tools.findLikelyTests({ path: "src/mass.ts" });
    expect(capped.tests).toHaveLength(20);
    expect(capped.meta).toMatchObject({ truncated: true, omittedCount: 5 });

    const nonMatching = await tools.findLikelyTests({
      symbol: {
        path: "src/util.ts",
        name: "targetSymbol",
        kind: "function",
        lineRange: [1, 1]
      }
    });
    expect(nonMatching.tests).toEqual([]);
  });

  it("resolves qualified Go methods with unnamed receivers", async () => {
    const repo = initRepo();
    writeRepoFile(
      repo,
      "cache/cache.go",
      `package cache

type Cache struct{}

func (*Cache) Load() string {
  return "ok"
}
`
    );
    const head = commitAll(repo, "base");
    const { tools } = await buildIndexForRange(repo, head, head);

    const definition = await tools.findDefinition("(*Cache).Load");
    expect(definition.definitions[0]?.symbol).toMatchObject({ name: "Load", ownerType: "Cache", kind: "method" });
  });

  it("records normalized successful tool args and omitted counts in telemetry", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "src/app.ts", "export const value = 1\n");
    writeRepoFile(repo, "many/many.go", `package many\n\n${manyFunctions(130)}\n`);
    const base = commitAll(repo, "base");
    writeRepoFile(repo, "src/app.ts", "export const value = 2\n");
    const head = commitAll(repo, "change app");
    const telemetry = recordingTelemetry();
    const { tools } = await buildIndexForRange(repo, base, head, telemetry);

    await tools.readDiffBlocks({ path: "./src//app.ts" });
    await tools.searchFiles("value", { pathGlob: "./src//*.ts" });
    await tools.readFileOutline("many/many.go");

    expect(telemetry.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: "read_diff_blocks", status: "ok", args: expect.objectContaining({ path: "src/app.ts" }) }),
        expect.objectContaining({ tool: "search_files", status: "ok", args: expect.objectContaining({ glob: "src/*.ts" }) }),
        expect.objectContaining({
          tool: "read_file_outline",
          status: "ok",
          args: expect.objectContaining({ path: "many/many.go" }),
          truncated: true,
          omittedCount: expect.any(Number)
        })
      ])
    );
  });

  it("rejects readDiffBlocks calls with both path and packet selectors", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "src/app.ts", "export const value = 1\n");
    const base = commitAll(repo, "base");
    writeRepoFile(repo, "src/app.ts", "export const value = 2\n");
    const head = commitAll(repo, "change app");
    const { tools } = await buildIndexForRange(repo, base, head);

    await expect(tools.readDiffBlocks({ path: "src/app.ts", packetId: "packet-1" })).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("surfaces mixed-hunk exported replacements without duplicate same-root signature signals", async () => {
    const repo = initRepo();
    writeRepoFile(
      repo,
      "src/replace.ts",
      `export function removedApi(): string {
  return "removed"
}
`
    );
    writeRepoFile(
      repo,
      "src/signature.ts",
      `export function changed(value: string): string {
  return value
}
`
    );
    const base = commitAll(repo, "base");
    writeRepoFile(
      repo,
      "src/replace.ts",
      `export function replacementApi(): string {
  return "replacement"
}
`
    );
    writeRepoFile(
      repo,
      "src/signature.ts",
      `export function changed(value: number): number {
  return value
}
`
    );
    const head = commitAll(repo, "change api");

    const { index } = await buildIndexForRange(repo, base, head);
    const replacementFacts = index.symbolFacts.filter((fact) => fact.path === "src/replace.ts");

    expect(replacementFacts).toHaveLength(1);
    expect(replacementFacts[0]).toMatchObject({ changedLinesSide: "new", enclosingSymbol: "replacementApi" });
    expect(index.staticSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core/exported-api-change",
          path: "src/replace.ts",
          side: "LEFT",
          snippet: expect.stringContaining("removedApi")
        })
      ])
    );
    expect(index.staticSignals.filter((signal) => signal.ruleId === "core/exported-api-change" && signal.path === "src/signature.ts")).toHaveLength(1);
  });

  it("surfaces every exported signature changed inside one diff hunk", async () => {
    const repo = initRepo();
    writeRepoFile(
      repo,
      "src/api.ts",
      `export function first(value: string): string {
  return value
}

export function second(count: number): number {
  return count
}
`
    );
    const base = commitAll(repo, "base");
    writeRepoFile(
      repo,
      "src/api.ts",
      `export function first(value: number): number {
  return value
}

export function second(count: string): string {
  return count
}
`
    );
    const head = commitAll(repo, "change two signatures");

    const { index } = await buildIndexForRange(repo, base, head);
    const facts = index.symbolFacts.filter((fact) => fact.path === "src/api.ts");
    const signals = index.staticSignals.filter((signal) => signal.ruleId === "core/exported-api-change" && signal.path === "src/api.ts");

    expect(facts).toHaveLength(1);
    expect(signals).toHaveLength(2);
    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ snippet: expect.stringContaining("first(value: number): number") }),
        expect.objectContaining({ snippet: expect.stringContaining("second(count: string): string") })
      ])
    );
  });

  it("surfaces every deleted exported top-level symbol inside one deletion-only hunk", async () => {
    const repo = initRepo();
    writeRepoFile(
      repo,
      "src/api.ts",
      `export function first(): string {
  return "first"
}
export function second(): string {
  return "second"
}
`
    );
    const base = commitAll(repo, "base");
    writeRepoFile(repo, "src/api.ts", "");
    const head = commitAll(repo, "delete exported functions");

    const { index } = await buildIndexForRange(repo, base, head);
    const signals = index.staticSignals.filter((signal) => signal.ruleId === "core/exported-api-change" && signal.path === "src/api.ts");

    expect(signals).toHaveLength(2);
    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ side: "LEFT", snippet: expect.stringContaining("first()") }),
        expect.objectContaining({ side: "LEFT", snippet: expect.stringContaining("second()") })
      ])
    );
  });

  it("surfaces deletion-only exported shape changes in surviving types", async () => {
    const repo = initRepo();
    writeRepoFile(
      repo,
      "src/api.ts",
      `export interface Api {
  keep(): string
  removed(): string
}
`
    );
    writeRepoFile(
      repo,
      "api/client.go",
      `package api

type Client struct {
	Timeout int
	Token string
}
`
    );
    writeRepoFile(
      repo,
      "api/doer.go",
      `package api

type Doer interface {
	Do() error
	Close() error
}
`
    );
    const base = commitAll(repo, "base");
    writeRepoFile(
      repo,
      "src/api.ts",
      `export interface Api {
  keep(): string
}
`
    );
    writeRepoFile(
      repo,
      "api/client.go",
      `package api

type Client struct {
	Timeout int
}
`
    );
    writeRepoFile(
      repo,
      "api/doer.go",
      `package api

type Doer interface {
	Do() error
}
`
    );
    const head = commitAll(repo, "remove exported shape members");

    const { index } = await buildIndexForRange(repo, base, head);
    const signals = index.staticSignals.filter((signal) => signal.ruleId === "core/exported-api-change");

    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/api.ts", side: "LEFT", snippet: expect.stringContaining("removed(): string") }),
        expect.objectContaining({ path: "api/client.go", side: "LEFT", snippet: expect.stringContaining("Token string") }),
        expect.objectContaining({ path: "api/doer.go", side: "LEFT", snippet: expect.stringContaining("Close() error") })
      ])
    );
  });

  it("surfaces fallback exported signature changes when parsing is unavailable", async () => {
    const repo = initRepo();
    const filler = oversizedFiller();
    writeRepoFile(
      repo,
      "src/oversized.ts",
      `export function fallbackApi(value: string): string {
  return value
}

const pad0 = 0
const pad1 = 1
const pad2 = 2
const pad3 = 3

${filler}
`
    );
    const base = commitAll(repo, "base");
    writeRepoFile(
      repo,
      "src/oversized.ts",
      `export function fallbackApi(value: number): number {
  return value
}

const pad0 = 0
const pad1 = 1
const pad2 = 2
const pad3 = 3

${filler}
`
    );
    const head = commitAll(repo, "change oversized api");

    const { index } = await buildIndexForRange(repo, base, head);

    expect(index.symbolFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/oversized.ts",
          source: "fallback",
          enclosingSymbol: "fallbackApi",
          changedLinesSide: "new"
        })
      ])
    );
    expect(index.staticSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core/exported-api-change",
          path: "src/oversized.ts",
          side: "RIGHT",
          snippet: expect.stringContaining("fallbackApi(value: number): number")
        })
      ])
    );
  });

  it("records telemetry when static signal caps omit results", async () => {
    const telemetry = recordingTelemetry();
    const files = Array.from({ length: 205 }, (_, index): DiffFile => {
      const filePath = `pkg/deleted_${index}_test.go`;
      return {
        path: filePath,
        status: "deleted",
        language: "go",
        hunks: [
          {
            id: `h${index}`,
            path: filePath,
            oldStart: 1,
            oldLines: 1,
            newStart: 0,
            newLines: 0,
            header: "",
            lines: [
              {
                kind: "delete",
                content: "func TestDeleted(t *testing.T) {}",
                oldLineNumber: 1
              }
            ]
          }
        ]
      };
    });
    const facts = files.map((file) => ({ ...fileFacts(file), testStatus: "test" as const }));

    const signals = await extractStaticSignals({} as never, {} as never, files, facts, [], telemetry);

    const capEvent = telemetry.events.find((event) => event.message === "static_signal_cap_hit" && event.data?.scope === "run");
    expect(signals).toHaveLength(200);
    expect(capEvent).toMatchObject({
      stage: 4,
      level: "warn",
      data: expect.objectContaining({ scope: "run", cap: 200 })
    });
    expect(capEvent?.data?.omittedCount).toBe(5);
  });

  it("records telemetry when static signal per-file caps omit results", async () => {
    const telemetry = recordingTelemetry();
    const file: DiffFile = {
      path: "pkg/api.go",
      status: "modified",
      language: "go",
      hunks: Array.from({ length: 25 }, (_, index) => ({
        id: `h${index}`,
        path: "pkg/api.go",
        oldStart: index + 1,
        oldLines: 1,
        newStart: index + 1,
        newLines: 0,
        header: "",
        lines: [
          {
            kind: "delete" as const,
            content: `func Exported${index}() {}`,
            oldLineNumber: index + 1
          }
        ]
      }))
    };
    const facts = [{ ...fileFacts(file), testStatus: "source" as const }];
    const symbolFacts = file.hunks.map((hunk, index) => ({
      path: file.path,
      hunkId: hunk.id,
      enclosingSymbol: `Exported${index}`,
      symbolKind: "function" as const,
      symbolRange: [index + 1, index + 1] as [number, number],
      changedLines: [index + 1],
      changedLinesSide: "old" as const,
      source: "tree-sitter" as const,
      confidence: "syntactic" as const
    }));

    const signals = await extractStaticSignals(fakeResolver(), fakeRegistry(), [file], facts, symbolFacts, telemetry);

    const capEvent = telemetry.events.find((event) => event.message === "static_signal_cap_hit" && event.data?.scope === "file");
    expect(signals).toHaveLength(20);
    expect(capEvent).toMatchObject({
      stage: 4,
      level: "warn",
      file: "pkg/api.go",
      data: expect.objectContaining({ scope: "file", cap: 20, omittedCount: 5 })
    });
  });
});

function fileFacts(file: DiffFile): FileFacts {
  return {
    path: file.path,
    language: file.language,
    processingMode: "per-hunk",
    testStatus: file.path.endsWith("_test.go") ? "test" : "source",
    isGenerated: false,
    isVendored: false,
    isLockfile: false,
    isBinary: false,
    changedLines: file.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === "add" || line.kind === "delete")).length,
    hunkCount: file.hunks.length,
    labels: [],
    reviewPriority: "normal",
    reasons: [],
    provenance: []
  };
}

async function buildIndexForRange(
  repo: string,
  base: string,
  head: string,
  telemetry: TelemetryRecorder & { events: TelemetryEvent[]; toolCalls: ToolCallRecord[] } = recordingTelemetry()
): Promise<{
  index: Awaited<ReturnType<typeof buildRepositoryIndex>>;
  tools: RepositoryToolsHost;
  telemetry: TelemetryRecorder & { events: TelemetryEvent[]; toolCalls: ToolCallRecord[] };
}> {
  const rawDiff = git(repo, ["diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", base, head]);
  const diff = parseDiff(rawDiff);
  const index = await buildRepositoryIndex(
    {
      mode: "commit_range",
      repoRoot: repo,
      startCommit: base,
      endCommit: head,
      mergeBase: base,
      headSha: head,
      commits: [],
      rawDiff
    },
    diff.files,
    diff.files.map((file) => fileFacts(file)),
    defaultConfig,
    telemetry
  );
  return { index, tools: index.tools as RepositoryToolsHost, telemetry };
}

async function parseForTest(registry: LanguageAdapterRegistry, filePath: string, content: string) {
  const adapter = registry.forPath(filePath);
  const parsed = await adapter.parse({
    path: filePath,
    language: registry.languageForPath(filePath),
    content,
    source: { kind: "head" },
    contentSha: `test:${filePath}`
  });
  return adapter.listSymbols(parsed);
}

function expectThrowsCode(fn: () => unknown, expected: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject({ code: expected });
    return;
  }
  throw new Error(`expected function to throw ${expected}`);
}

function manyFunctions(count: number): string {
  return Array.from({ length: count }, (_, index) => `func Func${index}() string { return "Func${index}" }`).join("\n\n");
}

function longFunction(lines: number): string {
  const body = Array.from({ length: lines }, (_, index) => `\tvalue += ${index}`).join("\n");
  return `func LongFunction() int {\n\tvalue := 0\n${body}\n\treturn value\n}`;
}

function lateDefMentions(fileIndex: number, count: number): string {
  return Array.from({ length: count }, (_, index) => `// LateDef mention ${fileIndex}-${index}`).join("\n");
}

function duplicateLongFunctions(count: number): string {
  return Array.from({ length: count }, (_, index) => `func BigDup() int {\n${longBody(index, 180)}\n}`).join("\n\n");
}

function duplicateFunctions(name: string, count: number): string {
  return Array.from({ length: count }, () => `func ${name}() string { return "${name}" }`).join("\n\n");
}

function oversizedFiller(): string {
  return Array.from({ length: 1_600 }, (_, index) => `const oversized${index} = "${"x".repeat(1_000)}"`).join("\n");
}

function longBody(seed: number, lines: number): string {
  return Array.from({ length: lines }, (_, index) => `\tvalue${seed} := ${index}\n\t_ = value${seed}`).join("\n");
}

function fakeResolver(): SourceResolver {
  return {
    readFile: async (relPath: string, source: SourceSelector = { kind: "head" }) => ({
      path: relPath,
      source,
      commit: source.kind,
      content: "",
      contentSha: `${source.kind}:${relPath}`
    })
  } as unknown as SourceResolver;
}

function fakeRegistry(): LanguageAdapterRegistry {
  const adapter: LanguageAdapter = {
    id: "fake",
    extensions: [],
    init: async () => undefined,
    parse: async (input) => ({
      path: input.path,
      language: input.language,
      adapterId: "fake",
      source: input.source,
      content: input.content,
      hasErrors: false,
      ...(input.contentSha !== undefined ? { contentSha: input.contentSha } : {})
    }),
    listSymbols: () => [],
    getEnclosingSymbol: (file: ParsedFile, line: number) => ({
      path: file.path,
      name: `Exported${line - 1}`,
      kind: "function",
      nativeKind: "function",
      lineRange: [line, line],
      exported: true,
      signature: `func Exported${line - 1}()`
    }),
    getImports: () => [],
    getChangedSymbols: () => []
  };
  return {
    forPath: () => adapter,
    languageForPath: () => "go"
  } as unknown as LanguageAdapterRegistry;
}

function recordingTelemetry(): TelemetryRecorder & { events: TelemetryEvent[]; toolCalls: ToolCallRecord[] } {
  const events: TelemetryEvent[] = [];
  const toolCalls: ToolCallRecord[] = [];
  return {
    runId: "repo-intel-test",
    runDir: undefined,
    events,
    toolCalls,
    event: (event) => {
      events.push({
        ...event,
        runId: "repo-intel-test",
        eventId: `ev-${events.length}`,
        timestamp: new Date(0).toISOString()
      });
    },
    recordModelCall: (_record: Omit<LlmCallRecord, "runId">) => undefined,
    recordToolCall: (record) => {
      const id = `tc-${toolCalls.length}`;
      toolCalls.push({
        ...record,
        toolCallId: id,
        runId: "repo-intel-test",
        timestamp: new Date(0).toISOString()
      });
      return id;
    },
    writeArtifact: async () => undefined,
    writeDebug: async () => undefined,
    flush: async () => undefined
  };
}
