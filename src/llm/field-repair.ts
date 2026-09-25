import { isDeepStrictEqual } from "node:util";
import { type TSchema } from "@earendil-works/pi-ai";
import { cleanupSubmitShape, focusedRepairDiagnostics, submissionIssues, type ValidationIssue } from "./submit-preservation.js";

type Schema = TSchema & { description?: string; type?: string; properties?: Record<string, Schema>; items?: Schema | Schema[]; additionalItems?: boolean | Schema; required?: string[]; anyOf?: Schema[]; oneOf?: Schema[]; allOf?: Schema[]; patternProperties?: Record<string, Schema> };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export type FieldRepair = {
  schema: TSchema;
  /** Stage-specific constrained repair context, when generic field repair is unsuitable. */
  prompt?: string;
  replaceConversation?: boolean;
  paths: string[];
  baseline: Record<string, unknown>;
  diagnostics: ReturnType<typeof focusedRepairDiagnostics>;
  merge(values: Record<string, unknown>): Record<string, unknown>;
};

// Optional input properties describe an update, not the final submission. Final
// required fields and all container constraints are checked after merging.
function updateSchema(input: Schema, baseline: unknown, semanticRequired: ReadonlySet<string>, path = ""): Schema {
  const schema = structuredClone(input);
  if (schema.anyOf || schema.oneOf || schema.allOf || schema.patternProperties) return schema;
  if (schema.type === "object" && object(baseline)) {
    const required = new Set(schema.required ?? []);
    delete schema.required;
    if (schema.properties) schema.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => {
      const childPath = path ? `${path}.${key}` : key;
      const updated = updateSchema(child, baseline[key], semanticRequired, childPath);
      updated.description = `${child.description ?? ""} ${semanticRequired.has(childPath)
        ? "Required by stage validation for the retained submission; omission from this update does not waive that requirement."
        : required.has(key) ? "Required in the final merged result; omit from this update only if already retained." : "Optional in the final result and in this update."}`.trim();
      return [key, updated];
    }));
  } else if (schema.type === "array" && schema.items) {
    if (Array.isArray(baseline) && baseline.length && baseline.some(object)) {
      const items = schema.items;
      schema.items = baseline.map((value, index) => updateSchema((Array.isArray(items) ? items[index] : items) ?? {} as Schema, value, semanticRequired, `${path}.${index}`));
      schema.additionalItems = Array.isArray(items) ? false : items;
    }
  }
  return schema;
}

export function mergeSubmissionDraft(before: unknown, update: unknown): unknown {
  // A malformed replacement must not erase retained structured evidence.
  if ((object(before) && !object(update)) || (Array.isArray(before) && !Array.isArray(update))) {
    return structuredClone(before);
  }
  if (object(before) && object(update)) {
    const result = structuredClone(before);
    for (const [key, value] of Object.entries(update)) {
      Object.defineProperty(result, key, { value: Object.hasOwn(before, key) ? mergeSubmissionDraft(before[key], value) : structuredClone(value), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }
  // Preserve omitted object-array items and fixed indices. Repair is not an
  // instruction to delete findings/evidence or reorder their identities.
  if (Array.isArray(before) && Array.isArray(update) && before.some(object)) {
    const result = structuredClone(before);
    update.forEach((value, index) => { result[index] = index < before.length ? mergeSubmissionDraft(before[index], value) : structuredClone(value); });
    return result;
  }
  return structuredClone(update);
}

// Only explicitly declared alternative encodings may replace one another.
// Ordinary omitted fields and evidence continue to be retained.
export function mergeRepairDraft(before: Record<string, unknown>, update: Record<string, unknown>, replacementGroups: readonly (readonly string[])[] = []): Record<string, unknown> {
  const retained = structuredClone(before);
  for (const group of replacementGroups) {
    const selected = group.filter(key => Object.hasOwn(update, key));
    if (selected.length === 1) {
      for (const key of group) if (key !== selected[0]) delete retained[key];
    }
  }
  return mergeSubmissionDraft(retained, update) as Record<string, unknown>;
}

export function createFieldRepair(schema: TSchema, original: unknown, allowSemanticRepair = false, replacementGroups: readonly (readonly string[])[] = [], semanticIssues: readonly ValidationIssue[] = []): FieldRepair | undefined {
  const cleaned = cleanupSubmitShape(schema, original);
  if (!object(cleaned.arguments) || cleaned.unusablePaths.length) return;
  const baseline = cleaned.arguments;
  const diagnostics = focusedRepairDiagnostics(schema, original, semanticIssues);
  const issues = diagnostics.issues;
  if ((!issues.length && !allowSemanticRepair) || issues.length > 64) return;
  const properties: Record<string, TSchema> = Object.create(null);
  for (const issue of issues) {
    const parts = issue.path.split(".");
    if (!issue.path || issue.kind === "unknown" || parts.some(part => ["__proto__", "prototype", "constructor"].includes(part))) return;
    let shape: Schema | undefined = schema as Schema;
    let value: unknown = baseline;
    for (const part of parts) {
      if (!shape || shape.anyOf || shape.oneOf || shape.allOf || shape.patternProperties) return;
      if (shape.type === "array") {
        if (!/^(0|[1-9][0-9]*)$/u.test(part) || !Array.isArray(value) || Number(part) >= value.length) return;
        shape = Array.isArray(shape.items) ? shape.items[Number(part)] : shape.items;
        value = value[Number(part)];
      } else {
        if (!object(value) || !Object.hasOwn(shape.properties ?? {}, part)) return;
        shape = shape.properties![part];
        value = Object.hasOwn(value, part) ? value[part] : undefined;
      }
    }
    if (!shape || (issue.kind === "invalid" && (object(value) || Array.isArray(value) || shape.type === "array" || shape.type === "object"))) return;
    properties[issue.path] = JSON.parse(JSON.stringify(shape)) as TSchema;
  }
  const paths = Object.keys(properties);
  if (paths.some(path => paths.some(other => other !== path && other.startsWith(`${path}.`)))) return;
  const partial = updateSchema(schema as Schema, baseline, new Set(semanticIssues.filter(issue => issue.kind === "missing").map(issue => issue.path)));
  partial.description = "Partial or full update to a retained submission. Omitted fields are retained; supplied fields replace earlier values. Final required fields are checked after merging.";
  // Nested partial objects and full submissions use the ordinary keys. Literal
  // path keys additionally let the model address a particular array item.
  for (const path of paths) {
    if (!Object.hasOwn(partial.properties ?? {}, path)) partial.properties![path] = properties[path] as Schema;
  }
  return {
    schema: partial,
    paths,
    baseline,
    diagnostics,
    merge(values) {
      const patch = cleanupSubmitShape(partial, values).arguments;
      if (!object(patch) || submissionIssues(partial, patch).length) throw new Error("Invalid field repair values");
      const nested = structuredClone(patch);
      for (const path of paths) if (path.includes(".")) delete nested[path];
      // A permitted literal path also explicitly selects its representation.
      for (const path of paths.filter(path => path.includes(".") && Object.hasOwn(patch, path))) {
        const root = path.split(".")[0]!;
        if (replacementGroups.some(group => group.includes(root)) && !Object.hasOwn(nested, root)) nested[root] = {};
      }
      const result = mergeRepairDraft(baseline, nested, replacementGroups);
      for (const path of paths.filter(path => path.includes(".") && Object.hasOwn(patch, path))) {
        const parts = path.split(".");
        const key = parts.pop()!;
        let parent: unknown = result;
        let supplied: unknown = nested;
        for (const part of parts) {
          parent = (parent as Record<string, unknown>)[part];
          supplied = supplied !== null && typeof supplied === "object" ? (supplied as Record<string, unknown>)[part] : undefined;
        }
        // Repeating an identical value is harmless; differing representations
        // have no defined precedence and must not silently overwrite each other.
        if (supplied !== null && typeof supplied === "object" && Object.hasOwn(supplied, key)
          && !isDeepStrictEqual((supplied as Record<string, unknown>)[key], patch[path])) {
          throw new Error(`Conflicting field repair representations at ${path}: nested and literal-path values differ. Supply one representation or identical values.`);
        }
        Object.defineProperty(parent, key, { value: structuredClone(patch[path]), enumerable: true, writable: true, configurable: true });
      }
      return result;
    }
  };
}
