import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    expect(parsed.config.lenses.restrictTo).toEqual(["core/tests", "lang/go"]);
    expect(parsed.config.cache.enabled).toBe(true);
  });

  it("enables progress by default and disables it for CI-friendly output", () => {
    expect(parseReviewCommand(["review", "feature"], testContext()).options.progress).toBe(true);
    expect(parseReviewCommand(["review", "feature", "--ci"], testContext()).options.progress).toBe(false);
    expect(parseReviewCommand(["review", "feature", "--no-progress"], testContext()).options.progress).toBe(false);
  });

  it("parses explicit head/base review flags", () => {
    const parsed = parseReviewCommand(
      ["review", "--head", "49f4645b40e3", "--base", "master"],
      testContext()
    );

    expect(parsed.target).toEqual({
      mode: "head",
      headRef: "49f4645b40e3",
      baseRef: "master"
    });
  });

  it("parses base...head shorthand as pinned PR-style review", () => {
    const parsed = parseReviewCommand(["review", "master...49f4645b40e3"], testContext());

    expect(parsed.target).toEqual({
      mode: "head",
      headRef: "49f4645b40e3",
      baseRef: "master"
    });
  });

  it("rejects head review without base", () => {
    expect(() => parseReviewCommand(["review", "--head", "49f4645b40e3"], testContext())).toThrow(
      /--base requires a value/
    );
  });

  it("rejects invalid base...head shorthand", () => {
    expect(() => parseReviewCommand(["review", "master..."], testContext())).toThrow(
      /base\/head shorthand/
    );
  });

  it("rejects --base with positional base...head shorthand", () => {
    expect(() =>
      parseReviewCommand(["review", "master...49f4645b40e3", "--base", "main"], testContext())
    ).toThrow(/--base is only valid/);
  });

  it("parses one positional target as a branch-or-commit ref", () => {
    const parsed = parseReviewCommand(["review", "feature"], testContext());

    expect(parsed.target).toEqual({
      mode: "single_ref",
      ref: "feature"
    });
  });

  it("allows --base with one positional branch-or-commit ref", () => {
    const parsed = parseReviewCommand(["review", "feature", "--base", "develop"], testContext());

    expect(parsed.target).toEqual({
      mode: "single_ref",
      ref: "feature",
      baseBranch: "develop"
    });
  });

  it("rejects --base with two positional range refs", () => {
    expect(() =>
      parseReviewCommand(["review", "abc123", "def456", "--base", "main"], testContext())
    ).toThrow(/--base is only valid/);
  });

  it("loads repo config from the git worktree root when invoked inside a subdirectory", () => {
    const ctx = testContext();
    execFileSync("git", ["init"], { cwd: ctx.repoRoot, stdio: "ignore" });
    writeFileSync(path.join(ctx.repoRoot, "codeninja.toml"), "[review]\ndepth = \"deep\"\n");
    mkdirSync(path.join(ctx.repoRoot, "src", "nested"), { recursive: true });

    const parsed = parseReviewCommand(["review", "--branch", "feature"], {
      ...ctx,
      repoRoot: path.join(ctx.repoRoot, "src", "nested")
    });

    expect(parsed.repoRoot).toBe(ctx.repoRoot);
    expect(parsed.config.review.depth).toBe("deep");
  });

  it("lets --no-cache override a configured cache default", () => {
    const ctx = testContext();
    writeFileSync(path.join(ctx.homeOverride, "config.toml"), "[cache]\nenabled = true\n");

    const parsed = parseReviewCommand(["review", "--branch", "feature", "--no-cache"], ctx);

    expect(parsed.options.cacheOverride).toBe(false);
    expect(parsed.config.cache.enabled).toBe(false);
    expect(parsed.configSources["cache.enabled"]).toBe("cli");
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
