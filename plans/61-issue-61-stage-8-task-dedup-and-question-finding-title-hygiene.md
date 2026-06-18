# Issue 61: Stage 8 Task Deduplication and Question-Finding Title Hygiene

Status: PENDING
Planned from: trails-api eval run `0c4d5213/logs/25`, 2026-06-17
Recommended priority: medium-high, because run 25 passed but spent extra work on duplicate Stage 8 tasks and published one question-shaped finding title

## Problem

Run 25 passed the eval and found all expected issues, but two polish/cost issues showed up clearly:

1. Stage 8 built two separate system-review tasks for the same root question:

```text
Does the generic data.lockForStatusUpdate helper reproduce the exact update columns, status predicate, and row-locking SQL of each original per-record LockForStatusUpdate...
```

Both tasks inspected the same helper/call-site equivalence concern, resolved the same human-attention thread, and produced no findings. Stage 8 still stayed cheap in this run, but duplicate system-review tasks are wasted model calls and make artifacts noisier.

2. Stage 10 published a final finding titled:

```text
Verify SolveQuoteRoutingWithFallbacks behavior after this change
```

The finding body was concrete and useful, but the title kept the review-question framing. Final findings should read like issues, not work items. A reviewer should see the defect immediately, for example:

```text
Explicit-preference routing requests now error instead of falling back
```

This is not a recall problem. The pipeline found, verified, and published the right issue. The fix is to improve task normalization and final presentation without weakening verification.

## Goal

Keep the review-question flow, but make it cheaper and more polished:

- Stage 8 should dispatch at most one task per root unresolved question/concern.
- Duplicate question-driven tasks should be merged before any model call.
- The merged task should preserve all useful packet IDs, files, symbols, answers, and reasons.
- Final finding titles should describe the concrete issue, not say "verify", "check", "confirm", or ask a question.
- Question-derived and promoted findings should still be allowed, but their final title/body must be rewritten into issue language after verification.

## Non-Goals

- Do not roll back review questions or Stage 8.
- Do not add a fixed risk taxonomy or risk kind enum.
- Do not hard-code trails-api, Go, `LockForStatusUpdate`, routing, decimals, or any eval-specific symbol.
- Do not add another LLM pass only for Stage 8 dedupe.
- Do not suppress distinct Stage 8 tasks just because they share vague words.
- Do not loosen verifier standards.
- Do not discard question-derived findings only because their original title was question-shaped.

## Design

### 1. Deduplicate Stage 8 Tasks Before Dispatch

Add a deterministic task-normalization step after Stage 8 task construction and before workers are scheduled.

Each task should have a normalized fingerprint based on structural evidence first:

- normalized review question text,
- review question ID when available,
- sorted changed/relevant files,
- sorted symbols,
- attached packet IDs,
- source hint/question IDs where available.

Use token overlap only as a tiebreaker inside structural gates. Do not merge solely because two questions share generic words like "behavior", "contract", "fallback", or "validation".

Recommended merge rules:

- Always merge tasks with the same review question ID.
- Merge tasks with the same normalized question and meaningful file overlap.
- Merge tasks with strong symbol overlap and meaningful file overlap when the question text is near-equivalent.
- Do not merge tasks that point at different files and different symbols, even if the wording sounds similar.

When tasks merge:

- keep one canonical question,
- union files and symbols,
- union packet IDs,
- preserve all partial answers and reasons,
- keep source provenance for debug artifacts,
- record `mergedTaskIds` or equivalent in telemetry/artifacts.

Emit telemetry:

- `stage8_tasks_deduplicated`
- fields: `inputTasks`, `outputTasks`, `mergedGroups`, `mergedTaskIds`, `savedTasks`.

Artifacts should expose both:

- raw constructed tasks,
- dispatched deduped tasks.

This keeps debugging honest when a task disappears because it was merged.

### 2. Rewrite Question-Derived Final Finding Titles

Treat title quality as a final composition invariant.

Add guidance to Stage 10:

- Final titles must be concrete issue statements.
- Do not publish titles that start with `Verify`, `Check`, `Confirm`, `Investigate`, `Does`, `Can`, `Could`, `Should`, or end as a question.
- If a finding came from a review question, use the verified behavior delta/failure mode as the title.
- If multiple candidates merged, prefer the most concrete verified title over a question/prompt title.

Add a deterministic post-composition check:

- detect question-shaped or task-shaped final titles,
- if the final group contains a non-question verified candidate title, replace with that title,
- otherwise synthesize a conservative title from structured fields such as `failureMode`, `behaviorChange`, `whyThisMatters`, or `verification.reason`,
- if no safe title can be synthesized, request composer schema repair with a short "rewrite title only" instruction rather than publishing a "Verify..." title.

Keep this generic. The fallback should not know domain terms. It should only convert:

```text
Verify <subject> behavior after this change
```

into an issue-shaped title when the verified finding already contains a concrete behavior delta.

Examples:

Good final title:

```text
Explicit-preference routing requests now error instead of falling back
```

Bad final title:

```text
Verify SolveQuoteRoutingWithFallbacks behavior after this change
```

## Implementation Steps

1. Audit Stage 8 task construction.
   - Locate where question-driven and hint-driven system-review tasks are built.
   - Identify the current task fields available for question ID, question text, files, symbols, packet IDs, source hints, and reasons.
   - Confirm where `system-review-tasks.json` is written.

2. Add a small Stage 8 task dedupe helper.
   - Prefer a focused module or local helper near system-review task construction.
   - Input: constructed tasks.
   - Output: `{ rawTasks, dispatchedTasks, mergeRecords }`.
   - Keep the algorithm deterministic and cheap.

3. Add Stage 8 dedupe telemetry and artifacts.
   - Log raw count, dispatched count, merged groups, saved tasks.
   - Preserve raw tasks in artifacts where practical.
   - Ensure existing eval/debug readers still understand the dispatched task list.

4. Add final-title validation helpers.
   - Implement a small predicate such as `isQuestionShapedFindingTitle(title)`.
   - Detect task/question verbs and trailing question marks.
   - Keep the check intentionally presentation-focused, not semantic.

5. Update Stage 10 composition.
   - Strengthen composer instructions.
   - Before writing final findings, normalize question-shaped titles using the verified candidate group.
   - Prefer an existing concrete candidate title over synthesized text.
   - Only fall back to composer repair if deterministic replacement cannot produce a safe title.

6. Add tests.
   - Stage 8 merges two tasks with the same review question and overlapping files/symbols.
   - Stage 8 does not merge two tasks with similar generic wording but different files/symbols.
   - Merged Stage 8 task preserves packet IDs, answers, files, symbols, and reasons.
   - Stage 10 replaces a `Verify ...` final title with a concrete verified candidate title from the same group.
   - Stage 10 leaves a concrete final title unchanged.
   - Stage 10 does not suppress or reject a finding only because its original title was question-shaped.

## Likely Files

- `src/pipeline/system-review.ts` or equivalent Stage 8 task builder
- `src/pipeline/composer.ts`
- `src/pipeline/finding-dedup.ts` or final selection helpers, if title normalization belongs there
- `src/types.ts`
- `src/telemetry/run-artifacts.ts`
- `tests/*system-review*.test.ts`
- `tests/*composer*.test.ts`

## Acceptance Criteria

- Run-25-style duplicate `lockForStatusUpdate` Stage 8 tasks would dispatch as one merged task.
- Stage 8 artifacts show raw task count and deduped dispatch count.
- Final reports do not publish titles that begin with "Verify", "Check", "Confirm", or similar task language.
- Question-derived findings still publish when verified.
- No verifier threshold changes are needed.
- No target-repo, language, or domain-specific matching is introduced.

## Validation

Run focused tests:

```text
pnpm exec vitest run tests/*system-review*.test.ts tests/*composer*.test.ts
```

Then run:

```text
pnpm test
pnpm run build
```

On the next eval, check:

- Stage 8 `inputTasks >= outputTasks`,
- duplicate root questions are merged before dispatch,
- final titles are issue-shaped,
- expected findings still match,
- cost/calls do not increase.

## Stop Conditions

Stop and reassess if:

- dedupe merges distinct cross-system questions only because their wording overlaps,
- final-title normalization rewrites the substance of a finding rather than its presentation,
- implementation needs a new LLM call for ordinary dedupe,
- Stage 8 artifacts become harder to debug,
- title rules become domain-specific.
