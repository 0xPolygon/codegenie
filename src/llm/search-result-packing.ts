import type { ToolExecutionResult } from "./llm-runner.js";

/** Pack whole entries after cache lookup, never mutate the shared canonical result. */
export function packSearchToolResult(input: ToolExecutionResult, allowance: number): ToolExecutionResult {
  if (!input.searchResults) return input;
  let results = structuredClone(input.searchResults);
  let omitted = input.meta?.omittedCount ?? 0;
  let shortened = false;
  const render = (): string => JSON.stringify({
    results,
    meta: { ...input.meta, ...(omitted || shortened ? { degraded: input.meta?.degraded || omitted > (input.meta?.omittedCount ?? 0), truncated: true, omittedCount: omitted, omittedCountIsLowerBound: true } : {}) },
    ...(omitted || shortened || input.meta?.truncated ? { notice: "Bounded results, not exhaustive. Optional context/excerpts may be shortened. Omitted count is a lower bound. Narrow pathGlob or read a known range." } : {})
  });
  if (render().length > allowance) {
    shortened = true;
    for (const result of results) {
      delete result.enclosingSymbol;
      delete result.contextBefore;
      delete result.contextAfter;
    }
  }
  if (render().length > allowance) {
    const available = results;
    results = [];
    // Reserve the omission notice before admitting entries; an oversized first
    // match must not evict later matches that fit.
    omitted += available.length;
    for (const result of available) {
      results.push(result);
      omitted--;
      if (render().length > allowance) { results.pop(); omitted++; }
    }
  }
  if (render().length > allowance || (input.searchResults.length > 0 && results.length === 0)) {
    return { text: "Search results could not fit the remaining result budget. Narrow pathGlob or read a known range; this is not a zero-match result.", isError: true, errorCode: "budget_exhausted",
      ...(input.meta ? { meta: { ...input.meta, truncated: true, deliveryStatus: "budget_rejected" } } : {}) };
  }
  return { ...input, text: render(), ...(input.meta ? { meta: { ...input.meta,
    ...(omitted || shortened ? { degraded: input.meta.degraded || omitted > (input.meta.omittedCount ?? 0), truncated: true, omittedCount: omitted, omittedCountIsLowerBound: true } : {}) } } : {}) };
}
