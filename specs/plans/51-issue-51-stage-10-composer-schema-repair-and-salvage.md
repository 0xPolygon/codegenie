# Issue 51: Stage 10 Composer Schema Repair and Salvage

Status: COMPLETE
Planned from: trails-api eval run 16, 2026-06-17
Recommended priority: immediate reliability fix before more eval tuning

## Problem

Run 16 completed the review pipeline through verification, then failed in Stage 10 composition:

```text
ERROR llm_schema_invalid: model submit payload failed schema validation after repair
```

The failure was not caused by Stage 7 recall or Stage 9 verification. The composer produced a malformed `submit_composition` tool payload. The model put XML/tool-parameter wrapper text inside the `summary` string:

```text
</parameter>
<parameter name="composedFindings">[
  ...
```

That made the submitted arguments invalid:

- `composedFindings` was missing as a top-level property,
- `summary` exceeded the 4000-character schema limit,
- the schema repair call resent a large composer context and failed again.

As a result, codegenie discarded an otherwise useful verified review and wrote no final findings artifacts:

- no `final-findings.json`,
- no `final-review.md`,
- no `final-selection.json`,
- eval reported `0 reported | 0/0 expectations`.

## Goal

Make Stage 10 robust when the composer has already produced substantively useful content but the structured submit payload is malformed.

The desired behavior is:

- recover deterministic XML/parameter bleed when it is safe,
- retry with a compact repair prompt when deterministic salvage is not safe,
- fall back to deterministic composition from verified findings if repair still fails,
- never publish unverified findings,
- keep telemetry honest about degraded/fallback composition.

## Non-Goals

- Do not make composer prompts larger.
- Do not lower schema validation strictness.
- Do not accept arbitrary malformed model output.
- Do not hide schema failures from telemetry.
- Do not tune this to Trails, Go, or any eval expectation.
- Do not rework Stage 7 or Stage 9 in this plan.
- Do not disable provider reasoning/thinking as a workaround.
- Do not ask the model to re-review code during schema repair.

## Diagnosis

Run 16 had healthy upstream stages:

| Stage | Run 16 behavior |
| --- | --- |
| Stage 5 | planner prompt projection worked: `299129` raw chars -> `102537` projected chars |
| Stage 6 | built `72` packets, reviewed `130/131` hunks, `1` import-only hunk skipped |
| Stage 7 | generated `14` direct candidates and `17` verification representatives |
| Stage 9 | accepted/revised `8`, rejected the LiFi false positive, kept AmountFromUSD and zero-native-price |
| Stage 10 | two `schema_invalid` composer calls, no final artifacts |

The initial composer call had `promptChars: 96707`. The repair call had `promptChars: 126913`, because repair preserved the broader conversation and invalid assistant content. The issue is not that Opus cannot handle that context. The issue is that a schema-repair task should be narrow and isolated. Re-exposing the model to the malformed parameter wrapper made the repair less crisp and more expensive.

## Plan

1. Add Stage 10-specific malformed payload classification.
   - Reuse existing schema-invalid classification helpers where possible.
   - Detect:
     - XML/`<parameter>` bleed,
     - missing top-level `composedFindings`,
     - summary containing leaked `composedFindings`,
     - summary length overflow,
     - missing submit call,
     - unknown invalid arguments.
   - Emit telemetry such as:
     - `composer_schema_invalid`,
     - `composer_schema_invalid_classified`,
     - `schemaInvalidKind: "xml_parameter_bleed"`.

2. Add deterministic salvage for XML parameter bleed.
   - If the submitted args contain a `summary` string with a clear `<parameter name="composedFindings">` section, try to extract the embedded JSON array.
   - Build a corrected object:
     - `summary`: the text before the leaked parameter marker, stripped of XML tags and truncated to the schema limit,
     - `composedFindings`: the extracted parsed array,
     - any other required schema fields preserved or defaulted only if safe and already derivable.
   - Validate the corrected object with the normal `submit_composition` schema before accepting it.
   - If validation fails, continue to model repair or fallback.
   - Emit:
     - `composer_payload_salvage_attempted`,
     - `composer_payload_salvage_succeeded`,
     - `composer_payload_salvage_failed`.

3. Keep deterministic salvage conservative.
   - Only salvage when the leaked parameter name and JSON boundaries are unambiguous.
   - Do not parse partial/truncated JSON into findings.
   - Do not invent finding bodies, IDs, anchors, categories, or publication status.
   - Do not salvage if extracted `findingIds` reference unknown or unverified findings.
   - Do not salvage if any composed finding would publish a rejected candidate.
   - Preserve an artifact or telemetry fingerprint of the original failure without logging full sensitive content.

4. Replace the Stage 10 repair prompt with a compact replacement prompt.
   - If deterministic salvage fails, retry once with `replaceConversation: true`.
   - The repair prompt should include only:
     - validation errors,
     - the required `submit_composition` schema constraints in short form,
     - verified findings or final-composition candidates already available to Stage 10,
     - a strict instruction to call `submit_composition` exactly once.
   - Explicitly prohibit:
     - XML,
     - `<parameter>` tags,
     - Markdown code fences,
     - prose outside the tool call,
     - repository tools or requests for more context.
   - Do not append the full prior invalid assistant content to the conversation.

5. Add deterministic composer fallback after failed repair.
   - If Stage 10 LLM composition remains schema-invalid after salvage and compact repair, do not erase verified findings.
   - Use the existing deterministic fallback path or add a minimal one if it does not cover schema-invalid errors.
   - Fallback output should:
     - render verified `keep`/`revise` findings in ranked order,
     - preserve anchors and publication eligibility,
     - include a short note that LLM composition failed and deterministic fallback formatting was used,
     - set `compositionMode: "deterministic_fallback"` or a more specific `"schema_repair_fallback"`.
   - Eval should score the fallback findings normally, because they were already verified.

6. Fix failed-stage lifecycle telemetry.
   - Run 16 Stage 10 showed `runtimeMs: 0` despite two model calls over roughly two minutes.
   - Ensure failed stages record:
     - started time,
     - failed/completed time,
     - runtime,
     - error code,
     - model-call count and cost.
   - Keep Stage 0 `review_pipeline_failed` as the top-level error, but do not lose the failed Stage 10 lifecycle summary.

7. Improve composer artifacts on failure.
   - Even when Stage 10 fails and fallback is not possible, write enough artifacts for diagnosis:
     - verified finding count,
     - composer input summary,
     - schema invalid kind,
     - repair attempted/succeeded/failed,
     - whether deterministic fallback was available.
   - Do not write a misleading empty `final-findings.json` unless the run truly had no verified findings.

8. Add focused regression tests.
   - XML parameter bleed in `summary` with valid embedded `composedFindings` is salvaged and validated.
   - Summary is sanitized/truncated without losing composed findings.
   - Salvage rejects unknown finding IDs.
   - Salvage rejects malformed/truncated composed-finding JSON and moves to repair.
   - Compact repair uses `replaceConversation: true` and does not include raw invalid assistant content.
   - Repair prompt prohibits XML/`<parameter>` tags.
   - Schema-invalid composer failure with verified findings falls back deterministically.
   - Schema-invalid composer failure with no verified findings still fails clearly.
   - Failed Stage 10 records non-zero lifecycle runtime and error metadata.

## Likely Files

- `src/pipeline/composer.ts`
- `src/llm/pi-runner.ts`
- `src/llm/schemas.ts` or existing schema/classification helpers
- `src/telemetry/run-artifacts.ts`
- `src/types.ts` if new composition-mode or telemetry fields are needed
- `tests/*composer*.test.ts`
- `tests/*phase4-llm*.test.ts` or existing structured-runner tests
- `tests/*telemetry*.test.ts`

## Acceptance Criteria

- Run-16-style XML/parameter bleed in `submit_composition` no longer aborts the whole review when the embedded composed findings are recoverable.
- Stage 10 schema repair uses a compact replacement prompt instead of resending the full invalid composer conversation.
- If salvage and repair fail but verified findings exist, deterministic fallback produces final artifacts rather than `0` reported findings.
- Fallback never publishes unverified or verifier-rejected candidates.
- Stage 10 failed lifecycle telemetry records real runtime and error metadata.
- Schema-invalid composer events are visible in telemetry with a classified reason.
- Tests cover salvage success, salvage refusal, compact repair, fallback, and telemetry.

## Validation

Run focused tests first:

```text
pnpm exec vitest run tests/*composer*.test.ts
pnpm exec vitest run tests/*phase4*.test.ts
pnpm exec vitest run tests/*telemetry*.test.ts
```

Then run:

```text
pnpm test
pnpm run build
```

On the next trails-api eval, check:

- Stage 10 does not abort with `llm_schema_invalid` for salvageable XML/parameter bleed.
- If composer repair/fallback is used, final artifacts are still written.
- Eval output does not show `0 reported | 0/0 expectations` after Stages 7 and 9 succeeded.
- `compositionMode` clearly states whether the LLM composer or deterministic fallback produced the final report.
- Stage 10 runtime is non-zero on failure or fallback.

## Stop Conditions

Stop and reassess if:

- deterministic salvage would require inventing or modifying finding substance,
- malformed payloads contain only partial/truncated composed findings,
- fallback would publish candidates that did not pass verification,
- repair prompts need full raw model output to succeed,
- telemetry would expose large invalid model payloads or sensitive source content,
- the implementation starts duplicating ranking/deduplication logic instead of reusing the existing final-selection path.

## Maintenance Notes

This is a Stage 10 reliability plan, not a review-quality tuning plan.

The clean boundary is:

- Stage 7 generates candidates.
- Stage 9 verifies them.
- Stage 10 ranks, dedupes, rewrites, and formats verified findings.

If Stage 10 formatting fails after verification succeeded, codegenie should degrade formatting before it discards verified findings. Strict schema validation should remain in place, but recoverable provider formatting mistakes should not erase a completed review.
