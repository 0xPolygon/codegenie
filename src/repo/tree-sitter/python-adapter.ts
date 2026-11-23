import type { Node } from "web-tree-sitter";
import type {
  ChangedSymbol,
  DiffHunk,
  LanguageAdapter,
  ParseInput,
  ParsedFile,
  SymbolInfo
} from "../../types.js";
import { isRepositoryTestPath } from "../../util/path-roles.js";
import {
  changedSymbolsFromEnclosing,
  treeFromParsed,
  walkNamed
} from "../language-adapter.js";
import { TreeSitterService } from "./tree-sitter-service.js";

const MAX_SIGNATURE_CHARS = 600;

type DeclarationNode = {
  definition: Node;
  outer: Node;
};

type DeclarationContext = {
  enclosingClass?: string;
  directClassBody: boolean;
  directModuleBody: boolean;
};

type LocatedSymbol = {
  symbol: SymbolInfo;
  depth: number;
};

export class PythonAdapter implements LanguageAdapter {
  readonly id = "python";
  readonly extensions = [".py"];

  constructor(private readonly service: TreeSitterService) {}

  async init(): Promise<void> {
    return undefined;
  }

  async parse(input: ParseInput): Promise<ParsedFile> {
    return this.service.parse({ ...input, language: "python" });
  }

  listSymbols(file: ParsedFile): SymbolInfo[] {
    const tree = treeFromParsed(file);
    if (!tree) {
      return [];
    }
    return declarationsInContainer(file, tree.rootNode, {
      directClassBody: false,
      directModuleBody: true
    }).map(({ symbol }) => symbol).sort(compareSymbols);
  }

  getEnclosingSymbol(file: ParsedFile, line: number): SymbolInfo | undefined {
    const tree = treeFromParsed(file);
    if (!tree) {
      return undefined;
    }
    return declarationsInContainer(file, tree.rootNode, {
      directClassBody: false,
      directModuleBody: true
    })
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
      for (const specifier of importSpecifiers(node)) {
        if (specifier.length > 0 && !seen.has(specifier)) {
          seen.add(specifier);
          imports.push(specifier);
        }
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
      pythonDeclarationIdentity
    );
  }
}

function declarationsInContainer(
  file: ParsedFile,
  container: Node,
  context: DeclarationContext,
  depth = 0
): LocatedSymbol[] {
  const symbols: LocatedSymbol[] = [];
  for (const child of container.namedChildren) {
    const declaration = unwrapDeclaration(child);
    if (declaration?.definition.type === "function_definition") {
      const symbol = functionSymbol(file, declaration, context);
      if (symbol !== undefined) {
        symbols.push({ symbol, depth });
      }
      const body = declaration.definition.childForFieldName("body");
      if (body !== null) {
        symbols.push(...declarationsInContainer(file, body, {
          directClassBody: false,
          directModuleBody: false
        }, depth + 1));
      }
      continue;
    }
    if (declaration?.definition.type === "class_definition") {
      const symbol = classSymbol(file, declaration, context);
      if (symbol !== undefined) {
        symbols.push({ symbol, depth });
      }
      const body = declaration.definition.childForFieldName("body");
      if (body !== null) {
        symbols.push(...declarationsInContainer(file, body, {
          ...(symbol?.name !== undefined ? { enclosingClass: symbol.name } : {}),
          directClassBody: true,
          directModuleBody: false
        }, depth + 1));
      }
      continue;
    }
    symbols.push(...declarationsInContainer(file, child, {
      ...(context.enclosingClass !== undefined ? { enclosingClass: context.enclosingClass } : {}),
      directClassBody: false,
      directModuleBody: false
    }, depth + 1));
  }
  return symbols;
}

function unwrapDeclaration(node: Node): DeclarationNode | undefined {
  if (node.type === "function_definition" || node.type === "class_definition") {
    return { definition: node, outer: node };
  }
  if (node.type !== "decorated_definition") {
    return undefined;
  }
  const definition = node.childForFieldName("definition");
  return definition !== null && (definition.type === "function_definition" || definition.type === "class_definition")
    ? { definition, outer: node }
    : undefined;
}

function functionSymbol(
  file: ParsedFile,
  declaration: DeclarationNode,
  context: DeclarationContext
): SymbolInfo | undefined {
  const name = declaration.definition.childForFieldName("name")?.text;
  if (!name) {
    return undefined;
  }
  const method = context.directClassBody && context.enclosingClass !== undefined;
  const testCase = isPythonTest(file.path, name, method, context);
  const async = declarationHeaderText(declaration.definition).trimStart().startsWith("async ");
  return {
    path: file.path,
    name,
    kind: method ? "method" : "function",
    nativeKind: testCase ? "test case" : async ? `async ${method ? "method" : "function"}` : method ? "method" : "function",
    lineRange: declarationRange(declaration),
    ...(method ? { ownerType: context.enclosingClass } : {}),
    signature: declarationSignature(declaration)
  };
}

function classSymbol(
  file: ParsedFile,
  declaration: DeclarationNode,
  context: DeclarationContext
): SymbolInfo | undefined {
  const name = declaration.definition.childForFieldName("name")?.text;
  if (!name) {
    return undefined;
  }
  const nested = context.enclosingClass !== undefined;
  return {
    path: file.path,
    name,
    kind: "type",
    nativeKind: nested ? "nested class" : "class",
    lineRange: declarationRange(declaration),
    ...(nested ? { ownerType: context.enclosingClass } : {}),
    signature: declarationSignature(declaration)
  };
}

function declarationRange(declaration: DeclarationNode): [number, number] {
  return [declaration.outer.startPosition.row + 1, declaration.outer.endPosition.row + 1];
}

function declarationSignature(declaration: DeclarationNode): string {
  const body = declaration.definition.childForFieldName("body");
  const headerEnd = body?.startIndex ?? declarationColonEnd(declaration.definition) ?? declaration.definition.endIndex;
  const source = declaration.outer.text.slice(0, Math.max(0, headerEnd - declaration.outer.startIndex));
  return boundedSignature(compactPythonHeader(source));
}

function declarationHeaderText(definition: Node): string {
  const body = definition.childForFieldName("body");
  const headerEnd = body?.startIndex ?? declarationColonEnd(definition) ?? definition.endIndex;
  return definition.text.slice(0, Math.max(0, headerEnd - definition.startIndex));
}

function declarationColonEnd(definition: Node): number | undefined {
  return definition.children.find((child) => child.type === ":")?.endIndex;
}

function compactPythonHeader(text: string): string {
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

function importSpecifiers(node: Node): string[] {
  if (node.type === "future_import_statement") {
    return ["__future__"];
  }
  if (node.type === "import_statement") {
    return node.namedChildren
      .map((child) => child.type === "aliased_import" ? child.childForFieldName("name") : child)
      .filter((child): child is Node => child !== null && child.type === "dotted_name")
      .map((child) => child.text.trim());
  }
  if (node.type !== "import_from_statement") {
    return [];
  }
  const moduleName = node.namedChildren[0];
  return moduleName !== undefined && (moduleName.type === "dotted_name" || moduleName.type === "relative_import")
    ? [moduleName.text.replace(/\s+/gu, "")]
    : [];
}

function isPythonTest(
  filePath: string,
  name: string,
  method: boolean,
  context: DeclarationContext
): boolean {
  if (!isRepositoryTestPath(filePath) || !name.startsWith("test_")) {
    return false;
  }
  if (method) {
    return context.enclosingClass?.startsWith("Test") === true;
  }
  return context.directModuleBody;
}

function pythonDeclarationIdentity(symbol: SymbolInfo): string {
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
