import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CliDisplayExit, parseReviewCommand } from "../src/cli/review-command.js";
import { CodeninjaError } from "../src/util/errors.js";

describe("review command", () => {
  it("treats top-level help as a successful display exit", () => {
    expect(() => parseReviewCommand(["--help"], testContext())).toThrow(CliDisplayExit);

    try {
      parseReviewCommand(["--help"], testContext());
      throw new Error("expected help exit");
    } catch (error) {
      expect(error).toBeInstanceOf(CliDisplayExit);
      expect((error as CliDisplayExit).exitCode).toBe(0);
    }
  });

  it("treats review help as a successful display exit", () => {
    expect(() => parseReviewCommand(["review", "--help"], testContext())).toThrow(CliDisplayExit);
  });

  it("exposes provider help through the root command tree", () => {
    expect(() => parseReviewCommand(["help", "provider"], testContext())).toThrow(CliDisplayExit);
  });

  it("rejects conflicting targets", () => {
    const ctx = testContext();

    expect(() =>
      parseReviewCommand(["review", "--pr", "123", "--branch", "feature"], ctx)
    ).toThrow(CodeninjaError);
    expect(() =>
      parseReviewCommand(["review", "--pr", "123", "--branch", "feature"], ctx)
    ).toThrow(/mutually exclusive/);
  });

  it("requires --pr for GitHub posting", () => {
    const ctx = testContext();

    expect(() => parseReviewCommand(["review", "--post-github-comments"], ctx)).toThrow(
      /requires --pr/
    );
  });

  it("parses branch review flags, repeated lenses, cache, and output format", () => {
    const ctx = testContext();

    const parsed = parseReviewCommand(
      [
        "review",
        "--branch",
        "feature",
        "--base",
        "main",
        "--lens",
        "core/tests",
        "--lens",
        "lang/go",
        "--format",
        "json",
        "--cache"
      ],
      ctx
    );

    expect(parsed.target).toEqual({ mode: "branch", branchName: "feature", baseBranch: "main" });
    expect(parsed.options.format).toBe("json");
    expect(parsed.options.cacheOverride).toBe(true);
    expect(parsed.options.cliLenses).toEqual(["core/tests", "lang/go"]);
    expect(parsed.config.lenses.enabled).toEqual(["core/tests", "lang/go"]);
    expect(parsed.config.cache.enabled).toBe(true);
  });

  it("parses commit ranges", () => {
    const parsed = parseReviewCommand(["review", "abc123", "def456"], testContext());

    expect(parsed.target).toEqual({
      mode: "commit_range",
      startCommit: "abc123",
      endCommit: "def456"
    });
  });
});

function testContext(): { repoRoot: string; homeOverride: string; env: NodeJS.ProcessEnv } {
  return {
    repoRoot: mkdtempSync(path.join(tmpdir(), "codeninja-repo-")),
    homeOverride: mkdtempSync(path.join(tmpdir(), "codeninja-home-")),
    env: {}
  };
}
