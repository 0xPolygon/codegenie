# Issue 59: Stage 5 Planner Schema Repair Salvage

Status: COMPLETE
Planned from: trails-api eval run `49f4645b/logs/7`, 2026-06-17
Recommended priority: immediate, because the review aborts before packet construction when a near-valid repaired planner response has a harmless schema drift

## Problem

The last clean commit, `e427211` (`plan-56`), added planner-authored review questions and answer tracking. Eval run `49f4645b/logs/7` used that exact clean commit and failed before Stage 6:

```text
ERROR llm_schema_invalid: model submit payload failed schema validation after repair
```

Stages 1-4 completed normally:

- Stage 1 resolved `master...49f4645b40e3e17f3a7f7c243d4d1de0a0a6e95c`.
- Stage 2 parsed 4 files and 10 hunks.
- Stage 3 classified all 4 changed files.
- Stage 4 built 10 changed-symbol facts.

Stage 5 failed in the planner:

- `mc-000001` called `submit_plan` with `{}` and also emitted many bogus numbered tool calls such as `"1"`, `"2"`, etc.
- Those numbered tool calls contained useful fragments: risk areas, review questions, and coverage decisions.
- Codeninja scheduled the planner schema repair.
- `mc-000002` repaired the response into one coherent `submit_plan`.
- The repaired payload still had one extra top-level key, `reason`.
- `SubmitPlanSchema` has `additionalProperties: false`, so validation rejected the otherwise useful repaired plan.
- Because planner repair has `failAfterRepair: true`, the entire review aborted.

This is a regression exposed by Plan 56 because the planner output is now more complex. The new review-question feature is not inherently wrong, but Stage 5 repair is too brittle when the provider returns a near-valid object with harmless root-level drift.

## Goal

Make Stage 5 planner repair robust to harmless wrapper/annotation fields while keeping planner validation strict.

The desired behavior is:

- keep `SubmitPlanSchema` strict,
- keep `additionalProperties: false`,
- do not accept malformed plans directly,
- deterministically salvage repaired `submit_plan` payloads when they contain the required planner structure plus harmless extra root keys,
- still reject plans that are missing required fields or have invalid nested objects,
- continue running `validatePlan` after schema recovery,
- emit telemetry when salvage strips extra fields.

## Non-Goals

- Do not loosen the planner schema globally.
- Do not accept unknown nested fields inside risk areas, review questions, coverage entries, or surrounding context hints.
- Do not invent missing planner fields.
- Do not reconstruct a plan from arbitrary numbered non-submit tool calls in the first version.
- Do not add repo-specific rules for Trails, Hyperlane, quotes, decimals, or any target symbols.
- Do not roll back Plan 56.
- Do not weaken Stage 9 verification or final composition.

## Diagnosis

The failure is not a model-connectivity problem, not a Stage 7 hunk-review problem, and not a verifier/composer problem. Run 7 never reached packets.

The narrow failure is:

```json
{
  "diffUnderstanding": { "...": "..." },
  "riskAreas": [ ... ],
  "coverage": [ ... ],
  "reason": "Documentation only; verify it accurately describes the decimal-mismatch bug."
}
```

The extra `reason` key is not part of the planner schema. The useful fields were present and could have gone through existing semantic normalization. Rejecting this payload is correct for raw schema validation, but too brittle after an explicit repair call.

The runner already supports stage-specific deterministic recovery:

```ts
schemaRepair: {
  recoverInvalidSubmit?(input): Record<string, unknown> | undefined
}
```

Stage 5 should use that hook the same way Stage 7 and Stage 10 use conservative schema salvage for near-valid structured payloads.

## Plan

1. Add a Stage 5 planner invalid-submit recovery helper.
   - Keep it local to `src/pipeline/planner.ts` unless a shared helper becomes clearly useful.
   - Wire it through `runPlannerCall().schemaRepair.recoverInvalidSubmit`.
   - The helper should inspect invalid `submit_plan` calls from `LlmSchemaInvalidSubmitRecoveryInput`.

2. Recover only payloads that already look like a complete plan.
   - Require a record-like object.
   - Require `diffUnderstanding`, `riskAreas`, and `coverage` to exist.
   - Allow optional `reviewQuestions` and `partialReview`.
   - Prefer the candidate submit call with the strongest plan shape if more than one exists.
   - Return `undefined` when required fields are missing.

3. Strip only unknown root-level keys.
   - Allowed root keys:
     - `diffUnderstanding`
     - `riskAreas`
     - `reviewQuestions`
     - `coverage`
     - `partialReview`
   - Drop fields such as `reason`, `notes`, `summary`, or other top-level annotations.
   - Do not strip or normalize nested unknown keys; let `SubmitPlanSchema` reject those.
   - Do not coerce arrays, strings, enums, or nested object shapes in this plan.
   - Return a recovered payload only when the helper actually stripped at least one unknown root key. If the payload already has only schema-known root keys but still fails validation, return `undefined` and let the existing repair/failure path handle it.

4. Keep schema validation as the acceptance gate.
   - The runner will validate the recovered object against `SubmitPlanSchema`.
   - If validation still fails, fall back to existing repair failure behavior.
   - `validatePlan` should still run after schema recovery to dedupe, normalize question IDs, trim invalid hunk references, and apply default coverage behavior.

5. Add telemetry for deterministic planner salvage.
   - Emit a Stage 5 warning or info event such as `planner_schema_recovery_stripped_root_keys`.
   - Include:
     - stripped key names,
     - invalid submit call count,
     - whether this happened during initial response or after repair (`schemaRepairUsed`),
     - recovered root key count.
   - Do not log the full plan payload in high-level telemetry.

6. Keep the repair prompt as-is for now.
   - The prompt already tells the model to call `submit_plan` exactly once.
   - The problem was not the repair prompt failing completely; it produced a nearly valid plan.
   - If this failure repeats with nested XML/parameter bleed inside `coverage` or `reviewQuestions`, consider a later plan for schema-guided prompt simplification.

7. Add focused tests.
   - Planner recovery strips an extra top-level `reason` field and returns a schema-valid plan.
   - Planner recovery works when `schemaRepairUsed` is true.
   - Planner recovery returns `undefined` for `{}` or any payload missing required fields.
   - Planner recovery returns `undefined` for a complete-looking payload that has no unknown root keys, because there is nothing deterministic to salvage.
   - Planner recovery does not strip nested unknown fields to force a bad plan through.
   - `runPlanner` still calls `validatePlan` after recovered payloads, so invalid/unknown hunk IDs and review-question IDs are normalized as before.

8. Validate against the run-7 failure mode.
   - Add a fixture-like test shaped after `mc-000002`: complete plan plus extra root `reason`.
   - Confirm it no longer aborts Stage 5.
   - Confirm the raw initial `{}` submit would still schedule repair rather than being accepted.

## Likely Files

- `src/pipeline/planner.ts`
- `src/llm/llm-runner.ts` only if type imports need adjustment
- `tests/pipeline-phase5.test.ts`
- `plans/README.md`

## Acceptance Criteria

- A repaired planner payload with only extra root-level annotation fields is recovered and validated.
- A missing required planner payload is not recovered.
- Nested schema errors are not hidden by the recovery helper.
- Stage 5 telemetry records when root keys were stripped.
- Plan 56 review-question behavior remains intact.
- Full build and test suite pass.

## Validation

Run focused tests:

```text
pnpm exec vitest run tests/pipeline-phase5.test.ts tests/phase4-llm.test.ts
```

Then run:

```text
pnpm run build
pnpm test
git diff --check
```

Then rerun the failed eval:

```text
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/49f4645b --no-cache
```

Expected next-run behavior:

- Stage 5 completes instead of aborting on a harmless extra root field.
- `review-plan.json` is written.
- Stage 6 packet construction runs.
- Any remaining review-quality issues can be evaluated from Stage 7 onward.

## Stop Conditions

Stop and reassess if:

- the recovery helper starts coercing nested object shapes,
- the model repeatedly emits malformed plans that require reconstructing objects from numbered non-submit tool calls,
- telemetry shows many planner salvage events per run,
- recovered plans produce worse coverage decisions than deterministic fallback,
- the fix creates a broad schema leniency path that could hide real planner errors.
