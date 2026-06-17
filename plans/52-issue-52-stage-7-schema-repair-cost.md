# Issue 52: Stage 7 Candidate Schema Repair Cost

Status: COMPLETE
Planned from: trails-api eval run 17, 2026-06-17
Recommended priority: next reliability/cost fix

## Problem

Run 17 passed, but Stage 7 had an expensive schema-repair path for one useful candidate finding.

The concrete run-17 example:

- packet: `7848ccd3a46103e3a1e81020936e2ffb318baa32aa31132b73b4a44ca88f0950`
- invalid finalize call: `mc-000158`
- repair call: `mc-000177`
- original finalize: `94,061` prompt chars, `$0.3187`, `58.9s`
- repair prompt instruction: `2,665` chars
- actual repair call: `111,911` prompt chars, `$0.1162`, `23.7s`

The model produced a semantically useful `submit_review` finding but added one unknown field:

```json
"category_note": ""
```

The local schema correctly rejected it:

```text
findings.0: must not have additional properties
```

The expensive part was not the repair instruction. Stage 7 used append-mode repair (`replaceConversation: false`), so the repair call resent the full prior packet conversation, including packet context, tool results, and the malformed assistant submit.

This was recoverable and did not hurt recall, but it is wasteful and can make large reviews slower and more expensive.

## Goal

Make Stage 7 `submit_review` schema repair cheap and safe when the submitted payload is structurally close to valid.

The desired behavior is:

- keep schema validation strict,
- recover harmless malformed candidate payloads without resending the full packet conversation,
- never invent or modify substantive finding content,
- preserve Stage 7 recall,
- keep telemetry explicit about deterministic cleanup versus model repair.

## Architecture Guidance

Keep this as an incremental improvement to the existing Stage 7 repair path in `pi-runner.ts`.

Prefer:

- a small helper for candidate-submit cleanup/classification,
- normal schema validation as the only acceptance gate,
- compact replacement repair through the existing `schemaRepair` mechanism.

Avoid:

- a broad new schema-recovery framework,
- stage-specific business logic in the generic runner beyond dispatching to stage-specific recovery helpers,
- re-reviewing code during schema repair.

## Non-Goals

- Do not loosen the `submit_review` schema.
- Do not accept arbitrary malformed model output.
- Do not silently drop substantive fields that might change review meaning.
- Do not reintroduce compact/no-finding finalization behavior that harmed recall.
- Do not reduce Stage 7 tool access or investigation budget.
- Do not make this specific to Trails, Go, relay, decimals, or `category_note` only.
- Do not disable provider reasoning/thinking to avoid schema failures.

## Diagnosis

Stage 7 currently has two broad classes of schema-invalid submits:

1. Empty/no-finding payloads with a minor shape problem.
   - Example: `noFindingReason` exceeds the schema length.
   - Current deterministic recovery worked in run 17.

2. Candidate-like payloads with a minor schema problem.
   - Example: unknown extra field in a finding.
   - Current behavior schedules model repair with `replaceConversation: false`.
   - This preserves the whole packet conversation and makes the repair expensive.

The second class is the target. We want to recover or repair the JSON arguments, not ask the model to re-review the code.

## Plan

1. Add Stage 7 invalid-submit classification for candidate payloads.
   - Reuse existing schema-invalid classification helpers where possible.
   - Classify at least:
     - `extra_finding_properties`,
     - `extra_top_level_properties`,
     - `missing_required_finding_fields`,
     - `invalid_enum_value`,
     - `string_too_long`,
     - `xml_parameter_bleed`,
     - `unsafe_candidate_like_payload`.
   - Keep unknown cases classified as unsafe.
   - Keep the classifier deterministic and close to the existing Stage 7 no-finding salvage helpers.

2. Add conservative deterministic cleanup before model repair.
   - If the invalid submit contains candidate findings and the only validation failure is harmless unknown properties, remove those unknown properties and revalidate.
   - Only strip keys that are not in the schema and are not needed to understand the finding.
   - Safe examples:
     - empty annotation fields such as `category_note`,
     - accidental comment/note fields not referenced elsewhere.
   - Do not strip:
     - unknown nested evidence objects if their removal would erase the only proof,
     - unknown anchor data that might indicate line/range ambiguity,
     - fields with non-empty substantive prose unless the same substance exists in schema-valid fields.
   - If cleanup succeeds, emit telemetry and continue with the recovered payload.

3. Keep deterministic cleanup schema-gated.
   - Always validate the cleaned payload with the normal `submit_review` schema.
   - Do not accept partially valid payloads.
   - Do not coerce severities, categories, confidence values, anchors, or evidence into valid values.
   - If a value has the wrong enum/type, use model repair rather than guessing.

4. Replace append-mode Stage 7 candidate repair with compact replacement repair.
   - When deterministic cleanup is not safe, retry once with `replaceConversation: true`.
   - The replacement repair prompt should include only:
     - the schema validation error,
     - the invalid submitted arguments, truncated safely if needed,
     - concise schema constraints,
     - the instruction to call `submit_review` exactly once with corrected arguments.
   - It should not include:
     - the full original packet prompt,
     - prior tool results,
     - full source excerpts,
     - the invalid assistant conversation around the tool call.
   - The model is repairing structured JSON, not re-evaluating code.
   - Use the existing `schemaRepair.replaceConversation` path rather than adding a second repair loop.

5. Add safety guard for candidate repair.
   - Never repair candidate payloads to `no_findings`.
   - If the raw invalid payload contains findings, either recover findings, model-repair findings, or fail the packet as degraded.
   - Do not silently convert a malformed candidate to a no-finding result.

6. Keep no-finding deterministic recovery separate.
   - The existing long `noFindingReason` recovery is fine.
   - Make the telemetry distinguish no-finding shape cleanup from candidate payload cleanup.

7. Add telemetry.
   - Emit:
     - `stage7_schema_cleanup_attempted`,
     - `stage7_schema_cleanup_recovered`,
     - `stage7_schema_cleanup_rejected`,
     - `stage7_schema_compact_repair_scheduled`,
     - `stage7_schema_repair_recovered`,
     - `stage7_schema_repair_failed`.
   - Include:
     - classification,
     - stripped key names,
     - `replaceConversation`,
     - repair prompt chars,
     - original call id,
     - recovered call id when applicable.
   - Do not log full large invalid payloads into high-level telemetry.

8. Add cost-focused telemetry summary.
   - Count Stage 7 schema-invalid candidates separately from no-finding schema invalids.
   - Report:
     - deterministic cleanup count,
     - compact repair count,
     - append-mode repair count if any remain,
     - recovered count,
     - failed count,
     - repair prompt chars and actual repair call prompt chars.

9. Add focused tests.
   - Extra unknown finding property is stripped and revalidated.
   - Non-empty unknown field with unique substantive content is not stripped blindly.
   - Wrong enum value uses compact repair or fails, never guessed locally.
   - Candidate-like invalid payload is never salvaged to no-findings.
   - Compact repair uses `replaceConversation: true`.
   - Compact repair prompt excludes prior full packet/tool context.
   - Long `noFindingReason` recovery still works.

## Likely Files

- `src/pipeline/review-runner.ts`
- `src/llm/pi-runner.ts`
- `src/llm/llm-runner.ts`
- `src/llm/schemas.ts` or schema helper modules
- `src/telemetry/run-artifacts.ts`
- `src/types.ts` if new telemetry enums are needed
- `tests/phase4-llm.test.ts`
- `tests/pipeline-*.test.ts`
- `tests/telemetry.test.ts`

## Acceptance Criteria

- A run-17-style extra `category_note` field is recovered without a large append-mode model repair.
- Candidate payload repair does not resend the full packet conversation.
- Candidate payload repair never downgrades malformed findings into no-findings.
- Existing no-finding deterministic recovery continues to work.
- Stage 7 schema repair telemetry clearly reports cleanup versus compact repair.
- No test expects schema validation to accept unknown properties.
- Full test suite and build pass.

## Validation

Run focused tests:

```text
pnpm exec vitest run tests/phase4-llm.test.ts tests/pipeline-*.test.ts tests/telemetry.test.ts
```

Then run:

```text
pnpm test
pnpm run build
```

On the next comparable eval, check:

- Stage 7 candidate schema repair actual prompt chars are small.
- No `replaceConversation:false` Stage 7 candidate repair remains for schema-only JSON fixes.
- Candidate count and final recall do not regress.
- Stage 7 cost decreases or stays flat without new packet failures.

## Stop Conditions

Stop and reassess if:

- safe cleanup requires interpreting review semantics,
- unknown fields contain evidence not present elsewhere,
- compact repair starts changing the substance of candidate findings,
- false positives increase because malformed findings bypass real verification,
- Stage 7 recall drops,
- implementation duplicates too much schema-validation logic instead of reusing the existing validator.
