import { existsSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createGitClient } from "../src/git/git-client.js";
import { assertSafeRefspec, runGit, runGitCapped, scrubSubprocessValue } from "../src/git/subprocess.js";
import { CodeninjaError } from "../src/util/errors.js";
import { commitAll, git, initRepo, writeRepoFile } from "./helpers/git.js";

describe("git client", () => {
  it("rejects option-like refs and paths before spawning risky commands", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "file.txt", "base\n");
    commitAll(repo, "base");
    const client = createGitClient(repo);

    await expect(client.revParse("--upload-pack=x")).rejects.toMatchObject({
      code: "invalid_args"
    } satisfies Partial<CodeninjaError>);
    await expect(client.catFile("HEAD", "--evil")).rejects.toMatchObject({
      code: "invalid_args"
    } satisfies Partial<CodeninjaError>);
  });

  it("redacts argv values in subprocess error messages", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "file.txt", "base\n");
    commitAll(repo, "base");
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";

    await expect(createGitClient(repo).revParse(`token=${secret}`)).rejects.toMatchObject({
      code: "git_ref_missing",
      message: expect.not.stringContaining(secret)
    });
  });

  it("does not execute shell metacharacters passed as subprocess arguments", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "file.txt", "base\n");
    commitAll(repo, "base");
    const marker = path.join(repo, "shell-pwned");

    await expect(
      runGit(repo, ["rev-parse", `HEAD;touch ${marker}`], { errorCode: "git_ref_missing" })
    ).rejects.toMatchObject({ code: "git_ref_missing" });
    expect(existsSync(marker)).toBe(false);
  });

  it("injects safe noninteractive git environment variables", async () => {
    const repo = initRepo();

    await expect(runGit(repo, ["var", "GIT_PAGER"])).resolves.toBe("cat");
  });

  it("treats a leading-dash grep glob as a pathspec, not a git option", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "needle.ts", "const needle = 1;\n");
    commitAll(repo, "base");
    const client = createGitClient(repo);

    // A grep glob starting with '-' is wrapped as ':(glob)...' after a '--'
    // separator, so it can never be parsed as a git flag and must not be rejected.
    await expect(client.grep("HEAD", "needle", { glob: "-not-a-flag*.ts" })).resolves.toEqual([]);
    // The same query with a matching glob still finds the match, proving grep works.
    await expect(client.grep("HEAD", "needle", { glob: "*.ts" })).resolves.not.toEqual([]);
  });

  it("redacts capped subprocess error contexts", async () => {
    const repo = initRepo();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";

    await expect(
      runGitCapped(repo, ["show", `HEAD:${secret}`], {
        maxBytes: 1024,
        maxLines: 20,
        errorCode: "git_ref_missing"
      })
    ).rejects.toMatchObject({
      code: "git_ref_missing",
      message: expect.not.stringContaining(secret),
      context: expect.not.objectContaining({
        args: expect.arrayContaining([expect.stringContaining(secret)])
      })
    });
  });

  it("uses the pinned GitHub scrubber for gh subprocess contexts", () => {
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "abc123",
      "-----END PRIVATE KEY-----"
    ].join("\n");
    const raw = {
      stdout: `token xoxb-abcdefghijklmnop ${privateKey}`,
      stderr: "notify @team"
    };

    expect(scrubSubprocessValue("gh", raw)).toEqual({
      stdout: "token [redacted:slack-token] [redacted:private-key]",
      stderr: "notify @team"
    });
    expect(String(scrubSubprocessValue("git", privateKey))).toContain("BEGIN PRIVATE KEY");
  });

  it("rejects malformed refspecs before fetch", () => {
    expect(() => assertSafeRefspec(":refs/foo")).toThrow(/empty ref components/);
    expect(() => assertSafeRefspec("refs/foo:")).toThrow(/empty ref components/);
    expect(() => assertSafeRefspec("refs/a:refs/b:refs/c")).toThrow(/bare ref or <src>:<dst>/);
    expect(() => assertSafeRefspec("+refs/a:refs/b")).not.toThrow();
    expect(() => assertSafeRefspec("refs/a")).not.toThrow();
  });

  it("treats timed-out subprocesses as typed failures", async () => {
    const repo = initRepo();

    await expect(
      runGit(repo, ["hash-object", "--stdin"], {
        input: new Readable({ read: () => undefined }),
        timeoutMs: 10,
        errorCode: "timeout"
      })
    ).rejects.toMatchObject({
      code: "timeout",
      message: expect.stringMatching(/timed out|terminated by signal|failed/u)
    });
  });

  it("returns an empty result for no-match grep exit code 1", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "file.txt", "base\n");
    commitAll(repo, "base");

    await expect(createGitClient(repo).grep("HEAD", "definitely-not-present")).resolves.toEqual([]);
  });

  it("uses pathspec separators before untrusted paths where git supports them", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "--not-a-flag.txt", "needle\n");
    commitAll(repo, "base");
    const client = createGitClient(repo);

    await expect(client.lsFiles(["--not-a-flag.txt"])).resolves.toEqual(["--not-a-flag.txt"]);
    await expect(client.lsTreeEntry("HEAD", "--not-a-flag.txt")).resolves.toMatchObject({ type: "blob" });
  });

  it("maps missing grep refs to git_ref_missing", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "file.txt", "base\n");
    commitAll(repo, "base");

    await expect(createGitClient(repo).grep("missing-ref", "base")).rejects.toMatchObject({
      code: "git_ref_missing"
    });
  });

  it("rejects option-like default remotes before fetch", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "file.txt", "base\n");
    commitAll(repo, "base");

    await expect(createGitClient(repo, { defaultRemote: "--upload-pack=x" }).fetch("HEAD")).rejects.toMatchObject({
      code: "invalid_args"
    });
  });

  it("maps missing diff refs to git_ref_missing", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "file.txt", "base\n");
    commitAll(repo, "base");

    await expect(createGitClient(repo).diff("missing-base-ref", "HEAD")).rejects.toMatchObject({
      code: "git_ref_missing"
    });
  });

  it("produces pinned diffs and parses NUL-delimited log records", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "file.txt", "one\n");
    const base = commitAll(repo, "base");
    writeRepoFile(repo, "file.txt", "one\ntwo\n");
    const head = commitAll(repo, "second title", "body line 1\nbody line 2");
    git(repo, ["config", "diff.algorithm", "patience"]);
    git(repo, ["config", "diff.noprefix", "true"]);

    const client = createGitClient(repo);
    const diff = await client.diff(base, head);
    const commits = await client.log(`${base}..${head}`);

    expect(diff).toContain("diff --git a/file.txt b/file.txt");
    expect(diff).toContain("+two");
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      sha: head,
      title: "second title",
      body: "body line 1\nbody line 2"
    });
  });
});
