import path from "node:path";
import type { SourceSelector, SymbolInfo, SymbolRef, ToolBackend } from "../types.js";
import type { SourceResolver } from "./source-resolver.js";
import type { LanguageAdapterRegistry } from "./language-adapter.js";
import { fileStem } from "./language-adapter.js";
import { containPath } from "./path-guard.js";
import { escapeRegExp } from "../util/regex.js";

const MAX_TESTS = 20;

export async function findLikelyTestsForInput(
  resolver: SourceResolver,
  registry: LanguageAdapterRegistry,
  input: { path?: string; symbol?: SymbolRef; source?: SourceSelector }
): Promise<{ tests: SymbolRef[]; backend: ToolBackend; truncated?: boolean; omittedCount?: number }> {
  const source = input.source ?? { kind: "head" };
  const subjectPath = input.symbol?.path ?? input.path;
  if (subjectPath === undefined) {
    return { tests: [], backend: "text" };
  }
  const containedSubjectPath = containPath(resolver.repoRoot, subjectPath);
  const allPaths = await resolver.listFiles(undefined, source);
  const language = registry.languageForPath(containedSubjectPath);
  const candidates = candidateTestPaths(containedSubjectPath, allPaths, language);
  const discoveredTests: SymbolRef[] = [];
  let parsedAny = false;

  for (const candidate of candidates) {
    const content = await resolver.readFile(candidate, source);
    if (!content) {
      continue;
    }
    if (input.symbol !== undefined && !wordMention(content.content, input.symbol.name)) {
      continue;
    }
    const adapter = registry.forPath(candidate);
    const parsed = await adapter.parse({
      path: candidate,
      language: registry.languageForPath(candidate),
      content: content.content,
      source,
      contentSha: content.contentSha
    });
    const symbols = adapter
      .listSymbols(parsed)
      .filter((symbol) => isTestSymbol(candidate, symbol))
      .filter((symbol) => input.symbol === undefined || wordMention(sourceText(content.content, symbol.lineRange), input.symbol.name));
    const parsedOk = parsed.tree !== undefined;
    parsedAny = parsedAny || parsedOk;
    const discovered: SymbolRef[] =
      symbols.length > 0
        ? symbols
        : !parsedOk
          ? [
              {
                path: candidate,
                name: candidate,
                kind: "other",
                nativeKind: "test file",
                lineRange: [1, 1]
              }
            ]
          : [];
    discoveredTests.push(...discovered);
  }

  const uniqueTests = dedupeAndSortTests(discoveredTests);
  const tests = uniqueTests.slice(0, MAX_TESTS);
  const omittedCount = Math.max(0, uniqueTests.length - tests.length);

  return {
    tests,
    backend: parsedAny ? "tree-sitter" : "text",
    ...(omittedCount > 0 ? { truncated: true, omittedCount } : {})
  };
}

export function candidateTestPaths(subjectPath: string, allPaths: string[], language: string): string[] {
  const dir = path.posix.dirname(subjectPath);
  const prefix = dir === "." ? "" : `${dir}/`;
  const stem = fileStem(subjectPath);
  const allPathSet = new Set(allPaths);
  const candidates = new Set<string>();

  if (language === "rust") {
    candidates.add(`${prefix}${stem}_test.rs`);
    const packageRoot = nearestPackageRoot(subjectPath, allPathSet, ["Cargo.toml"]);
    if (packageRoot !== undefined) {
      candidates.add(joinRoot(packageRoot, `tests/${stem}.rs`));
    }
    return presentSorted(candidates, allPathSet);
  }

  if (language === "python") {
    candidates.add(`${prefix}test_${stem}.py`);
    candidates.add(`${prefix}${stem}_test.py`);
    const packageRoot = nearestPackageRoot(subjectPath, allPathSet, ["pyproject.toml", "setup.py", "setup.cfg"]) ?? ".";
    candidates.add(joinRoot(packageRoot, `tests/test_${stem}.py`));
    candidates.add(joinRoot(packageRoot, `tests/${stem}_test.py`));
    return presentSorted(candidates, allPathSet);
  }

  if (language === "solidity") {
    const packageRoot = nearestPackageRoot(subjectPath, allPathSet, ["foundry.toml"]) ?? ".";
    candidates.add(joinRoot(packageRoot, `test/${stem}.t.sol`));
    candidates.add(joinRoot(packageRoot, `test/${stem}Test.t.sol`));
    return presentSorted(candidates, allPathSet);
  }

  const sameDirGo = `${prefix}${stem}_test.go`;
  const tsNames = new Set([
    `${prefix}${stem}.test.ts`,
    `${prefix}${stem}.spec.ts`,
    `${prefix}${stem}.test.mts`,
    `${prefix}${stem}.spec.mts`,
    `${prefix}${stem}.test.cts`,
    `${prefix}${stem}.spec.cts`,
    `${prefix}${stem}.test.tsx`,
    `${prefix}${stem}.spec.tsx`,
    `${prefix}${stem}.test.js`,
    `${prefix}${stem}.spec.js`,
    `${prefix}${stem}.test.mjs`,
    `${prefix}${stem}.spec.mjs`,
    `${prefix}${stem}.test.cjs`,
    `${prefix}${stem}.spec.cjs`,
    `${prefix}${stem}.test.jsx`,
    `${prefix}${stem}.spec.jsx`,
    `${prefix}__tests__/${stem}.ts`,
    `${prefix}__tests__/${stem}.mts`,
    `${prefix}__tests__/${stem}.cts`,
    `${prefix}__tests__/${stem}.tsx`,
    `${prefix}__tests__/${stem}.js`,
    `${prefix}__tests__/${stem}.mjs`,
    `${prefix}__tests__/${stem}.cjs`,
    `${prefix}__tests__/${stem}.jsx`,
    `test/${stem}.test.ts`,
    `test/${stem}.spec.ts`,
    `tests/${stem}.test.ts`,
    `tests/${stem}.spec.ts`
  ]);
  for (const filePath of allPaths) {
    if ((language === "go" && filePath === sameDirGo) ||
        ((language === "typescript" || language === "tsx" || language === "javascript") && tsNames.has(filePath))) {
      candidates.add(filePath);
      continue;
    }
    if ((language === "go" || language === "typescript" || language === "tsx" || language === "javascript") &&
        /(?:^|\/)(?:__tests__|tests?|test)\//u.test(filePath) && fileStem(filePath) === stem) {
      candidates.add(filePath);
    }
  }
  return [...candidates].sort();
}

function nearestPackageRoot(subjectPath: string, allPaths: Set<string>, markers: string[]): string | undefined {
  let current = path.posix.dirname(subjectPath);
  if (current === ".") {
    current = "";
  }
  for (;;) {
    if (markers.some((marker) => allPaths.has(current.length === 0 ? marker : `${current}/${marker}`))) {
      return current.length === 0 ? "." : current;
    }
    if (current.length === 0) {
      return undefined;
    }
    const parent = path.posix.dirname(current);
    current = parent === "." ? "" : parent;
  }
}

function joinRoot(root: string, child: string): string {
  return root === "." ? child : `${root}/${child}`;
}

function presentSorted(candidates: Set<string>, allPaths: Set<string>): string[] {
  return [...candidates].filter((candidate) => allPaths.has(candidate)).sort();
}

function dedupeAndSortTests(tests: SymbolRef[]): SymbolRef[] {
  const byIdentity = new Map<string, SymbolRef>();
  for (const test of tests) {
    const identity = `${test.path}\0${test.kind}\0${test.nativeKind ?? ""}\0${test.name}\0${test.lineRange[0]}\0${test.lineRange[1]}`;
    byIdentity.set(identity, test);
  }
  return [...byIdentity.values()].sort((a, b) =>
    compareStrings(a.path, b.path) ||
    a.lineRange[0] - b.lineRange[0] ||
    a.lineRange[1] - b.lineRange[1] ||
    compareStrings(a.name, b.name)
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isTestSymbol(filePath: string, symbol: SymbolInfo): boolean {
  if (filePath.endsWith("_test.go")) {
    return /^(?:Test|Benchmark|Fuzz|Example)/u.test(symbol.name);
  }
  return symbol.nativeKind === "test case";
}

function wordMention(content: string, word: string): boolean {
  return new RegExp(`\\b${escapeRegExp(word)}\\b`, "u").test(content);
}

function sourceText(content: string, range: [number, number]): string {
  return content
    .split(/\n/u)
    .slice(range[0] - 1, range[1])
    .join("\n");
}
