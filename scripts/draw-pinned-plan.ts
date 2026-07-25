#!/usr/bin/env tsx
// Plan 103 (experiment-only): write a PinnedPlanArtifact. Internal script, not
// a CLI verb — the pinned-plan seam is eval-only and adding a user-facing
// command would contradict that scope.
//
//   --repo <path> --base <ref> --head <ref> --output <file>            authored/derived from the diff
//   --repo <path> ... --coverage normal --lenses lang/go              author a uniform plan (no model call)
import { writeFileSync } from "node:fs";
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

const git = createGitClient(repo);
const rawDiff = await git.diff(base, head);
const diff = parseDiff(rawDiff);
const plan: ReviewPlan = {
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

// "*" marks a content-anchored artifact: fixture repos are materialized fresh
// per run so their SHAs vary, while content-derived hunk IDs do not.
const artifact = buildPinnedPlanArtifact({
  baseSha: anchor === "content" ? "*" : await git.revParse(base),
  headSha: anchor === "content" ? "*" : await git.revParse(head),
  plan
});
writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({ output, hunks: plan.coverage.length, planSha256: artifact.planSha256, anchor }, null, 1));
