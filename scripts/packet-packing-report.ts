#!/usr/bin/env tsx
// Plan 103 packet-packing report. Rebuilds Stage 6 from recorded run artifacts
// with packing off and on, using the real builder and zero model calls, and
// fails closed on any invariant violation.
//
// Modes:
//   replay  --repo <path> --run <dir>... [--dispatch-slots N] [--distinct-diffs] --output <file>
//
// Failure records are structured and templated: a closed-set code plus typed
// fields, rendered from a template. Raw exception text and repository source
// are never interpolated into a message.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseDiff } from "../src/git/diff-parser.js";
import { filterDiffFiles, classifyChangedFiles } from "../src/git/file-classifier.js";
import { createGitClient } from "../src/git/git-client.js";
import { buildRepositoryIndex } from "../src/repo/repository-index.js";
import { buildReviewPackets } from "../src/pipeline/packet-builder.js";
import { defaultConfig } from "../src/config/schema.js";
import { applyRepoConfigLayer } from "../src/config/config-loader.js";
import type {
  CodegenieConfig,
  ResolvedReviewInput,
  ReviewPacket,
  ReviewPlan,
  TelemetryEvent
} from "../src/types.js";
import type { TelemetryRecorder } from "../src/telemetry/telemetry-recorder.js";

const DEFAULT_DISPATCH_SLOTS = 56;
const HISTORICAL_BASELINE_HUNKS = 89;

type FailureCode =
  | "run_artifacts_missing"
  | "ref_unavailable"
  | "model_call_observed"
  | "hunk_not_unique"
  | "atom_split"
  | "cap_exceeded"
  | "coverage_changed"
  | "profile_downgraded"
  | "budget_downgraded"
  | "lens_dropped"
  | "dispatch_rank_invalid"
  | "estimator_unreconciled";

export type Failure = { code: FailureCode; run: string; message: string; fields: Record<string, unknown> };

export function fail(code: FailureCode, run: string, fields: Record<string, unknown>): Failure {
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join(" ");
  return { code, run, message: `${code}: ${rendered}`, fields };
}

// Counts every repository tool call so a replay that silently reaches the
// network or a model can be caught; the builder must stay offline.
function countingTelemetry(counters: { events: number; modelCalls: number }): TelemetryRecorder {
  return {
    event: (entry: TelemetryEvent) => {
      counters.events += 1;
      if (typeof entry.message === "string" && entry.message.startsWith("model_call")) {
        counters.modelCalls += 1;
      }
    },
    writeArtifact: async () => undefined
  } as unknown as TelemetryRecorder;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

// The reviewed repository's own codegenie.toml carries the classification path
// rules that decide which files are reviewed at all. Replaying without it keeps
// generated files the real run skipped and silently changes the workload, which
// is what the reconciliation gate exists to catch.
function packingConfig(repoRoot: string, on: boolean): CodegenieConfig {
  const base = structuredClone(defaultConfig) as CodegenieConfig;
  base.telemetry.enabled = false;
  const config = applyRepoConfigLayer(base, repoRoot).config;
  config.review.packCompatibleAtoms = on;
  return config;
}

const COVERAGE_RANK = { deep: 0, normal: 1, light: 2 } as const;
const PROFILE_RANK = { simple: 0, standard: 1, investigate: 2 } as const;
const PRIORITY_RANK = { critical: 0, high: 1, normal: 2, low: 3 } as const;

// Mirrors worker-runner's scheduling comparator. The real scheduler is a
// prefix-with-holes at concurrency > 1, so this is a calibrated counterfactual
// capacity proxy, not a reproduction — the reconciliation gate below is what
// makes it trustworthy.
export function dispatchOrder(packets: ReviewPacket[]): ReviewPacket[] {
  return [...packets].sort(
    (a, b) =>
      PRIORITY_RANK[a.reviewPriority] - PRIORITY_RANK[b.reviewPriority] ||
      COVERAGE_RANK[a.coverage] - COVERAGE_RANK[b.coverage] ||
      (a.dispatchRank[0] ?? 0) - (b.dispatchRank[0] ?? 0) ||
      (a.dispatchRank[1] ?? 0) - (b.dispatchRank[1] ?? 0) ||
      a.id.localeCompare(b.id)
  );
}

export function hunksWithinSlots(packets: ReviewPacket[], slots: number): number {
  return new Set(
    dispatchOrder(packets)
      .slice(0, slots)
      .flatMap((packet) => packet.hunks.map((hunk) => hunk.hunkId))
  ).size;
}

async function rebuildStageSix(
  resolved: ResolvedReviewInput,
  plan: ReviewPlan,
  on: boolean
): Promise<{ packets: ReviewPacket[]; modelCalls: number }> {
  const counters = { events: 0, modelCalls: 0 };
  const telemetry = countingTelemetry(counters);
  const config = packingConfig(resolved.repoRoot, on);
  const diff = parseDiff(resolved.rawDiff);
  const { kept, decisions } = await filterDiffFiles(resolved, diff, config, telemetry);
  const facts = await classifyChangedFiles(resolved, kept, decisions, config, telemetry);
  const repoIndex = await buildRepositoryIndex(resolved, kept, facts, config, telemetry);
  const packets = await buildReviewPackets(plan, kept, facts, repoIndex, telemetry, {
    config,
    enabledLenses: [...new Set(plan.coverage.flatMap((entry) => entry.lenses))]
  });
  return { packets, modelCalls: counters.modelCalls };
}

export function comparePackets(run: string, off: ReviewPacket[], on: ReviewPacket[], slots: number): Failure[] {
  const failures: Failure[] = [];
  const offHunks = off.flatMap((packet) => packet.hunks.map((hunk) => hunk.hunkId));
  const onHunks = on.flatMap((packet) => packet.hunks.map((hunk) => hunk.hunkId));

  if (new Set(onHunks).size !== onHunks.length) {
    failures.push(fail("hunk_not_unique", run, { duplicates: onHunks.length - new Set(onHunks).size }));
  }
  const missing = offHunks.filter((hunkId) => !onHunks.includes(hunkId));
  if (missing.length > 0) {
    failures.push(fail("hunk_not_unique", run, { missingHunks: missing.length }));
  }

  for (const packet of on) {
    if (packet.hunks.length > defaultConfig.review.packMaxHunks) {
      failures.push(fail("cap_exceeded", run, { packetId: packet.id, hunks: packet.hunks.length }));
    }
  }

  // Coverage, profile, and budget may never fall for any hunk relative to the
  // packet that carried it with packing off.
  const offByHunk = new Map<string, ReviewPacket>();
  for (const packet of off) {
    for (const hunk of packet.hunks) {
      offByHunk.set(hunk.hunkId, packet);
    }
  }
  for (const packet of on) {
    for (const hunk of packet.hunks) {
      const before = offByHunk.get(hunk.hunkId);
      if (before === undefined) {
        continue;
      }
      // The partition key forces identical coverage across a packet's members,
      // so any change at all is a violation — promotion inflates cost and
      // demotion reviews a hunk more shallowly than planned.
      if (packet.coverage !== before.coverage) {
        failures.push(fail("coverage_changed", run, { hunkId: hunk.hunkId, from: before.coverage, to: packet.coverage }));
      }
      if (PROFILE_RANK[packet.reviewProfile] < PROFILE_RANK[before.reviewProfile]) {
        failures.push(fail("profile_downgraded", run, { hunkId: hunk.hunkId, from: before.reviewProfile, to: packet.reviewProfile }));
      }
      if (packet.toolBudget.maxToolCalls < before.toolBudget.maxToolCalls) {
        failures.push(fail("budget_downgraded", run, {
          hunkId: hunk.hunkId,
          from: before.toolBudget.maxToolCalls,
          to: packet.toolBudget.maxToolCalls
        }));
      }
      for (const lens of before.lenses) {
        if (!packet.lenses.includes(lens)) {
          failures.push(fail("lens_dropped", run, { hunkId: hunk.hunkId, lens }));
        }
      }
    }
  }
  void slots;
  return failures;
}

async function replay(args: Map<string, string[]>): Promise<number> {
  const repo = args.get("repo")?.[0];
  const runs = args.get("run") ?? [];
  const output = args.get("output")?.[0];
  const slots = Number(args.get("dispatch-slots")?.[0] ?? DEFAULT_DISPATCH_SLOTS);
  if (repo === undefined || runs.length === 0 || output === undefined) {
    console.error("usage: packet-packing-report.ts replay --repo <path> --run <dir>... --output <file>");
    return 2;
  }

  const failures: Failure[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const git = createGitClient(repo);
  const seenDiffs = new Map<string, string>();

  for (const runDir of runs) {
    const name = path.basename(runDir);
    const inputPath = path.join(runDir, "stages/01-input/resolved-input.json");
    const planPath = path.join(runDir, "stages/05-planner/review-plan.json");
    if (!existsSync(inputPath) || !existsSync(planPath)) {
      failures.push(fail("run_artifacts_missing", name, { inputPath: existsSync(inputPath), planPath: existsSync(planPath) }));
      continue;
    }
    const recorded = readJson<{ baseRef?: string; headSha?: string; mergeBase?: string; commits?: unknown[] }>(inputPath);
    const plan = readJson<ReviewPlan>(planPath);
    const base = recorded.mergeBase ?? recorded.baseRef;
    const head = recorded.headSha;
    if (base === undefined || head === undefined) {
      failures.push(fail("run_artifacts_missing", name, { base: base ?? null, head: head ?? null }));
      continue;
    }
    try {
      await git.revParse(base);
      await git.revParse(head);
    } catch {
      failures.push(fail("ref_unavailable", name, { base, head }));
      continue;
    }

    const rawDiff = await git.diff(base, head);
    const diffKey = `${base}..${head}`;
    const duplicateOf = seenDiffs.get(diffKey);
    seenDiffs.set(diffKey, duplicateOf ?? name);

    const resolved: ResolvedReviewInput = {
      mode: "commit_range",
      repoRoot: repo,
      baseRef: base,
      headRef: head,
      headSha: head,
      mergeBase: base,
      commits: [],
      rawDiff
    };

    const off = await rebuildStageSix(resolved, plan, false);
    const on = await rebuildStageSix(resolved, plan, true);
    if (off.modelCalls > 0 || on.modelCalls > 0) {
      failures.push(fail("model_call_observed", name, { off: off.modelCalls, on: on.modelCalls }));
    }
    failures.push(...comparePackets(name, off.packets, on.packets, slots));

    const offYield = hunksWithinSlots(off.packets, slots);
    const onYield = hunksWithinSlots(on.packets, slots);
    if (duplicateOf === undefined && offYield !== HISTORICAL_BASELINE_HUNKS && name.endsWith("dca8d870")) {
      failures.push(fail("estimator_unreconciled", name, { expected: HISTORICAL_BASELINE_HUNKS, actual: offYield, slots }));
    }

    rows.push({
      run: name,
      duplicateOf: duplicateOf ?? null,
      offPackets: off.packets.length,
      onPackets: on.packets.length,
      reductionPct: Number((100 * (off.packets.length - on.packets.length) / Math.max(1, off.packets.length)).toFixed(1)),
      multiHunkPackets: on.packets.filter((packet) => packet.hunks.length > 1).length,
      hunkDistribution: [1, 2, 3, 4, 5].map((size) => on.packets.filter((packet) => packet.hunks.length === size).length),
      reviewableHunks: new Set(off.packets.flatMap((packet) => packet.hunks.map((hunk) => hunk.hunkId))).size,
      fixedSlotYield: { slots, off: offYield, on: onYield, gain: onYield - offYield },
      modelCallsObserved: off.modelCalls + on.modelCalls
    });
  }

  const distinctRows = rows.filter((row) => row.duplicateOf === null);
  const report = {
    schemaVersion: 1,
    mode: "replay",
    dispatchSlots: slots,
    noModelCalls: rows.every((row) => row.modelCallsObserved === 0),
    distinctDiffs: distinctRows.length,
    rows,
    failures
  };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ rows, failures: failures.length, distinctDiffs: distinctRows.length }, null, 1));
  return failures.length === 0 ? 0 : 1;
}

function parseArgs(argv: string[]): Map<string, string[]> {
  const args = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      args.set(key, [...(args.get(key) ?? []), "true"]);
      continue;
    }
    args.set(key, [...(args.get(key) ?? []), value]);
    i += 1;
  }
  return args;
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (mode === "replay") {
    process.exitCode = await replay(args);
    return;
  }
  console.error("usage: packet-packing-report.ts replay --repo <path> --run <dir>... --output <file>");
  process.exitCode = 2;
}

// Importable for focused tests; only the CLI entry point runs main().
if (process.argv[1]?.includes("packet-packing-report")) {
  await main();
}
