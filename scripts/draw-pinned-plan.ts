#!/usr/bin/env tsx
// Plan 103 (experiment-only): write a PinnedPlanArtifact. Internal script, not
// a CLI verb — the pinned-plan seam is eval-only and adding a user-facing
// command would contradict that scope.
//
// Two modes:
//
//   --from-run <runDir>   wrap the REAL planner draw recorded by an existing
//                         run, so an A/B can replay one Stage-5 output across
//                         both arms. This is what you want for a production
//                         A/B: it preserves the planner's per-hunk deep/normal/
//                         light grading exactly as it was drawn.
//
//   (default)             author a UNIFORM plan - every hunk gets the same
//                         coverage and lenses. Built for the dilution fixture,
//                         where making packet size the only variable was the
//                         point. Not representative of production grading.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseDiff } from "../src/git/diff-parser.js";
import { createGitClient } from "../src/git/git-client.js";
import { buildPinnedPlanArtifact } from "../src/pipeline/pinned-plan.js";
import type { CoverageLevel, ReviewPlan } from "../src/types.js";

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const repo = arg("repo");
const base = arg("base", "main") ?? "main";
const head = arg("head", "feature") ?? "feature";
const output = arg("output");
const coverage = (arg("coverage", "normal") ?? "normal") as Exclude<CoverageLevel, "skip">;
const lenses = (arg("lenses", "lang/go") ?? "lang/go").split(",");
const anchor = arg("anchor", "content") ?? "content";

if (repo === undefined || output === undefined) {
  console.error("usage: draw-pinned-plan.ts --repo <path> [--base ref] [--head ref] [--coverage level] [--lenses a,b] --output <file>");
  process.exit(2);
}

const fromRun = arg("from-run");
const git = createGitClient(repo);
const rawDiff = await git.diff(base, head);
const diff = parseDiff(rawDiff);
const diffHunkIds = new Set(diff.files.flatMap((file) => file.hunks.map((hunk) => hunk.id)));

const recordedPlan: ReviewPlan | undefined = fromRun === undefined
  ? undefined
  : JSON.parse(readFileSync(path.join(fromRun, "stages/05-planner/review-plan.json"), "utf8")) as ReviewPlan;

if (recordedPlan !== undefined) {
  const stale = recordedPlan.coverage.filter((entry) => !diffHunkIds.has(entry.hunkId)).map((entry) => entry.hunkId);
  if (stale.length > 0) {
    console.error(`recorded plan references ${String(stale.length)} hunk id(s) absent from this diff: ${stale.slice(0, 5).join(", ")}`);
    console.error("the run's diff and this base/head do not match; re-draw against the same refs");
    process.exit(1);
  }
}

const authored: ReviewPlan = {
  diffUnderstanding: {
    declaredIntent: "authored pinned plan for the packet-size recall curve",
    inferredBehavior: "uniform coverage so packet size is the only variable across arms"
  },
  coverage: diff.files.flatMap((file) =>
    file.hunks.map((hunk) => ({
      hunkId: hunk.id,
      path: file.path,
      coverage,
      lenses: [...lenses],
      surroundingContextHints: [],
      reason: "authored uniform coverage"
    }))
  )
};

const plan = recordedPlan ?? authored;

// "*" marks a content-anchored artifact: fixture repos are materialized fresh
// per run so their SHAs vary, while content-derived hunk IDs do not.
const artifact = buildPinnedPlanArtifact({
  baseSha: anchor === "content" ? "*" : await git.revParse(base),
  headSha: anchor === "content" ? "*" : await git.revParse(head),
  plan
});
writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
const byCoverage: Record<string, number> = {};
for (const entry of plan.coverage) {
  byCoverage[entry.coverage] = (byCoverage[entry.coverage] ?? 0) + 1;
}
console.log(JSON.stringify({
  output,
  source: recordedPlan !== undefined ? `recorded draw: ${String(fromRun)}` : "authored uniform plan",
  coverageEntries: plan.coverage.length,
  diffHunks: diffHunkIds.size,
  byCoverage,
  planSha256: artifact.planSha256,
  anchor
}, null, 1));
