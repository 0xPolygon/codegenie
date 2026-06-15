# Issue 21: Targeted Cross-System Review

Status: PENDING
Planned at: a47a23b, 2026-06-14

## Problem

Stage 8 is currently skipped or effectively deferred, so repeated cross-system questions from Stage 7 flow into the final human-attention section instead of being resolved. A full global review pass would be expensive and risks overfitting, but repeated high-signal questions deserve a small targeted follow-up.

## Plan

1. Add a minimal Stage 8 task builder that runs only when Stage 7 produces repeated or high-risk follow-up hints.
2. Build at most a small number of targeted tasks per run, for example 1 to 3.
3. Each task should include:
   - the repeated question or suspected invariant
   - involved packets and changed symbols
   - representative candidate findings, if any
   - specific files/symbols to inspect first
4. Give Stage 8 the same read-only repository tools as normal/deep packet review, with a strict tool and token budget.
5. Stage 8 may produce:
   - one or more candidate findings
   - a resolved-note that suppresses repeated human-attention hints
   - no output if evidence is insufficient
6. Keep Stage 8 disabled when there are no repeated systemic signals.

## Likely Files

- `src/pipeline/review-runner.ts`
- `src/pipeline/lens-runner.ts`
- `src/pipeline/worker-runner.ts`
- `src/pipeline/composer.ts`
- `src/pipeline/types.ts`
- `src/llm/pi-runner.ts`
- `tests/pipeline-phase8.test.ts`
- `tests/pipeline-phase10.test.ts`

## Tests

- Unit test: repeated hints create a bounded Stage 8 task.
- Unit test: isolated hints do not trigger Stage 8.
- Unit test: Stage 8 resolved-notes suppress duplicate human-attention output.
- Unit test: Stage 8 candidate findings enter the normal verification path.

## Acceptance Criteria

- Stage 8 is a bounded targeted follow-up, not a broad whole-repo review.
- Repeated systemic questions are either resolved or grouped cleanly.
- Stage 8 cost remains predictable and visible in telemetry.
