import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { executeReviewCommand, parseReviewCommand } from "../src/cli/review-command.js";
import { defaultConfig } from "../src/config/schema.js";
import * as gitClient from "../src/git/git-client.js";
import { captureLocalReview } from "../src/git/local-review.js";
import * as githubClient from "../src/github/github-client.js";
import { reviewCacheFingerprint, runReview } from "../src/pipeline/review-runner.js";
import { SourceResolver } from "../src/repo/source-resolver.js";
import { canonicalArtifactPath } from "../src/telemetry/run-artifacts.js";
import type { LocalReviewTarget } from "../src/types.js";
import { commitAll, git, initRepo, writeRepoFile } from "./helpers/git.js";

const fakeEnv = { CODEGENIE_PROVIDER: "fake", CODEGENIE_MODEL: "fake-model", CODEGENIE_HOME: process.env.CODEGENIE_HOME };
const realCreateGitClient = gitClient.createGitClient;

describe("local review snapshots", () => {
  it("accepts each local flag as an exclusive target and rejects posting", () => {
    const repoRoot = initRepo();
    const parse = (args: string[]) => parseReviewCommand(["review", ...args], { repoRoot, env: fakeEnv });
    expect(parse(["--staged"]).target).toEqual({ mode: "staged" });
    expect(parse(["--uncommitted"]).target).toEqual({ mode: "uncommitted" });
    for (const flag of ["--staged", "--uncommitted"]) {
      for (const conflict of [["HEAD"], ["main...HEAD"], ["--pr", "1"], ["--branch", "main"], ["--head", "HEAD"]]) {
        expect(() => parse([flag, ...conflict])).toThrow("mutually exclusive");
      }
      expect(() => parse([flag, "--base", "main"])).toThrow("--base is only valid");
      expect(() => parse([flag, "--post-github-comments"])).toThrow("--post-github-comments requires --pr");
    }
    expect(() => parse(["--staged", "--uncommitted"])).toThrow("mutually exclusive");
  });

  it("freezes both HEAD-to-index and HEAD-to-worktree deltas and keeps new objects out of the real store", async () => {
    const repo = fixture();
    const index = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trimEnd();
    const originalIndex = readFileSync(index);
    const originalHead = git(repo, ["rev-parse", "HEAD"]);
    const originalRefs = git(repo, ["show-ref"]);
    const staged = await snapshot(repo, "staged");
    const worktree = await snapshot(repo, "uncommitted");
    try {
      expect(staged.resolved.rawDiff).toContain("+export const version = 'staged'");
      expect(staged.resolved.rawDiff).not.toContain("worktree");
      expect(worktree.resolved.rawDiff).toContain("-export const version = 'base'");
      expect(worktree.resolved.rawDiff).toContain("+export const version = 'worktree'");
      expect(worktree.resolved.rawDiff).toContain("deleted file mode");
      expect(worktree.resolved.rawDiff).toContain("intent.ts");
      expect(worktree.resolved.rawDiff).not.toContain("loose.ts");
      expect(worktree.resolved.rawDiff).not.toContain("ignored.ts");
      expect(worktree.resolved.untrackedFiles).toBe(1);

      writeRepoFile(repo, "app.ts", "later edit\n");
      const indexSource = await SourceResolver.create(staged.resolved, staged.git);
      const worktreeSource = await SourceResolver.create(worktree.resolved, worktree.git);
      expect((await indexSource.readFile("app.ts"))?.content).toContain("'staged'");
      expect((await worktreeSource.readFile("app.ts"))?.content).toContain("'worktree'");
      expect((await worktreeSource.readFile("app.ts", { kind: "base" }))?.content).toContain("'base'");
      expect(await worktreeSource.listFiles("**/*.ts")).toEqual(["app.ts", "intent.ts", "staged.ts"]);
      expect(await worktreeSource.grep("worktree", { fixedString: true })).toEqual([
        expect.objectContaining({ path: "app.ts", line: 1 })
      ]);
      expect(await worktreeSource.readFile("loose.ts")).toBeUndefined();
      expect((await worktreeSource.readFile("delete.ts", { kind: "base" }))?.content).toBe("before deletion\n");
      expect(await worktreeSource.readFile("delete.ts")).toBeUndefined();
      expect(await plainTreeExists(repo, worktree.resolved.headRef!)).toBe(false);
      expect(readFileSync(index)).toEqual(originalIndex);
      expect(git(repo, ["rev-parse", "HEAD"])).toBe(originalHead);
      expect(git(repo, ["show-ref"])).toBe(originalRefs);
    } finally {
      await staged.close();
      await worktree.close();
    }
  });

  it("reuses the cache fingerprint for identical inputs and invalidates it when the snapshot or target changes", async () => {
    const repo = fixture();
    const first = await snapshot(repo, "uncommitted");
    const repeat = await snapshot(repo, "uncommitted");
    writeRepoFile(repo, "app.ts", "different snapshot\n");
    const edited = await snapshot(repo, "uncommitted");
    const staged = await snapshot(repo, "staged");
    try {
      const key = (value: typeof first) => reviewCacheFingerprint(defaultConfig, value.resolved, "registry");
      expect(key(first)).toBe(key(repeat));
      expect(key(first)).not.toBe(key(edited));
      expect(key(first)).not.toBe(key(staged));
    } finally {
      await Promise.all([first.close(), repeat.close(), edited.close(), staged.close()]);
    }
  });

  it("uses an inherited Git index and Git directory and leaves the alternate index unchanged", async () => {
    const repo = fixture();
    const alternateRoot = mkdtempSync(path.join(tmpdir(), "codegenie-index-"));
    const alternate = path.join(alternateRoot, "alternate-index");
    const realIndex = path.join(repo, ".git", "index");
    copyFileSync(realIndex, alternate);
    const originalIndex = readFileSync(realIndex);
    vi.stubEnv("GIT_INDEX_FILE", alternate);
    vi.stubEnv("GIT_DIR", path.join(repo, ".git"));
    try {
      git(repo, ["add", "--", "app.ts"]);
      const originalAlternate = readFileSync(alternate);
      const captured = await snapshot(repo, "staged");
      try {
        expect(captured.resolved.rawDiff).toContain("+export const version = 'worktree'");
        expect(readFileSync(realIndex)).toEqual(originalIndex);
        expect(readFileSync(alternate)).toEqual(originalAlternate);
      } finally {
        await captured.close();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("copies the index for a linked worktree with a split index", async () => {
    const repo = fixture();
    const linked = path.join(mkdtempSync(path.join(tmpdir(), "codegenie-linked-")), "worktree");
    git(repo, ["worktree", "add", "--detach", linked, "HEAD"]);
    writeRepoFile(linked, "app.ts", "linked change\n");
    git(linked, ["add", "--", "app.ts"]);
    git(linked, ["update-index", "--split-index"]);
    const index = git(linked, ["rev-parse", "--path-format=absolute", "--git-path", "index"]).trimEnd();
    const original = readFileSync(index);
    const review = await snapshot(linked, "staged");
    try {
      expect(review.resolved.rawDiff).toContain("+linked change");
      expect(readFileSync(index)).toEqual(original);
    } finally {
      await review.close();
    }
  });

  it("uses an empty tree on an unborn branch and permits a zero-work capture without an index", async () => {
    const repo = initRepo();
    const empty = await snapshot(repo, "staged");
    try {
      expect(empty.resolved.rawDiff).toBe("");
      expect(empty.resolved.baseRefName).toBe("empty tree (unborn HEAD)");
      expect(existsSync(path.join(repo, ".git", "index"))).toBe(false);
    } finally {
      await empty.close();
    }
    writeRepoFile(repo, "first.ts", "export const first = 1;\n");
    git(repo, ["add", "--", "first.ts"]);
    const added = await snapshot(repo, "staged");
    try {
      expect(added.resolved.rawDiff).toContain("+export const first = 1;");
      expect((await SourceResolver.create(added.resolved, added.git)).binding.baseCommit)
        .toBe(added.resolved.baseRef);
    } finally {
      await added.close();
    }
  });

  it.each(["staged", "uncommitted"] as const)("records the resolved labels for --%s on an unborn branch", async (mode) => {
    const repo = initRepo();
    writeRepoFile(repo, "first.ts", "export const first = 1;\n");
    git(repo, ["add", "--", "first.ts"]);
    const parsed = parseReviewCommand(["review", `--${mode}`], { repoRoot: repo, env: fakeEnv });
    parsed.config.telemetry.enabled = true;
    parsed.config.telemetry.runDir = path.join(mkdtempSync(path.join(tmpdir(), "codegenie-local-runs-")), "runs");

    const { runDir } = await executeReviewCommand(parsed);
    const run = JSON.parse(readFileSync(path.join(runDir, "run.json"), "utf8"));
    const resolved = JSON.parse(readFileSync(path.join(runDir, canonicalArtifactPath("resolved-input.json")), "utf8"));
    expect(resolved.baseRefName).toBe("empty tree (unborn HEAD)");
    expect(run.review).toMatchObject({
      baseRef: resolved.baseRefName,
      headRef: resolved.headRefName,
      baseSha: null,
      headSha: null
    });
  });

  it.each(["staged", "uncommitted"] as const)("runs --%s through the pipeline using only tree readers", async (mode) => {
    const repo = fixture();
    const staged = "export const value = 'CODEGENIE_FAKE_FINDING STAGED';";
    const amended = "export const value = 'CODEGENIE_FAKE_FINDING WORKTREE';";
    writeRepoFile(repo, "app.ts", "// padding\n" + staged + "\n");
    git(repo, ["add", "--", "app.ts"]);
    writeRepoFile(repo, "app.ts", "// padding\n// worktree padding\n" + amended + "\n");
    const commitReader = vi.fn(() => {
      throw new Error("unexpected commit-only Git operation");
    });
    const objects: string[] = [];
    vi.spyOn(gitClient, "createGitClient").mockImplementation((root, opts) => {
      const bound = realCreateGitClient(root, opts);
      if (opts?.gitEnv?.GIT_OBJECT_DIRECTORY) objects.push(opts.gitEnv.GIT_OBJECT_DIRECTORY);
      return Object.assign(bound, {
        revParse: commitReader, commitExists: commitReader, mergeBase: commitReader,
        log: commitReader, firstParent: commitReader, parentShas: commitReader
      });
    });
    const github = vi.spyOn(githubClient, "createGitHubClient");
    const output = vi.fn();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const parsed = parseReviewCommand(["review", `--${mode}`], { repoRoot: repo, env: fakeEnv });
    parsed.config.telemetry.enabled = true;
    parsed.config.telemetry.runDir = path.join(mkdtempSync(path.join(tmpdir(), "codegenie-local-runs-")), "runs");
    const result = await executeReviewCommand(parsed, { writeOutput: output });
    expect(result.review.findings).toContainEqual(expect.objectContaining({
      path: "app.ts", anchor: expect.objectContaining({ line: mode === "staged" ? 2 : 3 })
    }));
    expect(commitReader).not.toHaveBeenCalled();
    expect(github).not.toHaveBeenCalled();
    expect(objects).toHaveLength(1);
    expect(existsSync(objects[0]!)).toBe(false);
    const run = JSON.parse(readFileSync(path.join(result.runDir, "run.json"), "utf8"));
    expect(run.review).toMatchObject({
      mode, baseRef: "HEAD", headRef: mode === "staged" ? "index" : "tracked worktree",
      baseSha: null, headSha: null
    });
    const resolved = JSON.parse(readFileSync(path.join(result.runDir, canonicalArtifactPath("resolved-input.json")), "utf8"));
    expect(resolved).toMatchObject({
      mode, commits: [],
      baseRef: expect.stringMatching(/^[0-9a-f]{40,64}$/u),
      headRef: expect.stringMatching(/^[0-9a-f]{40,64}$/u)
    });
    expect(resolved).not.toHaveProperty("headSha");
    expect(output).toHaveBeenCalledWith(expect.stringContaining(mode === "staged" ? "index" : "tracked worktree"));
    const report = String(output.mock.calls[0]?.[0]);
    expect(report).not.toContain("https://github.com/");
    expect(report).not.toContain(path.dirname(objects[0]!));
    expect(report.includes("Omitted 1 untracked file.")).toBe(mode === "uncommitted");
    expect(report.includes("`git add -N <path>`")).toBe(mode === "uncommitted");
    expect(stderr.mock.calls.flat().join("").includes("Omitted 1 untracked file.")).toBe(mode === "uncommitted");
  });

  it("reports omitted untracked files in a zero-work review", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "base.ts", "export const base = 1;\n");
    commitAll(repo, "base");
    writeRepoFile(repo, "new.ts", "export const newFile = 1;\n");
    const parsed = parseReviewCommand(["review", "--uncommitted"], { repoRoot: repo, env: fakeEnv });
    const writeOutput = vi.fn();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await executeReviewCommand(parsed, { writeOutput });
    expect(result.review).toMatchObject({ summary: "Nothing to review.", coverage: { totalHunks: 0 } });
    expect(writeOutput).toHaveBeenCalledWith(expect.stringContaining("Omitted 1 untracked file."));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("git add -N <path>"));
  });

  it("names TMPDIR when the temporary directory sits inside the repository", async () => {
    const repo = initRepo();
    const inside = mkdtempSync(path.join(repo, "temp-"));
    vi.stubEnv("TMPDIR", inside);
    vi.stubEnv("TEMP", inside);
    try {
      await expect(snapshot(repo, "staged")).rejects.toMatchObject({
        code: "invalid_args",
        message: expect.stringContaining("set TMPDIR")
      });
      expect(readdirSync(inside)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects unmerged index entries as an input error and cleans its scratch directory", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "conflict.ts", "base\n");
    const base = commitAll(repo, "base");
    writeRepoFile(repo, "conflict.ts", "left\n");
    const left = commitAll(repo, "left");
    git(repo, ["checkout", "--detach", base]);
    writeRepoFile(repo, "conflict.ts", "right\n");
    commitAll(repo, "right");
    expect(spawnSync("git", ["merge", "--no-commit", left], { cwd: repo }).status).toBe(1);
    expect(git(repo, ["ls-files", "--unmerged"])).not.toBe("");
    const parent = mkdtempSync(path.join(tmpdir(), "codegenie-conflict-tmp-"));
    vi.stubEnv("TMPDIR", parent);
    try {
      const parsed = parseReviewCommand(["review", "--staged"], { repoRoot: repo, env: fakeEnv });
      await expect(executeReviewCommand(parsed, { conciseTargetErrors: true })).rejects.toMatchObject({
        code: "invalid_args", message: expect.stringContaining("resolve unmerged index entries")
      });
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("cleans the captured trees after a hard timeout", async () => {
    const repo = fixture();
    const paths: string[] = [];
    vi.spyOn(gitClient, "createGitClient").mockImplementation((root, opts) => {
      const bound = realCreateGitClient(root, opts);
      const objects = opts?.gitEnv?.GIT_OBJECT_DIRECTORY;
      if (objects !== undefined) {
        paths.push(objects);
        const diff = bound.diff;
        bound.diff = async (base, head) => {
          await delay(100);
          return diff(base, head);
        };
      }
      return bound;
    });
    const config = { ...defaultConfig, review: { ...defaultConfig.review, maxTimeMs: 10 } };
    await expect(runReview({ mode: "staged" }, config, { repoRoot: repo })).rejects.toMatchObject({ code: "timeout" });
    expect(paths).toHaveLength(1);
    expect(existsSync(paths[0]!)).toBe(false);
  });

  it("rejects programmatic local posting before using GitHub or model tools", async () => {
    const github = vi.spyOn(githubClient, "createGitHubClient");
    const runStructured = vi.fn();
    await expect(runReview({ mode: "uncommitted" }, defaultConfig, {
      repoRoot: fixture(), postGithubComments: true, runner: { runStructured }
    })).rejects.toMatchObject({ code: "invalid_args" });
    expect(github).not.toHaveBeenCalled();
    expect(runStructured).not.toHaveBeenCalled();
  });
});

function fixture(): string {
  const repo = initRepo();
  writeRepoFile(repo, "app.ts", "export const version = 'base';\n");
  writeRepoFile(repo, "delete.ts", "before deletion\n");
  writeRepoFile(repo, ".gitignore", "ignored.ts\n");
  commitAll(repo, "base");
  writeRepoFile(repo, "app.ts", "export const version = 'staged';\n");
  writeRepoFile(repo, "staged.ts", "staged addition\n");
  git(repo, ["add", "--", "app.ts", "staged.ts"]);
  writeRepoFile(repo, "app.ts", "export const version = 'worktree';\n");
  unlinkSync(path.join(repo, "delete.ts"));
  writeRepoFile(repo, "loose.ts", "untracked\n");
  writeRepoFile(repo, "ignored.ts", "ignored\n");
  writeRepoFile(repo, "intent.ts", "intent to add\n");
  git(repo, ["add", "-N", "--", "intent.ts"]);
  return repo;
}

async function snapshot(repoRoot: string, mode: LocalReviewTarget["mode"]) {
  const cleanups: Array<() => Promise<void>> = [];
  const close = async () => { await Promise.all(cleanups.map(cleanup => cleanup())); };
  try {
    const captured = await captureLocalReview({ mode }, {
      repoRoot, runsRoot: path.join(repoRoot, ".codegenie", "runs"),
      onCleanup: (cleanup) => { cleanups.push(cleanup); }
    });
    return { ...captured, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function plainTreeExists(repo: string, tree: string): boolean {
  return spawnSync("git", ["cat-file", "-e", `${tree}^{tree}`], { cwd: repo }).status === 0;
}
