# Issue 54: Recovered Schema Telemetry

Status: PENDING
Planned from: trails-api eval runs 16 and 17, 2026-06-17
Recommended priority: after Stage 7 schema repair cost and human-attention dedupe

## Problem

Run 17 recovered successfully from schema-invalid model output, but high-level telemetry still makes some recovered calls look like failures.

Example from Stage 10:

- raw composer model call `mc-000279` had `status: "schema_invalid"`,
- `composer_schema_invalid_classified` classified the issue,
- `schema_invalid_submit_recovered` recovered it,
- Stage 10 completed and produced 9 findings,
- but model-call summary for Stage 10 still showed `ok: 0`, `schema_invalid: 1`.

That is technically accurate for the raw provider call, but incomplete for operational dashboards. A recovered schema-invalid call is different from an unrecovered schema-invalid failure.

## Goal

Make telemetry distinguish raw model-call validity from pipeline outcome after recovery.

The desired behavior is:

- preserve raw `schema_invalid` call records,
- record recovered schema-invalid submits explicitly,
- show stage/pipeline health clearly,
- make eval summaries easier to interpret.

## Architecture Guidance

Implement this as derived telemetry first, not a new recovery subsystem.

Prefer:

- preserving raw model-call status exactly as emitted,
- adding recovery fields/counters beside the raw status,
- deriving stage-level recovery summaries from existing recovery events plus model-call records.

Avoid:

- rewriting historical model-call records,
- proliferating many near-duplicate event names,
- coupling eval scoring to internal repair implementation details.

## Non-Goals

- Do not rewrite raw model call history.
- Do not hide provider/model schema-invalid behavior.
- Do not collapse all repair paths into one vague success counter.
- Do not change eval scoring semantics.
- Do not change review pipeline behavior except telemetry.

## Plan

1. Define schema recovery counters.
   - At minimum:
     - `schemaInvalidCalls`,
     - `schemaInvalidRecovered`,
     - `schemaInvalidUnrecovered`,
     - `schemaRepairAttempts`,
     - `schemaRepairRecovered`,
     - `deterministicSchemaRecovered`,
     - `schemaRecoveryFailed`.
   - Track by stage and total.

2. Preserve raw call status.
   - Keep model-call records as `status: "schema_invalid"` when the submitted payload failed validation.
   - Do not mutate historical records to `ok`.
   - Add a separate recovery field if useful:
     - `recoveryStatus: "recovered" | "failed" | "not_attempted"`,
     - `recoveryKind: "deterministic" | "model_repair" | "fallback"`.

3. Add stage outcome summary.
   - Stage summary should answer:
     - Did the stage complete?
     - Did any schema-invalid calls occur?
     - Were all schema-invalid calls recovered?
     - Did the stage use fallback/degraded formatting?
   - Avoid relying only on raw call status counts.

4. Improve eval display fields.
   - Include a compact phrase when relevant:
     - `schema recovered 5/5`,
     - or `schema invalid 5, recovered 5`.
   - Only surface this in CLI output when non-zero.
   - Do not make passing runs look failed because raw calls were invalid but recovered.

5. Standardize recovery interpretation without event churn.
   - Keep existing events for compatibility.
   - Add new events only where a recovery path currently has no observable signal.
   - Prefer deriving summary counters from:
     - `schema_invalid_submit_recovered`,
     - `schema_invalid_submit_recovery_invalid`,
     - `schema_repair_scheduled`,
     - `stage7_schema_cleanup_attempted`,
     - `stage7_schema_cleanup_recovered`,
     - `stage7_schema_cleanup_rejected`,
     - `stage7_schema_compact_repair_scheduled`,
     - `stage7_schema_repair_recovered`,
     - `stage7_schema_repair_failed`,
     - stage-specific repair/recovery events.
   - Include `stage`, `callId` when available, `role`, `classification`, and `recoveryKind`.

6. Add artifact fields.
   - Update:
     - `model-calls-summary.json`,
     - `telemetry.json`,
     - `budget-summary.json` if useful,
     - `info.json` score metrics.
   - Keep schema versioning in mind if artifacts are consumed by eval comparison.

7. Add tests.
   - Raw schema-invalid call plus deterministic recovery counts as:
     - raw invalid,
     - recovered,
     - stage completed.
   - Raw schema-invalid call plus failed repair counts as unrecovered and stage failed.
   - Stage 10 fallback after schema invalid counts as recovered/fallback, not ok raw call.
   - Eval summary includes schema recovery only when non-zero.

## Likely Files

- `src/telemetry/run-artifacts.ts`
- `src/evals/*`
- `src/cli/*`
- `src/llm/pi-runner.ts`
- `src/pipeline/composer.ts`
- `src/pipeline/review-runner.ts`
- `tests/telemetry.test.ts`
- `tests/eval*.test.ts`
- `tests/phase4-llm.test.ts`

## Acceptance Criteria

- Recovered schema-invalid calls are visible as recovered in telemetry.
- Raw model-call records still show schema-invalid status.
- Stage summaries distinguish recovered schema invalids from unrecovered failures.
- Eval output remains concise but does not mislead operators.
- Run-17-style Stage 10 recovery would show a completed stage with one recovered schema invalid.

## Validation

Run focused tests:

```text
pnpm exec vitest run tests/telemetry.test.ts tests/eval*.test.ts tests/phase4-llm.test.ts
```

Then run:

```text
pnpm test
pnpm run build
```

On the next eval, check:

- CLI summary reports schema recovery when present.
- `info.json` and `telemetry.json` agree on recovered/unrecovered counts.
- Recovered schema-invalid calls no longer require manual event inspection to understand.

## Stop Conditions

Stop and reassess if:

- telemetry starts double-counting repaired calls,
- raw model-call status is overwritten,
- artifact schema changes break existing eval comparison,
- summaries become noisy on clean runs.
