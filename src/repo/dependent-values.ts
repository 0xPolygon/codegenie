import type { Node } from "web-tree-sitter";
import type { ParsedFile, SymbolInfo } from "../types.js";
import { lineRange, treeFromParsed } from "./language-adapter.js";

export type ContractMember = { key: string; spelling: string; number?: number; qualified?: string };
export type ValueContract = { name: string; members: ContractMember[]; range: [number, number] };

function literal(node: Node): ContractMember | undefined {
  const raw = node.text.trim();
  if (/^-?(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|[0-9][0-9_]*)$/u.test(raw)) {
    const negative = raw.startsWith("-");
    const n = Number((negative ? raw.slice(1) : raw).replaceAll("_", "")) * (negative ? -1 : 1);
    if (Number.isSafeInteger(n)) return { key: `number:${n}`, spelling: raw, number: n };
  }
  if (/^(?:"[^"\\\r\n]*"|'[^'\\\r\n]*')$/u.test(raw)) {
    return { key: `string:${raw.slice(1, -1)}`, spelling: raw };
  }
  if (/^(?:true|false|null)$/u.test(raw)) return { key: raw, spelling: raw };
  return undefined;
}

function unionMembers(node: Node): ContractMember[] | undefined {
  if (node.type === "union_type") return combine(children(node), unionMembers);
  if (node.type === "literal_type" || node.type === "parenthesized_type") {
    const child = children(node)[0];
    return child ? unionMembers(child) : undefined;
  }
  const member = literal(node);
  return member ? [member] : undefined;
}

function children(node: Node): Node[] {
  return node.namedChildren.filter(child => child.type !== "comment");
}

function combine(nodes: Node[], membersFor: (node: Node) => ContractMember[] | undefined): ContractMember[] | undefined {
  const result: ContractMember[] = [];
  for (const node of nodes) {
    const members = membersFor(node);
    if (!members) return undefined;
    result.push(...members);
  }
  return result;
}

function memberLiteral(node: Node): ContractMember[] | undefined {
  const member = literal(node);
  return member ? [member] : undefined;
}

function enumMembers(node: Node, name: string): ContractMember[] | undefined {
  const body = node.childForFieldName("body");
  if (!body) return undefined;
  return combine(children(body), entry => {
    const key = (entry.childForFieldName("name") ?? entry).text.replace(/^["']|["']$/gu, "");
    if (!/^[A-Za-z_$][\w$]*$/u.test(key)) return undefined;
    const valueNode = entry.childForFieldName("value");
    const value = valueNode ? literal(valueNode) : undefined;
    if (valueNode && !value) return undefined;
    return [{ key: `enum:${key}:${value?.key ?? ""}`, spelling: key, qualified: `${name}.${key}`,
      ...(value?.number !== undefined ? { number: value.number } : {}) }];
  });
}

function constMembers(node: Node): ContractMember[] | undefined {
  if (!/^const\b/u.test(node.parent?.text.trimStart() ?? "")) return undefined;
  let value = node.childForFieldName("value");
  if (value?.type === "as_expression" || value?.type === "satisfies_expression") value = children(value)[0] ?? null;
  if (value?.type === "array") {
    if (/,\s*,|^\[\s*,/u.test(value.text)) return undefined;
    return combine(children(value), memberLiteral);
  }
  if (value?.type !== "object") return undefined;
  return combine(children(value), entry => {
    const property = entry.childForFieldName("key");
    const value = entry.childForFieldName("value");
    const member = value && literal(value);
    return entry.type === "pair" && property && member ? [{ ...member, key: `property:${property.text}:${member.key}` }] : undefined;
  });
}

function goConstContracts(node: Node): ValueContract[] {
  const groups = new Map<string, ContractMember[]>();
  let previousType: string | undefined;
  for (const spec of children(node)) {
    if (spec.type !== "const_spec") continue;
    const type = spec.childForFieldName("type");
    const rhs = spec.childForFieldName("value");
    const name = type?.type === "type_identifier" ? type.text : !type && !rhs ? previousType : undefined;
    previousType = name;
    if (!name) continue;
    const members = groups.get(name) ?? [];
    groups.set(name, members);
    const names = spec.childrenForFieldName("name");
    for (const [i, identifier] of names.entries()) {
      const value = rhs?.namedChildren[i];
      const token = value ? literal(value) : undefined;
      members.push({ key: `const:${identifier.text}:${value?.text ?? ""}`, spelling: identifier.text, qualified: identifier.text,
        ...(token?.number !== undefined ? { number: token.number } : {}) });
    }
  }
  return [...groups].map(([name, members]) => ({ name, members, range: lineRange(node) }));
}

export function supportsValueSetExtraction(language: string): boolean {
  return ["typescript", "tsx", "javascript", "go"].includes(language);
}

export function valueContracts(file: ParsedFile, symbols: SymbolInfo[]): Map<string, ValueContract> {
  const tree = treeFromParsed(file);
  const contracts = new Map<string, ValueContract>();
  if (!tree || !supportsValueSetExtraction(file.language)) return contracts;
  const pending = [tree.rootNode];
  while (pending.length) {
    const node = pending.pop()!;
    if (file.language === "go" && node.type === "const_declaration") {
      for (const contract of goConstContracts(node)) {
        contracts.set(`${contract.name}:${contract.range[0]}`, contract);
      }
      continue;
    }

    if (node.type === "type_alias_declaration" || node.type === "enum_declaration" || node.type === "variable_declarator") {
      const name = node.childForFieldName("name")?.text;
      const range = lineRange(node);
      const symbol = symbols.find(symbol => symbol.name === name && symbol.lineRange[0] === range[0]
        && ["type", "value", "container"].includes(symbol.kind));
      if (name && symbol) {
        const value = node.childForFieldName("value");
        const members = node.type === "enum_declaration" ? enumMembers(node, name)
          : node.type === "type_alias_declaration" ? value && unionMembers(value) : constMembers(node);
        if (members) contracts.set(`${name}:${range[0]}`, { name, members, range });
      }
    }
    pending.push(...node.namedChildren);
  }
  return contracts;
}
