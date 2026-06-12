import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { parseDiff } from "../src/git/diff-parser.js";
import { sanitizeGitHubCommentBody } from "../src/github/comment-sanitizer.js";
import { maybePublishToGitHub } from "../src/github/publisher.js";
import type {
  ExistingReviewThread,
  FinalFinding,
  GitHubClient,
  PullRequestMetadata,
  ReviewResult
} from "../src/types.js";
import { CodeninjaError } from "../src/util/errors.js";
import { nullTelemetry } from "./helpers/git.js";

const RAW_DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,1 +1,1 @@",
  "-export const value = 1;",
  "+export const value = 2; // CODENINJA_FAKE_FINDING",
  ""
].join("\n");

const MIXED_ANCHOR_DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,1 +1,3 @@",
  "-export const oldValue = 1;",
  "+export const value = 1;",
  "+export const next = 2;",
  "+export const third = 3;",
  ""
].join("\n");

describe("GitHub publisher", () => {
  it("sanitizes GitHub comment bodies deterministically", () => {
    expect(
      sanitizeGitHubCommentBody(
        "hello @team <!-- forged --> token = abcdefghijklmnop AKIA1234567890ABCDEF"
      )
    ).toBe("hello `@team`  token = [redacted:secret] [redacted:pattern]");
  });

  it("posts one sanitized COMMENT review and records the posting outcome", async () => {
    const diff = parseDiff(RAW_DIFF);
    const hunk = diff.files[0]?.hunks[0];
    if (!hunk) {
      throw new Error("missing hunk");
    }
    const finding = finalFinding({ hunkId: hunk.id, line: 1, finalBody: "Fix @team. <!--bad--> token = abcdefghijklmnop" });
    const created: Array<{ body: string; comments: Array<{ body: string; line: number }> }> = [];
    const github = fakeGithub({
      createReview: async (_number, review) => {
        created.push(review);
      }
    });
    const result = reviewResult(finding);

    const record = await maybePublishToGitHub(result, resolved(), defaultConfig, nullTelemetry(), { github, diff });

    expect(record?.status).toBe("posted");
    expect(record?.inlinePosted).toBe(1);
    expect(result.posting?.status).toBe("posted");
    expect(created).toHaveLength(1);
    expect(created[0]?.comments).toHaveLength(1);
    expect(created[0]?.body).toBe("Found issues.");
    expect(created[0]?.comments[0]?.body).toContain("`@team`");
    expect(created[0]?.comments[0]?.body).not.toContain("<!--bad-->");
    expect(created[0]?.comments[0]?.body).toContain("<!-- codeninja:fingerprint=");
  });

  it("fails before posting when the PR head changed after resolution", async () => {
    const diff = parseDiff(RAW_DIFF);
    const hunk = diff.files[0]?.hunks[0];
    if (!hunk) {
      throw new Error("missing hunk");
    }
    const viewOpts: Array<{ refresh?: boolean } | undefined> = [];
    const github = fakeGithub({
      viewPr: async (_number, opts) => {
        viewOpts.push(opts);
        return { ...pr(), headSha: "n".repeat(40) };
      },
      createReview: async () => {
        throw new Error("must not post when PR head moved");
      }
    });

    await expect(
      maybePublishToGitHub(reviewResult(finalFinding({ hunkId: hunk.id, line: 1 })), resolved(), defaultConfig, nullTelemetry(), {
        github,
        diff
      })
    ).rejects.toMatchObject({
      code: "github_post_failed",
      message: expect.stringContaining("changed while review was running")
    });
    expect(viewOpts).toEqual([{ refresh: true }]);
  });

  it("demotes invalid anchors into the review body instead of posting them inline", async () => {
    const diff = parseDiff(RAW_DIFF);
    const hunk = diff.files[0]?.hunks[0];
    if (!hunk) {
      throw new Error("missing hunk");
    }
    const finding = finalFinding({ hunkId: hunk.id, line: 2, side: "LEFT" });
    const created: Array<{ body: string; comments: unknown[] }> = [];
    const github = fakeGithub({
      createReview: async (_number, review) => {
        created.push(review);
      }
    });

    const record = await maybePublishToGitHub(reviewResult(finding), resolved(), defaultConfig, nullTelemetry(), {
      github,
      diff
    });

    expect(record?.status).toBe("posted");
    expect(record?.inlinePosted).toBe(0);
    expect(record?.demotedToBody).toBe(1);
    expect(created[0]?.comments).toEqual([]);
    expect(created[0]?.body).toContain("Inline findings included in the review body");
  });

  it("skips duplicate inline findings without demoting them", async () => {
    const diff = parseDiff(RAW_DIFF);
    const hunk = diff.files[0]?.hunks[0];
    if (!hunk) {
      throw new Error("missing hunk");
    }
    const finding = finalFinding({ hunkId: hunk.id, line: 1 });
    const github = fakeGithub({
      comments: [
        {
          id: "prior",
          path: "src/app.ts",
          line: 1,
          side: "RIGHT",
          author: "codebot",
          isCodeninja: true,
          fingerprint: finding.fingerprint
        }
      ],
      createReview: async () => {
        throw new Error("duplicate-only run should not post");
      }
    });

    const record = await maybePublishToGitHub(reviewResult(finding), resolved(), defaultConfig, nullTelemetry(), {
      github,
      diff
    });

    expect(record?.status).toBe("skipped_all_duplicates");
    expect(record?.skippedDuplicates).toBe(1);
    expect(record?.demotedToBody).toBe(0);
  });

  it("recovers from a 422 by demoting identified rejected comments and retrying", async () => {
    const diff = parseDiff(RAW_DIFF);
    const hunk = diff.files[0]?.hunks[0];
    if (!hunk) {
      throw new Error("missing hunk");
    }
    const first = finalFinding({ id: "f1", hunkId: hunk.id, line: 1 });
    const second = finalFinding({ id: "f2", hunkId: hunk.id, line: 1, fingerprint: "b".repeat(64) });
    const commentCounts: number[] = [];
    const github = fakeGithub({
      createReview: async (_number, review) => {
        commentCounts.push(review.comments.length);
        if (commentCounts.length === 1) {
          throw new CodeninjaError("github_post_failed", "HTTP 422", {
            context: { stderr: JSON.stringify({ errors: [{ index: 0 }] }) }
          });
        }
      }
    });

    const record = await maybePublishToGitHub(reviewResult(first, second), resolved(), defaultConfig, nullTelemetry(), {
      github,
      diff
    });

    expect(commentCounts).toEqual([2, 1]);
    expect(record?.status).toBe("posted");
    expect(record?.inlinePosted).toBe(1);
    expect(record?.demotedToBody).toBe(1);
    expect(record?.attempts).toEqual([
      { httpStatus: 422, commentCount: 2, outcome: "rejected" },
      { commentCount: 1, outcome: "ok" }
    ]);
  });

  it("tries local 422 suspect classes in order before demoting later classes", async () => {
    const diff = parseDiff(MIXED_ANCHOR_DIFF);
    const hunk = diff.files[0]?.hunks[0];
    if (!hunk) {
      throw new Error("missing hunk");
    }
    const left = finalFinding({
      id: "left",
      hunkId: hunk.id,
      line: 1,
      side: "LEFT",
      fingerprint: "b".repeat(64),
      finalBody: "LEFT-side comment should move to the body."
    });
    const multiline = finalFinding({
      id: "multi",
      hunkId: hunk.id,
      line: 2,
      startLine: 1,
      fingerprint: "c".repeat(64),
      finalBody: "Valid multiline comment should stay inline."
    });
    const right = finalFinding({
      id: "right",
      hunkId: hunk.id,
      line: 3,
      fingerprint: "d".repeat(64),
      finalBody: "Right single-line comment should stay inline."
    });
    const commentCounts: number[] = [];
    const postedBodies: string[] = [];
    const postedCommentBodies: string[][] = [];
    const github = fakeGithub({
      createReview: async (_number, review) => {
        commentCounts.push(review.comments.length);
        if (commentCounts.length === 1) {
          throw new CodeninjaError("github_post_failed", "HTTP 422", {
            context: { stderr: "Validation failed without comment indexes" }
          });
        }
        postedBodies.push(review.body);
        postedCommentBodies.push(review.comments.map((comment) => comment.body));
      }
    });

    const record = await maybePublishToGitHub(reviewResult(left, multiline, right), resolved(), defaultConfig, nullTelemetry(), {
      github,
      diff
    });

    expect(commentCounts).toEqual([3, 2]);
    expect(record?.status).toBe("posted");
    expect(record?.inlinePosted).toBe(2);
    expect(record?.demotedToBody).toBe(1);
    expect(postedBodies[0]).toContain("LEFT-side comment should move to the body.");
    expect(postedBodies[0]).not.toContain("Valid multiline comment should stay inline.");
    expect(postedBodies[0]).not.toContain("Right single-line comment should stay inline.");
    expect(postedCommentBodies[0]).toEqual([
      expect.stringContaining("Valid multiline comment should stay inline."),
      expect.stringContaining("Right single-line comment should stay inline.")
    ]);
  });

  it("demotes path-line-side identified 422 failures before local suspect fallback", async () => {
    const diff = parseDiff(MIXED_ANCHOR_DIFF);
    const hunk = diff.files[0]?.hunks[0];
    if (!hunk) {
      throw new Error("missing hunk");
    }
    const left = finalFinding({
      id: "left",
      hunkId: hunk.id,
      line: 1,
      side: "LEFT",
      fingerprint: "b".repeat(64),
      finalBody: "Valid LEFT-side comment should stay inline."
    });
    const right = finalFinding({
      id: "right",
      hunkId: hunk.id,
      line: 3,
      fingerprint: "c".repeat(64),
      finalBody: "Path-identified comment should move to the body."
    });
    const commentCounts: number[] = [];
    const postedBodies: string[] = [];
    const postedCommentBodies: string[][] = [];
    const github = fakeGithub({
      createReview: async (_number, review) => {
        commentCounts.push(review.comments.length);
        if (commentCounts.length === 1) {
          throw new CodeninjaError("github_post_failed", "HTTP 422", {
            context: { stderr: JSON.stringify({ errors: [{ path: "src/app.ts", line: 3, side: "RIGHT" }] }) }
          });
        }
        postedBodies.push(review.body);
        postedCommentBodies.push(review.comments.map((comment) => comment.body));
      }
    });

    const record = await maybePublishToGitHub(reviewResult(left, right), resolved(), defaultConfig, nullTelemetry(), {
      github,
      diff
    });

    expect(commentCounts).toEqual([2, 1]);
    expect(record?.status).toBe("posted");
    expect(record?.inlinePosted).toBe(1);
    expect(record?.demotedToBody).toBe(1);
    expect(postedBodies[0]).toContain("Path-identified comment should move to the body.");
    expect(postedBodies[0]).not.toContain("Valid LEFT-side comment should stay inline.");
    expect(postedCommentBodies[0]).toEqual([expect.stringContaining("Valid LEFT-side comment should stay inline.")]);
  });

  it("uses the third attempt as summary-only after a second unidentified 422 demotes a suspect class", async () => {
    const diff = parseDiff(MIXED_ANCHOR_DIFF);
    const hunk = diff.files[0]?.hunks[0];
    if (!hunk) {
      throw new Error("missing hunk");
    }
    const left = finalFinding({
      id: "left",
      hunkId: hunk.id,
      line: 1,
      side: "LEFT",
      fingerprint: "b".repeat(64),
      finalBody: "LEFT-side comment should move to the body."
    });
    const multiline = finalFinding({
      id: "multi",
      hunkId: hunk.id,
      line: 2,
      startLine: 1,
      fingerprint: "c".repeat(64),
      finalBody: "Multiline comment should move to the body."
    });
    const right = finalFinding({
      id: "right",
      hunkId: hunk.id,
      line: 3,
      fingerprint: "d".repeat(64),
      finalBody: "Remaining right comment should move to the summary-only fallback."
    });
    const commentCounts: number[] = [];
    const postedBodies: string[] = [];
    const github = fakeGithub({
      createReview: async (_number, review) => {
        commentCounts.push(review.comments.length);
        if (commentCounts.length <= 2) {
          throw new CodeninjaError("github_post_failed", "HTTP 422", {
            context: { stderr: "Validation failed without comment indexes" }
          });
        }
        postedBodies.push(review.body);
      }
    });

    const record = await maybePublishToGitHub(reviewResult(left, multiline, right), resolved(), defaultConfig, nullTelemetry(), {
      github,
      diff
    });

    expect(commentCounts).toEqual([3, 2, 0]);
    expect(record?.status).toBe("summary_only_fallback");
    expect(record?.inlinePosted).toBe(0);
    expect(record?.demotedToBody).toBe(3);
    expect(postedBodies[0]).toContain("LEFT-side comment should move to the body.");
    expect(postedBodies[0]).toContain("Multiline comment should move to the body.");
    expect(postedBodies[0]).toContain("Remaining right comment should move to the summary-only fallback.");
  });

  it("sanitizes 422-demoted findings and reports summary-only fallback when all comments demote", async () => {
    const diff = parseDiff(RAW_DIFF);
    const hunk = diff.files[0]?.hunks[0];
    if (!hunk) {
      throw new Error("missing hunk");
    }
    const finding = finalFinding({
      id: "f1",
      hunkId: hunk.id,
      line: 1,
      finalBody: "Ping @team <!-- hidden --> token = abcdefghijklmnop"
    });
    const commentCounts: number[] = [];
    const postedBodies: string[] = [];
    const github = fakeGithub({
      createReview: async (_number, review) => {
        commentCounts.push(review.comments.length);
        if (commentCounts.length === 1) {
          throw new CodeninjaError("github_post_failed", "HTTP 422", {
            context: { stderr: JSON.stringify({ errors: [{ index: 0 }] }) }
          });
        }
        postedBodies.push(review.body);
      }
    });

    const record = await maybePublishToGitHub(reviewResult(finding), resolved(), defaultConfig, nullTelemetry(), {
      github,
      diff
    });

    expect(commentCounts).toEqual([1, 0]);
    expect(record?.status).toBe("summary_only_fallback");
    expect(record?.inlinePosted).toBe(0);
    expect(record?.demotedToBody).toBe(1);
    expect(postedBodies[0]).toContain("`@team`");
    expect(postedBodies[0]).toContain("[redacted:secret]");
    expect(postedBodies[0]).not.toContain("<!-- hidden -->");
  });

  it("uses the third 422 attempt for summary-only fallback after repeated identified rejections", async () => {
    const diff = parseDiff(RAW_DIFF);
    const hunk = diff.files[0]?.hunks[0];
    if (!hunk) {
      throw new Error("missing hunk");
    }
    const findings = [
      finalFinding({ id: "f1", hunkId: hunk.id, line: 1, fingerprint: "a".repeat(64) }),
      finalFinding({ id: "f2", hunkId: hunk.id, line: 1, fingerprint: "b".repeat(64) }),
      finalFinding({ id: "f3", hunkId: hunk.id, line: 1, fingerprint: "c".repeat(64) })
    ];
    const commentCounts: number[] = [];
    const github = fakeGithub({
      createReview: async (_number, review) => {
        commentCounts.push(review.comments.length);
        if (commentCounts.length <= 2) {
          throw new CodeninjaError("github_post_failed", "HTTP 422", {
            context: { stderr: JSON.stringify({ errors: [{ index: 0 }] }) }
          });
        }
      }
    });

    const record = await maybePublishToGitHub(reviewResult(...findings), resolved(), defaultConfig, nullTelemetry(), {
      github,
      diff
    });

    expect(commentCounts).toEqual([3, 2, 0]);
    expect(record?.status).toBe("summary_only_fallback");
    expect(record?.inlinePosted).toBe(0);
    expect(record?.demotedToBody).toBe(3);
  });
});

function fakeGithub(
  opts: {
    comments?: ExistingReviewThread[];
    viewPr?: GitHubClient["viewPr"];
    createReview?: GitHubClient["createReview"];
  } = {}
): GitHubClient {
  return {
    viewPr: opts.viewPr ?? (async () => pr()),
    listOwnComments: async () => opts.comments ?? [],
    createReview: opts.createReview ?? (async () => undefined)
  };
}

function resolved() {
  return {
    mode: "github_pr" as const,
    repoRoot: "/repo",
    baseRef: "b".repeat(40),
    headRef: "h".repeat(40),
    mergeBase: "m".repeat(40),
    headSha: "h".repeat(40),
    pr: pr(),
    commits: [],
    rawDiff: RAW_DIFF
  };
}

function pr(): PullRequestMetadata {
  return {
    owner: "0xPolygon",
    repo: "codeninja",
    number: 1,
    title: "PR",
    body: "",
    url: "https://github.com/0xPolygon/codeninja/pull/1",
    baseRefName: "main",
    baseSha: "b".repeat(40),
    headRefName: "feature",
    headSha: "h".repeat(40)
  };
}

function reviewResult(...findings: FinalFinding[]): ReviewResult {
  return {
    summary: "Found issues.",
    coverage: {
      totalHunks: 1,
      reviewedHunks: 1,
      skippedHunks: 0,
      failedHunks: 0,
      coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
      degradedPlanning: false,
      budgetStopped: false,
      verificationIncompleteCount: 0,
      partial: false,
      reasons: []
    },
    findings,
    summaryOnlyFindings: [],
    needsHumanAttention: [],
    noFindings: findings.length === 0,
    postingPlan: {
      inline: findings.map((finding) => ({ findingId: finding.id, anchor: finding.anchor! })),
      reviewBody: "Found issues."
    }
  };
}

function finalFinding(
  overrides: {
    id?: string;
    hunkId: string;
    line: number;
    side?: "RIGHT" | "LEFT";
    startLine?: number;
    startSide?: "RIGHT" | "LEFT";
    fingerprint?: string;
    finalBody?: string;
  }
): FinalFinding {
  const id = overrides.id ?? "f1";
  const anchor = {
    path: "src/app.ts",
    line: overrides.line,
    side: overrides.side ?? "RIGHT",
    hunkId: overrides.hunkId,
    ...(overrides.startLine !== undefined ? { startLine: overrides.startLine } : {}),
    ...(overrides.startSide !== undefined ? { startSide: overrides.startSide } : {})
  };
  return {
    id,
    title: "Changed value causes stale behavior",
    severity: "medium",
    confidence: "high",
    path: "src/app.ts",
    anchor,
    changedLine: true,
    category: "correctness",
    evidence: { changedCode: "+export const value = 2;" },
    failureMode: "The changed value breaks callers.",
    whyThisMatters: "Callers observe the wrong value.",
    suggestedFix: "Restore the old behavior.",
    verification: "The diff changes the value.",
    producedBy: { kind: "packet", stage: 7, packetId: "p1", lensId: "core/code-review", skillIds: [] },
    fingerprint: overrides.fingerprint ?? "a".repeat(64),
    finalBody: overrides.finalBody ?? "The changed value breaks callers.",
    publication: "inline",
    mergedCandidateIds: [id]
  };
}
