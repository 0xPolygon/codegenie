import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { parseDiff } from "../src/git/diff-parser.js";
import { maybePublishToGitHub } from "../src/github/publisher.js";
import type { LlmRunner } from "../src/llm/llm-runner.js";
import { renderMarkdownReview } from "../src/output/markdown-renderer.js";
import { dedupeRankAndComposeReview, refreshReviewHealth } from "../src/pipeline/composer.js";
import { createPromptBuilder } from "../src/skills/prompt-builder.js";
import type { LensRegistry } from "../src/skills/lens-registry.js";
import type {
  CandidateFinding,
  FinalFinding,
  GitHubClient,
  PullRequestMetadata,
  ReviewPlan,
  ReviewResult,
  RunCoverageStatus
} from "../src/types.js";
import { CodegenieError } from "../src/util/errors.js";
import { FINDING_ORDER_NOTE, presentationOrder } from "../src/util/markdown.js";
import { nullTelemetry } from "./helpers/git.js";

const MULTI_FILE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,1 +1,12 @@",
  "-export const a = 0;",
  "+export const a1 = 1;",
  "+export const a2 = 2;",
  "+export const a3 = 3;",
  "+export const a4 = 4;",
  "+export const a5 = 5;",
  "+export const a6 = 6;",
  "+export const a7 = 7;",
  "+export const a8 = 8;",
  "+export const a9 = 9;",
  "+export const a10 = 10;",
  "+export const a11 = 11;",
  "+export const a12 = 12;",
  "diff --git a/src/z.ts b/src/z.ts",
  "index 3333333..4444444 100644",
  "--- a/src/z.ts",
  "+++ b/src/z.ts",
  "@@ -1,1 +1,4 @@",
  "-export const z = 0;",
  "+export const z1 = 1;",
  "+export const z2 = 2;",
  "+export const z3 = 3;",
  "+export const z4 = 4;",
  ""
].join("\n");

describe("finding presentation order (#104)", () => {
  it("groups by severity and orders within a severity by file, numeric line, anchorless last, and id", () => {
    const input = [
      { id: "m-b-2", severity: "medium" as const, confidence: "high" as const, path: "src/b.ts", anchor: anchor("src/b.ts", 2) },
      { id: "l-a-1", severity: "low" as const, confidence: "high" as const, path: "src/a.ts", anchor: anchor("src/a.ts", 1) },
      { id: "m-a-none-b", severity: "medium" as const, confidence: "high" as const, path: "src/a.ts" },
      { id: "m-a-10", severity: "medium" as const, confidence: "high" as const, path: "src/a.ts", anchor: anchor("src/a.ts", 10) },
      { id: "m-a-2-b", severity: "medium" as const, confidence: "low" as const, path: "src/a.ts", anchor: anchor("src/a.ts", 2) },
      { id: "m-a-2-a", severity: "medium" as const, confidence: "low" as const, path: "src/a.ts", anchor: anchor("src/a.ts", 2) },
      { id: "m-a-none-a", severity: "medium" as const, confidence: "low" as const, path: "src/a.ts" },
      { id: "h-z-50", severity: "high" as const, confidence: "medium" as const, path: "src/z.ts", anchor: anchor("src/z.ts", 50) },
      { id: "c-z-99", severity: "critical" as const, confidence: "low" as const, path: "src/z.ts", anchor: anchor("src/z.ts", 99) }
    ];
    const snapshot = input.map((item) => item.id);

    const ordered = presentationOrder(input);

    expect(input.map((item) => item.id)).toEqual(snapshot);
    expect(ordered.map((item) => item.id)).toEqual([
      "c-z-99",
      "h-z-50",
      "m-a-2-a",
      "m-a-2-b",
      "m-a-10",
      "m-a-none-a",
      "m-a-none-b",
      "m-b-2",
      "l-a-1"
    ]);
  });

  it("applies reader order after caps in composer while keeping compareFindings for caps and composer prompt input", async () => {
    const diff = parseDiff(MULTI_FILE_DIFF);
    const aHunk = diff.files.find((file) => file.path === "src/a.ts")!.hunks[0]!;
    const zHunk = diff.files.find((file) => file.path === "src/z.ts")!.hunks[0]!;

    // Higher-confidence z.ts finding must win softCommentCap / maxFindings over
    // lower-confidence a.ts finding of the same severity, proving applyCaps
    // still uses compareFindings rather than presentationOrder.
    const highConfLaterFile = candidate({
      id: "med-highconf-z",
      title: "High confidence later file",
      severity: "medium",
      confidence: "high",
      path: "src/z.ts",
      anchor: { path: "src/z.ts", line: 4, side: "RIGHT", hunkId: zHunk.id },
      failureMode: "Later file high-confidence failure mode that triggers on empty input."
    });
    const medConfEarlierFile = candidate({
      id: "med-medconf-a",
      title: "Medium confidence earlier file",
      severity: "medium",
      confidence: "medium",
      path: "src/a.ts",
      anchor: { path: "src/a.ts", line: 2, side: "RIGHT", hunkId: aHunk.id },
      failureMode: "Earlier file medium-confidence failure mode that drops records."
    });
    const medConfLaterLine = candidate({
      id: "med-medconf-a10",
      title: "Medium confidence later line",
      severity: "medium",
      confidence: "medium",
      path: "src/a.ts",
      anchor: { path: "src/a.ts", line: 10, side: "RIGHT", hunkId: aHunk.id },
      failureMode: "Later line medium-confidence failure mode that skips retries."
    });

    // Stage 10 composer prompt retains compareFindings order (high confidence
    // z.ts before medium confidence a.ts), byte-identical to master.
    const capturedPrompts: string[] = [];
    const capturingRunner = (findings: CandidateFinding[]): LlmRunner => ({
      runStructured: async <T>(req: { prompt: string }) => {
        capturedPrompts.push(req.prompt);
        return {
          summary: `Found ${findings.length} verified issues.`,
          composedFindings: findings.map((finding) => ({
            findingIds: [finding.id],
            finalBody: finding.failureMode,
            publication: finding.anchor ? "inline" : "summary-only"
          }))
        } as T;
      }
    });

    const three = [medConfLaterLine, medConfEarlierFile, highConfLaterFile];
    const softArtifacts = new Map<string, unknown>();
    const softTelemetry = {
      ...nullTelemetry(),
      writeArtifact: async (name: string, data: unknown) => {
        softArtifacts.set(name, data);
      }
    };
    const softCapped = await dedupeRankAndComposeReview(
      { verified: three, verdicts: [] },
      fakePlan(),
      fakeResolved(),
      fakeCoverage(),
      { ...defaultConfig, review: { ...defaultConfig.review, softCommentCap: 1, maxFindings: 10 } },
      softTelemetry,
      { runner: capturingRunner(three), promptBuilder: fakePromptBuilder(), diff }
    );
    expect(softCapped.findings.map((finding) => finding.id)).toEqual(["med-highconf-z"]);
    expect(softCapped.summaryOnlyFindings.map((finding) => finding.id)).toEqual(["med-medconf-a", "med-medconf-a10"]);
    const softSuppressed = (softArtifacts.get("final-findings.json") as FinalFinding[])
      .filter((finding) => finding.publication === "suppressed")
      .map((finding) => finding.id);
    expect(softSuppressed).toEqual([]);

    // In the composer prompt, compareFindings put high-confidence z.ts first,
    // followed by a.ts line 2, then a.ts line 10; and no presentation note leaks in.
    const prompt = capturedPrompts[0] ?? "";
    expect(prompt.indexOf("\"id\": \"med-highconf-z\"")).toBeGreaterThan(-1);
    expect(prompt.indexOf("\"id\": \"med-highconf-z\"")).toBeLessThan(prompt.indexOf("\"id\": \"med-medconf-a\""));
    expect(prompt.indexOf("\"id\": \"med-medconf-a\"")).toBeLessThan(prompt.indexOf("\"id\": \"med-medconf-a10\""));
    expect(prompt).not.toContain(FINDING_ORDER_NOTE);

    // Over both softCommentCap (1) and maxFindings (2): high-confidence z.ts stays
    // inline, a.ts:2 downgrades to summary-only, a.ts:10 is suppressed — identical
    // published/summary-only/suppressed id sets to master.
    const maxArtifacts = new Map<string, unknown>();
    const maxTelemetry = {
      ...nullTelemetry(),
      writeArtifact: async (name: string, data: unknown) => {
        maxArtifacts.set(name, data);
      }
    };
    const maxCapped = await dedupeRankAndComposeReview(
      { verified: three, verdicts: [] },
      fakePlan(),
      fakeResolved(),
      fakeCoverage(),
      { ...defaultConfig, review: { ...defaultConfig.review, softCommentCap: 1, maxFindings: 2 } },
      maxTelemetry,
      { runner: passthroughComposerRunner(three), promptBuilder: fakePromptBuilder(), diff }
    );
    expect(maxCapped.findings.map((finding) => finding.id)).toEqual(["med-highconf-z"]);
    expect(maxCapped.summaryOnlyFindings.map((finding) => finding.id)).toEqual(["med-medconf-a"]);
    const maxSuppressed = (maxArtifacts.get("final-findings.json") as FinalFinding[])
      .filter((finding) => finding.publication === "suppressed")
      .map((finding) => finding.id);
    expect(maxSuppressed).toEqual(["med-medconf-a10"]);
  });

  it("orders two files of the same severity with mixed confidence by path then line, places anchorless last, and applies the same order on deterministic fallback", async () => {
    const diff = parseDiff(MULTI_FILE_DIFF);
    const aHunk = diff.files.find((file) => file.path === "src/a.ts")!.hunks[0]!;
    const zHunk = diff.files.find((file) => file.path === "src/z.ts")!.hunks[0]!;

    const medHighZ = candidate({
      id: "med-high-z",
      title: "Unbounded cache growth in z.ts",
      severity: "medium",
      confidence: "high",
      path: "src/z.ts",
      anchor: { path: "src/z.ts", line: 1, side: "RIGHT", hunkId: zHunk.id },
      failureMode: "Entries inserted into the cache are never evicted and grow without bound.",
      whyThisMatters: "Long-lived workers exhaust process memory."
    });
    const medMedA10 = candidate({
      id: "med-med-a10",
      title: "Skipped pagination token in a.ts",
      severity: "medium",
      confidence: "medium",
      path: "src/a.ts",
      anchor: { path: "src/a.ts", line: 10, side: "RIGHT", hunkId: aHunk.id },
      failureMode: "Loop terminates after the first response page and ignores nextCursor.",
      whyThisMatters: "Callers silently receive truncated result sets."
    });
    const medMedA2 = candidate({
      id: "med-med-a2",
      title: "Stale timeout reuse in a.ts",
      severity: "medium",
      confidence: "medium",
      path: "src/a.ts",
      anchor: { path: "src/a.ts", line: 2, side: "RIGHT", hunkId: aHunk.id },
      failureMode: "Timer handle is overwritten without clearing the previous scheduled callback.",
      whyThisMatters: "Superseded requests fire late and overwrite fresh state."
    });
    // Same severity & same file in summary-only: anchored must sort before
    // anchorless even when anchorless has higher confidence and earlier id.
    const sumAnchorlessA = candidate({
      id: "a-sum-anchorless",
      title: "Missing socket close on shutdown",
      severity: "medium",
      confidence: "high",
      path: "src/a.ts",
      failureMode: "Graceful shutdown exits before draining open TCP listeners.",
      whyThisMatters: "In-flight client requests are reset during deploys."
    });
    const sumAnchoredA = candidate({
      id: "z-sum-anchored",
      title: "Missing null check before parsing header",
      severity: "medium",
      confidence: "medium",
      path: "src/a.ts",
      anchor: { path: "src/a.ts", line: 6, side: "RIGHT", hunkId: aHunk.id },
      failureMode: "Optional authorization header is split without checking for undefined.",
      whyThisMatters: "Unauthenticated requests throw an unhandled TypeError."
    });

    const inputs = [medHighZ, medMedA10, medMedA2, sumAnchorlessA, sumAnchoredA];
    const llmResult = await dedupeRankAndComposeReview(
      { verified: inputs, verdicts: [] },
      fakePlan(),
      fakeResolved(),
      fakeCoverage(),
      defaultConfig,
      nullTelemetry(),
      {
        runner: {
          runStructured: async <T>() => ({
            summary: "Found 5 verified issues.",
            composedFindings: [
              { findingIds: ["med-high-z"], finalBody: medHighZ.failureMode, publication: "inline" },
              { findingIds: ["med-med-a10"], finalBody: medMedA10.failureMode, publication: "inline" },
              { findingIds: ["med-med-a2"], finalBody: medMedA2.failureMode, publication: "inline" },
              { findingIds: ["a-sum-anchorless"], finalBody: sumAnchorlessA.failureMode, publication: "summary-only" },
              { findingIds: ["z-sum-anchored"], finalBody: sumAnchoredA.failureMode, publication: "summary-only" }
            ]
          }) as T
        },
        promptBuilder: fakePromptBuilder(),
        diff,
        postGithubComments: true
      }
    );

    expect(llmResult.findings.map((finding) => finding.id)).toEqual(["med-med-a2", "med-med-a10", "med-high-z"]);
    expect(llmResult.summaryOnlyFindings.map((finding) => finding.id)).toEqual(["z-sum-anchored", "a-sum-anchorless"]);

    // Deterministic fallback (recoverable LLM error) produces the same reader order
    // for both inline and summary-only findings.
    const sumAnchorlessZ = candidate({
      id: "sum-anchorless-z",
      title: "Unclosed temp directory on failure",
      severity: "medium",
      confidence: "high",
      path: "src/z.ts",
      failureMode: "Temporary staging directory is left on disk when archive extraction throws.",
      whyThisMatters: "Repeated failed uploads fill ephemeral storage."
    });
    const fallbackResult = await dedupeRankAndComposeReview(
      { verified: [medHighZ, medMedA10, medMedA2, sumAnchorlessZ, sumAnchorlessA], verdicts: [] },
      fakePlan(),
      fakeResolved(),
      fakeCoverage(),
      defaultConfig,
      nullTelemetry(),
      {
        runner: {
          runStructured: async () => {
            throw new CodegenieError("budget_exhausted", "composer budget exhausted");
          }
        },
        promptBuilder: fakePromptBuilder(),
        diff,
        postGithubComments: true
      }
    );
    expect(fallbackResult.composition?.mode).toBe("deterministic_fallback");
    expect(fallbackResult.findings.map((finding) => finding.id)).toEqual(["med-med-a2", "med-med-a10", "med-high-z"]);
    expect(fallbackResult.postingPlan?.inline.map((item) => item.findingId)).toEqual(["med-med-a2", "med-med-a10", "med-high-z"]);
    expect(fallbackResult.summaryOnlyFindings.map((finding) => finding.id)).toEqual(["a-sum-anchorless", "sum-anchorless-z"]);
    expect(fallbackResult.postingPlan?.reviewBody).toContain(`**Summary-only findings:**\n${FINDING_ORDER_NOTE}`);
  });

  it("orders inline, summary-only, postingPlan, and reviewBody by severity then file/line and emits the note only for 2+ findings", async () => {
    const diff = parseDiff(MULTI_FILE_DIFF);
    const aHunk = diff.files.find((file) => file.path === "src/a.ts")!.hunks[0]!;
    const zHunk = diff.files.find((file) => file.path === "src/z.ts")!.hunks[0]!;

    const inlineHighZ = candidate({
      id: "in-high-z",
      title: "Inline high z.ts",
      severity: "high",
      confidence: "medium",
      path: "src/z.ts",
      anchor: { path: "src/z.ts", line: 4, side: "RIGHT", hunkId: zHunk.id },
      failureMode: "High severity failure in z.ts causes crash on startup."
    });
    const inlineMedA10 = candidate({
      id: "in-med-a10",
      title: "Inline medium a.ts line 10",
      severity: "medium",
      confidence: "high",
      path: "src/a.ts",
      anchor: { path: "src/a.ts", line: 10, side: "RIGHT", hunkId: aHunk.id },
      failureMode: "Medium severity failure in a.ts line 10 skips validation."
    });
    const inlineMedA2 = candidate({
      id: "in-med-a2",
      title: "Inline medium a.ts line 2",
      severity: "medium",
      confidence: "medium",
      path: "src/a.ts",
      anchor: { path: "src/a.ts", line: 2, side: "RIGHT", hunkId: aHunk.id },
      failureMode: "Medium severity failure in a.ts line 2 returns stale state."
    });
    const summaryMedZ = candidate({
      id: "sum-med-z",
      title: "Summary medium z.ts",
      severity: "medium",
      confidence: "high",
      path: "src/z.ts",
      failureMode: "Summary-only failure in z.ts leaks file handles."
    });
    const summaryMedA = candidate({
      id: "sum-med-a",
      title: "Summary medium a.ts",
      severity: "medium",
      confidence: "medium",
      path: "src/a.ts",
      failureMode: "Summary-only failure in a.ts ignores cancellation."
    });
    const summaryHighZ = candidate({
      id: "sum-high-z",
      title: "Summary high z.ts",
      severity: "high",
      confidence: "medium",
      path: "src/z.ts",
      failureMode: "Summary-only high failure in z.ts corrupts persisted state."
    });

    const artifacts = new Map<string, unknown>();
    const telemetry = {
      ...nullTelemetry(),
      writeArtifact: async (name: string, data: unknown) => {
        artifacts.set(name, data);
      }
    };

    const scrambled = [inlineMedA10, inlineMedA2, inlineHighZ, summaryMedZ, summaryMedA, summaryHighZ];
    const result = await dedupeRankAndComposeReview(
      { verified: scrambled, verdicts: [] },
      fakePlan(),
      fakeResolved(),
      fakeCoverage(),
      defaultConfig,
      telemetry,
      {
        runner: passthroughComposerRunner(scrambled),
        promptBuilder: fakePromptBuilder(),
        diff,
        postGithubComments: true
      }
    );

    expect(result.findings.map((finding) => finding.id)).toEqual([
      "in-high-z",
      "in-med-a2",
      "in-med-a10"
    ]);
    expect(result.postingPlan?.inline.map((item) => item.findingId)).toEqual([
      "in-high-z",
      "in-med-a2",
      "in-med-a10"
    ]);
    expect(result.summaryOnlyFindings.map((finding) => finding.id)).toEqual([
      "sum-high-z",
      "sum-med-a",
      "sum-med-z"
    ]);

    // final-findings.json retains applyCaps (compareFindings) order:
    // high-confidence medium findings precede medium-confidence medium ones.
    const artifactFindings = artifacts.get("final-findings.json") as FinalFinding[];
    expect(artifactFindings.map((finding) => finding.id).indexOf("in-med-a10")).toBeLessThan(
      artifactFindings.map((finding) => finding.id).indexOf("in-med-a2")
    );

    const reviewBody = result.postingPlan?.reviewBody ?? "";
    expect(reviewBody).toContain(`**Summary-only findings:**\n${FINDING_ORDER_NOTE}`);
    expect(reviewBody.indexOf("Summary high z.ts")).toBeLessThan(reviewBody.indexOf("Summary medium a.ts"));
    expect(reviewBody.indexOf("Summary medium a.ts")).toBeLessThan(reviewBody.indexOf("Summary medium z.ts"));

    // refreshReviewHealth preserves the summary-only order and note.
    refreshReviewHealth(result);
    const refreshedBody = result.postingPlan?.reviewBody ?? "";
    expect(refreshedBody).toContain(`**Summary-only findings:**\n${FINDING_ORDER_NOTE}`);
    expect(refreshedBody.indexOf("Summary high z.ts")).toBeLessThan(refreshedBody.indexOf("Summary medium a.ts"));

    // Single summary-only finding omits the ordering note.
    const singleSummaryResult = await dedupeRankAndComposeReview(
      { verified: [summaryMedA], verdicts: [] },
      fakePlan(),
      fakeResolved(),
      fakeCoverage(),
      defaultConfig,
      nullTelemetry(),
      {
        runner: passthroughComposerRunner([summaryMedA]),
        promptBuilder: fakePromptBuilder(),
        diff,
        postGithubComments: true
      }
    );
    expect(singleSummaryResult.postingPlan?.reviewBody).toContain("**Summary-only findings:**");
    expect(singleSummaryResult.postingPlan?.reviewBody).not.toContain(FINDING_ORDER_NOTE);
  });

  it("renders FINDING_ORDER_NOTE in markdown only for sections with two or more findings", () => {
    const highZ = finalFinding({ id: "h-z", title: "High Z", severity: "high", path: "src/z.ts", line: 4 });
    const medA = finalFinding({ id: "m-a", title: "Medium A", severity: "medium", path: "src/a.ts", line: 2 });
    const sumOnly = finalFinding({ id: "s-1", title: "Solo Summary", severity: "medium", path: "src/a.ts", line: 5, publication: "summary-only" });
    const sumOnly2 = finalFinding({ id: "s-2", title: "Second Summary", severity: "low", path: "src/b.ts", line: 1, publication: "summary-only" });

    const twoInlineOneSummary = renderMarkdownReview(reviewResult([highZ, medA], [sumOnly]));
    expect(twoInlineOneSummary).toContain(`## ⚠️ Findings\n\n${FINDING_ORDER_NOTE}\n\n### 🟠 High: High Z`);
    expect(twoInlineOneSummary.indexOf("### 🟠 High: High Z")).toBeLessThan(twoInlineOneSummary.indexOf("### 🔵 Medium: Medium A"));
    expect(twoInlineOneSummary).toContain("## Summary-Only Findings\n\n### 🔵 Medium: Solo Summary");
    expect(twoInlineOneSummary.split(FINDING_ORDER_NOTE)).toHaveLength(2);

    const oneInlineTwoSummary = renderMarkdownReview(reviewResult([highZ], [sumOnly, sumOnly2]));
    expect(oneInlineTwoSummary).toContain("## ⚠️ Findings\n\n### 🟠 High: High Z");
    expect(oneInlineTwoSummary).toContain(`## Summary-Only Findings\n\n${FINDING_ORDER_NOTE}\n\n### 🔵 Medium: Solo Summary`);
    expect(oneInlineTwoSummary.split(FINDING_ORDER_NOTE)).toHaveLength(2);
  });

  it("includes FINDING_ORDER_NOTE for demoted GitHub body findings only when two or more are demoted", async () => {
    const diff = parseDiff(MULTI_FILE_DIFF);
    const aHunk = diff.files.find((file) => file.path === "src/a.ts")!.hunks[0]!;
    const zHunk = diff.files.find((file) => file.path === "src/z.ts")!.hunks[0]!;

    const first = finalFinding({
      id: "d-high",
      title: "High demoted",
      severity: "high",
      confidence: "low",
      path: "src/z.ts",
      line: 2,
      hunkId: zHunk.id,
      fingerprint: "a".repeat(64)
    });
    const second = finalFinding({
      id: "d-med",
      title: "Medium demoted",
      severity: "medium",
      confidence: "low",
      path: "src/a.ts",
      line: 1,
      hunkId: aHunk.id,
      fingerprint: "b".repeat(64)
    });

    const singleBodies: string[] = [];
    await maybePublishToGitHub(reviewResult([first], []), githubResolved(MULTI_FILE_DIFF), defaultConfig, nullTelemetry(), {
      github: fakeGithub({ createReview: async (_n, review) => { singleBodies.push(review.body); } }),
      diff
    });
    expect(singleBodies[0]).toContain("**Inline findings included in the review body:**");
    expect(singleBodies[0]).not.toContain(FINDING_ORDER_NOTE);

    const multiBodies: string[] = [];
    await maybePublishToGitHub(reviewResult([first, second], []), githubResolved(MULTI_FILE_DIFF), defaultConfig, nullTelemetry(), {
      github: fakeGithub({ createReview: async (_n, review) => { multiBodies.push(review.body); } }),
      diff
    });
    expect(multiBodies[0]).toContain(`**Inline findings included in the review body:**\n${FINDING_ORDER_NOTE}`);
    expect(multiBodies[0]!.indexOf("High demoted")).toBeLessThan(multiBodies[0]!.indexOf("Medium demoted"));

    // 422 recovery demoting two inline comments together also includes the note and preserves order.
    const validFirst = { ...first, confidence: "high" as const };
    const validSecond = { ...second, confidence: "high" as const };
    let calls = 0;
    const retryBodies: string[] = [];
    await maybePublishToGitHub(reviewResult([validFirst, validSecond], []), githubResolved(MULTI_FILE_DIFF), defaultConfig, nullTelemetry(), {
      github: fakeGithub({
        createReview: async (_n, review) => {
          calls += 1;
          if (calls === 1) {
            throw new CodegenieError("github_post_failed", "422", {
              context: { httpStatus: 422, responseBody: JSON.stringify({ errors: [{ index: 0 }, { index: 1 }] }) }
            });
          }
          retryBodies.push(review.body);
        }
      }),
      diff
    });
    expect(retryBodies[0]).toContain(`**Inline findings included in the review body:**\n${FINDING_ORDER_NOTE}`);
    expect(retryBodies[0]!.indexOf("High demoted")).toBeLessThan(retryBodies[0]!.indexOf("Medium demoted"));
  });
});

function anchor(path: string, line: number) {
  return { path, line, side: "RIGHT" as const, hunkId: `h-${path}` };
}

function candidate(overrides: Partial<CandidateFinding> & { id: string; title: string; path: string; failureMode: string }): CandidateFinding {
  const { anchor: anchorValue, ...rest } = overrides;
  const hasAnchorOverride = "anchor" in overrides;
  return {
    severity: "medium",
    confidence: "high",
    changedLine: anchorValue !== undefined,
    category: "correctness",
    evidence: { changedCode: `+const ${overrides.id} = true;` },
    whyThisMatters: "Breaks caller expectations under valid input.",
    verification: "Confirmed directly from the changed code path.",
    producedBy: { kind: "packet", stage: 7, packetId: "p1", lensId: "core/code-review", skillIds: [] },
    ...rest,
    ...(hasAnchorOverride ? (anchorValue !== undefined ? { anchor: anchorValue } : {}) : {})
  };
}

function finalFinding(overrides: {
  id: string;
  title: string;
  severity: FinalFinding["severity"];
  confidence?: FinalFinding["confidence"];
  path: string;
  line: number;
  hunkId?: string;
  publication?: FinalFinding["publication"];
  fingerprint?: string;
}): FinalFinding {
  return {
    id: overrides.id,
    title: overrides.title,
    severity: overrides.severity,
    confidence: overrides.confidence ?? "high",
    path: overrides.path,
    anchor: { path: overrides.path, line: overrides.line, side: "RIGHT", hunkId: overrides.hunkId ?? "h1" },
    changedLine: true,
    category: "correctness",
    evidence: { changedCode: "+export const x = 1;" },
    failureMode: `${overrides.title} failure mode.`,
    whyThisMatters: "Affects runtime behavior.",
    verification: "Observed directly in the diff.",
    producedBy: { kind: "packet", stage: 7, packetId: "p1", lensId: "core/code-review", skillIds: [] },
    fingerprint: overrides.fingerprint ?? overrides.id.padEnd(64, "0"),
    finalBody: `${overrides.title} body.`,
    publication: overrides.publication ?? "inline",
    mergedCandidateIds: [overrides.id]
  };
}

function passthroughComposerRunner(findings: CandidateFinding[]): LlmRunner {
  return {
    runStructured: async <T>() => ({
      summary: `Found ${findings.length} verified issues.`,
      composedFindings: findings.map((finding) => ({
        findingIds: [finding.id],
        finalBody: finding.failureMode,
        publication: finding.anchor ? "inline" : "summary-only"
      }))
    }) as T
  };
}

function fakePromptBuilder() {
  const registry: LensRegistry = {
    allLenses: () => [],
    enabledLenses: () => [],
    lens: () => undefined,
    skillsForLens: () => [],
    skillsById: () => [],
    registryHash: () => "fake-registry"
  };
  return createPromptBuilder(registry);
}

function fakePlan(): ReviewPlan {
  return {
    diffUnderstanding: {
      declaredIntent: "Update a.ts and z.ts",
      inferredBehavior: "Changes values in a.ts and z.ts"
    },
    coverage: []
  };
}

function fakeCoverage(): RunCoverageStatus {
  return {
    totalHunks: 2,
    reviewedHunks: 2,
    skippedHunks: 0,
    failedHunks: 0,
    coverageByLevel: { deep: 0, normal: 2, light: 0, skip: 0 },
    degradedPlanning: false,
    budgetStopped: false,
    verificationIncompleteCount: 0,
    partial: false,
    reasons: []
  };
}

function fakeResolved() {
  return {
    mode: "branch" as const,
    repoRoot: "/repo",
    baseRef: "b".repeat(40),
    headRef: "h".repeat(40),
    mergeBase: "m".repeat(40),
    headSha: "h".repeat(40),
    commits: [],
    rawDiff: MULTI_FILE_DIFF
  };
}

function pr(): PullRequestMetadata {
  return {
    owner: "0xPolygon",
    repo: "codegenie",
    number: 1,
    title: "PR",
    body: "",
    url: "https://github.com/0xPolygon/codegenie/pull/1",
    baseRefName: "master",
    baseSha: "b".repeat(40),
    headRefName: "feature",
    headSha: "h".repeat(40)
  };
}

function githubResolved(rawDiff: string) {
  return {
    ...fakeResolved(),
    mode: "github_pr" as const,
    pr: pr(),
    rawDiff
  };
}

function reviewResult(findings: FinalFinding[], summaryOnlyFindings: FinalFinding[]): ReviewResult {
  return {
    summary: "Found issues.",
    coverage: fakeCoverage(),
    findings,
    summaryOnlyFindings,
    needsHumanAttention: [],
    noFindings: findings.length === 0 && summaryOnlyFindings.length === 0,
    postingPlan: {
      inline: findings.flatMap((finding) => finding.anchor ? [{ findingId: finding.id, anchor: finding.anchor }] : []),
      reviewBody: "Found issues."
    }
  };
}

function fakeGithub(opts: { createReview?: GitHubClient["createReview"] } = {}): GitHubClient {
  return {
    viewPr: async () => pr(),
    listOwnComments: async () => [],
    createReview: opts.createReview ?? (async () => undefined)
  };
}
