import type { DiffRecordGroups, ToolExecutionResult, ToolResultRecords } from "./llm-runner.js";
import type { ToolResultMeta } from "../types.js";
import { MAX_OMITTED_DIFF_LABELS } from "../repo/diff-blocks.js";
import { earlierSearchPosition, hasSearchContext, searchContextPosition, searchCutNotice, searchDeliveryMeta } from "../repo/search.js";
import { MISSING_FILE_GUIDANCE, renderSourceBlockHeader, withMeta } from "./repository-tool-guidance.js";

function renderRecordOpening(open: string, meta: ToolResultMeta): string {
  const { requestedRange, sourceUsed, deliveredLineRange, totalLines } = meta;
  if (!requestedRange || !sourceUsed || !deliveredLineRange || totalLines === undefined) return open;
  return open + renderSourceBlockHeader(requestedRange.path, sourceUsed, deliveredLineRange, totalLines) + "\n";
}

/** Derive the canonical text and its packable representation together. */
export function createPackableToolResult(packable: ToolResultRecords, meta: ToolResultMeta): ToolExecutionResult {
  const { open, records, separator, close, diffGroups, labels } = packable;
  const notes = diffGroups && meta.truncated
    ? [`truncation: ${meta.degradationReason ?? "diff_result_limit"}`, ...diffDeliveryNotes(diffGroups, meta.omittedCount ?? 0, records.length, labels?.at(-1))]
    : [];
  return { text: withMeta(renderRecordOpening(open, meta) + records.join(separator) + close, meta, notes), packable, meta };
}

function diffDeliveryNotes(groups: DiffRecordGroups, omittedCount: number, count: number, last?: string): string[] {
  const notes: string[] = [];
  const hunk = groups.rendered.at(-1);
  const ends = groups.lineEnds[count - 1];
  if (last && hunk && ends) {
    const [base, head] = ends;
    notes.push(`last delivered: ${last}`,
      `last hunk delivered: base ${base === undefined ? "none" : `${hunk.baseStart}-${base}`}, head ${head === undefined ? "none" : `${hunk.headStart}-${head}`}`);
  }
  if (groups.next) notes.push(`next: ${groups.next}; use read_range at the stated revision`);
  if (omittedCount) {
    const other = omittedCount - groups.omittedLabels.length;
    notes.push(`omitted hunks: ${groups.omittedLabels.join(" | ")}${other > 0 ? ` | ${other} more` : ""}`);
  }
  return notes;
}

function diffGroupsAfterCut(groups: DiffRecordGroups, count: number, next: string | undefined) {
  const rendered = groups.rendered.filter(hunk => hunk.firstRecord < count);
  const omitted = groups.rendered.slice(rendered.length);
  const nextPosition = next ?? groups.next;
  return {
    omittedCount: omitted.length,
    groups: {
      rendered,
      lineEnds: groups.lineEnds,
      omittedLabels: [...omitted.map(hunk => hunk.label), ...groups.omittedLabels].slice(0, MAX_OMITTED_DIFF_LABELS),
      ...(nextPosition ? { next: nextPosition } : {})
    }
  };
}

/** Keep the longest prefix of whole records that fits with its closing text and status. */
export function packTextToolResult(input: ToolExecutionResult, allowance: number): ToolExecutionResult {
  if (!input.packable || input.isError || input.text.length <= allowance) return input;

  const { packable, sourceLineRange, ...result } = input;
  const { open, records, separator, close, labels, keepWithNext, diffGroups } = packable;
  // A backend continuation may be beyond the first line omitted by this cut.
  // The range/record locator below is the authoritative caller continuation.
  const { deliveredLineRange, recovery: _backendRecovery, ...originalMeta } = input.meta ?? { backend: "text", precision: "text", degraded: false };
  const degradationReason = (originalMeta.degraded ? originalMeta.degradationReason : undefined) ?? "tool_result_budget";
  const lineRange = deliveredLineRange ?? sourceLineRange;
  const firstLine = lineRange && lineRange[1] - lineRange[0] + 1 === records.length ? lineRange[0] : undefined;
  // A range clipped before EOF does not carry the original file's terminal newline.
  const deliveredClosing = originalMeta.requestedRange ? "" : close;
  let recordChars = records.reduce((total, record) => total + record.length, 0);
  for (let count = records.length - 1; count > 0; count--) {
    recordChars -= records[count]!.length;
    if (keepWithNext?.[count - 1]) continue;
    const range: [number, number] | undefined = firstLine === undefined ? undefined : [firstLine, firstLine + count - 1];
    const diffCut = diffGroups ? diffGroupsAfterCut(diffGroups, count, labels?.[count]) : undefined;
    const meta: ToolResultMeta = {
      ...originalMeta,
      truncated: true,
      deliveryStatus: "truncated",
      degradationReason,
      omittedCount: (originalMeta.omittedCount ?? 0) + (diffCut?.omittedCount ?? records.length - count),
      ...(range ? { deliveredLineRange: range } : {})
    };
    const notes = ["truncation: tool_result_budget"];
    if (diffCut) {
      notes.push(...diffDeliveryNotes(diffCut.groups, meta.omittedCount ?? 0, count, labels?.[count - 1]));
    } else if (!range) {
      const last = labels?.[count - 1];
      const next = labels?.[count];
      if (last) notes.push(`last delivered: ${last}`);
      if (next) notes.push(`next: ${next}`);
    }
    const footer = withMeta("", meta, notes);
    const deliveredOpening = renderRecordOpening(open, meta);
    const bodyLength = deliveredOpening.length + recordChars + (count - 1) * separator.length + deliveredClosing.length;
    if (bodyLength + footer.length <= allowance) {
      const kept = { open, records: records.slice(0, count), separator, close: deliveredClosing,
        ...(labels ? { labels: labels.slice(0, count) } : {}),
        ...(keepWithNext ? { keepWithNext: keepWithNext.slice(0, count) } : {}),
        ...(diffCut ? { diffGroups: { ...diffCut.groups, lineEnds: diffCut.groups.lineEnds.slice(0, count) } } : {}) };
      return {
        ...result,
        text: deliveredOpening + kept.records.join(separator) + deliveredClosing + footer,
        packable: kept,
        meta,
        ...(sourceLineRange && range ? { sourceLineRange: range } : {})
      };
    }
  }

  const refusalMeta: ToolResultMeta = {
    ...originalMeta,
    truncated: true,
    deliveryStatus: "budget_rejected",
    degradationReason,
    omittedCount: (originalMeta.omittedCount ?? 0) + (diffGroups?.rendered.length ?? records.length)
  };
  const firstUnread = labels?.[0];
  const refusal = "Tool result cannot fit the remaining result budget. Narrow the request to retrieve source."
    + (firstUnread && !diffGroups ? ` First unread source: ${firstUnread}.` : "");
  return {
    text: diffGroups ? withMeta(refusal, refusalMeta, diffDeliveryNotes(diffGroupsAfterCut(diffGroups, 0, firstUnread).groups,
      refusalMeta.omittedCount ?? 0, 0)) : originalMeta.requestedRange ? withMeta(refusal, refusalMeta) : refusal,
    isError: true,
    errorCode: "budget_exhausted",
    meta: refusalMeta
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
  const { searchDelivery, ...meta } = input.meta ?? { backend: "text" as const, precision: "text" as const, degraded: false };
  const canonical = input.searchResults;
  let results = structuredClone(canonical);
  let omitted = meta.omittedCount ?? 0;
  let shortened = false;
  let firstBudgetOmitted: (typeof canonical)[number] | undefined;
  let nextUnconsidered: (typeof canonical)[number] | undefined;
  const firstContext = searchDelivery ? canonical.find(hasSearchContext) : undefined;
  const deliveryFor = (refused = false) => {
    if (!searchDelivery) return undefined;
    const nextMissing = refused ? canonical[0] : earlierSearchPosition(firstBudgetOmitted, nextUnconsidered);
    const nextRead = earlierSearchPosition(
      searchDelivery.nextRead,
      earlierSearchPosition(nextMissing, shortened && firstContext ? searchContextPosition(firstContext) : undefined)
    );
    const deliveredCount = refused ? 0 : results.length;
    return {
      ...searchDelivery, deliveredCount,
      budgetOmittedCount: canonical.length - deliveredCount,
      shortenedExcerpts: refused ? 0 : results.filter(result => result.excerpt).length,
      budgetContextStripped: shortened && firstContext !== undefined,
      ...(nextRead ? { nextRead: { path: nextRead.path, line: nextRead.line } } : {})
    };
  };
  const render = (): string => {
    const delivery = deliveryFor();
    const bounded = delivery && searchDeliveryMeta(meta, delivery);
    if (bounded?.truncated && delivery) {
      const { backend, precision, degraded, truncated, omittedCount, omittedCountIsLowerBound, discoveryLimited } = bounded;
      return JSON.stringify({ results,
        meta: { backend, precision, degraded, truncated, omittedCount, omittedCountIsLowerBound, discoveryLimited },
        notice: searchCutNotice(delivery)
      });
    }
    if (delivery) return JSON.stringify({ results, meta });
    return JSON.stringify({
      results,
      meta: { ...meta, ...(omitted || shortened ? { degraded: meta.degraded || omitted > (meta.omittedCount ?? 0), truncated: true, omittedCount: omitted, omittedCountIsLowerBound: true } : {}) },
      ...(omitted || shortened || meta.truncated ? { notice: "Bounded results, not exhaustive. Optional context/excerpts may be shortened. Omitted count is a lower bound. Narrow pathGlob or read a known range." } : {})
    });
  };
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
    for (const [index, result] of available.entries()) {
      nextUnconsidered = available[index + 1];
      results.push(result);
      omitted--;
      if (render().length > allowance) {
        results.pop();
        omitted++;
        firstBudgetOmitted ??= result;
      }
    }
  }
  const text = render();
  const refused = text.length > allowance || (canonical.length > 0 && results.length === 0);
  const delivery = deliveryFor(refused);
  const reportedMeta = delivery && searchDeliveryMeta(meta, delivery, refused);
  if (refused) {
    const refusal = "Search results could not fit the remaining result budget. This is not a zero-match result.";
    return { text: delivery ? `${refusal} ${searchCutNotice(delivery)}`
      : "Search results could not fit the remaining result budget. Narrow pathGlob or read a known range; this is not a zero-match result.", isError: true, errorCode: "budget_exhausted",
      meta: reportedMeta ?? { ...meta, degraded: true, truncated: true, deliveryStatus: "budget_rejected" } };
  }
  return { ...input, text, meta: reportedMeta ?? { ...meta,
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
