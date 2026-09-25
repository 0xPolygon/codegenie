import type { TSchema } from "@earendil-works/pi-ai";
import type { PiArgumentSyntaxDiagnostic } from "./llm-runner.js";
import { submissionIssues } from "./submit-preservation.js";

/** Locate XML parameter syntax outside JSON strings; never recover argument values. */
export function xmlParameterSyntax(text: string): { offset: number; field?: string } | undefined {
  let field: string | undefined;
  const containers: string[] = [];
  for (let i = 0; i < text.length;) {
    if (/\s/u.test(text[i]!)) { i++; continue; }
    if (text[i] === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      if (i >= text.length) return undefined;
      const literal = text.slice(start, ++i);
      while (i < text.length && /\s/u.test(text[i]!)) i++;
      field = undefined;
      if (text[i] === ":") {
        try { field = JSON.parse(literal) as string; } catch { /* Invalid key: keep generic syntax guidance. */ }
        i++;
      }
      continue;
    }
    if (text[i] === "<" && /^<\/?parameter(?:\s|>)/u.test(text.slice(i, i + 32))) {
      // Targets use the root schema. A nested same-named key must not borrow
      // that field's type; keep generic XML guidance when its scope differs.
      const rootField = containers.length === 1 && containers[0] === "{";
      return { offset: i, ...(rootField && field && field.length <= 200 ? { field } : {}) };
    }
    if (text[i] === "{" || text[i] === "[") containers.push(text[i]!);
    if (text[i] === "}" || text[i] === "]") {
      const expected = text[i] === "}" ? "{" : "[";
      if (containers.at(-1) !== expected) return undefined;
      containers.pop();
    }
    field = undefined;
    i++;
  }
  return undefined;
}

type Shape = {
  type?: string;
  properties?: Record<string, Shape>;
  required?: string[];
  items?: Shape;
  enum?: unknown[];
  const?: unknown;
  anyOf?: unknown;
  oneOf?: unknown;
  allOf?: unknown;
};

// A bounded JSON structure example, not a reconstructed verdict. Unsupported or
// oversized shapes are omitted instead of fabricating a schema-compatible value.
function structureExample(shape: Shape, depth = 0): unknown {
  if (depth > 4 || shape.anyOf || shape.oneOf || shape.allOf) return undefined;
  if (shape.const !== undefined) return shape.const;
  if (shape.enum?.length) return shape.enum[0];
  if (shape.type === "string") return "<replace with task-supported text>";
  if (shape.type === "boolean") return false;
  if (shape.type === "number" || shape.type === "integer") return 0;
  if (shape.type === "null") return null;
  if (shape.type === "array" && shape.items && !Array.isArray(shape.items)) {
    const item = structureExample(shape.items, depth + 1);
    return item === undefined ? undefined : [item];
  }
  if (shape.type === "object" && shape.properties) {
    const keys = shape.required ?? Object.keys(shape.properties);
    if (keys.length > 12) return undefined;
    const entries = keys.map(key => [key, structureExample(shape.properties![key] ?? {}, depth + 1)] as const);
    return entries.some(([, value]) => value === undefined) ? undefined : Object.fromEntries(entries);
  }
  return undefined;
}

/** Examples come only from the active schema, never from rejected argument values. */
export function xmlSyntaxRepairTargets(schema: TSchema, diagnostics: PiArgumentSyntaxDiagnostic[]) {
  const properties = (schema as Shape).properties ?? {};
  const fields = [...new Set(diagnostics.flatMap(d => d.xmlParameter?.field ? [d.xmlParameter.field] : []))];
  return fields.slice(0, 3).flatMap(field => {
    if (!Object.hasOwn(properties, field)) return [];
    const shape = properties[field]!;
    if (shape.type !== "object" && shape.type !== "array") return [];
    const example = structureExample(shape);
    const target = { field, optional: !(schema as Shape).required?.includes(field), schema: shape,
      ...(example !== undefined && submissionIssues(shape as TSchema, example).length === 0
        ? { jsonStructureExample: { [field]: example } } : {}) };
    return JSON.stringify(target).length <= 3000 ? [target] : [];
  });
}
