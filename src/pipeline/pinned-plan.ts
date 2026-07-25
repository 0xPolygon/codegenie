// Plan 103 (experiment-only, removed at teardown): an eval-only seam that
// replays one recorded Stage-5 plan across several arms so packet size is the
// only difference between them.
//
// ReviewPlan carries no base/head identity and no self-describing hash, so a
// bare plan file cannot prove it belongs to the diff under review. The pinned
// artifact is an explicit versioned wrapper that can.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { sha256Hex } from "../util/hashing.js";
import { CodegenieError } from "../util/errors.js";
import type { ReviewPlan, UnifiedDiff } from "../types.js";

export const PINNED_PLAN_SCHEMA_VERSION = 1;

const pinnedPlanArtifactSchema = z
  .object({
    schemaVersion: z.literal(PINNED_PLAN_SCHEMA_VERSION),
    baseSha: z.string().min(1),
    headSha: z.string().min(1),
    planSha256: z.string().length(64),
    plan: z.looseObject({ coverage: z.array(z.looseObject({ hunkId: z.string().min(1) })) })
  })
  .strict();

export type PinnedPlanArtifact = {
  schemaVersion: typeof PINNED_PLAN_SCHEMA_VERSION;
  baseSha: string;
  headSha: string;
  planSha256: string;
  plan: ReviewPlan;
};

// Canonical form: keys sorted recursively, no whitespace, over `plan` alone —
// so the hash is independent of field order and of the wrapper's own fields.
export function canonicalPlanJson(plan: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(canonical);
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)])
      );
    }
    return value;
  };
  return JSON.stringify(canonical(plan));
}

export function planSha256(plan: unknown): string {
  return sha256Hex(canonicalPlanJson(plan));
}

export function buildPinnedPlanArtifact(input: { baseSha: string; headSha: string; plan: ReviewPlan }): PinnedPlanArtifact {
  return {
    schemaVersion: PINNED_PLAN_SCHEMA_VERSION,
    baseSha: input.baseSha,
    headSha: input.headSha,
    planSha256: planSha256(input.plan),
    plan: input.plan
  };
}

function reject(reason: string, context: Record<string, unknown>): never {
  throw new CodegenieError("config_error", `pinned plan rejected: ${reason}`, { context });
}

// Fails closed on every mismatch. A hash match over a plan that no longer
// parses, or that targets a different diff, is not sufficient.
export function loadPinnedPlan(
  filePath: string,
  expected: { baseSha?: string; headSha?: string; diff?: UnifiedDiff }
): ReviewPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (cause) {
    reject("artifact is not readable JSON", { path: filePath, cause: cause instanceof Error ? cause.message : "unknown" });
  }

  const parsed = pinnedPlanArtifactSchema.safeParse(raw);
  if (!parsed.success) {
    reject("artifact does not match the pinned plan schema", { path: filePath, issues: parsed.error.issues.length });
  }
  const artifact = parsed.data as unknown as PinnedPlanArtifact;

  const recomputed = planSha256(artifact.plan);
  if (recomputed !== artifact.planSha256) {
    reject("planSha256 does not match the canonical hash of the plan", { path: filePath, recorded: artifact.planSha256, recomputed });
  }
  // Fixture-backed eval repos are materialized fresh per run, so their commit
  // SHAs vary while content-derived hunk IDs do not. "*" records that the
  // artifact is content-anchored rather than ref-anchored; hash, schema, and
  // hunk-membership validation still apply in full.
  if (artifact.baseSha !== "*" && expected.baseSha !== undefined && expected.baseSha !== artifact.baseSha) {
    reject("baseSha does not match the resolved review target", { recorded: artifact.baseSha, resolved: expected.baseSha });
  }
  if (artifact.headSha !== "*" && expected.headSha !== undefined && expected.headSha !== artifact.headSha) {
    reject("headSha does not match the resolved review target", { recorded: artifact.headSha, resolved: expected.headSha });
  }
  if (expected.diff !== undefined) {
    const available = new Set(expected.diff.files.flatMap((file) => file.hunks.map((hunk) => hunk.id)));
    const unknown = artifact.plan.coverage.filter((entry) => !available.has(entry.hunkId)).map((entry) => entry.hunkId);
    if (unknown.length > 0) {
      reject("plan references hunk ids absent from the current diff", { unknownHunkIds: unknown.slice(0, 5), unknownCount: unknown.length });
    }
  }
  return artifact.plan;
}
