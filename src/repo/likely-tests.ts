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
  const candidates = candidateTestPaths(containedSubjectPath, allPaths);
  const tests: SymbolRef[] = [];
  let parsedAny = false;
  let omittedCount = 0;

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
    const remaining = Math.max(0, MAX_TESTS - tests.length);
    tests.push(...discovered.slice(0, remaining));
    omittedCount += Math.max(0, discovered.length - remaining);
  }

  return {
    tests,
    backend: parsedAny ? "tree-sitter" : "text",
    ...(omittedCount > 0 ? { truncated: true, omittedCount } : {})
  };
}

function candidateTestPaths(subjectPath: string, allPaths: string[]): string[] {
  const dir = path.posix.dirname(subjectPath);
  const prefix = dir === "." ? "" : `${dir}/`;
  const stem = fileStem(subjectPath);
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
  const candidates = new Set<string>();
  for (const filePath of allPaths) {
    if (filePath === sameDirGo || tsNames.has(filePath)) {
      candidates.add(filePath);
      continue;
    }
    if (/(?:^|\/)(?:__tests__|tests?|test)\//u.test(filePath) && fileStem(filePath) === stem) {
      candidates.add(filePath);
    }
  }
  return [...candidates].sort();
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
