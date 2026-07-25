#!/usr/bin/env node
// Packing diagnostics over recorded run artifacts (Plan 103 planning aid).
//
// Answers three questions about same-file packet packing without running a
// review or calling a model:
//
//   pairs     which atoms are related but currently split, and what blocks them
//   sweep     how packet count responds to the hunk/patch caps
//   simulate  packet count under a chosen packing predicate
//
// APPROXIMATIONS — this is a planning aid, not the authoritative measurement.
// Plan 103 step 8 specifies a real-builder replay; that is what gates the work.
// This tool differs in three known ways:
//
//   1. Patch size uses each packet hunk's recorded `contentWithLineNumbers`
//      length. The builder uses combinedPatchChars() over raw diff lines.
//      Plan 102 documented the two differing by about one packet per run.
//   2. Container identity is recovered by splitting the owner prefix out of
//      the recorded `enclosingSymbol` display string ("(*T).Method" -> "T").
//      Plan 103 specifies a structural ownerKey resolved from symbol ranges,
//      which does not collide across duplicate or nested same-named owners.
//   3. Planner lens signatures are only known for hunks the planner issued a
//      coverage entry for. Undeclared hunks fall back to
//      defaultLensesForLanguage(), which is constant within a file, so they
//      share a synthetic DEFAULT signature. That is sound within a file and
//      wrong across files — this tool never compares across files.
//
// Calibration: `sweep` at 5h/12K reproduces Plan 102's measured packet counts
// (75/68/85) within one packet on all three distinct retained diffs.
//
// Usage:
//   node scripts/packing-diagnostics.mjs pairs    <runDir...>
//   node scripts/packing-diagnostics.mjs sweep    <runDir...>
//   node scripts/packing-diagnostics.mjs simulate <runDir...> [--predicate source|compatibility|related] [--max-hunks N] [--max-patch N]
//
// A runDir is a recorded telemetry run, e.g.
//   <repo>/.codegenie/runs/20260724-184952-dca8d870

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_MAX_HUNKS = 5;
const DEFAULT_MAX_PATCH = 12_000;
const SWEEP_GRID = [[5, 12_000], [6, 12_000], [8, 12_000], [8, 16_000], [10, 16_000], [10, 20_000], [12, 24_000]];

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// "(*FeeCalculator).CalculateIntentFees" -> "FeeCalculator"; "Foo.bar" -> "Foo".
function ownerPrefix(symbol) {
  const dot = symbol.lastIndexOf(".");
  if (dot <= 0) {
    return undefined;
  }
  const owner = symbol.slice(0, dot).replace(/^\(\*?|\)$/gu, "").trim();
  return owner.length > 0 ? owner : undefined;
}

// Baseline runs did no packing, so each recorded packet is exactly one atom.
function loadRun(runDir) {
  const plan = readJson(path.join(runDir, "stages/05-planner/review-plan.json"));
  const graph = readJson(path.join(runDir, "stages/06-packets/hunk-relationships.json"));
  const coverageByHunk = new Map((plan.coverage ?? []).map((entry) => [entry.hunkId, entry.coverage]));
  const lensesByHunk = new Map((plan.coverage ?? []).map((entry) => [entry.hunkId, [...(entry.lenses ?? [])].sort().join(",")]));

  const atoms = [];
  const atomByHunk = new Map();
  const packetsDir = path.join(runDir, "stages/06-packets/packets");
  for (const file of readdirSync(packetsDir)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const packet = readJson(path.join(packetsDir, file));
    const hunks = packet.hunks ?? [];
    if (hunks.length === 0) {
      continue;
    }
    const owners = new Set();
    for (const hunk of hunks) {
      const fact = (packet.symbolFacts ?? []).find((entry) => entry.hunkId === hunk.hunkId && entry.enclosingSymbol);
      const owner = fact ? ownerPrefix(fact.enclosingSymbol) : undefined;
      if (owner !== undefined) {
        owners.add(owner);
      }
    }
    const atom = {
      id: packet.id,
      path: packet.path,
      kind: packet.kind,
      coverage: packet.coverage,
      owners,
      hunkIds: hunks.map((hunk) => hunk.hunkId),
      hunkCount: hunks.length,
      patchChars: hunks.reduce((sum, hunk) => sum + (hunk.contentWithLineNumbers ?? "").length, 0),
      sourcePos: Math.min(...hunks.map((hunk) => hunk.newStart ?? hunk.oldStart ?? 0)),
      lensSignature: [...new Set(hunks.map((hunk) => lensesByHunk.get(hunk.hunkId) ?? "DEFAULT"))].sort().join("|")
    };
    atoms.push(atom);
    for (const hunkId of atom.hunkIds) {
      atomByHunk.set(hunkId, atom.id);
    }
  }

  return {
    name: path.basename(runDir),
    atoms,
    atomByHunk,
    graph,
    plannerEntries: (plan.coverage ?? []).length,
    effectiveCoverage: (hunkId) => coverageByHunk.get(hunkId) ?? "normal"
  };
}

// Packing-affinity adjacency between atoms: strong recorded edges plus shared
// container. Mirrors Plan 103's derived/structural split.
function affinity(run) {
  const byId = new Map(run.atoms.map((atom) => [atom.id, atom]));
  const adjacency = new Map(run.atoms.map((atom) => [atom.id, new Set()]));
  const pairSources = new Map();
  const pairKey = (a, b) => [a, b].sort().join("|");

  const link = (a, b, source) => {
    if (a === b) {
      return;
    }
    adjacency.get(a)?.add(b);
    adjacency.get(b)?.add(a);
    const key = pairKey(a, b);
    const sources = pairSources.get(key) ?? new Set();
    sources.add(source);
    pairSources.set(key, sources);
  };

  for (const edge of run.graph.edges ?? []) {
    if (edge.strength !== "strong" || !edge.toHunkId) {
      continue;
    }
    const from = run.atomByHunk.get(edge.fromHunkId);
    const to = run.atomByHunk.get(edge.toHunkId);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    if (byId.get(from).path !== byId.get(to).path) {
      continue;
    }
    link(from, to, edge.source);
  }

  const byFile = new Map();
  for (const atom of run.atoms) {
    byFile.set(atom.path, [...(byFile.get(atom.path) ?? []), atom]);
  }
  for (const group of byFile.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        if ([...group[i].owners].some((owner) => group[j].owners.has(owner))) {
          link(group[i].id, group[j].id, "same_container");
        }
      }
    }
  }

  return { byId, adjacency, pairSources, byFile };
}

function bypassesPacking(atom) {
  return atom.kind === "whole-file" || atom.kind === "file-diff";
}

// Which related-but-split atom pairs exist, and what prevents each from packing.
function pairs(run) {
  const { byId, pairSources } = affinity(run);
  const summary = { coverage: 0, lenses: 0, caps: 0, bypass: 0, eligible: 0 };
  const detail = [];
  for (const [key, sources] of pairSources) {
    const [x, y] = key.split("|");
    const a = byId.get(x);
    const b = byId.get(y);
    // Checked in the same order the production predicate applies them, so the
    // first blocker reported is the one that actually decides the pair.
    let blocker;
    if (bypassesPacking(a) || bypassesPacking(b)) {
      blocker = "bypass";
    } else if (a.coverage !== b.coverage) {
      blocker = "coverage";
    } else if (a.lensSignature !== b.lensSignature) {
      blocker = "lenses";
    } else if (a.hunkCount + b.hunkCount > DEFAULT_MAX_HUNKS || a.patchChars + b.patchChars > DEFAULT_MAX_PATCH) {
      blocker = "caps";
    } else {
      blocker = "eligible";
    }
    summary[blocker] += 1;
    detail.push({
      file: a.path,
      sources: [...sources].sort().join("+"),
      blocker,
      a: `${a.kind} ${a.coverage} ${a.hunkCount}h/${a.patchChars}c`,
      b: `${b.kind} ${b.coverage} ${b.hunkCount}h/${b.patchChars}c`
    });
  }
  return {
    run: run.name,
    atoms: run.atoms.length,
    plannerEntries: run.plannerEntries,
    relatedSplitAtomPairs: pairSources.size,
    blockedBy: summary,
    detail: detail.sort((p, q) => p.file.localeCompare(q.file))
  };
}

// All three predicates share Plan 102's partition (same file + same effective
// coverage + same planner lens signature) and differ only in admission order:
//
//   source          fill in source order            — Plan 102's rule
//   compatibility   prefer related, else source     — Plan 103's rule
//   related         admit only related atoms        — the rejected draft
function simulate(run, { predicate, maxHunks, maxPatch }) {
  const { adjacency } = affinity(run);
  const partitions = new Map();
  const packets = [];

  for (const atom of run.atoms) {
    if (bypassesPacking(atom)) {
      packets.push([atom]);
      continue;
    }
    const key = `${atom.path} ${atom.coverage} ${atom.lensSignature}`;
    partitions.set(key, [...(partitions.get(key) ?? []), atom]);
  }

  for (const group of partitions.values()) {
    const remaining = [...group].sort((a, b) => a.sourcePos - b.sourcePos);
    while (remaining.length > 0) {
      const seed = remaining.shift();
      const members = [seed];
      let hunks = seed.hunkCount;
      let patch = seed.patchChars;
      for (;;) {
        const fits = (atom) => hunks + atom.hunkCount <= maxHunks && patch + atom.patchChars <= maxPatch;
        const related = predicate === "source"
          ? undefined
          : remaining.find((atom) => fits(atom) && members.some((member) => adjacency.get(member.id)?.has(atom.id)));
        const next = predicate === "related" ? related : related ?? remaining.find(fits);
        if (next === undefined) {
          break;
        }
        remaining.splice(remaining.indexOf(next), 1);
        members.push(next);
        hunks += next.hunkCount;
        patch += next.patchChars;
      }
      packets.push(members);
    }
  }

  const sizes = packets.map((packet) => packet.reduce((sum, atom) => sum + atom.hunkCount, 0));
  const atomsPerPacket = {};
  for (const packet of packets) {
    atomsPerPacket[packet.length] = (atomsPerPacket[packet.length] ?? 0) + 1;
  }
  return {
    run: run.name,
    predicate,
    caps: { maxHunks, maxPatch },
    atomsOff: run.atoms.length,
    packetsOn: packets.length,
    reductionPct: Number((100 * (run.atoms.length - packets.length) / run.atoms.length).toFixed(1)),
    multiAtomPackets: packets.filter((packet) => packet.length > 1).length,
    largestPacketHunks: Math.max(...sizes),
    packetsOverFiveHunks: sizes.filter((size) => size > 5).length,
    atomsPerPacket
  };
}

function sweep(run) {
  return {
    run: run.name,
    atomsOff: run.atoms.length,
    grid: SWEEP_GRID.map(([maxHunks, maxPatch]) => {
      const result = simulate(run, { predicate: "compatibility", maxHunks, maxPatch });
      return {
        cap: `${maxHunks}h/${maxPatch / 1000}K`,
        packets: result.packetsOn,
        reductionPct: result.reductionPct,
        multiAtomPackets: result.multiAtomPackets,
        largestPacketHunks: result.largestPacketHunks,
        packetsOverFiveHunks: result.packetsOverFiveHunks
      };
    })
  };
}

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const flags = new Map();
  const runDirs = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      flags.set(arg.slice(2), rest[i + 1]);
      i += 1; // consume the value so it is never mistaken for a run directory
      continue;
    }
    runDirs.push(arg);
  }
  const flag = (name, fallback) => flags.get(name) ?? fallback;

  if (!mode || runDirs.length === 0 || !["pairs", "sweep", "simulate"].includes(mode)) {
    console.error("usage: packing-diagnostics.mjs <pairs|sweep|simulate> <runDir...> [--predicate source|compatibility|related] [--max-hunks N] [--max-patch N]");
    process.exitCode = 2;
    return;
  }

  const options = {
    predicate: flag("predicate", "compatibility"),
    maxHunks: Number(flag("max-hunks", DEFAULT_MAX_HUNKS)),
    maxPatch: Number(flag("max-patch", DEFAULT_MAX_PATCH))
  };
  if (!["source", "compatibility", "related"].includes(options.predicate)) {
    console.error(`unknown predicate: ${options.predicate}`);
    process.exitCode = 2;
    return;
  }

  for (const runDir of runDirs) {
    const run = loadRun(runDir);
    const report = mode === "pairs" ? pairs(run) : mode === "sweep" ? sweep(run) : simulate(run, options);
    console.log(JSON.stringify(report, null, 1));
  }
}

main();
