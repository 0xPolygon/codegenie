import type { DiffRecordGroups, ToolResultRecords } from "../llm/llm-runner.js";
import type { DiffFile, DiffHunk, PacketLine, ToolResultMeta, UnifiedDiff } from "../types.js";
import { CodegenieError } from "../util/errors.js";
import { changeFunctionContext, parseChangeFunctions, selectChangeFunctions,
  type ChangeSource, type FunctionContext, type FunctionPair } from "./change-function-context.js";
import { MAX_OMITTED_DIFF_LABELS } from "./diff-blocks.js";
import type { LanguageAdapterRegistry } from "./language-adapter.js";
import { packetDiffLine, renderNumberedDiffLine } from "./numbered-diff.js";
import type { SourceResolver } from "./source-resolver.js";
import { decodeToolCursor, encodeToolCursor, toolCursorBinding } from "./tool-cursor.js";

const MAX_DIRECTORY_CHARS = 3_800;
const MAX_PROMPT_DIRECTORY_CHARS = 2_400;
const MAX_SOURCE_CHARS = 15_000;
const MAX_BLOCKS = 20;
const EXACT = { backend: "text", precision: "exact", degraded: false } as const;

export type ReadChangeInput = { path?: string; hunkId?: string; context?: "function"; cursor?: string };
export type ReadChangeResult = { meta: ToolResultMeta; packable?: ToolResultRecords; text?: string };
type Target = { file: DiffFile; hunk: DiffHunk };
type SourceTarget = { file: DiffFile; hunks: [DiffHunk, ...DiffHunk[]]; comparison?: FunctionPair | string };
type Position = { block: number; row: number };
type Sides = { base: ChangeSource | undefined; head: ChangeSource | undefined };
type DirectoryRow = { text: string; label: string; hunkId?: string };
type SourceBlock = { title: string; rows: PacketLine[] };

export class ReadChangeService {
  private readonly fileSides = new Map<DiffFile, Promise<Sides>>();
  private readonly functionSymbols = new WeakMap<ChangeSource, ReturnType<typeof parseChangeFunctions>>();
  private targets?: Target[];
  private directory?: DirectoryRow[];

  constructor(private readonly diff: UnifiedDiff, private readonly resolver: SourceResolver, private readonly registry: LanguageAdapterRegistry) {}

  promptDirectory(currentHunks: readonly string[], canContinue: boolean): string {
    if (!this.diff.files.length) return "";
    const directory = this.directoryRows();
    const current = new Set(currentHunks);
    const inPacket = (row: DirectoryRow) => row.hunkId !== undefined && current.has(row.hunkId);
    const prioritized = [...directory.filter(inPacket).map(markCurrent), ...directory.filter(row => !inPacket(row))];
    const heading = this.directoryHeading();
    const scope = "Entries marked [current packet] are this review's hunks; other entries are optional context from the same change.";
    const retained = fitDirectoryRows(prioritized, MAX_PROMPT_DIRECTORY_CHARS - heading.length - scope.length - 171);
    const omitted = prioritized.length - retained.length;
    return [heading, scope, ...retained.map(row => row.text),
      ...(omitted ? [`Omitted ${omitted} change entries${canContinue ? "; use read_change without a selector to page through the directory" : ""}.`] : [])
    ].join("\n");
  }

  async read(input: ReadChangeInput, currentHunks?: readonly string[]): Promise<ReadChangeResult> {
    const overview = input.path === undefined && input.hunkId === undefined;
    if (overview && input.context !== undefined) {
      throw new CodegenieError("invalid_args", "Function context requires path or hunkId.");
    }
    const binding = toolCursorBinding(["read_change", this.resolver.binding.baseCommit, this.resolver.binding.headCommit,
      input.hunkId === undefined ? input.path ?? null : null, input.hunkId ?? null, input.context ?? null,
      overview ? currentHunks ?? null : null]);
    if (overview) return this.readDirectory(binding, input.cursor, currentHunks);
    this.targets ??= this.diff.files.flatMap(file => file.hunks.filter(hunk => hunk.lines.length).map(hunk => ({ file, hunk })));
    const matchesPath = (file: DiffFile): boolean => input.path === undefined || file.path === input.path || file.oldPath === input.path;
    const matchingHunks = input.hunkId === undefined ? this.targets
      : this.targets.filter(({ hunk }) => hunk.id === input.hunkId);
    const targets = matchingHunks.filter(({ file }) => matchesPath(file));
    if (matchingHunks.length && !targets.length && input.hunkId !== undefined) {
      throw new CodegenieError("invalid_args", `hunkId ${JSON.stringify(input.hunkId)} belongs to ${JSON.stringify(matchingHunks[0]!.file.path)}, not path ${JSON.stringify(input.path)}.`);
    }
    if (!targets.length) {
      if (input.cursor !== undefined) throw new CodegenieError("invalid_args", "Cursor does not identify an available change.");
      const knownPath = input.hunkId === undefined && this.diff.files.some(matchesPath);
      return empty(knownPath ? "The changed path has no textual hunks. Call read_change without a selector for its status."
        : "No changed hunk matched the path or hunk ID. Call read_change without a selector for the pinned changes.");
    }
    return this.readSourcePage(await this.sourceTargets(targets, input.context), binding, input);
  }

  private directoryRows(): DirectoryRow[] {
    this.directory ??= this.diff.files.flatMap(file => {
      const path = file.oldPath && file.oldPath !== file.path ? `${JSON.stringify(file.oldPath)} -> ${JSON.stringify(file.path)}` : JSON.stringify(file.path);
      let additions = 0;
      let deletions = 0;
      for (const hunk of file.hunks) for (const line of hunk.lines) {
        if (line.kind === "add") additions++;
        if (line.kind === "delete") deletions++;
      }
      const fileLabel = `${path} (${file.status}, +${additions}/-${deletions}${file.isBinary ? ", binary" : ""})`;
      if (!file.hunks.length) return [{ text: fileLabel + " | no textual hunks", label: path }];
      return file.hunks.map(hunk => ({
        text: `${fileLabel} | ${hunk.id} base ${interval(hunk.oldStart, hunk.oldLines)} head ${interval(hunk.newStart, hunk.newLines)}`,
        label: `${path} hunk ${hunk.id}`,
        hunkId: hunk.id
      }));
    });
    return this.directory;
  }

  private directoryHeading(): string {
    return `Changed files (${this.diff.files.length}) in pinned base -> head:`;
  }

  private readDirectory(binding: string, cursor: string | undefined, currentHunks: readonly string[] | undefined): ReadChangeResult {
    const current = new Set(currentHunks);
    const rows = this.directoryRows().map(row => row.hunkId !== undefined && current.has(row.hunkId) ? markCurrent(row) : row);
    if (!rows.length && cursor === undefined) return empty("No changed files in the pinned base-to-head comparison.");
    const index = cursor === undefined ? 0 : decodeToolCursor(cursor, binding);
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= rows.length) {
      throw new CodegenieError("invalid_args", "Cursor does not identify a change directory row.");
    }
    const heading = this.directoryHeading();
    const visible = fitDirectoryRows(rows.slice(index), MAX_DIRECTORY_CHARS - heading.length);
    const next = index + visible.length;
    const omittedCount = rows.length - next;
    return {
      meta: deliveryMeta(visible.length, omittedCount > 0, omittedCount),
      packable: {
        open: visible.length ? heading + "\n" : "No complete change entry fits the result limit.",
        records: visible.map(row => row.text), labels: visible.map(row => row.label),
        cursors: visible.map((_, i) => encodeToolCursor(binding, index + i)), separator: "\n", close: "",
        ...(omittedCount ? { nextPage: `${rows[next]!.label}, cursor=${encodeToolCursor(binding, next)}` } : {})
      }
    };
  }

  private async sourceTargets(targets: Target[], context: ReadChangeInput["context"]): Promise<SourceTarget[]> {
    if (!context) return targets.map(({file, hunk}) => ({ file, hunks: [hunk] }));

    const groups: SourceTarget[] = [];
    const functionGroups = new Map<DiffFile, Map<string, SourceTarget>>();
    for (const {file, hunk} of targets) {
      const {base, head} = await this.readSides(file);
      if (!base || !head) {
        groups.push({ file, hunks: [hunk], comparison: "Function context unavailable: a pinned file side is absent." });
        continue;
      }
      const [baseFunctions, headFunctions] = await Promise.all([this.readFunctions(base), this.readFunctions(head)]);
      const comparison = selectChangeFunctions(hunk, base, head, baseFunctions, headFunctions);
      if (typeof comparison === "string") {
        groups.push({ file, hunks: [hunk], comparison });
        continue;
      }
      let fileGroups = functionGroups.get(file);
      if (!fileGroups) {
        fileGroups = new Map();
        functionGroups.set(file, fileGroups);
      }
      const key = JSON.stringify([comparison.base.lineRange, comparison.head.lineRange]);
      const existing = fileGroups.get(key);
      if (existing) {
        existing.hunks.push(hunk);
      } else {
        const group: SourceTarget = { file, hunks: [hunk], comparison };
        fileGroups.set(key, group);
        groups.push(group);
      }
    }
    return groups;
  }

  private readFunctions(source: ChangeSource): ReturnType<typeof parseChangeFunctions> {
    let pending = this.functionSymbols.get(source);
    if (!pending) {
      pending = parseChangeFunctions(source, this.registry);
      this.functionSymbols.set(source, pending);
    }
    return pending;
  }

  private async readSourcePage(targets: SourceTarget[], binding: string, input: ReadChangeInput): Promise<ReadChangeResult> {
    const start = input.cursor === undefined ? { block: 0, row: 0 } : readPosition(decodeToolCursor(input.cursor, binding), targets.length);
    const packable: ToolResultRecords = { open: "", records: [], labels: [], cursors: [], keepWithNext: [], separator: "\n", close: "" };
    const groups: DiffRecordGroups = { rendered: [], lineEnds: [], omittedLabels: [],
      ...(targets.some(target => target.hunks.length > 1) ? { groupedHunks: true } : {}) };
    packable.diffGroups = groups;
    const deliveredFiles = new Set<DiffFile>();
    let next: Position | undefined;
    let remaining = MAX_SOURCE_CHARS;
    for (let block = start.block; block < targets.length; block++) {
      const target = targets[block]!;
      const { file, hunks } = target;
      const rowOffset = block === start.block ? start.row : 0;
      const sides = await this.readSides(file);
      const source = this.sourceBlock(target, sides);
      if (rowOffset >= source.rows.length) throw new CodegenieError("invalid_args", "Cursor does not identify a diff row.");
      const available = source.rows.slice(rowOffset);
      const hunkName = targetLabel(target);
      const scope = hunks.length === 1 ? `hunk ${hunks[0].id}` : `function comparison for hunks ${hunks.map(hunk => hunk.id).join(", ")}`;
      const firstLocation = rowLabel(file, scope, available[0]!);
      const lengths = deliveredFiles.has(file) ? "" : "\n" + fileLengths(file, sides);
      const firstRecord = packable.records.length;
      const baseStart = available.find(line => line.oldLine !== undefined)?.oldLine ?? 0;
      const headStart = available.find(line => line.newLine !== undefined)?.newLine ?? 0;
      const header = (firstRecord ? "\n" : "") + targetLabel(target, "\n") + lengths + (source.title ? "\n" + source.title : "") +
        (rowOffset ? "\nContinued from " + firstLocation : "");
      const headerCost = header.length + 1;
      const firstLineCost = renderNumberedDiffLine(available[0]!).length + 1;
      if (groups.rendered.length >= MAX_BLOCKS || headerCost + firstLineCost > remaining) {
        next = { block, row: rowOffset };
        groups.next = firstLocation;
        break;
      }
      deliveredFiles.add(file);
      groups.rendered.push({ firstRecord, label: hunkName, baseStart, headStart });
      appendRecord(packable, header, firstLocation, encodeToolCursor(binding, { block, row: rowOffset }), true);
      groups.lineEnds.push([undefined, undefined]);
      remaining -= headerCost;

      let baseEnd: number | undefined;
      let headEnd: number | undefined;
      for (const [i, line] of available.entries()) {
        const rendered = renderNumberedDiffLine(line);
        const locator = rowLabel(file, scope, line);
        const position = { block, row: rowOffset + i };
        if (rendered.length + 1 > remaining) {
          next = position;
          groups.next = locator;
          break;
        }
        appendRecord(packable, rendered, locator, encodeToolCursor(binding, position), false);
        baseEnd = line.oldLine ?? baseEnd;
        headEnd = line.newLine ?? headEnd;
        groups.lineEnds.push([baseEnd, headEnd]);
        remaining -= rendered.length + 1;
      }
      if (next) break;
    }
    if (next) {
      groups.nextCursor = encodeToolCursor(binding, next);
      const firstOmitted = next.block + Number(groups.rendered.at(-1)?.label === targetLabel(targets[next.block]!));
      groups.omittedLabels = targets.slice(firstOmitted, firstOmitted + MAX_OMITTED_DIFF_LABELS).map(target => targetLabel(target));
      if (!packable.records.length) packable.open = "No whole diff line fits the result limit. Narrow the selection or use read_range at the stated source location.";
      return { meta: deliveryMeta(packable.records.length, true, targets.length - firstOmitted), packable };
    }
    return { meta: deliveryMeta(packable.records.length, false, 0), packable };
  }

  private sourceBlock({file, hunks: [hunk], comparison}: SourceTarget, {base, head}: Sides): SourceBlock {
    if (typeof comparison !== "object" || !base || !head) {
      return { title: typeof comparison === "string" ? comparison : "", rows: hunk.lines.map(packetDiffLine) };
    }
    const context = changeFunctionContext(file, base, head, comparison);
    return { title: functionHeading(context), rows: context.rows };
  }

  private readSides(file: DiffFile): Promise<Sides> {
    let pending = this.fileSides.get(file);
    if (!pending) {
      const read = async (path: string, side: "base" | "head"): Promise<ChangeSource | undefined> => {
        const result = await this.resolver.readFile(path, { kind: side });
        if (!result) return undefined;
        const lines = result.content.length ? result.content.replace(/\n$/u, "").split("\n") : [];
        return { content: result, lines };
      };
      pending = Promise.all([
        file.status === "added" ? undefined : read(file.oldPath ?? file.path, "base"),
        file.status === "deleted" ? undefined : read(file.path, "head")
      ]).then(([base, head]) => ({ base, head }));
      this.fileSides.set(file, pending);
    }
    return pending;
  }
}

function empty(text: string): ReadChangeResult {
  return { text, meta: { ...EXACT, lookupStatus: "not_found", deliveryStatus: "empty" } };
}

function deliveryMeta(count: number, truncated: boolean, omittedCount: number): ToolResultMeta {
  return { ...EXACT, lookupStatus: "found", deliveryStatus: !count ? "budget_rejected" : truncated ? "truncated" : "full",
    ...(truncated ? { truncated: true, degradationReason: "diff_result_limit", omittedCount } : {}) };
}

function interval(start: number, count: number): string {
  return count ? `${start}-${start + count - 1}` : `none (after ${start})`;
}

function fitDirectoryRows(rows: DirectoryRow[], allowance: number): DirectoryRow[] {
  const visible: DirectoryRow[] = [];
  for (const row of rows) {
    allowance -= row.text.length + 1;
    if (allowance < 0) break;
    visible.push(row);
  }
  return visible;
}

function markCurrent(row: DirectoryRow): DirectoryRow {
  return { ...row, text: row.text + " [current packet]" };
}

function fileLengths(file: DiffFile, sides: Sides): string {
  const base = file.status === "added" ? "base absent" : `${JSON.stringify(file.oldPath ?? file.path)}@base: ${sides.base ? `${sides.base.lines.length} lines` : "file length unavailable"}`;
  const head = file.status === "deleted" ? "head absent" : `${JSON.stringify(file.path)}@head: ${sides.head ? `${sides.head.lines.length} lines` : "file length unavailable"}`;
  return `${base} | ${head}`;
}

function functionHeading({base, head, aligned}: FunctionContext): string {
  const names = `Function intervals: base ${base.name} ${base.lineRange.join("-")} | head ${head.name} ${head.lineRange.join("-")}.`;
  return aligned ? names : names + " Alignment unavailable; base and head are shown independently. These rows do not identify edits.";
}

function targetLabel({file, hunks}: SourceTarget, separator = "; "): string {
  return hunks.map(hunk =>
    `${JSON.stringify(file.path)} hunk ${hunk.id} | base ${interval(hunk.oldStart, hunk.oldLines)} | head ${interval(hunk.newStart, hunk.newLines)}`
  ).join(separator);
}

function rowLabel(file: DiffFile, scope: string, line: PacketLine): string {
  const base = line.oldLine === undefined ? "" : `${JSON.stringify(file.oldPath ?? file.path)}@base:${line.oldLine}`;
  const head = line.newLine === undefined ? "" : `${JSON.stringify(file.path)}@head:${line.newLine}`;
  return `${[base, head].filter(Boolean).join(" / ")} (${scope})`;
}

function appendRecord(packable: ToolResultRecords, text: string, label: string, cursor: string, keepWithNext: boolean): void {
  packable.records.push(text);
  packable.labels!.push(label);
  packable.cursors!.push(cursor);
  packable.keepWithNext!.push(keepWithNext);
}

function readPosition(value: unknown, count: number): Position {
  if (!value || typeof value !== "object" || !("block" in value) || !("row" in value) ||
    typeof value.block !== "number" || typeof value.row !== "number" ||
    !Number.isSafeInteger(value.block) || !Number.isSafeInteger(value.row) ||
    value.block < 0 || value.block >= count || value.row < 0) {
    throw new CodegenieError("invalid_args", "Cursor does not identify a diff row.");
  }
  return { block: value.block, row: value.row };
}
