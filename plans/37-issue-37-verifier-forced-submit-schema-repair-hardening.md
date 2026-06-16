# Issue 37: Verifier Forced-Submit Schema Repair Hardening

Status: PENDING
Planned from: trails-api eval run 6 review and Opus 4.8 follow-up, 2026-06-16
Planned at: commit `506fa43`

## Problem

Verifier schema-invalid failures are expensive and brittle. Opus called out a precise failure mode: XML-like `<parameter>` bleed in verifier forced-submit/schema-repair output. That is actionable because codeninja should force a clean `submit_verdict` tool call, not let explanatory XML or parameter wrapper text leak into the structured tool arguments.

This plan should harden Stage 9 repair without disabling provider reasoning/thinking. The root fix is stricter repair context and regression coverage.

## Current State

Relevant files:

- `src/llm/pi-runner.ts` handles forced finalization, submit-tool retries, and generic schema repair.
- `src/pipeline/verifier.ts` catches verifier schema-invalid errors and retries with an appended generic prompt.
- `tests/phase4-llm.test.ts` covers forced finalization and schema repair behavior.
- `tests/verifier.test.ts` covers verifier prompts and verdict handling.

Current forced-finalize behavior:

```ts
// src/llm/pi-runner.ts:172-176
const activeTools = forceFinalize ? [submitTool] : allTools;
const kind = forceFinalize ? schemaRepairUsed ? "repair" : "finalize" : messages.length === 1 ? "initial" : "tool-continuation";
const toolChoice = forceFinalize || repositoryTools.length === 0
  ? { type: "tool" as const, name: submitTool.name }
  : "auto";
```

Current missing-submit retry:

```ts
// src/llm/pi-runner.ts:256-263
if (forceFinalize) {
  if (!finalizeSubmitRetryUsed) {
    ...
    content: `The previous response did not call ${submitTool.name}. You must call ${submitTool.name} now with schema-valid arguments. Do not call repository tools, ask for more context, or answer in plain text. If there are no findings, submit empty arrays where the schema requires arrays.`
```

Current verifier-specific repair:

```ts
// src/pipeline/verifier.ts:580-612
try {
  return await request(prompt.prompt);
} catch (error) {
  if (!isSchemaInvalidError(error)) { throw error; }
  ...
  const repaired = await request(`${prompt.prompt}\n\nThe previous verifier response failed submit_verdict schema validation. Retry once and call submit_verdict with schema-valid arguments only.`);
```

That retry resends the full verifier prompt with a generic instruction, instead of using the runner's `schemaRepair` hook to build a compact, replacement repair conversation.

## Plan

1. Add a verifier-specific schema repair strategy.
   - In `runVerifierStructured`, pass `schemaRepair` to `runner.runStructured` instead of only catching errors afterward.
   - Use:
     - `replaceConversation: true`
     - `failAfterRepair: false` unless existing behavior requires a hard fail
     - `buildPrompt(...)` that returns a compact repair prompt
   - The repair prompt should include:
     - candidate id
     - candidate title/path
     - the validation error summary
     - the required submit tool name
     - a minimal verdict decision reminder
   - It should not include the full prior provider response or any XML-like wrapper text from the model.

2. Make the repair instruction explicit about XML/parameter bleed.
   - Add direct language:
     - "Do not output XML."
     - "Do not write `<parameter>` tags."
     - "Do not describe the schema."
     - "Call `submit_verdict` exactly once."
   - Keep this instruction generic enough for all providers.
   - Do not disable reasoning/thinking mode as a workaround.

3. Keep submit-tool-only repair.
   - During repair/finalize, only the submit tool should be available.
   - Do not allow repository tools during schema repair.
   - Do not let a repair response request more context.
   - Existing forced-submit logic already points in this direction; add tests so it cannot regress.

4. Classify XML/parameter schema failures for telemetry.
   - Add a lightweight classifier on schema-invalid error text:
     - `xml_parameter_bleed`
     - `missing_submit_tool`
     - `invalid_tool_arguments`
     - `extra_tool_calls`
     - `unknown`
   - Include this in `verification_schema_invalid` and `verification_schema_repair_failed` events.
   - Do not store full invalid model content in telemetry.

5. Add regression tests.
   - A verifier response that puts XML-like `<parameter>` content in a string/tool argument fails validation, triggers the compact repair path, and succeeds on the repair response.
   - The repair request uses only `submit_verdict`.
   - The repair prompt does not contain the full prior invalid assistant content.
   - The repair prompt includes the XML/parameter prohibition.
   - Forced finalization still keeps reasoning enabled and does not rely on disabling provider thinking.
   - Non-verifier stages keep existing schema repair behavior unless intentionally changed.

6. Revisit post-repair fallback.
   - If repair fails, keep returning an incomplete verifier verdict rather than crashing the whole run, as current Stage 9 behavior does.
   - Make the incomplete reason precise:
     - `schema_invalid_after_repair: xml_parameter_bleed`
   - Ensure the final review reports partial/degraded verification when this affects findings.

## Opus 4.8 Comparison

This plan directly addresses Opus's precise diagnosis: verifier schema invalidity from XML/`<parameter>` bleed. It does not treat the problem as a generic provider flake and does not work around it by disabling thinking.

## Likely Files

- `src/pipeline/verifier.ts`
- `src/llm/pi-runner.ts`
- `src/llm/schemas.ts` only if schema error classification needs helpers
- `src/types.ts`
- `tests/verifier.test.ts`
- `tests/phase4-llm.test.ts`
- `tests/pipeline-phase5.test.ts` only if end-to-end verifier degradation assertions need updates

## Verification Commands

- `pnpm test -- tests/verifier.test.ts`
- `pnpm test -- tests/phase4-llm.test.ts`
- `pnpm test -- tests/pipeline-phase5.test.ts`
- `pnpm run build`

Expected result: all commands exit 0.

## Acceptance Criteria

- Verifier schema-invalid repairs use a compact replacement repair prompt, not a full prompt append.
- XML/`<parameter>` bleed is explicitly prohibited and classified in telemetry.
- Repair/finalize turns expose only the submit tool.
- Provider reasoning/thinking remains enabled according to normal config.
- Failed repairs degrade the candidate verification cleanly instead of failing the entire review.

## Stop Conditions

- Stop if the change requires disabling provider reasoning/thinking.
- Stop if repair prompts would include raw invalid model output or sensitive tool contents.
- Stop if the repair behavior changes non-verifier stages without explicit tests.
