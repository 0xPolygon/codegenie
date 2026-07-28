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
import { CodegenieError } from "../src/util/errors.js";
import { nullTelemetry } from "./helpers/git.js";

const RAW_DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,1 +1,1 @@",
  "-export const value = 1;",
  "+export const value = 2; // CODEGENIE_FAKE_FINDING",
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

const DELETED_AND_LEFT_DIFF = [
  "diff --git a/src/deleted.ts b/src/deleted.ts",
  "deleted file mode 100644",
  "index 1111111..0000000",
  "--- a/src/deleted.ts",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-export const removed = true;",
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,1 +1,2 @@",
  "-export const oldValue = 1;",
  "+export const value = 1;",
  "+export const next = 2;",
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
    expect(created[0]?.comments[0]?.body).toContain("<!-- codegenie:fingerprint=");
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

  it("demotes low-confidence inline findings into the review body", async () => {
    const diff = parseDiff(RAW_DIFF);
    const hunk = diff.files[0]?.hunks[0];
    if (!hunk) {
      throw new Error("missing hunk");
    }
    const finding = finalFinding({ hunkId: hunk.id, line: 1, confidence: "low", finalBody: "Low confidence body." });
    const created: Array<{ body: string; comments: unknown[] }> = [];
    const github = fakeGithub({
      createReview: async (_number, review) => {
        created.push(review);
      }
    });

    const record = await maybePublishToGitHub(reviewResult(finding), resolved(), defaultConfig, nullTelemetry(), { github, diff });

    expect(record?.status).toBe("posted");
    expect(record?.inlinePosted).toBe(0);
    expect(record?.demotedToBody).toBe(1);
    expect(created[0]?.comments).toEqual([]);
    expect(created[0]?.body).toContain("Low confidence body.");
  });

  it("posts a configured no-finding summary comment", async () => {
    const created: Array<{ body: string; comments: unknown[] }> = [];
    const github = fakeGithub({
      createReview: async (_number, review) => {
        created.push(review);
      }
    });

    const record = await maybePublishToGitHub(reviewResult(), resolved(), {
      ...defaultConfig,
      github: { ...defaultConfig.github, summaryWhenNoFindings: true }
    }, nullTelemetry(), { github, diff: parseDiff(RAW_DIFF) });

    expect(record?.status).toBe("posted");
    expect(record?.inlinePosted).toBe(0);
    expect(created).toEqual([expect.objectContaining({ comments: [], body: "Found issues.", event: "COMMENT" })]);
  });

  it("caps oversized inline and review bodies before posting", async () => {
    const diff = parseDiff(RAW_DIFF);
    const hunk = diff.files[0]?.hunks[0];
    if (!hunk) {
      throw new Error("missing hunk");
    }
    const finding = finalFinding({
      hunkId: hunk.id,
      line: 1,
      finalBody: "x".repeat(20_000)
    });
    const result = reviewResult(finding);
    result.postingPlan = {
      ...result.postingPlan!,
      reviewBody: "y".repeat(100_000)
    };
    const created: Array<{ body: string; comments: Array<{ body: string }> }> = [];
    const github = fakeGithub({
      createReview: async (_number, review) => {
        created.push(review);
      }
    });

    await maybePublishToGitHub(result, resolved(), defaultConfig, nullTelemetry(), { github, diff });

    expect(created[0]?.body.length).toBeLessThanOrEqual(60_000);
    expect(created[0]?.body).toContain("... (truncated)");
    expect(created[0]?.comments[0]?.body.length).toBeLessThanOrEqual(10_200);
    expect(created[0]?.comments[0]?.body).toContain("... (truncated)");
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
          isCodegenie: true,
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
          throw github422({ errors: [{ index: 0 }] });
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
          throw github422({ message: "Validation failed without comment indexes" });
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

  it("demotes deleted-file anchors before other LEFT-side anchors on unidentified 422s", async () => {
    const diff = parseDiff(DELETED_AND_LEFT_DIFF);
    const deletedHunk = diff.files.find((file) => file.path === "src/deleted.ts")?.hunks[0];
    const appHunk = diff.files.find((file) => file.path === "src/app.ts")?.hunks[0];
    if (!deletedHunk || !appHunk) {
      throw new Error("missing hunks");
    }
    const deleted = finalFinding({
      id: "deleted",
      path: "src/deleted.ts",
      hunkId: deletedHunk.id,
      line: 1,
      side: "LEFT",
      fingerprint: "b".repeat(64),
      finalBody: "Deleted-file comment should move to the body first."
    });
    const left = finalFinding({
      id: "left",
      path: "src/app.ts",
      hunkId: appHunk.id,
      line: 1,
      side: "LEFT",
      fingerprint: "c".repeat(64),
      finalBody: "Ordinary LEFT-side comment should stay inline."
    });
    const right = finalFinding({
      id: "right",
      path: "src/app.ts",
      hunkId: appHunk.id,
      line: 2,
      side: "RIGHT",
      fingerprint: "d".repeat(64),
      finalBody: "Right-side comment should stay inline."
    });
    const commentCounts: number[] = [];
    const postedBodies: string[] = [];
    const postedCommentBodies: string[][] = [];
    const github = fakeGithub({
      createReview: async (_number, review) => {
        commentCounts.push(review.comments.length);
        if (commentCounts.length === 1) {
          throw github422({ message: "Validation failed without comment indexes" });
        }
        postedBodies.push(review.body);
        postedCommentBodies.push(review.comments.map((comment) => comment.body));
      }
    });

    const record = await maybePublishToGitHub(reviewResult(deleted, left, right), resolved(), defaultConfig, nullTelemetry(), {
      github,
      diff
    });

    expect(commentCounts).toEqual([3, 2]);
    expect(record?.status).toBe("posted");
    expect(record?.inlinePosted).toBe(2);
    expect(record?.demotedToBody).toBe(1);
    expect(postedBodies[0]).toContain("Deleted-file comment should move to the body first.");
    expect(postedBodies[0]).not.toContain("Ordinary LEFT-side comment should stay inline.");
    expect(postedBodies[0]).not.toContain("Right-side comment should stay inline.");
    expect(postedCommentBodies[0]).toEqual([
      expect.stringContaining("Ordinary LEFT-side comment should stay inline."),
      expect.stringContaining("Right-side comment should stay inline.")
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
          throw github422({ errors: [{ path: "src/app.ts", line: 3, side: "RIGHT" }] });
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

  it("uses the third attempt to preserve remaining valid inline comments after a second unidentified 422", async () => {
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
    const postedCommentBodies: string[][] = [];
    const github = fakeGithub({
      createReview: async (_number, review) => {
        commentCounts.push(review.comments.length);
        if (commentCounts.length <= 2) {
          throw github422({ message: "Validation failed without comment indexes" });
        }
        postedBodies.push(review.body);
        postedCommentBodies.push(review.comments.map((comment) => comment.body));
      }
    });

    const record = await maybePublishToGitHub(reviewResult(left, multiline, right), resolved(), defaultConfig, nullTelemetry(), {
      github,
      diff
    });

    expect(commentCounts).toEqual([3, 2, 1]);
    expect(record?.status).toBe("posted");
    expect(record?.inlinePosted).toBe(1);
    expect(record?.demotedToBody).toBe(2);
    expect(postedBodies[0]).toContain("LEFT-side comment should move to the body.");
    expect(postedBodies[0]).toContain("Multiline comment should move to the body.");
    expect(postedBodies[0]).not.toContain("Remaining right comment should move to the summary-only fallback.");
    expect(postedCommentBodies[0]).toEqual([
      expect.stringContaining("Remaining right comment should move to the summary-only fallback.")
    ]);
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
          throw github422({ errors: [{ index: 0 }] });
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

  it("uses the third attempt to preserve valid inline comments after repeated identified rejections", async () => {
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
    const postedComments: string[][] = [];
    const github = fakeGithub({
      createReview: async (_number, review) => {
        commentCounts.push(review.comments.length);
        if (commentCounts.length <= 2) {
          throw github422({ errors: [{ index: 0 }] });
        }
        postedComments.push(review.comments.map((comment) => comment.body));
      }
    });

    const record = await maybePublishToGitHub(reviewResult(...findings), resolved(), defaultConfig, nullTelemetry(), {
      github,
      diff
    });

    expect(commentCounts).toEqual([3, 2, 1]);
    expect(record?.status).toBe("posted");
    expect(record?.inlinePosted).toBe(1);
    expect(record?.demotedToBody).toBe(2);
    expect(postedComments[0]).toHaveLength(1);
  });

  it("falls back to a summary-only review after three inline 422 rejections", async () => {
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
        if (commentCounts.length <= 3) {
          throw github422({ message: "Validation failed without comment indexes" });
        }
        postedBodies.push(review.body);
      }
    });

    const record = await maybePublishToGitHub(reviewResult(left, multiline, right), resolved(), defaultConfig, nullTelemetry(), {
      github,
      diff
    });

    expect(commentCounts).toEqual([3, 2, 1, 0]);
    expect(record?.status).toBe("summary_only_fallback");
    expect(record?.inlinePosted).toBe(0);
    expect(record?.demotedToBody).toBe(3);
    expect(record?.attempts).toEqual([
      { httpStatus: 422, commentCount: 3, outcome: "rejected" },
      { httpStatus: 422, commentCount: 2, outcome: "rejected" },
      { httpStatus: 422, commentCount: 1, outcome: "rejected" },
      { commentCount: 0, outcome: "fallback_summary_only" }
    ]);
    expect(postedBodies[0]).toContain("LEFT-side comment should move to the body.");
    expect(postedBodies[0]).toContain("Multiline comment should move to the body.");
    expect(postedBodies[0]).toContain("Remaining right comment should move to the summary-only fallback.");
  });

  it("fails only if the summary-only fallback review is also rejected", async () => {
    const diff = parseDiff(RAW_DIFF);
    const hunk = diff.files[0]?.hunks[0];
    if (!hunk) {
      throw new Error("missing hunk");
    }
    const commentCounts: number[] = [];
    const github = fakeGithub({
      createReview: async (_number, review) => {
        commentCounts.push(review.comments.length);
        if (commentCounts.length === 1) {
          throw github422({ message: "Validation failed without comment indexes" });
        }
        throw new CodegenieError("github_post_failed", "summary body rejected", {
          context: { httpStatus: 500 }
        });
      }
    });

    await expect(
      maybePublishToGitHub(reviewResult(finalFinding({ hunkId: hunk.id, line: 1 })), resolved(), defaultConfig, nullTelemetry(), {
        github,
        diff
      })
    ).rejects.toMatchObject({
      code: "github_post_failed",
      message: "summary body rejected"
    });
    expect(commentCounts).toEqual([1, 0]);
  });

  it("fails fast on non-422 GitHub posting errors", async () => {
    const diff = parseDiff(RAW_DIFF);
    const hunk = diff.files[0]?.hunks[0];
    if (!hunk) {
      throw new Error("missing hunk");
    }
    const commentCounts: number[] = [];
    const github = fakeGithub({
      createReview: async (_number, review) => {
        commentCounts.push(review.comments.length);
        throw new CodegenieError("github_post_failed", "bad credentials", {
          context: { httpStatus: 401 }
        });
      }
    });

    await expect(
      maybePublishToGitHub(reviewResult(finalFinding({ hunkId: hunk.id, line: 1 })), resolved(), defaultConfig, nullTelemetry(), {
        github,
        diff
      })
    ).rejects.toMatchObject({
      code: "github_post_failed",
      message: "bad credentials"
    });
    expect(commentCounts).toEqual([1]);
  });

  it("adds partial coverage disclosure to posting bodies that do not already include it", async () => {
    const createdBodies: string[] = [];
    const result = reviewResult();
    result.coverage = {
      totalHunks: 3,
      reviewedHunks: 1,
      skippedHunks: 0,
      failedHunks: 1,
      coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
      degradedPlanning: false,
      budgetStopped: true,
      budgetStop: {
        reason: "max_budget_tokens",
        stage: 7,
        elapsedMs: 10_000,
        timeoutMs: 600_000,
        hardTimeoutMs: 660_000,
        remainingRuntimeMs: 100_000,
        reservedTailRuntimeMs: 60_000,
        modelCalls: 4,
        inFlightModelCalls: 0,
        projectedModelCalls: 4,
        totalTokens: 1_000,
        inFlightTokens: 0,
        projectedTokens: 1_000,
        maxBudgetTokens: 1_000,
        remainingTokens: 0,
        reservedTokens: 0
      },
      verificationIncompleteCount: 1,
      partial: true,
      reasons: ["semantic composition skipped; deterministic fallback used"]
    };
    result.postingPlan = {
      inline: [],
      reviewBody: "Found issues."
    };
    const github = fakeGithub({
      createReview: async (_number, review) => {
        createdBodies.push(review.body);
      }
    });

    const record = await maybePublishToGitHub(result, resolved(), {
      ...defaultConfig,
      github: { ...defaultConfig.github, summaryWhenNoFindings: true }
    }, nullTelemetry(), { github, diff: parseDiff(RAW_DIFF) });

    expect(record?.status).toBe("posted");
    expect(createdBodies[0]).toContain("Sorry, this review is incomplete.");
    expect(createdBodies[0]).toContain("## Coverage");
    expect(createdBodies[0]).toContain("**Partial review:** 2 hunks were not reviewed because budget was exhausted before dispatch.");
    expect(createdBodies[0]).toContain("Reviewed 1/3 hunks before stopping.");
    expect(createdBodies[0]).toContain("Verification incomplete for 1 candidate.");
    expect(createdBodies[0]).toContain("semantic composition skipped; deterministic fallback used");
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
    repo: "codegenie",
    number: 1,
    title: "PR",
    body: "",
    url: "https://github.com/0xPolygon/codegenie/pull/1",
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
    path?: string;
    side?: "RIGHT" | "LEFT";
    startLine?: number;
    startSide?: "RIGHT" | "LEFT";
    fingerprint?: string;
    finalBody?: string;
    confidence?: FinalFinding["confidence"];
  }
): FinalFinding {
  const id = overrides.id ?? "f1";
  const filePath = overrides.path ?? "src/app.ts";
  const anchor = {
    path: filePath,
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
    confidence: overrides.confidence ?? "high",
    path: filePath,
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

function github422(responseBody: unknown): CodegenieError {
  return new CodegenieError("github_post_failed", "GitHub review creation failed", {
    context: { httpStatus: 422, responseBody }
  });
}
