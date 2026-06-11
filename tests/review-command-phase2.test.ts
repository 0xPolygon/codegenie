import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeReviewCommand, parseReviewCommand } from "../src/cli/review-command.js";
import { commitAll, git, initRepo, writeRepoFile } from "./helpers/git.js";

describe("review command phase 2 inventory", () => {
  it("writes resolved input, diff, filter, facts, and coverage artifacts", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "export const value = 1;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "app.ts", "export const value = 2;\n");
    commitAll(repo, "feature");

    const parsed = parseReviewCommand(["review", "--branch", "feature"], {
      repoRoot: repo,
      homeOverride: mkdtempSync(path.join(tmpdir(), "codeninja-home-")),
      env: {}
    });
    const result = await executeReviewCommand(parsed);

    expect(result.filesChanged).toBe(1);
    expect(result.hunks).toBe(1);
    expect(result.keptFiles).toBe(1);
    for (const relPath of [
      "resolved-input.json",
      "diff.json",
      "file-filter-decisions.json",
      "file-facts.json",
      "coverage.json"
    ]) {
      expect(existsSync(path.join(result.runDir, relPath)), relPath).toBe(true);
    }
    const coverage = JSON.parse(readFileSync(path.join(result.runDir, "coverage.json"), "utf8"));
    expect(coverage).toMatchObject({
      status: "not_implemented",
      phase: 2,
      filesChanged: 1,
      hunks: 1,
      keptFiles: 1,
      classifiedFiles: 1
    });
  });

  it("finalizes failed runs after run directory creation", async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "codeninja-not-git-"));
    const parsed = parseReviewCommand(["review", "--branch", "feature"], {
      repoRoot,
      homeOverride: mkdtempSync(path.join(tmpdir(), "codeninja-home-")),
      env: {}
    });

    await expect(executeReviewCommand(parsed)).rejects.toMatchObject({ code: "not_git_worktree" });

    const runsRoot = path.join(repoRoot, ".codeninja", "runs");
    const runDirs = readdirSync(runsRoot);
    expect(runDirs).toHaveLength(1);
    const runJson = JSON.parse(readFileSync(path.join(runsRoot, runDirs[0] ?? "", "run.json"), "utf8"));
    expect(runJson.outcome).toMatchObject({
      status: "failed",
      errorCode: "not_git_worktree",
      exitCode: 2
    });
  });
});
