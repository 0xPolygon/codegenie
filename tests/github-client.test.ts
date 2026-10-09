import { describe, expect, it } from "vitest";
import { createGitHubClient } from "../src/github/github-client.js";
import type { runGh } from "../src/git/subprocess.js";
import { CodegenieError } from "../src/util/errors.js";

type RunGh = typeof runGh;

describe("GitHub client", () => {
  it("maps PR metadata and falls back to REST commit SHAs", async () => {
    const calls: string[][] = [];
    const gh: RunGh = async (_repoRoot, args) => {
      calls.push(args);
      if (args[0] === "--version" || args.join(" ") === "auth status") {
        return "";
      }
      if (args.join(" ") === "repo view --json owner,name") {
        return JSON.stringify({ owner: { login: "0xPolygon" }, name: "codegenie" });
      }
      if (args[0] === "pr") {
        return JSON.stringify({
          number: 7,
          title: "PR title",
          body: "PR body",
          url: "https://github.com/0xPolygon/codegenie/pull/7",
          baseRefName: "main",
          headRefName: "feature"
        });
      }
      if (args[0] === "api" && args[1] === "repos/0xPolygon/codegenie/pulls/7") {
        return JSON.stringify({ base: { sha: "b".repeat(40) }, head: { sha: "h".repeat(40) } });
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };

    const client = createGitHubClient("/repo", { runGh: gh });

    await expect(client.viewPr(7)).resolves.toMatchObject({
      owner: "0xPolygon",
      repo: "codegenie",
      number: 7,
      baseSha: "b".repeat(40),
      headSha: "h".repeat(40)
    });
    expect(calls).toContainEqual(["pr", "view", "7", "--json", expect.stringContaining("baseRefOid")]);
    expect(calls).toContainEqual(["api", "repos/0xPolygon/codegenie/pulls/7"]);
  });

  it("lists only viewer-authored codegenie comments with pagination and outdated-line fallback", async () => {
    const fingerprint = "a".repeat(64);
    const gh: RunGh = async (_repoRoot, args) => {
      if (args[0] === "--version" || args.join(" ") === "auth status") {
        return "";
      }
      if (args.join(" ") === "repo view --json owner,name") {
        return JSON.stringify({ owner: { login: "0xPolygon" }, name: "codegenie" });
      }
      if (args.join(" ") === "api user --jq .login") {
        return "codebot\n";
      }
      if (args[0] === "api" && String(args[1]).endsWith("page=1")) {
        return JSON.stringify([
          {
            id: 1,
            path: "src/app.ts",
            side: "RIGHT",
            line: null,
            original_line: 42,
            body: `<!-- codegenie:fingerprint=${fingerprint};run=run-1 -->`,
            user: { login: "codebot" }
          },
          {
            id: 2,
            path: "src/app.ts",
            side: "RIGHT",
            line: 50,
            body: `<!-- codegenie:fingerprint=${"b".repeat(64)};run=run-2 -->`,
            user: { login: "other" }
          }
        ]);
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };

    const client = createGitHubClient("/repo", { runGh: gh });

    await expect(client.listOwnComments(3)).resolves.toEqual([
      {
        id: "1",
        path: "src/app.ts",
        line: 42,
        side: "RIGHT",
        author: "codebot",
        isCodegenie: true,
        fingerprint,
        body: `<!-- codegenie:fingerprint=${fingerprint};run=run-1 -->`
      }
    ]);
  });

  it("lists only viewer-authored reviews across pages and stops after a short page", async () => {
    const reviewCalls: string[] = [];
    const gh: RunGh = async (_repoRoot, args) => {
      if (args[0] === "--version" || args.join(" ") === "auth status") {
        return "";
      }
      if (args.join(" ") === "repo view --json owner,name") {
        return JSON.stringify({ owner: { login: "0xPolygon" }, name: "codegenie" });
      }
      if (args.join(" ") === "api user --jq .login") {
        return "codebot\n";
      }
      if (args[0] === "api" && String(args[1]).startsWith("repos/0xPolygon/codegenie/pulls/5/reviews?")) {
        reviewCalls.push(String(args[1]));
        if (String(args[1]).endsWith("page=1")) {
          return JSON.stringify(Array.from({ length: 100 }, (_, index) => index === 0
            ? { id: 11, state: "CHANGES_REQUESTED", commit_id: "c".repeat(40), body: "first", submitted_at: "2026-01-01T00:00:00Z", user: { login: "CodeBot" } }
            : { id: 1000 + index, state: "COMMENTED", user: { login: "other" } }));
        }
        return JSON.stringify([
          { id: 12, state: "APPROVED", commit_id: "d".repeat(40), body: "", submitted_at: "2026-01-02T00:00:00Z", user: { login: "codebot" } }
        ]);
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };
    const client = createGitHubClient("/repo", { runGh: gh });

    await expect(client.listOwnReviews(5)).resolves.toEqual([
      { id: "11", state: "CHANGES_REQUESTED", commitId: "c".repeat(40), body: "first", submittedAt: "2026-01-01T00:00:00Z" },
      { id: "12", state: "APPROVED", commitId: "d".repeat(40), body: "", submittedAt: "2026-01-02T00:00:00Z" }
    ]);
    expect(reviewCalls).toEqual([
      "repos/0xPolygon/codegenie/pulls/5/reviews?per_page=100&page=1",
      "repos/0xPolygon/codegenie/pulls/5/reviews?per_page=100&page=2"
    ]);
  });

  it("dismisses a review with a PUT to the dismissals endpoint and surfaces failures", async () => {
    let call: { args: string[]; input: unknown } | undefined;
    let fail = false;
    const gh: RunGh = async (_repoRoot, args, opts = {}) => {
      if (args[0] === "--version" || args.join(" ") === "auth status") {
        return "";
      }
      if (args.join(" ") === "repo view --json owner,name") {
        return JSON.stringify({ owner: { login: "0xPolygon" }, name: "codegenie" });
      }
      if (args[0] === "api" && String(args[1]).endsWith("/dismissals")) {
        call = { args, input: JSON.parse(String(opts.input)) };
        if (fail) {
          throw new CodegenieError("github_post_failed", "forbidden", { context: { httpStatus: 403 } });
        }
        return "{}";
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };
    const client = createGitHubClient("/repo", { runGh: gh });

    await client.dismissReview(5, "11", "stale");
    expect(call?.args).toEqual(["api", "repos/0xPolygon/codegenie/pulls/5/reviews/11/dismissals", "--method", "PUT", "--input", "-"]);
    expect(call?.input).toEqual({ message: "stale", event: "DISMISS" });
    fail = true;
    await expect(client.dismissReview(5, "11", "stale")).rejects.toBeInstanceOf(CodegenieError);
  });

  it("maps compare files to changed lines, renames, and missing patches", async () => {
    const gh: RunGh = async (_repoRoot, args) => {
      if (args[0] === "--version" || args.join(" ") === "auth status") {
        return "";
      }
      if (args.join(" ") === "repo view --json owner,name") {
        return JSON.stringify({ owner: { login: "0xPolygon" }, name: "codegenie" });
      }
      if (args[0] === "api" && args[1] === `repos/0xPolygon/codegenie/compare/${"a".repeat(40)}...${"h".repeat(40)}`) {
        return JSON.stringify({
          status: "ahead",
          files: [
            { filename: "src/app.ts", status: "modified", changes: 2, patch: "@@ -3,1 +3,1 @@\n-old\n+new\n" },
            { filename: "assets/big.bin", status: "modified", changes: 9 },
            { filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed", changes: 0 }
          ]
        });
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };
    const client = createGitHubClient("/repo", { runGh: gh });

    await expect(client.compareFiles("a".repeat(40), "h".repeat(40))).resolves.toEqual([
      { path: "src/app.ts", status: "modified", patchMissing: false, addedLines: [3], deletedLines: [3] },
      { path: "assets/big.bin", status: "modified", patchMissing: true, addedLines: [], deletedLines: [] },
      { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed", patchMissing: false, addedLines: [], deletedLines: [] }
    ]);
  });

  it("rejects a compare whose base is not an ancestor of head", async () => {
    const gh: RunGh = async (_repoRoot, args) => {
      if (args[0] === "--version" || args.join(" ") === "auth status") {
        return "";
      }
      if (args.join(" ") === "repo view --json owner,name") {
        return JSON.stringify({ owner: { login: "0xPolygon" }, name: "codegenie" });
      }
      if (args[0] === "api" && String(args[1]).includes("/compare/")) {
        // After a force-push the three-dot diff runs from the branch point and lists every PR line.
        return JSON.stringify({ status: "diverged", files: [{ filename: "src/app.ts", status: "modified", changes: 1, patch: "@@ -1,0 +1,1 @@\n+line\n" }] });
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };
    const client = createGitHubClient("/repo", { runGh: gh });

    await expect(client.compareFiles("a".repeat(40), "h".repeat(40))).rejects.toThrow(/diverged/u);
  });

  it("posts one COMMENT review with the cached PR head SHA", async () => {
    let payload: unknown;
    const gh: RunGh = async (_repoRoot, args, opts = {}) => {
      if (args[0] === "--version" || args.join(" ") === "auth status") {
        return "";
      }
      if (args.join(" ") === "repo view --json owner,name") {
        return JSON.stringify({ owner: { login: "0xPolygon" }, name: "codegenie" });
      }
      if (args[0] === "pr") {
        return JSON.stringify({
          number: 9,
          title: "",
          body: "",
          url: "",
          baseRefName: "main",
          headRefName: "feature",
          baseRefOid: "b".repeat(40),
          headRefOid: "h".repeat(40)
        });
      }
      if (args[0] === "api" && args[1] === "repos/0xPolygon/codegenie/pulls/9/reviews") {
        payload = JSON.parse(String(opts.input));
        return "{}";
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };
    const client = createGitHubClient("/repo", { runGh: gh });

    await client.viewPr(9);
    await client.createReview(9, {
      body: "review body",
      event: "COMMENT",
      comments: [{ path: "src/app.ts", line: 2, side: "RIGHT", body: "inline" }]
    });

    expect(payload).toEqual({
      body: "review body",
      event: "COMMENT",
      commit_id: "h".repeat(40),
      comments: [{ path: "src/app.ts", line: 2, side: "RIGHT", body: "inline" }]
    });
  });

  it("surfaces structured HTTP status and response body for review creation failures", async () => {
    const gh: RunGh = async (_repoRoot, args) => {
      if (args[0] === "--version" || args.join(" ") === "auth status") {
        return "";
      }
      if (args.join(" ") === "repo view --json owner,name") {
        return JSON.stringify({ owner: { login: "0xPolygon" }, name: "codegenie" });
      }
      if (args[0] === "pr") {
        return JSON.stringify({
          number: 9,
          title: "",
          body: "",
          url: "",
          baseRefName: "main",
          headRefName: "feature",
          baseRefOid: "b".repeat(40),
          headRefOid: "h".repeat(40)
        });
      }
      if (args[0] === "api" && args[1] === "repos/0xPolygon/codegenie/pulls/9/reviews") {
        throw new CodegenieError("github_post_failed", "gh: Validation Failed (HTTP 422)", {
          context: {
            stderr: 'gh: Validation Failed (HTTP 422)\n{"message":"Validation Failed","errors":[{"index":0}]}'
          }
        });
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };
    const client = createGitHubClient("/repo", { runGh: gh });

    await expect(
      client.createReview(9, {
        body: "review body",
        event: "COMMENT",
        comments: [{ path: "src/app.ts", line: 2, side: "RIGHT", body: "inline" }]
      })
    ).rejects.toMatchObject({
      code: "github_post_failed",
      context: {
        httpStatus: 422,
        responseBody: {
          message: "Validation Failed",
          errors: [{ index: 0 }]
        }
      }
    });
  });

  it("accepts Actions installation tokens that fail `gh auth status`", async () => {
    const calls: string[][] = [];
    const gh: RunGh = async (_repoRoot, args) => {
      calls.push(args);
      if (args[0] === "--version") {
        return "";
      }
      if (args.join(" ") === "auth status") {
        throw new CodegenieError("gh_auth_failed", "The token in GH_TOKEN is invalid.");
      }
      if (args.join(" ") === "api rate_limit") {
        return JSON.stringify({ resources: { core: { remaining: 4999 } } });
      }
      if (args.join(" ") === "repo view --json owner,name") {
        return JSON.stringify({ owner: { login: "0xPolygon" }, name: "codegenie" });
      }
      if (args[0] === "pr") {
        return JSON.stringify({ number: 7, baseRefName: "main", headRefName: "feature" });
      }
      if (args[0] === "api" && args[1] === "repos/0xPolygon/codegenie/pulls/7") {
        return JSON.stringify({ base: { sha: "b".repeat(40) }, head: { sha: "h".repeat(40) } });
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };

    const client = createGitHubClient("/repo", { runGh: gh });

    await expect(client.viewPr(7)).resolves.toMatchObject({ owner: "0xPolygon", number: 7 });
    expect(calls).toContainEqual(["api", "rate_limit"]);
  });

  it("still fails when both `gh auth status` and the API probe reject", async () => {
    const gh: RunGh = async (_repoRoot, args) => {
      if (args[0] === "--version") {
        return "";
      }
      if (args.join(" ") === "auth status" || args.join(" ") === "api rate_limit") {
        throw new CodegenieError("gh_auth_failed", "gh: Bad credentials (HTTP 401)");
      }
      throw new Error(`unexpected gh args: ${args.join(" ")}`);
    };

    const client = createGitHubClient("/repo", { runGh: gh });

    await expect(client.viewPr(7)).rejects.toMatchObject({ code: "gh_auth_failed" });
  });
});
