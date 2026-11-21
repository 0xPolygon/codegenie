import fs, { symlinkSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createGitClient } from "../src/git/git-client.js";
import { readBaseRevisionPolicy, readWorkingTreePolicy } from "../src/repo/repository-policy.js";
import { loadSkills } from "../src/skills/skill-loader.js";
import type { ResolvedReviewInput } from "../src/types.js";
import { CodegenieError } from "../src/util/errors.js";
import { commitAll, initRepo, nullTelemetry, writeRepoFile } from "./helpers/git.js";

function resolved(repoRoot: string, baseRef: string): ResolvedReviewInput {
  return { mode: "head", repoRoot, baseRef, commits: [], rawDiff: "" };
}

describe("base revision repository policy", () => {
  it("reads config and nested Markdown at the base SHA despite later commits and dirty files", async () => {
    const repo = initRepo();
    const config = '[review]\ndepth = "deep"\n';
    const nested = ".codegenie/skills/nested/évidence.md";
    writeRepoFile(repo, "codegenie.toml", config);
    writeRepoFile(repo, nested, "base skill\n");
    writeRepoFile(repo, ".codegenie/skills/alpha.md", "alpha\n");
    writeRepoFile(repo, ".codegenie/skills/ignored.txt", "ignored\n");
    const base = commitAll(repo, "base policy");
    writeRepoFile(repo, "codegenie.toml", '[review]\ndepth = "light"\n');
    writeRepoFile(repo, nested, "later skill\n");
    commitAll(repo, "later policy");
    writeRepoFile(repo, ".codegenie/skills/dirty.md", "dirty skill\n");

    await expect(readBaseRevisionPolicy(resolved(repo, base), createGitClient(repo))).resolves.toEqual({
      origin: "base-revision", revision: base,
      config: { path: "codegenie.toml", content: config },
      skillFiles: [
        { path: ".codegenie/skills/alpha.md", content: "alpha\n" },
        { path: nested, content: "base skill\n" }
      ]
    });
  });

  it("distinguishes an empty base, a tree with no policy, and an unreadable base", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "src.ts", "export {};\n");
    const base = commitAll(repo, "no policy");
    const git = createGitClient(repo);
    await expect(readBaseRevisionPolicy(resolved(repo, await git.emptyTreeSha()), git)).resolves.toEqual({ origin: "none", skillFiles: [] });
    await expect(readBaseRevisionPolicy(resolved(repo, base), git)).resolves.toEqual({ origin: "base-revision", revision: base, skillFiles: [] });
    await expect(readBaseRevisionPolicy(resolved(repo, "missing"), git)).rejects.toMatchObject({ code: "git_ref_missing" });
  });

  it("refuses a symlinked config", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "target.toml", '[review]\ndepth = "deep"\n');
    symlinkSync("target.toml", path.join(repo, "codegenie.toml"));
    const base = commitAll(repo, "symlinked config");
    await expect(readBaseRevisionPolicy(resolved(repo, base), createGitClient(repo))).rejects.toMatchObject({ code: "config_error" });
  });

  it("reads a skill symlink as link text without following it", async () => {
    const repo = initRepo();
    writeRepoFile(repo, ".codegenie/skills/target.txt", "target content\n");
    symlinkSync("target.txt", path.join(repo, ".codegenie/skills/link.md"));
    const base = commitAll(repo, "symlinked skill");
    await expect(readBaseRevisionPolicy(resolved(repo, base), createGitClient(repo))).resolves.toMatchObject({
      skillFiles: [{ path: ".codegenie/skills/link.md", content: "target.txt" }]
    });
  });

  it("fails a Git read error but carries an eval checkout read error as a recoverable skill failure", async () => {
    const repo = initRepo();
    const filePath = ".codegenie/skills/fixture.md";
    const absolutePath = path.join(repo, filePath);
    writeRepoFile(repo, filePath, "fixture\n");
    const base = commitAll(repo, "skill fixture");
    const git = createGitClient(repo);
    vi.spyOn(git, "catFile").mockRejectedValueOnce(new CodegenieError("git_ref_missing", "object unavailable"));
    await expect(readBaseRevisionPolicy(resolved(repo, base), git)).rejects.toMatchObject({ code: "git_ref_missing" });

    const readFileSync = fs.readFileSync;
    const read = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (file === absolutePath) throw new Error("permission denied");
      return readFileSync(file, options);
    });
    syncBuiltinESMExports();
    try {
      const policy = readWorkingTreePolicy(repo);
      expect(policy.skillFiles).toEqual([{ path: filePath, readError: "permission denied" }]);
      const logger = { debug() {}, info() {}, warn() {}, error() {} };
      const loaded = await loadSkills({ repoRoot: repo, repoSkillFiles: policy.skillFiles, extraSkillPaths: [], logger, telemetry: nullTelemetry() });
      expect(loaded.failures).toEqual([{ filePath, reason: "failed to read skill file: permission denied" }]);
      expect(loaded.skills.some((skill) => skill.source === "bundled")).toBe(true);
    } finally {
      read.mockRestore();
      syncBuiltinESMExports();
    }
  });
});
