import { isDeepStrictEqual } from "node:util";
import { validateToolCall, type TSchema } from "@earendil-works/pi-ai";

type JsonSchema = TSchema & {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  patternProperties?: Record<string, JsonSchema>;
  const?: unknown;
  default?: unknown;
};

export type ValidationIssue = { path: string; kind: "missing" | "unknown" | "invalid" };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const empty = (v: unknown) => v === null || v === "" || (Array.isArray(v) && v.length === 0) || (record(v) && Object.keys(v).length === 0);

function valid(schema: TSchema, value: unknown): boolean {
  try {
    const result = validateToolCall([{ name: "value", description: "", parameters: { type: "object", properties: { value: schema }, required: ["value"] } as TSchema }],
      { type: "toolCall", id: "validation", name: "value", arguments: JSON.parse(JSON.stringify({ value })) });
    return isDeepStrictEqual(result, { value });
  } catch { return false; }
}

export type SubmitShapeEdit = {
  path: string;
  destination?: string;
  rule: "unknown_property" | "verifier_risk_alias";
};

const owns = (object: object, key: string) => Object.hasOwn(object, key);
const childPath = (path: string, key: string) => path ? `${path}.${key}` : key;

// All edits operate on a copy; raw provider arguments remain available for diagnostics.
export function cleanupSubmitShape(schema: TSchema, input: unknown, rootPath = ""): { arguments: unknown; edits: SubmitShapeEdit[]; removedUnexpectedFields: Array<{ path: string; originalValue: unknown }> } {
  const args: unknown = structuredClone(input);
  const edits: SubmitShapeEdit[] = [];
  const removedUnexpectedFields: Array<{ path: string; originalValue: unknown }> = [];
  const walk = (s: JsonSchema | undefined, node: unknown, path: string) => {
    if (!s || s.anyOf || s.oneOf || s.allOf || s.patternProperties) return;
    if (s.type === "array" && Array.isArray(node)) {
      node.forEach((value, index) => walk(Array.isArray(s.items) ? s.items[index] : s.items,
        value, childPath(path, String(index))));
      return;
    }
    if (s.type !== "object" || !record(node)) return;
    const properties = s.properties ?? {};
    const unknownKeys = Object.keys(node).filter(key => !owns(properties, key));
    if (s.additionalProperties === false) {
      // Only the exact root verifier alias is locally renamed.
      if (path === "" && owns(properties, "verdict") && owns(properties, "falsePositiveRisk")
        && unknownKeys.includes("falsePositivesRisk") && valid(properties.falsePositiveRisk!, node.falsePositivesRisk)
        && (!owns(node, "falsePositiveRisk") || isDeepStrictEqual(node.falsePositiveRisk, node.falsePositivesRisk))) {
        node.falsePositiveRisk = node.falsePositivesRisk;
        delete node.falsePositivesRisk;
        edits.push({ path: "falsePositivesRisk", destination: "falsePositiveRisk", rule: "verifier_risk_alias" });
      }
      for (const key of unknownKeys.filter(key => owns(node, key))) {
        removedUnexpectedFields.push({ path: childPath(path, key), originalValue: node[key] });
        delete node[key];
        edits.push({ path: childPath(path, key), rule: "unknown_property" });
      }
    }
    for (const key of Object.keys(node)) {
      const child = owns(properties, key) ? properties[key] : record(s.additionalProperties) ? s.additionalProperties : undefined;
      if (child) walk(child, node[key], childPath(path, key));
    }
  };
  walk(schema as JsonSchema, args, rootPath);
  return { arguments: args, edits, removedUnexpectedFields };
}

// Expected shapes and unexpected values are data for the repair prompt, not
// telemetry. The caller must fence them as untrusted and retain the full draft.
export function focusedRepairDiagnostics(schema: TSchema, original: unknown) {
  const cleaned = cleanupSubmitShape(schema, original);
  const at = (root: unknown, path: string): unknown => path.split(".").filter(Boolean).reduce<unknown>((node, key) =>
    record(node) || Array.isArray(node) ? (node as Record<string, unknown>)[key] : undefined, root);
  const schemaAt = (path: string): JsonSchema | undefined => path.split(".").filter(Boolean).reduce<JsonSchema | undefined>((node, key) =>
    node?.type === "array" ? Array.isArray(node.items) ? node.items[Number(key)] : node.items : node?.properties?.[key], schema as JsonSchema);
  return {
    localEdits: cleaned.edits,
    removedUnexpectedFields: cleaned.removedUnexpectedFields,
    issues: submissionIssues(schema, cleaned.arguments).map(issue => {
      const expected = schemaAt(issue.path);
      return { ...issue, ...(expected ? { expected } : {}),
        ...(issue.kind === "unknown" ? { originalValue: at(original, issue.path) } : {}) };
    })
  };
}

// Structured diagnostics come from schema traversal, never from words inside
// model-written evidence. Full validation remains the runner's authority.
export function submissionIssues(input: TSchema, value: unknown, path = ""): ValidationIssue[] {
  const schema = (input ?? {}) as JsonSchema;
  if (record(value) && schema.type === "object") {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = (schema.required ?? []) as string[];
    const issues: ValidationIssue[] = [
      ...required.filter(key => !(key in value)).map(key => ({ path: path ? `${path}.${key}` : key, kind: "missing" as const })),
      ...Object.entries(value).flatMap(([key, child]) => {
        const next = path ? `${path}.${key}` : key;
        return properties[key] ? submissionIssues(properties[key], child, next)
          : schema.additionalProperties === false ? [{ path: next, kind: "unknown" as const }] : [];
      })
    ];
    return issues.length ? issues : valid(schema, value) ? [] : [{ path, kind: "invalid" }];
  }
  if (Array.isArray(value) && schema.type === "array" && (record(schema.items) || Array.isArray(schema.items))) {
    const children = value.flatMap((child, index) => submissionIssues((Array.isArray(schema.items) ? schema.items[index] : schema.items) as TSchema, child, `${path}.${index}`));
    return children.length ? children : valid(schema, value) ? [] : [{ path, kind: "invalid" }];
  }
  return valid(schema, value) ? [] : [{ path, kind: "invalid" }];
}

// Complete, provenance-valid JSON only. Fixed array indices are local identities.
// Invalid primitive fields may be corrected. Unexpected closed-object keys are
// discarded; schema-defined values, item identities, and order remain protected.
export function preservationViolations(schema: TSchema, before: unknown, after: unknown): string[] {
  before = cleanupSubmitShape(schema, before).arguments;
  if ((schema as JsonSchema).properties?.coverage && record(before)) {
    if (Object.keys(before).length === 1 && "plan" in before) {
      let plan: unknown = before.plan;
      if (typeof plan === "string") { try { plan = JSON.parse(plan); } catch { /* Not a complete wrapper. */ } }
      if (record(plan) && record(plan.diffUnderstanding) && Array.isArray(plan.coverage)) before = plan;
    }
    if (record(before)) before = normalizePlannerBookkeeping(before);
  }
  const violations: string[] = [];
  const walk = (s: JsonSchema | undefined, a: unknown, b: unknown, path: string) => {
    if (isDeepStrictEqual(a, b)) return;
    if (typeof a === "string" && (s?.type === "object" || s?.type === "array")) {
      // A complete JSON wrapper can be unwrapped, but not a fragment or prefix.
      try {
        const parsed: unknown = JSON.parse(a);
        if (record(parsed) || Array.isArray(parsed)) { walk(s, cleanupSubmitShape(s, parsed, path).arguments, b, path); return; }
      } catch { /* Retain the opaque invalid value as unresolved. */ }
      violations.push(path); return;
    }
    if ((s?.type === "object" || s?.type === "array") && !record(a) && !Array.isArray(a) && !empty(a)) {
      violations.push(path); return;
    }
    if (s?.type === "string" && typeof a !== "string" && !empty(a) && b !== String(a)) {
      violations.push(path); return;
    }
    if (b === undefined && !empty(a)) { violations.push(path); return; }
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) { violations.push(path); return; }
      a.forEach((value, index) => walk(Array.isArray(s?.items) ? s.items[index] : s?.items, value, b[index], `${path}.${index}`));
      return;
    }
    if (record(a)) {
      if (!record(b)) { violations.push(path); return; }
      const properties = (s?.properties ?? {}) as Record<string, JsonSchema>;
      for (const [key, value] of Object.entries(a)) {
        const next = path ? `${path}.${key}` : key;
        if (!(key in b) && !properties[key]) {
          // Redundant anchor aliases have no independent semantic content.
          if (record(a.anchor) && ((key === "line" || key === "hunkId") && isDeepStrictEqual(a.anchor[key], value)
            || key === "filePath" && value === a.path && value === a.anchor.path
            || key === "changedLine" && value === true && a.anchor.side === "RIGHT")) continue;
          if (path.endsWith("evidence") && ["verification", "whyThisMatters"].includes(key)) {
            const parentPath = path.split(".").slice(0, -1);
            const parent = parentPath.reduce<unknown>((node, part) => record(node) || Array.isArray(node) ? (node as Record<string, unknown>)[part] : undefined, after);
            const originalParent = parentPath.reduce<unknown>((node, part) => record(node) || Array.isArray(node) ? (node as Record<string, unknown>)[part] : undefined, before);
            if (record(parent) && isDeepStrictEqual(parent[key], value) && record(originalParent) && (!(key in originalParent) || isDeepStrictEqual(originalParent[key], value))) continue;
          }
          violations.push(next); continue;
        }
        // Omission of an empty, invalid optional scalar is a shape correction.
        if (!(key in b) && empty(value) && properties[key] && !((s?.required ?? []) as string[]).includes(key) && !valid(properties[key], value)) continue;
        walk(properties[key], value, b[key], next);
      }
      // Adding a previously absent schema-defined field does not overwrite
      // original content. Full schema and stage-semantic validation still apply.
      for (const key of Object.keys(b).filter(key => !(key in a))) {
        if (!owns(properties, key) || !valid(properties[key]!, b[key])) {
          violations.push(childPath(path, key));
        }
      }
      return;
    }
    const protectedDecision = /(?:^|\.)(severity|confidence|verdict|coverage|reviewStatus|behaviorChange|falsePositiveRisk|requiredEvidencePresent)$/u.test(path);
    if (!s || valid(s, a) || protectedDecision || (typeof a === "string" && a.trim().length > 0 && typeof b === "string" && a.trim() !== b.trim() && !s.enum && !s.anyOf && s.const === undefined)) violations.push(path);
  };
  walk(schema as JsonSchema, before, after, "");
  return [...new Set(violations)];
}

// Only planner-owned bookkeeping is removable. Preserve misplaced explanatory
// prose verbatim in inferredBehavior; coverage remains byte-for-byte intact.
export function normalizePlannerBookkeeping(input: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(input);
  if (!Array.isArray(result.coverage) || !record(result.diffUnderstanding)) return result;
  const understanding = result.diffUnderstanding;
  for (const key of ["reviewedHunks", "totalHunks"]) {
    if (typeof understanding[key] === "number" && Number.isInteger(understanding[key]) && (understanding[key] as number) >= 0) delete understanding[key];
  }
  if (typeof understanding.isPartial === "boolean") delete understanding.isPartial;
  if (typeof understanding.reason === "string" && typeof understanding.inferredBehavior === "string") {
    if (understanding.reason.trim()) understanding.inferredBehavior += `\n${understanding.reason}`;
    delete understanding.reason;
  }
  return result;
}
