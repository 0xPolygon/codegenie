import type { ToolExecutionResult, ToolResultRecords } from "./llm-runner.js";
import type { ToolResultMeta } from "../types.js";
import { MISSING_FILE_GUIDANCE, withMeta } from "./repository-tool-guidance.js";

function renderRecords({ open, records, separator, close }: ToolResultRecords): string {
  return open + records.join(separator) + close;
}

/** Derive the canonical text and its packable representation together. */
export function createPackableToolResult(packable: ToolResultRecords, meta: ToolResultMeta): ToolExecutionResult {
  return { text: withMeta(renderRecords(packable), meta), packable, meta };
}

/** Keep the longest prefix of whole records that fits with its closing text and status. */
export function packTextToolResult(input: ToolExecutionResult, allowance: number): ToolExecutionResult {
  if (!input.packable || input.isError || input.text.length <= allowance) return input;

  const { packable, sourceLineRange, ...result } = input;
  const { open, records, separator, close, labels } = packable;
  const { deliveredLineRange, ...originalMeta } = input.meta ?? { backend: "text", precision: "text", degraded: false };
  const lineRange = deliveredLineRange ?? sourceLineRange;
  const firstLine = lineRange && lineRange[1] - lineRange[0] + 1 === records.length ? lineRange[0] : undefined;
  let recordChars = records.reduce((total, record) => total + record.length, 0);
  for (let count = records.length - 1; count > 0; count--) {
    recordChars -= records[count]!.length;
    const range: [number, number] | undefined = firstLine === undefined ? undefined : [firstLine, firstLine + count - 1];
    const meta: ToolResultMeta = {
      ...originalMeta,
      truncated: true,
      deliveryStatus: "truncated",
      degradationReason: originalMeta.degradationReason ?? "tool_result_budget",
      omittedCount: (originalMeta.omittedCount ?? 0) + records.length - count,
      ...(range ? { deliveredLineRange: range } : {})
    };
    const notes = ["truncation: tool_result_budget"];
    if (range) {
      const total = meta.totalLines === undefined ? "" : ` of ${meta.totalLines}`;
      notes.push(`delivered lines ${range[0]}-${range[1]}${total}`, `continue with startLine=${range[1] + 1}`);
    } else {
      const last = labels?.[count - 1];
      const next = labels?.[count];
      if (last) notes.push(`last delivered: ${last}`);
      if (next) notes.push(`next: ${next}`);
    }
    const footer = withMeta("", meta, notes);
    const bodyLength = open.length + recordChars + (count - 1) * separator.length + close.length;
    if (bodyLength + footer.length <= allowance) {
      const kept = { open, records: records.slice(0, count), separator, close,
        ...(labels ? { labels: labels.slice(0, count) } : {}) };
      return {
        ...result,
        text: renderRecords(kept) + footer,
        packable: kept,
        meta,
        ...(sourceLineRange && range ? { sourceLineRange: range } : {})
      };
    }
  }

  return {
    text: "Tool result cannot fit the remaining result budget. Narrow the request to retrieve source.",
    isError: true,
    errorCode: "budget_exhausted",
    meta: {
      ...originalMeta,
      truncated: true,
      deliveryStatus: "budget_rejected",
      degradationReason: originalMeta.degradationReason ?? "tool_result_budget",
      omittedCount: (originalMeta.omittedCount ?? 0) + records.length
    }
  };
}

/** Keep whole paths and disclose omissions rather than cutting a filename in half. */
export function packFileListToolResult(input: ToolExecutionResult, allowance: number): ToolExecutionResult {
  if (!input.filePaths) return input;
  const available = input.filePaths;
  const paths: string[] = [];
  const base = input.meta ?? { backend: "text" as const, precision: "exact" as const, degraded: false };
  const backendOmittedCount = base.omittedCount ?? 0;
  const boundedMeta = (budgetOmittedCount: number) => ({
    ...base,
    truncated: true,
    omittedCount: backendOmittedCount + budgetOmittedCount,
    degradationReason: budgetOmittedCount > 0 ? "tool_result_budget" : "list_path_limit"
  });
  const render = () => {
    const budgetOmittedCount = available.length - paths.length;
    const bounded = backendOmittedCount > 0 || budgetOmittedCount > 0 || base.truncated;
    return JSON.stringify({ paths, meta: bounded ? boundedMeta(budgetOmittedCount) : { ...input.meta },
      ...(bounded ? { notice: "Bounded listing. Narrow the glob to inspect omitted paths." } : {}) });
  };
  for (const path of available) {
    paths.push(path);
    if (render().length > allowance) paths.pop();
  }
  const text = render();
  if (text.length > allowance || (available.length > 0 && paths.length === 0)) {
    return { text: "File listing cannot fit the remaining result budget. Narrow the glob; this is not an empty repository result.",
      isError: true, errorCode: "budget_exhausted", meta: { ...boundedMeta(available.length),
        degradationReason: "tool_result_budget",
        deliveryStatus: "budget_rejected", pathListDelivery: { deliveredCount: 0, backendOmittedCount, budgetOmittedCount: available.length } } };
  }
  const budgetOmittedCount = available.length - paths.length;
  const bounded = backendOmittedCount > 0 || budgetOmittedCount > 0 || base.truncated;
  return { ...input, text, meta: { ...(bounded ? boundedMeta(budgetOmittedCount) : base),
    deliveryStatus: bounded ? "truncated" : paths.length > 0 ? "full" : "empty",
    pathListDelivery: { deliveredCount: paths.length, backendOmittedCount, budgetOmittedCount } } };
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
