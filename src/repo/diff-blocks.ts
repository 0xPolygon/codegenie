import { diffRowRanges } from "../util/delivered-source.js";
import type { DiffRecordGroups, ToolResultRecords } from "../llm/llm-runner.js";
import type { DiffFile, DiffHunk, DiffLine, ReviewPacket, ToolResultMeta, UnifiedDiff } from "../types.js";
import { CodegenieError } from "../util/errors.js";
import type { SourceResolver } from "./source-resolver.js";

const MAX_BLOCKS = 20;
const MAX_CHARS = 16_000;
export const MAX_OMITTED_DIFF_LABELS = 8;

type DiffBlockResult = { blocks: string[]; meta: ToolResultMeta; packable?: ToolResultRecords };

export class DiffBlockRenderer {
  private readonly packetHunks = new Map<string, Set<string>>();
  private readonly fileHeaders = new Map<DiffFile, Promise<string>>();

  constructor(private readonly diff: UnifiedDiff, private readonly resolver: Pick<SourceResolver, "readFile">) {}

  bindPackets(packets: ReviewPacket[]): void {
    this.packetHunks.clear();
    for (const packet of packets) {
      this.packetHunks.set(packet.id, new Set(packet.hunks.map((hunk) => hunk.hunkId)));
    }
  }

  async read(input: { packetId?: string; path?: string }): Promise<DiffBlockResult> {
    if ((input.packetId === undefined) === (input.path === undefined)) {
      throw new CodegenieError("invalid_args", "readDiffBlocks requires exactly one selector");
    }

    const packetHunks = input.packetId === undefined ? undefined : this.packetHunks.get(input.packetId);
    if (input.packetId !== undefined && !packetHunks) {
      return emptyDiffResult("packet bindings are unavailable or packet id is unknown");
    }
    const hunks = this.diff.files.flatMap(file => {
      if (input.path !== undefined && file.path !== input.path && file.oldPath !== input.path) return [];
      return file.hunks.filter(hunk => !packetHunks || packetHunks.has(hunk.id)).map(hunk => ({ file, hunk }));
    });
    if (!hunks.length) return emptyDiffResult("no diff blocks matched selector");

    const blocks: string[] = [];
    const records: string[] = [];
    const labels: string[] = [];
    const keepWithNext: boolean[] = [];
    const recordRanges: NonNullable<ToolResultRecords["recordRanges"]> = [];
    const deliveredFiles = new Set<DiffFile>();
    const diffGroups: DiffRecordGroups = { rendered: [], lineEnds: [], omittedLabels: [] };
    let omittedCount = 0;
    let totalChars = 0;
    let windowDelivered = false;
    for (const { file, hunk } of hunks) {
      const hunkLabel = describeHunk(file, hunk);
      const first = hunk.lines[0];
      const firstLabel = first ? describeLine(file, hunk, first) : hunkLabel;
      const blockGap = blocks.length > 0 ? 2 : 0;
      if (!windowDelivered && blocks.length < MAX_BLOCKS && first &&
          totalChars + blockGap + hunkLabel.length + renderDiffLine(first).length < MAX_CHARS) {
        const header = deliveredFiles.has(file) ? hunkLabel : `${hunkLabel}\n${await this.fileHeader(file)}`;
        const rendered: string[] = [];
        let nextTotal = totalChars + blockGap + header.length;
        for (const line of hunk.lines) {
          const text = renderDiffLine(line);
          if (nextTotal + text.length + 1 > MAX_CHARS) break;
          rendered.push(text);
          nextTotal += text.length + 1;
        }
        const next = hunk.lines[rendered.length];
        if (rendered.length && (!next || exceedsResultLimit(header.length, hunk.lines))) {
          deliveredFiles.add(file);
          diffGroups.rendered.push({ firstRecord: records.length, label: hunkLabel, baseStart: hunk.oldStart, headStart: hunk.newStart });
          records.push((blockGap ? "\n" : "") + header, ...rendered);
          labels.push(firstLabel);
          keepWithNext.push(true);
          recordRanges.push([]);
          diffGroups.lineEnds.push([undefined, undefined]);
          let baseEnd: number | undefined;
          let headEnd: number | undefined;
          for (const line of hunk.lines.slice(0, rendered.length)) {
            labels.push(describeLine(file, hunk, line));
            keepWithNext.push(false);
            recordRanges.push(diffRowRanges(file.path, file.oldPath, line.oldLineNumber, line.newLineNumber));
            baseEnd = line.oldLineNumber ?? baseEnd;
            headEnd = line.newLineNumber ?? headEnd;
            diffGroups.lineEnds.push([baseEnd, headEnd]);
          }
          blocks.push([header, ...rendered].join("\n"));
          totalChars = nextTotal;
          if (next) {
            diffGroups.next = describeLine(file, hunk, next);
            windowDelivered = true;
          }
          continue;
        }
      }
      omittedCount++;
      if (diffGroups.omittedLabels.length < MAX_OMITTED_DIFF_LABELS) diffGroups.omittedLabels.push(hunkLabel);
      diffGroups.next ??= firstLabel;
    }

    const truncated = diffGroups.next !== undefined;
    const refused = !records.length;
    const meta: ToolResultMeta = {
      backend: "text", precision: "exact", degraded: false, lookupStatus: "found",
      deliveryStatus: refused ? "budget_rejected" : truncated ? "truncated" : "full",
      ...(truncated ? { truncated: true, degradationReason: "diff_result_limit" } : {}),
      ...(omittedCount ? { omittedCount } : {})
    };
    return { blocks, meta, packable: {
      open: refused ? "No whole diff line fits the result limit." : "",
      records, separator: "\n", close: "", labels, keepWithNext, diffGroups, recordRanges
    } };
  }

  private fileHeader(file: DiffFile): Promise<string> {
    let header = this.fileHeaders.get(file);
    if (!header) {
      header = Promise.all([
        file.status === "added" ? "base absent" : this.describeFile(file.oldPath ?? file.path, "base"),
        file.status === "deleted" ? "head absent" : this.describeFile(file.path, "head")
      ]).then(sides => sides.join(" | "));
      this.fileHeaders.set(file, header);
    }
    return header;
  }

  private async describeFile(path: string, source: "base" | "head"): Promise<string> {
    const file = await this.resolver.readFile(path, { kind: source });
    if (!file) return `${path}@${source}: file length unavailable`;
    const text = file.content;
    const lines = text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
    return `${path}@${source}: ${lines} lines`;
  }
}

function emptyDiffResult(reason: string): DiffBlockResult {
  return { blocks: [], meta: { backend: "text", precision: "exact", degraded: true,
    lookupStatus: "not_found", deliveryStatus: "empty", degradationReason: reason } };
}

function describeHunk(file: DiffFile, hunk: DiffHunk): string {
  return `${file.path} @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.id}`;
}

function describeLine(file: DiffFile, hunk: DiffHunk, line: DiffLine): string {
  const positions: string[] = [];
  if (line.oldLineNumber !== undefined) positions.push(`${file.oldPath ?? file.path}@base:${line.oldLineNumber}`);
  if (line.newLineNumber !== undefined) positions.push(`${file.path}@head:${line.newLineNumber}`);
  return `${positions.join(" / ")} (hunk ${hunk.id})`;
}

function exceedsResultLimit(headerLength: number, lines: DiffLine[]): boolean {
  let chars = headerLength;
  for (const line of lines) {
    chars += renderDiffLine(line).length + 1;
    if (chars > MAX_CHARS) return true;
  }
  return false;
}

function renderDiffLine(line: DiffLine): string {
  const marker = line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " ";
  return `${line.oldLineNumber ?? "-"} ${line.newLineNumber ?? "-"} ${marker} ${line.content}`;
}
