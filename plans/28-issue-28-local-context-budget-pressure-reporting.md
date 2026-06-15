# Issue 28: Local Context Budget Pressure Reporting

Status: PENDING
Planned from: trails-api eval run 5 review, 2026-06-15
Planned at: commit `db41ed7`

## Problem

Plan 26 made global budget accounting much better: run 5 correctly reported `complete review`, `0 budget overruns`, and `0 dispatch blocks`. But that does not tell the whole story.

Run 5 still had meaningful local context pressure:

- Stage 7 had 18 local tool-call rejections.
- Stage 9 had 5 local tool-call rejections.
- 77 hunks were marked degraded.
- The final report printed `Additional unresolved notes suppressed: 50`.

These are not global token-budget overruns. They are local investigation/tool-result budget limits inside packet reviewers and verifiers. A run can be globally complete but still have degraded local source context. The final report and eval metrics should expose that distinction plainly.

## Current State

- `src/output/markdown-renderer.ts:61-84` renders a budget summary with completeness, model calls, tokens, cost, effective caps, budget overruns, and dispatch blocks.
- `src/output/markdown-renderer.ts:87-95` renders budget summary whenever usage/caps/overruns/blocks exist.
- `src/pipeline/review-runner.ts:1233-1248` builds `BudgetSummary` from global budget state and coverage partial status.
- `src/telemetry/run-artifacts.ts:187-214` already has stage summaries for packets, coverage, and degraded hunks.
- `tool-calls-summary.json` already counts degraded and rejected tool calls by stage/tool.
- The final markdown budget section does not mention local tool rejections, degraded tool results, degraded hunks, or unresolved-note pressure.

## Plan

1. Define a local context pressure summary.
   - Add a structured summary object, for example `contextPressure`, to the final review result or budget summary.
   - Include:
     - total degraded hunks
     - local tool-call rejections by stage
     - local degraded tool results by stage
     - top rejection reasons, such as `tool_result_budget_exhausted` and `tool_call_budget_exhausted`
     - unresolved human-attention notes emitted and omitted
   - Do not mark the review partial solely because local context pressure exists.

2. Render a compact final report line.
   - In `## Budget` or `## Coverage`, add a concise line only when pressure exists:
     - `Local context pressure: 23 tool-budget rejections, 77 degraded hunks, 50 unresolved notes suppressed.`
   - Keep quiet for small clean runs.
   - Keep "Review completeness: complete" when all required stages completed and no dispatch was blocked.

3. Persist the pressure summary in artifacts.
   - Add the same structured summary to `budget-summary.json`, `run.json`, or a clearly named artifact.
   - Prefer extending existing artifacts over introducing a new file unless a new file keeps the implementation simpler.
   - Ensure eval replay can read the summary without parsing markdown.

4. Add eval metrics and optional assertions.
   - Include `toolBudgetRejections`, `degradedHunks`, and `unresolvedNotesSuppressed` in eval metrics.
   - Add optional eval expectation fields:
     - `maxToolBudgetRejections`
     - `maxDegradedHunks`
     - `maxUnresolvedNotesSuppressed`
   - Do not fail existing evals unless these fields are configured.

5. Keep terminology clear.
   - Use "budget overrun" only for global model-call/token caps.
   - Use "local tool budget rejection" or "local context budget pressure" for per-worker tool-call/result limits.
   - Avoid calling a review partial just because a local optional investigation hit a cap.

6. Add tests.
   - Final markdown includes the local context pressure line when tool rejections/degraded hunks exist.
   - Final markdown omits the line when all counts are zero.
   - Eval metrics include the counts from artifacts.
   - Optional eval thresholds fail with directionally clear output, for example `maxToolBudgetRejections: 23 > 10`.

## Likely Files

- `src/types.ts`
- `src/output/markdown-renderer.ts`
- `src/pipeline/review-runner.ts`
- `src/pipeline/composer.ts`
- `src/telemetry/run-artifacts.ts`
- `src/evals/eval-scoring.ts`
- `src/evals/eval-runner.ts`
- `tests/pipeline-phase5.test.ts`
- `tests/evals.test.ts`
- `tests/telemetry.test.ts`

## Acceptance Criteria

- A globally complete review can also report local context pressure.
- Final markdown and eval summaries distinguish global budget overruns from local tool-budget pressure.
- Structured artifacts expose local tool rejections and degraded hunk counts.
- Existing evals remain compatible unless new thresholds are configured.
- The output stays compact and useful; no long per-packet dump appears in normal markdown.

