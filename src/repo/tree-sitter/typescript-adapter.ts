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
  cleanName,
  importLikeScan,
  lineRange,
  nodeName,
  treeFromParsed,
  walkNamed
} from "../language-adapter.js";
import { isRepositoryTestPath } from "../../util/path-roles.js";
import { TreeSitterService, type GrammarId } from "./tree-sitter-service.js";

type ExportContext = {
  exported: boolean;
  defaultExport: boolean;
};

export class TypeScriptAdapter implements LanguageAdapter {
  readonly extensions: string[];

  constructor(
    private readonly service: TreeSitterService,
    readonly id: Extract<GrammarId, "typescript" | "tsx" | "javascript">
  ) {
    this.extensions =
      id === "typescript" ? [".ts", ".mts", ".cts", ".d.ts"] : id === "tsx" ? [".tsx"] : [".js", ".jsx", ".mjs", ".cjs"];
  }

  async init(): Promise<void> {
    return undefined;
  }

  async parse(input: ParseInput): Promise<ParsedFile> {
    return this.service.parse({ ...input, language: this.id });
  }

  listSymbols(file: ParsedFile): SymbolInfo[] {
    const tree = treeFromParsed(file);
    if (!tree) {
      return [];
    }
    const symbols: SymbolInfo[] = [];
    const exportedNames = exportLocalNames(file.content);

    for (const node of tree.rootNode.namedChildren) {
      const exportContext = {
        exported: node.type === "export_statement" || startsWithExport(node.text),
        defaultExport: node.type === "export_statement" && isDefaultExport(node.text)
      };
      const declarations = node.type === "export_statement" ? exportDeclarationNodes(node) : [node];
      for (const declaration of declarations) {
        symbols.push(...symbolsForDeclaration(file, declaration, exportContext, exportedNames));
      }
    }

    symbols.push(...testSymbols(file));
    return dedupeSymbols(symbols).sort((a, b) => a.lineRange[0] - b.lineRange[0]);
  }

  getEnclosingSymbol(file: ParsedFile, line: number): SymbolInfo | undefined {
    return this.listSymbols(file)
      .filter((symbol) => line >= symbol.lineRange[0] && line <= symbol.lineRange[1])
      .sort((a, b) => span(a) - span(b) || a.lineRange[0] - b.lineRange[0])[0];
  }

  getImports(file: ParsedFile): string[] {
    return importLikeScan(file.content);
  }

  getChangedSymbols(file: ParsedFile, hunk: DiffHunk): ChangedSymbol[] {
    const side = file.source.kind === "base" ? "old" : "new";
    return changedSymbolsFromEnclosing(file, hunk, (line) => this.getEnclosingSymbol(file, line), side);
  }
}

function symbolsForDeclaration(
  file: ParsedFile,
  node: Node,
  exportContext: ExportContext,
  exportedNames: Set<string>,
  ownerType?: string
): SymbolInfo[] {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
      return singleSymbol(file, node, "function", "function", exportContext, exportedNames, ownerType);
    case "arrow_function":
    case "function":
    case "function_expression":
      return singleSymbol(file, node, "function", node.type === "arrow_function" ? "arrow function" : "function", exportContext, exportedNames, ownerType);
    case "class":
    case "class_declaration": {
      const symbols = singleSymbol(file, node, "type", "class", exportContext, exportedNames, ownerType);
      const owner = symbols[0]?.name;
      if (owner !== undefined) {
        symbols.push(...classMembers(file, node, owner, Boolean(symbols[0]?.exported), exportedNames));
      }
      return symbols;
    }
    case "interface_declaration":
      return singleSymbol(file, node, "interface", "interface", exportContext, exportedNames, ownerType);
    case "type_alias_declaration":
      return singleSymbol(file, node, "type", "type alias", exportContext, exportedNames, ownerType);
    case "enum_declaration":
      return singleSymbol(file, node, "type", "enum", exportContext, exportedNames, ownerType);
    case "internal_module":
    case "module":
      return namespaceSymbols(file, node, exportContext, exportedNames, ownerType);
    case "lexical_declaration":
    case "variable_declaration":
      return variableSymbols(file, node, exportContext.exported, exportedNames, ownerType);
    default:
      return [];
  }
}

function singleSymbol(
  file: ParsedFile,
  node: Node,
  kind: SymbolKind,
  nativeKind: string,
  exportContext: ExportContext,
  exportedNames: Set<string>,
  ownerType?: string
): SymbolInfo[] {
  const fallbackDefault = exportContext.defaultExport || node.text.includes("export default") ? "default" : undefined;
  const name = nodeName(node) ?? fallbackDefault;
  if (!name) {
    return [];
  }
  return [makeSymbol(file, node, name, kind, nativeKind, exportContext.exported || exportedNames.has(name), ownerType)];
}

function variableSymbols(
  file: ParsedFile,
  node: Node,
  exportedContext: boolean,
  exportedNames: Set<string>,
  ownerType?: string
): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const declarationKind = declarationKeyword(node.text);
  for (const child of directVariableDeclarators(node)) {
    const name = child.childForFieldName("name")?.text;
    if (!name) {
      continue;
    }
    const value = child.childForFieldName("value");
    const callable = value?.type === "arrow_function" || value?.type === "function" || value?.type === "function_expression";
    symbols.push(
      makeSymbol(
        file,
        child,
        cleanName(name),
        callable ? "function" : "value",
        callable ? "arrow function" : declarationKind,
        exportedContext || exportedNames.has(cleanName(name)),
        ownerType
      )
    );
  }
  return symbols;
}

function directVariableDeclarators(node: Node): Node[] {
  if (node.type === "variable_declarator") {
    return [node];
  }
  return node.namedChildren.filter((child) => child.type === "variable_declarator");
}

function namespaceSymbols(
  file: ParsedFile,
  node: Node,
  exportContext: ExportContext,
  exportedNames: Set<string>,
  ownerType?: string
): SymbolInfo[] {
  const symbols = singleSymbol(file, node, "container", "namespace", exportContext, exportedNames, ownerType);
  const namespace = symbols[0];
  if (!namespace) {
    return symbols;
  }
  const namespaceExported = Boolean(namespace.exported);
  for (const member of namespaceMemberDeclarations(node)) {
    const memberExported = namespaceExported && member.exportedContext;
    symbols.push(...symbolsForDeclaration(file, member.declaration, { exported: memberExported, defaultExport: false }, exportedNames, namespace.name));
  }
  return symbols;
}

function namespaceMemberDeclarations(node: Node): Array<{ declaration: Node; exportedContext: boolean }> {
  const body = node.childForFieldName("body") ?? node.namedChildren.find((child) => /body|block/u.test(child.type));
  if (!body) {
    return [];
  }
  const declarations: Array<{ declaration: Node; exportedContext: boolean }> = [];
  for (const child of body.namedChildren) {
    const childExported = child.type === "export_statement" || startsWithExport(child.text);
    const candidates = child.type === "export_statement" ? child.namedChildren : [child];
    for (const candidate of candidates) {
      if (isDeclarationNode(candidate)) {
        declarations.push({ declaration: candidate, exportedContext: childExported });
      }
    }
  }
  return declarations;
}

function isDeclarationNode(node: Node): boolean {
  return (
    node.type === "function_declaration" ||
    node.type === "generator_function_declaration" ||
    node.type === "class" ||
    node.type === "class_declaration" ||
    node.type === "interface_declaration" ||
    node.type === "type_alias_declaration" ||
    node.type === "enum_declaration" ||
    node.type === "internal_module" ||
    node.type === "module" ||
    node.type === "lexical_declaration" ||
    node.type === "variable_declaration"
  );
}

function classMembers(
  file: ParsedFile,
  classNode: Node,
  ownerType: string,
  exportedContext: boolean,
  exportedNames: Set<string>
): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  for (const node of directClassMembers(classNode)) {
    if (node.type !== "method_definition" && node.type !== "public_field_definition" && node.type !== "field_definition") {
      continue;
    }
    const name = nodeName(node) ?? (node.text.startsWith("constructor") ? "constructor" : undefined);
    if (!name) {
      continue;
    }
    const field = node.type === "public_field_definition" || node.type === "field_definition";
    if (field && !hasFunctionLikeValue(node)) {
      continue;
    }
    const nativeKind = name === "constructor" ? "constructor" : node.type === "method_definition" ? "method" : "class field function";
    const exported = isPublicClassMember(node, name) && (exportedContext || exportedNames.has(name));
    symbols.push(makeSymbol(file, node, name, "method", nativeKind, exported, ownerType));
  }
  return symbols;
}

function isPublicClassMember(node: Node, name: string): boolean {
  const prefix = node.text.slice(0, Math.max(0, node.text.indexOf(name)));
  return !/\b(?:private|protected)\b/u.test(prefix) && !name.startsWith("#");
}

function hasFunctionLikeValue(node: Node): boolean {
  const value = node.childForFieldName("value");
  return value?.type === "arrow_function" || value?.type === "function" || value?.type === "function_expression";
}

function directClassMembers(classNode: Node): Node[] {
  const body = classNode.childForFieldName("body") ?? classNode.namedChildren.find((child) => child.type === "class_body");
  return body?.namedChildren ?? [];
}

function testSymbols(file: ParsedFile): SymbolInfo[] {
  if (!isRepositoryTestPath(file.path)) {
    return [];
  }
  const tree = treeFromParsed(file);
  if (!tree) {
    return [];
  }
  const symbols: SymbolInfo[] = [];
  walkNamed(tree.rootNode, (node) => {
    if (node.type !== "call_expression") {
      return;
    }
    const fn = node.childForFieldName("function")?.text ?? "";
    if (!/^(?:describe|it|test)(?:\.(?:only|skip|each))?$/u.test(fn)) {
      return;
    }
    const name = firstStringLiteral(node.text) ?? fn;
    symbols.push(makeSymbol(file, node, name, "function", "test case", false));
  });
  return symbols;
}

function makeSymbol(
  file: ParsedFile,
  node: Node,
  name: string,
  kind: SymbolKind,
  nativeKind: string,
  exported: boolean,
  ownerType?: string
): SymbolInfo {
  const output: SymbolInfo = {
    path: file.path,
    name,
    kind,
    nativeKind,
    lineRange: lineRange(node),
    exported,
    signature: signatureForSymbol(node, nativeKind)
  };
  if (ownerType !== undefined) {
    output.ownerType = ownerType;
  }
  return output;
}

function signatureForSymbol(node: Node, nativeKind: string): string {
  const compact = compactDeclarationText(node.text);
  if (nativeKind === "arrow function" || nativeKind === "class field function") {
    return trimAtTopLevelArrow(compact);
  }
  if (nativeKind === "function" || nativeKind === "method" || nativeKind === "constructor") {
    return trimAtImplementationBody(compact);
  }
  if (nativeKind === "class" || nativeKind === "namespace") {
    return trimAtFirstTopLevelBrace(compact);
  }
  return compact;
}

function compactDeclarationText(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

function trimAtTopLevelArrow(text: string): string {
  const index = firstTopLevelArrow(text);
  return index >= 0 ? text.slice(0, index + 2).trim() : text;
}

function trimAtImplementationBody(text: string): string {
  const braces = topLevelOpenBraces(text);
  const bodyStart = braces.at(-1);
  return bodyStart !== undefined ? text.slice(0, bodyStart).trim() : text;
}

function trimAtFirstTopLevelBrace(text: string): string {
  const braces = topLevelOpenBraces(text);
  const bodyStart = braces[0];
  return bodyStart !== undefined ? text.slice(0, bodyStart).trim() : text;
}

function firstTopLevelArrow(text: string): number {
  const state = new ScanState();
  for (let index = 0; index < text.length; index += 1) {
    if (state.consume(text, index)) {
      continue;
    }
    if (text[index] === "=" && text[index + 1] === ">" && state.atTopLevel()) {
      return index;
    }
    state.track(text[index] ?? "");
  }
  return -1;
}

function topLevelOpenBraces(text: string): number[] {
  const state = new ScanState();
  const braces: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (state.consume(text, index)) {
      continue;
    }
    const char = text[index] ?? "";
    if (char === "{" && state.atTopLevel()) {
      braces.push(index);
    }
    state.track(char);
  }
  return braces;
}

class ScanState {
  private quote: "'" | '"' | "`" | undefined;
  private escaped = false;
  private parenDepth = 0;
  private bracketDepth = 0;
  private braceDepth = 0;

  consume(text: string, index: number): boolean {
    const char = text[index] ?? "";
    if (this.quote !== undefined) {
      if (this.escaped) {
        this.escaped = false;
      } else if (char === "\\") {
        this.escaped = true;
      } else if (char === this.quote) {
        this.quote = undefined;
      }
      return true;
    }
    if (char === "'" || char === '"' || char === "`") {
      this.quote = char;
      return true;
    }
    return false;
  }

  atTopLevel(): boolean {
    return this.parenDepth === 0 && this.bracketDepth === 0 && this.braceDepth === 0;
  }

  track(char: string): void {
    if (char === "(") {
      this.parenDepth += 1;
    } else if (char === ")") {
      this.parenDepth = Math.max(0, this.parenDepth - 1);
    } else if (char === "[") {
      this.bracketDepth += 1;
    } else if (char === "]") {
      this.bracketDepth = Math.max(0, this.bracketDepth - 1);
    } else if (char === "{") {
      this.braceDepth += 1;
    } else if (char === "}") {
      this.braceDepth = Math.max(0, this.braceDepth - 1);
    }
  }
}

function exportDeclarationNodes(node: Node): Node[] {
  const declarations = node.namedChildren.filter((child) => child.type !== "export_clause");
  return declarations.length > 0 ? declarations : node.namedChildren;
}

function isDefaultExport(text: string): boolean {
  return /^\s*export\s+default\b/u.test(text);
}

function exportLocalNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const match of content.matchAll(/\bexport\s*\{(?<body>[^}]+)\}/gu)) {
    const body = match.groups?.body;
    if (!body) {
      continue;
    }
    for (const part of body.split(",")) {
      const [local] = part.trim().replace(/^type\s+/u, "").split(/\s+as\s+|\s+/u);
      if (local) {
        names.add(local.trim());
      }
    }
  }
  return names;
}

function startsWithExport(text: string): boolean {
  return /^\s*export\b/u.test(text);
}

function declarationKeyword(text: string): "const" | "let" | "var" {
  const match = /\b(const|let|var)\b/u.exec(text);
  return (match?.[1] as "const" | "let" | "var" | undefined) ?? "const";
}

function firstStringLiteral(text: string): string | undefined {
  const match = /["'`]([^"'`]+)["'`]/u.exec(text);
  return match?.[1];
}

function dedupeSymbols(symbols: SymbolInfo[]): SymbolInfo[] {
  const seen = new Set<string>();
  const output: SymbolInfo[] = [];
  for (const symbol of symbols) {
    const key = `${symbol.path}:${symbol.ownerType ?? ""}:${symbol.name}:${symbol.lineRange[0]}:${symbol.lineRange[1]}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push(symbol);
    }
  }
  return output;
}

function span(symbol: SymbolInfo): number {
  return symbol.lineRange[1] - symbol.lineRange[0];
}
