import type { ToolExecutionResult } from "./llm-runner.js";
import { MISSING_FILE_GUIDANCE } from "./repository-tool-guidance.js";

/** Keep whole paths and disclose omissions rather than cutting a filename in half. */
export function packFileListToolResult(input: ToolExecutionResult, allowance: number): ToolExecutionResult {
  if (!input.filePaths) return input;
  const paths: string[] = [];
  let omitted = (input.meta?.omittedCount ?? 0) + input.filePaths.length;
  const render = () => JSON.stringify({ paths, meta: { ...input.meta,
    ...(omitted ? { degraded: true, truncated: true, omittedCount: omitted, omittedCountIsLowerBound: true } : {}) },
    ...(omitted || input.meta?.truncated ? { notice: "Bounded listing, not exhaustive. Narrow the glob to inspect omitted paths." } : {}) });
  for (const path of input.filePaths) {
    paths.push(path);
    omitted--;
    if (render().length > allowance) { paths.pop(); omitted++; }
  }
  if (render().length > allowance || (input.filePaths.length > 0 && paths.length === 0)) {
    return { text: "File listing cannot fit the remaining result budget. Narrow the glob; this is not an empty repository result.",
      isError: true, errorCode: "budget_exhausted", meta: { backend: "text", precision: "text",
        ...input.meta, degraded: true, truncated: true, deliveryStatus: "budget_rejected" } };
  }
  return { ...input, text: render(), ...(omitted ? { meta: { backend: "text", precision: "text",
    ...input.meta, degraded: true, truncated: true, omittedCount: omitted, omittedCountIsLowerBound: true } } : {}) };
}

/** Pack whole entries after cache lookup, never mutate the shared canonical result. */
export function packSearchToolResult(input: ToolExecutionResult, allowance: number): ToolExecutionResult {
  if (!input.searchResults) return input;
  const meta = input.meta ?? { backend: "text" as const, precision: "text" as const, degraded: false };
  let results = structuredClone(input.searchResults);
  let omitted = meta.omittedCount ?? 0;
  let shortened = false;
  const render = (): string => JSON.stringify({
    results,
    meta: { ...meta, ...(omitted || shortened ? { degraded: meta.degraded || omitted > (meta.omittedCount ?? 0), truncated: true, omittedCount: omitted, omittedCountIsLowerBound: true } : {}) },
    ...(omitted || shortened || meta.truncated ? { notice: "Bounded results, not exhaustive. Optional context/excerpts may be shortened. Omitted count is a lower bound. Narrow pathGlob or read a known range." } : {})
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
      meta: { ...meta, degraded: true, truncated: true, deliveryStatus: "budget_rejected" } };
  }
  return { ...input, text: render(), meta: { ...meta,
    ...(omitted || shortened ? { degraded: meta.degraded || omitted > (meta.omittedCount ?? 0), truncated: true, omittedCount: omitted, omittedCountIsLowerBound: true } : {}) } };
}

/** Keep outlines parseable under local caps; never present a chopped sourceText as complete. */
export function packOutlineToolResult(input: ToolExecutionResult, allowance: number): ToolExecutionResult {
  if (!input.outline || input.text.length <= allowance) return input;
  if (input.meta?.lookupStatus === "file_missing") {
    // There is no source outline to shorten. Preserve the lookup result and
    // recovery instructions instead of implying that source was truncated.
    const text = JSON.stringify({ meta: input.meta, notice: MISSING_FILE_GUIDANCE });
    if (text.length <= allowance) return { ...input, text };
    return { text: "Missing-file guidance cannot fit the remaining result budget. Discover a path at the intended revision before reading.",
      isError: true, errorCode: "budget_exhausted", meta: { ...input.meta, truncated: true, deliveryStatus: "budget_rejected" } };
  }
  const outline = structuredClone(input.outline);
  let omitted = input.meta?.omittedCount ?? 0;
  let changed = false;
  const meta = () => ({ backend: "text" as const, precision: "heuristic" as const, degraded: false,
    ...input.meta, ...(changed ? { degraded: true, truncated: true, deliveryStatus: "truncated" as const,
      omittedCount: omitted, omittedCountIsLowerBound: true } : {}) });
  const render = () => JSON.stringify({ outline, meta: meta(), notice: "Bounded outline. Use search_files to locate source, then read_range; omitted symbols do not imply absence." });
  if (render().length > allowance && outline.sourceText) {
    outline.sourceReadHint = { tool: "read_range", path: outline.path,
      startLine: outline.sourceText.startLine, endLine: Math.min(outline.sourceText.endLine, outline.sourceText.startLine + 79) };
    delete outline.sourceText;
    omitted++;
    changed = true;
  }
  for (const entries of [outline.testSymbols, outline.topLevelSymbols, outline.imports, outline.notes]) {
    while (entries.length && render().length > allowance) {
      entries.pop();
      omitted++;
      changed = true;
    }
  }
  if (render().length > allowance) return { text: "Outline cannot fit the remaining result budget. Use search_files or a known read_range; this is not an empty file.",
    isError: true, errorCode: "budget_exhausted", meta: { ...meta(), degraded: true, truncated: true, deliveryStatus: "budget_rejected" } };
  return { ...input, text: render(), meta: meta() };
}
