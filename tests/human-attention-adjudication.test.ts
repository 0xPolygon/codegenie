import { describe, expect, it, vi } from "vitest";
import { buildHumanAttentionNotes, humanAttentionArtifact, selectHumanAttentionGroups } from "../src/pipeline/human-attention.js";
import type { PacketReviewResult, ReviewPacket } from "../src/types.js";
import { nullTelemetry } from "./helpers/git.js";

const QUESTION = "Does the changed LiFi parser still tolerate malformed provider numeric fields?";

describe("human-attention repository paths", () => {
  it("retains all kept group IDs in the version 4 artifact even when output is capped", () => {
    const attention = buildHumanAttentionNotes([packetResultWithHint()], { packets: [packet()] });
    const groups = Array.from({ length: 7 }, (_, index) => ({ ...attention.groups[0]!, key: `group-${index}` }));
    const output = selectHumanAttentionGroups(groups);
    const artifact = humanAttentionArtifact(attention, output, [], groups);
    expect(artifact.schemaVersion).toBe(4);
    expect(artifact.keptForOutputGroupIds).toEqual(groups.map(group => group.key));
    expect(artifact.outputGroupIds).toEqual(groups.slice(0, 5).map(group => group.key));
    expect(artifact.omittedCount).toBe(2);
    expect(artifact).not.toHaveProperty("suppressedByFindings");
    expect(artifact).not.toHaveProperty("publicationFallbacks");
  });

  it("retains unchanged files for file-only hints and uncertainties while rejecting unknown and unsafe paths", () => {
    const result = packetResultWithHint();
    result.followUpHints[0]!.files = ["./schema/shared.ridl:12-15", "missing.go", "../outside.go", "/tmp/outside.go", "C:\\outside.go"];
    result.followUpHints[0]!.symbols = [];
    result.uncertainties = [{ question: "Which deployed database schema defines this constraint?",
      files: ["data/migrations/initial.sql"], symbols: [], projectedSkillIds: [] }];
    const event = vi.fn();
    const attention = buildHumanAttentionNotes([result], { packets: [packet()],
      repositoryPaths: ["lib/lifi/parser.go", "schema/shared.ridl", "data/migrations/initial.sql"],
      telemetry: { ...nullTelemetry(), event } });
    expect(attention.raw.map(hint => hint.files)).toEqual([["schema/shared.ridl"], ["data/migrations/initial.sql"]]);
    expect(attention.notes.flatMap(note => note.files)).toEqual(expect.arrayContaining(["schema/shared.ridl", "data/migrations/initial.sql"]));
    expect(attention.raw[0]!.droppedPaths).toEqual([
      { path: "../outside.go", reason: "traversal" },
      { path: "/tmp/outside.go", reason: "absolute_path" },
      { path: "C:\\outside.go", reason: "absolute_path" },
      { path: "missing.go", reason: "unknown_path" }
    ]);
    expect(event.mock.calls.filter(([value]) => value.message === "human_attention_note_path_dropped")).toHaveLength(4);
  });

  it("keeps known directories out of dropped file diagnostics", () => {
    const result = packetResultWithHint();
    result.followUpHints[0]!.files = ["./schema/", "data", "data/migrations", "schema/shared.ridl", "schema/typo.ridl"];
    result.uncertainties = [{ question: "Which schema version applies to migrations?",
      files: ["data/migrations/", "data/migrations/initial.sql"], symbols: [], projectedSkillIds: [] }];
    const event = vi.fn();
    const attention = buildHumanAttentionNotes([result], { packets: [packet()],
      repositoryPaths: ["schema/shared.ridl", "data/migrations/initial.sql"],
      telemetry: { ...nullTelemetry(), event } });
    expect(attention.raw.map(hint => hint.files)).toEqual([["schema/shared.ridl"], ["data/migrations/initial.sql"]]);
    expect(attention.raw.map(hint => hint.droppedPaths)).toEqual([[{ path: "schema/typo.ridl", reason: "unknown_path" }], []]);
    expect(event.mock.calls.map(([value]) => value).filter(value => value.message === "human_attention_note_path_dropped"))
      .toEqual([expect.objectContaining({ data: { originalPath: "schema/typo.ridl", reason: "unknown_path" } })]);
  });
});

function packet(): ReviewPacket {
  return {
    id: "packet-lifi",
    path: "lib/lifi/parser.go",
    coverage: "normal",
    reviewPriority: "normal",
    reviewProfile: "standard",
    lenses: ["core/code-review"],
    hunks: [{
      hunkId: "h1",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      contentWithLineNumbers: "",
      lines: [{ kind: "add", content: "strictParse(value)", newLine: 1 }],
      changedNewLineNumbers: [1],
      changedOldLineNumbers: []
    }],
    symbolFacts: [],
    relevantTests: [],
    relatedChangedContext: [],
    surroundingContextHints: [],
    context: { path: "lib/lifi/parser.go" }
  } as unknown as ReviewPacket;
}

function packetResultWithHint(): PacketReviewResult {
  return {
    packetId: "packet-lifi",
    lenses: ["core/code-review"],
    findings: [],
    followUpHints: [{
      question: QUESTION,
      files: ["lib/lifi/parser.go"],
      symbols: ["strictParse"],
      suggestedLenses: [],
      reason: "The changed parser hard-fails on malformed numerics that were previously tolerated.",
      confidence: "medium",
      projectedSkillIds: ["core/code-review"]
    }],
    uncertainties: [],
    status: "completed"
  };
}
