import type { Node } from "web-tree-sitter";
import type {
  ChangedSymbol,
  DiffHunk,
  LanguageAdapter,
  ParseInput,
  ParsedFile,
  SymbolInfo,
  SymbolKind
} from "../../types.js";
import {
  changedSymbolsFromEnclosing,
  lineRange,
  nodeName,
  treeFromParsed
} from "../language-adapter.js";
import { escapeRegExp } from "../../util/regex.js";
import { TreeSitterService } from "./tree-sitter-service.js";

export class GoAdapter implements LanguageAdapter {
  readonly id = "go";
  readonly extensions = [".go"];

  constructor(private readonly service: TreeSitterService) {}

  async init(): Promise<void> {
    return undefined;
  }

  async parse(input: ParseInput): Promise<ParsedFile> {
    return this.service.parse({ ...input, language: "go" });
  }

  listSymbols(file: ParsedFile): SymbolInfo[] {
    const tree = treeFromParsed(file);
    if (!tree) {
      return [];
    }
    const packageName = packageNameFor(tree.rootNode);
    const symbols: SymbolInfo[] = [];
    for (const node of tree.rootNode.namedChildren) {
      if (node.type === "function_declaration") {
        const symbol = functionSymbol(file, node, packageName);
        if (symbol) {
          symbols.push(symbol);
        }
      } else if (node.type === "method_declaration") {
        const symbol = methodSymbol(file, node, packageName);
        if (symbol) {
          symbols.push(symbol);
        }
      } else if (node.type === "type_declaration") {
        symbols.push(...typeSymbols(file, node, packageName));
      } else if (node.type === "const_declaration" || node.type === "var_declaration") {
        symbols.push(...valueSymbols(file, node, packageName));
      }
    }
    return symbols.sort((a, b) => a.lineRange[0] - b.lineRange[0]);
  }

  getEnclosingSymbol(file: ParsedFile, line: number): SymbolInfo | undefined {
    return this.listSymbols(file)
      .filter((symbol) => line >= symbol.lineRange[0] && line <= symbol.lineRange[1])
      .sort((a, b) => span(a) - span(b) || a.lineRange[0] - b.lineRange[0])[0];
  }

  getImports(file: ParsedFile): string[] {
    const tree = treeFromParsed(file);
    if (!tree) {
      return [];
    }
    const imports = new Set<string>();
    for (const node of tree.rootNode.namedChildren) {
      if (node.type !== "import_declaration") {
        continue;
      }
      for (const match of node.text.matchAll(/"([^"]+)"/gu)) {
        const value = match[1];
        if (value !== undefined) {
          imports.add(value);
        }
      }
    }
    return [...imports];
  }

  getChangedSymbols(file: ParsedFile, hunk: DiffHunk): ChangedSymbol[] {
    const side = file.source.kind === "base" ? "old" : "new";
    return changedSymbolsFromEnclosing(file, hunk, (line) => this.getEnclosingSymbol(file, line), side);
  }
}

export function renderGoSymbolName(symbol: SymbolInfo): string {
  if (symbol.kind !== "method" || symbol.ownerType === undefined) {
    return symbol.name;
  }
  const signature = symbol.signature ?? "";
  const pointer = new RegExp(`\\*\\s*${escapeRegExp(symbol.ownerType)}\\b`, "u").test(signature);
  return pointer ? `(*${symbol.ownerType}).${symbol.name}` : `(${symbol.ownerType}).${symbol.name}`;
}

function functionSymbol(file: ParsedFile, node: Node, packageName: string | undefined): SymbolInfo | undefined {
  const name = nodeName(node);
  if (!name) {
    return undefined;
  }
  return makeSymbol(file, node, name, "function", "func", packageName);
}

function methodSymbol(file: ParsedFile, node: Node, packageName: string | undefined): SymbolInfo | undefined {
  const name = nodeName(node);
  if (!name) {
    return undefined;
  }
  const receiver = node.childForFieldName("receiver")?.text ?? "";
  const ownerType = receiverOwner(receiver);
  return makeSymbol(file, node, name, "method", "method", packageName, ownerType);
}

function typeSymbols(file: ParsedFile, node: Node, packageName: string | undefined): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== "type_spec") {
      continue;
    }
    const name = nodeName(child);
    if (!name) {
      continue;
    }
    const nativeKind = goTypeNativeKind(child);
    symbols.push(makeSymbol(file, child, name, nativeKind === "interface" ? "interface" : "type", nativeKind, packageName));
  }
  return symbols;
}

function valueSymbols(file: ParsedFile, node: Node, packageName: string | undefined): SymbolInfo[] {
  const nativeKind = node.type === "const_declaration" ? "const" : "var";
  const symbols: SymbolInfo[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== "const_spec" && child.type !== "var_spec") {
      continue;
    }
    for (const name of declaredNames(child)) {
      const symbol = makeSymbol(file, child, name, "value", nativeKind, packageName);
      if (symbol) {
        symbols.push(symbol);
      }
    }
  }
  return symbols;
}

function makeSymbol(
  file: ParsedFile,
  node: Node,
  name: string,
  kind: SymbolKind,
  nativeKind: string,
  packageName: string | undefined,
  ownerType?: string
): SymbolInfo {
  const output: SymbolInfo = {
    path: file.path,
    name,
    kind,
    nativeKind,
    lineRange: lineRange(node),
    exported: /^[A-Z]/u.test(name),
    signature: goSignature(node.text, nativeKind)
  };
  if (packageName !== undefined) {
    output.packageName = packageName;
  }
  if (ownerType !== undefined) {
    output.ownerType = ownerType;
  }
  return output;
}

function goSignature(text: string, nativeKind: string): string {
  const compact = compactGoDeclaration(text);
  if (nativeKind === "func" || nativeKind === "method") {
    return trimAtImplementationBody(compact);
  }
  return compact;
}

function compactGoDeclaration(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

function trimAtImplementationBody(text: string): string {
  const braces = topLevelOpenBraces(text);
  const bodyStart = braces.at(-1);
  return bodyStart !== undefined ? text.slice(0, bodyStart).trim() : text;
}

function topLevelOpenBraces(text: string): number[] {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: '"' | "`" | undefined;
  let escaped = false;
  const braces: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{" && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      braces.push(index);
    }
    if (char === "(") {
      parenDepth += 1;
    } else if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (char === "[") {
      bracketDepth += 1;
    } else if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (char === "{") {
      braceDepth += 1;
    } else if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
    }
  }

  return braces;
}

function packageNameFor(root: Node): string | undefined {
  const pkg = root.namedChildren.find((node) => node.type === "package_clause")?.text;
  return pkg?.replace(/^package\s+/u, "").trim();
}

function goTypeNativeKind(node: Node): string {
  const text = node.text;
  if (/\bstruct\s*\{/u.test(text)) {
    return "struct";
  }
  if (/\binterface\s*\{/u.test(text)) {
    return "interface";
  }
  return "type";
}

function declaredNames(node: Node): string[] {
  const names = node.namedChildren
    .filter((child) => child.type === "identifier")
    .map((child) => child.text.trim())
    .filter(Boolean);
  if (names.length > 0) {
    return names;
  }
  const match = /^\s*(?:const|var)?\s*([A-Za-z_]\w*)/u.exec(node.text);
  return match?.[1] ? [match[1]] : [];
}

function receiverOwner(receiver: string): string | undefined {
  const match = /\(\s*(?:\w+\s+)?\*?\s*([A-Za-z_]\w*)/u.exec(receiver);
  return match?.[1];
}

function span(symbol: SymbolInfo): number {
  return symbol.lineRange[1] - symbol.lineRange[0];
}
