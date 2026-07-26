import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPinnedPlanArtifact, canonicalPlanJson, loadPinnedPlan, planSha256 } from "../src/pipeline/pinned-plan.js";
import type { ReviewPlan, UnifiedDiff } from "../src/types.js";

const plan = (): ReviewPlan => ({
  diffUnderstanding: { declaredIntent: "intent", inferredBehavior: "behavior" },
  coverage: [
    { hunkId: "h1", path: "app.go", coverage: "normal", lenses: ["lang/go"], surroundingContextHints: [], reason: "test" }
  ]
});

const diff = (hunkIds: string[]): UnifiedDiff => ({
  files: [
    {
      path: "app.go",
      status: "modified",
      language: "go",
      hunks: hunkIds.map((id) => ({
        id,
        hunkHash: id.repeat(64).slice(0, 64),
        path: "app.go",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        header: "@@",
        lines: []
      }))
    }
  ]
});

function write(artifact: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pinned-plan-"));
  const file = path.join(dir, "frozen.json");
  writeFileSync(file, JSON.stringify(artifact));
  return file;
}

describe("pinned plan artifact", () => {
  it("hashes the plan independently of key order and wrapper fields", () => {
    const a = { b: 1, a: [{ y: 2, x: 1 }] };
    const b = { a: [{ x: 1, y: 2 }], b: 1 };
    expect(canonicalPlanJson(a)).toBe(canonicalPlanJson(b));
    expect(planSha256(a)).toBe(planSha256(b));
  });

  it("round-trips a valid artifact against its diff", () => {
    const file = write(buildPinnedPlanArtifact({ baseSha: "base1", headSha: "head1", plan: plan() }));
    const loaded = loadPinnedPlan(file, { baseSha: "base1", headSha: "head1", diff: diff(["h1"]) });
    expect(loaded.coverage[0]?.hunkId).toBe("h1");
  });

  it("fails closed on every mismatch", () => {
    const good = buildPinnedPlanArtifact({ baseSha: "base1", headSha: "head1", plan: plan() });

    expect(() => loadPinnedPlan(write({ ...good, schemaVersion: 2 }), {})).toThrow(/pinned plan schema/);
    expect(() => loadPinnedPlan(write({ ...good, extra: true }), {})).toThrow(/pinned plan schema/);
    expect(() => loadPinnedPlan(write({ ...good, plan: { nope: true } }), {})).toThrow(/pinned plan schema/);
    expect(() => loadPinnedPlan(write({ ...good, planSha256: "0".repeat(64) }), {})).toThrow(/canonical hash/);

    // A hash that matches a mutated plan is still rejected against its diff and refs.
    const mutated = buildPinnedPlanArtifact({
      baseSha: "base1",
      headSha: "head1",
      plan: { ...plan(), coverage: [{ ...plan().coverage[0]!, hunkId: "ghost" }] }
    });
    expect(() => loadPinnedPlan(write(mutated), { diff: diff(["h1"]) })).toThrow(/hunk ids absent/);

    expect(() => loadPinnedPlan(write(good), { baseSha: "other" })).toThrow(/baseSha/);
    expect(() => loadPinnedPlan(write(good), { headSha: "other" })).toThrow(/headSha/);

    const badPath = path.join(mkdtempSync(path.join(tmpdir(), "pinned-plan-")), "missing.json");
    expect(() => loadPinnedPlan(badPath, {})).toThrow(/readable JSON/);
  });
});

describe("pinned plan run artifacts", () => {
  it("keeps the artifact path map and the seam in agreement", async () => {
    // The seam writes both names; if either loses its stage mapping the run
    // stops being self-describing, which is the failure this guards.
    const runArtifacts = await import("../src/telemetry/run-artifacts.js");
    const source = readFileSync(new URL("../src/telemetry/run-artifacts.ts", import.meta.url), "utf8");
    expect(source).toContain('"review-plan.json": "stages/05-planner/review-plan.json"');
    expect(source).toContain('"pinned-plan-source.json": "stages/05-planner/pinned-plan-source.json"');
    expect(runArtifacts).toBeDefined();

    const runner = readFileSync(new URL("../src/pipeline/review-runner.ts", import.meta.url), "utf8");
    expect(runner).toContain('writeArtifact("review-plan.json", pinnedPlan)');
    expect(runner).toContain('writeArtifact("pinned-plan-source.json"');
  });
});
