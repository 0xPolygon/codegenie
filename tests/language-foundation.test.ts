import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { detectLanguage } from "../src/git/detectors.js";
import { parseDiff } from "../src/git/diff-parser.js";
import { classifyChangedFiles, filterDiffFiles } from "../src/git/file-classifier.js";
import { resolveReviewInput } from "../src/git/review-input-resolver.js";
import { defaultFakeLenses } from "../src/llm/fake-runner.js";
import { buildReviewPackets } from "../src/pipeline/packet-builder.js";
import { buildPlannerDossier, defaultPlan } from "../src/pipeline/planner.js";
import {
  changedSymbolsFromEnclosing,
  LanguageAdapterRegistry
} from "../src/repo/language-adapter.js";
import { candidateTestPaths, findLikelyTestsForInput } from "../src/repo/likely-tests.js";
import { buildRepositoryIndex } from "../src/repo/repository-index.js";
import type { SourceResolver } from "../src/repo/source-resolver.js";
import {
  GRAMMAR_IDS,
  TreeSitterService
} from "../src/repo/tree-sitter/tree-sitter-service.js";
import type {
  DiffHunk,
  ParsedFile,
  SourceSelector,
  SymbolInfo,
  TelemetryEvent
} from "../src/types.js";
import type { LensDescriptor } from "../src/skills/lens-registry.js";
import { commitAll, git, initRepo, nullTelemetry, writeRepoFile } from "./helpers/git.js";

const MINIMAL_SOURCE = {
  go: "package fixture\n\nfunc Value() int { return 1 }\n",
  typescript: "export function value(): number { return 1 }\n",
  tsx: "export function View() { return <div /> }\n",
  javascript: "export function value() { return 1 }\n",
  rust: "pub fn value() -> i32 { 1 }\n",
  python: "def value():\n    return 1\n",
  solidity: "pragma solidity ^0.8.20; contract Value { function value() external pure returns (uint256) { return 1; } }\n"
} as const;

describe("Plan 98 shared language foundation", () => {
  it("loads every registered grammar from the installed dependency layout", async () => {
    const service = new TreeSitterService();

    for (const grammarId of GRAMMAR_IDS) {
      const parsed = await service.parse({
        path: `fixture.${grammarId}`,
        language: grammarId,
        content: MINIMAL_SOURCE[grammarId],
        source: { kind: "head" },
        contentSha: `grammar:${grammarId}`
      });

      expect(parsed, grammarId).toMatchObject({
        language: grammarId,
        adapterId: grammarId,
        hasErrors: false
      });
      expect(parsed.tree, grammarId).toBeDefined();
    }
  });

  it("pins partial and unavailable parser lifecycle outcomes", async () => {
    const syntaxError = await new TreeSitterService().parse({
      path: "broken.rs",
      language: "rust",
      content: "fn broken(",
      source: { kind: "head" }
    });
    expect(syntaxError.tree).toBeDefined();
    expect(syntaxError).toMatchObject({ adapterId: "rust", hasErrors: true });

    const events: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">> = [];
    let loadCalls = 0;
    const unavailable = new TreeSitterService({
      telemetry: { ...nullTelemetry(), event: (event) => events.push(event) },
      initialize: async () => undefined,
      resolveGrammarWasm: () => "missing.wasm",
      loadLanguage: async () => {
        loadCalls += 1;
        throw new Error("ABI mismatch");
      }
    });
    for (const contentSha of ["first", "second"]) {
      const parsed = await unavailable.parse({
        path: "lib.rs",
        language: "rust",
        content: "fn value() {}",
        contentSha,
        source: { kind: "head" }
      });
      expect(parsed).toMatchObject({ adapterId: "rust", hasErrors: true });
      expect(parsed.tree).toBeUndefined();
    }
    expect(loadCalls).toBe(1);
    expect(events.filter((event) => event.message === "parser_unavailable")).toHaveLength(1);
  });

  it("pins parser throw, timeout, null-tree, and size-cap degradation", async () => {
    const fakeLanguage = {} as never;
    const fakeTree = () => ({ rootNode: { hasError: false }, delete: () => undefined }) as never;
    const serviceFor = (parse: (progressCallback: () => boolean) => unknown, extra: Record<string, unknown> = {}) =>
      new TreeSitterService({
        initialize: async () => undefined,
        resolveGrammarWasm: () => "fixture.wasm",
        loadLanguage: async () => fakeLanguage,
        createParser: () => ({
          setLanguage: () => undefined,
          parse: (_content, _oldTree, options) => parse(options.progressCallback) as never,
          delete: () => undefined
        }),
        ...extra
      });
    const input = { path: "lib.rs", language: "rust", content: "fn value() {}", source: { kind: "head" } as const };

    for (const service of [
      serviceFor(() => { throw new Error("parser threw"); }),
      serviceFor(() => null),
      serviceFor((progress) => { progress(); return fakeTree(); }, {
        now: (() => { const values = [0, 2]; return () => values.shift() ?? 2; })(),
        parseTimeoutMs: 1
      }),
      serviceFor(() => fakeTree(), { maxParseBytes: 1 })
    ]) {
      const parsed = await service.parse(input);
      expect(parsed).toMatchObject({ adapterId: "rust", hasErrors: true });
      expect(parsed.tree).toBeUndefined();
    }
  });

  it("carries canonical identity through diff facts, adapters, outlines, packets, and lenses", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "Cargo.toml", "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\n");
    writeRepoFile(repo, "pyproject.toml", "[project]\nname = \"fixture\"\nversion = \"0.1.0\"\n");
    writeRepoFile(repo, "foundry.toml", "[profile.default]\nsrc = \"src\"\n");
    writeRepoFile(repo, "src/lib.rs", "pub fn value() -> i32 { 1 }\n");
    writeRepoFile(repo, "src/value.py", "def value():\n    return 1\n");
    writeRepoFile(repo, "src/Value.sol", "pragma solidity ^0.8.20; contract Value { function value() external pure returns (uint256) { return 1; } }\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "src/lib.rs", "pub fn value() -> i32 { 2 }\n");
    writeRepoFile(repo, "src/value.py", "def value():\n    return 2\n");
    writeRepoFile(repo, "src/Value.sol", "pragma solidity ^0.8.20; contract Value { function value() external pure returns (uint256) { return 2; } }\n");
    commitAll(repo, "feature");

    const resolved = await resolveReviewInput({ mode: "branch", branchName: "feature" }, defaultConfig, nullTelemetry(), { repoRoot: repo });
    const diff = parseDiff(resolved.rawDiff);
    const { kept, decisions } = await filterDiffFiles(resolved, diff, defaultConfig, nullTelemetry());
    const facts = await classifyChangedFiles(resolved, kept, decisions, defaultConfig, nullTelemetry());
    const index = await buildRepositoryIndex(resolved, kept, facts, defaultConfig, nullTelemetry());
    const lenses = languageLenses();
    const dossier = await buildPlannerDossier(resolved, kept, facts, decisions, index, defaultConfig, nullTelemetry(), { lenses });
    const plan = defaultPlan(dossier, lenses, "shared language foundation");
    const packets = await buildReviewPackets(plan, kept, facts, index, nullTelemetry(), {
      config: defaultConfig,
      enabledLenses: lenses.map((lens) => lens.id)
    });
    const service = new TreeSitterService();
    const registry = new LanguageAdapterRegistry(service);

    for (const expected of [
      { path: "src/lib.rs", language: "rust", content: "pub fn value() -> i32 { 2 }\n" },
      { path: "src/value.py", language: "python", content: "def value():\n    return 2\n" },
      { path: "src/Value.sol", language: "solidity", content: "pragma solidity ^0.8.20; contract Value { function value() external pure returns (uint256) { return 2; } }\n" }
    ]) {
      expect(diff.files.find((file) => file.path === expected.path)?.language).toBe(expected.language);
      expect(facts.find((fact) => fact.path === expected.path)?.language).toBe(expected.language);
      expect(detectLanguage(expected.path).value).toBe(expected.language);
      expect(defaultFakeLenses(expected.path)).toContain(`lang/${expected.language}`);

      const adapter = registry.forPath(expected.path);
      const parsed = await adapter.parse({
        path: expected.path,
        language: registry.languageForPath(expected.path),
        content: expected.content,
        source: { kind: "head" }
      });
      expect(adapter.id).toBe(expected.language);
      expect(parsed).toMatchObject({ language: expected.language, adapterId: expected.language, hasErrors: false });
      expect(parsed.tree).toBeDefined();

      const outline = await index.tools.readFileOutline(expected.path);
      expect(outline.outline.language).toBe(expected.language);
      const packet = packets.find((entry) => entry.path === expected.path);
      expect(packet?.language).toBe(expected.language);
      expect(packet?.lenses).toContain(`lang/${expected.language}`);
    }

    const pyiDiff = parseDiff("diff --git a/types.pyi b/types.pyi\nnew file mode 100644\n--- /dev/null\n+++ b/types.pyi\n@@ -0,0 +1 @@\n+value: int\n");
    expect(pyiDiff.files[0]?.language).toBe("unknown");
    expect(detectLanguage("types.pyi").value).toBe("unknown");
    expect(registry.languageForPath("types.pyi")).toBe("unknown");
    expect(registry.forPath("types.pyi").id).toBe("generic");
  });

  it("generates only the accepted deterministic candidate paths", () => {
    expect(candidateTestPaths("crates/payments/src/lib.rs", [
      "crates/payments/Cargo.toml",
      "crates/payments/src/lib_test.rs",
      "crates/payments/tests/lib.rs",
      "crates/payments/tests/arbitrary.rs"
    ], "rust")).toEqual([
      "crates/payments/src/lib_test.rs",
      "crates/payments/tests/lib.rs"
    ]);
    expect(candidateTestPaths("pkg/service.py", [
      "pyproject.toml",
      "pkg/test_service.py",
      "pkg/service_test.py",
      "tests/test_service.py",
      "tests/service_test.py"
    ], "python")).toEqual([
      "pkg/service_test.py",
      "pkg/test_service.py",
      "tests/service_test.py",
      "tests/test_service.py"
    ]);
    expect(candidateTestPaths("contracts/Vault.sol", [
      "foundry.toml",
      "test/Vault.t.sol",
      "test/VaultTest.t.sol",
      "test/Unrelated.t.sol"
    ], "solidity")).toEqual([
      "test/Vault.t.sol",
      "test/VaultTest.t.sol"
    ]);
    expect(candidateTestPaths("src/foo.rb", [
      "src/foo.rb",
      "src/foo.test.ts",
      "src/foo_test.go",
      "tests/bar.rb",
      "tests/foo.rb"
    ], "ruby")).toEqual(["tests/foo.rb"]);
  });

  it("pins Rust test filenames and shared test-directory roles", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "README.md", "base\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "src/foo_test.rs", "fn helper() {}\n");
    writeRepoFile(repo, "tests/foo.rs", "fn integration() {}\n");
    writeRepoFile(repo, "src/foo.rs", "fn source() {}\n");
    commitAll(repo, "add Rust files");

    const resolved = await resolveReviewInput(
      { mode: "branch", branchName: "feature" },
      defaultConfig,
      nullTelemetry(),
      { repoRoot: repo }
    );
    const diff = parseDiff(resolved.rawDiff);
    const { kept, decisions } = await filterDiffFiles(resolved, diff, defaultConfig, nullTelemetry());
    const facts = await classifyChangedFiles(resolved, kept, decisions, defaultConfig, nullTelemetry());
    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/foo_test.rs", language: "rust", testStatus: "test" }),
      expect.objectContaining({ path: "tests/foo.rs", language: "rust", testStatus: "test" }),
      expect.objectContaining({ path: "src/foo.rs", language: "rust", testStatus: "source" })
    ]));
  });

  it("restores generic likely tests through the public tool and packet context", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "src/foo.rb", "def foo\n  1\nend\n");
    writeRepoFile(repo, "tests/foo.rb", "def test_foo\n  foo == 1\nend\n");
    writeRepoFile(repo, "src/foo.test.ts", "test('foo', () => {});\n");
    writeRepoFile(repo, "src/foo_test.go", "package src\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "src/foo.rb", "def foo\n  2\nend\n");
    commitAll(repo, "change foo");

    const telemetry = nullTelemetry();
    const resolved = await resolveReviewInput(
      { mode: "branch", branchName: "feature" },
      defaultConfig,
      telemetry,
      { repoRoot: repo }
    );
    const diff = parseDiff(resolved.rawDiff);
    const { kept, decisions } = await filterDiffFiles(resolved, diff, defaultConfig, telemetry);
    const facts = await classifyChangedFiles(resolved, kept, decisions, defaultConfig, telemetry);
    const index = await buildRepositoryIndex(resolved, kept, facts, defaultConfig, telemetry);
    const lenses = languageLenses();
    const dossier = await buildPlannerDossier(
      resolved,
      kept,
      facts,
      decisions,
      index,
      defaultConfig,
      telemetry,
      { lenses }
    );
    const packets = await buildReviewPackets(
      defaultPlan(dossier, lenses, "generic likely-test compatibility"),
      kept,
      facts,
      index,
      telemetry,
      { config: defaultConfig, enabledLenses: lenses.map((lens) => lens.id) }
    );

    expect(facts).toEqual([expect.objectContaining({ path: "src/foo.rb", language: "ruby", testStatus: "source" })]);
    const expectedTest = expect.objectContaining({
      path: "tests/foo.rb",
      name: "tests/foo.rb",
      kind: "other",
      nativeKind: "test file",
      lineRange: [1, 1]
    });
    const publicTests = await index.tools.findLikelyTests({ path: "src/foo.rb" });
    expect(publicTests.tests).toEqual([expectedTest]);
    expect(publicTests.meta).toMatchObject({ backend: "text", precision: "heuristic", degraded: false });
    expect(packets).toHaveLength(1);
    expect(packets[0]?.relevantTests).toEqual([expectedTest]);
    expect(packets[0]?.contextText).toContain("tests/foo.rb");
  });

  it("uses one parsed test-symbol contract for all three candidate conventions", async () => {
    const allPaths = [
      "Cargo.toml",
      "src/lib.rs",
      "src/lib_test.rs",
      "tests/lib.rs",
      "pyproject.toml",
      "pkg/service.py",
      "pkg/test_service.py",
      "pkg/service_test.py",
      "tests/test_service.py",
      "tests/service_test.py",
      "foundry.toml",
      "contracts/Vault.sol",
      "test/Vault.t.sol",
      "test/VaultTest.t.sol"
    ];
    const observedSources: string[] = [];
    const resolver = {
      repoRoot: "/repo",
      listFiles: async (_glob: string | undefined, source: { kind: string } = { kind: "head" }) => {
        observedSources.push(source.kind);
        return allPaths;
      },
      readFile: async (filePath: string, source: { kind: "head" | "base" }) => {
        observedSources.push(source.kind);
        return {
          path: filePath,
          source,
          commit: source.kind,
          content: "value\n",
          contentSha: `${source.kind}:${filePath}`
        };
      }
    } as unknown as SourceResolver;
    const adapter = {
      id: "fixture",
      extensions: [],
      init: async () => undefined,
      parse: async (input: { path: string; language: string; content: string; source: { kind: "head" | "base" }; contentSha?: string }) => ({
        ...input,
        adapterId: input.language,
        tree: {},
        hasErrors: false
      }),
      listSymbols: (parsed: ParsedFile) => {
        const test = {
          path: parsed.path,
          name: `test:${parsed.path}`,
          kind: "function" as const,
          nativeKind: "test case",
          lineRange: [1, 1] as [number, number]
        };
        return [test, test, { ...test, name: "helper", nativeKind: "helper" }];
      },
      getEnclosingSymbol: () => undefined,
      getImports: () => [],
      getChangedSymbols: () => []
    };
    const registry = {
      languageForPath: (filePath: string) => detectLanguage(filePath).value,
      forPath: () => adapter
    } as unknown as LanguageAdapterRegistry;

    for (const [subject, expectedPaths] of [
      ["src/lib.rs", ["src/lib_test.rs", "tests/lib.rs"]],
      ["pkg/service.py", ["pkg/service_test.py", "pkg/test_service.py", "tests/service_test.py", "tests/test_service.py"]],
      ["contracts/Vault.sol", ["test/Vault.t.sol", "test/VaultTest.t.sol"]]
    ] as Array<[string, string[]]>) {
      const result = await findLikelyTestsForInput(resolver, registry, {
        symbol: { path: subject, name: "value", kind: "function", lineRange: [1, 1] },
        source: { kind: "base" }
      });
      expect(result.backend).toBe("tree-sitter");
      expect(result.tests.map((test) => test.path)).toEqual(expectedPaths);
      expect(result.tests.every((test) => test.nativeKind === "test case")).toBe(true);

      const pathOnly = await findLikelyTestsForInput(resolver, registry, {
        path: subject,
        source: { kind: "base" }
      });
      expect(pathOnly.backend).toBe("tree-sitter");
      expect(pathOnly.tests.map((test) => test.path)).toEqual(expectedPaths);
    }
    expect(observedSources.every((source) => source === "base")).toBe(true);
  });

  it("uses text fallback for unavailable new-language candidate parsers", async () => {
    const paths = [
      "pyproject.toml",
      "pkg/service.py",
      "pkg/test_service.py",
      "pkg/service_test.py",
      "tests/test_service.py",
      "tests/service_test.py"
    ];
    const resolver = memoryResolver(paths);
    const unavailableAdapter = {
      id: "python",
      extensions: [".py"],
      init: async () => undefined,
      parse: async (input: { path: string; language: string; content: string; source: { kind: "head" | "base" } }) => ({
        ...input,
        adapterId: "python",
        hasErrors: true
      }),
      listSymbols: () => [],
      getEnclosingSymbol: () => undefined,
      getImports: () => [],
      getChangedSymbols: () => []
    };
    const registry = fixtureRegistry(unavailableAdapter);

    const result = await findLikelyTestsForInput(resolver, registry, { path: "pkg/service.py" });

    expect(result.backend).toBe("text");
    expect(result.tests).toEqual([
      expect.objectContaining({ path: "pkg/service_test.py", nativeKind: "test file" }),
      expect.objectContaining({ path: "pkg/test_service.py", nativeKind: "test file" }),
      expect.objectContaining({ path: "tests/service_test.py", nativeKind: "test file" }),
      expect.objectContaining({ path: "tests/test_service.py", nativeKind: "test file" })
    ]);
  });

  it("deduplicates recognized test symbols before applying the shared result cap", async () => {
    const paths = [
      "pyproject.toml",
      "pkg/service.py",
      "pkg/test_service.py",
      "pkg/service_test.py",
      "tests/test_service.py",
      "tests/service_test.py"
    ];
    const resolver = memoryResolver(paths);
    const parsedAdapter = {
      id: "python",
      extensions: [".py"],
      init: async () => undefined,
      parse: async (input: { path: string; language: string; content: string; source: { kind: "head" | "base" } }) => ({
        ...input,
        adapterId: "python",
        tree: {},
        hasErrors: false
      }),
      listSymbols: (parsed: ParsedFile) => Array.from({ length: 6 }, (_value, index) => ({
        path: parsed.path,
        name: `test_${String(index)}`,
        kind: "function" as const,
        nativeKind: "test case",
        lineRange: [index + 1, index + 1] as [number, number]
      })).flatMap((test) => [test, test]),
      getEnclosingSymbol: () => undefined,
      getImports: () => [],
      getChangedSymbols: () => []
    };
    const registry = fixtureRegistry(parsedAdapter);

    const result = await findLikelyTestsForInput(resolver, registry, { path: "pkg/service.py" });

    expect(result.tests).toHaveLength(20);
    expect(result.truncated).toBe(true);
    expect(result.omittedCount).toBe(4);
    expect(new Set(result.tests.map((test) => `${test.path}:${test.name}`)).size).toBe(20);
  });

  it("supports declaration identity callbacks while preserving the qualified-name default", () => {
    const file: ParsedFile = {
      path: "contracts/Vault.sol",
      language: "solidity",
      adapterId: "solidity",
      source: { kind: "head" },
      content: "",
      hasErrors: false
    };
    const first = symbol("deposit", [1, 4], "Vault");
    const second = symbol("deposit", [7, 10], "Vault");
    const hunk: DiffHunk = {
      id: "h1",
      path: file.path,
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: 10,
      header: "",
      lines: [2, 3, 8].map((line) => ({ kind: "add" as const, content: "+", newLineNumber: line }))
    };
    const enclosing = (line: number) => line < 7 ? first : second;

    expect(changedSymbolsFromEnclosing(file, hunk, enclosing, "new")).toEqual([
      expect.objectContaining({ name: "deposit", changedLines: [2, 3, 8] })
    ]);
    expect(changedSymbolsFromEnclosing(
      file,
      hunk,
      enclosing,
      "new",
      (entry) => `${entry.path}:${entry.kind}:${entry.ownerType}:${entry.name}:${entry.lineRange.join("-")}:${entry.signature ?? ""}`
    )).toEqual([
      expect.objectContaining({ lineRange: [1, 4], changedLines: [2, 3] }),
      expect.objectContaining({ lineRange: [7, 10], changedLines: [8] })
    ]);
  });
});

function languageLenses(): LensDescriptor[] {
  const lens = (id: string, languages: string[]): LensDescriptor => ({
    id,
    title: id,
    description: id,
    skillIds: [],
    enabledByDefault: true,
    enabled: true,
    languages
  });
  return [
    lens("core/code-review", []),
    lens("core/tests", []),
    lens("lang/rust", ["rust"]),
    lens("lang/python", ["python"]),
    lens("lang/solidity", ["solidity"])
  ];
}

function symbol(name: string, lineRange: [number, number], ownerType: string): SymbolInfo {
  return {
    path: "contracts/Vault.sol",
    name,
    kind: "method",
    nativeKind: "function",
    ownerType,
    lineRange,
    signature: `function ${name}()`
  };
}

function memoryResolver(paths: string[]): SourceResolver {
  return {
    repoRoot: "/repo",
    listFiles: async () => paths,
    readFile: async (filePath: string, source: SourceSelector = { kind: "head" }) => ({
      path: filePath,
      source,
      commit: source.kind,
      content: "value\n",
      contentSha: `${source.kind}:${filePath}`
    })
  } as unknown as SourceResolver;
}

function fixtureRegistry(adapter: object): LanguageAdapterRegistry {
  return {
    languageForPath: (filePath: string) => detectLanguage(filePath).value,
    forPath: () => adapter
  } as unknown as LanguageAdapterRegistry;
}
