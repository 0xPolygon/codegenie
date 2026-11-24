/** Check the serialized schema sent to providers, reporting every offending path. */
export function portableSchemaIssues(name: string, schema: unknown): string[] {
  const issues: string[] = [];
  const allowed = new Set(["type", "properties", "required", "additionalProperties", "items", "minItems", "maxItems",
    "enum", "minLength", "maxLength", "minimum", "maximum", "description", "const", "anyOf"]);
  const primitive = new Set(["string", "integer", "number", "boolean"]);
  const walk = (input: unknown, path: string, root: boolean) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) { issues.push(`${path}: expected schema object`); return; }
    const node = input as Record<string, unknown>;
    for (const key of Object.keys(node)) if (!allowed.has(key)) issues.push(`${path}.${key}: unsupported keyword`);
    if (node.additionalProperties !== undefined && node.additionalProperties !== false) issues.push(`${path}.additionalProperties: must be false`);
    if (node.anyOf !== undefined) {
      if (root || !Array.isArray(node.anyOf) || node.anyOf.some(item => {
        if (!item || typeof item !== "object") return true;
        const variant = item as Record<string, unknown>;
        return !primitive.has(variant.type as string) || (variant.const === undefined && !Array.isArray(variant.enum));
      })) {
        issues.push(`${path}.anyOf: only nested typed primitive literal variants are permitted`);
      }
      if (Array.isArray(node.anyOf)) node.anyOf.forEach((item, index) => walk(item, `${path}.anyOf[${index}]`, false));
    } else if (typeof node.type !== "string" || !new Set([...primitive, "object", "array"]).has(node.type)) {
      issues.push(`${path}.type: expected one supported type`);
    }
    if (node.const !== undefined && typeof node.type !== "string") issues.push(`${path}.const: requires a type`);
    if (node.enum !== undefined && (node.type !== "string" || !Array.isArray(node.enum) || node.enum.some(value => typeof value !== "string"))) {
      issues.push(`${path}.enum: requires string values and string type`);
    }
    if (node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)) {
      for (const [key, value] of Object.entries(node.properties)) walk(value, `${path}.properties.${key}`, false);
    }
    if (node.items !== undefined) walk(node.items, `${path}.items`, false);
  };
  walk(JSON.parse(JSON.stringify(schema)), name, true);
  return issues;
}
