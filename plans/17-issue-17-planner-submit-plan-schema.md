# Issue 17: Planner Submit Plan Schema Discipline

Status: COMPLETE
Planned at: a47a23b, 2026-06-14
Completed at: 2026-06-14

## Problem

In the latest eval, Stage 5 initially produced multiple `submit_plan` tool calls with partial payloads instead of one complete planner output. The repair path succeeded, but it made Stage 5 slower and more expensive. This is avoidable because the planner should be a single structured-output pass over a compact dossier.

## Plan

1. Tighten the planner prompt so it explicitly requires exactly one `submit_plan` call containing the complete `ReviewPlan`.
2. Add a planner-specific validation guard that rejects:
   - zero `submit_plan` calls
   - more than one `submit_plan` call
   - partial submit payloads that are missing required top-level fields
3. Make the repair prompt cheaper:
   - include the validation error
   - include the invalid submit payloads if present
   - include only the compact planner dossier summary needed for correction
   - avoid resending oversized unchanged context when the model already attempted the right tool
4. Record planner schema repair telemetry with `stage: 5`, number of invalid submit calls, repair prompt size, and final result.
5. Keep fail-fast behavior if the repaired planner output is still invalid.

## Likely Files

- `src/pipeline/planner.ts`
- `src/llm/pi-runner.ts`
- `src/llm/schemas.ts`
- `src/telemetry/telemetry-recorder.ts`
- `tests/pipeline-phase5.test.ts`
- `tests/phase4-llm.test.ts`

## Tests

- Unit test: multiple `submit_plan` calls trigger one repair attempt.
- Unit test: repaired single complete `submit_plan` succeeds.
- Unit test: second invalid planner response fails the review with a clear error.
- Telemetry test: planner repair event records `stage: 5` and invalid call count.

## Acceptance Criteria

- Stage 5 normally completes with one model call and one `submit_plan`.
- If repair is needed, the repair prompt is smaller and targeted.
- The planner never silently merges multiple partial tool calls into an ambiguous plan.
