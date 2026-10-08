import { describe, expect, it } from "vitest";
import {
  carryForwardIssues,
  changedLinesFromPatch,
  formatVerdictMarker,
  parseVerdictMarker,
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
    expect(carryForwardIssues([issue], new Set(), [{ path: "src/app.ts", patchMissing: false, addedLines: [4], deletedLines: [] }])).toEqual([issue]);
    expect(carryForwardIssues([issue], new Set(), [{ path: "src/app.ts", patchMissing: false, addedLines: [], deletedLines: [4] }])).toEqual([]);
    expect(carryForwardIssues([{ ...issue, lineBasis: "current" }], new Set(), [{ path: "src/app.ts", patchMissing: false, addedLines: [4], deletedLines: [] }])).toEqual([]);
    expect(changedLinesFromPatch("@@ -1,1 +1,2 @@\n context\n+added\n").addedLines).toEqual([2]);
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
