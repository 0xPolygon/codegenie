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
import { isRepositoryTestPath } from "../../util/path-roles.js";
import {
  changedSymbolsFromEnclosing,
  treeFromParsed,
  walkNamed
} from "../language-adapter.js";
import { TreeSitterService } from "./tree-sitter-service.js";

const MAX_SIGNATURE_CHARS = 600;

type OwnerContext = {
  name: string;
  kind: "contract" | "abstract contract" | "interface" | "library";
};

type LocatedSymbol = {
  symbol: SymbolInfo;
  depth: number;
};

export class SolidityAdapter implements LanguageAdapter {
  readonly id = "solidity";
  readonly extensions = [".sol"];

  constructor(private readonly service: TreeSitterService) {}

  async init(): Promise<void> {
    return undefined;
  }

  async parse(input: ParseInput): Promise<ParsedFile> {
    return this.service.parse({ ...input, language: "solidity" });
  }

  listSymbols(file: ParsedFile): SymbolInfo[] {
    const tree = treeFromParsed(file);
    if (!tree) {
      return [];
    }
    return declarationsInContainer(file, tree.rootNode)
      .map(({ symbol }) => symbol)
      .sort(compareSymbols);
  }

  getEnclosingSymbol(file: ParsedFile, line: number): SymbolInfo | undefined {
    const tree = treeFromParsed(file);
    if (!tree) {
      return undefined;
    }
    return declarationsInContainer(file, tree.rootNode)
      .filter(({ symbol }) => line >= symbol.lineRange[0] && line <= symbol.lineRange[1])
      .sort(compareEnclosingSymbols)[0]?.symbol;
  }

  getImports(file: ParsedFile): string[] {
    const tree = treeFromParsed(file);
    if (!tree) {
      return [];
    }
    const imports: string[] = [];
    const seen = new Set<string>();
    walkNamed(tree.rootNode, (node) => {
      if (node.type !== "import_directive") {
        return;
      }
      const source = node.childForFieldName("source");
      const specifier = source === null ? "" : unquoteSolidityString(source.text.trim());
      if (specifier.length > 0 && !seen.has(specifier)) {
        seen.add(specifier);
        imports.push(specifier);
      }
    });
    return imports;
  }

  getChangedSymbols(file: ParsedFile, hunk: DiffHunk): ChangedSymbol[] {
    const side = file.source.kind === "base" ? "old" : "new";
    return changedSymbolsFromEnclosing(
      file,
      hunk,
      (line) => this.getEnclosingSymbol(file, line),
      side,
      solidityDeclarationIdentity
    );
  }
}

function declarationsInContainer(
  file: ParsedFile,
  container: Node,
  owner?: OwnerContext,
  depth = 0
): LocatedSymbol[] {
  const symbols: LocatedSymbol[] = [];
  for (const node of container.namedChildren) {
    const ownerKind = solidityOwnerKind(node);
    if (ownerKind !== undefined) {
      const symbol = namedDeclarationSymbol(file, node, ownerKind === "interface" ? "interface" : "type", ownerKind);
      if (symbol === undefined) {
        continue;
      }
      symbols.push({ symbol, depth });
      const body = node.childForFieldName("body");
      if (body !== null) {
        symbols.push(...declarationsInContainer(file, body, { name: symbol.name, kind: ownerKind }, depth + 1));
      }
      continue;
    }

    const symbol = symbolForDeclaration(file, node, owner);
    if (symbol !== undefined) {
      symbols.push({ symbol, depth });
    }
  }
  return symbols;
}

function solidityOwnerKind(node: Node): OwnerContext["kind"] | undefined {
  if (node.type === "interface_declaration") {
    return "interface";
  }
  if (node.type === "library_declaration") {
    return "library";
  }
  if (node.type !== "contract_declaration") {
    return undefined;
  }
  return node.children.some((child) => child.type === "abstract") ? "abstract contract" : "contract";
}

function symbolForDeclaration(file: ParsedFile, node: Node, owner?: OwnerContext): SymbolInfo | undefined {
  switch (node.type) {
    case "function_definition": {
      const name = node.childForFieldName("name")?.text;
      if (!name) {
        return undefined;
      }
      const directMember = owner !== undefined;
      const testCase = owner !== undefined &&
        (owner.kind === "contract" || owner.kind === "abstract contract") &&
        isSolidityTest(file.path, name);
      return declarationSymbol(
        file,
        node,
        name,
        directMember ? "method" : "function",
        testCase ? "test case" : directMember ? `${owner.kind} function` : "free function",
        owner
      );
    }
    case "constructor_definition":
      return owner === undefined
        ? undefined
        : declarationSymbol(file, node, "constructor", "method", "constructor", owner);
    case "fallback_receive_definition": {
      if (owner === undefined) {
        return undefined;
      }
      const name = fallbackReceiveName(node);
      return declarationSymbol(file, node, name, "method", name, owner);
    }
    case "modifier_definition": {
      if (owner === undefined) {
        return undefined;
      }
      const name = node.childForFieldName("name")?.text;
      return name ? declarationSymbol(file, node, name, "method", "modifier", owner) : undefined;
    }
    case "state_variable_declaration": {
      if (owner === undefined) {
        return undefined;
      }
      const name = node.childForFieldName("name")?.text;
      return name ? declarationSymbol(file, node, name, "value", stateVariableNativeKind(node), owner) : undefined;
    }
    case "struct_declaration":
      return namedDeclarationSymbol(file, node, "type", "struct", owner);
    case "enum_declaration":
      return namedDeclarationSymbol(file, node, "type", "enum", owner);
    case "user_defined_type_definition":
      return namedDeclarationSymbol(file, node, "type", "user-defined value type", owner);
    case "event_definition":
      return namedDeclarationSymbol(file, node, "other", "event", owner);
    case "error_declaration":
      return namedDeclarationSymbol(file, node, "other", "custom error", owner);
    default:
      return undefined;
  }
}

function namedDeclarationSymbol(
  file: ParsedFile,
  node: Node,
  kind: SymbolKind,
  nativeKind: string,
  owner?: OwnerContext
): SymbolInfo | undefined {
  const name = node.childForFieldName("name")?.text;
  return name ? declarationSymbol(file, node, name, kind, nativeKind, owner) : undefined;
}

function declarationSymbol(
  file: ParsedFile,
  node: Node,
  name: string,
  kind: SymbolKind,
  nativeKind: string,
  owner?: OwnerContext
): SymbolInfo {
  const signature = declarationSignature(node);
  return {
    path: file.path,
    name,
    kind,
    nativeKind,
    lineRange: [node.startPosition.row + 1, node.endPosition.row + 1],
    ...(owner !== undefined ? { ownerType: owner.name } : {}),
    ...(signature.length > 0 ? { signature } : {})
  };
}

function declarationSignature(node: Node): string {
  const body = node.childForFieldName("body");
  const end = body?.startIndex ?? node.endIndex;
  const source = node.text.slice(0, Math.max(0, end - node.startIndex));
  return boundedSignature(compactSolidityText(source));
}

function compactSolidityText(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

function boundedSignature(signature: string): string {
  return signature.length <= MAX_SIGNATURE_CHARS
    ? signature
    : signature.slice(0, MAX_SIGNATURE_CHARS).trimEnd();
}

function fallbackReceiveName(node: Node): "fallback" | "receive" {
  return node.children.some((child) => child.type === "receive") ? "receive" : "fallback";
}

function stateVariableNativeKind(node: Node): string {
  return node.children.some((child) => child.type === "constant")
    ? "constant"
    : node.namedChildren.some((child) => child.type === "immutable")
      ? "immutable state variable"
      : "state variable";
}

function isSolidityTest(filePath: string, name: string): boolean {
  return isRepositoryTestPath(filePath) && (name.startsWith("test") || name.startsWith("invariant"));
}

function unquoteSolidityString(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function solidityDeclarationIdentity(symbol: SymbolInfo): string {
  return [
    symbol.path,
    symbol.kind,
    symbol.ownerType ?? "",
    symbol.name,
    symbol.lineRange[0],
    symbol.lineRange[1],
    symbol.signature ?? ""
  ].join("\0");
}

function compareSymbols(a: SymbolInfo, b: SymbolInfo): number {
  return a.lineRange[0] - b.lineRange[0] ||
    a.lineRange[1] - b.lineRange[1] ||
    compareText(a.ownerType ?? "", b.ownerType ?? "") ||
    compareText(a.name, b.name) ||
    compareText(a.kind, b.kind);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function symbolSpan(symbol: SymbolInfo): number {
  return symbol.lineRange[1] - symbol.lineRange[0];
}

function compareEnclosingSymbols(a: LocatedSymbol, b: LocatedSymbol): number {
  return symbolSpan(a.symbol) - symbolSpan(b.symbol) ||
    b.depth - a.depth ||
    compareSymbols(a.symbol, b.symbol);
}
