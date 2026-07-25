# Issue 103: Relationship-Driven Same-File Packet Packing

Status: PENDING
Related: Plan 102 (`102-issue-102-same-file-packet-packing.md`) — COMPLETE as a failed treatment gate; supplies the atom implementation, the deterministic replay harness, and the negative result this plan is built from. Plan 67 (hunk relationship context) built the graph this plan spends differently. Plan 92 (coverage calibration and escalation) supplies the coverage-promotion precedent and the noisy-grade evidence. Plan 100 (dispatch rank), Plan 79 (repeat/recall harness), Plan 32 (adaptive Stage-6 symbol context).
Planned from: Plan 102's preserved evidence — `plan102-packet-shape.json`, `plan102-eval-preflight-invalid-ace65769.json`, and `plan102-eval-preflight-retry-invalid-5bd80f2c.json` under `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-packing/reports/` (manifest verified) — plus the same four retained runs, 2026-07-25
Production replay refs: base/merge-base `d1c49bdf6a8002ec2ec27faac94a932d736532b2`; head `fbb5f8761c2c296e115af17e919a7c35d9de8373`
Planned at: commit `f372f73` (branch `next`)
Recommended priority: after Plan 101's paid A/B settles. Plan 102's deterministic half already passed; its paid half never asked the question. This plan changes the packing predicate so the question becomes askable, and isolates Stage 6 so the answer is attributable.

> Executor instructions: pack by the relationship graph that already exists, not by the planner's coverage grade. Preserve today's semantic grouper output as indivisible **atoms** exactly as Plan 102 did. Grow packets by connectivity-preserving greedy expansion — never chunk a component by source order, and never require contiguity. Keep the container-affinity signal out of the shared prompt-context graph entirely. Allow coverage promotion only through a packing-eligible edge, and record it per member, not on Plan 92's packet-level field. Extend symbol context to every member atom before packing multi-symbol atoms. Prove the treatment surface deterministically and for free before spending a model call, and pin one Stage-5 plan across both arms of every paid pair so packing is the only difference. Ship exactly one temporary flag; there is no budget-mode arm.
>
> **Commit references are rebase-unstable.** Branch `next` was rebased between Plan 102's teardown and this plan. The Plan 102 series is currently `5551547` (implementation), `8fceba9` (report tool), `7ebfd2f` (report fixes), `87a5a10` (retry docs), `f372f73` (teardown). If those hashes are unreachable, locate them by commit subject rather than trusting the hash.
>
> Drift check: `git diff --stat f372f73..HEAD -- src/pipeline/packet-builder.ts src/pipeline/review-runner.ts src/repo/symbol-extraction.ts src/repo/tree-sitter/ src/config/schema.ts src/config/config-loader.ts src/types.ts src/evals/eval-runner.ts scripts/packet-packing-report.ts tests/pipeline-phase5.test.ts tests/config-loader.test.ts tests/evals.test.ts tests/packet-packing-report.test.ts`
> Working-tree check: `git status --short -- src/pipeline/ src/repo/ src/config/ src/types.ts src/evals/`
> If the drift check reports committed changes, reconcile the current-state claims below. If the working-tree check reports changes owned by another task, stop and wait for that work to land or move this plan to an isolated worktree.

## Decision

Pack same-file atoms that the existing hunk relationship graph already relates, and stop using the planner's per-hunk coverage grade as a partition key.

- Run the existing symbol/proximity grouper unchanged. Its output groups remain indivisible **atoms**, exactly as in Plan 102.
- Build a **separate packing-affinity view** over the atoms of one file. It is derived from the relationship graph but never written back into it: the prompt-context graph, its per-hunk edge cap, its excerpts, and its attention notes stay byte-identical with the flag off.
- An atom pair is adjacent when any hunk of one has a **packing-eligible** edge to any hunk of the other: `same_symbol`, strong `symbol_mention`, uniquely-resolved strong `planner_hint`, or the new `same_container`.
- Grow packets by **connectivity-preserving greedy expansion**: start from the source-earliest unassigned atom, then repeatedly admit the source-earliest atom that has an eligible edge into the current packet set and fits the caps. Never chunk a connected component by source order; never require source contiguity.
- **Coverage promotion is permitted and recorded per member**, not banned and not folded into Plan 92's packet-level escalation field.
- **Symbol context follows membership.** Packing multiple primary symbols into one packet extends symbol-source reading to every member atom under a shared budget, rather than silently keeping only the top-ranked one.
- Lens intent, focus notes, and per-member context quality are protected by **transactional candidate rejection**, not by partitioning.
- Plan 102's monotonic profile floor is retained unchanged.
- One temporary flag, `review.packRelatedHunks`. One budget policy — today's. No `atom-scaled` arm.
- Every paid pair consumes **one pinned Stage-5 plan**, so the arms differ only by packing.

This is a different bet from Plan 102. That plan optimized packet count and treated relatedness as a nice-to-have; this plan optimizes cross-hunk reasoning and treats packet reduction as a secondary, reported effect that may well be negative.

## Evidence

### Plan 102's deterministic mechanics worked; its predicate did not

The four-run replay passed every invariant with zero model calls: `740d73f2` 109→85, `fe1548ae` 109→85, `81f806a6` 93→68, `dca8d870` 96→75, with zero coverage promotions, zero effective profile or budget downgrades, zero cap violations, zero lens drops, and zero invalid dispatch ranks. Atom preservation, hunk bijection, source ordering, profile floors, and dispatch-rank recomputation are proven machinery. This plan reuses them and changes which atoms are eligible to combine.

Note that `740d73f2` and `fe1548ae` are the same commit and PR — identical 109→85 rows. There are two distinct diffs among the four retained runs, and every threshold in this plan counts distinct diffs.

### The coverage/lens predicate was self-defeating

Both paid cohorts failed on treatment validity, never on recall. In the repaired retry (`5bd80f2c`), consistency B and C were each treated `0/1`: the planner graded the target `HandleWire` hunk `deep` and its three safe siblings `light`, so the compatibility partition correctly refused to pack them. The first cohort failed the same way.

This is structural. A recall fixture needs a detectably risky hunk among safe siblings; the planner grades the risky one differently. Under a coverage-equality predicate, **any hunk interesting enough to carry a recall expectation is by construction unpackable**. Freezing the planner output does not fix that; only changing the predicate does.

### The codebase already contradicts the predicate

`applyCoverageEscalations()` exists because of Plan 92, and its own comment states the case:

> the planner's deep/normal assignment is a one-draw LLM judgment with measured run-to-run variance (the erc20 packet: normal in runs 46-50, deep in 51); these rules floor structurally suspicious packets to deep so attention amplification (budgets, ensemble passes) stops depending on the planner's mood

Plan 92 concluded that grade is too noisy to trust and added structural correction. Plan 102 then used the same grade as an inviolable partition key. This plan resolves the inconsistency in Plan 92's direction.

### The relationship signal is already computed and currently spent on lossy excerpts

`buildHunkRelationshipGraph()` runs before packet construction and produces strength-graded `same_symbol`, `symbol_mention`, and `planner_hint` edges from tree-sitter enclosing-symbol facts and `findSymbolMentions(..., contextMode: "symbols")`. Those edges buy a `relatedChangedContext` excerpt — capped at three per packet, 2,500 source and 1,500 patch characters each — plus a profile nudge. `buildRelatedChangedContext()` explicitly *skips* an edge whose target already sits in the packet, because membership makes the excerpt redundant.

Plan 102 made this argument and did not act on it: *"The relationship graph and related-context machinery try to reconstruct this adjacency later, with caps and omissions; safe same-file packing supplies it directly."*

### Promotion through an edge is cheaper than the split it replaces

A deep atom and four related light atoms cost five model conversations and `10 + 4×1 = 14` tool calls today (`toolBudget()` at normal depth, `standard` profile). Packed into one promoted deep packet they cost one conversation and 10 tool calls. Promotion collapses total capacity rather than multiplying it, because tool budget is per packet. Promotion's real cost is fidelity of the per-hunk coverage record, which per-member promotion records address directly.

### The one clean paid comparison Plan 102 produced points the right way

In the retry cohort's dilution case — the only family where the packed arms received treatment (`1/1`) — arm B (packed, today's budget) was the only arm whose finding survived verification (`should_find` final `1/1`); A and C both lost it at verification. B also used fewer input tokens than A (66,780 vs 72,167) and less model-service time (65.1s vs 72.5s). Arm C, the `atom-scaled` budget, spent 106.1s of service time and $0.4427 in Stage 7 against B's 65.1s and $0.3460 — 63% more service time for no recall gain. `n = 1` from an invalid cohort decides nothing, but it is sufficient reason not to spend this plan's budget re-testing a scaled tool allowance.

### Four pressures this plan inherits and must guard

1. **Attention-note pressure.** Plan 102's replay recorded six standalone note strings per run disappearing under the unchanged three-note cap. Relationship packing raises note density, so this worsens and needs an explicit reject-and-report rule.
2. **Profile upgrades are unbounded.** The retry cohort showed packing pulling zero-tool `simple` atoms into tool-using packets: consistency B/C requested six tool calls against A's four while packets fell five to three, and input tokens rose 5.6%. The floor blocks downgrades; nothing bounds upgrades. Report it; do not assume fewer packets means lower cost.
3. **Symbol context is single-primary today.** `readEnclosingSymbolSource()` reads one symbol — the top-ranked `HunkSymbolFacts` — for the whole packet, and `computeSymbolContextBudget()` sets `singlePrimarySymbol = false` for multi-symbol packets, selecting `multiple_symbols_keep_compact`. Since `same_container` packing combines *different* methods by definition, naive packing would silently drop every non-primary member's surrounding source, and the coarse `contextQuality` grade would not register it. This is the one place where relationship packing genuinely regresses today's behavior, and it is fixed by design section 4, not by rejection — rejecting every cross-symbol candidate would neuter the plan.
4. **Independent planner draws destroy attribution.** Four of Plan 102's six retry failures were cross-arm reconciliation against independently sampled Stage-5 plans. Pinning the plan per pair removes the cause rather than removing the check.

## Current State

- `hunkFirstGroups()`/`canJoinGroup()` in `src/pipeline/packet-builder.ts` join same-file hunks by identical enclosing symbol or `NEARBY_GAP_LINES = 30` proximity. The Plan 102 experiment was fully reverted; `src`, `scripts`, `tests`, and `evals` match the pre-experiment baseline.
- `buildHunkRelationshipGraph()` builds `same_symbol` (always `strong`), `planner_hint` (`strong` for symbol hints, `medium` for file hints), and `symbol_mention` (`strong` when the mention has an enclosing symbol, else `medium`) edges, capped at `MAX_RELATIONSHIP_EDGES_PER_HUNK = 8` per hunk, dropped on overflow in insertion order.
- `addSymbolMentionEdges()` guards ambiguity (`sourceIdentities.size > 1` → skip). `addPlannerHintEdges()` has no equivalent guard, so a repeated method name can produce spurious `strong` edges.
- `buildRelatedChangedContext()` consumes every non-`weak` edge whose target is outside the packet, capped at `MAX_RELATED_CONTEXTS_PER_PACKET = 3`. Any new `medium` edge source would therefore change flag-off context, attention notes, repository reads, and — through `hasRelatedChangedContext` in the `light`/mechanical branch — profiles.
- `buildPacket()` sets packet coverage to `maxCoverage(members)` and derives `reviewProfile` after related-context filtering, so absorbing a strong edge can currently lower the derived profile.
- `applyCoverageEscalations()` runs *after* packet construction, early-returns only when the packet is already `deep`, and stamps `coverageEscalation`. `CoverageEscalation["rule"]` is the single-member union `"test_coverage_delta"`, so a packed `normal` packet it escalates would overwrite any packing provenance stored there.
- `SymbolInfo` carries `ownerType` (Go method receivers, TypeScript classes, Rust `impl`/trait owners, Python classes, Solidity contracts) and `packageName` (Go). `generic-adapter.ts` resolves neither. `HunkSymbolFacts` — the per-hunk record the packet builder groups on — carries neither. `renderSymbol()` prefixes methods as `Owner.Method` inside `enclosingSymbol`, so container identity is only recoverable today by string-splitting a display string. `packet-context.ts:154` already resolves an owner structurally by name and kind, which is the precedent for a structural container key.
- `packageName` is constant within a Go file and carries no within-file affinity signal; it is deliberately not plumbed.
- `pnpm test -- <file>` does **not** filter: it runs the full suite and silently drops the argument (verified — `pnpm test -- tests/config-loader.test.ts` executed all 761 tests). Plan 102's focused verify commands were therefore never focused. This plan uses `pnpm exec vitest run <file>`.
- Plan 102's report script redacted every failure `message` to `sha256:<hash>:<length>` through `safeFailureOutput()`, leaving its preserved evidence unreadable.
- There is no seam to supply a pre-recorded Stage-5 plan to a review. `runReview()` always calls `runPlanner()`.

## Goal

1. Make the packing predicate semantic: atoms combine when repository structure says they are related, regardless of how the planner graded them.
2. Prove deterministically and for free that the predicate produces a **treatment surface**, including packs that cross coverage grades, before authorizing a paid call.
3. Answer one paid question with attribution: given an identical Stage-5 plan, does a reviewer shown related hunks together find a cross-hunk inconsistency that a reviewer shown them separately misses?
4. Keep every Plan 102 invariant that passed, and add per-member coverage, context-quality, and connectivity invariants that Plan 102 did not need.
5. End in exactly one product path with no surviving flag, under either outcome.

## Design

### 1. Structural container identity

Add `ownerType?: string` and `ownerKey?: string` to `HunkSymbolFacts`, populated in `src/repo/symbol-extraction.ts` from the primary changed symbol. `ownerType` is the display name. `ownerKey` is the **structural** identity: `${path}:${ownerName}:${ownerStartLine}-${ownerEndLine}`, resolved by locating the owning symbol in the file's extracted symbols by name and container kind — the lookup `packet-context.ts:154` already performs. Where the owner cannot be resolved structurally, `ownerKey` is absent and the hunk has no container affinity. Duplicate or nested same-named classes therefore never collide.

No adapter changes are required: Go resolves the owner from the method receiver, TypeScript from the enclosing class, Rust from the `impl`/trait owner, Python from the enclosing class, and Solidity from the owning contract. `generic-adapter.ts` does not, so fallback-path files simply have no container affinity — correct, not a gap.

### 2. A separate packing-affinity view

`same_container` is **not** added to `HunkRelationshipGraph`. Adding any new `medium` source there would change flag-off excerpts, attention notes, `readSymbol` calls, profiles through `hasRelatedChangedContext`, and — through `MAX_RELATIONSHIP_EDGES_PER_HUNK` overflow — which existing edges survive.

Instead, build a `PackingAffinity` view per file, computed only when the flag is on:

- **derived** edges: copied from the relationship graph — `same_symbol`, `symbol_mention` with `strength === "strong"`, and `planner_hint` with `strength === "strong"` **and** unique resolution (the hint's normalized symbol key matches exactly one changed symbol identity in the file, mirroring `addSymbolMentionEdges()`'s existing ambiguity guard);
- **structural** edges: `same_container`, emitted for hunk pairs in one file sharing a non-empty `ownerKey`;
- no per-hunk edge cap, because this view is not rendered into any prompt and cannot evict prompt context.

The report attributes every pack to `derived` versus `structural` edges separately, so `same_container`'s contribution is measurable rather than assumed.

### 3. Connectivity-preserving greedy expansion

Within one file, over hunk-first atoms only:

1. Order atoms by first source position.
2. Take the source-earliest unassigned atom as a packet seed.
3. Repeatedly admit the source-earliest unassigned atom that (a) has an eligible edge to **at least one atom already in the packet** and (b) keeps total hunks `<= MAX_HUNKS_PER_PACKET` and total patch characters `<= MAX_PATCH_CHARS` via `combinedPatchChars()`.
4. Stop when no candidate qualifies; flush and seed the next packet from the remaining atoms.
5. Order packets by first source position; render hunks in source order within each packet.

Every resulting packet is connected by construction, which a source-order chunk of a connected component is not — a chain `A—B—C` appearing in source order `A, C, B` would chunk into a disconnected `{A, C}`. Expansion is also not contiguity-bound: `A1, X, A2` with an `A1—A2` edge packs `A1` and `A2` and leaves `X` alone, which is precisely the separated-sibling case this plan exists for.

Atoms with no eligible edge remain their own packets, exactly as today. Direct `whole-file` and content-probed `file-diff` returns from `groupHunks()` bypass packing entirely.

### 4. Symbol context follows membership

For a packed packet whose member atoms have more than one distinct primary symbol identity, read enclosing-symbol source for **every** member atom's primary symbol rather than the top-ranked one alone:

- allocate each member `floor(symbolContextBudget / memberSymbolCount)` characters, computed by the existing `computeSymbolContextBudget()` path per member;
- preserve the existing adaptive/sliced selection per member, and render members in source order;
- record `contextQuality` per member atom in packet telemetry, alongside the packet-level grade.

A candidate is rejected when any member atom's context quality would fall below its standalone quality *and* below `sliced` — that is, to `outline_only` or `path_only`. Falling from `full` to `sliced` under a shared budget is expected and reported, not fatal.

This is the one place relationship packing regresses today's behavior if left alone, and it is why the throughput case is secondary: packed packets carry more context, not less.

### 5. Transactional candidate evaluation

Every candidate is dry-built against a cloned relationship accumulator and a suppressed telemetry sink. Nothing is written to the real graph, artifacts, or event stream until a candidate is committed. A candidate is abandoned — leaving its atoms as separate packets — when the combined packet would:

- drop a lens any member atom routed standalone;
- newly omit a planner focus note belonging to a hunk whose `reviewPriority` is `high` or `critical`;
- reduce any member atom's context quality below `sliced`;
- lower any member's effective coverage, or lower the effective profile below the maximum standalone member profile.

Every abandonment is recorded with its reason code and the atoms involved.

### 6. Per-member coverage promotion records

Packet coverage remains `maxCoverage(members)`. Add to `ReviewPacket`:

```ts
memberCoveragePromotions?: Array<{
  atomId: string;
  hunkIds: string[];
  from: CoverageLevel;
  to: CoverageLevel;
  edgeSource: "same_symbol" | "symbol_mention" | "planner_hint" | "same_container";
  edgeStrength: HunkRelationshipStrength;
}>;
```

ordered by first source position. `CoverageEscalation` and its single `"test_coverage_delta"` rule are left untouched, so Plan 92's packet-level escalation provenance and this plan's member-level promotion record coexist without either overwriting the other. Demotion of any member is an invariant failure, not a reportable event.

### 7. Profile floor and dispatch rank

Plan 102's floor is retained verbatim: `effectiveReviewProfile = max(derivedPackedProfile, max(standalone member profiles))` over the explicit rank map `{ simple: 0, standard: 1, investigate: 2 }`, never lexical comparison. Standalone profiles are computed through the same Stage-6 path the atom receives with packing off, against the scratch accumulator.

`dispatchRank` is recomputed with the unchanged `packetDispatchRank(filePath, facts, combinedChangedLines)` formula. Scheduling movement is reported, never suppressed.

### 8. Configuration and the pinned-plan seam

```yaml
review:
  packRelatedHunks: false
```

One boolean in raw and resolved schemas, `CodegenieConfig`, defaults, config-source tracking, repo-safe filtering, the strict eval-case `review` schema, and `applyCaseReviewConfig()`. Deleted in step 10 under either outcome.

Separately, add an **eval-only** pinned-plan seam so both arms of a paid pair consume one Stage-5 draw:

- a planner-draw mode that runs Stage 1–5 and writes the resulting `ReviewPlan` plus its SHA-256;
- an eval-case field (`review.pinnedPlanDir`) that supplies execution *k* of a repeat with plan *k*, validated by hash and by exact `hunkId` membership against the current diff, failing closed on any mismatch;
- no user-facing config field, no `codegenie.toml` surface, and no reachable path in normal review.

This is eval-harness capability, not product surface. At teardown it survives only if it is independently useful to other eval work; otherwise it goes with the flag.

## Validation Strategy

### A. Free deterministic replay (no model calls)

Port `scripts/packet-packing-report.ts` from `7ebfd2f` down to `replay` plus `treatment`, with tests in `tests/packet-packing-report.test.ts`.

**Failure records are structured and templated**, not hashed and not raw. Each failure carries a closed-set `code`, structured fields (`runId`, `packetId`, `atomIds`, `hunkIds`, counts, enum reasons), and a `message` rendered from a template over those fields. Raw exception text and repository source are never interpolated. Plan 102's `safeFailureOutput()` hashing is not ported; its credential stripping is.

Run over the four retained runs. Assert per run:

- every reviewable hunk appears exactly once, in source order;
- no atom is split or internally reordered;
- **every packed packet is connected** under the affinity view;
- five-hunk, 12K-patch, six-lens, and three-note caps hold; file boundaries hold;
- no planner-requested lens dropped, no `high`/`critical` focus note newly omitted, no member context quality below `sliced` — or the candidate was abandoned and recorded;
- no effective profile or base budget below the maximum standalone member value;
- no member coverage demotion; every promotion carries a member record with a causing edge;
- every dispatch rank equals the existing formula;
- flag off is artifact-identical to current behavior, including the relationship-graph artifact, which proves the affinity view never wrote back.

Report per run: packets off→on, atoms per packet, promoted members by edge source, abandoned candidates by reason code, packing edges split `derived` versus `structural`, per-member context-quality distribution, attention notes dropped, excerpts internalized, and scheduling movement.

**Pre-registered numeric gates**, counted on the two *distinct* diffs (`dca8d870`, `81f806a6`) and reported for all four rows:

| Gate | Threshold |
| --- | --- |
| Treatment surface — packets combining atoms Plan 102's `(coverage, lensSignature)` predicate would separate | `>= 5` per distinct diff |
| Cross-coverage packs — packed packets containing at least one member promotion | `>= 3` per distinct diff |
| `same_container` aggressiveness — multi-atom packets with structural edges enabled, versus derived-only | `<= 2.0x` |
| Promoted members as a share of reviewable hunks | `<= 25%` per run |
| Members whose context quality falls below `sliced` | `0` |

Missing the first two means the predicate does not reach materially more code than Plan 102's did, or does not do the new thing it exists to do — stop here, for free. Exceeding the third or fourth means demoting `same_container` to context-only and re-running with derived edges alone before continuing.

Also report what Plan 102's compatibility tier would add on top, as a diagnostic for a possible later throughput plan. Do not implement that layer here.

### B. One paid question, isolated by a pinned plan

**Fixture.** One family, `container-consistency`, under `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/relationship-packing/recall/`: several methods on one Go receiver type, four applying a shared guard and one omitting it, separated by more than `NEARBY_GAP_LINES` so today's grouper yields one atom each. The same repository also carries an **unrelated local boundary bug** in a free function, which serves as the control.

Two expectations:

- `cross-hunk` — the missing guard. Invisible without seeing siblings. Packing should help.
- `local-control` — the boundary bug. Visible in isolation. Packing must not hurt.

Fixture rules learned from Plan 102: the target must be a hunk the planner grades **ordinarily** on its own (if it grades `deep` alone, the fixture is wrong); target and siblings must be related by a real edge, verified by the no-model treatment check before launch; and expectations constrain path, line range, and failure mode while **accepting any plausible category**. Plan 102 recorded three executions that found its bug and scored `partial-match` solely because the expectation demanded `correctness` and the reviewer said `security`.

**Procedure.** Two cases, `container-a.yml` (packing off) and `container-b.yml` (packing on), identical except that field. For each of 6 repeats: draw one Stage-5 plan, hash it, and run both arms pinned to it. Six planner draws total, so planner variance is still sampled *across* pairs while packing is the only difference *within* a pair. With the plan pinned, cross-arm atom and hunk reconciliation is exact and **required** — the check Plan 102 could not support is now sound.

Run the one-repeat treatment preflight first. Arm B's target packet must contain at least two source atoms. If it does not, repair the fixture and rerun — a preflight treatment miss is a fixture defect and explicitly does **not** trigger teardown.

**Pre-registered decision table** over 6 pairs, where `Ax`/`Bx` are hits on `cross-hunk` and `Ac`/`Bc` on `local-control`:

| Condition | Outcome |
| --- | --- |
| `Ax >= 5` | **Void — no headroom.** Fixture too easy; redesign, do not count as evidence. |
| `Ax == 0 and Bx == 0` | **Void — no signal.** Bug undetectable at this model/config; redesign. |
| `Bx - Ax >= 3` and `Bc >= Ac - 1` | **Pass.** Proceed to collateral and capacity confirmation. |
| `1 <= Bx - Ax <= 2` | **Inconclusive.** Record; do not ship; a larger `n` is a separate decision. |
| `Bx <= Ax` or `Bc < Ac - 1` | **Fail.** Take the failure branch. |

Requiring `+3` of 6 is a strong-effect-only test. It cannot detect a small improvement, and the reconciliation note must say so rather than reporting a null as safety.

### C. Collateral and capacity, inside this plan

A pass on one Go fixture does not license unconditional cross-language behavior. Before shipping, and within this plan:

1. Run the complete `evals/fixtures/` suite flag-off and flag-on at `repeat: 1` with the fake provider. Every declared expectation, packet invariant, and config parse must match.
2. Run the complete `evals/skill-semantics/` suite (TypeScript, Python, Solidity) flag-off and flag-on at `repeat: 1`. Cross-language container semantics differ — Solidity contracts and Python classes are much broader containers than a Go receiver — so this is where `same_container` over-packing would surface. An A-pass/B-fail difference is a stop-for-investigation; rerun only the affected case at `repeat: 3` before deciding variance versus regression.
3. Run one production-shaped capacity pair on the pinned `trails-api` diff at concurrency 6, flag-off and flag-on, and report reviewed-hunk set, packet count, model-service time, tokens, and cost per reviewed hunk. This is a capacity and safety observation, not an economics gate — this plan does not claim throughput and must not be blocked on producing it.

These stay in this plan so the decision and the teardown happen together. Deferring them would leave `packRelatedHunks` alive across plan boundaries, which is the dark path Plan 102 exists to forbid.

### Cost discipline

No paid model call begins before `approvedValidationCostUSD` is recorded in this plan's reconciliation note; the owner supplies the amount and there is no default.

Projection from Plan 102's measured $0.56–$0.81 per execution on comparable Go fixtures:

| Phase | Executions | Projection |
| --- | ---: | ---: |
| Treatment preflight (1 pair + 1 plan draw) | 3 | ~$2 |
| Paired recall, 6 pairs | 18 | ~$14 |
| `evals/fixtures/` collateral (fake provider) | — | $0 |
| `evals/skill-semantics/` collateral, both arms | 6 | ~$5 |
| Production capacity pair | 2 | ~$50 |
| Contingency 25% | — | ~$18 |
| **Reservation** | | **~$90** |

Record actual and projected spend after every phase and stop if actual plus projection exceeds the ceiling. The production pair is the only expensive item; it runs last and only after a pass.

## In-Scope Files

- `src/repo/symbol-extraction.ts` — `ownerType` and structural `ownerKey` on `HunkSymbolFacts`.
- `src/pipeline/packet-builder.ts` — affinity view, greedy expansion, transactional candidates, multi-member symbol context, member promotion records, profile floor, telemetry.
- `src/pipeline/review-runner.ts` — the eval-only pinned-plan seam.
- `src/types.ts` — `ownerType`/`ownerKey`, `memberCoveragePromotions`, per-member context-quality telemetry, the temporary config field.
- `src/config/schema.ts`, `src/config/config-loader.ts`, `src/evals/eval-runner.ts` — flag plumbing and `pinnedPlanDir`; both deleted or re-justified in step 10.
- `scripts/packet-packing-report.ts`, `tests/packet-packing-report.test.ts` — `replay` and `treatment` modes with templated failure records.
- `tests/pipeline-phase5.test.ts`, `tests/config-loader.test.ts`, `tests/evals.test.ts`, and the symbol-extraction suite.
- `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/relationship-packing/` — fixture, cases, pinned plans, immutable logs, reports.
- `specs/plans/README.md` and affected `specs/project/` docs.

## Non-Goals

- Cross-file packing. File identity remains the context and anchor boundary.
- Raising the five-hunk, 12K-patch, six-lens, or three-note caps.
- Reintroducing Plan 102's `atom-scaled` budget, or any tool-budget change.
- Layering Plan 102's coverage/lens compatibility packing on top. The replay reports what it would add; a separate plan may act on it.
- Claiming a throughput or economics win. Packed packets carry more symbol context and may cost more; the capacity run observes this rather than gating on it.
- Changing prompt templates, attention-note ordering, `canJoinGroup()` semantics, Plan 100's dispatch policy, or Plan 92's escalation rules.
- Exposing `packRelatedHunks` or `pinnedPlanDir` as user-facing configuration, or leaving either dark after step 10.
- Treating `packageName` as an affinity signal.

## Implementation Steps

1. Reconcile the drift and working-tree checks. Add `ownerType` and structural `ownerKey` to `HunkSymbolFacts`.

   **Verify:** `pnpm exec vitest run tests/pipeline-phase5.test.ts -t "container identity"` → exit 0; Go receivers, TypeScript classes, Rust `impl` blocks, Python classes, and Solidity contracts resolve; free functions and generic-adapter files resolve none; two same-named classes in one file produce distinct `ownerKey` values.
2. Add the dark `review.packRelatedHunks` field end-to-end, including strict eval schema, `applyCaseReviewConfig()`, defaults, repo-safe filtering, and config-source tracking.

   **Verify:** `pnpm exec vitest run tests/config-loader.test.ts tests/evals.test.ts` → exit 0; default `false`, eval override applies, winning source identified.
3. Build the `PackingAffinity` view, including the `planner_hint` unique-resolution guard. Prove it never mutates the relationship graph.

   **Verify:** `pnpm exec vitest run tests/pipeline-phase5.test.ts -t "packing affinity"` → exit 0; `hunk-relationships.json`, related-context excerpts, attention notes, repository reads, and profiles are byte-identical with the flag on and packing suppressed; ambiguous repeated symbol names produce no structural or hint edge; the per-hunk edge cap is unaffected.
4. Wrap `hunkFirstGroups()` output as atoms with standalone coverage, routed lenses, profile, and context quality captured through the scratch path. Add flag-off golden parity before any packing runs.

   **Verify:** `pnpm exec vitest run tests/pipeline-phase5.test.ts -t "packet atom|flag-off parity|whole-file bypass"` → exit 0.
5. Implement connectivity-preserving greedy expansion.

   **Verify:** `pnpm exec vitest run tests/pipeline-phase5.test.ts -t "greedy expansion"` → exit 0, covering: the `A—B—C` chain in source order `A, C, B` never producing a disconnected packet; `A1, X, A2` packing across the unrelated `X`; cap-bound expansion stopping without splitting a packet into disconnected parts; interleaved components; unrelated atoms staying separate; hunk bijection and source order.
6. Implement multi-member symbol context and per-member context-quality recording.

   **Verify:** `pnpm exec vitest run tests/pipeline-phase5.test.ts -t "member symbol context"` → exit 0; a two-symbol packet carries both symbols' source under a shared budget; `full`→`sliced` degradation is reported and allowed; a member falling to `outline_only` aborts the candidate.
7. Implement transactional candidate evaluation, member promotion records, and the profile floor.

   **Verify:** `pnpm exec vitest run tests/pipeline-phase5.test.ts -t "candidate rejection|member promotion|profile floor"` → exit 0; an abandoned candidate leaves no telemetry, graph mutation, or artifact residue; lens-drop, `high`-priority focus-note-drop, and context-collapse candidates all abort; promotions are recorded per member with the causing edge; `coverageEscalation` is untouched and a subsequent Plan 92 escalation does not erase promotion records; demotion fails closed.
8. Add the eval-only pinned-plan seam and its validation.

   **Verify:** `pnpm exec vitest run tests/evals.test.ts -t "pinned plan"` → exit 0; a pinned plan reproduces identical Stage-6 inputs across two runs, a hash mismatch fails closed, a `hunkId` set mismatch fails closed, and no user-facing config path can reach it.
9. Port the report script and run the four-run replay. Record the full table and every pre-registered gate in this plan's reconciliation note.

   **Verify:** `pnpm exec vitest run tests/packet-packing-report.test.ts` → exit 0 with templated-message and fail-closed regressions; then the replay command exits 0 with `modelCallsObserved: 0` on every row, all invariants green, and every numeric gate in section A satisfied on both distinct diffs. Otherwise stop; no paid phase is authorized.
10. Record the owner-approved ceiling, build the fixture, and run the paid programme in order: treatment preflight, 6 pinned pairs, `evals/fixtures/`, `evals/skill-semantics/`, then the production capacity pair. Apply the decision table verbatim.

    **Verify:** preflight target packet combines at least two atoms; cross-arm reconciliation is exact for every pair; the decision table yields Pass, Inconclusive, Fail, or Void with no discretion; collateral suites show no reproducible regression; cumulative spend stays within the ceiling.
11. Record the decision and tear down the scaffolding in a dedicated commit.

    **Preserve evidence first:** copy every JSON report produced by completed phases into `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/relationship-packing/reports/` with a `manifest.sha256`, alongside the six pinned plans and their hashes. Mark unreached phases `not_run` with their stopping reason.

    **If Pass:** make packing unconditional; delete `review.packRelatedHunks` and the unpacked path with all schema, loader, and eval plumbing. Keep `ownerType`/`ownerKey`, the affinity view, greedy expansion, multi-member symbol context, member promotion records, the profile floor, and packing telemetry as unconditional behavior. Reduce the report script to a golden check against frozen packet shapes. Retain `pinnedPlanDir` only if it is independently useful to other eval work; otherwise delete it.

    **If Fail, Inconclusive, or Void:** delete the packing pass, the flag and its plumbing, the affinity view, the atom wrapper, member promotion records, and the report script with its tests. `ownerType`/`ownerKey` and multi-member symbol context survive **only** if the replay showed them independently improving related-context selection or context quality with packing off; otherwise they go too. A Void outcome permits one fixture redesign and one rerun before the failure branch; a second Void takes the failure branch. Do not leave the feature dark.

    **Verify:** `rg -n "packRelatedHunks" src scripts tests evals` → exit 1; the evidence manifest verifies; the reconciliation note records the decision table result, actual spend, and the strong-effect-only limitation of `n = 6`.
12. Run the complete repository gate.

    **Verify:** `pnpm run check && pnpm test && pnpm build` → exit 0.

## Tests and Commands

Focused gates — note `pnpm exec vitest run`, because `pnpm test -- <file>` silently runs the whole suite:

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
  --compare-predicate plan102 \
  --distinct-diffs \
  --output /tmp/plan103-relationship-shape.json
```

Expected: exit 0, four rows with duplicate diffs marked and counted once, zero model calls, zero invariant failures, all section-A gates satisfied, and a `plan102Predicate` diagnostic block.

Paid preflight, then the pinned paired suite:

```bash
pnpm dev eval \
  --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/relationship-packing/recall \
  --no-cache

pnpm exec tsx scripts/packet-packing-report.ts treatment \
  --logs /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/relationship-packing/recall/logs \
  --cohort <invocation-uuid> \
  --expected-repeats 1 \
  --require-pinned-plan \
  --output /tmp/plan103-treatment-preflight.json
```

Note the `pnpm dev eval` spelling: under pnpm 11 a literal `--` is passed through to Commander and rejected before suite allocation.

## Acceptance Criteria

- Flag off produces byte-identical packet artifacts, IDs, order, profiles, context, budgets, **and relationship-graph artifacts** — proving the affinity view never wrote back.
- Flag on preserves every atom, assigns every reviewable hunk exactly once in source order, and respects file, five-hunk, and 12K boundaries.
- Every packed packet is connected under the affinity view; unrelated atoms are never combined; no packet is a source-order chunk of a component.
- No planner-requested lens dropped, no `high`/`critical` focus note newly omitted, no member context quality below `sliced`; candidates that would do any of these are abandoned transactionally and recorded.
- Every effective profile is at least the maximum standalone member profile; no member coverage falls; every promotion is recorded per member with its causing edge; `coverageEscalation` remains Plan 92's alone.
- Dispatch ranks use Plan 100's unchanged formula; scheduling movement is reported.
- The replay exits 0 with zero model calls and satisfies every pre-registered numeric gate on both distinct diffs, reporting `derived` versus `structural` edge attribution and per-member context quality.
- Every paid pair consumes one hash-verified Stage-5 plan; cross-arm atom and hunk reconciliation is exact; the decision table is applied without discretion.
- `evals/fixtures/` and `evals/skill-semantics/` show no reproducible collateral regression under the selected behavior.
- The production capacity pair reviews at least the baseline hunk set and its cost, tokens, and service time are reported without being claimed as a win.
- Paid validation never begins without a recorded ceiling; every phase records actual and projected spend.
- Report failures carry templated, structured, human-readable messages with no raw exception text, no repository source, and no hashing.
- Teardown leaves exactly one product path with no surviving flag and no dark code, and preserves every produced report and pinned plan under a verified manifest.
- Checks, tests, and build pass; the final behavior and the strong-effect-only `n = 6` limitation are documented.

## Stop Conditions

- Treatment surface below 5 packets, or cross-coverage packs below 3, on either distinct diff: the predicate does not reach materially more code than Plan 102's, or does not do the new thing. Stop before any paid call and record the premise as disproven.
- `same_container` more than doubles multi-atom packets versus derived-only edges, or promotes more than 25% of reviewable hunks on any run: demote it to context-only and re-run the replay with derived edges before continuing.
- Any atom split or reordered, hunk lost or duplicated, disconnected packet, cap exceeded, member coverage demotion, profile or budget downgrade, or member context collapse below `sliced` that was not abandoned: fix the deterministic design before spending anything.
- The affinity view mutates the relationship graph, or flag-off artifacts change: stop; the isolation guarantee is the basis of every later comparison.
- The replay cannot reproduce flag-off artifacts from recorded inputs or resolves different production refs: reconcile the evidence.
- A paid pair's two arms consumed different Stage-5 plans, or a pinned-plan hash or `hunkId` set fails validation: discard that pair and rerun it. Never analyze an unpinned pair.
- The preflight target packet does not combine at least two atoms: repair the fixture and rerun. This is a fixture defect and explicitly does **not** trigger teardown; Plan 102 stopped here after a single repair when its own step 7 called for another.
- The decision table returns Void twice: take the failure branch rather than redesigning a third time.
- Cross-arm reconciliation is proposed as optional: reject it. With the plan pinned it is exact and required; without pinning the pair is invalid.
- Actual plus projected spend exceeds the approved ceiling: stop for explicit approval. Do not weaken a gate to fit a budget.
- "Keep packing dark" always means *do not ship it in this iteration*; every such outcome terminates in step 11's failure branch in the same change. Deferring teardown to a later plan is itself a stop condition.

## Maintenance Notes

- Any future change to `hunkFirstGroups()`, `canJoinGroup()`, the relationship edge builders or their strengths, `buildRelatedChangedContext()`, `readEnclosingSymbolSource()`, `computeSymbolContextBudget()`, `packetReviewProfile()`, coverage levels, packet caps, `packetDispatchRank()`, or `toolBudget()` invalidates the recorded shape, promotion, context, and order baselines; rerun the replay before changing unconditional packing behavior.
- Reviewers should scrutinize affinity-view isolation, edge-source attribution, per-member context quality, promotion records, abandonment reasons, and pinned-plan provenance — not packet count.
- Plan 102's negative result is why this plan exists. Its preserved reports and paid logs under `codegenie-private-evals/trails-api/packet-packing/` remain the record of the rejected coverage/lens predicate and must not be edited or deleted.
- Throughput packing of *unrelated* compatible atoms remains a separate, later question. This plan measures what it would add but deliberately does not ship it: bundling a quality mechanism with a cost mechanism is what made Plan 102 unmeasurable.
- Commit hashes in this document are rebase-unstable. Locate referenced work by commit subject when a hash does not resolve.
