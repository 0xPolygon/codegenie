import type { DiffHunk, ReviewPacket, ToolResultMeta, UnifiedDiff } from "../types.js";
import { CodeninjaError } from "../util/errors.js";

const MAX_BLOCKS = 20;
const MAX_CHARS = 16_000;

export class DiffBlockRenderer {
  private readonly packetHunks = new Map<string, Set<string>>();

  constructor(private readonly diff: UnifiedDiff) {}

  bindPackets(packets: ReviewPacket[]): void {
    this.packetHunks.clear();
    for (const packet of packets) {
      this.packetHunks.set(packet.id, new Set(packet.hunks.map((hunk) => hunk.hunkId)));
    }
  }

  read(input: { packetId?: string; path?: string }): { blocks: string[]; meta: ToolResultMeta } {
    if ((input.packetId === undefined) === (input.path === undefined)) {
      throw new CodeninjaError("invalid_args", "readDiffBlocks requires exactly one selector");
    }

    const hunks = input.path !== undefined ? this.hunksForPath(input.path) : this.hunksForPacket(input.packetId ?? "");
    if (input.packetId !== undefined && !this.packetHunks.has(input.packetId)) {
      return {
        blocks: [],
        meta: {
          backend: "text",
          precision: "exact",
          degraded: true,
          degradationReason: "packet bindings are unavailable or packet id is unknown"
        }
      };
    }

    const rendered: string[] = [];
    let omitted = 0;
    let totalChars = 0;
    for (const hunk of hunks) {
      const block = renderHunk(hunk);
      if (rendered.length >= MAX_BLOCKS || totalChars + block.length > MAX_CHARS) {
        omitted += 1;
        continue;
      }
      rendered.push(block);
      totalChars += block.length;
    }
    return {
      blocks: rendered,
      meta: {
        backend: "text",
        precision: "exact",
        degraded: hunks.length === 0,
        ...(hunks.length === 0 ? { degradationReason: "no diff blocks matched selector" } : {}),
        ...(omitted > 0 ? { truncated: true, omittedCount: omitted } : {})
      }
    };
  }

  private hunksForPath(filePath: string): DiffHunk[] {
    return this.diff.files
      .filter((file) => file.path === filePath || file.oldPath === filePath)
      .flatMap((file) => file.hunks);
  }

  private hunksForPacket(packetId: string): DiffHunk[] {
    const hunkIds = this.packetHunks.get(packetId);
    if (!hunkIds) {
      return [];
    }
    return this.diff.files.flatMap((file) => file.hunks.filter((hunk) => hunkIds.has(hunk.id)));
  }
}

function renderHunk(hunk: DiffHunk): string {
  const lines = [`${hunk.path} @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.id}`];
  for (const line of hunk.lines) {
    const marker = line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " ";
    lines.push(`${line.oldLineNumber ?? "-"} ${line.newLineNumber ?? "-"} ${marker} ${line.content}`);
  }
  return lines.join("\n");
}
