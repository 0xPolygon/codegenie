import type { DiffRecordGroups, ToolExecutionResult, ToolResultRecords } from "./llm-runner.js";
import type { DeliveredSourceRange, FileOutline, SearchResult, ToolResultMeta } from "../types.js";
import { MAX_OMITTED_DIFF_LABELS } from "../repo/diff-blocks.js";
import { earlierSearchPosition, hasSearchContext, searchContextPosition, searchCutNotice, searchDeliveryMeta } from "../repo/search.js";
import { MISSING_FILE_GUIDANCE, numberSourceLine, renderSourceBlockHeader, withMeta } from "./repository-tool-guidance.js";

function renderRecordOpening(open: string, meta: ToolResultMeta): string {
  const { requestedRange, sourceUsed, deliveredLineRange, totalLines } = meta;
  if (!requestedRange || !sourceUsed || !deliveredLineRange || totalLines === undefined) return open;
  return open + renderSourceBlockHeader(requestedRange.path, sourceUsed, deliveredLineRange, totalLines) + "\n";
}

function pageDeliveryNotes(meta: ToolResultMeta): string[] {
  const search = meta.searchDelivery;
  if (search) {
    const notes = [`delivered matches: ${search.deliveredCount}`];
    if (search.emptyScope) notes.push(`No tracked files match pathGlob at the pinned ${search.source} revision.`);
    if (search.shortenedExcerpts) notes.push("Some matching lines are excerpts. Use read_range at the numbered match to inspect the line.");
    if (search.backendOmittedCount) {
      const next = search.nextRead;
      notes.push(`matching lines omitted by the Git output cap: ${search.backendOmittedCount}${next ? `; inspect ${JSON.stringify(next.path)}@${search.source}:${next.line} with read_range` : ""}`);
    }
    return notes;
  }
  return meta.pathListDelivery ? [`delivered paths: ${meta.pathListDelivery.deliveredCount}`] : [];
}

function updatePageDelivery(meta: ToolResultMeta, records: ToolResultRecords, count: number, refused = false): ToolResultMeta {
  const budgetOmitted = records.records.length - count;
  if (records.searchExcerptFlags && meta.searchDelivery) {
    return searchDeliveryMeta(meta, {
      ...meta.searchDelivery, deliveredCount: count,
      budgetOmittedCount: meta.searchDelivery.budgetOmittedCount + budgetOmitted,
      shortenedExcerpts: records.searchExcerptFlags.slice(0, count).filter(Boolean).length
    }, refused);
  }
  if (meta.pathListDelivery) {
    return { ...meta, pathListDelivery: {
      ...meta.pathListDelivery, deliveredCount: count,
      budgetOmittedCount: meta.pathListDelivery.budgetOmittedCount + budgetOmitted
    } };
  }
  return meta;
}

/** Derive the canonical text and its packable representation together. */
export function createPackableToolResult(packable: ToolResultRecords, meta: ToolResultMeta): ToolExecutionResult {
  const { open, records, separator, close, diffGroups, labels, nextPage } = packable;
  const notes = diffGroups && meta.truncated
    ? [`truncation: ${meta.degradationReason ?? "diff_result_limit"}`, ...diffDeliveryNotes(diffGroups, meta.omittedCount ?? 0, records.length, labels?.at(-1))]
    : [];
  notes.push(...pageDeliveryNotes(meta));
  if (nextPage) notes.push(`next: ${nextPage}`);
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
  if (groups.next) notes.push(groups.nextCursor
    ? `next: ${groups.next}, cursor=${groups.nextCursor}; continue with read_change and the same selector and context`
    : `next: ${groups.next}; ${count ? "use read_range at the stated revision" : "use read_range or narrow search_files at the stated revision"}`);
  if (omittedCount) {
    const other = omittedCount - groups.omittedLabels.length;
    notes.push(`omitted ${groups.groupedHunks ? "change blocks" : "hunks"}: ${groups.omittedLabels.join(" | ")}${other > 0 ? ` | ${other} more` : ""}`);
  }
  return notes;
}

function diffGroupsAfterCut(groups: DiffRecordGroups, count: number, next: string | undefined, cursor?: string) {
  const rendered = groups.rendered.filter(hunk => hunk.firstRecord < count);
  const omitted = groups.rendered.slice(rendered.length);
  const nextPosition = next ?? groups.next;
  const nextCursor = cursor ?? groups.nextCursor;
  return {
    omittedCount: omitted.length,
    groups: {
      rendered,
      lineEnds: groups.lineEnds,
      omittedLabels: [...omitted.map(hunk => hunk.label), ...groups.omittedLabels].slice(0, MAX_OMITTED_DIFF_LABELS),
      ...(groups.groupedHunks ? { groupedHunks: true } : {}),
      ...(nextPosition ? { next: nextPosition } : {}),
      ...(nextCursor ? { nextCursor } : {})
    }
  };
}

/** Keep the longest prefix of whole records that fits with its closing text and status. */
export function packTextToolResult(input: ToolExecutionResult, allowance: number): ToolExecutionResult {
  if (!input.packable || input.isError || input.text.length <= allowance) return input;
  if (input.budgetFallback) return packTextToolResult(input.budgetFallback, allowance);

  const { packable, sourceLineRange, rawSource: _rawSource, ...result } = input;
  const { open, records, separator, close, labels, keepWithNext, diffGroups } = packable;
  const unreadAt = (index: number): string | undefined => {
    const label = labels?.[index];
    const cursor = packable.cursors?.[index];
    return cursor ? `${label ? `${label}, ` : ""}cursor=${cursor}` : label;
  };
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
    const diffCut = diffGroups ? diffGroupsAfterCut(diffGroups, count, labels?.[count], packable.cursors?.[count]) : undefined;
    const meta = updatePageDelivery({
      ...originalMeta,
      truncated: true,
      deliveryStatus: "truncated",
      degradationReason,
      omittedCount: (originalMeta.omittedCount ?? 0) + (diffCut?.omittedCount ?? records.length - count),
      ...(range ? { deliveredLineRange: range } : {})
    }, packable, count);
    const notes = ["truncation: tool_result_budget"];
    notes.push(...pageDeliveryNotes(meta));
    if (diffCut) {
      notes.push(...diffDeliveryNotes(diffCut.groups, meta.omittedCount ?? 0, count, labels?.[count - 1]));
    } else if (!range) {
      const last = labels?.[count - 1];
      const next = unreadAt(count);
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
        ...(packable.cursors ? { cursors: packable.cursors.slice(0, count) } : {}),
        ...(packable.searchExcerptFlags ? { searchExcerptFlags: packable.searchExcerptFlags.slice(0, count) } : {}),
        ...(packable.recordRanges ? { recordRanges: packable.recordRanges.slice(0, count) } : {}),
        ...(diffCut ? { diffGroups: { ...diffCut.groups, lineEnds: diffCut.groups.lineEnds.slice(0, count) } } : {}) };
      return {
        ...result,
        text: deliveredOpening + kept.records.join(separator) + deliveredClosing + footer,
        packable: kept,
        meta,
        ...(input.searchResults && packable.searchExcerptFlags ? { searchResults: input.searchResults.slice(0, count) } : {}),
        ...(sourceLineRange && range ? { sourceLineRange: range } : {})
      };
    }
  }

  const refusalMeta = updatePageDelivery({
    ...originalMeta,
    truncated: true,
    deliveryStatus: "budget_rejected",
    degradationReason,
    omittedCount: (originalMeta.omittedCount ?? 0) + (diffGroups?.rendered.length ?? records.length)
  }, packable, 0, true);
  const firstUnread = unreadAt(0);
  const refusal = "Tool result cannot fit the remaining result budget. Narrow the request to retrieve source."
    + (firstUnread && !diffGroups ? ` First unread source: ${firstUnread}.` : "");
  return {
    text: diffGroups ? withMeta(refusal, refusalMeta, diffDeliveryNotes(diffGroupsAfterCut(diffGroups, 0, labels?.[0], packable.cursors?.[0]).groups,
      refusalMeta.omittedCount ?? 0, 0)) : originalMeta.requestedRange || packable.searchExcerptFlags || originalMeta.pathListDelivery
      ? withMeta(refusal, refusalMeta, pageDeliveryNotes(refusalMeta)) : refusal,
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
  if (input.packable) return packTextToolResult(input, allowance);
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
    if (delivery) return JSON.stringify({ results, meta,
      ...(delivery.emptyScope ? { notice: `No tracked files match pathGlob at the pinned ${delivery.source} revision.` } : {}) });
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
  return { ...input, text, searchResults: results, meta: reportedMeta ?? { ...meta,
    ...(omitted || shortened ? { degraded: meta.degraded || omitted > (meta.omittedCount ?? 0), truncated: true, omittedCount: omitted, omittedCountIsLowerBound: true } : {}) } };
}

/** An excerpt proves visibility of its surrounding whole lines only. */
export function searchHitRanges(hit: SearchResult, side: DeliveredSourceRange["side"], totalLines = Infinity): DeliveredSourceRange[] {
  const before = hit.contextBefore?.length ?? 0;
  const after = Math.min(hit.contextAfter?.length ?? 0, totalLines - hit.line);
  const ranges: DeliveredSourceRange[] = [];
  if (!hit.excerpt) ranges.push({ path: hit.path, side, lineRange: [hit.line - before, hit.line + after] });
  else {
    if (before) ranges.push({ path: hit.path, side, lineRange: [hit.line - before, hit.line - 1] });
    if (after > 0) ranges.push({ path: hit.path, side, lineRange: [hit.line + 1, hit.line + after] });
  }
  return ranges;
}

/** Keep outlines parseable under local caps; never present a chopped sourceText as complete. */
export function renderOutlineToolResult(outline: FileOutline, meta: ToolResultMeta, packed = false): string {
  const { sourceText, ...fields } = outline;
  const description = { ...fields, notes: fields.notes.map(note => note.replace("Read sourceText or use read_range",
    sourceText?.text ? "Read the numbered source or use read_range" : "Use read_range")) };
  const source = meta.sourceUsed ?? "head";
  const total = meta.totalLines;
  const note = total !== undefined
    ? `${outline.path}@${source}: ${total} lines. ${sourceText?.text ? "Numbered source follows." : "Source lines delivered: none; declaration ranges are listed above."}`
    : "";
  const next = meta.recovery;
  const continuation = next ? `Continue with read_range at ${next.path}@${next.source} startLine=${next.startLine}, endLine=${next.endLine}.` : "";
  const { recovery: _recovery, totalLines: _totalLines, ...compactMeta } = meta;
  const text = packed
    ? JSON.stringify({ outline: description, meta: compactMeta,
      notice: ["Bounded outline. Omitted symbols do not imply absence.", note, continuation].filter(Boolean).join(" ") })
    : withMeta(JSON.stringify(description, null, 2), meta, [note, continuation].filter(Boolean));
  if (!sourceText?.text) return text;
  const { startLine, endLine } = sourceText;
  const positioned = sourceText.text.split("\n").slice(0, endLine - startLine + 1)
    .map((line, index) => numberSourceLine(line, startLine + index));
  return [text, renderSourceBlockHeader(outline.path, source, [startLine, endLine], total ?? endLine), ...positioned].join("\n");
}

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
  let nextLine = input.meta?.recovery?.startLine ?? Infinity;
  const totalLines = input.meta?.totalLines;
  const recordOmission = (line?: number) => {
    omitted++;
    changed = true;
    if (line !== undefined) nextLine = Math.min(nextLine, line);
  };
  const meta = () => ({ backend: "text" as const, precision: "heuristic" as const, degraded: false,
    ...input.meta, ...(changed ? { truncated: true, deliveryStatus: "truncated" as const,
      degradationReason: (input.meta?.degraded ? input.meta.degradationReason : undefined) ?? "tool_result_budget",
      omittedCount: omitted, omittedCountIsLowerBound: true,
      ...(totalLines !== undefined && nextLine <= totalLines ? { recovery: {
        tool: "read_range" as const, path: outline.path, source: input.meta?.sourceUsed ?? "head",
        startLine: nextLine, endLine: Math.min(totalLines, nextLine + 79), reason: "first source position affected by the outline delivery budget"
      } } : {})
    } : {}) });
  const render = () => renderOutlineToolResult(outline, meta(), true);
  if (render().length > allowance && outline.sourceText) {
    outline.sourceReadHint = { tool: "read_range", path: outline.path,
      startLine: outline.sourceText.startLine, endLine: Math.min(outline.sourceText.endLine, outline.sourceText.startLine + 79) };
    recordOmission(outline.sourceText.startLine);
    delete outline.sourceText;
  }
  for (const entries of [outline.testSymbols, outline.topLevelSymbols, outline.imports, outline.notes]) {
    while (entries.length && render().length > allowance) {
      const entry = entries.pop();
      recordOmission(typeof entry === "object" ? entry.lineRange[0] : entries === outline.imports ? 1 : undefined);
    }
  }
  if (render().length > allowance) {
    const refusalMeta = { ...meta(), truncated: true, deliveryStatus: "budget_rejected" as const,
      degradationReason: (input.meta?.degraded ? input.meta.degradationReason : undefined) ?? "tool_result_budget" };
    return { text: withMeta("Outline cannot fit the remaining result budget. Use a known read_range; this is not an empty file.", refusalMeta),
      isError: true, errorCode: "budget_exhausted", meta: refusalMeta };
  }
  return { ...input, text: render(), outline, meta: meta() };
}
