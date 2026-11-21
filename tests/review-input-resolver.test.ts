import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { parseDiff } from "../src/git/diff-parser.js";
import { createGitClient, type InternalGitClient } from "../src/git/git-client.js";
import { resolveReviewCommandTarget, resolveReviewInput } from "../src/git/review-input-resolver.js";
import type { GitHubClient, PullRequestMetadata } from "../src/types.js";
import { CodegenieError } from "../src/util/errors.js";
import { commitAll, git, initRepo, nullTelemetry, writeRepoFile } from "./helpers/git.js";

describe("review input resolver", () => {
  it("uses master policy for one base redirect and keeps the default fallback for working-tree evals", async () => {
    const repo = initRepo();
    git(repo, ["branch", "-m", "master"]);
    writeRepoFile(repo, "codegenie.toml", '[git]\nbaseBranch = "develop"\n');
    writeRepoFile(repo, "app.ts", "export const value = 1;\n");
    const master = commitAll(repo, "trusted default config");
    git(repo, ["checkout", "-b", "develop"]);
    writeRepoFile(repo, "codegenie.toml", '[git]\nbaseBranch = "third"\n');
    const develop = commitAll(repo, "integration config");
    git(repo, ["checkout", "-b", "feature", "master"]);
    writeRepoFile(repo, "app.ts", "export const value = 2;\n");
    commitAll(repo, "feature change");
    const input = { mode: "branch", branchName: "feature" } as const;

    await expect(resolveReviewInput(input, defaultConfig, nullTelemetry(), { repoRoot: repo })).resolves.toMatchObject({
      baseRef: develop, baseRefName: "develop", mergeBase: master
    });

    writeRepoFile(repo, "codegenie.toml", '[git]\nbaseBranch = "third"\n');
    commitAll(repo, "untrusted redirect");
    await expect(resolveReviewInput(input, defaultConfig, nullTelemetry(), { repoRoot: repo })).rejects.toMatchObject({
      code: "git_base_branch_unresolved", message: expect.stringContaining('Pass --base "third"')
    });
    await expect(resolveReviewInput(input, defaultConfig, nullTelemetry(), { repoRoot: repo, repositoryBaseBranch: false })).resolves.toMatchObject({
      baseRef: master, baseRefName: "master"
    });
  });

  it("requires confirmation for a reviewed branch's base hint and ignores malformed reviewed config", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "export {};\n");
    const base = commitAll(repo, "base with no policy");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "codegenie.toml", '[git]\nbaseBranch = "other"\n');
    commitAll(repo, "reviewed branch tries to name its base");
    const input = { mode: "branch", branchName: "feature" } as const;
    const options = { repoRoot: repo };
    const telemetry = nullTelemetry();

    await expect(resolveReviewInput(input, defaultConfig, telemetry, options)).rejects.toMatchObject({
      code: "git_base_branch_unresolved", message: expect.stringContaining('Pass --base "other"')
    });
    await expect(resolveReviewInput({ ...input, baseBranch: "main" }, defaultConfig, telemetry, options)).resolves.toMatchObject({ baseRef: base });
    await expect(resolveReviewInput(input, { ...defaultConfig, git: { baseBranch: "main" } }, telemetry, options)).resolves.toMatchObject({ baseRef: base });

    writeRepoFile(repo, "codegenie.toml", "[broken\n");
    commitAll(repo, "malformed reviewed-branch config");
    await expect(resolveReviewInput(input, defaultConfig, telemetry, options)).resolves.toMatchObject({ baseRef: base });
  });

  it("refuses a trusted default redirect to a missing base", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "codegenie.toml", '[git]\nbaseBranch = "missing"\n');
    commitAll(repo, "base requests a missing branch");
    git(repo, ["checkout", "-b", "feature"]);
    await expect(resolveReviewInput({ mode: "branch", branchName: "feature" }, defaultConfig, nullTelemetry(), { repoRoot: repo })).rejects.toMatchObject({
      code: "git_base_branch_unresolved", message: expect.stringContaining("'missing' could not be resolved")
    });
  });

  it("names --base and the reviewed hint when neither default branch exists", async () => {
    const repo = initRepo();
    git(repo, ["branch", "-m", "integration"]);
    writeRepoFile(repo, "app.ts", "export {};\n");
    commitAll(repo, "integration base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "codegenie.toml", '[git]\nbaseBranch = "integration"\n');
    commitAll(repo, "reviewed branch supplies an advisory hint");
    await expect(resolveReviewCommandTarget({ mode: "default_branch" }, defaultConfig, nullTelemetry(), { repoRoot: repo })).rejects.toMatchObject({
      code: "git_base_branch_unresolved", message: expect.stringContaining('Pass --base "integration"')
    });
  });

  it.each(["name-$(fixture)", "name\u001b[31m"])("keeps an untrusted base hint out of a pasteable command (%j)", async (hint) => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "export {};\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "codegenie.toml", `[git]\nbaseBranch = ${JSON.stringify(hint)}\n`);
    commitAll(repo, "reviewed base hint");

    await expect(resolveReviewInput({ mode: "branch", branchName: "feature" }, defaultConfig, nullTelemetry(), { repoRoot: repo })).rejects.toMatchObject({
      code: "git_base_branch_unresolved",
      message: expect.stringMatching(/^[^\u0000-\u001f]*Pass --base with the branch you intend[^\u0000-\u001f]*$/u)
    });
  });

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

  it("resolves one positional branch target as a merge-base branch review", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "base\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "app.ts", "base\nfeature one\n");
    commitAll(repo, "feature one");
    writeRepoFile(repo, "app.ts", "base\nfeature one\nfeature two\n");
    const feature = commitAll(repo, "feature two");
    git(repo, ["checkout", "main"]);
    writeRepoFile(repo, "main.ts", "main only\n");
    commitAll(repo, "main change");

    const branch = await resolveReviewCommandTarget(
      { mode: "single_ref", ref: "feature" },
      defaultConfig,
      nullTelemetry(),
      { repoRoot: repo }
    );
    const explicit = await resolveReviewInput(
      { mode: "branch", branchName: "feature" },
      defaultConfig,
      nullTelemetry(),
      { repoRoot: repo }
    );

    expect(branch.mode).toBe("branch");
    expect(branch.headSha).toBe(feature);
    expect(branch.rawDiff).toBe(explicit.rawDiff);
    expect(branch.rawDiff).toContain("+feature one");
    expect(branch.rawDiff).toContain("+feature two");
    expect(branch.rawDiff).not.toContain("main.ts");
    expect(branch.commits.map((commit) => commit.title)).toEqual(["feature two", "feature one"]);
  });

  it("falls one positional non-branch refs back to single-commit review", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "one\n");
    commitAll(repo, "first");
    writeRepoFile(repo, "app.ts", "one\ntwo\n");
    const second = commitAll(repo, "second");

    const resolved = await resolveReviewCommandTarget(
      { mode: "single_ref", ref: second },
      defaultConfig,
      nullTelemetry(),
      { repoRoot: repo }
    );

    expect(resolved.mode).toBe("commit_range");
    expect(resolved.headSha).toBe(second);
    expect(resolved.rawDiff).toContain("+two");
    expect(resolved.commits.map((commit) => commit.title)).toEqual(["second"]);
  });

  it("applies --base to one positional branch targets", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "base\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "develop"]);
    writeRepoFile(repo, "develop.ts", "develop only\n");
    commitAll(repo, "develop change");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "app.ts", "base\nfeature\n");
    const feature = commitAll(repo, "feature change");
    git(repo, ["checkout", "main"]);
    writeRepoFile(repo, "main.ts", "main only\n");
    commitAll(repo, "main change");

    const resolved = await resolveReviewCommandTarget(
      { mode: "single_ref", ref: "feature", baseBranch: "develop" },
      defaultConfig,
      nullTelemetry(),
      { repoRoot: repo }
    );

    expect(resolved.mode).toBe("branch");
    expect(resolved.headSha).toBe(feature);
    expect(resolved.rawDiff).toContain("+feature");
    expect(resolved.rawDiff).not.toContain("develop.ts");
    expect(resolved.rawDiff).not.toContain("main.ts");
  });

  it("rejects --base when one positional target is not a branch", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "one\n");
    commitAll(repo, "first");
    writeRepoFile(repo, "app.ts", "one\ntwo\n");
    const second = commitAll(repo, "second");

    await expect(
      resolveReviewCommandTarget(
        { mode: "single_ref", ref: second, baseBranch: "main" },
        defaultConfig,
        nullTelemetry(),
        { repoRoot: repo }
      )
    ).rejects.toMatchObject({
      code: "invalid_args",
      message: expect.stringContaining("--base can only be used when")
    });
  });

  it("checks the worktree before resolving one positional branch-or-commit refs", async () => {
    await expect(
      resolveReviewCommandTarget(
        { mode: "single_ref", ref: "feature" },
        defaultConfig,
        nullTelemetry(),
        { git: fakeGitClient({ isInsideWorktree: async () => false }) }
      )
    ).rejects.toMatchObject({ code: "not_git_worktree" });
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
          throw new CodegenieError("git_ref_missing", "history missing");
        }
        return "m".repeat(40);
      },
      log: async () => {
        logAttempts += 1;
        if (logAttempts === 1) {
          throw new CodegenieError("git_ref_missing", "range missing");
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
        { name: "upstream", url: "git@github.com:0xPolygon/codegenie.git" }
      ],
      listRefs: async () => ["refs/codegenie/pr/12/head"],
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
      { remote: "upstream", refspec: "+refs/pull/12/head:refs/codegenie/pr/12/head" },
      { remote: "upstream", refspec: `+${pr.baseSha}:refs/codegenie/pr/12/base` }
    ]);
    expect(deletedRefs).toEqual(["refs/codegenie/pr/12/head"]);
  });

  it("refreshes PR metadata once when the head moves during fetch", async () => {
    const first = prMetadata({ headSha: "1".repeat(40) });
    const second = prMetadata({ headSha: "2".repeat(40) });
    const available = new Set<string>([second.baseSha]);
    const gitClient = fakeGitClient({
      isShallow: async () => false,
      remotes: async () => [{ name: "origin", url: "https://github.com/0xPolygon/codegenie.git" }],
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
        { name: "upstream", url: "https://github.com/0xPolygon/codegenie.git" }
      ],
      commitExists: async () => true,
      fetchFrom: async (remote, refspec, opts) => {
        deepenCalls.push({ remote, refspec, ...(opts?.deepen !== undefined ? { deepen: opts.deepen } : {}) });
      },
      mergeBase: async () => {
        mergeAttempts += 1;
        if (mergeAttempts === 1) {
          throw new CodegenieError("git_ref_missing", "history missing");
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
    repo: "codegenie",
    number: 12,
    title: "PR",
    body: "",
    url: "https://github.com/0xPolygon/codegenie/pull/12",
    baseRefName: "main",
    baseSha: "b".repeat(40),
    headRefName: "feature",
    headSha: "h".repeat(40),
    ...overrides
  };
}
