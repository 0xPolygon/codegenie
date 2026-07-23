import type {
  DiffFile,
  DiffHunk,
  FileOutline,
  HunkSymbolFacts,
  PacketContext,
  ParsedFile,
  SourceSelector,
  SymbolInfo
} from "../types.js";
import type { SourceResolver } from "./source-resolver.js";
import type { LanguageAdapterRegistry } from "./language-adapter.js";
import { importLikeScan } from "./language-adapter.js";
import { findLikelyTestsForInput } from "./likely-tests.js";
import { isRepositoryTestPath } from "../util/path-roles.js";

const MAX_TOP_LEVEL_SYMBOLS = 120;
const MAX_TEST_SYMBOLS = 40;
const MAX_IMPORTS = 60;
const MAX_OUTLINE_CHARS = 8_000;

export async function readOutline(
  resolver: SourceResolver,
  registry: LanguageAdapterRegistry,
  filePath: string,
  source: SourceSelector = { kind: "head" }
): Promise<{
  outline: FileOutline;
  parsed?: ParsedFile;
  degraded: boolean;
  degradationReason?: string;
  truncated?: boolean;
  omittedCount?: number;
}> {
  const content = await resolver.readFile(filePath, source);
  if (!content) {
    const fallback = fallbackOutline(filePath, registry.languageForPath(filePath), "", "file missing at selected revision");
    const capped = capOutlineTotal(fallback.outline, fallback.omittedCount);
    return {
      outline: capped.outline,
      degraded: true,
      degradationReason: "file missing at selected revision",
      ...(capped.omittedCount > 0 ? { truncated: true, omittedCount: capped.omittedCount } : {})
    };
  }
  const adapter = registry.forPath(filePath);
  const parsed = await adapter.parse({
    path: filePath,
    language: registry.languageForPath(filePath),
    content: content.content,
    source,
    contentSha: content.contentSha
  });
  if (parsed.tree === undefined) {
    const fallback = fallbackOutline(filePath, registry.languageForPath(filePath), content.content, "tree-sitter unavailable; using text outline");
    const capped = capOutlineTotal(fallback.outline, fallback.omittedCount);
    return {
      outline: capped.outline,
      parsed,
      degraded: true,
      degradationReason: "tree-sitter unavailable; using text outline",
      ...(capped.omittedCount > 0 ? { truncated: true, omittedCount: capped.omittedCount } : {})
    };
  }
  const symbols = adapter.listSymbols(parsed);
  const imports = adapter.getImports(parsed);
  const testSymbolsAll = symbols.filter((symbol) => isTestSymbol(filePath, symbol));
  const packageName = symbols.find((symbol) => symbol.packageName !== undefined)?.packageName;
  const omittedCount =
    Math.max(0, imports.length - MAX_IMPORTS) +
    Math.max(0, symbols.length - MAX_TOP_LEVEL_SYMBOLS) +
    Math.max(0, testSymbolsAll.length - MAX_TEST_SYMBOLS);
  const capped = capOutlineTotal(
    {
      path: filePath,
      language: registry.languageForPath(filePath),
      ...(packageName !== undefined ? { packageName } : {}),
      imports: imports.slice(0, MAX_IMPORTS),
      topLevelSymbols: symbols.slice(0, MAX_TOP_LEVEL_SYMBOLS),
      testSymbols: testSymbolsAll.slice(0, MAX_TEST_SYMBOLS),
      notes: parsed.hasErrors ? ["parse contained error or missing nodes"] : []
    },
    omittedCount
  );
  return {
    outline: capped.outline,
    parsed,
    degraded: false,
    ...(capped.omittedCount > 0 ? { truncated: true, omittedCount: capped.omittedCount } : {})
  };
}

export async function assemblePacketContext(
  resolver: SourceResolver,
  registry: LanguageAdapterRegistry,
  file: DiffFile,
  hunks: DiffHunk[],
  symbolFacts: HunkSymbolFacts[]
): Promise<{
  context: PacketContext;
  outline?: FileOutline;
  relevantTests: SymbolInfo[];
  degradation?: string;
  primarySymbol?: SymbolInfo;
  packetSymbols?: SymbolInfo[];
  noSymbolHunkIds?: string[];
}> {
  const side = hunks.some((hunk) => hunk.lines.some((line) => line.kind === "add")) && file.status !== "deleted" ? "head" : "base";
  const source: SourceSelector = { kind: side };
  const readPath = side === "base" ? file.oldPath ?? file.path : file.path;
  const outlineResult = await readOutline(resolver, registry, readPath, source);
  const outline = { ...outlineResult.outline, path: file.path };
  const symbolSelections = rankedSymbolSelections(outline.topLevelSymbols, symbolFacts);
  const primarySymbol = symbolSelections[0]?.symbol;
  const packetSymbols = uniqueSymbols(symbolSelections.map((selection) => selection.symbol)).slice(0, 8);
  const noSymbolHunkIds = uniqueStrings(symbolFacts
    .filter((fact) => !isRealSymbolFact(fact))
    .map((fact) => fact.hunkId));
  const context: PacketContext = {
    path: file.path,
    ...(outline.packageName !== undefined ? { packageName: outline.packageName } : {})
  };
  if (primarySymbol?.kind === "function") {
    context.enclosingFunction = primarySymbol;
  } else if (primarySymbol?.kind === "method") {
    context.enclosingMethod = primarySymbol;
    const owner = enclosingOwnerType(outline.topLevelSymbols, primarySymbol);
    if (owner) {
      context.enclosingType = owner;
    }
  } else if (primarySymbol?.kind === "type" || primarySymbol?.kind === "interface") {
    context.enclosingType = primarySymbol;
  }

  const tests = await findLikelyTestsForInput(resolver, registry, {
    path: file.path,
    source,
    ...(primarySymbol !== undefined ? { symbol: primarySymbol } : {})
  });

  return {
    context,
    outline,
    relevantTests: tests.tests.slice(0, 5) as SymbolInfo[],
    ...(primarySymbol !== undefined ? { primarySymbol } : {}),
    ...(packetSymbols.length > 0 ? { packetSymbols } : {}),
    ...(noSymbolHunkIds.length > 0 ? { noSymbolHunkIds } : {}),
    ...(outlineResult.degraded ? { degradation: outlineResult.degradationReason ?? "packet context degraded" } : {})
  };
}

function enclosingOwnerType(symbols: SymbolInfo[], method: SymbolInfo): SymbolInfo | undefined {
  const matching = symbols.filter(
    (symbol) => symbol.name === method.ownerType && (symbol.kind === "type" || symbol.kind === "interface")
  );
  const containing = matching
    .filter((symbol) => containsRange(symbol.lineRange, method.lineRange))
    .sort((a, b) =>
      rangeSpan(a.lineRange) - rangeSpan(b.lineRange) ||
      a.lineRange[0] - b.lineRange[0] ||
      a.lineRange[1] - b.lineRange[1]
    );
  return containing[0] ?? matching[0];
}

function containsRange(outer: [number, number], inner: [number, number]): boolean {
  return outer[0] <= inner[0] && outer[1] >= inner[1];
}

function rangeSpan(range: [number, number]): number {
  return range[1] - range[0];
}

function fallbackOutline(filePath: string, language: string, content: string, note: string): { outline: FileOutline; omittedCount: number } {
  const imports = importLikeScan(content);
  const omittedCount = Math.max(0, imports.length - MAX_IMPORTS);
  return {
    outline: {
      path: filePath,
      language,
      imports: imports.slice(0, MAX_IMPORTS),
      topLevelSymbols: [],
      testSymbols: isRepositoryTestPath(filePath)
        ? [
            {
              path: filePath,
              name: filePath,
              kind: "other",
              nativeKind: "test file",
              lineRange: [1, 1]
            }
          ]
        : [],
      notes: [note]
    },
    omittedCount
  };
}

function capOutlineTotal(outline: FileOutline, existingOmittedCount: number): { outline: FileOutline; omittedCount: number } {
  const capped: FileOutline = {
    ...outline,
    imports: [...outline.imports],
    topLevelSymbols: outline.topLevelSymbols.map((symbol) => ({ ...symbol })),
    testSymbols: outline.testSymbols.map((symbol) => ({ ...symbol })),
    notes: [...outline.notes]
  };
  let omittedCount = existingOmittedCount;

  while (JSON.stringify(capped).length > MAX_OUTLINE_CHARS) {
    if (capped.topLevelSymbols.length > 0) {
      capped.topLevelSymbols.pop();
      omittedCount += 1;
    } else if (capped.testSymbols.length > 0) {
      capped.testSymbols.pop();
      omittedCount += 1;
    } else if (capped.imports.length > 0) {
      capped.imports.pop();
      omittedCount += 1;
    } else if (capped.notes.length > 0) {
      capped.notes.pop();
      omittedCount += 1;
    } else {
      break;
    }
  }

  return { outline: capped, omittedCount };
}

function findSymbolForFact(symbols: SymbolInfo[], fact: HunkSymbolFacts): SymbolInfo | undefined {
  if (fact.symbolRange !== undefined) {
    const byRange = symbols.find((symbol) => symbol.lineRange[0] === fact.symbolRange?.[0] && symbol.lineRange[1] === fact.symbolRange?.[1]);
    if (byRange) {
      return byRange;
    }
  }
  if (fact.enclosingSymbol !== undefined) {
    return symbols.find((symbol) => enclosingSymbolMatchesName(fact.enclosingSymbol, symbol.name));
  }
  return undefined;
}

function enclosingSymbolMatchesName(enclosingSymbol: string | undefined, symbolName: string): boolean {
  if (enclosingSymbol === undefined) {
    return false;
  }
  const enclosing = enclosingSymbol.trim();
  const name = symbolName.trim();
  if (!enclosing.endsWith(name)) {
    return false;
  }
  const boundaryIndex = enclosing.length - name.length - 1;
  return boundaryIndex < 0 || !/[A-Za-z0-9_$]/u.test(enclosing[boundaryIndex] ?? "");
}

type SymbolSelection = {
  symbol: SymbolInfo;
  fact: HunkSymbolFacts;
  score: number;
};

function rankedSymbolSelections(symbols: SymbolInfo[], facts: HunkSymbolFacts[]): SymbolSelection[] {
  const selections: SymbolSelection[] = [];
  for (const fact of facts) {
    if (!isRealSymbolFact(fact)) {
      continue;
    }
    const symbol = findSymbolForFact(symbols, fact) ?? fallbackSymbolForFact(fact);
    if (symbol === undefined) {
      continue;
    }
    selections.push({ symbol, fact, score: symbolFactScore(fact) });
  }
  return selections.sort((a, b) =>
    b.score - a.score ||
    (a.fact.changedLines[0] ?? a.fact.symbolRange?.[0] ?? Number.MAX_SAFE_INTEGER) -
      (b.fact.changedLines[0] ?? b.fact.symbolRange?.[0] ?? Number.MAX_SAFE_INTEGER) ||
    a.symbol.name.localeCompare(b.symbol.name)
  );
}

function isRealSymbolFact(fact: HunkSymbolFacts): boolean {
  return fact.enclosingSymbol !== undefined || fact.symbolRange !== undefined;
}

function symbolFactScore(fact: HunkSymbolFacts): number {
  const changedWeight = Math.max(1, fact.changedLines.length);
  const namedWeight = fact.enclosingSymbol !== undefined ? 100 : 0;
  const syntacticWeight = fact.confidence === "syntactic" ? 20 : 0;
  const sourceWeight = fact.source === "tree-sitter" ? 20 : 0;
  const kindWeight = fact.symbolKind !== undefined ? 10 : 0;
  return namedWeight + syntacticWeight + sourceWeight + kindWeight + changedWeight;
}

function fallbackSymbolForFact(fact: HunkSymbolFacts): SymbolInfo | undefined {
  if (fact.enclosingSymbol === undefined || fact.symbolRange === undefined) {
    return undefined;
  }
  const name = fact.enclosingSymbol.split(".").at(-1)?.replace(/^\(\*?|\)$/gu, "") || fact.enclosingSymbol;
  return {
    path: fact.path,
    name,
    kind: fact.symbolKind ?? "other",
    ...(fact.symbolNativeKind !== undefined ? { nativeKind: fact.symbolNativeKind } : {}),
    lineRange: fact.symbolRange,
    ...(fact.signature !== undefined ? { signature: fact.signature } : {})
  };
}

function uniqueSymbols(symbols: SymbolInfo[]): SymbolInfo[] {
  const seen = new Set<string>();
  const output: SymbolInfo[] = [];
  for (const symbol of symbols) {
    const key = `${symbol.path}:${symbol.name}:${symbol.lineRange.join("-")}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(symbol);
  }
  return output;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isTestSymbol(filePath: string, symbol: SymbolInfo): boolean {
  if (filePath.endsWith("_test.go")) {
    return /^(?:Test|Benchmark|Fuzz|Example)/u.test(symbol.name);
  }
  return symbol.nativeKind === "test case";
}
