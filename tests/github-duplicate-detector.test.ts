import { describe, expect, it } from "vitest";
import {
  detectDuplicateFindings,
  formatCodegenieMarker,
  parseCodegenieMarker,
  proseContentFingerprint
} from "../src/github/duplicate-detector.js";
import type { ExistingReviewThread, FinalFinding } from "../src/types.js";

describe("GitHub duplicate detector", () => {
  it("parses and formats codegenie fingerprint markers", () => {
    const fingerprint = "a".repeat(64);
    const marker = formatCodegenieMarker(fingerprint, "run-123");

    expect(parseCodegenieMarker(`body\n${marker}`)).toEqual({ fingerprint, runId: "run-123" });
    expect(parseCodegenieMarker("body only")).toBeUndefined();
  });

  it("round trips content markers while retaining legacy marker support", () => {
    const fingerprint = "a".repeat(64), contentFingerprint = "b".repeat(64);
    expect(parseCodegenieMarker(formatCodegenieMarker(fingerprint, "run-1", contentFingerprint)))
      .toEqual({ fingerprint, runId: "run-1", contentFingerprint });
    expect(proseContentFingerprint("\r\nSome unchanged advice.\r\n")).toBe(proseContentFingerprint("Some unchanged advice."));
    expect(proseContentFingerprint(" ")).toBeUndefined();
  });

  it.each(["docs/design.md", "README.MD", "guide.mdx", "guide.rst", "notes.txt"])("matches legacy prose content across distant or different anchors in %s", path => {
    const body = "The table lists widgetCreated, but EventKind does not define it.";
    const f = { ...finding({ line: 74 }), path, finalBody: body,
      anchor: { path, side: "RIGHT" as const, hunkId: "new-hunk", line: 74 } };
    expect(detectDuplicateFindings([f], [{ id: "previous", path: f.path, line: 81, side: "RIGHT", author: "bot", isCodegenie: true,
      fingerprint: "b".repeat(64), body: `${body}\n\n${formatCodegenieMarker("b".repeat(64), "old-run")}` }]))
      .toEqual([expect.objectContaining({ action: "skip_unchanged_content" })]);
  });

  it.each([20, 21, 180])("does not hide a different prose defect at line %i under an old fingerprint or proximity", line => {
    const f = { ...finding({ line }), path: "docs/api.md", finalBody: "Retrying this request creates duplicate orders.",
      anchor: { path: "docs/api.md", side: "RIGHT" as const, hunkId: "new", line } };
    expect(detectDuplicateFindings([f], [{ id: "old", path: f.path, line: 20, side: "RIGHT", author: "bot", isCodegenie: true,
      fingerprint: f.fingerprint, body: "The enum value is not defined." }])[0]?.action).toBe("post");
  });

  it("does not match absent content, other files, other sides, or foreign comments", () => {
    const f = { ...finding(), path: "docs/api.md", finalBody: "An actionable issue.",
      anchor: { path: "docs/api.md", side: "RIGHT" as const, hunkId: "h1", line: 1 } };
    const base = { id: "old", path: f.path, side: "RIGHT" as const, author: "bot", isCodegenie: true,
      fingerprint: f.fingerprint, body: f.finalBody };
    for (const comment of [{ ...base, body: "" }, { ...base, path: "docs/other.md" },
      { ...base, side: "LEFT" as const }, { ...base, isCodegenie: false }]) {
      expect(detectDuplicateFindings([f], [comment])[0]?.action).toBe("post");
    }
  });

  it("preserves code fingerprint behavior for executable examples under docs", () => {
    const f = { ...finding(), path: "docs/examples/server.ts" };
    expect(detectDuplicateFindings([f], [{ id: "old", author: "bot", isCodegenie: true, fingerprint: f.fingerprint }])[0]?.action)
      .toBe("skip_exact_fingerprint");
  });

  it("does not treat two missing anchor sides as a proven prose match", () => {
    const { anchor: _anchor, ...unanchored } = finding();
    const f = { ...unanchored, path: "docs/api.md" };
    expect(detectDuplicateFindings([f], [{ id: "old", path: f.path, author: "bot", isCodegenie: true,
      body: f.finalBody }])[0]?.action).toBe("post");
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
