import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { parseDiff } from "../src/git/diff-parser.js";
import { createGitClient, type InternalGitClient } from "../src/git/git-client.js";
import { resolveReviewCommandTarget, resolveReviewInput } from "../src/git/review-input-resolver.js";
import type { GitHubClient, PullRequestMetadata } from "../src/types.js";
import { CodeninjaError } from "../src/util/errors.js";
import { commitAll, git, initRepo, nullTelemetry, writeRepoFile } from "./helpers/git.js";

describe("review input resolver", () => {
  it("resolves default branch review like explicit branch mode", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "export const value = 1;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "app.ts", "export const value = 2;\n");
    commitAll(repo, "feature change");

    const explicit = await resolveReviewInput(
      { mode: "branch", branchName: "feature" },
      defaultConfig,
      nullTelemetry(),
      { repoRoot: repo }
    );
    const implicit = await resolveReviewCommandTarget(
      { mode: "default_branch" },
      defaultConfig,
      nullTelemetry(),
      { repoRoot: repo }
    );

    expect(implicit.headSha).toBe(explicit.headSha);
    expect(implicit.mergeBase).toBe(explicit.mergeBase);
    expect(implicit.rawDiff).toBe(explicit.rawDiff);
  });

  it("rejects bare default on the base branch", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "export const value = 1;\n");
    commitAll(repo, "base");

    await expect(
      resolveReviewCommandTarget({ mode: "default_branch" }, defaultConfig, nullTelemetry(), {
        repoRoot: repo
      })
    ).rejects.toMatchObject({ code: "invalid_args" });
  });

  it("resolves single root commits through the empty tree", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "root.go", "package root\n");
    const root = commitAll(repo, "root commit");

    const resolved = await resolveReviewInput(
      { mode: "commit_range", startCommit: root },
      defaultConfig,
      nullTelemetry(),
      { repoRoot: repo }
    );
    const diff = parseDiff(resolved.rawDiff);

    expect(resolved.headSha).toBe(root);
    expect(resolved.mergeBase).not.toBe(root);
    expect(diff.files).toMatchObject([{ path: "root.go", status: "added" }]);
  });

  it("parses commit parents only from the commit header section", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "root.go", "package root\n");
    const root = commitAll(repo, "root commit", `parent ${"a".repeat(40)} appears in the body`);

    await expect(createGitClient(repo).parentShas(root)).resolves.toEqual([]);
  });

  it("resolves two-commit ranges as endpoint diffs", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "one\n");
    const first = commitAll(repo, "first");
    writeRepoFile(repo, "app.ts", "one\ntwo\n");
    commitAll(repo, "second");
    writeRepoFile(repo, "app.ts", "one\ntwo\nthree\n");
    const third = commitAll(repo, "third");

    const resolved = await resolveReviewInput(
      { mode: "commit_range", startCommit: first, endCommit: third },
      defaultConfig,
      nullTelemetry(),
      { repoRoot: repo }
    );

    expect(resolved.baseRef).toBe(first);
    expect(resolved.headSha).toBe(third);
    expect(resolved.commits.map((commit) => commit.title)).toEqual(["third", "second"]);
    expect(resolved.rawDiff).toContain("+three");
  });

  it("resolves head/base inputs as merge-base diffs for pinned PR-style evals", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "base\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "app.ts", "base\nfeature\n");
    const feature = commitAll(repo, "feature change");
    git(repo, ["checkout", "main"]);
    writeRepoFile(repo, "other.ts", "main only\n");
    commitAll(repo, "main change");

    const endpoint = await resolveReviewInput(
      { mode: "commit_range", startCommit: "main", endCommit: feature },
      defaultConfig,
      nullTelemetry(),
      { repoRoot: repo }
    );
    const head = await resolveReviewInput(
      { mode: "head", baseRef: "main", headRef: feature },
      defaultConfig,
      nullTelemetry(),
      { repoRoot: repo }
    );

    expect(head.mode).toBe("head");
    expect(head.headSha).toBe(feature);
    expect(head.rawDiff).toContain("+feature");
    expect(head.rawDiff).not.toContain("other.ts");
    expect(endpoint.rawDiff).toContain("other.ts");
  });

  it("deepens shallow branch history and retries merge-base and log", async () => {
    const deepenCalls: Array<{ refspec: string; deepen?: number }> = [];
    let mergeAttempts = 0;
    let logAttempts = 0;
    const gitClient = fakeGitClient({
      resolveBranch: async (name) =>
        name === "feature"
          ? { sha: "f".repeat(40), ref: "refs/heads/feature" }
          : { sha: "b".repeat(40), ref: "refs/remotes/origin/main" },
      mergeBase: async () => {
        mergeAttempts += 1;
        if (mergeAttempts === 1) {
          throw new CodeninjaError("git_ref_missing", "history missing");
        }
        return "m".repeat(40);
      },
      log: async () => {
        logAttempts += 1;
        if (logAttempts === 1) {
          throw new CodeninjaError("git_ref_missing", "range missing");
        }
        return [];
      },
      fetchFrom: async (_remote, refspec, opts) => {
        deepenCalls.push(opts?.deepen === undefined ? { refspec } : { refspec, deepen: opts.deepen });
      }
    });

    const resolved = await resolveReviewInput(
      { mode: "branch", branchName: "feature", baseBranch: "main" },
      defaultConfig,
      nullTelemetry(),
      { git: gitClient }
    );

    expect(resolved.mergeBase).toBe("m".repeat(40));
    expect(mergeAttempts).toBe(2);
    expect(logAttempts).toBe(2);
    expect(deepenCalls).toEqual(
      expect.arrayContaining([
        { refspec: "+refs/heads/main:refs/remotes/origin/main", deepen: 100 },
        { refspec: "+refs/heads/feature:refs/remotes/origin/feature", deepen: 100 }
      ])
    );
  });

  it("fetches missing base branch refs in shallow repositories", async () => {
    let fetched = false;
    const gitClient = fakeGitClient({
      resolveBranch: async (name) => {
        if (name === "feature") {
          return { sha: "f".repeat(40), ref: "refs/heads/feature" };
        }
        if (name === "main" && fetched) {
          return { sha: "b".repeat(40), ref: "refs/remotes/origin/main" };
        }
        return undefined;
      },
      fetchFrom: async (_remote, refspec, opts) => {
        expect(refspec).toBe("+refs/heads/main:refs/remotes/origin/main");
        expect(opts?.deepen).toBe(100);
        fetched = true;
      }
    });

    const resolved = await resolveReviewInput(
      { mode: "branch", branchName: "feature", baseBranch: "main" },
      defaultConfig,
      nullTelemetry(),
      { git: gitClient }
    );

    expect(resolved.baseRef).toBe("b".repeat(40));
    expect(fetched).toBe(true);
  });

  it("does not treat a shallow boundary commit as a root commit", async () => {
    const sha = "c".repeat(40);
    const gitClient = fakeGitClient({
      firstParent: async () => undefined,
      parentShas: async () => ["p".repeat(40)],
      remotes: async () => [],
      emptyTreeSha: async () => {
        throw new Error("empty tree should not be used for shallow boundary commits");
      }
    });

    await expect(
      resolveReviewInput(
        { mode: "commit_range", startCommit: sha },
        defaultConfig,
        nullTelemetry(),
        { git: gitClient }
      )
    ).rejects.toMatchObject({
      code: "git_ref_missing",
      message: expect.stringContaining("git fetch --unshallow")
    });
  });

  it("resolves PR mode by fetching GitHub-matched refs from the matching base remote", async () => {
    const pr = prMetadata();
    const available = new Set<string>();
    const fetches: Array<{ remote: string; refspec: string }> = [];
    const deletedRefs: string[] = [];
    const gitClient = fakeGitClient({
      repoRoot: async () => "/repo",
      isShallow: async () => false,
      remotes: async () => [
        { name: "origin", url: "https://github.com/someone/else.git" },
        { name: "upstream", url: "git@github.com:0xPolygon/codeninja.git" }
      ],
      listRefs: async () => ["refs/codeninja/pr/12/head"],
      deleteRef: async (ref) => {
        deletedRefs.push(ref);
      },
      commitExists: async (sha) => available.has(sha),
      fetchFrom: async (remote, refspec) => {
        fetches.push({ remote, refspec });
        if (refspec.includes("/head")) {
          available.add(pr.headSha);
        }
        if (refspec.includes(pr.baseSha)) {
          available.add(pr.baseSha);
        }
      },
      mergeBase: async (base, head) => {
        expect(base).toBe(pr.baseSha);
        expect(head).toBe(pr.headSha);
        return "m".repeat(40);
      },
      diff: async (base, head) => {
        expect(base).toBe("m".repeat(40));
        expect(head).toBe(pr.headSha);
        return "";
      },
      log: async (range) => {
        expect(range).toBe(`${"m".repeat(40)}..${pr.headSha}`);
        return [{ sha: pr.headSha, title: "change", body: "" }];
      }
    });

    const resolved = await resolveReviewInput(
      { mode: "github_pr", prNumber: 12 },
      defaultConfig,
      nullTelemetry(),
      { git: gitClient, github: fakeGithub([pr]) }
    );

    expect(resolved).toMatchObject({
      mode: "github_pr",
      repoRoot: "/repo",
      baseRef: pr.baseSha,
      headRef: pr.headSha,
      mergeBase: "m".repeat(40),
      headSha: pr.headSha,
      pr
    });
    expect(fetches).toEqual([
      { remote: "upstream", refspec: "+refs/pull/12/head:refs/codeninja/pr/12/head" },
      { remote: "upstream", refspec: `+${pr.baseSha}:refs/codeninja/pr/12/base` }
    ]);
    expect(deletedRefs).toEqual(["refs/codeninja/pr/12/head"]);
  });

  it("refreshes PR metadata once when the head moves during fetch", async () => {
    const first = prMetadata({ headSha: "1".repeat(40) });
    const second = prMetadata({ headSha: "2".repeat(40) });
    const available = new Set<string>([second.baseSha]);
    const gitClient = fakeGitClient({
      isShallow: async () => false,
      remotes: async () => [{ name: "origin", url: "https://github.com/0xPolygon/codeninja.git" }],
      commitExists: async (sha) => available.has(sha),
      fetchFrom: async (_remote, refspec) => {
        if (refspec.includes("/head") && refspec.includes("refs/pull/12")) {
          available.add(second.headSha);
        }
      },
      mergeBase: async (_base, head) => {
        expect(head).toBe(second.headSha);
        return "m".repeat(40);
      },
      diff: async () => "",
      log: async () => []
    });

    const resolved = await resolveReviewInput(
      { mode: "github_pr", prNumber: 12 },
      defaultConfig,
      nullTelemetry(),
      { git: gitClient, github: fakeGithub([first, second]) }
    );

    expect(resolved.headSha).toBe(second.headSha);
  });

  it("deepens shallow PR merge-base using the selected PR remote", async () => {
    const pr = prMetadata();
    const deepenCalls: Array<{ remote: string; refspec: string; deepen?: number }> = [];
    let mergeAttempts = 0;
    const gitClient = fakeGitClient({
      isShallow: async () => true,
      remotes: async () => [
        { name: "origin", url: "https://github.com/user/fork.git" },
        { name: "upstream", url: "https://github.com/0xPolygon/codeninja.git" }
      ],
      commitExists: async () => true,
      fetchFrom: async (remote, refspec, opts) => {
        deepenCalls.push({ remote, refspec, ...(opts?.deepen !== undefined ? { deepen: opts.deepen } : {}) });
      },
      mergeBase: async () => {
        mergeAttempts += 1;
        if (mergeAttempts === 1) {
          throw new CodeninjaError("git_ref_missing", "history missing");
        }
        return "m".repeat(40);
      },
      diff: async () => "",
      log: async () => []
    });

    const resolved = await resolveReviewInput(
      { mode: "github_pr", prNumber: 12 },
      defaultConfig,
      nullTelemetry(),
      { git: gitClient, github: fakeGithub([pr]) }
    );

    expect(resolved.mergeBase).toBe("m".repeat(40));
    expect(deepenCalls).toEqual([
      { remote: "upstream", refspec: pr.baseSha, deepen: 100 },
      { remote: "upstream", refspec: pr.headSha, deepen: 100 }
    ]);
  });
});

function fakeGitClient(overrides: Partial<InternalGitClient>): InternalGitClient {
  return {
    revParse: async (ref) => ref,
    catFile: async () => "",
    catFilePrefix: async () => "",
    lsTree: async () => [],
    lsFiles: async () => [],
    grep: async () => [],
    mergeBase: async () => "m".repeat(40),
    log: async () => [],
    diff: async () => "",
    fetch: async () => undefined,
    isShallow: async () => true,
    currentBranch: async () => "feature",
    isInsideWorktree: async () => true,
    repoRoot: async () => "/repo",
    commitExists: async () => true,
    resolveBranch: async (name) => ({ sha: name === "feature" ? "f".repeat(40) : "b".repeat(40), ref: `refs/heads/${name}` }),
    remotes: async () => [{ name: "origin", url: "https://example.com/repo.git" }],
    fetchFrom: async () => undefined,
    deleteRef: async () => undefined,
    listRefs: async () => [],
    lsTreeEntry: async () => undefined,
    emptyTreeSha: async () => "e".repeat(40),
    firstParent: async () => "p".repeat(40),
    parentShas: async () => ["p".repeat(40)],
    checkIgnored: async () => new Set(),
    ...overrides
  };
}

function fakeGithub(prs: PullRequestMetadata[]): GitHubClient {
  let index = 0;
  return {
    viewPr: async (_number, opts = {}) => {
      if (opts.refresh === true) {
        index = Math.min(index + 1, prs.length - 1);
      }
      const pr = prs[index];
      if (!pr) {
        throw new Error("missing fake PR");
      }
      return pr;
    },
    createReview: async () => undefined,
    listOwnComments: async () => []
  };
}

function prMetadata(overrides: Partial<PullRequestMetadata> = {}): PullRequestMetadata {
  return {
    owner: "0xPolygon",
    repo: "codeninja",
    number: 12,
    title: "PR",
    body: "",
    url: "https://github.com/0xPolygon/codeninja/pull/12",
    baseRefName: "main",
    baseSha: "b".repeat(40),
    headRefName: "feature",
    headSha: "h".repeat(40),
    ...overrides
  };
}
