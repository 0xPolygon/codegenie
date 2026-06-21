import { describe, expect, it } from "vitest";
import {
  detectDuplicateFindings,
  formatCodegenieMarker,
  parseCodegenieMarker
} from "../src/github/duplicate-detector.js";
import type { ExistingReviewThread, FinalFinding } from "../src/types.js";

describe("GitHub duplicate detector", () => {
  it("parses and formats codegenie fingerprint markers", () => {
    const fingerprint = "a".repeat(64);
    const marker = formatCodegenieMarker(fingerprint, "run-123");

    expect(parseCodegenieMarker(`body\n${marker}`)).toEqual({ fingerprint, runId: "run-123" });
    expect(parseCodegenieMarker("body only")).toBeUndefined();
  });

  it("skips exact fingerprint and fuzzy nearby codegenie comments only", () => {
    const exact = finding({ id: "exact", fingerprint: "b".repeat(64), line: 10 });
    const nearby = finding({ id: "nearby", fingerprint: "c".repeat(64), line: 105 });
    const outside = finding({ id: "outside", fingerprint: "d".repeat(64), line: 106 });
    const foreign = finding({ id: "foreign", fingerprint: "e".repeat(64), line: 30 });
    const comments: ExistingReviewThread[] = [
      {
        id: "1",
        path: "src/app.ts",
        line: 1,
        side: "RIGHT",
        author: "bot",
        isCodegenie: true,
        fingerprint: exact.fingerprint
      },
      {
        id: "2",
        path: "src/app.ts",
        line: 100,
        side: "RIGHT",
        author: "bot",
        isCodegenie: true
      },
      {
        id: "3",
        path: "src/app.ts",
        line: 30,
        side: "RIGHT",
        author: "someone-else",
        isCodegenie: false,
        fingerprint: foreign.fingerprint
      }
    ];

    expect(detectDuplicateFindings([exact, nearby, outside, foreign], comments)).toEqual([
      expect.objectContaining({ findingId: "exact", action: "skip_exact_fingerprint", matchedCommentId: "1" }),
      expect.objectContaining({ findingId: "nearby", action: "skip_fuzzy_proximity", matchedCommentId: "2" }),
      expect.objectContaining({ findingId: "outside", action: "post" }),
      expect.objectContaining({ findingId: "foreign", action: "post" })
    ]);
  });
});

function finding(overrides: Partial<FinalFinding> & { line?: number } = {}): FinalFinding {
  const line = overrides.line ?? 1;
  return {
    id: overrides.id ?? "f1",
    title: overrides.title ?? "Finding",
    severity: "medium",
    confidence: "high",
    path: "src/app.ts",
    anchor: { path: "src/app.ts", line, side: "RIGHT", hunkId: "h1" },
    changedLine: true,
    category: "correctness",
    evidence: { changedCode: "+ changed" },
    failureMode: overrides.failureMode ?? "Something is wrong.",
    whyThisMatters: "It matters.",
    verification: "Verified.",
    producedBy: { kind: "packet", stage: 7, packetId: "p1", lensId: "core/code-review", skillIds: [] },
    fingerprint: overrides.fingerprint ?? "a".repeat(64),
    finalBody: "Body",
    publication: "inline",
    mergedCandidateIds: [overrides.id ?? "f1"]
  };
}
