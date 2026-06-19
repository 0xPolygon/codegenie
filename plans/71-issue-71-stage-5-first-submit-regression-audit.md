# Issue 71: Stage 5 First-Submit Regression Audit and Repair

Status: COMPLETE
Planned from: trails-api eval `49f4645b` runs 1-16 and cross-checked against `0c4d5213` run 31, with emphasis on the `49f4645b` run 6 to run 7 first-submit reliability change and the current submit-plan prompt/schema/tool shape, 2026-06-19
Recommended priority: medium-high. This is still worth fixing before release because it targets a reproducible first-submit failure mode, but `0c4d5213` run 31 shows Stage 5 can first-submit cleanly on a large realistic PR with the current code. Treat this as sensitive-dossier hardening, not a universal Stage 5 outage.

## Problem

Recent `49f4645b` runs show that Stage 5 is no longer reliably producing a valid `submit_plan` tool call on the first attempt.

The important pattern:

```text
runs 1-6:
  mostly clean first submits

runs 7-15:
  planner_schema_repair_scheduled every run
```

Runs 13, 14, and 15 make the failure mode clear:

- Run 13: invalid first submit, repair recovered coverage, but downstream framing failed.
- Run 14: invalid first submit `{}`, repair recovered a sparse plan, production coverage collapsed to `deep 0`.
- Run 15: invalid first submit `{ plan: "<stringified json>" }`, repair recovered a full plan, downstream fixes produced a strong finding.

Plan 69 added safety coverage for sparse recovered plans. That is useful insurance, but run 15 shows the underlying Stage 5 first-submit problem remains.
Run 16 shows the insurance works: the planner produced `{}`, repair recovered only sparse coverage, and deterministic safety coverage upgraded source hunks to deep. That kept the review healthy, but it also confirms the first-submit problem is still present.

Cross-eval evidence from `0c4d5213` run 31 changes the scope: the same current pipeline first-submitted cleanly on a much larger 131-hunk refactor PR and produced the best recent result on that eval. The first-submit failure is therefore dossier-sensitive rather than universal. The likely class is a planning dossier whose context contains docs/postmortems/spec text that explicitly names a bug while the Stage 5 prompt strongly says the planner is not reviewing code and must not claim bugs exist.

This should be treated as a regression, not inherent LLM randomness:

- The sampled runs use the same planner model (`claude-opus-4-8`), so the regression should be attributed to Codeninja prompt/schema/tool changes unless the audit proves otherwise.
- Stages 1-4 are deterministic and stable for this eval.
- The same eval became invalid-first-submit consistently after a narrow run window.
- Earlier runs prove clean first-submit behavior is achievable.
- Runs 13-16 show several invalid shapes under newer Codeninja versions: `{}`, `{ plan: "<json>" }`, root-level planner metadata, and sparse recovered coverage.
- `0c4d5213` run 31 proves the current planner is not globally broken; the fix should target the sensitive class without making Stage 5 heavier.

The likely persistence mechanism is not schema field count alone. The provider-facing schema did grow again after Issue 67 (`focusNotes`, `relatedSymbols`, `relatedFiles`, and nested context hints), but at least one invalid `{}` run happened with a near-baseline schema. That points to the Stage 5 prompt and tool-call framing as first-class suspects too.

The current audit should therefore compare the current provider-facing `submit_plan` schema, Stage 5 prompt text, and tool definition against the known-good run-1-to-6-era shape. Do not reduce this to a schema-only diff.

The current leading diagnosis is:

- `{}` submits are likely driven by the Issue 66 Stage 5 prompt rewrite: the prompt shifted from a short positive planning contract to a longer scout-negation/prohibition stack. This matches run 13, which produced `{}` before the Issue 67 coverage subfields existed.
- `{ plan: "<json>" }` submits are likely driven by an incomplete finish instruction: it says not to answer in plain text, but does not explicitly say to call `submit_plan` with object arguments and not a JSON string or `{ plan: ... }` wrapper.
- `focusNotes`, `relatedSymbols`, and `relatedFiles` are secondary schema weight added after the first break. They may still be worth removing from the provider-facing schema if the audit confirms they are rarely populated, commonly misplaced, or derivable internally.

## Goal

Identify and fix the Stage 5 first-submit regression with the smallest general change.

Desired behavior:

```text
Stage 5 first submit valid:
  use it directly

Stage 5 first submit is a common recoverable wrapper:
  unwrap deterministically without an LLM repair call

Stage 5 first submit is malformed or sparse:
  use existing repair/safety paths
  emit precise recovery telemetry
```

The goal is not to make Stage 5 smarter. It is to make Stage 5 easier to call correctly.
The highest-value prevention target is the empty `{}` first submit. A `{ plan: "<json>" }` wrapper can be recovered deterministically; `{}` cannot. Empty submits should be treated as strong evidence that the prompt/tool-call framing is too heavy, contradictory, or unclear. Schema simplification may help, but prompt simplification is likely the primary lever.

## Implementation Audit Result

Implemented on 2026-06-19.

Local telemetry confirmed the plan's core diagnosis:

```text
49f4645b runs 1-6:
  Stage 5 schema-invalid calls: 0,1,0,1,0,0

49f4645b runs 7-16:
  Stage 5 schema-invalid calls: 2,1,1,1,1,1,1,2,1,2

0c4d5213 run 31:
  Stage 5 schema-invalid calls: 0
```

The failure is therefore not universal planner breakage. It is sensitive-dossier first-submit hardening: `49f4645b` repeatedly triggers invalid first submits while the larger `0c4d5213` run first-submitted cleanly with the same current pipeline.

The implemented changes are deliberately narrow:

- Stage 5 prompt text was trimmed back to a short positive coverage-planning contract.
- The redundant prohibition line about review questions, proof obligations, global risk lists, and standalone review emphasis was removed from the prompt; those fields are already excluded by schema.
- The final submit instruction now explicitly requires object arguments, not a JSON string and not a `{ plan: ... }` wrapper.
- Planner schema repair now deterministically unwraps root-only `{ plan: "<json>" }` and `{ plan: {...} }` shapes before scheduling an LLM repair call.
- Recovery telemetry now records `firstSubmitValid`, `unwrappedPlanStringCount`, and `unwrappedPlanObjectCount`.
- `focusNotes`, `relatedSymbols`, and `relatedFiles` were kept in the provider-facing schema for now because they are actively consumed by Stage 6 context assembly and have direct regression coverage. Removing them would be a larger contract change than this issue requires.

The implementation keeps Plan 69 sparse safety coverage unchanged.

## Non-Goals

- Do not make Stage 5 an issue-finding stage.
- Do not reintroduce review questions or obligations.
- Do not add a fixed risk taxonomy.
- Do not make Stage 5 multi-pass by default.
- Do not weaken Stage 7 or Stage 9 because of planner instability.
- Do not remove Plan 69 safety coverage.
- Do not tune for Hyperlane, Go, decimals, or this eval's domain.

## Design

### Architecture Fit

Stage 5 is a lightweight planning and scheduling stage. Its provider-facing `submit_plan` contract should stay small enough for the model to call reliably:

- concise diff understanding;
- coverage decisions;
- selected lenses;
- short reasons for scheduling choices.

Stage 5 should not become an issue-finding pass. Richer internal planning data can be normalized or derived after validation from deterministic inventory, coverage reason prose, static file facts, and the Stage 6 relationship graph. If a field can be derived reliably after the tool call, prefer deriving it internally over making the provider-facing schema larger.

Recovery should stay ordered and explicit:

```text
first submit validates
  -> use directly
recoverable wrapper shape
  -> unwrap deterministically
malformed submit
  -> use LLM repair
repaired plan is sparse or suspicious
  -> apply Plan 69 safety coverage
always
  -> emit telemetry that distinguishes each path
```

Stage 7 and Stage 9 must not compensate for Stage 5 instability by changing review or verification policy. The success metric for this work is improved Stage 5 first-submit validity and clearer recovery telemetry, not just a passing eval.

### 1. Confirm the Regression Audit First

Before broad simplification, confirm the eval run history and compare the Stage 5 provider-facing contract across the known-good and current versions. The audit already has a leading answer; this step should verify it from local artifacts and avoid rediscovering the same facts during implementation.

Build a small table from eval artifacts:

```text
run
codeninja commit
dirty flag
planner_schema_repair_scheduled count
invalid submit shape
coverage distribution
planner prompt/schema version if available
```

Use:

- `logs/<run>/info.json`
- `logs/<run>/telemetry/events.jsonl`
- `logs/<run>/telemetry/review-plan.json`
- `logs/<run>/telemetry/model-calls-summary.json`

Then inspect the diff between the last mostly-clean run and the first consistently-invalid run. Focus on Stage 5 prompt, schema, tool definition, and prompt-builder changes.

Also inspect these artifacts side by side:

```text
run-6-era submit_plan schema
run-6-era Stage 5 prompt text
run-6-era submit_plan tool description
current submit_plan schema
current Stage 5 prompt text
current submit_plan tool description
current internal ReviewPlan type
```

The target is not to restore old behavior blindly. The target is to recover the simpler provider-facing contract that earlier runs handled more reliably while keeping useful internal normalization.

This audit is a gate, but it should be a confirmation gate. Do not start with a broad prompt/schema rewrite. First confirm the run history from local artifacts, identify the codeninja commits involved, and record whether the known diagnosis holds:

- the planner model stayed constant across the sampled runs;
- the `{}` shape correlates with the Issue 66 prompt rewrite and its scout-negation/prohibition wording;
- the `{ plan: "<json>" }` shape is not blocked by the current finish instruction;
- Issue 67's added coverage subfields are secondary weight, not the first `{}` trigger.
- `49f4645b` contains dossier text that explicitly names a bug or postmortem-like concern, while `0c4d5213` does not show the same first-submit failure under the current code.

If the local artifacts do not support these conclusions, narrow this plan to deterministic wrapper recovery plus telemetry and do not remove planner fields.

This should answer:

- Did a schema field become too nested or too strict?
- Did the prompt grow a wall of negative instructions (`do not...`, `you are not...`) that competes with the actual submit shape?
- Did the prompt become ambiguous about whether the model should think in prose, emit raw JSON, or call the tool?
- Did the prompt start encouraging raw JSON instead of tool arguments?
- Did new fields such as `focusNotes`, `relatedSymbols`, or `relatedFiles` overload the coverage shape?
- Are `focusNotes`, `relatedSymbols`, and `relatedFiles` actually populated in successful plans often enough to justify keeping them in the provider-facing schema?
- Can planner-hint edges be derived from deterministic symbol mentions and normalized internal data instead of requiring nested planner fields?
- Did schema repair/prompt changes make the model wrap the whole plan in a string?
- Did any provider/tool-schema conversion change around this point?
- Do dossiers containing bug-describing docs/specs/postmortems raise the `{}` rate because the prompt over-emphasizes "do not claim bugs"?

### 2. Add Deterministic Wrapper Recovery

Run 15 produced a recoverable shape:

```json
{
  "plan": "{ \"diffUnderstanding\": ..., \"coverage\": [...] }"
}
```

Do not spend an LLM repair call for this class.

Before scheduling LLM repair, deterministically try:

```text
if root has only key "plan" and plan is a string:
  parse string as JSON
  validate parsed object as submit_plan args
  if valid, use it
  emit planner_schema_unwrapped_plan_string

if root has only key "plan" and plan is an object:
  validate plan object as submit_plan args
  if valid, use it
  emit planner_schema_unwrapped_plan_object
```

Keep this deliberately narrow. Do not build a general parser for arbitrary prose.

This only fixes wrapper-shaped invalid submits. It does not fix `{}` submits, so it should not be mistaken for the main reliability fix.

### 3. Simplify the Stage 5 Submit Surface Based on the Audit

After the audit confirms the likely regressor, simplify the smallest thing that reduces invalid first submits.

The primary prompt fix should be specific:

- trim the Stage 5 prompt back toward the known-good shape;
- replace the scout-negation/prohibition stack with a short positive contract;
- remove the redundant line that forbids review questions, proof obligations, global risk lists, and standalone review emphasis; those fields are already rejected by `additionalProperties: false`;
- put the exact required tool-call shape near the end of the prompt;
- explicitly say the model must call `submit_plan` with object arguments, not a JSON string and not a `{ plan: ... }` wrapper;

Schema fixes are secondary and should be evidence-driven:

- make optional coverage subfields truly optional and omit empty arrays;
- reduce nested coverage metadata in the tool schema;
- move verbose guidance from schema descriptions into prompt text;
- shorten the Stage 5 prompt around coverage metadata;
- split internal normalization from provider-facing schema if the provider schema is too heavy.

Strong candidate simplification:

```text
Provider-facing submit_plan:
  diffUnderstanding
  coverage decisions with hunkId, coverage, lenses, reason, optional skip reason

Internal normalized ReviewPlan:
  may derive planner emphasis, related symbols, related files, and context hints from:
    coverage reason prose
    deterministic symbol facts
    hunk relationship graph
    static file facts
```

If `focusNotes`, `relatedSymbols`, or `relatedFiles` are rarely populated or commonly misplaced, remove them from the provider-facing schema first while preserving internal fields where deterministic code can derive them. Do not remove useful Stage 5 scheduling signal unless the audit shows it is the regressor.

Strong candidate prompt simplification:

```text
You are doing a lightweight planning pass, not reviewing code.
Return:
  - concise diffUnderstanding
  - one coverage decision per reviewable hunk unless skipping is clearly justified
  - lenses and short reasons
Use the submit_plan tool with object arguments:
  { "diffUnderstanding": ..., "coverage": [...] }
Do not wrap the plan in a "plan" string.
```

Avoid restating every downstream stage responsibility in the prompt. Long cautionary text should move to developer docs or internal comments unless it measurably improves planner output.

### 4. Keep Sparse Safety Coverage as Insurance

Plan 69's sparse recovered-plan safety path should remain:

```text
repair/recovery produces suspiciously sparse source coverage
  -> mark planner recovery degraded
  -> apply bounded safety coverage to source hunks
```

This plan should add or strengthen tests that prove the fallback works, because run 15 did not exercise it.

### 5. Telemetry and Success Criteria

Keep `planner_recovery_summary` and add any missing fields needed to distinguish:

- first-submit valid;
- deterministic unwrap success;
- LLM repair success;
- deterministic sparse recovery;
- safety coverage applied;
- first-submit invalid shape.

Success should be measured by first-submit validity, not just final eval pass.

Suggested metrics:

```text
planner_schema_repair_scheduled count
planner_schema_unwrapped_plan_string count
planner_first_submit_valid count
planner_recovered_sparse_plan count
planner_degraded_safety_coverage_applied count
```

Validation should compare invalid-first-submit rate across enough repeated runs to distinguish improvement from luck. Two runs are useful smoke tests, but the real target is a lower `planner_schema_repair_scheduled` rate over a small batch.

## Implementation Steps

1. Build the run-history table.
   - Parse `49f4645b/logs/1..16`.
   - Record codeninja commit and Stage 5 first-submit status.
   - Identify the first run where invalid first submits became persistent.
   - Save the audit result in the plan or a short adjacent note before changing Stage 5 behavior.

2. Inspect the relevant codeninja diffs.
   - Compare commits around the run 6 -> run 7 transition.
   - Compare the run-6-era `submit_plan` schema against the current schema.
   - Compare the run-6-era Stage 5 prompt/tool description against the current prompt/tool description.
   - Focus on `src/pipeline/planner.ts`, `src/skills/prompt-builder.ts`, planner schemas, and provider-facing tool schema conversion.

3. Implement deterministic `{ plan: ... }` unwrap.
   - Add tests for stringified JSON and object wrappers.
   - Ensure invalid wrappers still fall through to existing repair.
   - Emit telemetry.

4. Implement the smallest schema/prompt simplification supported by the audit.
   - Avoid broad rewrites.
   - Lead with prompt/tool-call clarity if `{}` remains the dominant failure.
   - Prefer simplifying the provider-facing schema over deleting internal normalized data.
   - Remove Stage 5 provider fields only when they are low-value, often empty/misplaced, or derivable from deterministic context.
   - If no concrete regressor is found, limit implementation to deterministic unwrap, explicit submit-shape prompt guidance, and telemetry.

5. Strengthen sparse fallback tests.
   - Force a sparse recovered plan in a unit or eval-shaped fixture.
   - Assert source hunks receive bounded safety deep coverage.
   - Assert user-facing review completeness remains complete when all hunks are reviewed.

6. Validate.
   - Targeted planner tests.
   - Full test suite and build.
   - Run `49f4645b` at least twice with `--no-cache` as a smoke test.
   - Prefer a small repeated-run batch when practical; judge first-submit-validity rate, not only pass/fail.
   - Run the larger `0c4d5213` eval once for no-regression.

## Validation

Expected improvements:

- Fewer Stage 5 `planner_schema_repair_scheduled` events.
- Run-15-style `{ plan: "<json>" }` outputs recover deterministically without an LLM repair call.
- Run-13/run-14-style `{}` outputs become less frequent through prompt/tool contract simplification.
- Run-14-style sparse recovery cannot silently collapse source coverage to normal/deep 0.
- Stage 7 and Stage 9 behavior should remain unchanged for valid plans.

A successful eval should show:

```text
Stage 5 first submit valid
or deterministic unwrap applied
or sparse safety coverage applied
```

It should not depend on an LLM repair call happening to recover a full plan.

## Stop Conditions

Do not proceed if the implementation:

- broadens Stage 5 into issue finding;
- removes useful scheduling/context fields without evidence;
- hides first-submit invalidity by only reporting successful recovery;
- increases planner prompt/schema complexity;
- changes Stage 7 or Stage 9 policy to compensate for planner failures.
