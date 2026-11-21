---
created: 2026-11-19T20:21:21Z
author: architect
source: "https://github.com/0xPolygon/codegenie/issues/44 (workstream A: pipeline architecture)"
status: provisional
---

# Pipeline architecture: what each stage guarantees, what it costs, and where signal is lost

Reviewed codegenie 0.8.0 at master `f240376`. Nothing was run against a model. Paths are relative to the repo root; `RR` = `src/pipeline/review-runner.ts`, `PL` = `planner.ts`, `PB` = `packet-builder.ts`, `LR` = `lens-runner.ts`, `SR` = `system-reviewer.ts`, `UP` = `uncertainty-promotion.ts`, `VF` = `verifier.ts`, `C` = `composer.ts`, `HA` = `human-attention.ts` (all in `src/pipeline/`), `PR` = `src/llm/pi-runner.ts`, `PBD` = `src/skills/prompt-builder.ts`.

**How this was produced.** I read the orchestrator, the composer's publication path, the verifier's gate and verdict path and the spec's pipeline sections myself. Ten read-only sub-reviews mapped one block each with file:line evidence; I re-read the code behind every claim in sections 1, 3 and 6 before keeping it. Claims I did not re-read are in the block table (section 4) and are marked *(sub-review)*. Hypotheses are labelled.

## 1. Bottom line

1. **The architecture is sound and its central promise holds.** Code, not the model, owns stage order, hunk accounting, anchors, verdict application, caps and disclosure. The model cannot drop or invent a finding in stage 10, cannot place a comment off the diff, and cannot hide an unreviewed hunk.
2. **Recall is lost mainly after a bug has been found**, at confidence handling. A finding the verifier kept with established proof is still suppressed when its confidence is `low`, unless it passes a seven-condition hatch (`C:1632-1660`, `C:1707-1739`). The same threshold also gates entry to verification (`VF:1346-1355`), with a second, differently tuned hatch. Confidence is a self-report from stage 7 or a constant from promotion (`UP:492-500`); nothing derives it from the verifier's proof.
3. **Roughly a third of the pipeline code is recovery or compensation**, and the compensators interact. The clearest chain: promotion assigns `low` → the gate would drop it → a lane readmits up to four → the verifier must restate confidence without a rubric → stage 10 drops `low` again → a second hatch readmits some.
4. **About 900 lines are dead in production today** and can go without changing behaviour (section 5, group A). The largest is 540 lines of note suppression in `HA` that the only production caller disables.
5. **Four mechanisms are unmeasured in the configuration users actually run.** Stage 8 targeted review, the promotion heuristics, the planner's depth choices and the packet context enrichment each cost hundreds of lines; none has a recorded yield on the default config. The adaptive second pass is on in the eval cases and off in the product default, so the default has no recall measurement at all.
6. **Nothing measures master.** The newest recorded eval runs are on 0.6.x from September (`specs/plans/122-…md:4,121-136`). Every number in the repo predates 0.7.0 and 0.8.0, and precision is not measured at all (`rg -i precision src/evals` returns nothing).

## 2. The pipeline as the code runs it

`runReview` (`RR:113-429`) is one straight function. Stage numbers are the code's (`src/review-stages.ts:11-24`).

| Stage | Entry | In → out | Model calls | What code guarantees |
|---|---|---|---|---|
| 1 input | `resolveInput` `RR:130` | target → `ResolvedReviewInput` (pinned SHAs, raw diff) | none | All later reads go through git at pinned commits, never the worktree |
| 2 diff, filter | `parseDiff`, `filterDiffFiles` `RR:149,161` | raw diff → `UnifiedDiff`, kept files, `FileFilterDecision[]` | none | Parser fails loudly on malformed hunks; every skipped file has a recorded reason |
| 3 classify | `classifyChangedFiles` `RR:190` | kept files → `FileFacts[]` | none | Language, test status, package root |
| 4 index | `buildRepositoryIndex` `RR:205` | → symbol facts, static signals, nine read-only tools | none | Tree-sitter symbols; tools are repo-wide and read-only |
| 5 plan | `buildPlannerDossier`, `runPlanner` `RR:208-217` | dossier → `ReviewPlan` | 1 (or 1 per chunk), no tools | Unknown hunk ids and lenses dropped; failure falls back to `defaultPlan` |
| 6 packets | `buildReviewPackets`, `applyCoverageEscalations` `RR:219-228` | plan + diff → `ReviewPacket[]` | none | Every non-skip hunk lands in exactly one packet; a hunk the planner omitted gets `normal` |
| 7 review | `runLensPackets` `RR:249` | packets → `PacketReviewResult[]` | 1 per packet (all lenses in one prompt), with tools | Schema validity, anchors checked against the diff, failed packets counted as failed hunks |
| 8 follow-ups | `runTargetedSystemReviews`, `promoteUncertaintiesForVerification` `RR:258-272` | hints → extra candidates | ≤3 (system review); promotion is pure code | Promoted candidates carry no anchor |
| 9 verify | `verifyFindings` `RR:276` | candidates → kept findings, verdicts | 1 per distinct candidate, with tools | Keep needs established proof and required evidence; reject and incomplete never publish |
| coverage | `aggregateRunCoverage` `RR:289` | → `RunCoverageStatus` | none | Any hunk not accounted for is counted failed and makes the run partial |
| 10 compose | `dedupeRankAndComposeReview` `RR:316` | kept findings → `ReviewResult` | 1, no tools | Model cannot drop, invent or re-rank; thresholds and caps are code |
| 11 publish | `maybePublishToGitHub` `RR:354` | → one PR review | none | Stale-head guard, anchor re-validation, sanitisation, duplicate skip |

Three things the spec's algorithm (`specs/project/architecture.md:1279-1296`) leaves out and the code does: coverage escalation, stage 8, and promotion.

**The coverage guarantee is not where the spec puts it.** The plan is advisory: `validatePlan` has no completeness check (`PL:1354-1365`) and the prompt asks only for non-default entries. The guarantee is structural. Stage 6 walks the diff, so an omitted hunk becomes `normal` (`PB:1315-1321`), and accounting counts totals from the diff, so anything missing is a failed hunk (`RR:988,1023-1024`). This is the right design; the pipeline already runs end to end on an empty plan.

**One planner decision has no floor.** A `skip` with any non-blank reason removes a source hunk from review (`PL:1368`, `PB:1323-1331`). It is counted and listed, but nothing deterministic checks it. This is Backlog issue #31.

## 3. Where a true finding can be lost, in pipeline order

Each line is a place where a material bug that the pipeline could have reported does not reach the report. "Disclosed" means the report says something was lost.

**Before review**
- Whole-file skip on a generated marker in the first 64 lines, a `vendor`/`third_party` path segment, or a gitignore match on a tracked file. Disclosed as a filter reason. *(sub-review: `src/git/detectors.ts:73-90,274-299`)*
- Planner `skip` (above). Disclosed.
- A hunk over 12,000 chars is shown as a window around its median changed line (`PB:1406-1420`) and still counted reviewed. Not disclosed.
- `light` coverage, or a "mechanical" packet, gets the `simple` profile and therefore zero tools (`PB:2919-2922,2966-2970`). Not disclosed.
- **Bug:** a packet escalated to `deep` by the test-coverage rule keeps its old profile, so an escalated `simple` packet is "deep" with a zero tool budget (`src/pipeline/coverage-escalation.ts:39-44` calls `toolBudget("deep", …, packet.reviewProfile)`; `PB:2920`).

**Stage 7**
- One draw per packet. This is the variance the earlier studies measured (10 passes in 24 runs on a one-bug case, `specs/reviews/1-fable-review.md:172`).
- At most 2 hints and 1 uncertainty per packet survive (`LR:69,76`); the rest never reach promotion, the adaptive trigger or the notes.
- A timed-out or terminally invalid pass returns `findings: []` even when a finding was drafted (`LR:155-164`). Disclosed as failed hunks.

**Stage 8**
- Targeted review needs the same normalised question with the same files and symbols from two packets (`SR:374,405`), and low-confidence hints are excluded (`SR:368`). It was skipped in both local runs I could inspect, one of which reviewed 184 packets (`.codegenie/runs/20260818-133551-afaf2ec1`, `…/20260924-145255-68962f68`: one `system_review_skipped` event each). Two runs prove nothing, but the trigger is narrow by construction.
- Promotion admits `min(4, max(2, ceil(3% of packets)))` candidates per run (`UP:992-995`), chosen by keyword regexes and about twenty weights.

**Stage 9**
- **Pre-verification gate.** A candidate below `minConfidence` with medium or low severity is dropped unverified unless it is `low`, has related evidence, a failure mode of 24+ chars and a category in logic/correctness/security (`VF:1346-1355,1382-1388`). Recorded in `verification.json`; not disclosed.
- **Lane cap.** At most four such candidates are verified; the overflow gets a telemetry record and nothing else — no verdict, no incomplete count, no disclosure (`VF:1449-1451`, `VF:330-337`).
- **No retry.** Verifier tasks run with `retryOnTransient: false` (`VF:320`). A timeout, a provider error or an unrepairable submit yields an incomplete verdict, and incomplete verdicts never publish (`VF:389-392`). The run is marked incomplete, but the candidate itself appears nowhere in the report.
- **Budget tail.** After the first reservation fails, every later candidate is budget-limited (`VF:1454-1457`). Disclosed.
- **Any essential assumption forces reject** (`VF:793-798`). The question survives as a note.
- **One verdict governs a whole cluster** (`VF:397-398`). Clustering is exact-match only, so this is low risk.

**Stage 10**
- **`minConfidence` again**, with no exemption for critical or high severity (`C:1632-1660`). The verifier deliberately schedules low-confidence critical/high candidates (`VF:1349-1351`); if it keeps one without raising confidence, stage 10 drops it unless the hatch passes. The hatch (`C:1707-1739`) needs: confidence exactly `low`, a qualifying verdict on the representative's own id, one of five categories, changed code of 12+ chars with related code, failure mode 36+ chars, impact 24+ chars, and a word such as "test" or "verify" in the verification text. Not disclosed; the finding exists only in `final-findings.json`.
- Above 40 kept findings the lowest-ranked are trimmed (`C:1315-1330`). Disclosed.
- A composer error that is neither budget exhaustion nor a recoverable LLM error throws (`C:128-136`); `retainedReview` is assigned only after the composer returns (`RR:329`), so the failure report has no findings even though verification finished. The spec says stage-10 invalidity must not drop verified findings (`architecture.md:1386`).

**Stage 11**
- A new finding within five lines of any earlier codegenie comment on the same path and side is skipped as a duplicate, whatever it says (`src/github/duplicate-detector.ts:77-91`), and skipped findings are not moved into the review body (`src/github/publisher.ts:124-127`).
- A throw in stage 11 loses the finished review from the pull request when telemetry is off, which is the default. *(sub-review: `src/github-action/entrypoint.ts:249-272`)*

**Where noise gets in**
- `falsePositiveRisk: "high"` on a keep is not blocked (`VF:799-801`), although the spec lists "false-positive risk is not high" as a keep criterion (`architecture.md:1479`).
- The verifier is shown the reviewer's full claim and is told a bare keep endorses its confidence and severity (`PBD:358`). It checks the reviewer's argument; it does not re-derive one.
- Stage 8 loads skills for whatever lens ids the model suggests, without the enabled or language filter. *(sub-review: `SR:271`)*
- A neighbour's confidence can lift a low-confidence representative over the threshold (`C:874-912`).

## 4. Building blocks: guarantee, cost, verdict

Lines are non-test source lines. "Model cost" is per run.

| Block | Lines | Guarantee it provides | Model cost | Pulls its weight? |
|---|---|---|---|---|
| Input, diff, filter, classify (`src/git`) | ~3,150 | Pinned revisions, strict parse, recorded skips | none | **Yes.** Small dead surface only. |
| Repository index, tree-sitter, tools (`src/repo`) | ~5,900 | Symbols, nine bounded read-only tools | none | **Yes**, with one dual source of truth: the regex symbol path also runs when a tree exists but no symbol encloses the hunk, and names Go methods differently from tree-sitter; four normalisers compensate *(sub-review: `src/repo/symbol-extraction.ts:54-58`)*. |
| Planner (`PL`) | 1,690 | None that stage 6 does not also give | 1 call | **Unproven.** About 39% is core; 31% is dossier compaction and chunking; 25% is recovery. In the one study that looked, every matched expectation came from a normal-coverage packet (`specs/reviews/2-baseline-wave2.md:101-109`). |
| Packet builder (`PB`) | 3,018 | One packet per hunk group; size caps | none | **Core yes (~1,100). Enrichment unproven (~1,500):** relationship graph, adaptive symbol budget, hint prefetch. No single budget bounds the prompt, and the patch is serialised twice in every stage-7 prompt *(sub-review: `PBD:785`, `src/types.ts:462-463`)*. |
| Stage 7 (`LR`, worker runner) | ~1,270 | One call per packet, isolation, failed-hunk accounting | ~83% of tokens in the one small run with a per-stage table | **Yes.** Ensemble (off) and adaptive pass (off) are about a third of `LR`. |
| Stage 7 submit repair (`src/llm/stage7-submit-repair.ts`) | 624 | — | — | **Mostly no.** Its candidate cleanup strips keys that the shared validation already strips, so it cannot recover what just failed *(sub-review: `:272-317` vs `PR:2675,2719`)*. |
| Stage 8 targeted review (`SR`) | 540 | — | ≤3 calls when it fires | **Unproven;** narrow trigger, no recorded yield. |
| Promotion (`UP`) | 1,039 | Promoted candidates are anchorless and must be restated by the verifier | none directly; ~4 verifier calls | **Useful but over-built.** It is the only rescue path in the default config and converted about 4 in 10 (`2-baseline-wave2.md:62-63`). 95 lines of related-signal association have no reader in `src`. |
| Verifier (`VF`) | 1,977 | The precision gate: proof, evidence, anchors | 1 call per candidate | **Yes — the most valuable stage.** But its static prompt is 14,300 chars, the largest of any stage, and most paragraphs concern assessing the suggested fix and test rather than the defect (`PBD:361-362,369-371`). |
| Composer (`C`, content, repair) | ~2,630 | Model cannot drop, invent, re-rank or change metadata | 1 call | **Guards yes.** The deterministic fallback is complete, so the model call buys wording and semantic merging only. Root-cause grouping (~250 lines, ten thresholds) is advisory when the model composes. |
| Human-attention notes (`HA`, reconciliation) | 1,582 | Notes cite real files and symbols | part of the composer call | **Doubtful at this size.** ~540 lines are dead; the rest yields at most five bullets, and any surviving note turns health to "unresolved" and replaces the model's summary (`C:314-321`, `src/util/review-health.ts:19-23`). |
| Agent loop (`PR`) | 4,429 | Budgets, deadlines, trusted submit arguments, bounded repair | — | **Yes, but it is five things in one file.** The turn loop is under 1,000 lines; ~20% is telemetry, ~20% provider mapping, ~15% repair. Stages 5, 7 and 10 have branches inside it. |
| Budget ledger (`RR:1454-1764`) | ~310 | Soft stop at 85% for stages before 9; hard stop at twice the time limit | — | **Yes.** The reserve is why a budget-stopped run still verifies and composes. |
| Telemetry (`src/telemetry`) | ~2,500 | Scrubbed artifacts per stage | — | **Yes, with duplication:** three files re-project the same counters, and two aggregates have no reader *(sub-review)*. |
| Publisher, Action (`src/github*`) | ~2,740 | Stale-head guard, anchor validation, sanitising, event gate | none | **Yes.** 130 lines mine 422 payloads on an unmeasured assumption. |
| Skills overlay (`src/skills`) | 1,600 | Per-stage section projection, size caps, provenance by skill id | none | **Yes.** The cleanest block. One trust question and one layering problem (section 7). |

**Cost shape.** Cost is linear in packets and stage 7 dominates. The largest local run reviewed a 548-hunk diff as 282 packets, reached the 8M token soft stop inside stage 7 after 547 calls and $46.60, left 137 hunks unreviewed and published nothing (`.codegenie/runs/20260924-145255-68962f68`). `review.depth` does not change this: it scales tool budgets and one nudge threshold, and leaves packet count, verification and composition alone (`PB:2935-2940`, `LR:903-911`). Anything that wants to be cheaper has to cut packets or stages, not depth. Plan 102 (same-file packing) targets packets and is still `PENDING`; none of it is in `PB`.

## 5. Simplification candidates

### A. Delete now: no behaviour change in production

| What | Where | Lines | Why it is safe |
|---|---|---|---|
| Note suppression by finding or verdict | `HA:249-439,771-1008,1066-1140` | ~540 | The only production call passes empty findings and resolutions (`C:267-273`); `buildVerificationResolutionIndex` has test callers only. Plan 121 superseded it. @lead-dev reached the same result independently. |
| Gate-only representative anchor | `src/pipeline/pipeline-utils.ts:183-203`, `VF:1921-1926`, `C:800-818` and call at `C:100`, `src/types.ts:809` | ~65 | `"backfill_packet_representative"` is never assigned in `src` (rg: only readers and tests). Plan 109's fix for the "dead hatch" therefore guards a path that no longer exists. |
| Budget-extension chain | `src/telemetry/run-artifacts.ts:967-980` and readers | ~90 | The granting events are never emitted *(sub-review)*. |
| `finalizeMode: "compact"` | `PR:486` and six type sites | ~40 | Only `"full"` is produced. It is in the cache key, so bump the message version. |
| Planner multi-candidate ranking, chunk-duplicate guard | `PL:387-410,675-681,1017-1029` | ~37 | Guarded to exactly one submit; chunks partition files *(sub-review)*. |
| Zero-caller helpers | `validateAnchorForPacket`, `isRecoverableTransientLlmError`, `stage7SubmitRepairDecision`, `extraStage7FindingKeys`, `repositoryToolsToDefinitions`, `GitClient.fetch/lsFiles` | ~110 | rg finds definitions only *(sub-review)*. |
| Promotion related-signal association | `UP:346-442` | ~95 | No reader in `src`. It does reach the verifier inside the candidate JSON, so confirm with one replay that verdicts do not move. |

Before deleting, each needs the tests that pin the *production* behaviour to exist first; several current tests pin the dead path instead.

### B. Contract fixes: small, each removes a special case

1. **Make the verifier's verdict the publication gate, and delete both hatches.** A keep or revise already requires established proof, no essential assumption and required evidence (`VF:793-818,851-854`). A finding that passes that and is then dropped for `low` confidence contradicts the contract the code just enforced. Proposal: in stage 10 apply `minConfidence` only when verification did not run (`verify=false`); treat `falsePositiveRisk: high` on a keep as a reject, which the spec already says; keep `minInlineConfidence` as the one rule that decides inline versus summary. This deletes the hatch (61 lines, five categories, three length thresholds, one regex) and probably the merged-confidence lift (59 lines), and fixes the bug where the hatch bypasses `minInlineConfidence` (`C:1656` returns before `C:1661`).
   - *Why it might not be equivalent:* low-confidence kept findings outside the five hatch categories (architecture, maintainability) would start to appear, as summary-only.
   - *Measure first, without a model:* across stored eval runs, list `final-selection.json` records with reason `confidence-threshold` whose verdict was keep or revise, and adjudicate each as true or false positive. Adopt if their false-positive share is no worse than that of published findings on the same runs. *Kill:* worse, or any `should_not_find` sentinel appears.
2. **Disclose lane overflow.** Count lane-limited candidates into `verificationIncompleteCount` so the existing banner covers them (`VF:330-337`). No new mechanism. *Measure:* `lowConfidenceEvidenceLaneLimited` across stored runs; if it is always zero, delete the lane cap instead.
3. **Retain the review before composing.** Assign the retained result from the verified findings and the deterministic fallback before the composer call, so a composer throw degrades to the fallback report (`RR:316-329`, `C:128-136`).
4. **Escalation must recompute the profile** (`coverage-escalation.ts:43`). Twelve packets were escalated in one local run; how many were `simple` is not recorded.
5. **Carry `provenance` through a revise, or delete the code that reads it.** `revisedFinding` drops it (`VF:1284-1301`), every surviving promoted candidate is forced through revise (`src/llm/verifier-revision.ts:32-37`), so `isPromotedFinding` (`C:2074`) is false for all of them and the promoted branch of representative selection (`C:2059-2071`) only runs with `verify=false`.
6. **One default-lens function.** Two exist and disagree: all core lenses plus language (`PL:1566-1583`) versus language plus one core lens (`PB:2896-2912`). Needs a decision on which is intended.

### C. Measure, then keep or delete

Each has a real cost and no recorded yield on the default config. The measurements below read existing artifacts unless marked.

| Mechanism | Lines | Measurement | Delete when |
|---|---|---|---|
| Stage 8 targeted review | 540 | Share of stored runs where it fired; kept findings whose `producedBy.stage` is 8 | It fired in under 1 run in 10 or produced no kept finding that stage 7 or promotion did not also produce |
| Promotion heuristics (eligibility chain, rank, local-delta reserve) | ~450 of 1,039 | Per run: which rule selected each promotion and its verdict | Selection by reviewer confidence and pointer presence alone would have picked the same kept candidates |
| Planner depth and skip decisions | most of `PL` | Paired runs, plan versus `defaultPlan`, on the private cases *(paid; needs approval)* | No recall difference over N repeats; then the fast lane gets a no-model planner for free |
| Packet enrichment (relationship graph, adaptive symbol budget, hint prefetch) | ~1,500 | Tool calls and candidates per packet with and without each *(paid)* | No change in candidate yield and no rise in tool calls |
| Ensemble `deepEnsemblePasses` | ~100 + plumbing | Already measured and switched off; the owner's sunset count is 18 of 20 (`specs/plans/PUNCHLIST.md:71`) | Now, unless the cache-key collision @lead-dev reproduced is fixed first, because with the cache on K=2 is not two draws |
| Adaptive second pass | ~185 | It is on in the eval cases and off by default (`LR:271`) | Decide one way: default it on, or delete it. Today the measured product and the shipped product differ |
| Stage 7 submit repair beyond array defaulting | ~300 | `stage7_schema_cleanup_*` recovered counts in stored runs | Recovered count is zero |
| Human-attention reconciliation | 397 + ~400-word prompt | Share of notes resolved or narrowed per run; share of runs ending "unresolved" | Notes are rarely resolved, or most runs end "unresolved" regardless |
| Verifier remedy assessment | most of the stage-9 prompt | Keep rate on known true positives and sentinel rejections with and without the remedy paragraphs *(paid)* | Proof quality is no worse without them; then move remedy checks to a separate, optional step |

## 6. What would harden recall and precision

Ranked by expected effect on the stated goal.

1. **Stop losing found bugs at confidence** (B1, B2). In runs 52, 55 and 57 the verifier kept the bug, composition suppressed it and the report said "Everything looks good" (`specs/plans/110-…md:33-37`). Five plans patched individual paths; the gate that causes them is still there twice.
2. **Give the verifier one job.** It decides whether findings publish, yet it also assesses fixes, tests and caller contracts in the same call under an eight-call budget. Recorded effect: stage 9 took 13m41s against 8m06s for stage 7 on a small case (`specs/plans/117-…md:40`). Hypothesis: this both costs time and causes budget-pressure rejections of real findings. Measure as in table C.
3. **One retry for a failed verification.** Stage 7 retries a packet; stage 9 does not retry a candidate (`VF:320`). A single transient error there deletes a found bug from the report. Reusing the worker runner's existing retry flag is a one-line change; its cost is bounded by the number of failures.
4. **Show unverified candidates when verification could not finish.** Under the existing "review incomplete" banner, list the candidates that got no verdict, labelled as unverified. Today the reader learns that something was lost and not what. This is a decision: the spec says unverified candidates are not publishable (`architecture.md:1496`).
5. **Measure precision.** The scorer already computes unmatched finding ids (`src/evals/eval-scoring.ts:199-201`) and the run score does not use them *(sub-review)*. Without a false-positive rate, B1 and every cross-model comparison are guesses. @lead-dev's note covers the scorer.
6. **Re-baseline on master before changing anything**, default config, N repeats, at least two model families. Everything above is argued from code and from numbers that are two releases old.

**Across model families.** Three parts of the design assume a model's self-report is calibrated: stage-7 confidence, hint confidence (low-confidence hints are excluded from stage 8, promotion and notes), and the verifier's free choice of whether to restate confidence. The cross-model study saw 4 findings from one family and 7–10 from another on the same diff (`specs/reviews/3-gpt55-cross-model-study.md:31`). Moving publication onto the verdict, whose contract is enforced by code, removes the largest of the three dependencies. Prompts do not vary by family and there is no system role *(sub-review: `PR:293-295`)*.

## 7. Skills overlay and publication

**Skills.** A skill is a Markdown file with frontmatter; a lens exists when a loaded skill names it. One model call serves all of a packet's lenses. Each stage sees a different projection: stage 7 gets Checks, False Positives and Examples; stage 9 gets False Positives and Safe Patterns; the planner gets one-line summaries; the composer gets none. Caps are 4,000 chars per skill and 12,000 per prompt. Each finding records the skill ids actually projected, and the verifier resolves guidance from those ids only. *(sub-review; matches `architecture.md:1354-1355`)*

Three issues:
- **Trust (decision needed).** `loadSkills` reads `<repo>/.codegenie/skills` from the working tree unconditionally (`src/skills/skill-loader.ts:53,68`), and skill text enters prompts unfenced as trusted instructions. In the default local mode the working tree is the branch under review, so a pull request can add a skill whose False Positives section tells the verifier what to reject. The Action is safe only because the example workflow checks out the base revision; no code enforces it.
- **Lens choice is decided in three layers:** the planner, one of two divergent defaults, then deterministic pruning that can override an explicit planner choice *(sub-review: `PB:2766-2851`)*. The spec says the planner decides.
- **Silent displacement.** A repo skill attached to a core lens can push another skill past the 12,000-char cap; only telemetry records it.

**Composition and publication.** The split of duties is right: the model writes prose and proposes merges; code validates that every finding id appears exactly once, renders evidence from sources, applies thresholds and caps, and re-adds anything the model omitted (`C:165-228`). Two things to fix:
- `refreshReviewHealth` re-renders the review body without the composition argument (`C:2119` versus `C:338`), so the "report synthesis failed" banner is dropped from every posted review.
- Finding identity has one stored fingerprint and three matchers (exact, five-line proximity, prose content hash), plus a collision salt that makes a finding's hash depend on what else was found in the same run (`C:233-243`). The proximity matcher is the recall risk named in section 3.

## 8. Spec against code

The spec is in better shape than "stale by design" suggests; most divergences are additions the spec has not caught up with.

| Spec | Code | Class |
|---|---|---|
| `runReview` algorithm (`architecture.md:1279-1296`) | Also escalation, stage 8, promotion, location clarification | stale spec |
| "One schema-repair retry" (`architecture.md:1367`) | Three model repairs plus deterministic recovery (`PR:181`) | stale spec |
| Planner is the only stage that changes coverage or lenses (`architecture.md:487`) | Escalation, packet-max promotion, lens pruning | stale spec |
| Low confidence suppressed pre-verification except critical/high (`architecture.md:1487`) | Evidence-resolution lane, cap 4, overflow undisclosed | stale spec; overflow is decision needed |
| "False-positive risk is not high" is a keep criterion (`architecture.md:1479`) | Not enforced (`VF:799-801`) | code bug |
| Stage-10 invalidity must not drop verified findings (`architecture.md:1386`) | Non-recoverable composer error empties the report | code bug |
| Inline only at medium or high confidence (`architecture.md:1551`) | Hatch leaves low-confidence findings inline in the report; the publisher then demotes them | code bug |
| Larger budget for deep coverage (`architecture.md:1359`) | Escalated `simple` packets get zero tools | code bug |
| Revision preserves lineage (`architecture.md:1494`) | `provenance` dropped on revise | code bug |
| Default plan is all hunks at `normal` (`architecture.md:1369`) | `deep` for high or critical configured priority (`PL:1315`) | decision needed |
| Fingerprint excludes model wording (`architecture.md:1504`) | Collision salt uses failure-mode terms | decision needed |
| Skills load from the trusted checkout (`functional_spec.md:1013`) | Nothing checks that the checkout is not the head | decision needed |
| Notes are code-assembled and suppressed only by stage 8 (`functional_spec.md:566`) | The composer model resolves and rewrites notes | stale spec |
| Depth is a global budget and planner bias (`functional_spec.md:55,371`) | Tool budgets and one nudge threshold only | decision needed |
| Plan 102 packing, plan 104 delegate mode | `PENDING`, absent from code | decision: ship or close |
| Plans 106–110 headers say `PENDING` | README says `COMPLETE`; code present | stale plan headers |

## 9. Facts the fast-lane design should start from

Workstream B owns the design; these are the constraints the pipeline gives it.

- The pipeline runs unchanged on an empty or default plan, so a no-model planner costs nothing to build. It loses model-chosen deep coverage, skips and custom (non-core, non-language) lenses, which neither default ever selects.
- The composer's deterministic fallback already produces a complete report, so the composer call is optional.
- `review.verify=false` exists and publishes every gate-passed candidate as low risk (`VF:255-296`). That is the wrong lever for a fast lane: verification is the precision gate and is cheap next to stage 7.
- Packets are the cost unit. `depth: light` saves tool calls, not model calls.
- There is no preset or profile concept in the CLI or the Action. The only per-trigger channel is the model alias.

## 10. Not verified, and open questions

- Frequencies. Almost every "rarely" in the sub-reviews is a hypothesis: stage 8 fire rate, hatch pass rate, lane overflow, stage-7 cleanup recoveries, 422 payload hits. The stored eval artifacts would settle each without a model call. **Owner: @operator** — access approved on 2026-11-19; results follow in a separate note, aggregates only.
- Whether the token ledger double-counts cached prefixes across tool turns *(sub-review hypothesis, `PR:3580-3588`)*. If it does, the 8M cap is tighter than it looks on long investigations. **Owner: @architect-2** (workstream B).
- Whether provenance loss on revise changes any published output today, or only disables dormant code. I believe the latter.
- Whether the composer's cluster expansion can contradict its own validation and degrade a run *(sub-review, `C:178-199`)*. Not reproduced.
- I did not read `src/provider`, `src/evals` or `src/config` beyond the schema; workstreams B and C cover them.
