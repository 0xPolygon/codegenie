# Issue 19: Follow-Up Hint Deduplication

Status: PENDING
Planned at: a47a23b, 2026-06-14

## Problem

The latest run produced a large `Needs Human Attention` section with many repeated follow-up hints and uncertainty notes. This makes the final review feel noisy even when the actual findings are high quality. Repeated unresolved questions should either become a targeted cross-system review task or be grouped into a concise human-attention note.

## Plan

1. Introduce a normalized follow-up hint key based on:
   - normalized question text
   - category
   - primary file or symbol
   - related files, sorted and capped
2. Group duplicate and near-duplicate hints before final composition.
3. Cap the final human-attention section by default, for example 6 to 8 grouped notes.
4. Prefer notes that are:
   - repeated across multiple packets
   - tied to high-risk planner areas
   - tied to verified or kept findings
   - specific enough for a developer to act on
5. Preserve counts and representative locations so suppressed duplicates remain observable in telemetry.
6. Add a telemetry event for follow-up hint grouping with `stage: 10`.

## Likely Files

- `src/pipeline/composer.ts`
- `src/pipeline/types.ts`
- `src/telemetry/telemetry-recorder.ts`
- `tests/pipeline-phase10.test.ts`
- `tests/telemetry.test.ts`

## Tests

- Unit test: repeated hints collapse into one grouped note with a count.
- Unit test: distinct high-risk hints are not merged.
- Unit test: the final review respects the cap while retaining highest-value notes.
- Snapshot-style test for final review markdown with grouped human-attention notes.

## Acceptance Criteria

- Final reviews do not contain repeated human-attention bullets for the same unresolved question.
- The run artifacts still preserve raw hints for debugging and future eval analysis.
- The composer prefers a short, actionable final section over a long uncertainty dump.
