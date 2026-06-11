import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { parseDiff } from "../src/git/diff-parser.js";
import type { InternalGitClient } from "../src/git/git-client.js";
import { resolveReviewCommandTarget, resolveReviewInput } from "../src/git/review-input-resolver.js";
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
