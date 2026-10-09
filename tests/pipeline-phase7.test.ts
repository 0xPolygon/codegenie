import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { runReview } from "../src/pipeline/review-runner.js";
import { canonicalArtifactPath } from "../src/telemetry/run-artifacts.js";
import type { CodegenieConfig, GitHubClient, PullRequestMetadata } from "../src/types.js";
import { commitAll, git, initRepo, writeRepoFile } from "./helpers/git.js";

describe("phase 7 GitHub pipeline integration", () => {
  it("runs PR review and posts through Stage 11 when requested", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "export const value = 1;\n");
    const base = commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "app.ts", "export const value = 2; // CODEGENIE_FAKE_FINDING HIGH_CONFIDENCE\n");
    const head = commitAll(repo, "feature");
    const runArtifactDir = path.join(mkdtempSync(path.join(tmpdir(), "codegenie-phase7-")), "pr-review");
    const lockDir = path.join(repo, ".codegenie", "locks", "pr-44.refs.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({ runId: "stale", prNumber: 44, pid: 99_999_999 })}\n`);
    const output: string[] = [];
    const posted: Array<{ comments: unknown[]; body: string }> = [];

    const result = await runReview(
      { mode: "github_pr", prNumber: 44 },
      phase7Config(runArtifactDir),
      {
        repoRoot: repo,
        runArtifactDir,
        postGithubComments: true,
        github: fakeGithub(base, head, posted),
        writeOutput: (text) => output.push(text)
      }
    );

    expect(result.posting).toMatchObject({ status: "posted", inlinePosted: 1 });
    expect(posted).toHaveLength(1);
    expect(posted[0]?.comments).toHaveLength(1);
    expect(output.join("\n")).toContain("Status: posted");
    expect(output.join("\n")).toContain("Inline comments posted: 1");
    expect(existsSync(runFilePath(runArtifactDir, "github-posting.json"))).toBe(true);
    expect(readFileSync(runFilePath(runArtifactDir, "github-posting.json"), "utf8")).toContain("\"status\": \"posted\"");
    expect(existsSync(lockDir)).toBe(false);
  });

  it("posts the configured no-findings review for zero-work PR runs", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "export const value = 1;\n");
    const base = commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    const runArtifactDir = path.join(mkdtempSync(path.join(tmpdir(), "codegenie-phase7-zero-")), "pr-review");
    const output: string[] = [];
    const posted: Array<{ comments: unknown[]; body: string }> = [];

    const result = await runReview(
      { mode: "github_pr", prNumber: 44 },
      { ...phase7Config(runArtifactDir), github: { ...defaultConfig.github, summaryWhenNoFindings: true } },
      {
        repoRoot: repo,
        runArtifactDir,
        postGithubComments: true,
        github: fakeGithub(base, base, posted),
        writeOutput: (text) => output.push(text)
      }
    );

    expect(result.noFindings).toBe(true);
    expect(result.posting).toMatchObject({ status: "posted", inlinePosted: 0 });
    expect(posted).toEqual([{ comments: [], body: expect.stringMatching(/^Nothing to review\.\n\n— codegenie v\S+( \(`[0-9a-f]{1,10}`\))?( · \[View Workflow Job\]\(.+\))?$/u) }]);
    expect(output.join("\n")).toContain("Status: posted");
    expect(readFileSync(runFilePath(runArtifactDir, "github-posting.json"), "utf8")).toContain("\"inlinePosted\": 0");
  });

  it("keeps a stale approval on an exclusion-only push and dismisses it once there is reviewable work", async () => {
    const staleApprove = [{ id: "7", state: "APPROVED", commitId: "c".repeat(40), submittedAt: "2026-01-01T00:00:00Z" }];
    const approveConfig = (runArtifactDir: string): CodegenieConfig => ({
      ...phase7Config(runArtifactDir),
      github: { ...defaultConfig.github, reviewMode: "approve" },
      classification: { pathRules: [{ pattern: "generated/**", processingMode: "skip", reason: "generated output" }] }
    });

    const excludedRepo = initRepo();
    writeRepoFile(excludedRepo, "generated/out.ts", "export const value = 1;\n");
    const excludedBase = commitAll(excludedRepo, "base");
    git(excludedRepo, ["checkout", "-b", "feature"]);
    writeRepoFile(excludedRepo, "generated/out.ts", "export const value = 2;\n");
    const excludedHead = commitAll(excludedRepo, "feature");
    const excludedDir = path.join(mkdtempSync(path.join(tmpdir(), "codegenie-phase7-excluded-")), "pr-review");
    const excludedDismissed: string[] = [];
    const excludedEvents: string[] = [];
    const excludedResult = await runReview({ mode: "github_pr", prNumber: 44 }, approveConfig(excludedDir), {
      repoRoot: excludedRepo,
      runArtifactDir: excludedDir,
      postGithubComments: true,
      github: fakeGithub(excludedBase, excludedHead, [], { reviews: staleApprove, dismissed: excludedDismissed, events: excludedEvents }),
      writeOutput: () => undefined
    });
    expect(excludedDismissed).toEqual([]);
    // Zero reviewed hunks is an incomplete run, so it must post a verdict that is not an approval.
    expect(excludedEvents).toEqual(["COMMENT"]);
    // Deliberate exclusions are not incomplete work, so no "Review incomplete" banner for any mode.
    expect(excludedResult.coverage.partial).toBe(false);

    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "export const value = 1;\n");
    const base = commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "app.ts", "export const value = 2; // CODEGENIE_FAKE_FINDING HIGH_CONFIDENCE\n");
    const head = commitAll(repo, "feature");
    const runArtifactDir = path.join(mkdtempSync(path.join(tmpdir(), "codegenie-phase7-stale-")), "pr-review");
    const dismissed: string[] = [];
    await runReview({ mode: "github_pr", prNumber: 44 }, approveConfig(runArtifactDir), {
      repoRoot: repo,
      runArtifactDir,
      postGithubComments: true,
      github: fakeGithub(base, head, [], { reviews: staleApprove, dismissed }),
      writeOutput: () => undefined
    });
    expect(dismissed).toEqual(["7"]);
  }, 60_000);

  it("scrubs pinned secret patterns from final review artifacts", async () => {
    const repo = initRepo();
    writeRepoFile(repo, "app.ts", "console.log(\"safe\");\n");
    const base = commitAll(repo, "base");
    git(repo, ["checkout", "-b", "feature"]);
    writeRepoFile(repo, "app.ts", "console.log(\"xoxb-abcdefghijklmnop\"); // CODEGENIE_FAKE_FINDING HIGH_CONFIDENCE\n");
    const head = commitAll(repo, "feature");
    const runArtifactDir = path.join(mkdtempSync(path.join(tmpdir(), "codegenie-phase7-scrub-")), "branch-review");

    await runReview(
      { mode: "commit_range", startCommit: base, endCommit: head },
      phase7Config(runArtifactDir),
      { repoRoot: repo, runArtifactDir }
    );

    const finalReview = readFileSync(path.join(runArtifactDir, "final-review.md"), "utf8");
    const finalFindings = readFileSync(runFilePath(runArtifactDir, "final-findings.json"), "utf8");
    expect(finalReview).not.toContain("xoxb-abcdefghijklmnop");
    expect(finalFindings).not.toContain("xoxb-abcdefghijklmnop");
    expect(finalReview).toContain("[redacted:slack-token]");
    expect(finalFindings).toContain("[redacted:slack-token]");
  });
});

function phase7Config(runArtifactDir: string): CodegenieConfig {
  return {
    ...defaultConfig,
    lenses: { enabled: ["core/code-review"], disabled: [], extraSkillPaths: [] },
    llm: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
    telemetry: { ...defaultConfig.telemetry, enabled: true, runDir: path.dirname(runArtifactDir) },
    review: { ...defaultConfig.review, concurrency: 1, maxModelCalls: 12 }
  };
}

function fakeGithub(
  baseSha: string,
  headSha: string,
  posted: Array<{ comments: unknown[]; body: string }>,
  approvals: { reviews?: Awaited<ReturnType<GitHubClient["listOwnReviews"]>>; dismissed?: string[]; events?: string[] } = {}
): GitHubClient {
  const metadata: PullRequestMetadata = {
    owner: "0xPolygon",
    repo: "codegenie",
    number: 44,
    title: "Phase 7 PR",
    body: "",
    url: "https://github.com/0xPolygon/codegenie/pull/44",
    baseRefName: "main",
    baseSha,
    headRefName: "feature",
    headSha
  };
  return {
    viewPr: async () => metadata,
    listOwnComments: async () => [],
    listOwnReviews: async () => approvals.reviews ?? [],
    dismissReview: async (_number, reviewId) => {
      approvals.dismissed?.push(reviewId);
    },
    compareFiles: async () => [],
    createReview: async (_number, review) => {
      posted.push({ comments: review.comments, body: review.body });
      approvals.events?.push(review.event);
    }
  };
}

function runFilePath(runDir: string, relPath: string): string {
  return path.join(runDir, canonicalArtifactPath(relPath));
}
