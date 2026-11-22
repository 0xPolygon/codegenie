import type { DiffFile, DiffHunk, PacketLine, SymbolInfo } from "../types.js";
import type { LanguageAdapterRegistry } from "./language-adapter.js";
import { packetDiffLine } from "./numbered-diff.js";
import type { ResolvedContent } from "./source-resolver.js";

type Range = [number, number];
export type ChangeSource = { content: ResolvedContent; lines: string[] };

export type FunctionContext = {
  rows: PacketLine[];
  base: SymbolInfo;
  head: SymbolInfo;
  aligned: boolean;
};
export type FunctionPair = Pick<FunctionContext, "base" | "head">;

export async function parseChangeFunctions(source: ChangeSource, registry: LanguageAdapterRegistry): Promise<SymbolInfo[] | undefined> {
  const adapter = registry.forPath(source.content.path);
  const parsed = await adapter.parse({ ...source.content, language: adapter.id });
  if (!parsed.tree || parsed.hasErrors) return undefined;
  return adapter.listSymbols(parsed).filter(symbol => symbol.kind === "function" || symbol.kind === "method");
}

/** Locate both declarations syntactically, without rendering their bodies per hunk. */
export function selectChangeFunctions(
  hunk: DiffHunk, base: ChangeSource, head: ChangeSource, baseFunctions: SymbolInfo[] | undefined, headFunctions: SymbolInfo[] | undefined
): FunctionPair | string {
  if (!baseFunctions || !headFunctions) return "Function context unavailable: the base or head syntax could not be verified.";

  const removed = hunk.lines.flatMap(line => line.kind === "delete" && line.oldLineNumber !== undefined ? [line.oldLineNumber] : []);
  const added = hunk.lines.flatMap(line => line.kind === "add" && line.newLineNumber !== undefined ? [line.newLineNumber] : []);
  let baseFunction = enclosingFunction(baseFunctions, removed);
  let headFunction = enclosingFunction(headFunctions, added);
  const unchanged = hunk.lines.filter(line => line.kind === "context");
  if (!removed.length && headFunction) {
    baseFunction = enclosingFunction(baseFunctions, unchanged.flatMap(line =>
      within(line.newLineNumber, headFunction!.lineRange) && line.oldLineNumber !== undefined ? [line.oldLineNumber] : []));
  }
  if (!added.length && baseFunction) {
    headFunction = enclosingFunction(headFunctions, unchanged.flatMap(line =>
      within(line.oldLineNumber, baseFunction!.lineRange) && line.newLineNumber !== undefined ? [line.newLineNumber] : []));
  }
  if (!baseFunction || !headFunction) return "Function context unavailable: the hunk does not identify one enclosing function on each side.";
  const baseRange = baseFunction.lineRange;
  const headRange = headFunction.lineRange;
  if (baseRange[1] > base.lines.length || headRange[1] > head.lines.length) {
    return "Function context unavailable: a declaration extends beyond the pinned source.";
  }
  return { base: baseFunction, head: headFunction };
}

/** A shared row is presented once only after verifying it against both Git blobs. */
export function changeFunctionContext(file: DiffFile, base: ChangeSource, head: ChangeSource, pair: FunctionPair): FunctionContext {
  const baseRange = pair.base.lineRange;
  const headRange = pair.head.lineRange;
  const aligned = alignFunctions(file.hunks, base.lines, head.lines, baseRange, headRange);
  if (aligned) return { ...pair, rows: aligned, aligned: true };
  const baseRows = base.lines.slice(baseRange[0] - 1, baseRange[1]).map((content, i): PacketLine =>
    ({ kind: "context", oldLine: baseRange[0] + i, content }));
  const headRows = head.lines.slice(headRange[0] - 1, headRange[1]).map((content, i): PacketLine =>
    ({ kind: "context", newLine: headRange[0] + i, content }));
  return { ...pair, rows: [...baseRows, ...headRows], aligned: false };
}

function within(line: number | undefined, [first, last]: Range): boolean {
  return line !== undefined && line >= first && line <= last;
}

function enclosingFunction(symbols: SymbolInfo[], lines: number[]): SymbolInfo | undefined {
  if (!lines.length) return undefined;
  // All changed lines must agree on the innermost syntactic declaration.
  // A line-only hit on multiple equally narrow declarations is ambiguous.
  let result: SymbolInfo | undefined;
  for (const line of lines) {
    const containing = symbols.filter(symbol => within(line, symbol.lineRange)).sort((a, b) => span(a) - span(b));
    const [first, other] = containing;
    if (!first || (other && span(first) === span(other)) || (result && result !== first)) return undefined;
    result = first;
  }
  return result;
}

function span(symbol: SymbolInfo): number {
  return symbol.lineRange[1] - symbol.lineRange[0];
}

function alignFunctions(hunks: DiffHunk[], base: string[], head: string[], baseRange: Range, headRange: Range): PacketLine[] | undefined {
  const rows: PacketLine[] = [];
  let baseNext = 1;
  let headNext = 1;
  let baseDelivered = 0;
  let headDelivered = 0;
  let shared = false;
  const append = (row: PacketLine): boolean => {
    const old = within(row.oldLine, baseRange);
    const next = within(row.newLine, headRange);
    if (!old && !next) return true;
    if (row.kind === "context" && old !== next) return false;
    if (old && base[row.oldLine! - 1] !== row.content) return false;
    if (next && head[row.newLine! - 1] !== row.content) return false;
    if (old) baseDelivered++;
    if (next) headDelivered++;
    shared ||= old && next;
    rows.push(row);
    return true;
  };
  const appendGap = (baseEnd: number, headEnd: number) => {
    const count = baseEnd - baseNext;
    if (count < 0 || count !== headEnd - headNext) return false;
    // Reconstruct only the portions of the unchanged gap touching either body.
    const first = Math.max(0, Math.min(baseRange[0] - baseNext, headRange[0] - headNext));
    const last = Math.min(count - 1, Math.max(baseRange[1] - baseNext, headRange[1] - headNext));
    for (let offset = first; offset <= last; offset++) {
      const oldLine = baseNext + offset;
      const newLine = headNext + offset;
      if (!append({ kind: "context", oldLine, newLine, content: base[oldLine - 1] ?? "" })) return false;
    }
    return true;
  };
  for (const hunk of hunks) {
    // In unified diffs a zero-length side points to the preceding line.
    const baseStart = hunk.oldStart + Number(hunk.oldLines === 0);
    const headStart = hunk.newStart + Number(hunk.newLines === 0);
    if (!appendGap(baseStart, headStart)) return undefined;
    for (const line of hunk.lines) {
      if (!append(packetDiffLine(line))) return undefined;
    }
    baseNext = baseStart + hunk.oldLines;
    headNext = headStart + hunk.newLines;
  }
  if (!appendGap(base.length + 1, head.length + 1)) return undefined;
  return shared && baseDelivered === baseRange[1] - baseRange[0] + 1 &&
    headDelivered === headRange[1] - headRange[0] + 1 ? rows : undefined;
}
