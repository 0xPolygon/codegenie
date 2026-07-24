# Issue 102: Same-File Packet Packing

Status: PENDING
Related: Plan 100 (COMPLETE; dispatch rank), Plans 40/44 (recall calibration), Plan 79 (repeat/recall harness)
Planned from: production run `.codegenie/runs/20260724-184952-dca8d870` against `0xsequence/trails-api` PR 846 (88 files, 217 hunks, `--max-time 60`, concurrency 4), plus retained runs `740d73f2`, `fe1548ae`, and `81f806a6`, 2026-07-24
Production replay refs: base/merge-base `d1c49bdf6a8002ec2ec27faac94a932d736532b2`; head `fbb5f8761c2c296e115af17e919a7c35d9de8373`
Planned at: commit `6909e1a` (branch `next`)
Recommended priority: next throughput plan. Plan 100 is complete, and run `dca8d870` is the clean planner-survival/dispatch-order baseline: 32/32 planner entries survived and all 19 deep hunks were dispatched. Its dependency is satisfied.

> Executor instructions: preserve the output of today's semantic hunk grouper as indivisible **atoms**. Do not replace `canJoinGroup` with an affinity sort: proximity is not transitive, and a sort cannot preserve its semantics. Never combine atoms with different effective coverage levels. Preserve each atom's standalone review profile as a monotonic floor when packing internalizes relationship context. Keep source order, `MAX_HUNKS_PER_PACKET = 5`, and `MAX_PATCH_CHARS = 12_000`. Land packing dark, validate deterministic packet shape before spending model calls, then record treatment for every paid execution and require at least 8/10 treated B/C executions per arm/case. Use paired repeated A/B/C evals to decide the default and tool-budget mode.
>
> Drift check: `git diff --stat 6909e1a..HEAD -- src/pipeline/packet-builder.ts src/config/schema.ts src/config/config-loader.ts src/types.ts src/evals/eval-runner.ts scripts/packet-packing-report.ts tests/pipeline-phase5.test.ts tests/config-loader.test.ts tests/evals.test.ts tests/packet-packing-report.test.ts`
> Working-tree check: `git status --short -- src/pipeline/packet-builder.ts src/config/schema.ts src/config/config-loader.ts src/types.ts src/evals/eval-runner.ts scripts/packet-packing-report.ts tests/pipeline-phase5.test.ts tests/config-loader.test.ts tests/evals.test.ts tests/packet-packing-report.test.ts`
> If the drift check reports committed changes, reconcile the current-state claims below. If the working-tree check reports changes owned by another task, stop and wait for that work to land or move this plan to an isolated worktree; do not overwrite it.

## Decision

Pack more same-file work, but only across boundaries that do not carry a deliberate review signal:

- First run the existing symbol/proximity grouper unchanged. Its output groups are semantic atoms and remain indivisible.
- Pack compatible atoms from the same file, in source order, under the existing hunk and patch-size caps.
- Compatibility requires the same effective coverage level and the same normalized planner-selected lens set. This introduces **zero new coverage promotion** and prevents packing from silently dropping a requested lens.
- Review profile is not a compatibility boundary, but it is a **monotonic floor**. Packing can internalize a relationship edge, remove it from `relatedChangedContext`, and make the freshly derived profile lower even though the related hunk is now fully present. Rank profiles explicitly as `simple < standard < investigate`; the effective packed profile must be at least the maximum standalone member-atom profile. A packed profile may remain higher when the normal derivation requires it, but it may never fall below that floor.
- Keep the five-hunk cap and render hunks in source order. Do not add a new preamble, reorder attention notes, or otherwise change prompt construction under the packing flag: that would confound the shape-only B arm. Treat newly omitted high/critical focus as a failed packing candidate/gate rather than compensating with an unmeasured prompt change.
- Do not assume today's per-packet tool budget is sufficient or that scaling it is free. Implement an isolated atom-aware budget arm and select between it and today's budget using the recall/economics gate below.

This is deliberately more conservative than “pack every hunk in a file.” The historical artifact replay predicts 75 packets instead of 96 (21.9% fewer) without blunting Plan 100's per-hunk coverage signal; the real-builder replay below owns the authoritative count. Reaching 30% requires cross-coverage promotion and is rejected.

## Evidence

### The run is packet-bound and time-bound

The motivating run produced 96 packets carrying 142 reviewable hunks. Seventy-three packets (76%) were single-hunk and 84 (87.5%) contained at most two hunks. The previous three retained runs show the same shape: 76–79% singletons, so this is structural rather than a one-run anomaly.

Only 57 packets were dispatched before the deadline; 56 completed, covering 89 of 142 reviewable hunks. All 19 deep hunks were reached, which is evidence that Plan 100-style priority ordering worked. The remaining failure is throughput: 53 normal/light hunks received no review and therefore had zero recall.

Stage 7 consumed 174 model calls, 5.321M tokens, `$22.85`, and 53.3 minutes of observed runtime. Summed model-service time was 12,646 seconds; divided by concurrency 4, that is 52.7 minutes, almost the entire observed stage. Repository-tool runtime in Stage 7 was only 5.2 seconds. The binding cost is repeated model conversations and their fixed prompt/finalization freight, not local tool execution.

Among the 57 dispatched packets:

| Packet size | n | Avg calls | Avg input tokens | Avg model-service seconds |
| --- | ---: | ---: | ---: | ---: |
| 1 hunk | 41 | 3.10 | 91,585 | 228 |
| 2 hunks | 8 | 3.00 | 67,433 | 206 |
| 3 hunks | 3 | 2.67 | 77,940 | 158 |
| 4–5 hunks | 5 | 3.00 | ~109,000 | 228 |

The samples are observational and small, so they do not prove equal attention. They do show that a packet with several hunks is not several times as expensive as a singleton. Forced finalization alone accounted for 34 calls, 1.037M input tokens, 2,079 model-service seconds, and `$6.71`; fewer packets remove that fixed freight.

### Packing can improve quality as well as coverage

The accepted `acceptRoute` user-fee-cap bypass came from a five-hunk `routing_solver.go` packet. Its failure mode was cross-hunk inconsistency: four branches did one thing and a fifth did not. A reviewer shown the fifth hunk alone cannot make that comparison. The relationship graph and related-context machinery try to reconstruct this adjacency later, with caps and omissions; safe same-file packing supplies it directly.

The larger quality gain is coverage. The relevant comparison in this run is not “packed review versus perfectly attentive singleton review”; it is packed review versus 53 undispatched hunks. A complete review with bounded packet sizes should dominate a partial review if repeat-eval recall remains within variance.

### Deterministic replay selects the conservative rule

The packet artifacts were independently replayed twice:

| Strategy on the motivating run | Packets | Reduction | New cross-coverage promotion |
| --- | ---: | ---: | ---: |
| Repack all hunks by file | 67 | 30.2% | 11–16 hunks |
| Repack hunks, preserve coverage | 73–74 | 22.9–24.0% | 0 |
| Pack existing atoms by file + effective coverage + lenses | 75 | 21.9% | 0 |
| Also require identical review profile | 82 | 14.6% | 0 |

The historical 75-packet shape is the target, subject only to the explicitly bounded patch-measurement reconciliation below. It preserves today's semantic grouping, Plan 100's coverage signal, lens intent, source order, and current caps while still removing about one packet in five. Exact-profile matching gives away too much of the gain for a weaker boundary.

### Tool budget is a real coupling, but extra rounds are expensive

`toolBudget()` is currently a function of coverage, depth, and review profile—not hunk or atom count. A one-hunk normal/investigate packet and a five-hunk normal/investigate packet both receive 6 tool calls, 2 investigation rounds, and 12K result characters. Blind packing can therefore reduce investigative capacity per atom.

The motivating run already recorded 30 Stage-7 tool-budget rejections across 16 dispatched packets (34 including Stage 9). There is not, however, a monotonic packet-size starvation signal: deep/investigate packets had zero rejections, while most rejections came from normal/standard packets. Scaling every budget linearly by raw hunk count would spend in the wrong places.

Additional investigation rounds are also not free. The run's 83 tool-continuation calls consumed 2.718M input tokens, 6,358 model-service seconds, and `$6.86`; each continuation averaged roughly 32.7K input tokens and 76 seconds. A scaler that creates more model rounds can erase the packet-count saving.

Therefore the experiment scales by **newly combined atom count**, not raw hunks; leaves simple packets alone; modestly raises calls/result characters for other packed packets; and keeps investigation rounds unchanged. Deep's existing headroom is evidence against adding rounds, not a reason to leave a newly packed deep packet's allowance structurally unchanged. The gate, not intuition, decides whether that mode ships.

Packing has a second, independent budget coupling. `buildRelatedChangedContext()` omits an edge when its target hunk is already in the current packet. `hasStrongRelatedChangedContext()` can then change from true to false and `packetReviewProfile()` can fall from `investigate` to `standard`; a normal packet would lose two base tool calls despite gaining the full related hunk. The trigger is narrower than arbitrary same-symbol grouping—only strong `symbol_mention` and `planner_hint` related context participate in this profile nudge—but it directly overlaps the same-file atoms targeted here. Light/mechanical packets can also fall from `standard` to `simple` when all related context is absorbed. The profile floor prevents both regressions and keeps the B arm from being corrupted by an accidental budget downgrade.

## Current State

- `hunkFirstGroups()` and `canJoinGroup()` in `src/pipeline/packet-builder.ts` create same-file groups from same-symbol or nearby hunks. `canJoinGroup()` compares against the last group member; “nearby” is not a transitive ordering relation.
- `buildPacket()` currently computes packet coverage as the maximum member coverage, derives review priority/profile, unions/routes lenses, and applies shared caps including 8K context characters, six lenses, three attention notes, and three related contexts.
- `buildRelatedChangedContext()` skips relationship edges whose target hunk is already in the packet. `hasStrongRelatedChangedContext()` only treats strong source-side `symbol_mention` and `planner_hint` edges as a profile nudge; `same_symbol` edges alone do not qualify. `packetReviewProfile()` is evaluated after this filtering, so packing can currently derive a lower profile than the member atoms received independently.
- `toolBudget()` around `packet-builder.ts:2918` returns one budget per packet from coverage, depth, and review profile. At normal coverage, `investigate` receives 6 calls/2 rounds/12K result characters while `standard` receives 4/2/10K. `buildPacket()` applies `budgetBoost` afterward.
- `packetDispatchRank()` returns `[fileClassRank, -packetChangedLines]`. Packing legitimately changes the second component because it changes packet membership; Stage 7 sorts by priority, coverage, dispatch rank, then input order. Plan 102 must preserve that formula and report ordering movement rather than requiring flag-on ranks to equal member ranks.
- Raw and resolved config schemas are strict. A new review setting must also be added to `CodegenieConfig`, defaults/source tracking and repo-safe filtering in `config-loader.ts`, and the strict eval-case `review` schema plus `applyCaseReviewConfig()` in `src/evals/eval-runner.ts`.
- Plan 79 already supports `repeat`, cache-off enforcement, candidate/final recall rates, and per-expectation loss histograms. Reuse it; do not invent a second recall harness.

## Goal

1. Reduce the motivating run's packet count by at least 20% with zero new coverage promotion, no atom splits, no hunk loss/duplication, and all existing caps intact.
2. Improve reviewed-hunk throughput, total model-service time, token use per reviewed hunk, and cost per reviewed hunk without a measurable candidate- or final-recall regression.
3. Make profile and tool-budget coupling explicit: packing cannot reduce the maximum standalone member profile, and atom-aware capacity remains experimentally separable from base packing.
4. Keep flag-off packet artifacts byte-identical to current behavior.

## Design

### 1. Preserve semantic groups as atoms

Keep the existing hunk-first grouping path unchanged and name its outputs as packet atoms. An atom carries:

- `origin: "hunk-first"`; only groups returned by `hunkFirstGroups()` are eligible for the second packing pass;
- its ordered `PlannedHunk[]` and existing group metadata;
- total hunk count and rendered/estimated patch characters;
- first source position;
- effective coverage (the maximum coverage the atom receives today);
- normalized planner-selected lens signature, defined exactly as the stable serialization of the sorted, deduplicated union of `decision.lenses` for the atom;
- standalone review profile, computed through the same Stage-6 profile-input path the atom receives with packing off;
- a stable atom ID derived from its ordered hunk IDs for telemetry/replay only.

An atom may already contain mixed per-hunk coverage under today's behavior. Preserve that baseline exactly, but never combine it with another atom whose effective coverage differs. “Zero promotion” in this plan means **zero promotion introduced by the new packing pass**.

Do not split atoms to reach a prettier packet count. If one atom is already at a cap, it remains its own packet. The direct `whole-file` and content-probed `file-diff` returns from `groupHunks()` bypass the packer completely; insert packing only around return values produced by `hunkFirstGroups()`.

### 2. Stable compatible-atom packing

Behind `review.packSameFileHunks`:

1. Run today's grouper and produce atoms.
2. Within each file, partition atoms by `(effectiveCoverage, normalizedPlannerLensSet)`.
3. Preserve source order within each partition and greedily fill packets while:
   - total hunks `<= MAX_HUNKS_PER_PACKET`;
   - total patch characters `<= MAX_PATCH_CHARS`.
4. Restore packet order by the first source position with a stable tie-breaker. Render every packet's hunks in source order.
5. Materialize the combined `PacketGroup` without inventing whole-file metadata:
   - flatten atom hunks in source order;
   - recompute `kind` with the existing `packetGroup()`/`packetKind()` rules;
   - carry all non-empty atom `degradationReason` values through a sorted/deduplicated `"; "` join;
   - do not synthesize `wholeFileText` or `fileContext` for hunk-first atoms.
6. Build context, related context, and attention notes for the combined packet through the existing path, then:
   - derive the packed profile normally;
   - compute `profileFloor = maxProfile(sourceAtoms.map(atom => atom.standaloneReviewProfile))` using an explicit rank map `{ simple: 0, standard: 1, investigate: 2 }`, never lexical enum comparison;
   - set `effectiveReviewProfile = maxProfile(derivedPackedProfile, profileFloor)`;
   - route final lenses and compute the base/atom-scaled tool budget from `effectiveReviewProfile`.

Calculate each atom's standalone profile with the same coverage, priority, planner notes/hints, relationship graph, repository context, and profile helper used by the flag-off builder. Do not approximate the floor from coverage or edge kinds alone. It is acceptable to refactor the profile-input calculation into a shared helper, but flag-off packet artifacts and telemetry must remain byte-identical. Internalizing a related hunk should remove the redundant related-context excerpt; preserve review capacity through the profile floor rather than retaining fake “external” context.

Include artifact-only profile provenance in the packed-atom telemetry: ordered atom IDs and standalone profiles, derived packed profile, profile floor, effective profile, and whether the floor applied. Keep it out of the prompt and packet ID. An effective downgrade is an invariant failure; a derived downgrade corrected by the floor is reportable evidence, not a failure.

The normalized planner-lens signature is the compatibility key; the final routed set may add/remove lenses according to existing routing rules. Emit/assert telemetry that packing did not cause a planner-selected lens to disappear. If that cannot be guaranteed from the pre-build signature, use the stricter compatible signature rather than accepting lens loss.

Flag off must bypass the packing pass entirely and produce byte-identical packet artifacts, IDs, order, coverage, profile, context, and budgets.

When packing is on, emit an artifact-only Stage-6 `same_file_atoms_packed` telemetry event for each packet, containing packet ID, ordered source atom IDs and standalone profiles, source atom count, hunk count, effective coverage, normalized requested-lens signature, cap usage, derived packed profile, profile floor, effective profile, and whether the floor applied. Do not put this provenance into the reviewer prompt or packet ID. The replay/eval report uses it to prove treatment, enforce profile monotonicity, and normalize tool pressure by pre-existing atoms.

### 3. Position and focus safeguards

- Keep the five-hunk cap and source-order rendering.
- Preserve hunk IDs and per-hunk anchors.
- Keep `attentionNotesForDecisions()`, `mergeAttentionNotes()`, and prompt rendering unchanged in the packing implementation. Arm B must differ from A only through packet membership/derived context, not an independently edited prompt template or note-order algorithm.
- Compare flag-off/on note selection by hunk during the deterministic Stage-6 rebuild. A packed candidate that newly omits a planner focus from a high/critical-priority hunk is invalid; tighten compatibility or leave those atoms separate.
- Do not reorder hunks to place the riskiest one first. Source order is the more reliable code narrative and avoids position changes across runs.
- Recompute `dispatchRank` with the existing `packetDispatchRank(filePath, facts, combinedChangedLines)` formula. Do not introduce a packing-specific rank or freeze the rank to one member atom. Report changes in the complete Stage-7 scheduling tuple `(priority, coverage, dispatchRank, stable input order)`; packing may move a larger packet earlier within an otherwise equal tier, but must not change priority/coverage semantics.

### 4. Explicit configuration and eval plumbing

Add:

```yaml
review:
  packSameFileHunks: false
  packedToolBudgetMode: base # base | atom-scaled
```

- Both fields exist in raw/resolved schemas, `CodegenieConfig`, defaults, config-source telemetry, loader application, and repo-safe review filtering.
- Both fields exist in the strict eval-case `review` schema and are copied by `applyCaseReviewConfig()`.
- `packedToolBudgetMode` has no effect when packing is off. `base` reproduces today's per-packet budget.
- Defaults remain `false`/`base` until the complete gate passes. Only the winning budget mode may become the default when packing is enabled.

These are safe review-behavior settings, not credentials or filesystem authority, so project config may set them using the same source precedence as other repo-safe review settings.

### 5. Isolated atom-aware tool-budget arm

The `atom-scaled` arm applies only when a packet combines more than one pre-existing atom:

- `additionalAtoms = atomCount - 1`; a five-hunk atom that was already one packet gets no increase.
- `simple` profile remains zero-tool.
- For every non-simple standard or investigate packet, including deep:
  - keep `maxInvestigationRounds` unchanged;
  - increase `maxToolCalls` by at most one per additional atom, capped at `ceil(1.75 * base.maxToolCalls)`;
  - add at most 2,000 result characters per additional atom, capped at `ceil(1.75 * base.maxResultChars)`;
  - preserve source-extension policy and apply the existing global `budgetBoost` only after this calculation.

Treat these constants as an experimental starting point, not a universal law. Record requested/used/rejected calls, result characters, continuation count, model-service time, input/output tokens, and recall by atom count. Do not add investigation rounds in this plan. If the atom-scaled arm does not beat `base` on recall without erasing the economics, ship `base` or keep packing dark.

## Validation Strategy

Validation is split into a free deterministic half and a paid model half.

### Validation spend and payback accounting

This plan describes paid validation but does not itself authorize an unbounded eval bill. Complete the deterministic replay first. Before the first paid model call, add `approvedValidationCostUSD: <amount>` to this plan's reconciliation note; the owner supplies the amount and there is no implicit default. Also record `actualValidationCostUSD`, `projectedRemainingCostUSD`, and the assumptions behind the projection after every paid phase.

Use staged measurements instead of guessing the final bill:

1. The six one-repeat A/B/C preflight executions establish actual small-fixture cost. Before repeat-10, project that phase as `10 * preflightCostUSD` because the repeat-10 suite is an additional ten executions of each preflight case.
2. For each real-model collateral suite, run its A side first and project the selected side from the measured A cost, with a 25% contingency. The fake-provider suite has zero model spend but still records its reported cost.
3. The two production cases run as one paired suite, so approve that phase before launching either case. Run D cost `$25.2852` in total: `$22.8517` in Stage 7 across 57 dispatched packets (`$0.4009` per dispatched packet) plus `$2.4335` outside Stage 7. For frozen packed count `P`, forecast a complete pair as `2 * $2.4335 + (96 + P) * $0.4009`, or `$73.02–$73.82` for `P in {74, 75, 76}`. Applying 25% contingency yields `$91.28–$92.28`; round upward and reserve **`$95`**. This budgets all 96 baseline packets plus all packed packets even if the 60-minute baseline later truncates. Replace the reservation with actual paired cost afterward.
4. Before starting any next phase, require `actualValidationCostUSD + projectedRemainingCostUSD <= approvedValidationCostUSD`. If it does not hold, stop for explicit owner approval rather than dropping recall or deterministic gates to save money.

The report script must aggregate cohort cost from `score.metrics.costUSD`, falling back to the actual value of the `maxCostUSD` budget result when necessary. It emits cohort `actualCostUSD`; the executor records cumulative actual/projected/approved amounts in the reconciliation note using the formulas above.

Normalize production payback to equivalent reviewed work because the baseline may truncate while the selected arm completes. For the pinned diff, set `equivalentTargetHunks = 142` and compute:

```text
baselineCostPerReviewedHunk = baselineProductionCostUSD / baselineReviewedHunks
selectedCostPerReviewedHunk = selectedProductionCostUSD / selectedReviewedHunks
baselineEquivalentReviewCostUSD = baselineCostPerReviewedHunk * equivalentTargetHunks
selectedEquivalentReviewCostUSD = selectedCostPerReviewedHunk * equivalentTargetHunks
equivalentReviewSavingsUSD = baselineEquivalentReviewCostUSD - selectedEquivalentReviewCostUSD
breakEvenReviewCount = ceil(actualValidationCostUSD / equivalentReviewSavingsUSD)
```

Report raw arm costs and reviewed-hunk counts beside the normalized values. Label either normalized value as an extrapolation when that arm reviewed fewer than 142 hunks; do not make a cheaper-but-more-truncated arm look efficient. If `equivalentReviewSavingsUSD <= 0`, there is no cost payback and the production economics gate fails. Keep this accounting separate from quality evidence: a fast payback cannot excuse a recall failure, and a high validation bill does not imply the feature is unsafe.

### A. Offline packet-shape replay (no model calls)

Add `scripts/packet-packing-report.ts`, with focused tests in `tests/packet-packing-report.test.ts`. Its `replay` mode accepts a repository path plus repeated `--run` directories, reads each run's `stages/01-input/resolved-input.json` and recorded planning/coverage artifacts, verifies that the recorded base/head refs exist, materializes the head in a temporary worktree, and rebuilds Stage 6 with packing off/on. It must never invoke an LLM. It writes one stable JSON report containing per-run packet/atom counts, promotions, cap violations, lens/note/context omissions, and flag-off parity, then exits non-zero on an invariant failure.

Run it across exactly these retained inputs:

- `.codegenie/runs/20260724-135818-740d73f2`
- `.codegenie/runs/20260724-150405-fe1548ae`
- `.codegenie/runs/20260724-162739-81f806a6`
- `.codegenie/runs/20260724-184952-dca8d870`

The motivating run must resolve to base `d1c49bdf6a8002ec2ec27faac94a932d736532b2` and head `fbb5f8761c2c296e115af17e919a7c35d9de8373`; a mismatch is stale evidence and a stop condition.

For every replay, assert:

- every reviewable hunk appears exactly once;
- no existing atom is split or internally reordered;
- no new cross-effective-coverage merge occurs;
- file/language boundaries, source order, five-hunk cap, and 12K patch cap hold;
- no planner-selected lens is newly dropped;
- every packed packet's effective review profile is at least the maximum standalone profile of its source atoms, and the base-mode tool budget reflects that effective profile;
- every flag-on dispatch rank equals the existing formula applied to the combined packet's file class and changed-line count; report scheduling-order movement by hunk;
- flag off is artifact-identical to the recorded/current builder behavior.

On `dca8d870`, the historical artifact replay predicts 75 packets, at least a 20% reduction from 96, and zero new coverage promotion. That 75 used `contentWithLineNumbers` length as a patch-size proxy, while the new replay must rebuild through the real `combinedPatchChars()` calculation. The first authoritative replay may reconcile the expected count to 74 or 76 only when the report attributes every changed split to that proxy-versus-real measurement difference, all design invariants still pass, and the reduction remains at least 20%. Record the explanation and freeze the authoritative builder result as the new exact golden. Any larger delta or any change caused by coverage, lens compatibility, atom boundaries, or cap policy is a stop condition; do not silently weaken the target. Report the distribution on the other runs; do not tune the algorithm to one fixture.

Packet JSON alone cannot faithfully rebuild repository context. For the pinned motivating diff, also rebuild Stage 6 off/on and compare cap pressure:

- no deep packet loses a requested lens or drops a context-quality grade;
- no high/critical planner focus note is newly omitted;
- no effective packed profile is below the maximum standalone member profile, and no corresponding base budget is lower; report derived profile downgrades, profile-floor applications, effective profile changes, and budget changes per source atom;
- report context truncations, related-context omissions, attention-note omissions, lens drops, dispatch-rank/order changes, and profile changes per reviewed hunk;
- investigate any new omission before running paid evals.

### B. Repeated recall/economics eval (paid)

The paid gate needs cases whose target packet actually changes. The accepted `acceptRoute` finding is useful evidence for cross-hunk reasoning, but it is **not** a packing treatment: it already came from a five-hunk baseline atom. Likewise, do not spend repeats on an existing eval merely because it is available; first prove that the expected finding's packet combines multiple baseline atoms with packing on.

Create a private local suite at `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-packing/recall/` with two materializable Go fixture repos (`repos/<case>/{base,feature}`) and A/B/C case YAMLs:

1. `dilution-control`: one changed hunk contains a locally detectable boundary bug (for example, changing an allowed `amount <= limit` check to `amount < limit`), while two to four different functions in the same file contain safe unrelated changes. Separate functions/hunks by more than `NEARBY_GAP_LINES`, so today's grouper produces multiple one-atom packets. The known bug's baseline packet must be one atom; B/C must combine it with at least one unrelated atom. This tests whether packing buries a valid local finding.
2. `cross-atom-consistency`: five separated sibling functions are changed; four apply the same new validation/veto before returning, while the fifth hunk makes another edit but omits that validation. Today's grouper must split the functions into multiple atoms; B/C must bring the inconsistent siblings into one packet. This tests the quality class exemplified by `acceptRoute` without relying on an already-packed production atom.

Each fixture has precise `should_find_candidate` and `should_find` expectations using path, line range, category, severity, title pattern, and failure-mode pattern. Keep the source compact but realistic enough for the finding to be inferable from code, not comments that state the answer. Do not copy proprietary production code into the fixture.

Author six case files (`dilution-{a,b,c}.yml`, `consistency-{a,b,c}.yml`) with `repeat: 1`, cache disabled, and identical provider/model/reasoning/concurrency/depth/lenses/time/token settings. The only arm differences are:

| Arm | Packing | Tool budget |
| --- | --- | --- |
| A — baseline | off | base |
| B — isolate shape | on | base |
| C — shape + capacity | on | atom-scaled |

Run the one-repeat treatment preflight, then use `scripts/packet-packing-report.ts eval` on the suite logs. For both cases it must prove:

- A's target packet has one source atom;
- B and C put the target hunk in a packet with at least two source atoms;
- B/C have fewer packets for the target file than A;
- target effective coverage and requested lens signature match across arms;
- the B/C effective profile and base budget are no lower than the maximum profile/base budget of every A packet corresponding to the packed source atoms;
- no target hunk/atom/cap invariant fails.

If either case does not receive the treatment, stop before repeat-10. Adjust fixture spacing/content or compatibility inputs and rerun the one-repeat preflight; do not count an unchanged packet as evidence for or against packing.

After both treatment checks pass, change all six files to `repeat: 10` and run the suite again. Plan 79 provides cache-off enforcement, per-expectation candidate/final recall, and loss histograms. For each case and each of B/C, at least 8 of 10 executions must receive the intended treatment. Fewer than eight makes that arm/case inconclusive and stops the rollout gate; it does not count as evidence against packing.

Use all ten executions in each arm for the primary **intent-to-treat** system comparison. This retains upstream Stage-5 variance instead of conditioning the rollout decision on an LLM-generated compatibility outcome. Also report a secondary treated-only diagnostic that excludes untreated B/C executions from both numerator and denominator and states its denominator explicitly. The treated-only slice helps attribute misses, but it is not the rollout gate and must not replace the all-execution comparison.

Candidate recall is the primary Stage-7 signal; final recall is the user-visible secondary signal. Keep the new YAML expectations measure-only for the first A/B/C characterization; the report applies the A-relative gate below. Fixed `minCandidateRate`/`minRecallRate` values may be ratcheted into the suite only after this baseline is recorded. For this plan, the operational non-inferiority/variance band is no more than one fewer hit across the 10 all-execution runs than A. For the rollout gate:

- no required expectation may fall from non-zero baseline recall to zero;
- aggregate candidate recall for the packed arm may be at most one hit in ten below A;
- aggregate final recall follows the same one-hit-in-ten non-inferiority bound;
- loss histograms must not show a systematic move to `missed-before-candidate-generation` as atom count rises.

A pass at `n = 10` rules out a large recall regression in these two constructed failure classes under the chosen model/configuration; it is not statistical proof of zero recall loss, universal safety, or behavior on every code shape. Preserve that limitation in the reconciliation note and rollout documentation.

Compare B to A to measure packing. Compare C to B to measure budget scaling. Do not credit C's recall to packing or B's economics to the scaler.

Define Stage-7 tool-pressure rate per arm as:

```text
rejectionRate = rejected repository-tool attempts / reviewed pre-existing source atoms
```

Report the rejection cause/limit when telemetry supplies it, result characters, used calls, continuations, and model-service time per reviewed atom. C qualifies as a budget fix only when `rejectionRate(C) <= rejectionRate(B)` and it either strictly reduces rejection rate or improves candidate/final recall. If C and B have equal recall and pressure, choose B. If the selected packed arm exceeds A by more than `0.10` rejected attempts per reviewed atom without higher candidate recall, stop and keep packing dark.

### C. Existing-suite collateral regression checks

After the repeated packing-sensitive gate selects B or C, run two broader suites flag-off and with the selected arm. These checks look for collateral damage in paths not covered by the two synthetic Go fixtures; they are not packing-attribution or statistical recall evidence.

1. Run the complete deterministic `evals/fixtures/` suite under A and the selected arm. Both use `repeat: 1`, the fake provider, and otherwise identical case content. Every declared positive/negative expectation, packet invariant, config parse, and eval execution must match/pass.
2. Run the complete real-model `evals/skill-semantics/` suite under A and the selected arm with each case temporarily overridden to `repeat: 1`. This covers TypeScript, Python, and Solidity with their existing positive and negative expectations. An A-pass/selected-fail difference is a stop-for-investigation, not proof from one sample; rerun only the affected case at `repeat: 3` before deciding whether it is variance or a reproducible regression.

Materialize A and selected copies in disposable directories, copying the complete suite including `repos/`, and change only `repeat`, `review.packSameFileHunks`, and `review.packedToolBudgetMode`. The report must verify those are the only YAML differences, that the selected setting reached resolved config, and how many selected executions actually packed multiple atoms. Untreated cases remain valid collateral checks for flag/config parity but are explicitly not evidence about packing recall.

Add a `regression` mode to `scripts/packet-packing-report.ts` that compares the two explicit log roots and reports eval errors, expectation transitions, packet/hunk/cap/profile invariants, treatment counts, tool pressure, and dispatch-order changes. It must not merge these one-repeat outcomes into the repeated packing-sensitive recall gate.

### D. One production-shaped capacity confirmation

After the repeated gate selects B or C, create two one-repeat cases under `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-packing/production/`: `pr846-a.yml` (packing off/base) and `pr846-selected.yml` (the selected B or C settings). Both use `repo.external: /home/peter/Dev/0xsequence/trails-api`, base `d1c49bdf6a8002ec2ec27faac94a932d736532b2`, head `fbb5f8761c2c296e115af17e919a7c35d9de8373`, concurrency 6, cache off, and a 60-minute limit. The historical run used concurrency 4 and a dirty Codegenie checkout, so it is evidence—not a clean A/B counterpart. Run both cases from the same clean Codegenie commit.

Confirm:

- at least the same hunk set is reviewed, with the target being all 142 reviewable hunks;
- accepted/candidate findings and known cross-hunk observations are not lost;
- total model-service time, total tokens, cost per reviewed hunk, and wall time improve;
- raw arm costs/reviewed-hunk counts and 142-hunk equivalent costs are reported, with truncation extrapolations labeled and positive equivalent-review savings required;
- context/tool pressure stays within the offline and eval gates;
- profile floors hold, and dispatch-order plus reviewed-hunk-set changes are reported so a Plan-100 ordering interaction cannot masquerade as a packing-quality result.

Let `P` be the authoritative frozen packed count from the replay (`74`, `75`, or `76`). The packet/concurrency capacity multiplier is `(96 / P) * (6 / 4)`, or approximately 1.89–1.95×—not 3×. Using the motivating run's 52.7 minutes of concurrency-normalized Stage-7 service over 57 dispatched packets, the completion projection is `52.7 * (P / 57) * (4 / 6)`, approximately 46–47 minutes. Recompute and record both values from the frozen `P`; do not leave a literal 75 in final rollout documentation if reconciliation chose another count.

## In-Scope Files

- `src/pipeline/packet-builder.ts` — atom metadata, compatible-atom packing, atom-aware budget mode, and artifact-only treatment telemetry; prompt/note construction stays unchanged.
- `src/types.ts` — the two review config fields and any telemetry/report metadata types.
- `src/config/schema.ts` — strict raw/resolved schema and defaults.
- `src/config/config-loader.ts` — apply both fields, source tracking, and repo-safe filtering.
- `src/evals/eval-runner.ts` — strict eval review schema and `applyCaseReviewConfig()` support.
- `scripts/packet-packing-report.ts` — no-LLM retained-run replay, A/B/C treatment/economics/cost reporting, existing-suite collateral comparison, and production payback inputs.
- `tests/packet-packing-report.test.ts` — replay/report parsing, profile/rank invariant failures, cohort selection, intent-to-treat versus treated-only analysis, treatment thresholds, spend/payback accounting, and regression-suite checks.
- `tests/pipeline-phase5.test.ts` — grouping, metadata propagation, profile monotonicity, invariants, context/lens/note behavior, dispatch rank, budget-mode tests, replay fixture.
- `tests/config-loader.test.ts` — defaults, precedence, source tracking, strict parsing, repo config.
- `tests/evals.test.ts` — eval schema/application for both fields and A/B/C fixture coverage.
- `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-packing/` — local packing-sensitive recall fixtures/cases and pinned production-capacity cases; validation assets, not shipped package content.
- `specs/plans/README.md` and affected `specs/project/` docs — document the final behavior/default and reconciliation evidence.

## Non-Goals

- Cross-file batching, even when languages match. File identity is the context/anchor boundary; language alone is not sufficient.
- Raising the five-hunk or 12K patch caps.
- Splitting current semantic atoms or changing `canJoinGroup()` semantics.
- Packing across different effective coverage levels to chase a 30% packet target.
- Reducing fixed prompt content or redesigning context/relationship caps.
- Changing prompt templates, attention-note ordering, or adding a packing-specific preamble. Those would require a separately measured arm/plan.
- Changing Plan 100's Stage-7 priority/coverage/dispatch-rank sort policy. This plan only recomputes the existing packet rank from combined membership and measures the resulting movement.
- Tuning the handful of metadata files that receive `standard/normal` where `simple` may suffice; track that separately.
- Adding investigation rounds or changing verifier/system-review budgets.
- Treating an existing eval as recall evidence when its target packet is unchanged by packing.

## Implementation Steps

1. Reconcile the drift/working-tree checks. Add both dark configuration fields end-to-end, including strict eval schema/application, repo-safe filtering, defaults, and config-source tests.

   **Verify:** `pnpm test -- tests/config-loader.test.ts tests/evals.test.ts` → exit 0; defaults are `false`/`base`, both eval overrides apply, strict schemas accept only the documented enum values, and config sources identify the winning source.
2. Refactor only `hunkFirstGroups()` outputs into explicit atoms. Define the exact lens signature/atom ID, capture each atom's exact flag-off standalone review profile, and preserve direct whole-file/file-diff paths. Add flag-off golden parity before enabling packing.

   **Verify:** `pnpm test -- tests/pipeline-phase5.test.ts -t "packet atom|standalone profile|flag-off parity|whole-file"` → exit 0; existing packet fixture serialization/telemetry is unchanged with packing off, and atom profiles equal the current standalone packet profiles.
3. Implement stable same-file compatible-atom packing, metadata merge rules, profile floor, and existing dispatch-rank recomputation under current caps. Emit packing/profile provenance only when packing is on; do not edit prompt/note functions.

   **Verify:** `pnpm test -- tests/pipeline-phase5.test.ts -t "same-file packing|profile floor|coverage promotion|lens signature|degradation|source order|attention|dispatch rank"` → exit 0, including six-hunk/cap splits, patch cap, interleaved lens partitions, mixed-coverage baseline atoms, hunk bijection, direct file-diff bypass, degradation propagation, exact dispatch-rank formula, and no newly omitted high/critical focus fixture. Include regressions where absorbed strong `symbol_mention`/`planner_hint` edges would derive `investigate → standard`, and where absorbed ordinary related context would derive `standard → simple`; effective profile/budget must remain at the member maximum. Add the distinct `primarySymbols` case: atom X retains a strong relationship to an external hunk whose context symbol has the same name as atom Y's primary symbol; packing X+Y expands the primary-symbol set and would otherwise disqualify X's still-external strong context. Also prove `same_symbol` alone does not invent an investigate floor.
4. Implement `base` and `atom-scaled` from pre-existing atom count, not hunk count. Keep rounds/source extension unchanged and apply `budgetBoost` last.

   **Verify:** `pnpm test -- tests/pipeline-phase5.test.ts -t "packed tool budget"` → exit 0; simple remains zero, an already-five-hunk one-atom packet is unchanged, non-simple scaling/caps include deep, and rounds are identical.
5. Add `scripts/packet-packing-report.ts` and its tests. `replay` must use temporary worktrees, recorded decisions, and zero model calls; `eval` must select an explicit latest cohort, join A/B/C by case/expectation, prove treatment from Stage-6 telemetry, compute all-execution and treated-only views, and compute per-atom economics/tool pressure; `regression` must compare explicit A/selected log roots without treating one-repeat outcomes as recall evidence. All paid modes aggregate actual cohort cost, and the production comparison emits raw cost/reviewed-hunk counts, normalized 142-hunk equivalent costs, equivalent-review savings, extrapolation labels, and break-even inputs.

   **Verify:** `pnpm test -- tests/packet-packing-report.test.ts` → exit 0; corrupt/missing refs, effective profile/budget downgrades, bad dispatch ranks, fewer than 8/10 treated B/C, cap/promotion/hunk-bijection failures, mixed cohorts, missing telemetry, incorrect treated-only denominators, collateral expectation regressions, missing spend data, and non-positive payback denominators all fail closed.
6. Run the deterministic four-run replay command below. Record its JSON table and cap/context/lens/note comparison in this plan's reconciliation note.

   **Verify:** command exits 0; `dca8d870` is 96→75 or the one-time documented 74/76 measurement reconciliation, with zero new promotion, zero effective profile/budget downgrade, valid dispatch ranks, and all deterministic acceptance criteria passing. Freeze the authoritative exact count; stop before paid model calls otherwise.
7. Create the two private packing-sensitive fixtures and six A/B/C YAMLs with `repeat: 1`. Record the owner-approved validation-cost ceiling, run the treatment preflight/report, and use its actual cost to project the additional repeat-10 phase before proceeding.

   **Verify:** provider/config errors do not occur; report exits 0; both B/C target packets combine at least two A atoms while every A target remains one atom; actual plus projected remaining spend is within the recorded ceiling. One-sample recall is recorded but does not decide rollout.
8. Change all six recall cases to `repeat: 10`, run the suite, and analyze the latest cohort.

   **Verify:** each B/C arm/case has at least 8/10 treated executions; the all-10 intent-to-treat candidate/final non-inferiority gate passes; treated-only diagnostics state their denominators and the n=10 limitation; loss attribution, tool pressure, economics, and the updated spend projection meet the gates below. Select B or C mechanically from those results.
9. Materialize and run A/selected disposable copies of the complete `evals/fixtures/` and `evals/skill-semantics/` suites at repeat 1, then run the report's collateral-regression comparison. Rerun only an A-pass/selected-fail real-model case at repeat 3.

   **Verify:** deterministic suites match/pass exactly; real-model selected cases have no reproducible positive/negative expectation regression; no eval/config/packet/profile/rank invariant fails; the selected-side projection is checked after measuring A and cumulative spend stays within the ceiling. Record treatment counts but do not use these runs as packing recall evidence.
10. Create/run the two pinned production-capacity YAMLs with the selected arm at concurrency 6.

   **Verify:** before launching the paired suite, its `$95` reservation fits the remaining ceiling; both cases run from the same clean Codegenie commit and exact base/head; actual paired cost replaces the reservation; the selected arm reviews at least the baseline hunk set and satisfies the production economics/context gates, including positive normalized equivalent-review savings.
11. Flip `packSameFileHunks` to true only if every gate passes. Set the winning tool-budget default, or leave both dark and record the failed gate. Update plan reconciliation, plan index, and architecture/component docs.

    **Verify:** `git diff --check` → exit 0; docs state the final defaults, n=10 limitation, actual validation spend, raw and normalized production economics, measured equivalent-review saving/break-even count, and authoritative throughput calculation without claiming an unmeasured 3× gain.
12. Run the complete repository gate.

    **Verify:** `pnpm run check && pnpm test && pnpm build` → exit 0.

## Tests and Commands

```bash
pnpm run check
pnpm test -- tests/pipeline-phase5.test.ts tests/config-loader.test.ts tests/evals.test.ts tests/packet-packing-report.test.ts
pnpm test
pnpm build
```

Deterministic retained-run replay (run from the Codegenie repository):

```bash
pnpm exec tsx scripts/packet-packing-report.ts replay \
  --repo /home/peter/Dev/0xsequence/trails-api \
  --run /home/peter/Dev/0xsequence/trails-api/.codegenie/runs/20260724-135818-740d73f2 \
  --run /home/peter/Dev/0xsequence/trails-api/.codegenie/runs/20260724-150405-fe1548ae \
  --run /home/peter/Dev/0xsequence/trails-api/.codegenie/runs/20260724-162739-81f806a6 \
  --run /home/peter/Dev/0xsequence/trails-api/.codegenie/runs/20260724-184952-dca8d870 \
  --output /tmp/plan102-packet-shape.json
```

Expected: exit 0, no model calls, four report rows, and `dca8d870` reports `offPackets: 96`, `onPackets: 75` (or the one-time documented/frozen 74/76 reconciliation), `newCoveragePromotions: 0`, `effectiveProfileDowngrades: 0`, and `invalidDispatchRanks: 0`.

Packing-sensitive one-repeat preflight, followed later by the same commands after changing all six cases to `repeat: 10`:

```bash
pnpm dev -- eval \
  --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-packing/recall \
  --no-cache

pnpm exec tsx scripts/packet-packing-report.ts eval \
  --logs /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-packing/recall/logs \
  --cohort latest \
  --expected-repeats 1 \
  --output /tmp/plan102-eval-preflight.json
```

Expected preflight: the report exits 0, proves treatment for both B/C cases, and emits cohort `actualCostUSD`; the reconciliation note records the owner-approved ceiling and `10 * preflightCostUSD` repeat-10 projection before continuing. A one-sample finding miss is measurement, not a treatment failure; an eval configuration/provider error or report failure is a stop condition. For the paid gate, rerun with `--expected-repeats 10` and output `/tmp/plan102-eval-repeat10.json`; each B/C arm/case must be treated in at least 8/10 executions, the primary all-execution recall/economics gates must pass, the report must separately label treated-only diagnostics and denominators, and cumulative actual/projected cost must remain within the ceiling.

Existing-suite collateral comparison (after creating the disposable A/selected suite copies described above):

```bash
pnpm dev -- eval --eval-dir /tmp/plan102-regression/fixtures-a --no-cache
pnpm dev -- eval --eval-dir /tmp/plan102-regression/fixtures-selected --no-cache
# Run the real-model A suite, record actual cost, and check the selected-side
# projection against the approved ceiling before executing the next command.
pnpm dev -- eval --eval-dir /tmp/plan102-regression/skill-semantics-a --no-cache
pnpm dev -- eval --eval-dir /tmp/plan102-regression/skill-semantics-selected --no-cache

pnpm exec tsx scripts/packet-packing-report.ts regression \
  --baseline-logs /tmp/plan102-regression/fixtures-a/logs \
  --selected-logs /tmp/plan102-regression/fixtures-selected/logs \
  --cohort latest \
  --expected-repeats 1 \
  --output /tmp/plan102-fixtures-regression.json

pnpm exec tsx scripts/packet-packing-report.ts regression \
  --baseline-logs /tmp/plan102-regression/skill-semantics-a/logs \
  --selected-logs /tmp/plan102-regression/skill-semantics-selected/logs \
  --cohort latest \
  --expected-repeats 1 \
  --output /tmp/plan102-skill-semantics-regression.json
```

Expected: all four suite invocations and both comparisons exit 0; each report uses explicit A/selected log roots without cohort mixing, emits actual cohort cost, shows no deterministic expectation/config/packet/profile/rank regression, and the skill-semantics report labels its real-model results as one-repeat collateral evidence only. The measured real-model A cost plus 25% contingency was checked before running its selected side, and cumulative actual/projected spend remains within the ceiling.

Pinned production-capacity comparison:

```bash
pnpm dev -- eval \
  --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-packing/production \
  --no-cache

pnpm exec tsx scripts/packet-packing-report.ts eval \
  --logs /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-packing/production/logs \
  --cohort latest \
  --expected-repeats 1 \
  --output /tmp/plan102-production-capacity.json
```

Expected: reserve `$95` before starting; both cases and the report exit 0; the report emits baseline/selected actual cost, reviewed-hunk counts, 142-hunk equivalent costs, extrapolation labels, and the remaining production/context metrics. Replace the reservation with actual cost, record the final cumulative validation spend, and compute `equivalentReviewSavingsUSD` plus `breakEvenReviewCount`; non-positive normalized savings fail the economics gate.

## Acceptance Criteria

- Flag off produces byte-identical packet artifacts and budgets.
- Flag on preserves every existing atom and assigns every reviewable hunk exactly once, in source order, under the existing file/language, hunk-count, and patch-size boundaries.
- No new effective-coverage promotion and no newly dropped planner-selected lens.
- Every packed packet's effective review profile is at least the maximum standalone profile of its source atoms, and base-mode tool budget is computed from that effective profile. Derived downgrades and floor applications are reported; effective profile/budget downgrades are zero.
- Flag-on dispatch ranks use Plan 100's unchanged `[fileClassRank, -packetChangedLines]` formula; scheduling-order movement and reviewed-hunk-set effects are reported rather than hidden.
- Direct whole-file/content-probed file-diff groups bypass packing; combined hunk-first groups preserve degradation reasons and do not synthesize whole-file context.
- The motivating replay produces 75 packets, or a one-time 74/76 reconciliation proven to come only from replacing the historical patch-size proxy with real `combinedPatchChars()`; the resulting exact count is frozen, the reduction remains at least 20%, all other retained runs are reported, and none gains packets.
- Pinned Stage-6 rebuild shows no deep context-quality downgrade, requested-lens loss, or newly omitted planner focus from a high/critical-priority hunk.
- Every repeated recall comparison is treatment-valid: each B/C arm/case receives treatment in at least 8/10 executions, target coverage/lens/profile-floor invariants hold, and treatment counts are explicit. Primary recall uses all ten executions; treated-only rates are secondary diagnostics with explicit denominators.
- Packed repeated-eval candidate recall across all ten executions is no more than one hit below A and within the established band; final recall obeys the same one-hit-in-ten non-inferiority bound; no required expectation falls from non-zero to zero, and loss attribution does not worsen systematically with atom count.
- The selected arm's Stage-7 tool rejection rate is within the stated per-atom gate. C is selected only if it reduces normalized pressure or improves recall over B; unused extra allowance is not a reason to ship it.
- Complete flag-off/selected runs of `evals/fixtures/` and one-repeat `evals/skill-semantics/` show no deterministic or reproducible collateral regression; their results are not counted as packing-attribution evidence.
- The selected budget arm improves production-shaped reviewed-hunk throughput, wall time, total model-service time, tokens per reviewed hunk, and cost per reviewed hunk. Extra continuations may not erase more than 15% of the packet-count service-time saving.
- The clean concurrency-6, 60-minute capacity run reviews at least the same hunk set as baseline; target completeness is all 142 reviewable hunks.
- Paid validation never begins without an owner-approved ceiling; every phase records actual/projected spend and remains within it. The production pair reserves `$95` from full-workload run-D evidence. Final evidence records total validation cost, raw costs/reviewed-hunk counts, normalized 142-hunk equivalent costs, positive equivalent-review savings, break-even review count, any truncation extrapolation, and the limitation that n=10 only screens for large regressions in the constructed cases.
- Config, eval, focused tests, full tests, checks, and build pass; final defaults and evidence are documented.

## Stop Conditions

- Any existing atom is split/reordered, any hunk is lost/duplicated, any cap is exceeded, or packing introduces a coverage promotion: fix the deterministic design before any paid run.
- The no-LLM replay cannot reproduce flag-off artifacts from recorded inputs, resolves different production refs, or cannot explain a 74/76 count solely by the historical patch-size proxy: reconcile evidence/design before continuing.
- Packing newly drops a requested lens, produces an effective profile/base-budget downgrade, computes an invalid dispatch rank, degrades a deep packet's context quality, or omits a planner focus from a high/critical-priority hunk: keep the flag off and fix the deterministic design.
- The reconciliation note lacks an explicit owner-approved paid-validation ceiling, spend telemetry is unavailable, or actual cost plus the next-phase projection exceeds that ceiling: stop before the next paid call and request approval; do not reduce quality gates to fit the budget.
- The selected production arm does not lower cost per reviewed hunk or `equivalentReviewSavingsUSD <= 0`: the production economics gate fails; keep packing dark rather than claiming savings from unequal reviewed workloads.
- Any B/C arm/case receives treatment in fewer than 8/10 executions: mark it inconclusive and stop. Do not silently discard enough untreated runs to create a favorable denominator.
- Candidate/final recall falls outside the stated variance gates, a required expectation drops to zero, or misses shift systematically toward candidate-generation failure: keep packing dark; do not trade recall for cost.
- The selected arm introduces a deterministic existing-suite failure or a real-model A-pass/selected-fail difference that reproduces at repeat 3: keep packing dark and investigate collateral behavior before rollout.
- C increases normalized tool rejections over B, or neither reduces pressure nor improves recall: choose B if B otherwise passes; do not ship unused budget.
- If B fails recall but C passes, accept C only if its added continuations preserve at least 85% of the packet-count service-time saving. Otherwise keep the flag off and write a follow-up for a different budget policy.
- If B and C both pass recall, choose the cheaper/faster arm; do not ship extra budget without measured value.
- If the clean production-shaped run cannot complete the target hunk set within 60 minutes, record the true throughput and leave the completion claim unresolved; do not weaken recall/context gates to hit the clock.
- If in-scope code drift invalidates atom boundaries, coverage semantics, or the eval harness assumptions, update this plan's design and replay before implementation.

## Maintenance Notes

- Any future change to `hunkFirstGroups()`, `canJoinGroup()`, `buildRelatedChangedContext()`, `hasStrongRelatedChangedContext()`, `packetReviewProfile()`, coverage levels, planner lens routing, packet caps, attention-note caps, `packetDispatchRank()`, or `toolBudget()` invalidates the recorded shape/profile/budget/order baselines; rerun the deterministic report before changing defaults.
- Reviewers should scrutinize flag-off artifact parity, atom provenance, coverage/lens compatibility, profile monotonicity, treatment validity, dispatch-order movement, and continuation service time—not packet count alone.
- Cross-file packing, larger packets, investigation-round scaling, prompt changes, and simple-profile tuning remain separate experiments because each changes a different quality/cost mechanism.
