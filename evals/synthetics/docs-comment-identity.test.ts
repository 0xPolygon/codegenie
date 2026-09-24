import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/config/schema.js";
import { parseDiff } from "../../src/git/diff-parser.js";
import { createGitHubClient } from "../../src/github/github-client.js";
import { parseCodegenieMarker } from "../../src/github/duplicate-detector.js";
import { maybePublishToGitHub } from "../../src/github/publisher.js";
import { sha256Hex } from "../../src/util/hashing.js";
import type { FinalFinding, InlineCommentInput, ResolvedReviewInput, ReviewResult } from "../../src/types.js";
import type { runGh } from "../../src/git/subprocess.js";
import { nullTelemetry } from "../../tests/helpers/git.js";

const enumAdvice = "The table lists `widgetCreated`, but `EventKind` does not define it. Use a supported event value.";
const retryAdvice = "These retry instructions can submit the same order twice. Require an idempotency key before retrying.";

// Exercise the real diff parser, publisher, marker serialization, GitHub client,
// and duplicate detector across pushes. Only the GitHub transport is scripted.
describe("synthetic: documentation comment identity across pushes", () => {
  it.each([
    { name: "unchanged finding after a seven-line shift", first: enumAdvice, second: enumAdvice, line: 74, expected: 0 },
    { name: "same finding on a table row instead of its prose bullet", first: enumAdvice, second: enumAdvice, line: 40, expected: 0 },
    { name: "unchanged finding using its validated posting-plan anchor", first: enumAdvice, second: enumAdvice, line: 74, expected: 0, plannedAnchor: true },
    { name: "unrelated finding far away in the same document", first: enumAdvice, second: retryAdvice, line: 180, expected: 1 },
    { name: "unrelated finding within the old five-line fuzzy window", first: enumAdvice, second: retryAdvice, line: 82, expected: 1 },
    { name: "changed advice at the same location", first: enumAdvice, second: retryAdvice, line: 81, expected: 1 },
    { name: "paraphrased finding stays eligible without a proven content match", first: enumAdvice, second: "EventKind has no widgetCreated member; correct the documented event value.", line: 74, expected: 1 },
    { name: "legacy marker and an unchanged body", first: enumAdvice, second: enumAdvice, line: 74, expected: 0, legacy: true },
    { name: "legacy sanitized body with a mention", first: `${enumAdvice} Ask @maintainer.`, second: `${enumAdvice} Ask @maintainer.`, line: 74, expected: 0, legacy: true },
    { name: "same published text in a different file", first: enumAdvice, second: enumAdvice, line: 74, expected: 1, path: "docs/other.md" },
    { name: "unchanged long report despite the inline body cap", first: enumAdvice.repeat(130), second: enumAdvice.repeat(130), line: 74, expected: 0 },
    { name: "truncated legacy report cannot prove a full-content match", first: enumAdvice.repeat(130), second: enumAdvice.repeat(130), line: 74, expected: 1, legacy: true },
    { name: "different conclusions after an identical capped prefix", first: enumAdvice.repeat(130) + "\nFirst conclusion.", second: enumAdvice.repeat(130) + "\nDifferent conclusion.", line: 81, expected: 1 }
  ])("$name", async scenario => {
    const remote = scriptedGitHub();
    const first = snapshot("docs/api.md", 81, "- The event is `widgetCreated`.", scenario.first);
    const firstResult = await maybePublishToGitHub(first.review, first.resolved, defaultConfig, nullTelemetry(), { github: remote.client });
    expect(firstResult?.inlinePosted).toBe(1);
    expect(remote.comments).toHaveLength(1);
    expect(parseCodegenieMarker(remote.comments[0]!.body)?.contentFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    if (scenario.legacy) remote.comments[0]!.body = remote.comments[0]!.body.replace(/;content=[0-9a-f]{64}/u, "");
    // GitHub returns original_line for an outdated anchor after another push.
    remote.comments[0]!.line = null;
    remote.advance();
    const second = snapshot(scenario.path ?? "docs/api.md", scenario.line, "| event | `widgetCreated` |", scenario.second, "2".repeat(40));
    if (scenario.plannedAnchor) delete second.review.findings[0]!.anchor;
    const result = await maybePublishToGitHub(second.review, second.resolved, defaultConfig, nullTelemetry(), { github: remote.client });
    expect(result?.inlinePosted).toBe(scenario.expected);
    expect(result?.skippedDuplicates).toBe(1 - scenario.expected);
    expect(remote.comments).toHaveLength(1 + scenario.expected);
    expect(result?.duplicateDecisions?.[0]?.action).toBe(scenario.expected ? "post" : "skip_unchanged_content");
  });
});

function snapshot(path: string, line: number, changedText: string, body: string, headSha = "1".repeat(40)) {
  const rawDiff = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${line},1 +${line},1 @@\n-old text\n+${changedText}\n`;
  const hunk = parseDiff(rawDiff).files[0]!.hunks[0]!;
  const finding: FinalFinding = {
    id: "f1", path, title: "Documentation contradicts the supported behavior", severity: "medium", confidence: "high",
    category: "correctness", changedLine: true, anchor: { path, line, side: "RIGHT", hunkId: hunk.id },
    evidence: { changedCode: changedText }, failureMode: body, whyThisMatters: body, verification: "Checked against the source contract.",
    producedBy: { kind: "packet", stage: 7, packetId: `packet-${hunk.id}`, lensId: "core/code-review", skillIds: [] },
    fingerprint: sha256Hex([path, hunk.id, "correctness", "core/code-review"].join("\0")),
    finalBody: body, publication: "inline", mergedCandidateIds: ["f1"]
  };
  const review: ReviewResult = {
    summary: "One finding.", findings: [finding], summaryOnlyFindings: [], needsHumanAttention: [], noFindings: false,
    coverage: { totalHunks: 1, reviewedHunks: 1, skippedHunks: 0, failedHunks: 0,
      coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 }, degradedPlanning: false, budgetStopped: false,
      verificationIncompleteCount: 0, partial: false, reasons: [] },
    postingPlan: { inline: [{ findingId: finding.id, anchor: finding.anchor! }], reviewBody: "One finding." }
  };
  const resolved: ResolvedReviewInput = {
    mode: "github_pr", repoRoot: "/synthetic", commits: [], rawDiff,
    pr: { owner: "fixture", repo: "fixture", number: 1, title: "Docs update", body: "", url: "https://example.invalid/pr/1",
      baseRefName: "main", baseSha: "b".repeat(40), headRefName: "feature", headSha }
  };
  return { review, resolved };
}

function scriptedGitHub() {
  type Comment = { id: number; path: string; side: "RIGHT" | "LEFT"; line: number | null; original_line: number; body: string; user: { login: string } };
  const comments: Comment[] = [];
  let headSha = "1".repeat(40);
  const gh: typeof runGh = async (_cwd, args, opts) => {
    if (args[0] === "--version" || args.join(" ") === "auth status") return "";
    if (args[0] === "repo") return JSON.stringify({ owner: { login: "fixture" }, name: "fixture" });
    if (args[0] === "pr") return JSON.stringify({ number: 1, baseRefOid: "b".repeat(40), headRefOid: headSha });
    if (args[1] === "user") return "codegenie-bot";
    if (args[1]?.includes("/comments?")) return JSON.stringify(comments);
    if (args[1]?.endsWith("/reviews")) {
      const payload = JSON.parse(String(opts?.input)) as { comments: InlineCommentInput[] };
      for (const input of payload.comments) comments.push({ id: comments.length + 1, path: input.path, side: input.side,
        line: input.line, original_line: input.line, body: input.body, user: { login: "codegenie-bot" } });
      return "{}";
    }
    throw new Error(`Unexpected GitHub transport request: ${args.join(" ")}`);
  };
  return { comments, client: createGitHubClient("/synthetic", { runGh: gh }), advance: () => { headSha = "2".repeat(40); } };
}
