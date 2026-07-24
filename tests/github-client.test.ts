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
        fingerprint
      }
    ]);
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
