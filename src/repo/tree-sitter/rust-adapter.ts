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
  nodeName,
  treeFromParsed,
  walkNamed
} from "../language-adapter.js";
import { TreeSitterService } from "./tree-sitter-service.js";

const MAX_SIGNATURE_CHARS = 600;
const ASYNC_TEST_ATTRIBUTES = new Set([
  "actix_rt::test",
  "async_std::test",
  "tokio::test"
]);

type OwnershipContext = {
  ownerType: string;
  nativePrefix: "trait" | "impl";
  header: string;
};

type AttributedNode = {
  node: Node;
  attributes: Node[];
};

type LocatedSymbol = {
  symbol: SymbolInfo;
  depth: number;
};

export class RustAdapter implements LanguageAdapter {
  readonly id = "rust";
  readonly extensions = [".rs"];

  constructor(private readonly service: TreeSitterService) {}

  async init(): Promise<void> {
    return undefined;
  }

  async parse(input: ParseInput): Promise<ParsedFile> {
    return this.service.parse({ ...input, language: "rust" });
  }

  listSymbols(file: ParsedFile): SymbolInfo[] {
    const tree = treeFromParsed(file);
    if (!tree) {
      return [];
    }
    return locatedSymbolsInContainer(file, tree.rootNode)
      .map(({ symbol }) => symbol)
      .sort(compareSymbols);
  }

  getEnclosingSymbol(file: ParsedFile, line: number): SymbolInfo | undefined {
    const tree = treeFromParsed(file);
    if (!tree) {
      return undefined;
    }
    return locatedSymbolsInContainer(file, tree.rootNode)
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
      let specifier: Node | null = null;
      if (node.type === "use_declaration") {
        specifier = node.childForFieldName("argument");
      } else if (node.type === "extern_crate_declaration") {
        specifier = node.childForFieldName("name");
      }
      if (specifier === null) {
        return;
      }
      const compact = compactRustImport(specifier);
      const identity = rustImportIdentity(compact);
      if (compact.length > 0 && !seen.has(identity)) {
        seen.add(identity);
        imports.push(compact);
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
      rustDeclarationIdentity
    );
  }
}

function locatedSymbolsInContainer(
  file: ParsedFile,
  container: Node,
  context?: OwnershipContext,
  depth = 0
): LocatedSymbol[] {
  const symbols: LocatedSymbol[] = [];
  for (const attributed of attributedChildren(container)) {
    const { node, attributes } = attributed;
    if (node.type === "trait_item") {
      const trait = declarationSymbol(file, attributed, "interface", "trait");
      if (trait !== undefined) {
        symbols.push({ symbol: trait, depth });
        const body = node.childForFieldName("body");
        if (body !== null) {
          symbols.push(...locatedSymbolsInContainer(file, body, {
            ownerType: trait.name,
            nativePrefix: "trait",
            header: attributedHeader(attributed)
          }, depth + 1));
        }
      }
      continue;
    }
    if (node.type === "impl_item") {
      const body = node.childForFieldName("body");
      const ownerType = implOwner(node);
      if (body !== null) {
        symbols.push(...locatedSymbolsInContainer(file, body, {
          ownerType,
          nativePrefix: "impl",
          header: attributedHeader(attributed)
        }, depth + 1));
      }
      continue;
    }
    const symbol = symbolForDeclaration(file, attributed, context);
    if (symbol !== undefined) {
      symbols.push({ symbol, depth });
    }
    if (node.type === "mod_item") {
      const body = node.childForFieldName("body");
      if (body !== null) {
        symbols.push(...locatedSymbolsInContainer(file, body, undefined, depth + 1));
      }
      continue;
    }
    for (const block of outermostDescendantBlocks(node)) {
      symbols.push(...locatedSymbolsInContainer(file, block, undefined, depth + 1));
    }
  }
  return symbols;
}

function attributedChildren(container: Node): AttributedNode[] {
  const output: AttributedNode[] = [];
  let pendingAttributes: Node[] = [];
  for (const child of container.namedChildren) {
    if (child.type === "attribute_item") {
      pendingAttributes.push(child);
      continue;
    }
    if (isComment(child)) {
      continue;
    }
    output.push({ node: child, attributes: pendingAttributes });
    pendingAttributes = [];
  }
  return output;
}

function isComment(node: Node): boolean {
  return node.type === "line_comment" || node.type === "block_comment";
}

function outermostDescendantBlocks(node: Node): Node[] {
  const blocks: Node[] = [];
  const visit = (current: Node): void => {
    for (const child of current.namedChildren) {
      if (child.type === "block") {
        blocks.push(child);
      } else {
        visit(child);
      }
    }
  };
  visit(node);
  return blocks;
}

function symbolForDeclaration(
  file: ParsedFile,
  attributed: AttributedNode,
  context?: OwnershipContext
): SymbolInfo | undefined {
  const { node } = attributed;
  switch (node.type) {
    case "function_item":
    case "function_signature_item":
      return declarationSymbol(
        file,
        attributed,
        context === undefined ? "function" : "method",
        isRustTest(file.path, attributed.attributes) ? "test case" : context === undefined ? "function" : `${context.nativePrefix} method`,
        context
      );
    case "struct_item":
      return declarationSymbol(file, attributed, "type", "struct", context);
    case "union_item":
      return declarationSymbol(file, attributed, "type", "union", context);
    case "enum_item":
      return declarationSymbol(file, attributed, "type", "enum", context);
    case "type_item":
    case "associated_type":
      return declarationSymbol(file, attributed, "type", context === undefined ? "type alias" : "associated type", context);
    case "mod_item":
      return declarationSymbol(file, attributed, "container", "module", context);
    case "const_item":
      return declarationSymbol(file, attributed, "value", context === undefined ? "constant" : "associated constant", context);
    case "static_item":
      return declarationSymbol(file, attributed, "value", context === undefined ? "static" : "associated static", context);
    case "macro_definition":
      return declarationSymbol(file, attributed, "other", "macro definition", context);
    default:
      return undefined;
  }
}

function declarationSymbol(
  file: ParsedFile,
  attributed: AttributedNode,
  kind: SymbolKind,
  nativeKind: string,
  context?: OwnershipContext
): SymbolInfo | undefined {
  const name = nodeName(attributed.node);
  if (name === undefined) {
    return undefined;
  }
  const first = attributed.attributes[0] ?? attributed.node;
  const ownSignature = attributedHeader(attributed);
  const signature = boundedSignature(context === undefined ? ownSignature : `${context.header} :: ${ownSignature}`);
  return {
    path: file.path,
    name,
    kind,
    nativeKind,
    lineRange: [first.startPosition.row + 1, attributed.node.endPosition.row + 1],
    ...(context !== undefined ? { ownerType: context.ownerType } : {}),
    ...(signature.length > 0 ? { signature } : {})
  };
}

function attributedHeader(attributed: AttributedNode): string {
  return [
    ...attributed.attributes.map((attribute) => compactRustText(attribute.text)),
    declarationHeader(attributed.node)
  ].filter(Boolean).join(" ");
}

function declarationHeader(node: Node): string {
  if (node.type === "macro_definition") {
    let headerEnd: Node | undefined;
    for (const child of node.children) {
      if (child.type === "macro_rule" || child.type === "token_tree") {
        break;
      }
      if (!isComment(child)) {
        headerEnd = child;
      }
      if (["(", "[", "{"].includes(child.type)) {
        break;
      }
    }
    if (headerEnd !== undefined) {
      const headerBytes = Math.max(0, headerEnd.endIndex - node.startIndex);
      return compactRustText(Buffer.from(node.text, "utf8").subarray(0, headerBytes).toString("utf8"));
    }
  }
  const body = node.childForFieldName("body");
  const text = body === null
    ? node.text
    : node.text.slice(0, Math.max(0, node.text.length - body.text.length));
  return compactRustText(text);
}

function compactRustText(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

function compactRustImport(node: Node): string {
  return compactRustText(textWithoutCommentTrivia(node))
    .replace(/\s*::\s*/gu, "::")
    .replace(/\{\s*/gu, "{")
    .replace(/\s*,\s*/gu, ", ")
    .replace(/\s*\}/gu, "}");
}

function rustImportIdentity(compact: string): string {
  return compact.replace(/,\s*\}/gu, "}");
}

function textWithoutCommentTrivia(node: Node): string {
  const comments: Node[] = [];
  const collect = (current: Node): void => {
    for (const child of current.namedChildren) {
      if (isComment(child)) {
        comments.push(child);
      } else {
        collect(child);
      }
    }
  };
  collect(node);
  if (comments.length === 0) {
    return node.text;
  }

  const source = Buffer.from(node.text, "utf8");
  const segments: Buffer[] = [];
  let cursor = 0;
  for (const comment of comments.sort((a, b) => a.startIndex - b.startIndex)) {
    const start = Math.max(cursor, comment.startIndex - node.startIndex);
    const end = Math.max(start, comment.endIndex - node.startIndex);
    segments.push(source.subarray(cursor, start), Buffer.from(" "));
    cursor = end;
  }
  segments.push(source.subarray(cursor));
  return Buffer.concat(segments).toString("utf8");
}

function boundedSignature(signature: string): string {
  if (signature.length <= MAX_SIGNATURE_CHARS) {
    return signature;
  }
  return signature.slice(0, MAX_SIGNATURE_CHARS).trimEnd();
}

function nominalOwner(typeNode: Node | null, projectionRoots: ReadonlySet<string>): string | undefined {
  if (typeNode === null) {
    return undefined;
  }
  if (typeNode.type === "type_identifier") {
    return typeNode.text;
  }
  if (typeNode.type === "generic_type") {
    return nominalOwner(typeNode.childForFieldName("type"), projectionRoots);
  }
  if (typeNode.type !== "scoped_type_identifier") {
    return undefined;
  }
  const path = typeNode.childForFieldName("path");
  const name = typeNode.childForFieldName("name") ?? typeNode.namedChildren.at(-1) ?? null;
  if (path === null) {
    return typeNode.text.startsWith("::") && name?.type === "type_identifier"
      ? name.text
      : undefined;
  }
  if (!isPlainNominalPath(path)) {
    return undefined;
  }
  const root = plainPathRoot(path);
  if (root === "Self" || (root !== undefined && projectionRoots.has(root))) {
    return undefined;
  }
  return name?.type === "type_identifier" ? name.text : undefined;
}

function plainPathRoot(node: Node): string | undefined {
  if (["crate", "identifier", "self", "super", "type_identifier"].includes(node.type)) {
    return node.text;
  }
  const path = node.type === "scoped_identifier" ? node.childForFieldName("path") : null;
  if (path !== null) {
    return plainPathRoot(path);
  }
  const name = node.type === "scoped_identifier" && node.text.startsWith("::")
    ? node.childForFieldName("name")
    : null;
  return name?.type === "identifier" ? name.text : undefined;
}

function isPlainNominalPath(node: Node): boolean {
  if (["crate", "identifier", "self", "super", "type_identifier"].includes(node.type)) {
    return true;
  }
  if (node.type !== "scoped_identifier") {
    return false;
  }
  const path = node.childForFieldName("path");
  const name = node.childForFieldName("name");
  if (path === null) {
    return node.text.startsWith("::") && name?.type === "identifier";
  }
  return isPlainNominalPath(path) && name?.type === "identifier";
}

function implOwner(implNode: Node): string {
  const typeNode = implNode.childForFieldName("type");
  if (typeNode === null) {
    return "impl target";
  }
  const typeParameters = implNode.childForFieldName("type_parameters");
  const projectionRoots = new Set(typeParameters?.namedChildren
    .filter((parameter) => parameter.type === "type_parameter")
    .map((parameter) => parameter.childForFieldName("name") ??
      parameter.namedChildren.find((child) => child.type === "type_identifier") ?? null)
    .filter((parameter): parameter is Node => parameter !== null)
    .map((parameter) => parameter.text) ?? []);
  return nominalOwner(typeNode, projectionRoots) ?? (compactRustText(typeNode.text) || "impl target");
}

function isRustTest(filePath: string, attributes: Node[]): boolean {
  if (!isRepositoryTestPath(filePath)) {
    return false;
  }
  return attributes.some((attribute) => {
    const name = rustAttributeName(attribute);
    return name === "test" || ASYNC_TEST_ATTRIBUTES.has(name);
  });
}

function rustAttributeName(attribute: Node): string {
  const inner = attribute.namedChildren.find((child) => child.type === "attribute");
  if (inner === undefined) {
    return "";
  }
  const head = inner.namedChildren[0]?.text ?? "";
  return head.replace(/\s+/gu, "");
}

function rustDeclarationIdentity(symbol: SymbolInfo): string {
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
