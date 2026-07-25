import type { Node, Tree } from "web-tree-sitter";
import type {
  ChangedSymbol,
  DiffHunk,
  LanguageAdapter,
  ParsedFile,
  SymbolInfo,
  SymbolRef
} from "../types.js";
import { TreeSitterService, isGrammarId, languageFromPath } from "./tree-sitter/tree-sitter-service.js";
import { GenericAdapter } from "./tree-sitter/generic-adapter.js";
import { GoAdapter } from "./tree-sitter/go-adapter.js";
import { TypeScriptAdapter } from "./tree-sitter/typescript-adapter.js";
import { RustAdapter } from "./tree-sitter/rust-adapter.js";
import { PythonAdapter } from "./tree-sitter/python-adapter.js";
import { SolidityAdapter } from "./tree-sitter/solidity-adapter.js";

export class LanguageAdapterRegistry {
  private readonly generic: GenericAdapter;
  private readonly adapters = new Map<string, LanguageAdapter>();

  constructor(service: TreeSitterService) {
    this.generic = new GenericAdapter();
    const go = new GoAdapter(service);
    const ts = new TypeScriptAdapter(service, "typescript");
    const tsx = new TypeScriptAdapter(service, "tsx");
    const js = new TypeScriptAdapter(service, "javascript");
    const rust = new RustAdapter(service);
    const python = new PythonAdapter(service);
    const solidity = new SolidityAdapter(service);
    for (const adapter of [go, ts, tsx, js, rust, python, solidity]) {
      this.adapters.set(adapter.id, adapter);
    }
  }

  languageForPath(filePath: string): string {
    return languageFromPath(filePath);
  }

  forPath(filePath: string): LanguageAdapter {
    return this.forLanguage(this.languageForPath(filePath));
  }

  forLanguage(language: string): LanguageAdapter {
    if (isGrammarId(language)) {
      return this.adapters.get(language) ?? this.generic;
    }
    return this.generic;
  }
}

export function treeFromParsed(file: ParsedFile): Tree | undefined {
  return file.tree as Tree | undefined;
}

export function walkNamed(node: Node, visit: (node: Node) => void): void {
  for (const child of node.namedChildren) {
    visit(child);
    walkNamed(child, visit);
  }
}

export function lineRange(node: Node): [number, number] {
  return [node.startPosition.row + 1, node.endPosition.row + 1];
}

export function nodeLine(node: Node): number {
  return node.startPosition.row + 1;
}

export function nodeName(node: Node): string | undefined {
  const named = node.childForFieldName("name");
  if (named?.text) {
    return cleanName(named.text);
  }
  const identifier = node.namedChildren.find((child) => /identifier$/u.test(child.type) || child.type === "property_identifier");
  return identifier?.text ? cleanName(identifier.text) : undefined;
}

export function cleanName(name: string): string {
  return name.replace(/^['"`]|['"`]$/gu, "").trim();
}

export function compactSignature(text: string): string {
  const beforeBody = text.split("{", 1)[0] ?? text;
  return beforeBody
    .split("\n")
    .map((line) => line.trim())
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function textForLineRange(content: string, range: [number, number], maxLines = Number.POSITIVE_INFINITY): string {
  const lines = content.split(/\n/u);
  const start = Math.max(1, range[0]);
  const end = Math.min(lines.length, range[1], start + maxLines - 1);
  return lines.slice(start - 1, end).join("\n");
}

export function getLine(content: string, line: number): string {
  return content.split(/\n/u)[line - 1] ?? "";
}

export function changedLinesForHunk(hunk: DiffHunk, side: "old" | "new"): number[] {
  return hunk.lines
    .filter((line) => (side === "new" ? line.kind === "add" : line.kind === "delete"))
    .map((line) => (side === "new" ? line.newLineNumber : line.oldLineNumber))
    .filter((line): line is number => line !== undefined);
}

export function changedSymbolsFromEnclosing(
  file: ParsedFile,
  hunk: DiffHunk,
  getEnclosing: (line: number) => SymbolInfo | undefined,
  side: "old" | "new",
  identity: (symbol: SymbolInfo) => string = qualifiedSymbolName
): ChangedSymbol[] {
  const byKey = new Map<string, ChangedSymbol>();
  for (const line of changedLinesForHunk(hunk, side)) {
    const symbol = getEnclosing(line);
    if (!symbol) {
      continue;
    }
    const key = identity(symbol);
    const existing = byKey.get(key);
    if (existing) {
      existing.changedLines.push(line);
    } else {
      byKey.set(key, { ...symbol, path: file.path, changedLines: [line] });
    }
  }
  return [...byKey.values()];
}

export function qualifiedSymbolName(symbol: SymbolInfo): string {
  if (symbol.ownerType && symbol.kind === "method") {
    return `${symbol.ownerType}.${symbol.name}`;
  }
  return symbol.name;
}

export function importLikeScan(content: string): string[] {
  const matches: Array<{ value: string; index: number }> = [];
  const patterns = [
    /\bimport\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/gu,
    /\bexport\s+(?:\*(?:\s+as\s+[$\w]+)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/gu,
    /\brequire\(\s*["']([^"']+)["']\s*\)/gu,
    /^\s*from\s+([^\s]+)\s+import\b/gmu
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const value = match[1];
      if (value !== undefined) {
        matches.push({ value, index: match.index });
      }
    }
  }
  matches.sort((a, b) => a.index - b.index);
  return [...new Set(matches.map((match) => match.value))];
}

export function fileStem(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  return base.replace(/\.(?:test|spec)?\.?[cm]?[tj]sx?$/u, "").replace(/\.[^.]+$/u, "");
}

export function isLineInside(symbol: SymbolRef, line: number): boolean {
  return line >= symbol.lineRange[0] && line <= symbol.lineRange[1];
}
