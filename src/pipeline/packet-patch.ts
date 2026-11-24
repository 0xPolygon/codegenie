import { renderNumberedDiffLine } from "../repo/numbered-diff.js";
import { credentialSafeCut } from "../telemetry/redaction.js";
import type { PacketHunk, PacketLine } from "../types.js";

export const MAX_PATCH_CHARS = 12_000;
const CONTEXT_MARGIN = 2;
const COMPACT_CUT_NOTICE = "[Changed rows omitted or clipped. See omittedChangedRanges for exact positions.]";

type Patch = Pick<PacketHunk, "lines" | "contentWithLineNumbers" | "truncated" | "omittedLineCount" |
  "omittedChangedLineCount" | "omittedChangedRanges" | "partialChangedLine"> & {
    decisionChars?: number;
    boundaryRetreatChars?: number;
  };
type ChangedRanges = NonNullable<Patch["omittedChangedRanges"]>;

export function packPacketPatch(lines: PacketLine[]): Patch {
  const rendered = lines.map(renderNumberedDiffLine);
  const full = rendered.join("\n");
  if (full.length <= MAX_PATCH_CHARS) return { lines, contentWithLineNumbers: full };

  const changed = new Set<number>();
  const withContext = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.kind === "context") continue;
    changed.add(i);
    for (let j = Math.max(0, i - CONTEXT_MARGIN); j <= Math.min(lines.length - 1, i + CONTEXT_MARGIN); j++) {
      withContext.add(j);
    }
  }
  const retainedContext = renderSelection(lines, rendered, withContext);
  if (retainedContext.length <= MAX_PATCH_CHARS) return patchResult(lines, withContext, retainedContext);
  const onlyChanged = renderSelection(lines, rendered, changed);
  if (onlyChanged.length <= MAX_PATCH_CHARS) return patchResult(lines, changed, onlyChanged);
  const changedText = [...changed].map(index => rendered[index]!).join("\n");
  if (changedText.length <= MAX_PATCH_CHARS) return patchResult(lines, changed, changedText);

  const allowance = MAX_PATCH_CHARS - COMPACT_CUT_NOTICE.length - 1;
  const selected = fitChangedBlocks(changed, rendered, allowance);
  if (selected.size) {
    const detailed = renderSelection(lines, rendered, selected);
    const text = detailed.length <= MAX_PATCH_CHARS ? detailed
      : [...selected].map(index => rendered[index]!).concat(COMPACT_CUT_NOTICE).join("\n");
    return patchResult(lines, selected, text);
  }

  // A single enormous changed row can exceed the allowance on its own.
  const first = changed.values().next().value!;
  if (rendered[first]!.length <= MAX_PATCH_CHARS) {
    return patchResult(lines, new Set([first]), rendered[first]!);
  }
  const row = lines[first]!;
  const side = row.kind === "add" ? "new" : "old";
  const line = side === "new" ? row.newLine! : row.oldLine!;
  const empty = renderNumberedDiffLine({ ...row, content: "" });
  const sampleMarker = ` [... ${row.content.length} chars truncated ...]`;
  const notice = (omittedChars: number) => `[${side} changed line ${line} is partial. ${omittedChars} of ${row.content.length} characters omitted.]`;
  let prefixChars = MAX_PATCH_CHARS - empty.length - sampleMarker.length - notice(row.content.length).length - 1;
  if (/[\uDC00-\uDFFF]/u.test(row.content.charAt(prefixChars))) prefixChars = Math.max(0, prefixChars - 1);
  const safeEnd = credentialSafeCut(row.content, prefixChars);
  const omittedChars = row.content.length - safeEnd;
  const renderClipped = (end: number) => ({ ...row,
    content: row.content.slice(0, end) + ` [... ${row.content.length - end} chars truncated ...]` });
  const clipped = renderClipped(safeEnd);
  const renderPartial = (line: PacketLine, omitted: number) => [renderNumberedDiffLine(line), notice(omitted)].join("\n");
  return {
    ...patchResult(lines, new Set(), renderPartial(clipped, omittedChars)),
    lines: [clipped],
    omittedLineCount: lines.length - 1,
    partialChangedLine: { side, line, omittedChars, totalChars: row.content.length },
    ...(safeEnd !== prefixChars ? {
      decisionChars: renderPartial(renderClipped(prefixChars), row.content.length - prefixChars).length,
      boundaryRetreatChars: prefixChars - safeEnd
    } : {})
  };
}

function fitChangedBlocks(changed: Set<number>, rendered: string[], allowance: number): Set<number> {
  const blocks: number[][] = [];
  for (const index of changed) {
    const block = blocks.at(-1);
    if (block?.at(-1) === index - 1) block.push(index);
    else blocks.push([index]);
  }
  const selected = new Set<number>();
  let remaining = allowance + 1;
  for (const block of blocks) {
    const cost = block.reduce((total, index) => total + rendered[index]!.length + 1, 0);
    if (cost > remaining) continue;
    for (const index of block) selected.add(index);
    remaining -= cost;
  }
  return selected.size ? selected : fitWholeRowWindow(blocks, rendered, allowance);
}

function fitWholeRowWindow(blocks: number[][], rendered: string[], allowance: number): Set<number> {
  // When no complete block fits, retain the most whole rows in a contiguous
  // window. Equal-sized windows keep the earliest position.
  let best = { block: [] as number[], start: 0, length: 0 };
  for (const block of blocks) {
    let start = 0;
    let cost = 0;
    for (let end = 0; end < block.length; end++) {
      cost += rendered[block[end]!]!.length + 1;
      while (cost > allowance + 1) cost -= rendered[block[start++]!]!.length + 1;
      const length = end - start + 1;
      if (length > best.length) best = { block, start, length };
    }
  }
  return new Set(best.block.slice(best.start, best.start + best.length));
}

function patchResult(lines: PacketLine[], selected: Set<number>, contentWithLineNumbers: string): Patch {
  const omitted = lines.filter((_, index) => !selected.has(index));
  const omittedChangedLineCount = omitted.filter(line => line.kind !== "context").length;
  return {
    lines: lines.filter((_, index) => selected.has(index)),
    contentWithLineNumbers,
    truncated: true,
    omittedLineCount: omitted.length,
    omittedChangedLineCount,
    ...(omittedChangedLineCount ? { omittedChangedRanges: changedRanges(omitted) } : {})
  };
}

function renderSelection(lines: PacketLine[], rendered: string[], selected: Set<number>): string {
  const parts: string[] = [];
  for (let index = 0; index < lines.length;) {
    if (selected.has(index)) {
      parts.push(rendered[index]!);
      index++;
      continue;
    }
    const start = index;
    while (index < lines.length && !selected.has(index)) index++;
    parts.push(omissionNotice(lines.slice(start, index)));
  }
  return parts.join("\n");
}

function omissionNotice(omitted: PacketLine[]): string {
  const ranges = changedRanges(omitted);
  if (ranges.old.length || ranges.new.length) {
    const labels = [formatRanges("old", ranges.old), formatRanges("new", ranges.new)].filter(Boolean);
    return `[Changed rows omitted: ${labels.join(" / ")}]`;
  }
  const start = omitted[0]?.newLine;
  const end = omitted.at(-1)?.newLine;
  const position = start !== undefined && end !== undefined ? ` (new ${start}-${end})` : "";
  return `[... ${omitted.length} unchanged rows omitted${position} ...]`;
}

function changedRanges(lines: PacketLine[]): ChangedRanges {
  const ranges: ChangedRanges = { old: [], new: [] };
  for (const row of lines) {
    const range = row.kind === "delete" ? ranges.old : ranges.new;
    const number = row.kind === "delete" ? row.oldLine : row.kind === "add" ? row.newLine : undefined;
    if (number === undefined) continue;
    const last = range.at(-1);
    if (last && last[1] + 1 === number) last[1] = number;
    else range.push([number, number]);
  }
  return ranges;
}

function formatRanges(side: string, ranges: Array<[number, number]>): string {
  return ranges.length ? `${side} ${ranges.map(([start, end]) => start === end ? String(start) : `${start}-${end}`).join(", ")}` : "";
}
