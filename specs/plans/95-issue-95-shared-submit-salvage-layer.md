# Issue 95: One Shared Submit/Salvage Layer + the Prompt "Why" Ledger

Status: COMPLETE 2026-07-06 — census; six recorders -> one; PROMPT_TEMPLATE_WHY_LEDGER + standing rule (prompt-builder docblock) + guard test; stage-7 cleanup behind the shared `recoverInvalidSubmit` seam (`stage7RecoverInvalidSubmit`); one model-repair scheduler (`scheduleModelRepair` closure — both retry sites collapsed, one repair budget in `queueSchemaRepair`). Per-stage conversation-replacement variants kept deliberately: the census showed the stage-7 compact variant earns its keep (run 33 lineage). A/B gate GREEN on runs 41+61 (opus K=1): friction at census rates, stage-9 model repair and stage-10 deterministic salvage both recovered live through the post-seam paths, recall at/above baseline.
Planned from: fable review §2.3 + §4 ("recurring bug classes are structural") + §6 item 5 (`specs/reviews/1-fable-review.md`), 2026-07-04
Planned at: commit `762339d` (branch `next`)
Recommended priority: after plans 93/94. This is the highest-leverage simplification (the review's "output babysitting" class) and the one with the best measurement story: plan 86's schema-friction metrics exist specifically so this consolidation can be judged on numbers.

Step 0 census (2026-07-04, private eval artifacts `0c4d5213` runs 46-54 + `49f4645b` runs 29-33):

| Scope | Count |
|---|---:|
| Runs / model calls | 14 / 2,436 |
| Schema-invalid calls | 10 |
| Deterministic recoveries | 5 |
| Model repair attempts / recovered / unrecovered | 5 / 4 / 1 |
| Schema recovery failures | 0 |

By stage:

| Stage | Schema-invalid | Deterministic recovered | Repair attempts | Repair recovered | Unrecovered |
|---|---:|---:|---:|---:|---:|
| 5 planner | 1 | 0 | 1 | 1 | 0 |
| 7 packet review | 5 | 4 | 1 | 0 | 1 |
| 9 verifier | 3 | 0 | 3 | 3 | 0 |
| 10 composer | 1 | 1 | 0 | 0 | 0 |

Rung disposition from the census:

- **Keep deterministic Stage-7 candidate cleanup**: 4/4 recoveries, all `extra_finding_properties` / `candidate_payload`; stripped extra fields included `behaviorChangeEvidence`, `behaviorChangeConfidenceNote`, `behaviorChangeConfirmationNote`, `category_note`, and `hunkAnchor`.
- **Keep composer XML-parameter salvage**: 1/1 recovery (`xml_parameter_bleed`, run 31).
- **Keep model repair**: planner 1/1 and verifier 3/3 recovered; Stage-7 compact repair had the only unrecovered case (`missing_required_finding_fields`, run 33), but its rung is live.
- **Do not delete retry/finalize infrastructure from this census**: no retry attempts fired in this window, but the live repair rungs still depend on a single repair budget and failure path.

Implemented slices (2026-07-04):

- Added `PROMPT_TEMPLATE_WHY_LEDGER` beside `PROMPT_TEMPLATE_VERSIONS`, with stage-scoped reasons and motivating evidence for current schema/prompt surfaces. `tests/shared-utils.test.ts` now guards that every versioned prompt stage has non-empty ledger entries.
- Collapsed Stage-7 schema-repair telemetry emission to one parameterized recorder while preserving existing event names, levels, and payload fields.

Remaining implementation (seam design, 2026-07-05):

- Discovery: the generic seam (`tryRecoverInvalidSubmit`, pi-runner ~514) already runs for stage 7 — the stage-7 engine block (pi-runner 407-503) is a pre-seam attempt with richer telemetry plus two back-channels into model-repair queueing (`repairClassification`, `replaceConversationOverride` at 534-535).
- Seam extension (backward compatible): `recoverInvalidSubmit` may return either a plain `Record<string, unknown>` (planner/composer unchanged) or `{ arguments?, onRecovered?(recoveredCallId), onRejected?(error), repairClassification?, replaceConversationOverride? }`. Input gains `candidateDrafted?: boolean` (runner conversation state the stage-7 downgrade guard needs) and `fullError?: string` (classification markers can sit past the truncation cap).
- The whole stage-7 block moves into `stage7-submit-repair.ts` as `stage7RecoverInvalidSubmit(input, telemetry)` emitting the SAME events (`stage7_schema_repair_attempted`, `stage7_schema_cleanup_attempted/recovered/rejected`, `stage7_no_finding_reason_truncated`, `stage7_schema_repair_recovered`) with identical payloads; lens-runner wires it via `schemaRepair.recoverInvalidSubmit`. When the hook returns callbacks, pi-runner invokes them instead of the generic `schema_invalid_submit_recovered`/`recovery_invalid` events (stage-7 event names must not change; generic names for planner/composer must not change either).
- pi-runner keeps: revalidation, the post-repair candidate-downgrade guard (361-374), `queueSchemaRepair` (now reading classification/replace hints from the hook result). pi-runner's only stage-7-specific residue is the downgrade guard.
- Retry-path unification stays a separate follow-up commit after this lands flat.
- A/B gate: schema-friction metrics + recall vs the fresh 59/60 baseline (both models available).

## Problem

The spec says one schema-repair retry per structured call. Reality is a 6-rung ladder rebuilt per stage four times across the plan history (schema repair appears in 11 plans): caller `recoverInvalidSubmit` hooks (planner/composer/verifier use the shared seam; **stage 7 instead has its own 511-line cleanup engine**, `llm/stage7-submit-repair.ts`) → one model repair with per-stage conversation-replacement variants → post-repair downgrade guard → finalize-missing-submit completion → stage-5/10 submit-discipline handling. Plus six near-identical stage-7 telemetry recorders and duplicated retry paths in `completeWithCache`. Root cause per the review: schema surface is the tax, repairs are interest payments — and prompt paragraphs accrete without expiry ("prompt sediment").

## What the telemetry says now (measure before cutting)

Plan 86 gave every run first-submit-validity, `schemaInvalidCalls`/`schemaRepairAttempts`/`deterministicSchemaRecovered`/`schemaRecoveryFailed` metrics, and plan 86.3's real forced-submit landed after the ladder was built — the friction the ladder was written against may be substantially gone. **Step 0 of this plan is a rung-utilization census over the wave-era runs (46-54 + 29-33): which rungs actually fired, how often, and what recovered.** Rungs that never fire on the modern protocol are deletions, not consolidations. Do not skip this step — the fable review's own lesson is that this subsystem got patched eleven times without that census.

## Design

1. **Step 0 — census (no code):** per-rung fire/recover counts from existing `model-calls.jsonl` + repair events across recent runs; written into this plan. The census decides how much of steps 2-3 is "unify" vs "delete".
2. **One seam:** stage 7's cleanup engine moves behind the same `recoverInvalidSubmit` hook the other stages use (`llm-runner.ts:104`); `pi-runner` knows exactly one deterministic-recovery entry point. The 511-line engine shrinks to the transforms the census shows actually recover things.
3. **One retry path:** unify the duplicated retry flows in `completeWithCache`; one repair-attempt budget enforced in one place; per-stage conversation-replacement variants collapse unless the census shows a variant earns its keep.
4. **Collapse the six stage-7 telemetry recorders** into one parameterized recorder (pure mechanics; artifact/event shapes unchanged — eval metrics must not move).
5. **The "why" ledger:** alongside `PROMPT_TEMPLATE_VERSIONS`, each schema field and load-bearing prompt paragraph gets a one-line reason + motivating eval case. Standing rule (spec text): new provider-facing schema fields need a stated reason; a prompt paragraph dies when its motivating case passes without it. This is the structural fix for sediment — cheap to keep, and it turns future "can we delete this?" from archaeology into a lookup.

## Non-Goals

- Changing any schema shape, prompt content, or repair *semantics* the census shows to be live — this plan reorganizes and deletes dead rungs; posture changes are separate measured plans.
- Touching the salvage behaviors validated this session (composer payload salvage, run 31; schema recovery 3/3, run 28) except to relocate them behind the seam.

## Validation (harness)

- Full unit suite; the repair-path tests (37/51/52/59 lineage) keep passing unchanged.
- Owner A/B vs runs 51-54 baseline: `schemaInvalidCalls`, `schemaRepairAttempts`, recovery rates, first-submit validity, and recall all flat (this plan must be *invisible* in outcome metrics while deleting code).

## Done Criteria

- One deterministic-recovery seam, one retry path, one stage-7 recorder; census documented; "why" ledger exists with the standing rule in the spec; net deletion consistent with the census (expect several hundred lines).

## Stop Conditions

- If the census shows a rung fires and recovers materially on the modern protocol, it is load-bearing — keep it behind the seam and say so; the goal is fewer *copies*, not fewer *recoveries*.
- Any regression in schema-friction metrics or recall on the A/B → revert the consolidation commit and re-census.
