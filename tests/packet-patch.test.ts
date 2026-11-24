import { describe, expect, it } from "vitest";
import { MAX_PATCH_CHARS, packPacketPatch } from "../src/pipeline/packet-patch.js";
import { renderNumberedDiffLine } from "../src/repo/numbered-diff.js";
import type { PacketLine } from "../src/types.js";

describe("packet patch packing", () => {
  it("preserves under-cap patch bytes and rows", () => {
    const lines: PacketLine[] = [
      { kind: "delete", oldLine: 12, content: "old()" },
      { kind: "add", newLine: 12, content: "new()" },
      { kind: "context", oldLine: 13, newLine: 13, content: "  context" }
    ];
    expect(packPacketPatch(lines)).toEqual({ lines, contentWithLineNumbers: lines.map(renderNumberedDiffLine).join("\n") });
  });

  it("drops intervening context before dropping changed rows at either end", () => {
    const removed: PacketLine = { kind: "delete", oldLine: 100, content: "oldGuard()" };
    const added: PacketLine = { kind: "add", newLine: 150, content: "newGuard()" };
    const middle: PacketLine[] = Array.from({ length: 50 }, (_, index) => ({
      kind: "context", oldLine: 101 + index, newLine: 100 + index, content: "x".repeat(310)
    }));
    const patch = packPacketPatch([removed, ...middle, added]);
    expect(patch.omittedLineCount).toBe(46);
    expect(patch.omittedChangedLineCount).toBe(0);
    expect(patch.omittedChangedRanges).toBeUndefined();
    expect(patch.lines.filter(line => line.kind !== "context")).toEqual([removed, added]);
    expect(patch.contentWithLineNumbers).toContain("[... 46 unchanged rows omitted (new 102-147) ...]");
    expect(patch.contentWithLineNumbers.length).toBeLessThanOrEqual(MAX_PATCH_CHARS);
  });

  it("keeps whole changed blocks that fit and names exact base and head omissions", () => {
    const lines: PacketLine[] = [
      { kind: "add", newLine: 10, content: "entry()" },
      { kind: "context", oldLine: 10, newLine: 11, content: "before" },
      ...Array.from({ length: 12 }, (_, i): PacketLine => ({ kind: "delete", oldLine: 11 + i, content: "o".repeat(700) })),
      ...Array.from({ length: 12 }, (_, i): PacketLine => ({ kind: "add", newLine: 12 + i, content: "n".repeat(700) })),
      { kind: "context", oldLine: 23, newLine: 24, content: "after" },
      { kind: "add", newLine: 25, content: "exit()" }
    ];
    const patch = packPacketPatch(lines);
    expect(patch.lines).toEqual([lines[0], lines.at(-1)]);
    expect(patch.omittedChangedLineCount).toBe(24);
    expect(patch.omittedChangedRanges).toEqual({ old: [[11, 22]], new: [[12, 23]] });
    expect(patch.contentWithLineNumbers).toContain("[Changed rows omitted: old 11-22 / new 12-23]");
    expect(patch.contentWithLineNumbers.length).toBeLessThanOrEqual(MAX_PATCH_CHARS);
  });

  it("keeps the earliest most-complete whole-row window when one changed block exceeds the cap", () => {
    const lines: PacketLine[] = Array.from({ length: 1_500 }, (_, i) => ({
      kind: "add", newLine: i + 1, content: "add();"
    }));
    const patch = packPacketPatch(lines);
    expect(patch.lines.length).toBeGreaterThan(0);
    expect(patch.lines).toEqual(lines.slice(0, patch.lines.length));
    expect(patch.omittedChangedLineCount).toBe(lines.length - patch.lines.length);
    expect(patch.omittedChangedRanges).toEqual({ old: [], new: [[patch.lines.length + 1, lines.length]] });
    expect(patch.contentWithLineNumbers.length).toBeLessThanOrEqual(MAX_PATCH_CHARS);
  });

  it("keeps more whole changed rows when an oversized block starts with wide rows", () => {
    const lines: PacketLine[] = Array.from({ length: 720 }, (_, i) => ({
      kind: "add", newLine: i + 1, content: "x".repeat(i < 20 ? 600 : 6)
    }));
    const patch = packPacketPatch(lines);
    expect(patch.lines[0]?.newLine).toBe(21);
    expect(patch.lines.length).toBeGreaterThan(600);
    expect(patch.omittedChangedRanges?.new[0]).toEqual([1, 20]);
    expect(patch.contentWithLineNumbers.length).toBeLessThanOrEqual(MAX_PATCH_CHARS);
  });
});
