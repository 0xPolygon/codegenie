import { describe, expect, it } from "vitest";
import { comparePackets, dispatchOrder, fail, hunksWithinSlots } from "../scripts/packet-packing-report.js";
import type { ReviewPacket } from "../src/types.js";

function packet(overrides: Partial<ReviewPacket> & { id: string; hunkIds: string[] }): ReviewPacket {
  const { hunkIds, id, ...rest } = overrides;
  return {
    id,
    dispatchRank: [0, -hunkIds.length],
    kind: hunkIds.length > 1 ? "coalesced-hunks" : "hunk",
    prSummary: "",
    path: "app.ts",
    fileStatus: "modified",
    isDeletedContent: false,
    language: "typescript",
    reviewPriority: "normal",
    coverage: "normal",
    reviewProfile: "standard",
    lenses: ["core/code-review"],
    hunks: hunkIds.map((hunkId) => ({
      hunkId,
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      header: "@@",
      lines: [],
      contentWithLineNumbers: "",
      changedNewLineNumbers: [],
      changedOldLineNumbers: []
    })),
    symbolFacts: [],
    context: { path: "app.ts" },
    contextText: "",
    contextQuality: "full",
    relevantTests: [],
    surroundingContextHints: [],
    labels: [],
    attentionNotes: [],
    relatedChangedContext: [],
    toolBudget: { maxToolCalls: 4, maxInvestigationRounds: 2, maxResultChars: 10_000 },
    ...rest
  } as ReviewPacket;
}

describe("packet packing report", () => {
  it("renders failures from typed fields without raw text", () => {
    const failure = fail("lens_dropped", "run-1", { hunkId: "h1", lens: "core/tests" });
    expect(failure.message).toBe("lens_dropped: hunkId=h1 lens=core/tests");
    expect(failure.fields).toEqual({ hunkId: "h1", lens: "core/tests" });
  });

  it("orders packets by the stage 7 scheduling tuple", () => {
    const low = packet({ id: "low", hunkIds: ["h1"], reviewPriority: "low" });
    const deep = packet({ id: "deep", hunkIds: ["h2"], coverage: "deep" });
    const normal = packet({ id: "normal", hunkIds: ["h3"] });
    expect(dispatchOrder([low, normal, deep]).map((entry) => entry.id)).toEqual(["deep", "normal", "low"]);
  });

  it("counts distinct hunks within a fixed dispatch slot budget", () => {
    const packets = [packet({ id: "a", hunkIds: ["h1", "h2"] }), packet({ id: "b", hunkIds: ["h3"] })];
    expect(hunksWithinSlots(packets, 1)).toBe(2);
    expect(hunksWithinSlots(packets, 2)).toBe(3);
  });

  it("passes a clean pack and fails closed on every invariant violation", () => {
    const off = [packet({ id: "a", hunkIds: ["h1"] }), packet({ id: "b", hunkIds: ["h2"] })];
    const packed = [packet({ id: "ab", hunkIds: ["h1", "h2"] })];
    expect(comparePackets("run-1", off, packed, 56)).toEqual([]);

    const lost = [packet({ id: "ab", hunkIds: ["h1"] })];
    expect(comparePackets("run-1", off, lost, 56).map((entry) => entry.code)).toContain("hunk_not_unique");

    const duplicated = [packet({ id: "ab", hunkIds: ["h1", "h1", "h2"] })];
    expect(comparePackets("run-1", off, duplicated, 56).map((entry) => entry.code)).toContain("hunk_not_unique");

    const overCap = [packet({ id: "ab", hunkIds: ["h1", "h2", "h3", "h4", "h5", "h6"] })];
    expect(comparePackets("run-1", off, overCap, 56).map((entry) => entry.code)).toContain("cap_exceeded");

    const deepOff = [packet({ id: "a", hunkIds: ["h1"], coverage: "deep" }), packet({ id: "b", hunkIds: ["h2"] })];
    expect(comparePackets("run-1", deepOff, packed, 56).map((entry) => entry.code)).toContain("coverage_changed");

    const investigateOff = [
      packet({ id: "a", hunkIds: ["h1"], reviewProfile: "investigate" }),
      packet({ id: "b", hunkIds: ["h2"] })
    ];
    expect(comparePackets("run-1", investigateOff, packed, 56).map((entry) => entry.code)).toContain("profile_downgraded");

    const richBudgetOff = [
      packet({ id: "a", hunkIds: ["h1"], toolBudget: { maxToolCalls: 9, maxInvestigationRounds: 2, maxResultChars: 10_000 } }),
      packet({ id: "b", hunkIds: ["h2"] })
    ];
    expect(comparePackets("run-1", richBudgetOff, packed, 56).map((entry) => entry.code)).toContain("budget_downgraded");

    const extraLensOff = [
      packet({ id: "a", hunkIds: ["h1"], lenses: ["core/code-review", "core/tests"] }),
      packet({ id: "b", hunkIds: ["h2"] })
    ];
    expect(comparePackets("run-1", extraLensOff, packed, 56).map((entry) => entry.code)).toContain("lens_dropped");
  });
});
