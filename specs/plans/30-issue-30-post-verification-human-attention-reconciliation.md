# Issue 30: Post-Verification Human-Attention Reconciliation

Status: COMPLETE
Planned from: trails-api eval run 5 review, 2026-06-15
Planned at: commit `db41ed7`

## Problem

Run 5 produced useful final findings, but the final `Needs Human Attention` section still included stale unresolved questions. Several notes asked about helper behavior that Stage 9 had already verified or rejected, such as whether `CalculateAmountUSD` preserved decimal/price guards.

Human-attention notes are valuable when codegenie genuinely cannot resolve a question. They become noise when they survive after verification has already resolved the predicate. This weakens trust in the final report and makes large reviews feel less precise.

## Current State

- `src/pipeline/composer.ts:65` builds human-attention notes from packet results before composition.
- `src/pipeline/composer.ts:804-814` already suppresses attention groups covered by final findings.
- `tests/pipeline-phase5.test.ts` already has coverage for grouping, capping, and suppressing notes covered by final findings.
- `tests/pipeline-phase8.test.ts` has coverage for suppressing duplicate human-attention hints when Stage 8 resolves the question.
- Current suppression does not fully account for Stage 9 verifier decisions that resolve a question by rejecting a candidate or proving a helper predicate false.

## Plan

1. Build a verification resolution index.
   - From `verification.json` / in-memory verifier outputs, derive normalized resolution keys from:
     - candidate path
     - related files
     - symbols
     - follow-up hint question, when candidate provenance came from uncertainty promotion
     - verifier reason text only through safe normalized terms, not brittle exact prose
   - Record whether the verifier resolved the predicate as kept, rejected, revised, or incomplete.

2. Suppress notes resolved by verification.
   - When building final human-attention notes, suppress a note if:
     - it asks substantially the same question as a verified candidate, and
     - the verifier verdict was `keep`, `reject`, or `revise` with required evidence present.
   - Do not suppress when verification was incomplete, budget-limited, or required evidence was missing.
   - Do not suppress same-symbol notes when the file scope is different and the verifier only resolved a narrow caller.

3. Preserve artifacts for auditability.
   - In `human-attention-notes.json`, include:
     - raw notes
     - grouped notes
     - notes suppressed by final findings
     - notes suppressed by verification
     - notes kept for composer/final output
   - Include suppression reasons and the candidate/verdict id that resolved each note.

4. Keep final output conservative.
   - Do not hide a note merely because a similar word appears in a rejected candidate.
   - Require overlap in file/symbol/question intent.
   - Prefer keeping a note over suppressing it when matching confidence is low.
   - Never convert a suppressed note into a finding.

5. Add tests.
   - A note about a helper predicate is suppressed when a verifier reject proves the helper already enforces the guard.
   - A note is suppressed when a verifier keep publishes the same issue as a final finding.
   - A note remains when verifier verdict is incomplete or `requiredEvidencePresent=false`.
   - Same symbol but different file scope remains when the verifier resolved only one call site.
   - Artifact output includes suppressed-by-verification records.

## Likely Files

- `src/pipeline/composer.ts`
- `src/pipeline/verifier.ts`
- `src/types.ts`
- `src/telemetry/run-artifacts.ts`
- `tests/pipeline-phase5.test.ts`
- `tests/pipeline-phase8.test.ts`
- `tests/verifier.test.ts`

## Acceptance Criteria

- Final `Needs Human Attention` does not repeat questions already resolved by Stage 9 verification.
- Notes remain when the verifier could not resolve the evidence.
- `human-attention-notes.json` explains what was suppressed and why.
- Matching is based on normalized path/symbol/question overlap, not trails-api-specific strings.
- The final report becomes shorter and more credible without losing genuine uncertainty.
