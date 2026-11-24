import { describe, expect, it } from "vitest";
import { MAX_PATCH_CHARS, packPacketPatch } from "../src/pipeline/packet-patch.js";
import { joinPacketText, packetText, truncatePacketText } from "../src/pipeline/packet-text.js";
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

  it("retreats only when an oversized row's cut splits a credential", () => {
    const plain = "x".repeat(20_000);
    const row = { kind: "add", newLine: 20, content: plain } satisfies PacketLine;
    const before = packPacketPatch([row]);
    const cut = plain.length - before.partialChangedLine!.omittedChars;
    const credential = "sk-" + "A1b2".repeat(8);
    for (const [start, end] of [[cut - 13, cut - 13], [cut, cut], [cut - credential.length, cut]] as const) {
      const content = plain.slice(0, start - 1) + " " + credential + " " + plain.slice(start + credential.length + 1);
      const after = packPacketPatch([{ ...row, content }]);
      expect(after.partialChangedLine).toEqual({ side: "new", line: 20, totalChars: content.length, omittedChars: content.length - end });
      expect(after.lines).toEqual([{ ...row, content: content.slice(0, end) + ` [... ${content.length - end} chars truncated ...]` }]);
      expect(after.omittedChangedRanges).toEqual(before.omittedChangedRanges);
      expect(after.boundaryRetreatChars).toBe(end === cut ? undefined : cut - end);
      expect(after.decisionChars ?? after.contentWithLineNumbers.length).toBe(before.contentWithLineNumbers.length);
    }
  });

  it("keeps nested cuts at the original selection boundary after retreating a leaf cut", () => {
    const credential = "sk-" + "A1b2".repeat(8);
    const first = truncatePacketText(packetText("before " + credential), 20, "!");
    const second = packetText("visible follow-up source");
    const joined = joinPacketText([first, second], "\n");
    const packed = truncatePacketText(joined, 29, "!");
    expect(packed.decisionText).toBe(first.decisionText + "\nvisible!");
    expect(packed.text).toBe("before!\nvisible!");
    expect(truncatePacketText(joined, 15, "!").text).toBe("before!");
  });
});
