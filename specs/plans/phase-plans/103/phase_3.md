---
status: complete (step 7); step 6 deferred to phase 4
---

# Phase 3: The Free Replay Gate

## Overview

Plan 103 step 7: port the report script and run the four-run replay whose fixed-slot hunk yield decides whether any paid phase is authorized.

**Step order was inverted deliberately.** The plan lists the pinned-plan seam (step 6) before the replay (step 7), but the seam is paid-phase infrastructure and the replay is the gate that decides whether a paid phase happens at all. Building the seam first risked constructing infrastructure for a phase that might never run. Step 6 moves to the front of Phase 4, where it is used.

## Steps

1. Add `scripts/packet-packing-report.ts` with a `replay` mode that rebuilds Stage 6 from recorded run artifacts using the real builder — resolved input, diff parse, file filter, classification, repository index, `buildReviewPackets()` off and on — with zero model calls.
2. Emit structured, templated failure records: a closed-set code plus typed fields, rendered from a template. No raw exception text, no repository source, no hashing.
3. Implement the fixed-slot hunk yield estimator over the Stage-7 scheduling tuple, and gate it on reconciling against the historical run before it may define the break-even ratio.
4. Add focused tests and run the four-run replay.

## Tests

- `renders failures from typed fields without raw text`
- `orders packets by the stage 7 scheduling tuple`
- `counts distinct hunks within a fixed dispatch slot budget`
- `passes a clean pack and fails closed on every invariant violation`: hunk loss, hunk duplication, cap breach, coverage change, profile downgrade, budget downgrade, and lens drop each produce their code.

## Outcome

**The gate passes.** `pnpm run check`, `pnpm test`, and `pnpm build` pass; 778 → 782 tests.

| Run | Packets off→on | Reduction | Yield @56 slots | Reviewable hunks |
| --- | --- | ---: | --- | ---: |
| `dca8d870` | 96 → **75** | 21.9% | **89 → 109** (+20) | 142 |
| `81f806a6` | 93 → **68** | 26.9% | 89 → 116 (+27) | 136 |
| `740d73f2` | 93 → 69 | 25.8% | 90 → 116 (+26) | 137 |
| `fe1548ae` | duplicate diff of `740d73f2` | | | |

Zero failures, `noModelCalls: true`, three distinct diffs. Preserved at `packet-dilution/reports/plan103-replay.json`, SHA-256 `20321c65fefd02167eabe01584e6bf7f0b0728b008c6a5ea0f49dc9e6eb73a63`.

Against the pre-registered gates: estimator reconciliation exactly 89 ✓; flag-on yield 109 ≥ 102 ✓; reduction ≥20% on every distinct diff ✓; deviation from Plan 102's frozen counts is **0** on both post-Plan-100 runs ✓; zero coverage changes, profile or budget downgrades, lens drops, cap breaches, or hunk loss ✓.

**Break-even ratio for Phase 4: `B = 89 / 109 = 0.8165`.**

### The reconciliation gate earned its place immediately

The first replay produced 114 off-packets against the recorded 96, and 161 reviewable hunks against 142 — and the estimator gate caught it rather than the number being quietly accepted. The diff itself was byte-correct (88 files, 217 hunks, matching the recorded totals exactly), so the divergence was downstream.

Cause: the reviewed repository carries its own `codegenie.toml` with `classification.pathRules` that skip generated webrpc clients and docs, schema dumps, and e2e snapshots, and raise `workers/`, `lib/intentmachine/protocol/`, and migrations to critical priority. The real run loaded it — 88 files, 61 kept, 27 skipped. Replaying with bare `defaultConfig` kept files the real run never reviewed, silently changing the workload. `applyRepoConfigLayer()` fixed it, after which `dca8d870` reproduces Plan 102's frozen 96 → 75 and its 142 reviewable hunks exactly.

Had the gate not existed, the replay would have reported a plausible-looking 20.2% reduction on a workload that was not the one being claimed.

### Two older runs legitimately diverge

`740d73f2` and `fe1548ae` replay at 93 packets where their artifacts recorded 109. Both predate Plan 100, which changed hunk identity, and both are the runs whose planner output was entirely dropped. Plan 102's own reconciliation note flagged that these three older artifacts need a compatibility view. Their off→on comparison remains internally valid — identical inputs on both sides — so they contribute reduction evidence but not historical-count evidence. The gate is scoped to `dca8d870`, the only post-Plan-100 run with surviving planner coverage.

### Design note

`comparePackets()` originally tested coverage in one direction, catching promotion but not demotion — the more dangerous case, since a demoted hunk is reviewed more shallowly than planned. Because the partition key forces identical coverage across a packet's members, any change at all is a violation, so the check is now an inequality and the code is `coverage_changed`. A test covers it.

The estimator is documented in the script as a calibrated counterfactual capacity proxy, not a scheduler reproduction: the real dispatcher is a prefix-with-holes at concurrency above one.

## Remaining before Phase 4

Step 6 — the versioned `PinnedPlanArtifact`, its validation, and `scripts/draw-pinned-plan.ts` — is now authorized and moves to the head of Phase 4, together with the owner-approved validation ceiling that Phase 4 cannot start without.
