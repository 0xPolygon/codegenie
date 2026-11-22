import type { Node } from "web-tree-sitter";
import type { ParsedFile } from "../types.js";
import { treeFromParsed } from "./language-adapter.js";

export type UsageRole = "call" | "member_call" | "reference" | "import" | "re_export" | "declaration";
export type UsageOccurrence = {
  path: string;
  line: number;
  column: number;
  spelling: string;
  role: UsageRole;
  receiver?: string;
  packageName?: string;
  bindingEvidence?: { kind: "import_spelling" | "re_export_spelling"; importedName: string; localName: string; moduleSpecifier: string; line: number; binding: "unresolved";
    candidateModulePath?: string };
  enclosing: { name?: string; searchName?: string; lineRange: [number, number]; startColumn?: number; endColumnExclusive?: number; kind: "declaration" | "anonymous" | "module";
    nearestNamed?: { name: string; lineRange: [number, number] } };
};

const IDENTIFIERS = new Set(["identifier", "property_identifier", "field_identifier", "type_identifier"]);
const DECLARATIONS = new Set(["function_declaration", "function_expression", "method_definition", "method_declaration", "func_literal", "arrow_function", "generator_function_declaration"]);
const NAMED_BINDINGS = new Set(["variable_declarator", "class_declaration", "interface_declaration", "type_alias_declaration",
  "type_spec", "const_spec", "var_spec", "method_elem", "parameter_declaration", "required_parameter", "optional_parameter"]);

/** Classify lexical syntax only. This deliberately does not claim a runtime binding. */
export function classifyUsageSyntax(file: ParsedFile, name: string): UsageOccurrence[] | undefined {
  const tree = treeFromParsed(file);
  if (!tree || !["typescript", "tsx", "javascript", "go"].includes(file.language)) return undefined;
  const dotted = name.includes(".");
  const lastName = name.split(".").at(-1);
  const imports = importSpellings(tree.rootNode, lastName ?? "");
  const packageName = file.language === "go" ? tree.rootNode.namedChildren.find(child => child.type === "package_clause")
    ?.namedChildren.find(child => child.type === "package_identifier")?.text : undefined;
  const spellings = new Set([lastName, ...imports.filter(entry => entry.importedName === lastName).map(entry => entry.localName)]);
  const rows: UsageOccurrence[] = [];
  const visit = (node: Node): void => {
    if (IDENTIFIERS.has(node.type) && spellings.has(node.text)) {
      const parent = node.parent;
      const member = parent && ["member_expression", "selector_expression"].includes(parent.type)
        && sameNode(parent.childForFieldName("property") ?? parent.childForFieldName("field"), node) ? parent : undefined;
      const spelling = member?.text ?? node.text;
      if (!dotted || spelling === name) {
        const role = syntaxRole(node, member);
        const receiver = member?.childForFieldName("object")?.text ?? member?.childForFieldName("operand")?.text;
        const bindingEvidence = (role === "re_export" ? reExportEvidence(node) : undefined)
          ?? imports.find(entry => entry.localName === (receiver ?? node.text)
            || (role === "import" && entry.importedName === node.text && entry.line === node.startPosition.row + 1));
        rows.push({ path: file.path, line: node.startPosition.row + 1, column: node.startPosition.column + 1,
          spelling, role, ...(receiver ? { receiver } : {}), ...(packageName ? { packageName } : {}), ...(bindingEvidence ? { bindingEvidence } : {}),
          enclosing: enclosingDeclaration(node, tree.rootNode) });
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(tree.rootNode);
  return rows;
}

function reExportEvidence(node: Node): UsageOccurrence["bindingEvidence"] {
  let specifier = node.parent;
  while (specifier && specifier.type !== "export_specifier") specifier = specifier.parent;
  if (!specifier) return undefined;
  const importedName = specifier.childForFieldName("name")?.text;
  const localName = specifier.childForFieldName("alias")?.text ?? importedName;
  let statement = specifier.parent;
  while (statement && statement.type !== "export_statement") statement = statement.parent;
  const source = statement?.childForFieldName("source")?.text;
  if (!importedName || !localName || !source) return undefined;
  return { kind: "re_export_spelling", importedName, localName, moduleSpecifier: source.slice(1, -1),
    line: specifier.startPosition.row + 1, binding: "unresolved" };
}

function importSpellings(root: Node, sought: string): NonNullable<UsageOccurrence["bindingEvidence"]>[] {
  const entries: NonNullable<UsageOccurrence["bindingEvidence"]>[] = [];
  const visit = (node: Node): void => {
    if (node.type === "import_specifier") {
      const importedName = node.childForFieldName("name")?.text;
      const localName = node.childForFieldName("alias")?.text ?? importedName;
      let statement = node.parent;
      while (statement && statement.type !== "import_statement") statement = statement.parent;
      const source = statement?.childForFieldName("source")?.text;
      if (importedName === sought && localName && source) entries.push({ kind: "import_spelling", importedName, localName,
        moduleSpecifier: source.slice(1, -1), line: node.startPosition.row + 1, binding: "unresolved" });
    } else if (node.type === "namespace_import") {
      const localName = node.namedChildren.find(child => child.type === "identifier")?.text;
      let statement = node.parent;
      while (statement && statement.type !== "import_statement") statement = statement.parent;
      const source = statement?.childForFieldName("source")?.text;
      if (localName && source) entries.push({ kind: "import_spelling", importedName: "*", localName,
        moduleSpecifier: source.slice(1, -1), line: node.startPosition.row + 1, binding: "unresolved" });
    } else if (node.type === "import_spec") {
      const rawPath = node.childForFieldName("path")?.text;
      const moduleSpecifier = rawPath?.slice(1, -1);
      const localName = node.childForFieldName("name")?.text ?? moduleSpecifier?.split("/").at(-1);
      if (moduleSpecifier && localName && localName !== "." && localName !== "_") entries.push({ kind: "import_spelling",
        importedName: "*", localName, moduleSpecifier, line: node.startPosition.row + 1, binding: "unresolved" });
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return entries;
}

function sameNode(a: Node | null | undefined, b: Node): boolean {
  return a != null && a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
}

function syntaxRole(node: Node, member?: Node): UsageRole {
  for (let p = node.parent; p; p = p.parent) {
    if (["import_statement", "import_spec", "import_declaration"].includes(p.type)) return "import";
    if (["export_specifier", "export_clause"].includes(p.type)) return "re_export";
    if (p.type === "call_expression") {
      const target = p.childForFieldName("function");
      if (sameCallable(target, member ?? node)) return member ? "member_call" : "call";
      break;
    }
    if (DECLARATIONS.has(p.type) && sameNode(p.childForFieldName("name"), node)) return "declaration";
    if (NAMED_BINDINGS.has(p.type) && (sameNode(p.childForFieldName("name"), node) || sameNode(p.childForFieldName("pattern"), node))) return "declaration";
    if (["expression_statement", "statement_block", "block", "source_file", "program"].includes(p.type)) break;
  }
  return "reference";
}

function sameCallable(target: Node | null, occurrence: Node): boolean {
  let current = target;
  while (current && ["instantiation_expression", "parenthesized_expression", "non_null_expression"].includes(current.type)) {
    current = current.namedChildren[0] ?? null;
  }
  return sameNode(current, occurrence);
}

function enclosingDeclaration(node: Node, root: Node): UsageOccurrence["enclosing"] {
  for (let p = node.parent; p; p = p.parent) {
    if (!DECLARATIONS.has(p.type)) continue;
    const display = declarationName(p);
    if (display) return { name: display, searchName: p.childForFieldName("name")?.text ?? display,
      lineRange: [p.startPosition.row + 1, p.endPosition.row + 1], startColumn: p.startPosition.column + 1, endColumnExclusive: p.endPosition.column + 1, kind: "declaration" };
    let nearestNamed: { name: string; lineRange: [number, number] } | undefined;
    for (let outer = p.parent; outer; outer = outer.parent) {
      if (!DECLARATIONS.has(outer.type)) continue;
      const name = declarationName(outer);
      if (name) { nearestNamed = { name, lineRange: [outer.startPosition.row + 1, outer.endPosition.row + 1] }; break; }
    }
    return { lineRange: [p.startPosition.row + 1, p.endPosition.row + 1], startColumn: p.startPosition.column + 1, endColumnExclusive: p.endPosition.column + 1,
      kind: "anonymous", ...(nearestNamed ? { nearestNamed } : {}) };
  }
  return { kind: "module", lineRange: [1, Math.max(1, root.endPosition.row + (root.endPosition.column > 0 ? 1 : 0))] };
}

function declarationName(node: Node): string | undefined {
  const name = node.childForFieldName("name")?.text;
  if (name && node.type === "method_declaration") {
    const receiver = node.childForFieldName("receiver")?.text;
    return receiver ? `${receiver}.${name}` : name;
  }
  if (name && node.type === "method_definition") {
    const owner = node.parent?.parent?.childForFieldName("name")?.text;
    return owner ? `${owner}.${name}` : name;
  }
  if (name) return name;
  return ["arrow_function", "function_expression", "func_literal"].includes(node.type) && node.parent?.type === "variable_declarator"
    ? node.parent.childForFieldName("name")?.text : undefined;
}
