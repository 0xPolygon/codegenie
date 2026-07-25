# Issue 103: Compatible-Atom Packet Packing and the Packet-Size Recall Curve

Status: PENDING
Related: Plan 102 (`102-issue-102-same-file-packet-packing.md`) — COMPLETE as a failed treatment gate; its deterministic packing mechanism passed every invariant and is adopted here unchanged. Plan 92 (coverage calibration), Plan 100 (dispatch rank), Plan 79 (repeat/recall harness), Plan 32 (adaptive Stage-6 symbol context).
Planned from: Plan 102's preserved evidence, plus artifact-only diagnostics reproducible with `scripts/packing-diagnostics.mjs`, 2026-07-25
Production replay refs: base/merge-base `d1c49bdf6a8002ec2ec27faac94a932d736532b2`; head `fbb5f8761c2c296e115af17e919a7c35d9de8373`
Planned at: commit `32d7b83` (branch `next`)
Recommended priority: after Plan 101's paid A/B settles.

## Introduction and TL;DR

### The problem

Reviews run out of time before they run out of code. On the motivating pull request, Stage 6 produced **96 packets** covering 142 changed hunks. Only 56 packets were dispatched before the deadline, so **53 hunks received no review at all**.

A packet is one conversation with the model, and most of its cost is fixed — the skill text, the prompt scaffolding, the forced finalization at the end. Measurements from that run show a five-hunk packet costs roughly the same as a one-hunk packet: about 3 model calls and 228 seconds either way. Yet 73 of the 96 packets held a single hunk.

### What this plan achieves

Two things.

**First, it lands Plan 102's packing mechanism.** Group compatible hunks from the same file into fewer, slightly larger packets — about **21% fewer packets**, measured deterministically across four production runs with no model calls. The point is not a shorter review but a **more complete** one: at the same time budget, roughly **108 of 142 hunks reviewed instead of 89**. The win is coverage.

**Second, and more durable, it produces the recall-versus-packet-size curve.** Nobody has ever measured whether a hunk sharing a packet gets reviewed as carefully as a hunk reviewed alone. Every packing proposal — this one, Plan 102, any future cap increase or cross-file scheme — rests on assuming that answer. This plan measures it once, and the curve becomes a standing asset.

### What it does *not* do, and why

An earlier draft proposed packing by tree-sitter relationships instead of by planner compatibility, and then as an ordering preference within compatibility. Both were measured against recorded artifacts and rejected:

- **As a membership predicate**, relationship-required packing yields 4 combinable atom pairs and a 4.2% packet reduction, against compatibility's 21.9%. Relationships between *distinct* atoms are sparse because today's grouper already absorbs most same-symbol adjacency into atoms.
- **As an ordering preference**, it produces packing byte-identical to plain source order on all three distinct retained diffs — same packet counts, same composition. Related atoms are usually already source-adjacent, so preferring them picks the same atom.

So there is no affinity view, no container identity, and no relationship ordering in this plan. `scripts/packing-diagnostics.mjs` reproduces both measurements, and the outputs are preserved.

### How the machinery works

Five pieces, in the order they run inside Stage 6:

1. **Atoms.** Today's grouper already merges hunks that share an enclosing symbol or sit within 30 lines. We keep it as-is and treat each group as an unbreakable unit. Nothing here ever splits one.

2. **Partitions.** Within each file, atoms are bucketed by two things the planner already decided: review depth (`light`/`normal`/`deep`) and the set of lenses requested. Only atoms in the same bucket may combine. This guarantees no hunk is reviewed more shallowly, or with different expertise, than planned. It does **not** guarantee equal cost — see below.

3. **Filling.** Walk each bucket in source order, filling a packet until it hits 5 hunks or 12,000 characters, then start another.

4. **Context for every member.** If a packet holds three functions, the reviewer gets all three function bodies under a shared, explicitly budgeted allowance. Today's code reads only the top-ranked one, which would quietly leave the others as bare diffs. This is the one place Plan 102's mechanism is genuinely improved rather than reused.

5. **Safety checks before committing.** Each candidate packet is built in a scratch space first. If merging would drop a lens, drop an important planner note, or squeeze any member's source below a usable minimum *after final rendering*, the merge is abandoned and those atoms stay separate.

Packing can make a hunk **more** expensive than it would have been alone: the profile floor may lift a `standard` atom into an `investigate` packet's tool budget, and multi-member context deliberately adds input tokens. That is a deliberate trade for coverage, and both effects are reported rather than assumed away.

### The risk, and how it gets tested

**Attention dilution.** A bug in a five-hunk packet might get less scrutiny than the same bug alone.

One test repository, fifteen separated changes in one Go file, **three** independent bugs placed so that no two share a packet at any tested cap, plus a safe-looking control. The same review runs at packet caps 1, 3, and 5, six repeats each, all against one hand-authored frozen plan so packet size is the only variable. Three bugs times six repeats gives **18 recall opportunities per arm** rather than 6 — the same spend buys three times the resolution. Those opportunities are *clustered*, not independent: repeats share a fixture and an authored plan, so they are treated as three per-bug series rather than 18 free trials, and recall is reported per bug as well as in aggregate.

The pass bar is derived, not chosen: packing must not cost more per-hunk recall than the coverage it buys. If the replay shows packing reviewing 108 hunks where the baseline reviews 89, per-hunk recall may fall no further than 89/108 ≈ **82.4%** of baseline before the whole thing is a net loss.

Cost: about **$14** to answer that, and a $50 production-scale confirmation that is **required once the curve passes**, not optional.

### The outcome, either way

Either packing becomes permanent unconditional behavior and the temporary switches are deleted, or packing is removed entirely and the code returns to today's baseline. No flag survives, no dark path is left behind.

> **Revision history.** Draft 1 (`7b61b34`) proposed a relationship membership predicate. Draft 2 (`4935134`) demoted relationships to ordering after diagnostics showed 4.2% versus 21.9%. This draft removes relationships entirely after measuring ordering as a no-op, and rebuilds the paid experiment after review found it could repeat Plan 102's zero-treatment failure and could pass a net-negative outcome.

> Executor instructions: adopt Plan 102's predicate, caps, and fill order unchanged — its deterministic gate passed on four runs and this plan does not relitigate it. The new engineering is multi-member symbol context and transactional rejection. The new evidence is the packet-size recall curve. Do not add relationship signals, container identity, coverage promotion, tool-budget arms, or cap increases; each was measured or reasoned out and has an entry in Non-Goals.
>
> **Commit references are rebase-unstable.** The Plan 102 series is currently `5551547`, `8fceba9`, `7ebfd2f`, `87a5a10`, `f372f73`. Locate referenced work by commit subject when a hash does not resolve.
>
> Drift check: `git diff --stat 32d7b83..HEAD -- src/pipeline/packet-builder.ts src/pipeline/review-runner.ts src/config/schema.ts src/config/config-loader.ts src/types.ts src/evals/eval-runner.ts scripts/packet-packing-report.ts tests/pipeline-phase5.test.ts tests/evals.test.ts`
> Working-tree check: `git status --short -- src/ evals/ scripts/`

## Decision

- Run the existing grouper unchanged; its groups are indivisible **atoms**.
- Partition each file's atoms by `(effectiveCoverage, normalizedPlannerLensSignature)` — Plan 102's predicate. Zero coverage promotion by construction.
- Fill greedily in source order under the unchanged `MAX_HUNKS_PER_PACKET = 5` and `MAX_PATCH_CHARS = 12_000`.
- **Source order** means: hunks are ordered within a packet by file position, and packets are ordered by their earliest member hunk. Because partitions are non-contiguous, the globally flattened hunk sequence is *not* preserved across packets. That is expected and is not a defect.
- Read enclosing-symbol source for **every** member atom under an explicit shared budget.
- Abandon any candidate that would lose a lens, a high-priority planner focus note, or a member's usable symbol source after final rendering.
- Retain Plan 102's monotonic profile floor and the unchanged `packetDispatchRank()` formula.
- Two temporary settings, **eval and internal only** — not in the repo TOML schema, not repo-safe filtered, not user-facing. Both deleted at teardown.
- Ship only if the measured packet-size recall curve clears a break-even bar derived from the measured coverage gain.

## Evidence

### Plan 102's mechanism passed its deterministic gate

Four runs, zero model calls, zero failures: `740d73f2` 109→85, `fe1548ae` 109→85, `81f806a6` 93→68, `dca8d870` 96→75 — 21.9–26.9% fewer packets with zero coverage promotions, zero profile or budget downgrades, zero cap violations, zero lens drops, zero invalid dispatch ranks. Only the paid gate failed, and it failed on fixture treatment, never on recall.

`740d73f2` and `fe1548ae` are the same commit, and all four runs are the same PR at three head commits. This is one PR, not four samples. Thresholds below count distinct diffs.

### Relationship signals were measured and rejected

Reproducible via `scripts/packing-diagnostics.mjs`; outputs preserved under `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-dilution/reports/`:

| Artifact | SHA-256 |
| --- | --- |
| `plan103-affinity-pairs.json` | `2d0f6f2d14ce907822128e5338c2627e97fc9d495a528f807d71ffec0ac6bc76` |
| `plan103-cap-sweep.json` | `f9915c77210d329c2859531007f6175c90eaca45cb52417a22d8dbc3e08de371` |
| `plan103-ordering-comparison.json` | `e4e6bf2e3cfe585b1c04db1280a2bcb1c1bb5516975352b545fb96211bf24a57` |

On `dca8d870`, 13 atom pairs are related but currently split: 6 blocked by the caps, 2 by coverage inequality, 2 by lens-signature mismatch, 3 eligible. On `81f806a6`, 11 pairs: 7 caps, 4 eligible. Relationship-required packing gives 96→92 (4.2%). Relationship-preferred *ordering* gives 75/66/83 packets across the three distinct diffs — identical to plain source order, including multi-atom counts.

Both measurements use documented approximations (patch proxy, owner prefix from display strings, synthetic `DEFAULT` lens signature for planner-undeclared hunks). Neither is close enough to its threshold for the approximation to change the conclusion.

### The fixed-slot estimator is validated against the real run

The coverage claim is gated on a fixed-slot estimator rather than packet count, so the estimator itself was checked against `dca8d870`. `worker-runner.ts` sorts by `(priority, coverage, dispatchRank, input order)` and assigns worker IDs in that order, so dispatch order is directly recoverable from telemetry.

**The estimator is a calibrated counterfactual, not an exact reproduction of the scheduler.** The real dispatched set is a prefix *with a hole*: worker `w7-056` was recorded `packet_review_not_dispatched` while `w7-057` completed. At concurrency 4 a later worker can clear its budget checkpoint before an earlier one fails, so the undispatched set is not a clean suffix and a future run could have more than one hole.

Applying the sort to the 96 flag-off packets and taking the first 56 nevertheless yields **89 hunks — the same 89 the run actually reviewed** — with 55 of 56 packets in common; the one difference is exactly the `w7-056`/`w7-057` swap, and the two packets happen to carry equal hunk counts. That makes 56 slots a *calibrated capacity proxy*, validated against a known outcome, not a claim that the estimator replays scheduling.

Counting completed reviews, 56 packets produced review outcomes against 96 built; 57 started. This plan uses **56 slots** as the completed-packet capacity, and the reconciliation gate below re-proves the 89-hunk calibration mechanically before the estimator is used for anything.

### The 5-hunk cap is near-optimal

Simulator validated against Plan 102's real implementation to within one packet.

| Cap | `dca8d870` | `81f806a6` | `740d73f2` | Packets >5 hunks |
| --- | --- | --- | --- | ---: |
| 5h/12K (today) | 96→75 (21.9%) | 93→66 (29.0%) | 109→83 (23.9%) | 0 |
| 6h/12K | 96→75 | 93→65 | 109→81 | 2–4 |
| 8h/12K | 96→73 (24.0%) | 93→64 | 109→80 | 4–5 |
| 10h/16K | 96→71 (26.0%) | 93→61 | 109→77 | 5–6 |
| 12h/24K | saturated | | | |

The predicate is worth ~21 points; the cap ~5 more before saturating, because partitions run out of compatible atoms rather than hitting the cap. Raising it trades oversized packets for a few points and enlarges the untested recall risk. **The cap stays at 5.**

### The value is coverage, and the cost is not free

Plan 102's Stage 7 spent 174 model calls, 5.321M tokens, `$22.85`, and 52.7 concurrency-normalized minutes on 57 dispatched packets, reviewing 89 of 142 hunks. Forced finalization alone was 34 calls and `$6.71` of per-packet overhead. Per-packet cost is roughly flat in size (1 hunk: 3.10 calls / 228s; 4–5 hunks: 3.00 calls / 228s).

Packing does not reduce per-hunk cost uniformly. The profile floor can lift a member into a larger tool budget, and multi-member symbol context adds input tokens by design. Both are reported off/on rather than assumed neutral.

## Current State

- `hunkFirstGroups()`/`canJoinGroup()` join same-file hunks by identical enclosing symbol or `NEARBY_GAP_LINES = 30`. Baseline restored after Plan 102's teardown.
- `buildPacket()` derives `reviewProfile` after related-context filtering, so absorbing a strong edge can lower the derived profile — the reason Plan 102's floor exists.
- `readEnclosingSymbolSource()` reads one symbol per packet; `computeSymbolContextBudget()` selects `multiple_symbols_keep_compact` when `singlePrimarySymbol` is false. `DEFAULT_SYMBOL_CONTEXT_CHARS = 3_000`, `MAX_ADAPTIVE_SYMBOL_CONTEXT_CHARS = 6_000`, `MAX_CONTEXT_CHARS = 8_000`. Three members at the default already exceed the packet cap, and `renderPacketContextText()` truncates the combined text afterward — so any per-member quality computed before final rendering is fiction.
- `MAX_RELATIONSHIP_EDGES_PER_HUNK = 8` drops edges in insertion order; recorded `omittedEdges` is 112/91/89 on the retained runs. Relevant only if a future plan revives relationship signals.
- `evals/skill-semantics/` fixture files are 10–15 lines — one atom each — so those cases cannot exercise packing at all.
- `.gitignore` covers `evals/fixtures/logs/` but not `evals/skill-semantics/logs/`.
- `tsconfig.json` includes only `src/**` and `tests/**`, so `scripts/*.ts` is never typechecked by `pnpm run check`.
- `pnpm test -- <file>` does not filter; it runs the full suite and drops the argument.
- There is no seam to supply a pre-recorded Stage-5 plan to a review.

## Goal

1. Land Plan 102's mechanism unchanged in predicate, caps, and fill order.
2. Close the multi-member symbol-context gap so bigger packets are not quietly worse packets.
3. Prove the coverage gain deterministically as a **fixed-slot hunk yield**, not as a packet-count proxy.
4. Measure the packet-size recall curve with enough resolution to decide, and gate on a break-even bar derived from measurement 3.
5. End in one product path with no surviving flag.

## Design

### 1. Atoms, partitions, and fill — Plan 102, unchanged

Wrap `hunkFirstGroups()` output as atoms carrying ordered hunks, hunk count, `combinedPatchChars()` size, first source position, effective coverage, routed lenses, standalone profile, and standalone per-member context quality. Partition by `(effectiveCoverage, normalizedPlannerLensSignature)`. Direct `whole-file` and content-probed `file-diff` returns bypass packing.

### 2. Multi-member symbol context, fully specified

Constants:

- `PACKET_SYMBOL_CONTEXT_BUDGET = 5_000` — the share of `MAX_CONTEXT_CHARS` available to symbol source in a packed packet.
- `MIN_MEMBER_SYMBOL_CHARS = 800` — the floor below which a member is not meaningfully represented.
- `MIN_SLICED_MEMBER_CHARS = 600` — the minimum surviving emitted characters for a member to count as `sliced`.

Rules:

1. At least `MAX_CONTEXT_CHARS - PACKET_SYMBOL_CONTEXT_BUDGET` (3,000 characters) is reserved for outline, likely-tests, and planner-hint context. Symbol source never consumes it.
2. **Only members with a resolvable primary symbol participate in the allocation.** `memberSymbolCount` counts distinct resolvable primary symbol identities, never all members.
3. Each participating member receives `floor(PACKET_SYMBOL_CONTEXT_BUDGET / memberSymbolCount)`, subject to `MIN_MEMBER_SYMBOL_CHARS`.
4. If `memberSymbolCount * MIN_MEMBER_SYMBOL_CHARS > PACKET_SYMBOL_CONTEXT_BUDGET`, the candidate is abandoned — the packet cannot represent all its symbol-bearing members.
5. Members needing less than their share release the remainder; one redistribution pass, in source order, to members that requested more.
6. Existing adaptive/sliced selection applies per member within its share. Members render in source order.
7. **Per-member context quality is computed after `renderPacketContextText()` truncation, not before.** A participating member with fewer than `MIN_SLICED_MEMBER_CHARS` surviving is a candidate abandonment, never a reported `sliced`.

**Symbol-less members.** Configuration, documentation, generic-adapter, and fallback hunks frequently have no resolvable primary symbol; `readEnclosingSymbolSource()` returns empty for them today and their standalone context quality is `outline_only` or `path_only`. Such members:

- do not participate in the symbol allocation and consume none of it;
- are **exempt from the `MIN_SLICED_MEMBER_CHARS` rule** — applying a symbol-source floor to a member that never had symbol source would reject every packet containing one, including the config- and docs-heavy files where compatible atoms are most abundant;
- must retain their standalone outline or path context quality after packing. A symbol-less member whose quality degrades below what it held alone is a candidate abandonment.

A packet whose members are *all* symbol-less allocates no symbol budget and is judged solely on the standalone-quality rule.

### 3. Transactional candidate evaluation

Every candidate is dry-built against a cloned relationship accumulator and a suppressed telemetry sink; nothing reaches the real graph, artifacts, or event stream until commit. Abandon when the combined packet would drop a routed lens, newly omit a planner focus note on a `high`/`critical` hunk, breach the context rules in section 2, or lower the effective profile below the maximum standalone member profile. Record each abandonment with a reason code and the atoms involved.

### 4. Profile floor and dispatch rank

Plan 102's floor verbatim: `max(derivedPackedProfile, max(standalone member profiles))` over `{ simple: 0, standard: 1, investigate: 2 }`. `dispatchRank` recomputed with the unchanged formula.

### 5. Configuration — eval and internal only

```ts
// CodegenieConfig["review"], resolved schema and defaults only
packCompatibleAtoms: boolean;  // default false
packMaxHunks: number;          // default 5, never exceeds MAX_HUNKS_PER_PACKET in shipped behavior
```

Neither appears in `rawConfigSchema`, neither is repo-safe filtered, and no `codegenie.toml` can set them. They exist in the resolved config, defaults, config-source telemetry, the strict eval-case `review` schema, and `applyCaseReviewConfig()`. Both are deleted in step 9.

The pinned-plan seam is likewise eval-only. `ReviewPlan` carries no base/head identity, so the pinned artifact is an explicit versioned wrapper rather than a bare plan:

```ts
type PinnedPlanArtifact = {
  schemaVersion: 1;
  baseSha: string;      // resolved base commit the plan was drawn against
  headSha: string;      // resolved head commit
  planSha256: string;   // canonical hash of `plan`, defined below
  plan: ReviewPlan;
};
```

`planSha256` is the SHA-256 of the stable JSON serialization of `plan` alone — keys sorted recursively, no whitespace — so the hash is independent of field order and of the wrapper's own fields. The eval-case field `review.pinnedPlanPath` names this artifact, and loading it fails closed on any of: wrapper schema mismatch, `ReviewPlan` schema parse failure, `planSha256` not matching a recomputed canonical hash, `baseSha`/`headSha` not matching the resolved review target, or `hunkId` membership differing from the current diff. A hash match over a plan that no longer parses, or that targets a different diff, is not sufficient.

The planner-draw mode that writes this artifact is a **dedicated internal script**, not a new top-level CLI command — `pnpm dev plan` does not exist today and adding a user-facing verb would contradict the eval-only scope. Tests cover each failure mode individually: bad wrapper schema, bad plan schema, wrong hash, wrong base, wrong head, wrong path, changed lenses, and changed hunk IDs.

## Validation Strategy

### A. Free deterministic replay

Port `scripts/packet-packing-report.ts` from `7ebfd2f` down to `replay` plus `treatment`. Failure records are structured and templated — closed-set `code`, structured fields, message rendered from a template. No raw exception text, no repository source, no hashing.

Assert per run: packet counts reproduce Plan 102's frozen result within 2; every hunk appears exactly once in source order; no atom split; no coverage promotion; caps hold; no lens or high-priority note lost without a recorded abandonment; no member below `MIN_SLICED_MEMBER_CHARS`; no profile or budget below the standalone maximum; dispatch ranks match the formula; flag-off is artifact-identical including `hunk-relationships.json`.

**Fixed-slot hunk yield is the primary gate.** Sort packets by the full Stage-7 scheduling tuple `(priority, coverage, dispatchRank, input order)`, take the first 56 — the motivating run's observed dispatch capacity — and count reviewable hunks covered.

**The estimator must first reconcile against the actual run.** Apply it to the *flag-off* packets and require it to reproduce the 89 hunks the run actually reviewed. If it does not, the estimator is not comparable to the historical baseline and must not define `B` until reconciled. This has been validated once by hand (89 = 89, 55/56 packets in common); the report re-proves it mechanically because it also feeds the paid gate.

| Gate | Threshold |
| --- | --- |
| Flag-off estimator reconciliation | exactly `89` hunks at 56 slots |
| Fixed-slot hunk yield at 56 packets, flag on | `>= 102` hunks (≥15% over baseline 89) |
| Packet reduction | `>= 20%` per distinct diff |
| Deviation from Plan 102's frozen counts | `<= 2` packets per run |
| Participating members below `MIN_SLICED_MEMBER_CHARS` | `0` |
| Symbol-less members losing standalone quality | `0` |
| New coverage promotions | `0` |

Also report, off versus on: per-member profile upgrades, total tool-call allowance, total context characters, and projected cost and service time per reviewed hunk. The measured yield ratio `baselineYield / packedYield` becomes the break-even bar for phase B.

### B. The packet-size recall curve (paid)

**Location.** `evals/packet-dilution/` in this repository, not the private evals repo. The fixture is synthetic Go with nothing proprietary, and `evals/skill-semantics/` is precedent for a real-model suite living here. This makes the curve a standing asset re-runnable whenever anyone proposes changing caps. Add `evals/packet-dilution/logs/` — and the missing `evals/skill-semantics/logs/` — to `.gitignore`.

**Fixture.** One Go file, fifteen separated single-hunk changes, far enough apart that today's grouper yields fifteen atoms. It carries:

- **three independent bugs** at atom positions 1, 10, and 13. Under cap 5 the packets are `[1-5][6-10][11-15]`, placing the bugs in three *different* packets at positions 1, 5, and 3 — first, last, and middle. Under cap 3 the packets are `[1-3]…[10-12][13-15]`, again three different packets. **No two bugs ever share a packet at any tested cap**, so no arm reviews an unnaturally bug-dense packet and no two opportunities collapse into one conversation;
- **one safe-but-suspicious change** as a `should_not_find` control, so a rise in false positives is visible;
- eleven ordinary safe changes.

Fixture-quality rules, each learned from a Plan 102 failure:

1. **Transplant bugs already proven detectable.** Take them from `evals/skill-semantics/`, where the existing suite already demonstrates the harness finds them. Do not invent new bugs whose detectability is unknown.
2. **Validate expectations with the fake provider first**, for `$0`. `fake-runner.ts` emits a finding from a trigger line; confirm each `should_find` matcher fires on the expected finding shape before any real call.
3. **Each bug must be one the planner grades ordinarily.** If a bug is obvious enough to draw a `deep` grade on its own, it lands in a different partition and never packs.
4. **Constrain path, line range, and failure mode — never category.** Plan 102 lost three executions that found its bug because the expectation demanded `correctness` and the reviewer said `security`.
5. **Prove treatment model-free before paying.** Build Stage 6 against the frozen plan at caps 1, 3, and 5 and require exactly 15, 5, and 3 packets, with each bug's atom in a packet of exactly 1, 3, and 5 source atoms. Any miss is a fixture defect: fix the fixture, never the sample.

**The frozen plan is hand-authored, not drawn.** Authoring it makes coverage and lens assignment deterministic, so all fifteen atoms are guaranteed into one partition; removes planner variance so packet size is genuinely the only variable; eliminates any temptation to redraw unfavourable plans; and costs nothing.

**But an authored plan must be shown to be realistic, not merely convenient — and realism is measured in hunks, not atoms.** Plan 102's replay gives the production shape after packing at cap 5:

| Run | Packed packets by hunk count (1/2/3/4/5) | Packed packets by atom count (1/2/3/4) |
| --- | --- | --- |
| `dca8d870` | 46/12/4/5/**8** | 61/8/5/1 |
| `81f806a6` | 38/12/6/4/**8** | 48/10/7/1 |
| `740d73f2` | 54/13/6/5/**7** | 66/9/7/1 |

Five-**hunk** packets are ordinary production output — 7 to 8 per run, roughly a tenth of all packed packets. Five-**atom** packets never occur; the maximum observed is four, once per run. Since the fixture uses fifteen single-hunk atoms, its cap-5 arm produces a five-hunk packet, which is the production-real shape. The cap-5 arm is therefore a genuine production case, not a stress bound — but only because atoms there are one hunk each, and the plan claims nothing about five-*atom* packets, which production does not build.

Draw **three** reference plans from the real planner against the same fixture and require that in **at least 2 of 3**, every target hunk lands in a packet of at least five hunks at cap 5 and at least three at cap 3 — the shapes the arms actually test. Fewer than 2 of 3 means the fixture exercises a shape the planner would rarely produce: **the fixture is invalid and must be redesigned before any reviewer call**, not merely documented. Draws run with the local cache disabled so they are independent. A machine-enforced report parses all three, rebuilds their Stage-6 packet shapes, emits each target's actual packet hunk count and compatibility signature, and exits non-zero below the threshold. Record all three draws, their diffs against the authored plan, the emitted shapes, and the pass count.

**Arms.** Three cases differing only in `packMaxHunks` — 1, 3, 5 — at `repeat: 6`, cache off, all pinned to the same authored plan. Three bugs × six repeats = **18 recall opportunities per arm**.

Those opportunities are **clustered, not independent**: all repeats share one fixture and one authored plan, and each repeat's three bugs are reviewed by the same run. Treat the data as three per-bug series of six, report `R` per bug alongside the aggregate, and never describe it as 18 independent trials.

**Decision rule.** Let `N` be opportunities per arm (18 initially, 36 after an extension), `K` be repeats per arm (6 initially, 12 after), `R1`, `R3`, `R5` aggregate hits out of `N`, `R{n}[i]` per-bug hits out of `K`, and `B` the break-even ratio measured in phase A (`baselineYield / packedYield`; ≈ 0.824 at 89/108).

**All thresholds are proportions, so they scale correctly when repeats are extended.** Applying the initial absolute counts to a 36-opportunity extension would silently halve the baseline bar and redefine collapse.

| Condition | Outcome |
| --- | --- |
| `R1 / N < 5/6` (15 of 18; 30 of 36) | **Void.** Baseline too unreliable to measure a ratio against. |
| any bug with `R1[i] / K >= 5/6` and `R5[i] / K <= 1/6` (5-of-6 and 1-of-6; 10-of-12 and 2-of-12) | **Fail (per-bug collapse).** One target falling from reliable detection to near-zero is a real regression regardless of the aggregate. |
| `R5 / R1 >= B`, no per-bug collapse, and no monotone decline `R1 > R3 > R5` | **Pass.** |
| `R5 / R1 >= B` but `R1 > R3 > R5` | **Extend once** (see below). |
| `R5 / R1 < B` | **Fail.** Packing costs more recall than the coverage it buys. |

`R3` therefore has a real role — it distinguishes a cliff from a gradient — and there is no unreachable branch.

**Void and extension are bounded and preregistered, not discretionary:**

- **Void permits exactly one fixture redesign and one rerun.** A second Void is a **Fail** and takes the teardown branch. Void never means "keep trying until the numbers work."
- **Monotone decline permits exactly one extension:** six additional repeats on **all three arms**, budgeted below at ~$14. Re-apply the same decision rule to the combined 12-repeat totals (36 opportunities per arm). Its outcome is final — a second extension is not available, and a still-monotone result after extension is a **Fail**.
- Every Void or extension is recorded in the reconciliation note with its trigger, cost, and result.

**Honest limits.** Eighteen clustered opportunities per arm can detect a large regression; they cannot resolve, say, 100% versus 85% with confidence. The gate is a screen against material harm, not a certificate of equivalence, and the reconciliation note must say so. Report per-arm cost, tokens, and model-service time per reviewed hunk alongside recall.

### C. Collateral

1. `evals/fixtures/` flag-off and flag-on at `repeat: 1`, fake provider. Every expectation, packet invariant, and config parse must match.
2. **Treated cross-language packet-shape cases** under `evals/packet-dilution/`: small TypeScript, Python, and Solidity fixtures each with at least three compatible same-file atoms, run under the fake provider, asserting packed packet shape and per-member context presence. Existing `evals/skill-semantics/` files are 10–15 lines and yield one atom each, so they cannot exercise packing; they remain a flag-off/on regression check only.
3. One production-shaped capacity pair on the pinned `trails-api` diff at concurrency 6, flag-off and flag-on. **Required before shipping**, not optional.

   Both sides consume **the same pinned Stage-5 plan** and identical provider, model, reasoning, budget, concurrency, time limit, and cache settings; independently drawn plans would confound the pair exactly as they confounded Plan 102. Its gate is numeric, not narrative:

   - the flag-on run must review **at least 10% more reviewable hunks** than flag-off within the same wall-clock and token budget;
   - the flag-on reviewed-hunk set must be a **superset of the flag-off set minus at most 2 hunks**, so the gain is not a reshuffle;
   - measured flag-on yield must fall within **±10% of the phase-A fixed-slot prediction**; a larger miss means the estimator does not transfer to a live run and the prediction, not the run, is what failed.

   Any of the three failing is a stop-for-investigation before shipping.

### Cost discipline

No paid call before `approvedValidationCostUSD` is recorded here.

| Phase | Executions | Projection |
| --- | ---: | ---: |
| Fake-provider expectation validation | — | $0 |
| Three reference planner draws | 3 | ~$3 |
| Recall curve, 6 repeats × 3 arms | 18 | ~$14 |
| Reserved: one bounded extension, 6 more repeats × 3 arms | 18 | ~$14 |
| Reserved: one fixture redesign rerun after a single Void | 18 | ~$14 |
| `evals/fixtures/` and cross-language shape cases | — | $0 |
| Production capacity pair | 2 | ~$50 |
| Contingency 25% | — | ~$24 |
| **Reservation** | | **~$119** |

The two reserved contingencies are the *only* reruns this plan authorizes; a second Void or a second extension is a Fail, not another draw on the budget. Phases through the first curve cost ~$17 and decide whether packing ships; the capacity pair runs last and only after a pass.

## In-Scope Files

- `src/pipeline/packet-builder.ts` — atoms, partitions, fill, multi-member symbol context, transactional candidates, profile floor, telemetry.
- `src/pipeline/review-runner.ts` — eval-only pinned-plan seam.
- `src/types.ts` — per-member context-quality telemetry, both temporary settings.
- `src/config/schema.ts`, `src/config/config-loader.ts`, `src/evals/eval-runner.ts` — resolved-config and eval plumbing only.
- `scripts/packet-packing-report.ts`, `tests/packet-packing-report.test.ts` — `replay`, `treatment`, and `realism`.
- `scripts/draw-pinned-plan.ts` — internal planner-draw writing the versioned `PinnedPlanArtifact`. No user-facing CLI verb is added; `src/cli/` stays out of scope.
- `tests/pipeline-phase5.test.ts`, `tests/evals.test.ts`, `tests/config-loader.test.ts`.
- `evals/packet-dilution/` — Go recall fixture, cross-language shape cases, authored plan.
- `.gitignore` — `evals/packet-dilution/logs/` and the missing `evals/skill-semantics/logs/`.
- `specs/plans/README.md` and affected `specs/project/` docs.

## Non-Goals

- **Relationship-based packing, in any form.** Measured at 4.2% as a predicate and as a no-op as an ordering preference. No affinity view, no `ownerKey`, no `same_container`.
- **Raising `MAX_HUNKS_PER_PACKET` or `MAX_PATCH_CHARS`.** The sweep shows 5 captures ~80% of achievable compression. `packMaxHunks` exists only to measure the curve and never ships above 5.
- **Coverage promotion.** 2 of 13 candidate pairs, zero of them structural.
- **Reordering the stage flow.** The planner grades related siblings consistently in 132 of 134 measured pairs.
- Cross-file packing; the packet schema is file-scoped.
- Tool-budget changes of any kind.
- Changing prompt templates, attention-note ordering, `canJoinGroup()`, Plan 100's dispatch policy, or Plan 92's escalation rules.
- Any user-facing configuration surface, or leaving either setting dark after step 9.

## Implementation Steps

1. Reconcile drift and working-tree checks. Add both settings to the resolved config, defaults, source telemetry, the strict eval-case schema, and `applyCaseReviewConfig()` — **not** to `rawConfigSchema` or repo-safe filtering. Add both `.gitignore` log entries.

   **Verify:** `pnpm exec vitest run tests/config-loader.test.ts tests/evals.test.ts` → exit 0; defaults `false`/`5`; eval overrides apply; `packMaxHunks > 5` rejected; a `codegenie.toml` setting either key fails strict parsing.
2. Wrap `hunkFirstGroups()` output as atoms, capturing standalone coverage, lenses, profile, and per-member context quality; add flag-off golden parity.

   **Verify:** `pnpm exec vitest run tests/pipeline-phase5.test.ts -t "packet atom|flag-off parity|whole-file bypass"` → exit 0.
3. Implement partitions and source-order greedy fill; reproduce Plan 102's frozen counts.

   **Verify:** `pnpm exec vitest run tests/pipeline-phase5.test.ts -t "compatible partition"` → exit 0; hunk bijection, within-packet source ordering, packet ordering by earliest member, cap splits, interleaved partitions, degradation merge, exact dispatch rank.
4. Implement multi-member symbol context per section 2.

   **Verify:** `pnpm exec vitest run tests/pipeline-phase5.test.ts -t "member symbol context"` → exit 0; the 3,000-character non-symbol reserve is never consumed; equal shares with redistribution; a candidate needing more than the budget floor for all members is abandoned; quality is computed after final truncation and a member surviving under 600 characters aborts rather than reporting `sliced`.
5. Implement transactional candidate evaluation and the profile floor.

   **Verify:** `pnpm exec vitest run tests/pipeline-phase5.test.ts -t "candidate rejection|profile floor"` → exit 0; abandoned candidates leave no telemetry, graph, or artifact residue.
6. Add the pinned-plan seam and planner-draw mode.

   **Verify:** `pnpm exec vitest run tests/evals.test.ts -t "pinned plan"` → exit 0; a pinned plan reproduces identical Stage-6 inputs across runs; hash and `hunkId` mismatches fail closed; no user-facing path reaches it.
7. Port the report script and run the four-run replay.

   **Verify:** `pnpm exec vitest run tests/packet-packing-report.test.ts` → exit 0; the replay exits 0 with `modelCallsObserved: 0` and every section-A gate satisfied, including fixed-slot hunk yield `>= 102`. Record the measured break-even ratio `B`.
8. Build the fixture, validate expectations under the fake provider, author and hash the plan, prove treatment model-free, then record the ceiling and run: reference planner draw, the 6×3 curve, `evals/fixtures/`, cross-language shape cases, and the capacity pair. Apply the decision table verbatim.

   **Verify:** the realism report exits 0 with at least 2 of 3 draws placing every target in a five-hunk packet at cap 5; treatment proof shows 15/5/3 packets with each bug at 1/3/5 hunks and no two bugs sharing a packet; all three arms consumed the same verified plan artifact; the decision table yields Pass, Fail, Void, or Extend-once with no discretion; the capacity pair meets all three numeric gates; spend stays within the ceiling.
9. Record the decision and tear down in a dedicated commit.

   **Preserve evidence first:** copy into `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-dilution/reports/` every produced JSON report, the authored frozen plan, all three reference draws, the realism report and the reference diffs it emits, the treatment proof, the capacity-pair reports, and a `not_run` ledger naming every unreached phase with its stopping reason — then regenerate `manifest.sha256` over the complete set. Do not modify Plan 102's manifest, which its reconciliation note describes as covering exactly three files.

   **If Pass:** make packing unconditional at cap 5; delete both settings and the unpacked path. Keep atoms, partitions, the profile floor, multi-member symbol context, and transactional rejection. Reduce the report script to a golden check. Keep `evals/packet-dilution/` as a standing suite with the shipped cap only, and retain the curve in the reconciliation note.

   **If Fail — including a second Void, a post-extension monotone decline, or any per-bug collapse:** delete the packing pass, both settings, the atom wrapper, and the report script with its tests. Multi-member symbol context survives only if the replay showed it improving context quality with packing off. Keep the fixture and the measured curve — the curve is the durable asset regardless of outcome. Do not leave the feature dark.

   A *first* Void or a *first* monotone decline does not reach this step: each authorizes exactly one bounded rerun under phase B's preregistered limits, and only its result reaches teardown.

   **Verify:** `rg -n "packCompatibleAtoms|packMaxHunks" src scripts tests evals` → exit 1; both manifests verify; the note records the decision, actual spend, and the resolution limit of 18 observations per arm.
10. Run the complete repository gate.

    **Verify:** `pnpm run check && pnpm test && pnpm build` → exit 0.

## Tests and Commands

```bash
pnpm run check
pnpm exec vitest run tests/pipeline-phase5.test.ts tests/config-loader.test.ts tests/evals.test.ts tests/packet-packing-report.test.ts
```

Artifact diagnostics (reproduces this plan's Evidence section, no model calls):

```bash
RUNS=/home/peter/Dev/0xsequence/trails-api/.codegenie/runs
D="$RUNS/20260724-184952-dca8d870 $RUNS/20260724-162739-81f806a6 $RUNS/20260724-135818-740d73f2"
node scripts/packing-diagnostics.mjs pairs $D
node scripts/packing-diagnostics.mjs sweep $D
for p in source compatibility related; do
  node scripts/packing-diagnostics.mjs simulate $D --predicate $p
done
```

Deterministic four-run replay:

```bash
pnpm exec tsx scripts/packet-packing-report.ts replay \
  --repo /home/peter/Dev/0xsequence/trails-api \
  --run $RUNS/20260724-135818-740d73f2 \
  --run $RUNS/20260724-150405-fe1548ae \
  --run $RUNS/20260724-162739-81f806a6 \
  --run $RUNS/20260724-184952-dca8d870 \
  --dispatch-slots 56 \
  --distinct-diffs \
  --output /tmp/plan103-packing-shape.json
```

Fixture validation, planner draw, and the paid curve:

```bash
# 1. expectation wiring, fake provider, $0
pnpm dev eval --eval-dir evals/packet-dilution/shape --no-cache

# 2. three independent reference draws (cache off), then a machine-enforced
#    realism report: >=2 of 3 must place every target in a five-hunk packet at
#    cap 5 and a three-hunk packet at cap 3, else the fixture is invalid
for i in 1 2 3; do
  pnpm exec tsx scripts/draw-pinned-plan.ts \
    --repo evals/packet-dilution/repos/dilution \
    --base main --branch feature --no-cache \
    --output evals/packet-dilution/plans/reference-draw-$i.json
done

pnpm exec tsx scripts/packet-packing-report.ts realism \
  --authored evals/packet-dilution/plans/frozen.json \
  --draw evals/packet-dilution/plans/reference-draw-1.json \
  --draw evals/packet-dilution/plans/reference-draw-2.json \
  --draw evals/packet-dilution/plans/reference-draw-3.json \
  --require-target-hunks 5 --at-cap 5 --min-passing-draws 2 \
  --emit-diffs evals/packet-dilution/plans/reference-diff-{1,2,3}.json \
  --output /tmp/plan103-realism.json

# 3. model-free treatment proof at each cap
pnpm exec tsx scripts/packet-packing-report.ts treatment \
  --pinned-plan evals/packet-dilution/plans/frozen.json \
  --expect-packets 15,5,3 \
  --expect-target-atoms 1,3,5 \
  --output /tmp/plan103-treatment-proof.json

# 4. the paid curve
pnpm dev eval --eval-dir evals/packet-dilution/recall --no-cache

pnpm exec tsx scripts/packet-packing-report.ts treatment \
  --logs evals/packet-dilution/recall/logs \
  --cohort <invocation-uuid> \
  --expected-repeats 6 \
  --require-pinned-plan \
  --break-even <B from phase A> \
  --output /tmp/plan103-recall-curve.json
```

Collateral and capacity:

```bash
pnpm dev eval --eval-dir /tmp/plan103-collateral/fixtures-off --no-cache
pnpm dev eval --eval-dir /tmp/plan103-collateral/fixtures-on  --no-cache
pnpm dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-dilution/capacity --no-cache
```

Evidence preservation and verification:

```bash
D=/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-dilution/reports
cp /tmp/plan103-*.json "$D"/
cp evals/packet-dilution/plans/frozen.json "$D"/
cp evals/packet-dilution/plans/reference-draw-*.json "$D"/
cp evals/packet-dilution/plans/reference-diff-*.json "$D"/   # emitted by the realism report
cp /tmp/plan103-realism.json "$D"/
cp /tmp/plan103-capacity-*.json "$D"/ 2>/dev/null || true   # absent if not reached
# not_run ledger: every unreached phase and why
"$EDITOR" "$D/not-run-ledger.md"
(cd "$D" && sha256sum plan103-*.json frozen.json reference-draw-*.json reference-diff-*.json not-run-ledger.md > manifest.sha256 && sha256sum -c manifest.sha256)
(cd "$D/../../packet-packing/reports" && sha256sum -c manifest.sha256)   # Plan 102 evidence unchanged
```

Note the `pnpm dev eval` spelling: under pnpm 11 a literal `--` reaches Commander and is rejected before suite allocation.

## Acceptance Criteria

- Flag off produces byte-identical packet artifacts, IDs, order, profiles, context, budgets, and `hunk-relationships.json`.
- Flag on reproduces Plan 102's packet counts within 2 per run, every hunk appearing exactly once, hunks ordered within packets by file position and packets by earliest member, under unchanged caps with zero coverage promotion.
- Every member atom with a resolvable primary symbol has its source present after final rendering at or above `MIN_SLICED_MEMBER_CHARS`, or its candidate was abandoned and recorded. Symbol-less members consume no symbol budget, are exempt from that floor, and retain their standalone outline or path quality.
- The 3,000-character non-symbol context reserve is never consumed by symbol source.
- No lens dropped and no `high`/`critical` focus note newly omitted without a recorded abandonment; every effective profile at least the standalone maximum; dispatch ranks unchanged in formula.
- The fixed-slot estimator reproduces exactly 89 hunks on the flag-off packets at 56 slots before it is used for anything; flag-on yield at 56 slots is at least 102; the measured break-even ratio is recorded and used as phase B's bar.
- Per-member profile upgrades, tool-call allowance, context characters, and cost and service time per reviewed hunk are reported off versus on.
- All three curve arms consume one authored plan verified by hash, schema, hunk-ID membership, and diff identity; at least 2 of 3 reference draws confirm the tested partition is one production would plausibly create; treatment is proven model-free at 15/5/3 packets with no two bugs sharing a packet at any cap; the decision table, including per-bug collapse and the bounded Void and extension allowances, is applied without discretion.
- Cross-language shape cases prove packed context on TypeScript, Python, and Solidity; `evals/fixtures/` shows no regression; the capacity pair confirms the predicted yield.
- Paid validation never begins without a recorded ceiling; every phase records actual and projected spend.
- Report failures carry templated structured messages with no raw exception text, repository source, or hashing.
- Teardown leaves one product path with no surviving flag; both evidence manifests verify; Plan 102's manifest is unmodified.
- Checks, tests, and build pass; the decision and the 18-observation resolution limit are documented.

## Stop Conditions

- The flag-off estimator does not reproduce 89 hunks at 56 slots: the proxy is not comparable to the historical baseline and must not define `B` until reconciled.
- Fixed-slot hunk yield below 102, packet reduction below 20%, or deviation from Plan 102's frozen counts above 2: the port is wrong. Fix before spending anything.
- Any atom split or reordered, hunk lost or duplicated, cap exceeded, coverage promoted, profile or budget downgraded, or member context below the minimum without abandonment: fix the deterministic design first.
- Flag-off artifacts change in any respect: stop; parity is the basis of every later comparison.
- The model-free treatment proof does not yield 15/5/3 packets with the target atoms at 1/3/5: fix the fixture and re-prove. Never adjust the sample to fit.
- Any arm consumed a different plan hash: discard and rerun that repeat.
- Fewer than 2 of 3 reference draws place every target in a five-hunk packet at cap 5 and a three-hunk packet at cap 3: the fixture tests a shape production would rarely create. Redesign before any reviewer call.
- `R1 / N < 5/6`: the baseline is too unreliable to measure against. Void; fix the fixture rather than lowering the bar. A second Void is a Fail.
- Any bug with `R1[i] / K >= 5/6` and `R5[i] / K <= 1/6`: per-bug collapse. Fail regardless of the aggregate ratio.
- The capacity pair misses any of its three numeric gates: stop for investigation before shipping.
- Any proposal to apply the initial absolute thresholds to an extended cohort rather than the proportional ones: reject; it halves the baseline bar.
- A monotone decline surviving the single authorized six-repeat extension: Fail. No second extension exists.
- `R5 / R1 < B`: packing costs more recall than the coverage it buys. Fail and take the teardown branch — do not renegotiate `B` after seeing the result.
- A monotone decline `R1 > R3 > R5` that survives extended repeats: treat as a dilution signature and fail, even if the ratio clears.
- Any proposal to raise `MAX_HUNKS_PER_PACKET`, revive relationship signals, or add coverage promotion to recover margin: reject here. Each has a measured Non-Goal entry.
- Actual plus projected spend exceeds the approved ceiling: stop for explicit approval.
- "Keep packing dark" always means *do not ship it in this iteration*; every such outcome terminates in step 9's failure branch in the same change.

## Maintenance Notes

- Any change to `hunkFirstGroups()`, `canJoinGroup()`, `readEnclosingSymbolSource()`, `computeSymbolContextBudget()`, `packetReviewProfile()`, packet caps, `packetDispatchRank()`, or `toolBudget()` invalidates the recorded shape, context, and yield baselines; rerun the replay first.
- The packet-size recall curve is the durable asset from this plan, independent of whether packing ships. Any future proposal to raise caps, pack cross-file, or pack cross-coverage should extend the curve rather than assume it.
- `scripts/packing-diagnostics.mjs` reproduces the relationship and cap-sweep analyses that shaped this plan. Its approximations are documented in its header; the authoritative measurement is the report script's replay.
- Plan 102's preserved reports and paid logs under `codegenie-private-evals/trails-api/packet-packing/` record its failed fixture design and must not be edited. This plan's evidence lives under `packet-dilution/reports/` with its own manifest.
- Reviewers should scrutinize per-member context after final rendering, abandonment reasons, fixed-slot yield, and treatment proof — not packet count, which is Plan 102's already-validated result.
- Commit hashes here are rebase-unstable; locate referenced work by commit subject when a hash does not resolve.
