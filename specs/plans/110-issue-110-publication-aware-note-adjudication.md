# Issue 110: Make Note Fallback Publication-Aware and Score Rendered Notes

Status: PENDING
Planned from: trails-api eval `49f4645b`, runs 52/55/57 and the run-52 `surfacedAsNote` misreport, 2026-08-04; reduced after overfit review
Planned at: commit `1824056` (branch `master`)
Recommended priority: after Issues 106 and 109. This closes the remaining
visibility and measurement gaps without adding member-snapshot machinery.

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Stop
> on any condition below; do not improvise. Update this plan's row in
> `specs/plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat 1824056..HEAD -- src/types.ts src/pipeline/composer.ts src/pipeline/human-attention.ts src/evals/eval-artifacts.ts src/evals/eval-scoring.ts tests/human-attention-adjudication.test.ts tests/pipeline-phase5.test.ts tests/evals.test.ts specs/project/components/review_pipeline.md specs/project/components/evals.md`
> Issue 109 changes the composer hatch, not these source regions. STOP if
> output selection no longer receives already-published findings or if the
> resolution/matching flow differs semantically from Current state.

## Execution metadata

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**:
  `specs/plans/106-issue-106-verifier-revision-payload-contract.md`,
  `specs/plans/109-issue-109-verified-low-confidence-publication.md`
- **Category**: bug
- **Planned at**: commit `1824056`, 2026-08-04

## Why this matters

Output note suppression assumes every verifier keep/revise becomes visible as
a finding. Runs 52, 55, and 57 disproved that assumption: composition
suppressed the finding after its matching note group had already been removed,
and the review rendered “Everything looks good.” The scorer then compounded
the bug by treating an internal group as a user-visible note.

The generic invariant is simple: an unpublished keep/revise cannot suppress
its fallback note, and fallback notes must outrank ordinary notes within the
existing output cap. Separately, eval scoring must inspect `outputNotes`, not
internal groups. Evidence-backed rejects remain authoritative.

## Current state

- `src/pipeline/composer.ts:220-228` passes only non-suppressed findings but all
  verification resolutions into `selectHumanAttentionForOutput`.
- `src/pipeline/human-attention.ts:232-243` suppresses available groups using
  those unfiltered resolutions, then calls `selectHumanAttentionGroups`.
- `selectHumanAttentionGroups` takes the first five ranked groups. Merely
  restoring eligibility does not guarantee a fallback group survives that cap.
- `suppressAttentionGroupsResolvedByVerification` suppresses a whole group on
  the first matching resolution. This plan leaves reject behavior unchanged;
  residual cross-predicate reject suppression is measured for a separate plan.
- `src/evals/eval-artifacts.ts` normalizes artifact `groups`, while the schema
  has carried rendered `outputNotes` since version 2.
- `EvalArtifacts` and `EvalLossDetail` live in `src/types.ts`; new scorer fields
  must be added there as optional, backward-compatible fields.
- `should_not_find` currently evaluates reported final findings, not notes.
  Live overfit validation must therefore inspect rendered notes separately.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Focused tests | `pnpm exec vitest run tests/human-attention-adjudication.test.ts tests/pipeline-phase5.test.ts tests/evals.test.ts` | all selected tests pass |
| Checks | `pnpm run check` | exit 0 |
| Full tests | `pnpm test` | all tests pass |
| Build | `pnpm build` | exit 0 |
| Owner live eval | run `pnpm dev eval --eval-dir <case> --no-cache` for `49f4645b`, `0c4d5213`, and `relay-wc` under `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api` | cases complete; final-finding guards hold and rendered fallback notes are audited separately |

## Scope

**In scope**:

- `src/pipeline/human-attention.ts` — publication-aware resolution filtering,
  fallback-priority selection, bounded telemetry/artifact fields.
- `src/evals/eval-artifacts.ts`, `src/evals/eval-scoring.ts`, `src/types.ts` —
  rendered-note parsing and truthful loss diagnostics.
- `tests/human-attention-adjudication.test.ts`,
  `tests/pipeline-phase5.test.ts`, `tests/evals.test.ts`.
- `specs/project/components/review_pipeline.md`,
  `specs/project/components/evals.md`, and the plan status row.

**Out of scope**:

- Note-group merge thresholds, note wording, or raising the five-note cap.
- Member snapshots, truncated/opaque-group behavior, survivor reconstruction,
  or changing reject-resolution semantics.
- Composer confidence/publication policy, verifier policy, promotion policy,
  or historical artifact rewrites.

## Git workflow

- Branch: `fix/publication-aware-note-fallback`
- Suggested commit: `fix(attention): preserve unpublished verified predicates as notes`
- Do not push or open a PR unless asked.

## Steps

### Step 1: Filter keep/revise resolutions by actual publication

Inside `selectHumanAttentionForOutput`, partition resolutions before applying
verification suppression:

- every `reject` remains active;
- a keep/revise remains active only if its `candidateId` equals a published
  finding id or appears in that finding's `mergedCandidateIds`;
- all other keep/revise resolutions become **publication-fallback
  resolutions** and do not suppress groups.

Do not change the pre-composer reject-only suppression path. Add tests proving
an unpublished keep/revise leaves its matching group available, while a
published keep/revise and every reject behave exactly as today.

**Verify**:
`pnpm exec vitest run tests/human-attention-adjudication.test.ts tests/pipeline-phase5.test.ts`
-> all tests pass.

### Step 2: Protect fallback groups inside the existing note cap

Using the existing resolution/group matcher, identify available groups matched
by publication-fallback resolutions after active reject suppression. Select
output groups in two stable classes:

1. matching publication-fallback groups, in existing rank order;
2. all remaining groups, in existing rank order.

Take at most the existing `MAX_HUMAN_ATTENTION_NOTES`. Do not raise the cap.
This guarantees that no ordinary note displaces a verifier-kept predicate;
when more fallback groups exist than the cap, render the highest-ranked five
and record the overflow rather than claiming every predicate was shown.

Extend bounded telemetry/artifacts with fallback group ids/count and
`omittedFallbackCount`. Add regressions for:

- a run-55-derived **unpublished keep**: low-confidence candidate,
  `requiredEvidencePresent: true`, `falsePositiveRisk: "medium"`, and a
  deliberately vague `failureMode` below Plan 109's concrete-text threshold.
  Assert Plan 109 leaves it unpublished with `confidence-threshold`, then this
  plan selects its matching fallback note instead of the no-findings output;
- the fully concrete run-55 control: same evidence-backed medium-risk keep,
  but with concrete behavior-delta text satisfying Plan 109. Assert it
  publishes summary-only and its matching note is suppressed as redundant;
- published inline and summary-only controls -> matching note stays
  suppressed;
- six available groups with the fallback ranked sixth -> fallback is selected
  without increasing total notes;
- evidence-backed reject matching the group -> reject still suppresses it;
- more than five fallback groups -> deterministic top five plus overflow.

Do not use `requiredEvidencePresent: false` for the unpublished-keep fixture:
normal verifier normalization converts that shape to reject, and an active
reject should suppress the note. The fixture must remain a completed keep that
fails publication quality, not verification truth.

**Verify**:
`pnpm exec vitest run tests/human-attention-adjudication.test.ts tests/pipeline-phase5.test.ts`
-> all cases pass.

### Step 3: Score only rendered notes

Read the human-attention artifact once in `src/evals/eval-artifacts.ts`.
Preserve today's internal-group normalization as `humanAttentionNotes` and add
optional `humanAttentionOutputNotes` from `outputNotes`; leave it undefined for
old artifacts that lack the field.

In `src/types.ts`, add optional
`EvalArtifacts.humanAttentionOutputNotes` and
`EvalLossDetail.noteGroupExisted`. In scoring:

- set `surfacedAsNote` only from `humanAttentionOutputNotes`;
- fall back to internal groups only when the output field is absent, preserving
  old-artifact replay behavior;
- set `noteGroupExisted` from the internal-group match;
- keep aggregate `noteSurfaced` tied to the corrected field.

Test an internal-only run-52 shape, a rendered note, an explicit empty
`outputNotes` array, and a legacy artifact without the field.

**Verify**:
`pnpm exec vitest run tests/evals.test.ts` -> all cases pass.

### Step 4: Document and validate the visibility/noise tradeoff

Document publication-aware suppression, fallback priority, overflow telemetry,
and truthful scoring. Run all gates and the three owner eval cases.

`should_not_find` does not inspect notes. For `0c4d5213` and `relay-wc`, also
inspect `human-attention-notes.json.outputNotes` using the same path/text
matching semantics as `expectationMatchesNote`; no banned predicate may
resurface only as a note. Every newly rendered note must trace to a dropped
keep/revise candidate id in fallback telemetry. Do not weaken the eval cases
to accommodate note noise.

**Verify**: all commands exit 0; `git diff --check` is silent; only Scope files
and the plan status row changed.

## Measurement rule for member-level reject adjudication

After Issues 106, 109, and this plan land, collect at least 20 runs spanning
`49f4645b` and at least one other case. Open a **new plan against current HEAD**
only if at least two runs lose a required predicate because a reject resolution
for one raw note suppresses a merged group containing a different predicate.

That future design must adjudicate raw notes before regrouping survivors, or
use an equivalent lossless raw-note lookup. It must never suppress an opaque or
truncated group wholesale. If no residual failures occur, do nothing.

## Done criteria

- [ ] Unpublished keep/revise resolutions cannot suppress their note groups;
      published keep/revise and reject behavior remain intact.
- [ ] The vague unpublished-keep fixture renders a fallback note, while the
      fully concrete Plan-109-qualified run-55 control publishes summary-only
      and suppresses its redundant note.
- [ ] Fallback groups outrank ordinary notes inside the unchanged five-note
      cap, with deterministic overflow accounting.
- [ ] `surfacedAsNote` reflects rendered output; `noteGroupExisted` remains a
      diagnostic only; legacy artifacts score as before.
- [ ] Cross-case final-finding guards pass and rendered notes contain no banned
      predicates.
- [ ] `pnpm run check`, `pnpm test`, and `pnpm build` exit 0.
- [ ] Only Scope files and the plan status row changed.

## STOP conditions

Stop if publication awareness requires moving resolution-index construction;
if reject behavior changes; if fallback priority requires raising the cap; if
old artifacts change score beyond the documented correction; if cross-case
notes leak banned predicates; or if focused tests fail twice after a reasonable
correction.

## Maintenance notes

Fallback priority is a visibility invariant, not recall credit: the finding
still missed. If residual cross-predicate reject suppression is measured, write
the raw-note-first follow-up then; do not reintroduce member snapshots or
fail-closed opaque groups.
