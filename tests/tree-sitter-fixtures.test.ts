import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { parseDiff } from "../src/git/diff-parser.js";
import { buildRepositoryIndex } from "../src/repo/repository-index.js";
import { LanguageAdapterRegistry } from "../src/repo/language-adapter.js";
import { TreeSitterService } from "../src/repo/tree-sitter/tree-sitter-service.js";
import type { DiffFile, FileFacts, RepositoryToolsHost, TelemetryEvent, ToolCallRecord } from "../src/types.js";
import type { LlmCallRecord, TelemetryRecorder } from "../src/telemetry/telemetry-recorder.js";
import { commitAll, git, initRepo, writeRepoFile } from "./helpers/git.js";

describe("parser-derived fixture summaries", () => {
  it("derives Go summaries from fixture source without treating raw parser nodes as product output", async () => {
    const service = new TreeSitterService();
    const registry = new LanguageAdapterRegistry(service);
    const adapter = registry.forPath("httpbin_client.go");
    const parsed = await parseFixture(registry, "httpbin_client.go", fixture("go/httpbin_client.go"));
    const symbols = adapter.listSymbols(parsed);

    expect(service.routePath("httpbin_client.go")).toBe("go");
    expect(adapter.getImports(parsed)).toEqual(expect.arrayContaining(["context", "encoding/json", "io", "net/http", "net/url"]));
    expect(symbols.find((symbol) => symbol.name === "Doer")?.signature).toContain("Do(req *http.Request) (*http.Response, error)");
    expect(symbols.find((symbol) => symbol.name === "Client")?.signature).toContain("baseURL string");
    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Doer", kind: "interface", nativeKind: "interface", exported: true, packageName: "httpbin" }),
        expect.objectContaining({ name: "Client", kind: "type", nativeKind: "struct", exported: true, packageName: "httpbin" }),
        expect.objectContaining({ name: "NewClient", kind: "function", exported: true, packageName: "httpbin" }),
        expect.objectContaining({ name: "GetJSON", kind: "method", ownerType: "Client", exported: true, packageName: "httpbin" }),
        expect.objectContaining({ name: "Status", kind: "method", ownerType: "Client", exported: true, packageName: "httpbin" }),
        expect.objectContaining({
          name: "Version",
          kind: "method",
          ownerType: "Client",
          exported: true,
          signature: expect.stringContaining("func (*Client) Version() string")
        }),
        expect.objectContaining({ name: "newRequest", kind: "method", ownerType: "Client", exported: false, packageName: "httpbin" })
      ])
    );

    const testParsed = await parseFixture(registry, "httpbin_client_test.go", fixture("go/httpbin_client_test.go"));
    const testSymbols = registry.forPath("httpbin_client_test.go").listSymbols(testParsed);
    expect(testSymbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: "TestClientBuildsGetRequest", kind: "function" })]));
  });

  it("derives TypeScript summaries from fixture source without treating raw parser nodes as product output", async () => {
    const service = new TreeSitterService();
    const registry = new LanguageAdapterRegistry(service);
    const adapter = registry.forPath("src/httpbinClient.ts");
    const parsed = await parseFixture(registry, "src/httpbinClient.ts", fixture("ts/httpbinClient.ts"));
    const symbols = adapter.listSymbols(parsed);

    expect(service.routePath("src/httpbinClient.ts")).toBe("typescript");
    expect(service.routePath("src/httpbinClient.mts")).toBe("typescript");
    expect(service.routePath("src/httpbinClient.cjs")).toBe("javascript");
    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "HttpTransport",
          kind: "interface",
          exported: true,
          signature: expect.stringContaining("fetch(input: Request | URL | string, init?: RequestInit): Promise<Response>")
        }),
        expect.objectContaining({
          name: "RequestOptions",
          kind: "type",
          exported: true,
          signature: expect.stringContaining("onRetry?: (attempt: { count: number; status?: number }) => void")
        }),
        expect.objectContaining({
          name: "Decoder",
          kind: "type",
          exported: true,
          signature: expect.stringContaining("shape: { expectJson: boolean; endpoint: string }")
        }),
        expect.objectContaining({ name: "HttpBinClient", kind: "type", nativeKind: "class", exported: true }),
        expect.objectContaining({ name: "RetryClock", kind: "type", nativeKind: "class", exported: true }),
        expect.objectContaining({ name: "default", kind: "function", nativeKind: "arrow function", exported: true }),
        expect.objectContaining({ name: "status", ownerType: "HttpBinEndpoint", kind: "function", exported: true }),
        expect.objectContaining({ name: "anything", ownerType: "HttpBinEndpoint", kind: "function", exported: true }),
        expect.objectContaining({ name: "buildRequest", ownerType: "HttpBinClient", nativeKind: "method", exported: false }),
        expect.objectContaining({ name: "createHeaders", ownerType: "HttpBinClient", nativeKind: "method", exported: false }),
        expect.objectContaining({
          name: "decorateRequest",
          ownerType: "HttpBinClient",
          nativeKind: "class field function",
          exported: true,
          signature: "decorateRequest = (request: Request, metadata: { endpoint: string; attempt: number }) =>"
        })
      ])
    );
    expect(symbols).toEqual(expect.not.arrayContaining([expect.objectContaining({ name: "baseUrl", ownerType: "HttpBinClient" })]));
    expect(symbols).toEqual(expect.not.arrayContaining([expect.objectContaining({ name: "retryCount", ownerType: "HttpBinClient" })]));

    const testParsed = await parseFixture(registry, "src/httpbinClient.test.ts", fixture("ts/httpbinClient.test.fixture.ts"));
    expect(adapter.getImports(testParsed)).toEqual(expect.arrayContaining(["./httpbinClient.js"]));
    expect(adapter.listSymbols(testParsed)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "builds endpoint paths", nativeKind: "test case" }),
        expect.objectContaining({ name: "uses injected transport without network calls", nativeKind: "test case" })
      ])
    );
  });

  it("serves parser-derived summaries and source snippets through repository tools", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "httpbin_client.go", fixture("go/httpbin_client.go"));
    writeRepoFile(repo, "httpbin_client_test.go", fixture("go/httpbin_client_test.go"));
    writeRepoFile(repo, "src/httpbinClient.ts", fixture("ts/httpbinClient.ts"));
    writeRepoFile(repo, "src/httpbinClient.test.ts", fixture("ts/httpbinClient.test.fixture.ts"));
    const head = commitAll(repo, "fixtures");
    const { tools } = await buildIndexForRange(repo, head, head);

    const goOutline = await tools.readFileOutline("httpbin_client.go");
    expectNoAstPayload(goOutline);
    expect(goOutline.outline).toMatchObject({
      path: "httpbin_client.go",
      language: "go",
      packageName: "httpbin"
    });
    expect(goOutline.outline.topLevelSymbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Client", nativeKind: "struct" }),
        expect.objectContaining({ name: "GetJSON", ownerType: "Client", kind: "method" })
      ])
    );

    const goSymbol = await tools.readSymbol("httpbin_client.go", { symbolName: "(*Client).GetJSON" });
    expectNoAstPayload(goSymbol);
    expect(goSymbol.symbol).toMatchObject({ name: "GetJSON", ownerType: "Client", kind: "method" });
    expect(goSymbol.text).toContain("context.Context");

    const unnamedDefinition = await tools.findDefinition("(*Client).Version");
    expectNoAstPayload(unnamedDefinition);
    expect(unnamedDefinition.definitions[0]?.symbol).toMatchObject({ name: "Version", ownerType: "Client", kind: "method" });
    expect(unnamedDefinition.definitions[0]?.text).toContain("func (*Client) Version() string");

    const tsNamespaceSymbol = await tools.readSymbol("src/httpbinClient.ts", { symbolName: "HttpBinEndpoint.status" });
    expectNoAstPayload(tsNamespaceSymbol);
    expect(tsNamespaceSymbol.symbol).toMatchObject({ name: "status", ownerType: "HttpBinEndpoint", kind: "function", exported: true });

    const tsOutline = await tools.readFileOutline("src/httpbinClient.ts");
    expectNoAstPayload(tsOutline);
    expect(tsOutline.outline.topLevelSymbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "HttpBinClient", nativeKind: "class", exported: true }),
        expect.objectContaining({ name: "default", nativeKind: "arrow function", exported: true })
      ])
    );

    const mentions = await tools.findSymbolMentions("HttpBinClient", { pathGlob: "src/**/*.ts" });
    expectNoAstPayload(mentions);
    expect(mentions.results.map((result) => result.path)).toContain("src/httpbinClient.ts");

    const goTests = await tools.findLikelyTests({ path: "httpbin_client.go" });
    const tsTests = await tools.findLikelyTests({ path: "src/httpbinClient.ts" });
    expectNoAstPayload(goTests);
    expectNoAstPayload(tsTests);
    expect(goTests.tests.map((test) => test.path)).toContain("httpbin_client_test.go");
    expect(tsTests.tests.map((test) => test.path)).toContain("src/httpbinClient.test.ts");
  });

  it("builds packet context from fixture diffs as summaries and test references", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "httpbin_client.go", fixture("go/httpbin_client.go"));
    writeRepoFile(repo, "httpbin_client_test.go", fixture("go/httpbin_client_test.go"));
    const base = commitAll(repo, "fixtures");
    writeRepoFile(
      repo,
      "httpbin_client.go",
      fixture("go/httpbin_client.go").replace(
        'req, err := c.newRequest(ctx, http.MethodGet, "/get", query, nil)',
        'req, err := c.newRequest(ctx, http.MethodGet, "/get", query, nil)\n\treq.Header.Set("X-Fixture", "true")'
      )
    );
    const head = commitAll(repo, "change get request");
    const { diff, index, tools } = await buildIndexForRange(repo, base, head);
    const file = diff.files.find((item) => item.path === "httpbin_client.go");
    expect(file).toBeDefined();

    const packetContext = await tools.buildPacketContext(
      file!,
      file!.hunks,
      index.symbolFacts.filter((fact) => fact.path === "httpbin_client.go")
    );

    expectNoAstPayload(packetContext);
    expect(packetContext.context).toMatchObject({
      path: "httpbin_client.go",
      packageName: "httpbin",
      enclosingMethod: expect.objectContaining({ name: "GetJSON", ownerType: "Client" })
    });
    expect(packetContext.outline?.topLevelSymbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Client" })]));
    expect(packetContext.relevantTests.map((test) => test.path)).toContain("httpbin_client_test.go");
  });

  it("reports Go exported struct and interface shape changes as API changes", async () => {
    const repo = initRepo();
    writeRepoFile(
      repo,
      "api/doer.go",
      `package api

type Doer interface {
	Do(name string) error
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
    const base = commitAll(repo, "base");
    writeRepoFile(
      repo,
      "api/doer.go",
      `package api

type Doer interface {
	Do(name string, retry bool) error
}
`
    );
    writeRepoFile(
      repo,
      "api/client.go",
      `package api

type Client struct {
	Timeout int64
}
`
    );
    const head = commitAll(repo, "change go api shape");
    const { index } = await buildIndexForRange(repo, base, head);
    const apiSignals = index.staticSignals.filter((signal) => signal.ruleId === "core/exported-api-change");

    expect(apiSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "api/doer.go", snippet: expect.stringContaining("Do(name string, retry bool) error") }),
        expect.objectContaining({ path: "api/client.go", snippet: expect.stringContaining("Timeout int64") })
      ])
    );
  });

  it("reports TypeScript exported API changes when balanced type literal shapes change", async () => {
    const repo = initRepo();
    writeRepoFile(
      repo,
      "src/api.ts",
      `export function decode(input: { id: string; meta: { retry: boolean } }): { ok: boolean } {
  return { ok: input.meta.retry }
}

export type RequestShape = {
  id: string
  meta: { retry: boolean }
}
`
    );
    const base = commitAll(repo, "base");
    writeRepoFile(
      repo,
      "src/api.ts",
      `export function decode(input: { id: number; meta: { retry: boolean } }): { ok: boolean } {
  return { ok: input.meta.retry }
}

export type RequestShape = {
  id: number
  meta: { retry: boolean }
}
`
    );
    const head = commitAll(repo, "change api shape");
    const { index } = await buildIndexForRange(repo, base, head);
    const apiSignals = index.staticSignals.filter((signal) => signal.ruleId === "core/exported-api-change" && signal.path === "src/api.ts");

    expect(apiSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          snippet: expect.stringContaining("input: { id: number; meta: { retry: boolean } }")
        }),
        expect.objectContaining({
          snippet: expect.stringContaining("id: number")
        })
      ])
    );
  });

  it("marks public class members exported when the class is exported through an export clause", async () => {
    const service = new TreeSitterService();
    const registry = new LanguageAdapterRegistry(service);
    const symbols = registry
      .forPath("src/api.ts")
      .listSymbols(
        await parseFixture(
          registry,
          "src/api.ts",
          `class Api {
  run(value: string): string {
    return value
  }

  private secret(value: string): string {
    return value
  }
}

export { Api }
`
        )
      );

    expect(symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Api", exported: true }),
        expect.objectContaining({ name: "run", ownerType: "Api", exported: true }),
        expect.objectContaining({ name: "secret", ownerType: "Api", exported: false })
      ])
    );

    const repo = initRepo();
    writeRepoFile(
      repo,
      "src/api.ts",
      `class Api {
  run(value: string): string {
    return value
  }
}

export { Api }
`
    );
    const base = commitAll(repo, "base");
    writeRepoFile(
      repo,
      "src/api.ts",
      `class Api {
  run(value: number): number {
    return value
  }
}

export { Api }
`
    );
    const head = commitAll(repo, "change exported method");
    const { index } = await buildIndexForRange(repo, base, head);

    expect(index.staticSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "core/exported-api-change",
          path: "src/api.ts",
          snippet: expect.stringContaining("run(value: number): number")
        })
      ])
    );
  });

  it("searches tracked ignored files without traversing ignored untracked directories", async () => {
    const repo = initRepo();
    writeRepoFile(repo, ".ignore", "ignored*.txt\nignored-dir/\n");
    writeRepoFile(repo, "ignored-tracked.txt", "IgnoredTrackedFixtureNeedle\n");
    writeRepoFile(repo, "src/app.ts", "export const visible = 'VisibleFixtureNeedle'\n");
    git(repo, ["add", "-f", "ignored-tracked.txt"]);
    const head = commitAll(repo, "base");
    writeRepoFile(repo, "ignored-untracked.txt", "IgnoredDirtyFixtureNeedle\n");
    writeFixtureFile(repo, "ignored-dir/secret.txt", "IgnoredDirectoryFixtureNeedle\n");
    const { tools } = await buildIndexForRange(repo, head, head);

    expect((await tools.searchFiles("VisibleFixtureNeedle")).results.map((result) => result.path)).toContain("src/app.ts");
    expect((await tools.searchFiles("IgnoredTrackedFixtureNeedle")).results.map((result) => result.path)).toContain("ignored-tracked.txt");
    expect((await tools.searchFiles("IgnoredDirtyFixtureNeedle")).results).toEqual([]);
    expect((await tools.searchFiles("IgnoredDirectoryFixtureNeedle")).results).toEqual([]);
  });
});

function fixture(relPath: string): string {
  return readFileSync(path.join(process.cwd(), "tests", "fixtures", "tree-sitter", relPath), "utf8");
}

async function parseFixture(registry: LanguageAdapterRegistry, filePath: string, content: string) {
  const adapter = registry.forPath(filePath);
  return adapter.parse({
    path: filePath,
    language: registry.languageForPath(filePath),
    content,
    source: { kind: "head" },
    contentSha: `fixture:${filePath}`
  });
}

async function buildIndexForRange(
  repo: string,
  base: string,
  head: string
): Promise<{
  diff: ReturnType<typeof parseDiff>;
  index: Awaited<ReturnType<typeof buildRepositoryIndex>>;
  tools: RepositoryToolsHost;
  telemetry: TelemetryRecorder & { events: TelemetryEvent[]; toolCalls: ToolCallRecord[] };
}> {
  const telemetry = recordingTelemetry();
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
  return { diff, index, tools: index.tools as RepositoryToolsHost, telemetry };
}

function fileFacts(file: DiffFile): FileFacts {
  return {
    path: file.path,
    language: file.language,
    processingMode: "per-hunk",
    testStatus: file.path.endsWith("_test.go") || /\.(?:test|spec)\.[cm]?[tj]sx?$/u.test(file.path) ? "test" : "source",
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

function writeFixtureFile(repo: string, relPath: string, content: string): void {
  const fullPath = path.join(repo, relPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function expectNoAstPayload(value: unknown): void {
  expect(JSON.stringify(value)).not.toMatch(/"(?:tree|rootNode|node|children)"\s*:/u);
}

function recordingTelemetry(): TelemetryRecorder & { events: TelemetryEvent[]; toolCalls: ToolCallRecord[] } {
  const events: TelemetryEvent[] = [];
  const toolCalls: ToolCallRecord[] = [];
  return {
    runId: "tree-sitter-fixture-test",
    runDir: undefined,
    events,
    toolCalls,
    event: (event) => {
      events.push({
        ...event,
        runId: "tree-sitter-fixture-test",
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
        runId: "tree-sitter-fixture-test",
        timestamp: new Date(0).toISOString()
      });
      return id;
    },
    writeArtifact: async () => undefined,
    writeDebug: async () => undefined,
    flush: async () => undefined
  };
}
