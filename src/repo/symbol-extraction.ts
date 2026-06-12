import type { DiffFile, DiffHunk, FileFacts, HunkSymbolFacts, ParsedFile, SymbolInfo } from "../types.js";
import type { SourceResolver } from "./source-resolver.js";
import type { LanguageAdapterRegistry } from "./language-adapter.js";
import { changedLinesForHunk, getLine } from "./language-adapter.js";
import { renderGoSymbolName } from "./tree-sitter/go-adapter.js";

export async function extractChangedSymbolFacts(
  resolver: SourceResolver,
  registry: LanguageAdapterRegistry,
  kept: DiffFile[],
  facts: FileFacts[]
): Promise<HunkSymbolFacts[]> {
  const factByPath = new Map(facts.map((fact) => [fact.path, fact]));
  const output: HunkSymbolFacts[] = [];

  for (const file of kept) {
    const fact = factByPath.get(file.path);
    if (fact?.processingMode === "skip") {
      continue;
    }
    for (const hunk of file.hunks) {
      output.push(await extractHunkFacts(resolver, registry, file, hunk, hunkFactSide(file, hunk)));
    }
  }

  return output;
}

async function extractHunkFacts(
  resolver: SourceResolver,
  registry: LanguageAdapterRegistry,
  file: DiffFile,
  hunk: DiffHunk,
  side: "old" | "new"
): Promise<HunkSymbolFacts> {
  const source = side === "new" ? { kind: "head" as const } : { kind: "base" as const };
  const readPath = side === "old" ? file.oldPath ?? file.path : file.path;
  const changedLines = changedLinesForHunk(hunk, side);
  const content = await resolver.readFile(readPath, source);
  if (!content) {
    return fallbackFacts(file, hunk, side, changedLines, undefined);
  }

  const adapter = registry.forPath(file.path);
  const parsed = await adapter.parse({
    path: file.path,
    language: registry.languageForPath(file.path),
    content: content.content,
    source,
    contentSha: content.contentSha
  });
  const changedSymbols = parsed.tree === undefined ? [] : adapter.getChangedSymbols(parsed, hunk);
  const primary = choosePrimarySymbol(changedSymbols);
  if (!primary) {
    return fallbackFacts(file, hunk, side, changedLines, parsed);
  }
  return {
    path: file.path,
    hunkId: hunk.id,
    enclosingSymbol: renderSymbol(parsed, primary),
    symbolKind: primary.kind,
    ...(primary.nativeKind !== undefined ? { symbolNativeKind: primary.nativeKind } : {}),
    symbolRange: primary.lineRange,
    changedLines: primary.changedLines.length > 0 ? primary.changedLines : changedLines,
    changedLinesSide: side,
    ...(primary.signature !== undefined ? { signature: primary.signature } : {}),
    source: "tree-sitter",
    confidence: "syntactic"
  };
}

function hunkFactSide(file: DiffFile, hunk: DiffHunk): "old" | "new" {
  if (file.status === "deleted") {
    return "old";
  }
  if (file.status === "added") {
    return "new";
  }
  const hasAdds = hunk.lines.some((line) => line.kind === "add");
  return hasAdds ? "new" : "old";
}

function choosePrimarySymbol(symbols: Array<SymbolInfo & { changedLines: number[] }>): (SymbolInfo & { changedLines: number[] }) | undefined {
  return [...symbols].sort((a, b) => {
    const changed = b.changedLines.length - a.changedLines.length;
    if (changed !== 0) {
      return changed;
    }
    const spanA = a.lineRange[1] - a.lineRange[0];
    const spanB = b.lineRange[1] - b.lineRange[0];
    return spanA - spanB || a.lineRange[0] - b.lineRange[0];
  })[0];
}

function fallbackFacts(
  file: DiffFile,
  hunk: DiffHunk,
  side: "old" | "new",
  changedLines: number[],
  parsed: ParsedFile | undefined
): HunkSymbolFacts {
  const firstLine = changedLines[0] ?? (side === "new" ? hunk.newStart : hunk.oldStart);
  const content = parsed?.content;
  const declaration = content ? scanDeclaration(content, firstLine, file.language) : scanDiffDeclaration(hunk, file.language);
  return {
    path: file.path,
    hunkId: hunk.id,
    ...(declaration?.name !== undefined ? { enclosingSymbol: declaration.name } : {}),
    ...(declaration?.kind !== undefined ? { symbolKind: declaration.kind } : {}),
    ...(declaration?.nativeKind !== undefined ? { symbolNativeKind: declaration.nativeKind } : {}),
    changedLines,
    changedLinesSide: side,
    ...(declaration?.signature !== undefined ? { signature: declaration.signature } : {}),
    source: "fallback",
    confidence: "heuristic"
  };
}

function scanDeclaration(
  content: string,
  firstChangedLine: number,
  language: string
): { name: string; kind: HunkSymbolFacts["symbolKind"]; nativeKind: string; signature: string } | undefined {
  for (let line = firstChangedLine; line >= Math.max(1, firstChangedLine - 200); line -= 1) {
    const text = getLine(content, line).trim();
    const match = matchDeclaration(text, language);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function scanDiffDeclaration(
  hunk: DiffHunk,
  language: string
): { name: string; kind: HunkSymbolFacts["symbolKind"]; nativeKind: string; signature: string } | undefined {
  for (const line of hunk.lines) {
    const match = matchDeclaration(line.content.trim(), language);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function matchDeclaration(
  text: string,
  language: string
): { name: string; kind: HunkSymbolFacts["symbolKind"]; nativeKind: string; signature: string } | undefined {
  if (language === "go") {
    const method = /^func\s+\(\s*\w+\s+(\*?)([A-Za-z_]\w*)[^)]*\)\s*([A-Za-z_]\w*)/u.exec(text);
    if (method) {
      const owner = method[2] ?? "";
      const name = method[3] ?? "";
      return {
        name: method[1] === "*" ? `(*${owner}).${name}` : `${owner}.${name}`,
        kind: "method",
        nativeKind: "method",
        signature: text
      };
    }
    const fn = /^func\s+([A-Za-z_]\w*)/u.exec(text);
    if (fn?.[1]) {
      return { name: fn[1], kind: "function", nativeKind: "func", signature: text };
    }
  }

  if (language === "typescript" || language === "tsx" || language === "javascript") {
    const fn = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_]\w*)/u.exec(text);
    if (fn?.[1]) {
      return { name: fn[1], kind: "function", nativeKind: "function", signature: text };
    }
    const klass = /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_]\w*)/u.exec(text);
    if (klass?.[1]) {
      return { name: klass[1], kind: "type", nativeKind: "class", signature: text };
    }
    const arrow = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_]\w*)\s*=>/u.exec(text);
    if (arrow?.[1]) {
      return { name: arrow[1], kind: "function", nativeKind: "arrow function", signature: text };
    }
  }

  return undefined;
}

function renderSymbol(file: ParsedFile, symbol: SymbolInfo): string {
  if (file.language === "go") {
    return renderGoSymbolName(symbol);
  }
  if (symbol.ownerType && symbol.kind === "method") {
    return `${symbol.ownerType}.${symbol.name}`;
  }
  return symbol.name;
}
