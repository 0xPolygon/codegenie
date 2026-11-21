---
repo: codegenie
case: cg-07
role: positive
intro: 0711daa5b740a3f1a73d0161d233cb8f98851a82
base: 8a4c5bd1574d4c841343fae94c3cabf9cdc31ff4
introDate: 2026-11-20
fix: bbf1cdea91d1af7f8ab94561504c4bf4c07ed650, 7b828737f2139970cdc15f68f21035f106d60c70
kind: data-integrity, api-contract
severity: low
pr: 121
---

# codegenie cg-07

Review base `8a4c5bd1574d4c841343fae94c3cabf9cdc31ff4` (the parent) against head `0711daa5b740a3f1a73d0161d233cb8f98851a82`. The head exists only on `refs/pull/121/head` because the PR was squash-merged; fetch it by SHA.

## Expectation `legacy-stage8-accepted-by-guards`

### Expected finding

Stage 8 is removed from `ReviewStage`, but the local `isReviewStage` guards in eval scoring, the model-call cache and the review runner still accept any integer from 1 to 11. Legacy stage-8 model-call records are still scored into `maxPromptCharsByStage[8]`, and stale stage-8 cache entries pass stored-response validation as a valid review stage.

### Anchor

src/llm/model-call-cache.ts:351-352 and src/evals/eval-scoring.ts:1896-1897 (also the review-runner guard); the contract change is in src/types.ts

### Severity floor

The matcher floor is low. Expected severity is low; record it as a calibration note, not as a miss.

### Fixing evidence

bbf1cde replaces the range checks with a shared guard built from the stage list. Its regression tests (a stage-8 model call is ignored; a stage-8 cache record is an invalid entry) fail at the intro.

## Expectation `eval-budget-key-8-accepted`

### Expected finding

Eval-case validation still accepts a `maxPromptCharsByStage` key of 8 through its 1-11 range check after Stage 8 was deleted. A prompt budget for the removed stage is accepted silently and can never constrain anything.

### Anchor

src/evals/eval-runner.ts:252-256 (`parsed < 1 || parsed > 11`)

### Severity floor

The matcher floor is low. Expected severity is low; record it as a calibration note, not as a miss.

### Fixing evidence

7b82873 validates keys against the current stage list. Its regression test expects `loadEvalSuite` to reject key 8, and the suite loads at the intro.

