# Issue 62: Stage 7 Schema Friction Reduction

Status: COMPLETE
Planned from: trails-api eval run `0c4d5213/logs/25`, 2026-06-17
Recommended priority: after Issue 61, because run 25 passed but Stage 7 spent avoidable work recovering schema-invalid submit payloads

## Problem

Run 25 passed and all schema-invalid calls recovered, but Stage 7 still had 9 schema-invalid packet-review calls.

The failures were not substantive review failures. They were mostly output-shape friction:

- `noFindingReason` longer than the schema limit,
- `answeredQuestions.*.answer` longer than the schema limit,
- XML/tool-parameter bleed inside text fields,
- extra non-schema fields attached to candidate findings,
- no-finding payloads carrying detailed essay-style reasoning.

The recovery path worked, but it still costs latency, tokens, and complexity. It also makes telemetry noisier than necessary.

## Goal

Reduce avoidable Stage 7 schema-invalid calls while preserving review recall.

Important re-read note: codegenie already has a Stage 7 cleanup/repair path in `src/llm/stage7-submit-repair.ts`, with telemetry such as `stage7_schema_cleanup_attempted`, `stage7_schema_cleanup_recovered`, and `stage7_no_finding_reason_truncated`. This plan should refine that existing path, not introduce a parallel subsystem.

Desired behavior:

- no-finding submissions are concise by default,
- Stage 7 outputs are not mini review reports; they are candidate findings, short question answers, or precise unresolved predicates,
- detailed reasoning is carried only where it helps evidence, follow-up hints, uncertainties, or candidate findings,
- models receive clearer schema/field-limit instructions,
- safe deterministic cleanup avoids model repair when possible,
- non-semantic extra fields are stripped or mapped without losing useful review evidence.

This should make the system healthier and cheaper without making Stage 7 more conservative.

## Non-Goals

- Do not suppress candidate findings to reduce schema errors.
- Do not lower verifier standards.
- Do not remove structured `answeredQuestions`.
- Do not make no-finding reasons empty or useless.
- Do not add another model call only to rewrite normal Stage 7 outputs.
- Do not accept arbitrary extra properties silently if they carry semantic content that should be modeled explicitly.
- Do not target trails-api or Go-specific wording.

## Design

### 1. Make Stage 7 No-Finding Output Shorter

Update packet-review instructions so no-finding output is compact:

- `noFindingReason` should be a short conclusion, not a full proof.
- Prefer 2-4 sentences.
- Do not repeat all inspected code.
- If the packet answered a review question, put only the decisive trace in `answeredQuestions.evidenceTrace`.
- If a predicate is unresolved, use a follow-up/uncertainty with the exact predicate instead of writing a long no-finding essay.
- If the packet found a concrete changed-line failure mode, emit a candidate finding instead of explaining it in no-finding prose.

The prompt should still say:

- if a concrete defect exists, emit a candidate finding;
- if evidence is partial, preserve the exact predicate;
- no finding is valid only after the packet's required checks were answered or scoped.

This is presentation discipline, not recall suppression.

### 1b. Keep Tool Use Predicate-Driven

Update Stage 7 prompt/nudge wording so tool calls are framed around resolving a specific suspected predicate:

- Prefer exact source reads (`read_symbol`, `read_range`, `find_definition`, `read_diff_blocks`) tied to a concrete question.
- Avoid broad exploration after the packet already has enough evidence to submit a candidate, answer no issue, or preserve a follow-up.
- When the model wants another tool call near the budget limit, it should either name the exact predicate the tool decides or submit.
- If the decisive predicate is outside local budget, preserve it as a follow-up/uncertainty instead of continuing to explore.

This should reduce late rejected tool calls indirectly without changing the budget policy in this plan.

### 2. Strengthen Provider-Facing Tool Schema Descriptions

Add or tighten descriptions for Stage 7 submit fields:

- `noFindingReason`: concise, max length, no XML/parameter tags.
- `answeredQuestions.answer`: concise answer, max length.
- `answeredQuestions.evidenceTrace`: concise trace, max length.
- `followUpHints.reason`: concrete unresolved predicate, max length.
- candidate finding fields: no extra keys; use existing fields only.

Where TypeBox/JSON schema supports it, set explicit `maxLength` for fields that currently fail.

Descriptions should state:

```text
Return only JSON/tool arguments matching the schema. Do not include additional properties. Do not emit XML tags, <parameter> blocks, or markdown wrappers inside fields.
```

Keep the descriptions short enough that they do not bloat every prompt.

### 3. Refine Existing Deterministic Cleanup

Reuse the existing Stage 7 cleanup path for known non-semantic shape issues:

- trim `noFindingReason` to the schema max with a clear suffix,
- trim `answeredQuestions[*].answer` and `evidenceTrace` to max lengths,
- strip XML/Anthropic `<parameter ...>` bleed from string fields when the intended JSON payload is otherwise present,
- strip known non-semantic extra fields from candidate findings if the same information already exists in allowed fields,
- normalize empty no-finding payloads into the expected no-finding shape when no findings/hints/uncertainties are present.

Rules:

- Cleanup must be deterministic.
- Cleanup must not invent findings or evidence.
- Cleanup must not delete candidate findings.
- Cleanup must not strip semantic fields unless they are copied into an allowed field or already represented elsewhere.
- If cleanup changes a candidate payload materially, keep the schema-invalid/repair path instead of silently accepting it.
- Do not add a second cleanup pipeline. Keep the implementation in, or adjacent to, the current Stage 7 submit-repair helper.

Telemetry should reuse the existing vocabulary unless a genuine missing state is found:

- classification,
- cleaned fields,
- stripped keys,
- whether repair was avoided.

Do not rename existing events. Fragmenting schema telemetry would make eval comparisons harder.

### 4. Decide Whether Useful Extra Fields Should Become Schema Fields

Some extra fields may be useful but currently invalid. Audit the run-25 invalid payloads and classify extra fields into:

- non-semantic duplicate/prompt spillover: strip,
- useful but already represented elsewhere: map/strip,
- genuinely useful new structured evidence: add to schema deliberately,
- dangerous/ambiguous: reject and repair.

Default posture: do not expand the schema in this plan. Strip safe duplicate/prompt-spillover fields; route semantic or ambiguous fields through existing repair. Add a schema field only if repeated runs show the field is genuinely valuable and downstream code is ready to consume it.

## Implementation Steps

1. Audit current Stage 7 submit schema and normalization.
   - Locate TypeBox schemas for `submit_review`.
   - Locate provider-facing schema conversion.
   - Locate current Stage 7 schema cleanup/repair path.
   - List current string limits and extra-property behavior.

2. Tighten Stage 7 prompt/schema descriptions.
   - Add concise field-limit guidance.
   - Explicitly forbid extra properties and XML/parameter tags.
   - Make the Stage 7 contract explicit: candidate finding, short answer, or exact unresolved predicate.
   - Add predicate-driven tool-use wording to the existing post-tool nudge.
   - Keep wording generic.

3. Refine deterministic cleanup.
   - Reuse the existing `stage7-submit-repair` helper.
   - Cleanup no-finding and answered-question string overflow without model repair when safe.
   - Strip known non-semantic extra fields safely.
   - Preserve existing schema repair as fallback.

4. Add telemetry.
   - Reuse existing `stage7_schema_cleanup_*` and `stage7_schema_repair_*` events.
   - Add fields to existing events only if needed to make cleanup-vs-repair clearer.
   - Do not add a competing `stage7_schema_precleanup_*` vocabulary.

5. Add tests.
   - Long `noFindingReason` is truncated and accepted without a repair call.
   - Long `answeredQuestions.answer` is truncated and accepted without a repair call.
   - XML parameter bleed in no-finding text is cleaned when the payload is otherwise valid.
   - Extra non-semantic finding fields are stripped when safe.
   - Semantic unknown fields still fail and go to repair.
   - Candidate findings are not dropped during cleanup.

## Likely Files

- `src/pipeline/lens-runner.ts`
- `src/pipeline/llm-runner.ts`
- `src/llm/stage7-submit-repair.ts`
- `src/schema/*` or wherever submit-review schemas live
- `src/types.ts`
- `src/telemetry/run-artifacts.ts`
- `tests/*schema*.test.ts`
- `tests/*lens-runner*.test.ts`

## Acceptance Criteria

- Run-25-style long no-finding and answered-question payloads are recovered through existing deterministic cleanup, not model repair.
- Prompt/schema wording reduces the number of new Stage 7 schema-invalid calls where possible.
- Existing cleanup avoids repair calls for safe shape issues.
- No final finding is lost because of cleanup.
- Schema recovery telemetry clearly reports deterministic cleanup vs repair.
- Stage 7 output remains recall-oriented: concrete defects still become candidates.

## Validation

Run focused tests:

```text
pnpm exec vitest run tests/*schema*.test.ts tests/*lens-runner*.test.ts
```

Then run:

```text
pnpm test
pnpm run build
```

On the next eval, check:

- Stage 7 schema-invalid calls,
- deterministic cleanup recovered count,
- repair call count,
- candidate count,
- final finding count,
- expectation pass/fail,
- no increase in false positives.

## Stop Conditions

Stop and reassess if:

- cleanup drops or materially rewrites a candidate finding,
- schema descriptions become so verbose that prompt cost increases noticeably,
- extra fields appear semantically valuable and require broader type design,
- reducing schema-invalid calls also reduces candidate recall,
- telemetry becomes harder to interpret.
