export function stableJson(input: unknown): string {
  return JSON.stringify(sortJson(input));
}

export function prettyStableJson(input: unknown): string {
  return JSON.stringify(sortJson(input), null, 2);
}

export function sortJson(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(sortJson);
  }
  if (input && typeof input === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      output[key] = sortJson((input as Record<string, unknown>)[key]);
    }
    return output;
  }
  return input;
}
