# Issue 103: Compatible-Atom Packing with Relationship-Ordered Composition

Status: PENDING
Related: Plan 102 (`102-issue-102-same-file-packet-packing.md`) — COMPLETE as a failed treatment gate; its deterministic packing mechanism passed every invariant and is adopted here. Plan 67 (hunk relationship context) built the graph this plan reuses for ordering. Plan 92 (coverage calibration), Plan 100 (dispatch rank), Plan 79 (repeat/recall harness), Plan 32 (adaptive Stage-6 symbol context).
Planned from: Plan 102's preserved evidence under `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-packing/reports/` (manifest verified), plus artifact-only diagnostics over the same retained runs, 2026-07-25
Production replay refs: base/merge-base `d1c49bdf6a8002ec2ec27faac94a932d736532b2`; head `fbb5f8761c2c296e115af17e919a7c35d9de8373`
Planned at: commit `7b61b34` (branch `next`)
Recommended priority: after Plan 101's paid A/B settles.

## Introduction and TL;DR

### The problem

Reviews run out of time before they run out of code. On the motivating pull request, Stage 6 produced **96 packets** covering 142 changed hunks. Only 57 packets were dispatched before the deadline, so **53 hunks received no review at all**.

A packet is one conversation with the model, and most of its cost is fixed — the skill text, the prompt scaffolding, the forced finalization at the end. Measurements from that run show a five-hunk packet costs roughly the same as a one-hunk packet: about 3 model calls and 228 seconds either way. Yet 73 of the 96 packets held a single hunk. We were paying full conversation price to review one hunk at a time.

### What this plan achieves

Group compatible hunks from the same file into fewer, slightly larger packets — about **21% fewer packets**, measured deterministically across four production runs with no model calls.

The point is not a shorter review. It is a **more complete** one. At the same time budget, 21% fewer packets means roughly **108 of 142 hunks reviewed instead of 89**. The win is coverage: fewer changed lines slip past the deadline unreviewed.

A second, smaller benefit: when a packet has room and there is a choice of what to put in it, we prefer hunks that tree-sitter says are *related* — the same function, the same class or receiver type, one mentioning the other. That does not change how many packets exist, only which hunks sit together. A reviewer looking at five functions is then more likely to be looking at five *related* functions, and can notice things like "four of these added a validation check and the fifth didn't."

### How the machinery works

Seven pieces, in the order they run inside Stage 6:

1. **Atoms.** Today's grouper already merges hunks that share an enclosing symbol or sit within 30 lines of each other. We keep it exactly as-is and treat each group it produces as an unbreakable unit. Nothing this plan does ever splits one.

2. **Partitions.** Within each file, atoms are bucketed by two things the planner already decided: the review depth (`light`/`normal`/`deep`) and the set of review lenses requested. Only atoms in the same bucket may be combined. This is what guarantees no hunk is reviewed more shallowly, more expensively, or with different expertise than the planner asked for.

3. **An affinity map.** A private, packing-only map of which atoms are related, built from tree-sitter facts: same symbol, same container (class, Go receiver, Rust `impl`, Python class, Solidity contract), or one symbol mentioning another. It is deliberately kept separate from the relationship data that already feeds review prompts, so turning packing off changes nothing.

4. **Filling.** Walk each bucket in source order, filling a packet until it hits 5 hunks or 12,000 characters. When choosing what to add next, prefer a related atom; otherwise take the next one in source order. Hunks are always *displayed* in source order regardless of what order they were admitted — the code still reads top to bottom.

5. **Safety checks before committing.** Each candidate packet is built in a scratch space first. If merging would drop a review lens, drop an important planner note attached to a high-priority hunk, or lose a function's surrounding source, the merge is abandoned and those atoms stay separate. Nothing is written until a candidate passes.

6. **Context for every member.** If a packet ends up holding three different functions, the reviewer gets all three function bodies, splitting the context budget between them. Today's code reads only one, which would quietly leave the other two as bare diffs.

7. **A floor on review effort.** A merged packet never gets a weaker review profile or a smaller tool budget than its parts would have received alone.

### The risk, and how it gets tested

The obvious danger is **attention dilution**: a bug sitting in a five-hunk packet might get less scrutiny than the same bug alone in its own packet. Nobody has ever measured this — Plan 102 tried and its test fixture was built wrong.

So this plan measures it directly and measures nothing else. One test repository with about ten separated changes in one file, one of which contains a real bug. The same review runs three times over with packets capped at 1, 3, and 5 hunks, six repeats each, all sharing one frozen planning pass so packet size is the only variable. If recall at five hunks is within one hit of recall at one hunk, packing is safe and ships. If it degrades, the whole thing is deleted.

Cost: about **$17** to answer that question, plus an optional $50 production-scale confirmation afterward.

### The outcome, either way

There is no middle state. Either packing becomes permanent, unconditional behavior and the temporary switches are deleted — or packing is removed entirely and the code returns to today's baseline. No flag survives, and no dark code path is left behind.

> **Revision note.** The first draft of this plan (commit `7b61b34`) proposed replacing Plan 102's compatibility predicate with a relationship predicate, on the theory that coverage-grade equality was blocking the packs that mattered. Artifact-only diagnostics disproved that: on the one retained run with usable planner coverage, relationship-required packing yields 4 combinable atom pairs and a 4.2% packet reduction, against Plan 102's measured 21.9%. Coverage inequality blocks 2 of 13 candidate pairs; the 5-hunk cap blocks 7. This revision keeps Plan 102's mechanism and demotes relatedness from a membership predicate to a composition-ordering preference, which is what the evidence supports.

> Executor instructions: adopt Plan 102's compatible-atom packing unchanged in predicate and caps — its deterministic gate passed on four runs and this plan does not relitigate it. Use the relationship graph only to decide *which* compatible atoms share a packet, never how many packets exist, and never to render hunks out of source order. Keep the container-affinity signal out of the shared prompt-context graph. Extend symbol context to every member atom. Do not raise `MAX_HUNKS_PER_PACKET`; the sweep below shows 5 already captures ~80% of achievable compression. The one open question is recall under packing, and the paid phase measures exactly that and nothing else.
>
> **Commit references are rebase-unstable.** Branch `next` was rebased during Plan 102. The Plan 102 series is currently `5551547` (implementation), `8fceba9` (report tool), `7ebfd2f` (report fixes), `87a5a10` (retry docs), `f372f73` (teardown). Locate referenced work by commit subject when a hash does not resolve.
>
> Drift check: `git diff --stat 7b61b34..HEAD -- src/pipeline/packet-builder.ts src/pipeline/review-runner.ts src/repo/symbol-extraction.ts src/config/schema.ts src/config/config-loader.ts src/types.ts src/evals/eval-runner.ts scripts/packet-packing-report.ts tests/pipeline-phase5.test.ts tests/config-loader.test.ts tests/evals.test.ts tests/packet-packing-report.test.ts`
> Working-tree check: `git status --short -- src/pipeline/ src/repo/ src/config/ src/types.ts src/evals/`

## Decision

Ship Plan 102's compatible-atom packing, with relationship-ordered composition, at today's caps.

- Run the existing symbol/proximity grouper unchanged. Its output groups remain indivisible **atoms**.
- Partition a file's atoms by `(effectiveCoverage, normalizedPlannerLensSignature)` — Plan 102's predicate, unchanged. This is where the throughput comes from and it introduces **zero coverage promotion** by construction.
- Fill packets greedily within each partition under the unchanged `MAX_HUNKS_PER_PACKET = 5` and `MAX_PATCH_CHARS = 12_000`.
- **Relatedness decides composition, not count.** When choosing the next atom to admit, prefer one connected to a current member by a packing-affinity edge; fall back to the source-earliest atom that fits. With no relationships present this degrades to Plan 102's exact behavior.
- **Selection order is not render order.** Hunks always render in source order within a packet. Plan 102 conflated the two; they are separate here.
- Symbol context follows membership: multi-symbol packets read every member's primary symbol under a shared budget.
- Lens loss, focus-note loss, and per-member context collapse are prevented by **transactional candidate rejection**, not by narrowing the predicate.
- Plan 102's monotonic profile floor is retained unchanged.
- One mechanism flag plus one experiment-only cap knob, both deleted at teardown. No budget-mode arm.

There is **no coverage promotion anywhere in this plan.** Because the partition key preserves Plan 102's coverage equality, the member-promotion machinery, the `CoverageEscalation` conflict with Plan 92, and the promotion invariants from the first draft are all deleted rather than designed.

## Evidence

### Plan 102's mechanism passed its deterministic gate

Four-run replay, zero model calls, zero failures: `740d73f2` 109→85, `fe1548ae` 109→85, `81f806a6` 93→68, `dca8d870` 96→75 — 21.9–26.9% fewer packets with zero coverage promotions, zero effective profile or budget downgrades, zero cap violations, zero lens drops, and zero invalid dispatch ranks. Only the paid recall gate failed, and it failed on fixture treatment, never on recall. This plan adopts that mechanism rather than rebuilding it.

Note `740d73f2` and `fe1548ae` are the same commit, and all four retained runs are the same PR. This is one PR sampled at three head commits, not four independent samples. Every threshold below counts distinct diffs.

### Relationship-required packing is not a viable throughput mechanism

Artifact-only diagnostics over `dca8d870` (the only retained run with usable planner coverage — `740d73f2` has 0 surviving planner entries and `81f806a6` has 2):

| Measure | Value |
| --- | ---: |
| Atom pairs adjacent under strong + container edges, same file, currently split | 13 |
| — blocked by the 5-hunk / 12K caps | 7 |
| — blocked by coverage inequality | 2 |
| — eligible to pack | 4 |
| Simulated packet reduction, relationship-required predicate | 96→92 (4.2%) |
| Same, at a hypothetical 8-hunk cap | 96→89 (7.3%) |

Relationships between *distinct atoms* are sparse: today's grouper already absorbs most same-symbol adjacency into atoms, so what remains is thin. Relatedness cannot carry a throughput plan. It can, however, decide composition for free.

### Coverage inequality is not the blocker

Planner grades on `dca8d870` were deep:14, normal:14, light:2, skip:2 across 32 entries; the other 110 reviewed hunks take the `normal` default. Of 13 adjacent atom pairs, only 2 cross a coverage grade, and both come from `planner_hint` edges — **zero structural (`same_symbol`, `symbol_mention`, container) pairs cross a grade.**

This retires the first draft's central claim. Plan 102's coverage-equality partition was self-defeating in a *fixture*, where the planner grades every hunk; in production it grades 23% of them and the rest share a default. Retaining coverage equality costs 2 of 13 opportunities and removes an entire subsystem.

It also retires the proposed stage reordering — showing the planner hunk groups so it grades siblings consistently solves a problem that occurs twice per PR.

### The 5-hunk cap is near-optimal, not arbitrary

A cap sweep under Plan 102's predicate, using a simulator validated against Plan 102's real implementation (cap 5/12K reproduces 76/68/85 packets against the measured 75/68/85 — within one packet on all three runs):

| Cap | `dca8d870` | `81f806a6` | `740d73f2` | Packets >5 hunks |
| --- | --- | --- | --- | ---: |
| 5h/12K (today) | 96→76 (20.8%) | 93→68 (26.9%) | 109→85 (22.0%) | 0 |
| 6h/12K | 96→75 (21.9%) | 93→65 (30.1%) | 109→81 (25.7%) | 2–4 |
| 8h/12K | 96→73 (24.0%) | 93→64 (31.2%) | 109→80 (26.6%) | 4–5 |
| 10h/16K | 96→71 (26.0%) | 93→61 (34.4%) | 109→77 (29.4%) | 5–6 |
| 12h/24K | saturated — no further change | | | |

The predicate is worth ~21 points; the cap is worth ~5 more before saturating, because partitions run out of compatible atoms rather than hitting the cap. Raising it trades a handful of oversized packets for a few points of compression and enlarges the untested recall risk. **The cap stays at 5.**

### The value is run-level coverage, and the risk is packet-level recall

Plan 102's Stage 7 spent 174 model calls, 5.321M tokens, `$22.85`, and 52.7 concurrency-normalized minutes on 57 dispatched packets, reviewing 89 of 142 reviewable hunks before the deadline. Forced finalization alone was 34 calls, 1.037M input tokens, and `$6.71` of pure per-packet overhead. Observed per-packet cost is roughly flat in packet size:

| Packet size | n | Avg calls | Avg input tokens | Avg model-service seconds |
| --- | ---: | ---: | ---: | ---: |
| 1 hunk | 41 | 3.10 | 91,585 | 228 |
| 2 hunks | 8 | 3.00 | 67,433 | 206 |
| 3 hunks | 3 | 2.67 | 77,940 | 158 |
| 4–5 hunks | 5 | 3.00 | ~109,000 | 228 |

So a 21% packet reduction at a fixed time budget is worth roughly 19 more reviewed hunks on that run — 89/142 to ~108/142. That is the payoff, and it is run-level recall.

Against it stands packet-level recall: a hunk sharing a packet may be reviewed less attentively. **Nobody has measured that.** Plan 102 tried and its fixture never produced the treatment; the first draft of this plan proposed to try again with different machinery. It is one curve, it is the same question under every predicate, and it is the only thing standing between this mechanism and rollout. The paid phase measures it directly and measures nothing else.

## Current State

- `hunkFirstGroups()`/`canJoinGroup()` join same-file hunks by identical enclosing symbol or `NEARBY_GAP_LINES = 30` proximity. Baseline restored after Plan 102's teardown.
- `buildHunkRelationshipGraph()` produces `same_symbol` (`strong`), `planner_hint` (`strong` for symbol hints, `medium` for file hints), and `symbol_mention` (`strong` with an enclosing symbol, else `medium`) edges, capped at `MAX_RELATIONSHIP_EDGES_PER_HUNK = 8`, dropped on overflow in insertion order.
- `addSymbolMentionEdges()` guards ambiguity (`sourceIdentities.size > 1` → skip); `addPlannerHintEdges()` has no equivalent guard.
- `buildRelatedChangedContext()` consumes every non-`weak` edge whose target is outside the packet, capped at `MAX_RELATED_CONTEXTS_PER_PACKET = 3`. Any new `medium` edge source added to the shared graph would change flag-off context, notes, repository reads, and profiles.
- `buildPacket()` derives `reviewProfile` after related-context filtering, so absorbing a strong edge can lower the derived profile — the reason Plan 102's floor exists.
- `readEnclosingSymbolSource()` reads one symbol for the whole packet, and `computeSymbolContextBudget()` selects `multiple_symbols_keep_compact` when `singlePrimarySymbol` is false. Packing distinct symbols therefore drops non-primary members' surrounding source, and the coarse `contextQuality` grade does not register it.
- `SymbolInfo` carries `ownerType` (Go receivers, TypeScript classes, Rust `impl`/trait owners, Python classes, Solidity contracts); `generic-adapter.ts` does not. `HunkSymbolFacts` carries neither it nor `packageName`. `packet-context.ts:154` already resolves an owner structurally by name and kind.
- `pnpm test -- <file>` does **not** filter — it runs the full suite and drops the argument (verified). This plan uses `pnpm exec vitest run <file>`.
- Plan 102's implementation is recoverable at `5551547` and its report harness at `7ebfd2f`, including `safeFailureOutput()`, which hashed every failure message and is not ported.
- There is no seam to supply a pre-recorded Stage-5 plan to a review.

## Goal

1. Land Plan 102's packing mechanism unchanged in predicate and caps, so the measured 21–27% packet reduction is available.
2. Use relatedness to improve packet composition at zero cost to packet count.
3. Close the gap Plan 102 left open in symbol context, per-member quality, and note pressure, so bigger packets are not quietly worse packets.
4. Measure recall as a function of packet size — the single curve that decides whether packing ships.
5. End in exactly one product path with no surviving flag, under either outcome.

## Design

### 1. Atoms and partitions — Plan 102, unchanged

Wrap `hunkFirstGroups()` output as atoms carrying ordered hunks, hunk count, `combinedPatchChars()` size, first source position, effective coverage, routed lenses, standalone review profile and context quality, and a stable ID from ordered hunk IDs. Partition each file's atoms by `(effectiveCoverage, normalizedPlannerLensSignature)`. Direct `whole-file` and content-probed `file-diff` returns bypass packing.

### 2. Structural container identity

Add `ownerType?: string` and `ownerKey?: string` to `HunkSymbolFacts` in `src/repo/symbol-extraction.ts`. `ownerKey` is structural — `${path}:${ownerName}:${ownerStartLine}-${ownerEndLine}`, resolved through the owner lookup `packet-context.ts:154` already performs — so duplicate or nested same-named containers never collide. Absent where the owner cannot be resolved structurally. `packageName` is constant within a file and is not plumbed.

### 3. A separate packing-affinity view

`same_container` is **not** added to `HunkRelationshipGraph`; doing so would change flag-off excerpts, notes, repository reads, profiles, and — through `MAX_RELATIONSHIP_EDGES_PER_HUNK` overflow — which existing edges survive.

Build a `PackingAffinity` view per file, only when packing is on:

- **derived** edges copied from the relationship graph: `same_symbol`, `strong` `symbol_mention`, and `strong` `planner_hint` that resolves uniquely (its normalized symbol key matches exactly one changed symbol identity in the file, mirroring `addSymbolMentionEdges()`'s existing guard);
- **structural** edges: `same_container`, for hunk pairs sharing a non-empty `ownerKey`;
- no per-hunk cap, because this view is never rendered and cannot evict prompt context.

### 4. Relationship-ordered greedy fill

Within a partition, atoms sorted by first source position:

1. Seed with the source-earliest unassigned atom.
2. Admit the **source-earliest unassigned atom connected by an affinity edge to any current member** that fits `MAX_HUNKS_PER_PACKET` and `MAX_PATCH_CHARS`.
3. If no related atom fits, admit the source-earliest unassigned atom in the partition that fits — Plan 102's rule.
4. Flush when nothing fits; seed the next packet.
5. Order packets by first source position. **Render every packet's hunks in source order**, independent of admission order.

With no affinity edges this is byte-for-byte Plan 102's behavior, which makes the deterministic comparison exact: the replay reports how many packets differ in composition from the Plan 102 ordering, and packet *count* should differ by at most a small bin-packing residual.

### 5. Symbol context follows membership

For a packed packet whose members hold more than one distinct primary symbol identity, read enclosing-symbol source for **every** member's primary symbol: allocate each `floor(symbolContextBudget / memberSymbolCount)`, preserve the existing adaptive/sliced selection per member, render in source order, and record `contextQuality` per member alongside the packet grade.

This is the one place Plan 102's mechanism is genuinely improved rather than reused — it shipped a packer that could drop non-primary members' surrounding source without registering it.

### 6. Transactional candidate evaluation

Every candidate is dry-built against a cloned relationship accumulator and a suppressed telemetry sink; nothing reaches the real graph, artifacts, or event stream until commit. A candidate is abandoned — leaving its atoms separate — when the combined packet would:

- drop a lens any member routed standalone;
- newly omit a planner focus note belonging to a `high`/`critical` hunk;
- reduce any member's context quality below `sliced`;
- lower the effective profile below the maximum standalone member profile.

Each abandonment is recorded with a reason code and the atoms involved.

### 7. Profile floor

Plan 102's floor, retained verbatim: `effectiveReviewProfile = max(derivedPackedProfile, max(standalone member profiles))` over `{ simple: 0, standard: 1, investigate: 2 }`, never lexical comparison. `dispatchRank` is recomputed with the unchanged `packetDispatchRank(filePath, facts, combinedChangedLines)` formula.

### 8. Configuration

```yaml
review:
  packCompatibleAtoms: false   # mechanism gate
  packMaxHunks: 5              # experiment-only; the dilution curve varies this
```

Both in raw and resolved schemas, `CodegenieConfig`, defaults, config-source tracking, repo-safe filtering, the strict eval-case `review` schema, and `applyCaseReviewConfig()`. `packMaxHunks` exists solely to run the recall curve and never exceeds `MAX_HUNKS_PER_PACKET` in shipped behavior. Both are deleted in step 9.

Separately, an **eval-only** pinned-plan seam: a planner-draw mode writing a `ReviewPlan` plus its SHA-256, and an eval-case field (`review.pinnedPlanDir`) supplying execution *k* with plan *k*, validated by hash and exact `hunkId` membership, failing closed on mismatch. No user-facing config path. It survives teardown only if independently useful to other eval work.

## Validation Strategy

### A. Free deterministic replay

Port `scripts/packet-packing-report.ts` from `7ebfd2f` down to `replay` plus `treatment`. Failure records are **structured and templated** — a closed-set `code`, structured fields, and a message rendered from a template. No raw exception text, no repository source, no hashing.

Run over the four retained runs and assert:

- packet counts reproduce Plan 102's frozen result (96→75, 93→68, 109→85) within a documented bin-packing residual of at most 2 packets per run, attributable solely to admission order;
- every reviewable hunk appears exactly once, **in source order**;
- no atom split or reordered; no new coverage promotion; caps, file, lens, and note bounds hold;
- no lens dropped, no `high`/`critical` focus note newly omitted, no member context below `sliced` — or the candidate was abandoned and recorded;
- no effective profile or budget below the maximum standalone member value;
- every dispatch rank equals the existing formula;
- flag off is artifact-identical to current behavior, **including `hunk-relationships.json`**, proving the affinity view never wrote back.

Report per run: packets off→on, composition changes versus Plan 102 ordering, affinity edges split `derived`/`structural`, abandoned candidates by reason, per-member context-quality distribution, notes dropped, excerpts internalized, and scheduling movement.

**Pre-registered gates**, counted on the two distinct diffs:

| Gate | Threshold |
| --- | --- |
| Packet reduction | `>= 20%` per distinct diff |
| Deviation from Plan 102's frozen packet count | `<= 2` packets per run |
| Packets whose composition changed under relationship ordering | `>= 2` per distinct diff |
| Members whose context quality falls below `sliced` | `0` |
| New coverage promotions | `0` |

Missing the third gate means relationship ordering changes nothing measurable — drop `ownerKey`, `same_container`, and the affinity view, and ship Plan 102's ordering unchanged. That is a cheap, free deletion, not a plan failure.

### B. The recall-versus-packet-size curve (paid)

This is the only paid question. It is not about which predicate to use; it is whether review quality survives packing at all.

**Fixture.** One Go file under `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-dilution/recall/` with about ten separated single-hunk changes — far enough apart that today's grouper yields one atom each — sharing coverage and lenses so they all land in one partition. One hunk carries a locally detectable bug; the rest are safe. Expectations constrain path, line range, and failure mode, and **accept any plausible category**: Plan 102 recorded three executions that found its bug and scored `partial-match` solely because the expectation demanded `correctness` and the reviewer said `security`.

**Arms.** Identical cases differing only in `packMaxHunks`: 1 (one atom per packet — today's behavior), 3, and 5 (the shipping cap). `repeat: 6`, cache off. Each repeat draws one Stage-5 plan, hashed, consumed by all three arms, so packet size is the only within-repeat difference while planner variance is still sampled across repeats.

**Pre-registered decision table**, where `R1`, `R3`, `R5` are hits out of 6:

| Condition | Outcome |
| --- | --- |
| `R1 <= 1` | **Void.** The bug is not reliably findable even unpacked; redesign the fixture. |
| `R5 >= R1 - 1` | **Pass.** Packing is non-inferior at the shipping cap. |
| `R5 <= R1 - 2`, or `R1 > R3 > R5` | **Fail.** Recall degrades with packet size; do not ship packing at any predicate. |
| otherwise | **Inconclusive.** Record; do not ship. |

This is a non-inferiority test, and deliberately so: the *benefit* — roughly 19 more reviewed hunks per run — is already measured deterministically, so packing only has to avoid harming per-packet recall. The first draft demanded superiority because it was claiming a quality benefit; this plan claims a coverage benefit and a quality guard, which is the honest framing.

Also report tokens, model-service time, and cost per reviewed hunk per arm — the efficiency side of the same curve.

Relationship ordering gets **no paid arm.** It changes composition in a handful of packets per run, an effect far too small to resolve at `n = 6`. It cannot reduce packet count or violate any invariant, it is validated deterministically in phase A, and it is adopted or dropped on that basis alone. Do not spend paid budget on an effect you cannot measure.

### C. Collateral and capacity

1. `evals/fixtures/` flag-off and flag-on at `repeat: 1`, fake provider. Every expectation, packet invariant, and config parse must match.
2. `evals/skill-semantics/` (TypeScript, Python, Solidity) flag-off and flag-on at `repeat: 1`. An A-pass/B-fail difference is stop-for-investigation; rerun only that case at `repeat: 3`.
3. One production-shaped capacity pair on the pinned `trails-api` diff at concurrency 6, flag-off and flag-on, reporting reviewed-hunk set, packet count, model-service time, tokens, and cost per reviewed hunk. Its purpose is to confirm the run-level coverage gain the deterministic replay predicts.

### Cost discipline

No paid call before `approvedValidationCostUSD` is recorded here; the owner supplies the amount.

| Phase | Executions | Projection |
| --- | ---: | ---: |
| Dilution preflight (1 plan draw + 3 arms) | 4 | ~$3 |
| Dilution curve, 6 repeats × 3 arms | 18 | ~$14 |
| `evals/fixtures/` (fake provider) | — | $0 |
| `evals/skill-semantics/`, both arms | 6 | ~$5 |
| Production capacity pair | 2 | ~$50 |
| Contingency 25% | — | ~$18 |
| **Reservation** | | **~$90** |

The production pair dominates and runs last, only after a pass. If the ceiling is tight, phases 1–2 alone cost ~$17 and decide whether packing ships.

## In-Scope Files

- `src/repo/symbol-extraction.ts` — `ownerType`, structural `ownerKey`.
- `src/pipeline/packet-builder.ts` — atoms, partitions, affinity view, relationship-ordered fill, multi-member symbol context, transactional candidates, profile floor, telemetry.
- `src/pipeline/review-runner.ts` — eval-only pinned-plan seam.
- `src/types.ts` — `ownerType`/`ownerKey`, per-member context-quality telemetry, both temporary config fields.
- `src/config/schema.ts`, `src/config/config-loader.ts`, `src/evals/eval-runner.ts` — flag plumbing and `pinnedPlanDir`.
- `scripts/packet-packing-report.ts`, `tests/packet-packing-report.test.ts` — `replay` and `treatment` with templated failure records.
- `tests/pipeline-phase5.test.ts`, `tests/config-loader.test.ts`, `tests/evals.test.ts`, and the symbol-extraction suite.
- `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-dilution/` — fixture, cases, pinned plans, immutable logs, reports.
- `specs/plans/README.md` and affected `specs/project/` docs.

## Non-Goals

- **Raising `MAX_HUNKS_PER_PACKET` or `MAX_PATCH_CHARS`.** The sweep shows 5 captures ~80% of achievable compression; 10 adds ~5 points before saturating and enlarges untested recall risk. `packMaxHunks` exists only to measure the curve and never ships above 5.
- **Relationship-required packing as a membership predicate.** Measured at 4.2% versus 21.9%; retired by evidence.
- **Cross-coverage packing and any coverage-promotion machinery.** 2 of 13 candidate pairs, zero of them structural.
- **Reordering the stage flow.** The planner grades related siblings consistently in 132 of 134 measured pairs; there is nothing for a group-aware dossier to fix.
- Cross-file packing — the packet schema is file-scoped, and cross-file relatedness is already served by related-context excerpts.
- Tool-budget changes of any kind, including Plan 102's retired `atom-scaled` arm.
- Changing prompt templates, attention-note ordering, `canJoinGroup()` semantics, Plan 100's dispatch policy, or Plan 92's escalation rules.
- Exposing either config field as user-facing surface, or leaving either dark after step 9.

## Implementation Steps

1. Reconcile the drift and working-tree checks. Add `ownerType` and structural `ownerKey` to `HunkSymbolFacts`.

   **Verify:** `pnpm exec vitest run tests/pipeline-phase5.test.ts -t "container identity"` → exit 0; all five real adapters resolve owners, generic-adapter files resolve none, and two same-named classes in one file produce distinct keys.
2. Add both dark config fields end-to-end, including strict eval schema, `applyCaseReviewConfig()`, defaults, repo-safe filtering, and source tracking.

   **Verify:** `pnpm exec vitest run tests/config-loader.test.ts tests/evals.test.ts` → exit 0; defaults `false`/`5`, overrides apply, `packMaxHunks` above 5 is rejected.
3. Wrap `hunkFirstGroups()` output as atoms with standalone coverage, lenses, profile, and context quality captured through the scratch path; add flag-off golden parity.

   **Verify:** `pnpm exec vitest run tests/pipeline-phase5.test.ts -t "packet atom|flag-off parity|whole-file bypass"` → exit 0.
4. Implement Plan 102 partitions and greedy fill, with no relationship ordering yet, and prove it reproduces Plan 102's frozen counts.

   **Verify:** `pnpm exec vitest run tests/pipeline-phase5.test.ts -t "compatible partition"` → exit 0; hunk bijection, source-order rendering, cap splits, interleaved partitions, degradation merge, and the exact dispatch-rank formula.
5. Build the `PackingAffinity` view and add relationship-ordered admission.

   **Verify:** `pnpm exec vitest run tests/pipeline-phase5.test.ts -t "packing affinity|relationship ordering"` → exit 0; the relationship graph and all flag-off artifacts are unchanged; ambiguous repeated symbol names produce no edge; with no edges the fill is identical to step 4; with edges, composition changes while hunks still render in source order.
6. Implement multi-member symbol context and per-member context-quality recording.

   **Verify:** `pnpm exec vitest run tests/pipeline-phase5.test.ts -t "member symbol context"` → exit 0; a two-symbol packet carries both symbols; `full`→`sliced` is reported and allowed; a member falling to `outline_only` aborts the candidate.
7. Implement transactional candidate evaluation and the profile floor.

   **Verify:** `pnpm exec vitest run tests/pipeline-phase5.test.ts -t "candidate rejection|profile floor"` → exit 0; abandoned candidates leave no residue; lens-drop, `high`-priority note-drop, and context-collapse candidates abort; the floor holds when an absorbed strong edge would derive lower.
8. Add the pinned-plan seam, port the report script, and run the four-run replay. Record the table and every gate here.

   **Verify:** `pnpm exec vitest run tests/packet-packing-report.test.ts tests/evals.test.ts -t "pinned plan"` → exit 0; the replay exits 0 with `modelCallsObserved: 0` on every row and every section-A gate satisfied. If the composition gate fails, delete the affinity view and container identity, re-run, and continue with Plan 102 ordering.
9. Record the ceiling, build the dilution fixture, and run: preflight, the 6×3 curve, `evals/fixtures/`, `evals/skill-semantics/`, then the capacity pair. Apply the decision table verbatim.

   **Verify:** each repeat's three arms consumed one hash-verified plan; the decision table yields Pass, Fail, Void, or Inconclusive with no discretion; collateral shows no reproducible regression; spend stays within the ceiling.
10. Record the decision and tear down in a dedicated commit.

    **Preserve evidence first:** copy every produced JSON report and the pinned plans into `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-dilution/reports/` with a `manifest.sha256`. Mark unreached phases `not_run` with their stopping reason.

    **If Pass:** make packing unconditional at cap 5; delete both config fields and the unpacked path. Keep atoms, partitions, the profile floor, multi-member symbol context, transactional rejection, and — if the composition gate passed — `ownerKey`, `same_container`, and the affinity view. Reduce the report script to a golden check against frozen packet shapes.

    **If Fail, Inconclusive, or Void:** delete the packing pass, both fields, the atom wrapper, the affinity view, and the report script with its tests. Multi-member symbol context survives only if the replay showed it improving context quality with packing off. A Void permits one fixture redesign and rerun; a second Void takes the failure branch. Do not leave the feature dark.

    **Verify:** `rg -n "packCompatibleAtoms|packMaxHunks" src scripts tests evals` → exit 1; the manifest verifies; the note records the decision table result, actual spend, and the `n = 6` limitation.
11. Run the complete repository gate.

    **Verify:** `pnpm run check && pnpm test && pnpm build` → exit 0.

## Tests and Commands

```bash
pnpm run check
pnpm exec vitest run tests/pipeline-phase5.test.ts tests/config-loader.test.ts tests/evals.test.ts tests/packet-packing-report.test.ts
```

Deterministic four-run replay:

```bash
pnpm exec tsx scripts/packet-packing-report.ts replay \
  --repo /home/peter/Dev/0xsequence/trails-api \
  --run /home/peter/Dev/0xsequence/trails-api/.codegenie/runs/20260724-135818-740d73f2 \
  --run /home/peter/Dev/0xsequence/trails-api/.codegenie/runs/20260724-150405-fe1548ae \
  --run /home/peter/Dev/0xsequence/trails-api/.codegenie/runs/20260724-162739-81f806a6 \
  --run /home/peter/Dev/0xsequence/trails-api/.codegenie/runs/20260724-184952-dca8d870 \
  --compare-ordering source \
  --distinct-diffs \
  --output /tmp/plan103-packing-shape.json
```

Expected: exit 0, four rows with duplicate diffs marked and counted once, zero model calls, packet counts within 2 of Plan 102's frozen 75/68/85, and a composition-change block.

Dilution curve:

```bash
pnpm dev eval \
  --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-dilution/recall \
  --no-cache

pnpm exec tsx scripts/packet-packing-report.ts treatment \
  --logs /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-dilution/recall/logs \
  --cohort <invocation-uuid> \
  --expected-repeats 6 \
  --require-pinned-plan \
  --output /tmp/plan103-dilution-curve.json
```

Note the `pnpm dev eval` spelling: under pnpm 11 a literal `--` reaches Commander and is rejected before suite allocation.

## Acceptance Criteria

- Flag off produces byte-identical packet artifacts, IDs, order, profiles, context, budgets, and `hunk-relationships.json`.
- Flag on reproduces Plan 102's packet counts within 2 per run, with every reviewable hunk appearing exactly once in source order, under unchanged caps and with zero coverage promotion.
- Relationship ordering changes composition, never render order, and never increases packet count beyond the documented bin-packing residual.
- No lens dropped, no `high`/`critical` focus note newly omitted, no member context below `sliced`; violating candidates are abandoned transactionally and recorded.
- Every effective profile is at least the maximum standalone member profile; dispatch ranks use Plan 100's unchanged formula.
- The replay exits 0 with zero model calls and satisfies every pre-registered gate on both distinct diffs.
- Every dilution repeat's three arms consume one hash-verified Stage-5 plan; the decision table is applied without discretion.
- Collateral suites show no reproducible regression; the capacity pair confirms the predicted run-level coverage gain.
- Paid validation never begins without a recorded ceiling; every phase records actual and projected spend.
- Report failures carry templated, structured messages with no raw exception text, no repository source, and no hashing.
- Teardown leaves one product path with no surviving flag, and preserves every report and pinned plan under a verified manifest.
- Checks, tests, and build pass; the decision and the `n = 6` limitation are documented.

## Stop Conditions

- Packet reduction below 20% per distinct diff, or deviation from Plan 102's frozen counts above 2 packets: the port is wrong, not the mechanism. Fix before proceeding.
- Composition-change gate below 2 packets per distinct diff: delete the affinity view and container identity and continue with Plan 102 ordering. Not a plan failure.
- Any atom split or reordered, hunk lost or duplicated, cap exceeded, coverage promoted, profile or budget downgraded, or member context collapsed without abandonment: fix the deterministic design before spending anything.
- The affinity view mutates the relationship graph, or flag-off artifacts change: stop; isolation is the basis of every later comparison.
- A dilution repeat's arms consumed different Stage-5 plans, or a pinned-plan hash or `hunkId` set fails validation: discard that repeat and rerun it.
- The decision table returns Fail: packing does not ship at any predicate or cap. Take the failure branch and record the curve.
- The decision table returns Void twice: take the failure branch rather than redesigning a third time.
- Any proposal to raise `MAX_HUNKS_PER_PACKET` to recover compression: reject it here. It is a separate question with its own untested recall risk, and the sweep says it is worth ~5 points.
- Actual plus projected spend exceeds the approved ceiling: stop for explicit approval. Do not weaken a gate to fit a budget.
- "Keep packing dark" always means *do not ship it in this iteration*; every such outcome terminates in step 10's failure branch in the same change.

## Maintenance Notes

- Any future change to `hunkFirstGroups()`, `canJoinGroup()`, the relationship edge builders, `buildRelatedChangedContext()`, `readEnclosingSymbolSource()`, `computeSymbolContextBudget()`, `packetReviewProfile()`, packet caps, `packetDispatchRank()`, or `toolBudget()` invalidates the recorded shape, context, and order baselines; rerun the replay first.
- Reviewers should scrutinize affinity-view isolation, composition changes, per-member context quality, abandonment reasons, and pinned-plan provenance — not packet count, which is Plan 102's already-validated result.
- Plan 102's preserved reports and paid logs under `codegenie-private-evals/trails-api/packet-packing/` remain the record of its failed fixture design and must not be edited or deleted.
- The recall-versus-packet-size curve produced here is the reusable asset. Any future proposal to raise caps, pack cross-file, or pack cross-coverage should extend that curve rather than assume it.
- Commit hashes in this document are rebase-unstable. Locate referenced work by commit subject when a hash does not resolve.
