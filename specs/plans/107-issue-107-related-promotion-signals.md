# Issue 107: Carry Related Promotion Signals Without Changing Selection

Status: PENDING
Planned from: trails-api eval `49f4645b`, repeated promotion behavior in runs 52-57, 2026-08-04; redesigned after overfit review
Planned at: commit `1824056` (branch `master`)
Recommended priority: after Issue 106. This improves the evidence available to
Stage 9 without changing which candidates receive the scarce verifier slots.

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Stop
> on any condition below; do not improvise. Update this plan's row in
> `specs/plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat 1824056..HEAD -- src/types.ts src/util/text-similarity.ts src/pipeline/uncertainty-promotion.ts tests/uncertainty-promotion.test.ts tests/verifier.test.ts specs/project/components/review_pipeline.md specs/project/components/evals.md`
> If promotion admission, ranking, selection, candidate construction, or
> provenance changed, compare live behavior with Current state and STOP on a
> semantic mismatch.

## Execution metadata

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `1824056`, 2026-08-04

## Why this matters

Promotion currently discards every eligible source beyond the small verifier
cap. In run 57, the cap correctly selected one EXACT_INPUT and one EXACT_OUTPUT
predicate, but three additional EXACT_OUTPUT framings from other packets were
marked lane-limited and disappeared before Stage 9. Those signals are useful
context, but they are not independent proof and should not change confidence,
rank, or slot allocation by themselves.

This plan therefore leaves admission, ordering, caps, selected sources, and
candidate ids unchanged. It attaches strongly related **unselected** sources
to the already-selected candidate as bounded, explicitly non-authoritative
provenance. A false association may add a noisy lead, but cannot merge two
selected predicates, erase a verifier slot, or raise confidence.

## Current state

- `src/pipeline/uncertainty-promotion.ts:75-128` admits and ranks sources,
  selects at most `promotionLimit(...)`, labels every other eligible source
  `promotion_lane_limited`, and builds each candidate from one selected source.
- `src/pipeline/uncertainty-promotion.ts:227-247` owns selection and the local
  behavior-delta reserve. It must remain behaviorally unchanged.
- `CandidateFindingProvenance` at `src/types.ts:764-772` holds only the primary
  promoted source.
- Shared normalizers already exist in `src/util/text-similarity.ts`, but the
  broad human-attention grouping rule is intentionally a display-dedup rule,
  not predicate identity. Do not use it to group or select promotions.
- Run 57 selected the EXACT_INPUT and EXACT_OUTPUT candidates that should have
  remained distinct. The defect is loss of the remaining related signals, not
  the identity of the two selected candidates.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Focused tests | `pnpm exec vitest run tests/uncertainty-promotion.test.ts tests/verifier.test.ts` | all selected tests pass |
| Checks | `pnpm run check` | exit 0 |
| Full tests | `pnpm test` | all tests pass |
| Build | `pnpm build` | exit 0 |
| Owner live eval | `pnpm dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/49f4645b --no-cache` | case completes; selected count/calls do not increase |
| Cross-case guard | run the same command for `trails-api/0c4d5213` and `trails-api/relay-wc` | cases complete; `should_not_find` guards hold |

## Scope

**In scope**:

- `src/types.ts` — optional bounded related-signal provenance.
- `src/pipeline/uncertainty-promotion.ts` — post-selection association,
  decisions, summary counters, and artifact/event data.
- `tests/uncertainty-promotion.test.ts`, `tests/verifier.test.ts`.
- `specs/project/components/review_pipeline.md`,
  `specs/project/components/evals.md`, and the plan status row.

**Out of scope**:

- Any change to admission, rank, selected-source order, promotion caps,
  candidate ids, or the local behavior-delta reserve.
- Grouping sources before selection, consensus bonuses, base-confidence
  changes, or treating repeated model outputs as proof.
- New LLM calls, new similarity/tokenization helpers, or changes to
  human-attention grouping.
- Merging related-source code excerpts into candidate evidence. The primary
  selected source remains the candidate's evidence owner.

## Git workflow

- Branch: `fix/promotion-related-signal-provenance`
- Suggested commit: `fix(promotion): retain related lane-limited provenance`
- Do not push or open a PR unless asked.

## Steps

### Step 1: Associate related unselected sources after selection

Do not change `selectPromotionSources`. After selection, compare each
unselected eligible source with selected sources. It may be associated only
when all of these hold:

1. `riskProfile(...).category` matches.
2. `promotionClass` matches.
3. At least one normalized file and one normalized symbol overlap.
4. The existing normalized attention terms have either an exact normalized
   question match, or satisfy the existing broad related-question convention
   (`sharedTerms >= 3` or Jaccard `>= 0.24`). These values classify a source as
   related context only; they do not assert predicate identity.

Assign a source to at most one selected candidate. Choose deterministically by
exact-question match, then shared-term count, Jaccard, selected rank, question,
and packet id. Selected sources are never eligible to become another
candidate's related signal.

If no selected candidate matches, retain today's
`promotion_lane_limited` decision. If matched, emit a decision with
`promoted: false`, reason `represented_as_related_signal`, and the selected
candidate id. Such a source is represented, not lane-limited.

Do not move this association before selection. Add tests proving selected
sources, order, candidate ids, and model-call count are identical before and
after association.

**Verify**:
`pnpm exec vitest run tests/uncertainty-promotion.test.ts` -> all tests pass.

### Step 2: Carry bounded, explicitly non-authoritative provenance

Extend `CandidateFindingProvenance` with optional fields:

```ts
relatedSignals?: Array<{
  packetId: string;
  sourceKind: "uncertainty" | "follow_up_hint";
  question: string;
  files: string[];
  symbols: string[];
}>;
crossPacketRelatedCount?: number;
```

For each selected candidate, attach at most eight associated signals, sorted
deterministically. `crossPacketRelatedCount` counts unique related-signal
packet ids excluding the primary source packet. Do not call it
`independentSupportCount`; packet calls may share context and model behavior.
Do not merge related-signal prose or code into `evidence`, and do not alter
confidence.

Add summary counters `representedRelatedSignals` and
`unrepresentedLaneLimited`; preserve `promoted` as candidate count. Document
the adjusted `laneLimited` meaning as unselected signals that reached neither
a candidate nor related provenance.

Add a verifier handoff test proving these fields appear only inside the
untrusted candidate JSON and do not change tool budgets, projected skills, or
the primary provenance question.

**Verify**:
`pnpm exec vitest run tests/uncertainty-promotion.test.ts tests/verifier.test.ts`
-> all tests pass.

### Step 3: Add the run-57 regression and cross-case guard

Create the run-57-shaped fixture: selected EXACT_INPUT and EXACT_OUTPUT
sources, three related unselected EXACT_OUTPUT framings, and the normal cap.
Assert:

- the same EXACT_INPUT and EXACT_OUTPUT sources are selected in the same order
  and keep their existing candidate ids;
- selected sources never become one another's related signals;
- the related EXACT_OUTPUT framings are attached to the selected EXACT_OUTPUT
  candidate, bounded and deterministically ordered;
- no rank, confidence, evidence, cap, or model-call count changes;
- unmatched unselected sources remain `promotion_lane_limited`.

Then update the component docs and run all commands in the table. On live
cross-case validation, any new final-finding `should_not_find` violation,
selected-candidate change, or verifier-call increase is a stop-ship signal.

**Verify**: all commands exit 0; `git diff --check` is silent.

## Done criteria

- [ ] Promotion selection, order, caps, candidate ids, and call count are
      unchanged.
- [ ] Related unselected signals reach exactly one selected candidate as
      bounded, optional, non-authoritative provenance.
- [ ] Related repetition does not change rank, evidence, or confidence.
- [ ] Decisions distinguish represented signals from truly lane-limited ones.
- [ ] Run-57 and cross-case guards pass.
- [ ] `pnpm run check`, `pnpm test`, and `pnpm build` exit 0.
- [ ] Only Scope files and the plan status row changed.

## STOP conditions

Stop and report if association requires changing selection, candidate ids,
caps, prompt versions, confidence, or primary evidence; if a source cannot be
assigned deterministically to at most one selected candidate; if cross-case
guards regress; or if focused tests fail twice after a reasonable correction.

## Maintenance notes

Related signals are leads, not votes. If telemetry later proves that repeated
wordings waste slots, design a separate selection experiment against a broad
eval corpus. Do not turn this provenance path into fuzzy pre-cap clustering or
a confidence bonus without that evidence.
