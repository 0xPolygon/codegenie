import { describe, expect, it } from "vitest";
import {
  carryForwardIssues,
  changedLinesFromPatch,
  formatVerdictMarker,
  parseVerdictMarker,
  renderCarriedIssues,
  selectPostedEvent,
  staleApproval
} from "../src/github/review-verdict.js";

describe("review verdict", () => {
  it("keeps comment mode on COMMENT and does not force a post", () => {
    expect(selectPostedEvent({ mode: "comment", health: "completed", openIssueCount: 0 })).toEqual({
      event: "COMMENT",
      forcePost: false
    });
  });

  it("requests changes for open issues and approves only a clean completed approve-mode review", () => {
    expect(selectPostedEvent({ mode: "approve", health: "completed", openIssueCount: 1 }).event).toBe("REQUEST_CHANGES");
    expect(selectPostedEvent({ mode: "approve", health: "completed", openIssueCount: 0 }).event).toBe("APPROVE");
    expect(selectPostedEvent({ mode: "approve", health: "incomplete", openIssueCount: 0 }).event).toBe("COMMENT");
    expect(selectPostedEvent({ mode: "approve", health: "completed", openIssueCount: 0 }).event).toBe("APPROVE");
  });

  it("round-trips the verdict marker and treats an untouched anchor as still open", () => {
    const issue = { fingerprint: "a".repeat(64), path: "src/app.ts", line: 4, side: "RIGHT" as const, lineBasis: "previous" as const };
    const marker = formatVerdictMarker("approve", "abc1234", [issue]);
    expect(parseVerdictMarker(marker)?.open).toEqual([issue]);
    // A line inserted above the untouched anchor moves it to line 5 on the new head.
    expect(carryForwardIssues([issue], new Set(), [{ path: "src/app.ts", patchMissing: false, addedLines: [4], deletedLines: [] }])).toEqual([{ ...issue, line: 5 }]);
    expect(carryForwardIssues([issue], new Set(), [{ path: "src/app.ts", patchMissing: false, addedLines: [], deletedLines: [4] }])).toEqual([]);
    expect(carryForwardIssues([{ ...issue, lineBasis: "current" }], new Set(), [{ path: "src/app.ts", patchMissing: false, addedLines: [4], deletedLines: [] }])).toEqual([]);
    expect(changedLinesFromPatch("@@ -1,1 +1,2 @@\n context\n+added\n").addedLines).toEqual([2]);
  });

  it("rebases a carried RIGHT line onto the new head and leaves LEFT and patch-less lines alone", () => {
    const issue = { fingerprint: "f".repeat(64), path: "src/app.ts", line: 10, side: "RIGHT" as const, lineBasis: "previous" as const };
    // Two lines added above, one deleted above: 10 -> 11.
    const shifted = [{ path: "src/app.ts", patchMissing: false, addedLines: [2, 3], deletedLines: [5] }];
    expect(carryForwardIssues([issue], new Set(), shifted)).toEqual([{ ...issue, line: 11 }]);
    // An unrelated change below the anchor neither moves nor settles it.
    expect(carryForwardIssues([issue], new Set(), [{ path: "src/app.ts", patchMissing: false, addedLines: [20], deletedLines: [20] }])).toEqual([issue]);
    expect(carryForwardIssues([{ ...issue, side: "LEFT" as const }], new Set(), [{ path: "src/other.ts", patchMissing: false, addedLines: [1], deletedLines: [] }])).toEqual([{ ...issue, side: "LEFT" }]);
    expect(carryForwardIssues([issue], new Set(), [{ ...shifted[0]!, patchMissing: true }])).toEqual([issue]);
  });

  it("settles a file-level issue once its file changes, never shifts it, and renders it without a line", () => {
    const fileLevel = { fingerprint: "9".repeat(64), path: "src/app.ts", line: 0, side: "RIGHT" as const, lineBasis: "previous" as const };
    expect(carryForwardIssues([fileLevel], new Set(), [])).toEqual([fileLevel]);
    expect(carryForwardIssues([fileLevel], new Set(), [{ path: "src/app.ts", patchMissing: false, addedLines: [], deletedLines: [] }])).toEqual([fileLevel]);
    expect(carryForwardIssues([fileLevel], new Set(), [{ path: "src/app.ts", patchMissing: false, addedLines: [1], deletedLines: [] }])).toEqual([]);
    expect(renderCarriedIssues([fileLevel])).toContain("- `src/app.ts` was not changed");
  });

  it("keeps an unmovable carried line tied to its own commit and drops that commit once the line moves", () => {
    const issue = { fingerprint: "a".repeat(64), path: "src/app.ts", line: 4, side: "RIGHT" as const, lineBasis: "previous" as const };
    const origin = "c".repeat(40);
    const stuck = carryForwardIssues([issue], new Set(), undefined, origin);
    expect(stuck).toEqual([{ ...issue, commit: origin }]);
    const marker = formatVerdictMarker("approve", "e".repeat(40), stuck);
    expect(marker).toContain(`:4:RIGHT:${origin}`);
    expect(parseVerdictMarker(marker)?.open).toEqual([{ ...issue, commit: origin }]);
    expect(carryForwardIssues([issue], new Set(), [{ path: "src/app.ts", patchMissing: true, addedLines: [], deletedLines: [] }], origin)).toEqual([{ ...issue, commit: origin }]);
    // Once a compare from that commit can move the line, the recorded commit is no longer needed.
    expect(carryForwardIssues([{ ...issue, commit: origin }], new Set(), [{ path: "src/app.ts", patchMissing: false, addedLines: [1], deletedLines: [] }], origin)).toEqual([{ ...issue, line: 5 }]);
    // Four-field entries from older markers still parse, without a commit.
    expect(parseVerdictMarker(`<!-- codegenie:verdict=approve;commit=abc1234;open=${"a".repeat(64)}:src%2Fapp.ts:4:RIGHT -->`)?.open).toEqual([issue]);
  });

  it("drops a marker entry with an invalid path escape and keeps its valid siblings", () => {
    const good = `${"a".repeat(64)}:src%2Fapp.ts:4:RIGHT`;
    expect(parseVerdictMarker(`<!-- codegenie:verdict=approve;commit=abc1234;open=${"b".repeat(64)}:bad%zz:4:RIGHT -->`)?.open).toEqual([]);
    expect(parseVerdictMarker(`<!-- codegenie:verdict=approve;commit=abc1234;open=${"b".repeat(64)}:bad%zz:4:RIGHT,${good} -->`)?.open).toEqual([
      { fingerprint: "a".repeat(64), path: "src/app.ts", line: 4, side: "RIGHT", lineBasis: "previous" }
    ]);
  });

  it("settles an issue whose file was renamed and keeps one whose file is absent from the compare", () => {
    const issue = { fingerprint: "e".repeat(64), path: "src/old.ts", line: 4, side: "RIGHT" as const, lineBasis: "previous" as const };
    const renamed = { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed", patchMissing: false, addedLines: [], deletedLines: [] };
    expect(carryForwardIssues([issue], new Set(), [renamed])).toEqual([]);
    expect(carryForwardIssues([issue], new Set(), [{ ...renamed, previousPath: "src/other.ts" }])).toEqual([issue]);
  });

  it("keeps a prior issue open when the compare patch is unavailable", () => {
    const right = { fingerprint: "a".repeat(64), path: "src/app.ts", line: 4, side: "RIGHT" as const, lineBasis: "previous" as const };
    const left = { ...right, fingerprint: "c".repeat(64), side: "LEFT" as const };
    const patchless = [{ path: "src/app.ts", patchMissing: true, addedLines: [4], deletedLines: [4] }];
    expect(carryForwardIssues([right], new Set(), patchless)).toEqual([right]);
    expect(carryForwardIssues([{ ...right, lineBasis: "current" as const }], new Set(), patchless)).toEqual([{ ...right, lineBasis: "current" }]);
    expect(carryForwardIssues([left], new Set(), patchless)).toEqual([left]);
  });

  it("settles a LEFT anchor once its file changes and keeps it while the file is untouched", () => {
    const left = { fingerprint: "b".repeat(64), path: "src/app.ts", line: 9, side: "LEFT" as const, lineBasis: "previous" as const };
    expect(carryForwardIssues([left], new Set(), [])).toEqual([left]);
    expect(carryForwardIssues([left], new Set(), [{ path: "src/app.ts", patchMissing: false, addedLines: [2], deletedLines: [] }])).toEqual([]);
    expect(carryForwardIssues([{ ...left, lineBasis: "current" }], new Set(), [{ path: "src/app.ts", patchMissing: false, addedLines: [], deletedLines: [3] }])).toEqual([]);
  });

  it("dismisses only a stale approval, never a standing change request", () => {
    const head = "h".repeat(40);
    const approved = { id: "1", state: "APPROVED", commitId: "a".repeat(40), submittedAt: "2026-01-02T00:00:00Z" };
    const requested = { id: "2", state: "CHANGES_REQUESTED", commitId: "a".repeat(40), submittedAt: "2026-01-03T00:00:00Z" };
    expect(staleApproval([approved], head)?.id).toBe("1");
    expect(staleApproval([approved, requested], head)).toBeUndefined();
    expect(staleApproval([{ ...approved, commitId: head }], head)).toBeUndefined();
    const commented = { id: "3", state: "COMMENTED", commitId: "b".repeat(40), submittedAt: "2026-01-04T00:00:00Z" };
    expect(staleApproval([approved, commented], head)?.id).toBe("1");
    expect(staleApproval([approved, requested, commented], head)).toBeUndefined();
  });
});
