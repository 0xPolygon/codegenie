import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeReviewCommand, parseReviewCommand } from "../src/cli/review-command.js";
import { commitAll, git, initRepo, writeRepoFile } from "./helpers/git.js";

describe("review command pipeline", () => {
  it("runs the fake pipeline end to end and writes stage artifacts", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "export const value = 1;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "app.ts", "export const value = 'CODENINJA_FAKE_FINDING';\n");
    commitAll(repo, "feature");

    let stdout = "";
    const parsed = parseReviewCommand(["review", "--branch", "feature"], {
      repoRoot: repo,
      homeOverride: mkdtempSync(path.join(tmpdir(), "codeninja-home-")),
      env: { CODENINJA_PROVIDER: "fake", CODENINJA_MODEL: "fake-model" }
    });
    const result = await executeReviewCommand(parsed, { writeOutput: (text) => (stdout += text) });

    expect(result.hunks).toBe(1);
    for (const relPath of [
      "resolved-input.json",
      "diff.json",
      "file-filter-decisions.json",
      "file-facts.json",
      "planner-dossier.json",
      "review-plan.json",
      "coverage.json",
      "candidate-findings.json",
      "verification.json",
      "final-selection.json",
      "final-findings.json",
      "final-review.md"
    ]) {
      expect(existsSync(path.join(result.runDir, relPath)), relPath).toBe(true);
    }
    expect(readdirSync(path.join(result.runDir, "packets")).filter((file) => file.endsWith(".json"))).toHaveLength(1);
    const coverage = JSON.parse(readFileSync(path.join(result.runDir, "coverage.json"), "utf8"));
    expect(coverage).toMatchObject({
      status: {
        totalHunks: 1,
        reviewedHunks: 1,
        partial: false
      },
      records: [
        {
          path: "app.ts",
          coverage: "normal",
          status: "reviewed"
        }
      ]
    });
    expect(result.review.noFindings).toBe(false);
    expect(stdout).toContain("Fake finding in app.ts");
  });

  it("forwards repo config trust warnings into stage-0 logger and telemetry records", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "codeninja.toml", "[llm]\nprovider = \"ignored\"\n");
    writeRepoFile(repo, "app.ts", "export const value = 1;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "app.ts", "export const value = 2;\n");
    commitAll(repo, "feature");

    const parsed = parseReviewCommand(["review", "--branch", "feature"], {
      repoRoot: repo,
      homeOverride: mkdtempSync(path.join(tmpdir(), "codeninja-home-")),
      env: { CODENINJA_PROVIDER: "fake", CODENINJA_MODEL: "fake-model" }
    });

    expect(parsed.warnings).toContainEqual(expect.objectContaining({
      source: "repo-config",
      key: "llm.provider"
    }));

    const result = await executeReviewCommand(parsed);
    const warningMessage = "repo codeninja.toml cannot set user-scoped key llm.provider; value ignored";
    const logs = readJsonl(path.join(result.runDir, "run.log")) as Array<{ stage: number; event: string; message: string; data?: { key?: string } }>;
    const events = readJsonl(path.join(result.runDir, "events.jsonl")) as Array<{ stage: number; message: string; data?: { key?: string; message?: string } }>;

    expect(logs).toContainEqual(expect.objectContaining({
      stage: 0,
      event: "config_warning",
      message: warningMessage,
      data: expect.objectContaining({ key: "llm.provider" })
    }));
    expect(events).toContainEqual(expect.objectContaining({
      stage: 0,
      message: "config_warning",
      data: expect.objectContaining({ key: "llm.provider", message: warningMessage })
    }));
  });

  it("returns inventory counts without telemetry artifacts", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "export const value = 1;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "app.ts", "export const value = 2;\n");
    commitAll(repo, "feature");

    const parsed = parseReviewCommand(["review", "--branch", "feature"], {
      repoRoot: repo,
      homeOverride: mkdtempSync(path.join(tmpdir(), "codeninja-home-")),
      env: { CODENINJA_PROVIDER: "fake", CODENINJA_MODEL: "fake-model" }
    });
    const result = await executeReviewCommand({
      ...parsed,
      config: {
        ...parsed.config,
        telemetry: {
          ...parsed.config.telemetry,
          enabled: false
        }
      }
    });

    expect(result.runDir).toBe("");
    expect(result.filesChanged).toBe(1);
    expect(result.keptFiles).toBe(1);
    expect(result.hunks).toBe(1);
    expect(result.review.coverage.totalHunks).toBe(1);
  });

  it("short-circuits empty diffs without LLM stage artifacts", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "export const value = 1;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);

    const parsed = parseReviewCommand(["review", "--branch", "feature"], {
      repoRoot: repo,
      homeOverride: mkdtempSync(path.join(tmpdir(), "codeninja-home-")),
      env: { CODENINJA_PROVIDER: "fake", CODENINJA_MODEL: "fake-model" }
    });
    const result = await executeReviewCommand(parsed);

    expect(result.review).toMatchObject({
      noFindings: true,
      coverage: {
        totalHunks: 0,
        reviewedHunks: 0,
        skippedHunks: 0,
        partial: false
      }
    });
    expect(existsSync(path.join(result.runDir, "planner-dossier.json"))).toBe(false);
  });

  it("rejects unknown explicit lenses before zero-work short-circuiting", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "export const value = 1;\n");
    commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);

    const parsed = parseReviewCommand(["review", "--branch", "feature", "--lens", "typo/not-real"], {
      repoRoot: repo,
      homeOverride: mkdtempSync(path.join(tmpdir(), "codeninja-home-")),
      env: { CODENINJA_PROVIDER: "fake", CODENINJA_MODEL: "fake-model" }
    });

    await expect(executeReviewCommand(parsed)).rejects.toMatchObject({
      code: "invalid_args",
      context: expect.objectContaining({ unknown: ["typo/not-real"] })
    });

    const runsRoot = path.join(repo, ".codeninja", "runs");
    const runDirs = readdirSync(runsRoot);
    expect(runDirs).toHaveLength(1);
    const runDir = path.join(runsRoot, runDirs[0] ?? "");
    expect(existsSync(path.join(runDir, "planner-dossier.json"))).toBe(false);
    expect(existsSync(path.join(runDir, "review-plan.json"))).toBe(false);
    const runJson = JSON.parse(readFileSync(path.join(runDir, "run.json"), "utf8"));
    expect(runJson.outcome).toMatchObject({
      status: "failed",
      errorCode: "invalid_args"
    });
  });

  it("finalizes failed runs after run directory creation", async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "codeninja-not-git-"));
    const parsed = parseReviewCommand(["review", "--branch", "feature"], {
      repoRoot,
      homeOverride: mkdtempSync(path.join(tmpdir(), "codeninja-home-")),
      env: { CODENINJA_PROVIDER: "fake", CODENINJA_MODEL: "fake-model" }
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

function readJsonl(filePath: string): unknown[] {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}
