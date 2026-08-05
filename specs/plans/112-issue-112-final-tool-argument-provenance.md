# Issue 112: Enforce Final Structured-Submit Provenance from Pi Events

Status: PENDING
Planned from: audit of `@earendil-works/pi-ai` 0.83.0 final tool-call parsing
and its public `AssistantMessageEventStream`, 2026-08-05
Planned at: commit `07434ba` (branch `plans`)
Recommended priority: after Issue 111. This establishes a fail-closed final
argument boundary using Pi's existing public stream, then measures whether any
larger loss-aware syntax repair or upstream Pi change is justified.

> **Executor instructions**: Follow this plan step by step. Read the entire
> plan before changing code. This is a Codegenie-side implementation against
> Pi's public event API; it does not require a Pi fork, patch, PR, or release.
> Do not implement any item in “Conditional future design.” Mark the plan
> `IMPLEMENTED (measuring)` after the implementation gate passes,
> then collect the corpus in normal use and mark it `COMPLETE` only after
> Step 5 records the human-reviewed outcome. Stop on any STOP condition rather
> than accepting missing/divergent event provenance or adding provider-specific
> wire parsing. Update the README row at both status transitions.
>
> **Drift check (run first)**:
> `git diff --stat 07434ba..HEAD -- src/llm/llm-runner.ts src/llm/pi-runner.ts src/llm/final-tool-arguments.ts src/llm/model-call-cache.ts src/telemetry/telemetry-recorder.ts src/telemetry/run-artifacts.ts tests/final-tool-arguments.test.ts tests/phase4-llm.test.ts tests/telemetry.test.ts specs/project/architecture.md specs/project/components/skills_llm_telemetry.md specs/project/components/review_pipeline.md`
> Reconcile changed paths against Current state. STOP if Issue 111 has not
> landed, Pi's public stream/event shape no longer matches Current state, or
> the one-repair/cache boundaries changed semantically.

## Execution metadata

- **Priority**: P2
- **Effort**: M (one event-capture helper, the production adapter switch,
  runner/cache/telemetry wiring, generic event-shape tests, and two live
  provider smokes; the post-land corpus is time rather than implementation)
- **Risk**: HIGH (provider boundary and cache trust, mitigated by strict parse,
  equality, fail-closed routing, and no provider wire parsing)
- **Depends on**:
  `specs/plans/111-issue-111-observed-structured-submit-resilience.md`
- **Category**: correctness / observability
- **Planned at**: commit `07434ba`, 2026-08-05

## Why this matters

Pi 0.83.0 uses `parseStreamingJson` for streaming previews and finalized tool
calls. After strict JSON and Pi's narrow string repair fail, that function uses
`partial-json`, which intentionally returns a usable object from incomplete
input. A schema-valid partial prefix can therefore look complete after Pi
deletes its internal scratch buffer.

Codegenie currently calls `Models.complete()` / `completeSimple()` and receives
only that finalized object. Pi's public implementation, however, defines both
completion methods as `stream(...).result()`. The same public stream emits
`toolcall_start`, string `toolcall_delta`, `toolcall_end`, and terminal
`done`/`error` events. Codegenie can consume that stream, retain argument
fragments only in memory for the duration of the call, strictly parse the
assembled representation, and compare it with Pi's final arguments before any
submit schema/semantic validation.

No confirmed Codegenie incident has been attributed to partial final parsing.
That evidence level supports a small permanent fail-closed boundary plus
measurement, not a general self-repair parser or an externally coordinated Pi
change. Untrusted final values use the existing one model repair for submit
calls and are never accepted merely because Pi's partial object passes TypeBox.

## Research decision

| Candidate | Evidence | Decision in this plan |
| --- | --- | --- |
| Pi public `stream()` / `streamSimple()` | `Models.complete()` is exactly `stream(...).result()` and the public event union exposes tool-call framing and string deltas. | Use this Codegenie-side boundary first; preserve the same provider request/options and terminal result semantics. |
| Strict parse plus deep equality | Proves the complete event representation parses as one object and is semantically identical to Pi's finalized arguments. | Required for acceptance. Use Codegenie's parsed value as authoritative after equality succeeds. |
| Pi public `repairJson` | Exported from the package root; escapes raw control characters and invalid backslashes without completing delimiters or values. | Use only after strict parse fails, then run strict `JSON.parse` again and require equality. Record one bounded `pi_narrow_string_repair` kind. |
| Pi `parseStreamingJson` / `partial-json` | Intentionally yields partial values for presentation and is used internally by finalizers. | Never call or accept its output as final provenance in Codegenie. Pi may continue using it for preview state. |
| Provider-adapter fixture matrix | Pi adapters do not all construct deltas identically, but the Codegenie boundary has runtime parse/equality checks. | Do not duplicate every Pi adapter. Test generic event shapes plus the two configured provider smokes; add a targeted adapter fixture only after telemetry or a smoke exposes a real gap. |
| Upstream Pi change | Native provenance remains the ideal shared end state, but no incident or event-fidelity failure currently requires external coordination. | Deferred. Use measurements to support a later additive upstream proposal; delete the app-side accumulator only after equivalent native behavior is released and verified. |
| `jsonrepair`, JSONC, JSON5, streaming completion parsers | Can add closing delimiters or otherwise make truncated data look complete. | Do not add. They can mask semantic loss. |

The ownership boundary for this plan is:

- Pi owns provider wire formats, authentication, normalized public events, and
  its streaming preview objects.
- Codegenie's production Pi adapter owns ephemeral event accumulation, strict
  final parsing, equality against Pi's final value, and the local trusted /
  non-executable submit-call distinction.
- The runner owns submit discipline, TypeBox, stage semantics, the one repair,
  caching, and stage-local disposition.
- Neither layer persists the assembled event text.

## Important event-contract limits

`toolcall_delta.delta` is a normalized public representation, not universally
raw wire text:

- Anthropic Messages, Bedrock, and ordinary OpenAI argument streams forward
  JSON fragments.
- Google/Vertex receive structured argument objects and emit
  `JSON.stringify(arguments)` as one delta.
- Mistral forwards a string when supplied and otherwise stringifies a
  structured argument object.
- OpenAI Responses can replace its internal accumulated buffer with a final
  `arguments` value; when that value is not a suffix, the replacement is not
  emitted as another public delta.
- Grammar/custom-tool paths may emit a synthesized JSON representation of the
  provider's string input.

Therefore the accepted state means “the complete public event representation
strictly parses and equals Pi's final arguments,” not “Codegenie observed raw
provider bytes.” Missing or divergent events fail closed. A normal provider
that emits a non-suffix final replacement may incur one repair until Pi exposes
that replacement publicly; telemetry will make that concrete.

Pi's normalized `message.stopReason === "length"` remains an independent
message-level rejection and takes precedence. Do not reproduce mappings from
provider-specific `rawStopReason` strings in Codegenie. Pi 0.83.0's Google APIs
can overwrite a mapped length result with `toolUse` when a tool call exists;
this known upstream stop-reason limitation is not repaired by interpreting raw
Google values here. The strict/equality boundary still protects malformed
argument syntax, but this plan claims length-stop enforcement only when Pi's
public normalized stop reason is `length`. If a required provider smoke exposes
incorrect normalized length behavior, STOP and report the narrow Pi issue.

## Current state

- `package.json` depends on `@earendil-works/pi-ai ^0.83.0`; no dependency
  change is required by this plan.
- Pi's public `Models.stream()` / `streamSimple()` apply the same auth and
  provider options as completion. `complete()` and `completeSimple()` only
  await the corresponding stream's `result()`.
- Pi's public event union exposes `toolcall_start`, `toolcall_delta` with a
  string `delta`, `toolcall_end`, and terminal `done`/`error` events.
- Pi publicly exports `repairJson`; Codegenie need not copy or fork its narrow
  repair algorithm.
- `src/llm/pi-runner.ts:createRealPiAiAdapter` currently delegates to
  `models.complete` / `completeSimple`. The rest of the runner sees one
  `Promise<PiAssistantMessage>`, so event consumption can remain encapsulated
  inside the production adapter.
- `src/llm/llm-runner.ts:PiToolCall` currently has mandatory `arguments` and no
  provenance or non-executable variant.
- `src/llm/pi-runner.ts` already owns submit selection, repository-tool
  execution, Plan 95's one model-repair scheduler, cache eligibility, and
  Issue 111's stage-local terminal behavior.
- `schemaValidityForResponse` currently considers submit discipline plus
  schema/semantic validity; final provenance must become an earlier validity
  and cache gate.
- `MODEL_CALL_CACHE_SCHEMA_VERSION` is 1. Historical cache entries contain no
  event provenance and cannot be trusted after this boundary lands.
- Pi's validation layer separately clones and coerces argument values before
  TypeBox validation. That semantic-transformation channel is distinct from
  final event completeness and remains out of scope.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Event helper tests | `pnpm exec vitest run tests/final-tool-arguments.test.ts` | all selected tests pass |
| Runner tests | `pnpm exec vitest run tests/phase4-llm.test.ts` | all selected tests pass |
| Telemetry tests | `pnpm exec vitest run tests/telemetry.test.ts` | all selected tests pass |
| Checks | `pnpm run check` | exit 0 |
| Full tests | `pnpm test` | all tests pass |
| Build | `pnpm build` | exit 0 |
| Diff hygiene | `git diff --check` | no output |

## Scope

**In scope**:

- One new `src/llm/final-tool-arguments.ts` helper for public-event
  accumulation, strict/narrow parsing, deep equality, bounded provenance, and
  ephemeral-buffer cleanup.
- `src/llm/llm-runner.ts` and `src/llm/pi-runner.ts` — local trusted/untrusted
  call types, production stream consumption, fail-closed submit routing,
  and existing one-repair integration.
- `src/llm/model-call-cache.ts` — cache schema bump so provenance-less entries
  cannot bypass the boundary.
- Existing telemetry/model-call/run-artifact types only as needed for bounded
  state counts and repair outcomes.
- New focused `tests/final-tool-arguments.test.ts`, existing
  `tests/phase4-llm.test.ts`, `tests/telemetry.test.ts`, and architecture /
  LLM-telemetry / review-pipeline specs.
- Two configured-provider smokes: direct Anthropic Messages and one
  OpenAI-compatible Responses provider.
- Owner measurement and the written evidence-gate result in this plan.

**Out of scope**:

- Any Pi source/dependency change, upstream PR, fork, `pnpm patch`, workspace
  link, tarball, or provider-wire interception.
- Enforcing final provenance on read-only repository investigation tools. They
  have different provider-history and retry semantics, no incident evidence,
  and do not directly become the published review. The event helper may observe
  their framing transiently, but this plan transforms/gates only named stage
  submit calls and preserves today's repository-tool loop unchanged.
- A fixture or live-test matrix for every Pi provider/model. Add another
  targeted fixture only when a required smoke or bounded production telemetry
  demonstrates a distinct event-contract failure.
- `jsonc-parser`, `jsonrepair`, JSON5, missing comma/colon/trailing-comma/comment
  recovery, delimiter completion, scalar completion, or any new syntax repair.
- Reading private Pi scratch fields such as `partialJson` / `partialArgs`,
  serializing Pi's final object as a substitute for event capture, or parsing
  provider-specific `rawStopReason` values.
- Duplicate-submit policy changes, generic repair-prompt redesign, new stage
  normalization, or a second provider/model repair.
- Any change to Pi's TypeBox/JSON-schema value coercion or value-bearing
  coercion telemetry.
- Synthesizing/deleting findings, evidence, paths, anchors, lines, enum values,
  verdicts, revision payloads, coverage entries, strings, or array members.
- Raw accumulated argument text, parser messages, prompts, model output,
  repository snippets, diffs, tool results, validation values, or hashes of
  those values in telemetry, caches, artifacts, errors, or logs.
- Implementing the conditional future design in this plan.

## Git workflow

- Branch: `fix/final-tool-argument-provenance`.
- Keep event capture/types, runner/cache enforcement, and telemetry/docs in
  reviewable logical commits.
- Suggested commit subject:
  `fix(llm): verify final arguments from Pi events`
- Do not modify or publish Pi, push, or open PRs unless the operator asks.

## Steps

### Step 1: Build one loss-aware public-event accumulator

Create `src/llm/final-tool-arguments.ts`. It must depend only on Pi's public
event/types plus public `repairJson`, Node's deep strict equality, and small
local types. Do not import a provider adapter or private Pi path.

Define a bounded result equivalent to:

```ts
type FinalArgumentParse =
  | { state: "strict"; value: Record<string, unknown> }
  | {
      state: "repaired";
      value: Record<string, unknown>;
      repairs: ["pi_narrow_string_repair"];
    }
  | { state: "length_stopped" }
  | { state: "partial"; errorKind: "unexpected_end" | "unterminated" }
  | { state: "invalid"; errorKind: "invalid_syntax" | "non_object_root" }
  | { state: "event_capture_missing" }
  | { state: "event_final_mismatch" };
```

Exact names may follow repository style. States and error kinds must remain
closed unions with no raw parser text or data values.

Implement these invariants:

1. Track each call by public `contentIndex` between `toolcall_start` and
   `toolcall_end`; retain only concatenated `toolcall_delta.delta` strings and
   bounded framing state. Reconcile the completed capture with the end event's
   id/name and the terminal message's call at the same content index. A missing
   start, delta representation, end, or terminal call is
   `event_capture_missing`; ambiguous index/id/name reuse is never guessed.
   Produce provenance only for the adapter-supplied stage submit-tool name.
   Other tool buffers may be held until their end event identifies the name,
   but must then be discarded without parsing or changing the call.
2. Consume through the terminal `done` or `error` event and return the exact
   final assistant message semantics that `.result()` would return. If the
   terminal message has normalized `stopReason: "length"`, mark every captured
   stage submit `length_stopped` before parsing.
3. Otherwise run strict `JSON.parse` on the accumulated representation. Do not
   call `parseStreamingJson` or `partial-json`.
4. If strict parsing fails, call Pi's public `repairJson` once. Only if the
   returned string differs, run strict `JSON.parse` once more. A successful
   second parse is `repaired/pi_narrow_string_repair`; do not reimplement or
   expand Pi's algorithm.
5. Require exactly one non-null, non-array object root. Scalars and arrays are
   `invalid/non_object_root`.
6. Deep-compare the strict/repaired object with the final
   `toolcall_end.toolCall.arguments`. Equality is semantic and key-order
   independent. Divergence is `event_final_mismatch`; never choose either
   object heuristically. When equal, use Codegenie's strict/repaired parsed
   object as the authoritative arguments.
7. Normalize only clear unexpected-end/unterminated `SyntaxError` classes to
   `partial`; everything else is `invalid/invalid_syntax`. Parser messages may
   be inspected transiently for that bounded classification but never returned,
   logged, persisted, or placed in an error context. False-invalid is safe and
   may inform a later classifier plan; false-accept is not.
8. Clear all accumulated strings in `finally` after terminal conversion,
   including error/abort paths. Do not add raw text to the returned message.

Add `tests/final-tool-arguments.test.ts` with synthetic public event sequences,
not provider-adapter replicas. Cover:

- fragmented strict object and one-delta canonical object;
- key-order-different but deeply equal final arguments;
- both narrow repair inputs through public `repairJson`;
- unterminated string/object/array, malformed complete syntax, empty input,
  scalar, and array root;
- missing start/delta/end, duplicate/ambiguous framing, id/name/index mismatch,
  and final semantic mismatch;
- a non-suffix final replacement represented by divergent end arguments;
- normalized length stop with otherwise valid JSON;
- terminal error/abort parity and buffer cleanup;
- seeded credential/repository-like values absent from every returned
  classification and thrown error.

These are event-shape tests. Do not add Anthropic/OpenAI/Google/Mistral fixture
copies here.

**Verify**:
`pnpm exec vitest run tests/final-tool-arguments.test.ts` passes.

### Step 2: Consume Pi streams inside the production adapter without changing call semantics

Keep `PiAiAdapter.complete(...) => Promise<PiAssistantMessage>` as the runner's
single completion boundary. Change only `createRealPiAiAdapter` internally:

1. Extend the adapter-local completion input with an explicit
   `submitToolName`, supplied by `completeWithCache` from the current stage.
   Destructure it before constructing Pi's public `Context`/options; it is
   Codegenie routing metadata and must never be sent to a provider. Pass it to
   Step 1 so only that named call is transformed.
2. Extend `RealPiAiAdapterDeps.models` to expose `stream` and `streamSimple`.
   Forced-tool-choice calls use `models.stream`; ordinary simple calls use
   `models.streamSimple`, with the same prepared model, auth, mapped options,
   signal, headers callback, tool choice, reasoning, session id, cache
   retention, and `maxRetries: 0` currently passed to completion.
3. Replace injected `complete` / `completeSimple` test seams with public-stream
   equivalents, or add a small stream fixture factory. Do not retain a
   production path that returns provenance-less completion messages.
4. Pass the selected stream to Step 1's helper and return its locally typed
   final message. The runner, retry loop, provider-limit wrapper, timeout,
   accounting, and response-header capture remain outside the adapter exactly
   where they are today.
5. Preserve `.result()` terminal semantics: the `done` event returns its
   `message`; the `error` event returns its `error` message so the existing
   `providerFailureFromMessage` logic performs the same retry classification.
   Do not turn normal error events into a new thrown-error class inside the
   adapter.
6. Do not persist or emit intermediate stream events. This is an integrity
   wrapper, not a user-facing streaming feature.

Add integration tests proving that, for the same synthetic stream:

- the adapter returns the same final role/content/provider/model/usage/
  stopReason/error fields as `.result()` except for bounded local call
  provenance and authoritative equal arguments;
- forced and simple branches choose `stream` and `streamSimple` respectively;
- only the explicit submit-tool name is transformed; repository calls remain
  byte-for-byte unchanged and the private name is absent from provider input;
- request options, auth preparation, response callback, abort signal, and tool
  choice are unchanged;
- provider error, abort, timeout, retry, usage, and budget behavior remain
  byte-for-byte equivalent at the runner boundary;
- no extra provider request is created by event consumption.

**Verify**:
`pnpm exec vitest run tests/final-tool-arguments.test.ts tests/phase4-llm.test.ts`
passes.

### Step 3: Make untrusted submit arguments non-executable and reuse existing recovery

In `src/llm/llm-runner.ts`, represent the adapter's output as a discriminated
local union:

```ts
type PiTrustedSubmitCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  argumentParse: { state: "strict" | "repaired"; repairs?: string[] };
};

type PiUntrustedSubmitCall = {
  type: "invalidToolCall";
  id: string;
  name: string;
  argumentParse: Exclude<FinalArgumentParse, { state: "strict" | "repaired" }>;
};
```

The untrusted submit variant has no `arguments`. Never manufacture `{}`. The
exact types may be factored differently, but an untrusted stage submit must be
unrepresentable as an executable/validatable call inside Codegenie. Ordinary
repository tool calls retain their current Pi type and behavior.

Wire the runner with these rules:

1. Existing submit-call discipline counts both trusted and untrusted named
   calls by id/name, so an invalid selected submit cannot masquerade as a
   missing submit. Preserve Stage 5/10 exact-cardinality and Stage 7-9 existing
   first-submit/drop behavior.
2. A trusted submit proceeds to the unchanged TypeBox and Issue 111 semantic
   gates. Provenance never substitutes for either validation.
3. An untrusted primary submit enters Plan 95's existing single model-repair
   scheduler with one bounded classification:
   `length_stopped`, `final_arguments_partial`, `final_arguments_invalid`,
   `event_capture_missing`, or `event_final_mismatch`. Repair metadata may
   carry id/name/state but no arguments. Do not invoke a deterministic submit
   normalizer on an untrusted call.
4. An untrusted repaired submit follows Issue 111's existing stage-local
   terminal disposition. Never dispatch a second repair.
5. Do not append an assistant message containing `invalidToolCall` to the Pi
   provider conversation. Route an untrusted submit through the existing
   stateless/replace-conversation repair seam using only bounded id/name/state
   metadata and the submit schema. The invalid assistant payload and event text
   are discarded before the next provider call, so Pi never has to serialize a
   Codegenie-local content variant.
6. Apply the same submit provenance gate inside
   `schemaValidityForResponse`. A selected untrusted/provenance-less submit is
   invalid and not cacheable.
7. Bump `MODEL_CALL_CACHE_SCHEMA_VERSION`. Historical messages without
   provenance become cache misses. Cached trusted messages retain only the
   bounded provenance plus the already-persisted validated argument object;
   untrusted messages are never written.
8. Update test helpers/fake adapters to return explicit strict provenance for
   valid tool calls. Missing provenance is rejected in production and tests;
   do not add a permissive compatibility capability or accepted `unknown`.

Precedence is explicit:

- normalized message `stopReason: "length"` wins first and makes every named
  stage submit in that message untrusted;
- otherwise existing submit discipline/selection runs unchanged;
- provenance gates only the call selected by that existing policy;
- TypeBox and Issue 111 semantics run only after trusted provenance;
- repair remains capped at one.

Tests must cover every state on primary and repaired submits, schema failure
after strict provenance, semantic failure after strict provenance, stateless
repair history that contains neither the invalid local call nor its arguments,
every stage-local terminal disposition, no cache write for untrusted responses,
old-cache miss, unchanged repository-tool behavior, and preservation of
duplicate-submit behavior.

**Verify**: `pnpm exec vitest run tests/phase4-llm.test.ts` passes.

### Step 4: Measure bounded outcomes without storing event text

Extend existing model-call telemetry rather than creating a parallel raw log.

1. Record one bounded final-argument state for the submit selected by Step 3:
   `strict`, `repaired`, `partial`, `invalid`, `length_stopped`,
   `event_capture_missing`, or `event_final_mismatch`. A response with no named
   submit remains existing `missing_submit`, not capture-missing.
2. For `repaired`, record only `pi_narrow_string_repair`; for partial/invalid,
   record only bounded error kind. Include stage, role, submit tool, provider,
   model-call attempt kind, and one bounded correlation id.
3. Add summary counters for states, error kinds, and outcomes. Strict calls need
   no warning event; emit a warning only when Codegenie rejects a selected
   submit value.
4. When the one submit repair resolves, emit one bounded outcome referencing
   the original correlation id: `recovered`, `terminal_invalid`, or
   `not_dispatched`. Do not mutate the earlier model-call record.
5. Preserve all existing schema-recovery counters and meanings. Event
   provenance is an earlier trust dimension, not schema validity.
6. Never persist event text, final parser messages, argument values beyond the
   existing trusted cached call, or hashes of those values. Seed secret-like
   and repository-like strings in tests and scan events, model-call summaries,
   errors, debug artifacts, and run artifacts for absence.

Telemetry is also the trigger for extra targeted adapter work: if a provider
not in the two live smokes records `event_capture_missing` or
`event_final_mismatch`, reproduce only that public event shape in one focused
regression. Do not pre-build a provider matrix.

**Verify**:
`pnpm exec vitest run tests/final-tool-arguments.test.ts tests/phase4-llm.test.ts tests/telemetry.test.ts`
passes.

### Step 5: Document, run the two provider smokes, and measure post-land

Document these invariants:

- Pi may use partial parsing for streaming presentation, but Codegenie accepts
  a final call only after strict/narrow parse plus deep equality over the
  complete public event representation;
- public event representations may be raw fragments or provider-neutral
  canonical JSON; Codegenie never parses provider wire formats;
- untrusted submits are non-executable, use the existing stateless submit
  repair, and are never cached;
- normalized length stop wins, but Codegenie does not reinterpret
  provider-specific raw stop reasons;
- no accumulated event text crosses into telemetry, cache, artifacts, or logs;
- broader syntax repair and upstream migration remain measurement-gated.

Run full Codegenie checks. Then run only these configured-provider smokes:

1. Direct Anthropic Messages.
2. One OpenAI-compatible Responses provider used by the project.

For each, a normal structured submit must produce complete framing,
`strict` or current narrow `repaired` provenance, deep equality, unchanged
usage/stop reason, and zero extra calls. Synthetic stream tests—not live fault
requests—cover missing/mismatched/partial/length cases.

Do not add live or copied fixtures for Google, Mistral, Bedrock, OpenAI
Completions, or every provider wrapper at this gate. The runtime boundary is
fail-closed; add one only after evidence identifies a distinct gap.

The implementation gate is:

- all generic event-shape and stream/completion parity tests pass;
- both live normal-provider smokes are trusted without repair;
- zero accepted untrusted or provenance-less submits;
- zero extra provider calls on trusted finals;
- zero raw/value-bearing telemetry or artifacts.

If either required normal smoke lacks complete event data or produces an
event/final mismatch, STOP rather than adding a provider exception or accepting
Pi's final object. Report the exact bounded state and evaluate a narrow
upstream event-contract fix.

Once this gate passes, land the implementation and update the README row to
`IMPLEMENTED (measuring)`. The following corpus is post-land and must not hold
the implementation PR open:

- at least 2,500 non-cache-hit primary finalized structured submits (the
  terminal submit selected from the original stage request, before model
  repair; tool continuations, missing-submit responses, and repair responses
  are excluded);
- at least 20 completed runs spanning `49f4645b`, `0c4d5213`, and `relay-wc`;
- at least two provider API families and at least 500 qualifying submits from
  each family;
- synthetic fixtures and model-repair responses do not count.

Record totals by provenance state, repair kind, stage, provider API family,
model-repair outcome, and terminal disposition in this plan. Record no payload
examples. If real usage cannot satisfy the provider mix, leave the plan
`IMPLEMENTED (measuring)` and request an explicit plan revision; do not silently
lower or waive the denominator.

Apply the broader-repair evidence gate after human review. Open a new numbered
classifier-and-remeasurement plan only when complete `invalid` syntax,
excluding `partial`, `length_stopped`, capture-missing, and final-mismatch,
meets either trigger:

1. At least 10 occurrences and at least 0.25% of qualifying primary final
   submits, with one bounded error class occurring at least five times; or
2. The same bounded complete-syntax class causes at least three terminal
   degradations after the existing model repair.

Current narrow repairs do not trigger a larger parser. Capture missing/mismatch
is an event-contract issue, not a JSON-repair opportunity. A broad
`invalid_syntax` count can authorize only a classifier-and-remeasurement plan,
not repair implementation.

If neither syntax trigger fires, record “full loss-aware repair parser not
needed.” If one fires, open only the bounded follow-up described below. In
either case, record the human-reviewed result and mark Issue 112 `COMPLETE`;
the new numbered plan owns any follow-up.

Separately, summarize event-capture missing/mismatch and terminal impact. These
counts may support an additive upstream Pi provenance proposal. An upstream PR
is not an automatic requirement and must not be bundled with a syntax-repair
plan.

**Verify the implementation gate**: `pnpm run check`, `pnpm test`,
`pnpm build`, both provider smokes, and `git diff --check` pass.

**Verify measurement closure**: the corpus satisfies every denominator rule,
contains no synthetic/repair submits, records a human-reviewed gate outcome,
and contains no payload examples.

## Conditional future design — not authorized by this plan

If and only if the classifier/remeasurement follow-up identifies a refined
complete-input syntax subtype that independently passes the gate, a later
repair plan must remain limited to that evidenced class:

- operate in the isolated earliest-captured-text helper, never in stage code;
- prove one complete root with closed strings/numbers and balanced delimiters
  before any tolerant transformation;
- use an operation ledger and deep-equality assertions proving no semantic
  leaf or array member was added, removed, truncated, or guessed;
- rerun event/final equality, TypeBox, and stage semantics after repair;
- use the existing one model repair for missing fields, wrong types/enums,
  truncation, divergence, and ambiguous transformations;
- never accept `partial-json`, delimiter auto-closing, scalar completion, or
  capture-missing/final-mismatch as repairable JSON;
- kill/revert the future implementation if it accepts partial/length input,
  mutates data, regresses an owner eval, or removes fewer than half of the
  targeted repair calls in its validation corpus.

An upstream Pi migration is a separate possible success path. If Pi later
releases native bounded final provenance, first run A/B fixtures proving its
states and accepted values are at least as strict as this helper. Then delete
the Codegenie accumulator in the same migration; do not retain two authorities.

## Test plan summary

- `tests/final-tool-arguments.test.ts`: generic public-event framing, strict /
  narrow parsing, equality, mismatch/missing, length, error parity, cleanup,
  and payload absence.
- `tests/phase4-llm.test.ts`: production stream selection/parity, trusted and
  non-executable submit routing, stateless one repair, cache protection,
  unchanged repository-tool behavior, and stage-local terminal behavior.
- `tests/telemetry.test.ts`: bounded states/outcomes and strict absence of event
  text/values.
- Live gates: one normal Anthropic Messages submit and one normal
  OpenAI-compatible Responses submit; no full provider matrix.
- Full Codegenie checks/tests/build plus owner measurement corpus.

## Done criteria

- [ ] The production adapter consumes Pi's public stream while preserving the
      existing completion request/options/result/error semantics.
- [ ] Final accepted submit arguments come only from strict JSON or Pi's public
      narrow repair, require one object root, and deep-equal Pi's final
      arguments.
- [ ] Missing/divergent/partial/invalid/normalized-length-stopped calls are
      represented as local submit calls without `arguments` and cannot enter
      submit validation.
- [ ] Untrusted submits consume at most the existing one repair and then use
      Issue 111's stage-local disposition; invalid assistant data is not sent
      back to Pi in repair history.
- [ ] Untrusted/provenance-less responses are never cached and the cache schema
      version is bumped.
- [ ] Telemetry records only bounded states/counts/outcomes and no accumulated
      text, parser messages, values, or value hashes.
- [ ] Generic event-shape/parity tests and the two required provider smokes
      pass; no every-provider fixture matrix was added.
- [ ] Full checks/tests/build pass and the README row moves to
      `IMPLEMENTED (measuring)` without waiting for the corpus.
- [ ] Post-land, the minimum corpus and human-reviewed gate outcome are
      recorded; the README row then moves to `COMPLETE`.
- [ ] No Pi change, broad parser, provider-wire parser, duplicate-submit
      change, second model repair, or generic repair-prompt redesign landed.
- [ ] Specs and README status are updated.

## STOP conditions

Stop and report; do not improvise if any occurs:

- Pi's public `complete` methods are no longer equivalent to consuming the
  corresponding stream result, or required public event framing/deltas are
  unavailable.
- A required normal Anthropic/OpenAI Responses smoke yields missing/divergent
  event capture, extra provider calls, changed usage/error/timeout behavior, or
  an incorrectly normalized length stop.
- Trustworthy capture requires private Pi scratch fields, provider wire
  formats, provider-specific raw stop-reason mappings, or serializing Pi's
  final object as the event source.
- Pi's public `repairJson` is unavailable or expands beyond the two narrow
  string repairs.
- An untrusted submit would need an `arguments` placeholder, could reach
  TypeBox, could re-enter Pi conversation history, or could enter the
  model-call cache.
- Rejecting an untrusted submit cannot use the existing one-repair and
  stage-local disposition paths.
- Event accumulation would need persistence, logging, hashing, or inclusion in
  error context to work.
- A provider-specific exception or broad adapter fixture matrix appears
  necessary without bounded smoke/telemetry evidence.
- Provider/owner gates regress, or focused tests fail twice after a reasonable
  correction.

## Maintenance notes

- `strict` means strict parsing of the complete public event representation
  plus equality with Pi's final value; it does not claim raw-wire capture.
- Runtime equality makes event-contract drift fail closed. A new provider
  fixture is justified only after a smoke or telemetry identifies a distinct
  missing/mismatch shape.
- Review Pi dependency upgrades for changes to event framing, `repairJson`,
  completion-vs-stream equivalence, and stop-reason normalization.
- Pi's Google stop-reason overwrite and pre-validation primitive coercion are
  separate semantic trust channels. Do not quietly absorb either into this
  plan.
- Safe narrow-repair counts measure existing behavior, not evidence for a
  broader parser.
- Keep the corpus denominator/provider mix with the recorded result so later
  measurements remain comparable.
