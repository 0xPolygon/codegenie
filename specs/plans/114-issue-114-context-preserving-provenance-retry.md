# Issue 114: Re-execute Untrusted Structured Submits From Trusted Context

Status: COMPLETE
Planned from: Codegenie self-review GitHub Actions run `31021166634`
(Codegenie v0.5.4 reviewing `ae1bb70..803bf6f`) and cold source/spec
validation at current branch HEAD, 2026-08-05
Planned at: commit `fdeb767` (branch `llm-repair`)
Recommended priority: before the 0.5.5 release. This plan fixes one
release-blocking continuation defect in Issue 112, then closes a bounded set
of already-confirmed one-line/test-contract gaps in the same branch. It does
not add a new mechanism, telemetry field, parser, or stage-specific matrix.

> **Executor instructions**: Read this plan completely before changing code.
> Implement the smallest generic correction in the existing one-repair seam:
> reject and discard the untrusted assistant response exactly as today, retain
> the structurally valid conversation that preceded it, append the existing
> bounded stage repair instruction, and make the one forced-submit retry. Do
> not inspect, infer from, salvage, log, hash, cache, or resend rejected final
> arguments. Run every verification command. If a STOP condition occurs, stop
> and report rather than broadening the fix. Update this plan and its row in
> `specs/plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat fdeb767..HEAD -- package.json pnpm-lock.yaml src/llm/pi-runner.ts src/llm/final-tool-arguments.ts src/pipeline/planner.ts src/pipeline/verifier.ts src/pipeline/composer.ts src/output/markdown-renderer.ts src/telemetry/run-artifacts.ts src/github-action/entrypoint.ts action.yml tests/phase4-llm.test.ts tests/final-tool-arguments.test.ts tests/telemetry.test.ts tests/github-action.test.ts tests/pipeline-phase5.test.ts specs/plans/112-issue-112-final-tool-argument-provenance.md specs/project/architecture.md specs/project/components/skills_llm_telemetry.md specs/plans/README.md`
> Reconcile every Current state statement if a listed path changed. The
> planner/verifier/composer and Pi dependency files are read-only drift inputs,
> not authorized modification targets. STOP if the one-repair scheduler,
> non-executable call representation, Pi 0.83.0 public event/error contract,
> or stage-local terminal policies changed semantically.

## Execution metadata

- **Priority**: P1
- **Effort**: S-M
- **Risk**: MED (one shared runner continuation changes, with a narrow
  parameterized regression and unchanged provider/schema/cache boundaries)
- **Depends on**:
  `specs/plans/111-issue-111-observed-structured-submit-resilience.md` and
  `specs/plans/112-issue-112-final-tool-argument-provenance.md`, both already
  implemented on this branch
- **Category**: correctness / trust-boundary follow-up / telemetry / tests
- **Planned at**: commit `fdeb767`, 2026-08-05

## Why this matters

Issue 112 correctly turns a partial, invalid, length-stopped, capture-missing,
or event-divergent named submit into a local `invalidToolCall` without
`arguments`. The runner does not append that assistant response to Pi history,
does not validate or execute the submit, and does not cache the response. These
are the required fail-closed guarantees and must remain unchanged.

The retry currently discards independently trusted information too. The
untrusted path forces `replaceConversationOverride: true`, so
`queueSchemaRepair()` replaces the original stage request and any earlier valid
tool history with a repair message. A Stage-7 retry then sees a submit schema
but not the packet or diff it must review. It can return schema-valid
`findings: []` without doing an informed review, allowing known response loss
to look like a clean packet result. Planner, verifier, and composer provenance
failures have the same stage-generic problem.

The fix is a clean stage re-execution, not JSON repair. The invalid assistant
turn remains absent, while the trusted pre-response conversation remains. The
existing bounded repair message is appended and the existing one forced-submit
retry runs. If that retry fails, Issue 111's current planner fallback, packet
incompleteness, verifier suppression, or composer fallback remains the final
authority.

The same self-review confirmed two tiny consistency defects and four weak
regression assertions. They do not justify separate architecture or separate
plans: cache replays inflate the aggregate provenance histogram, the Action's
terminal-post path bypasses its bounded error-code helper, and existing tests
do not structurally pin failure-artifact upload, both event/final equality
clauses, telemetry provenance shape, or complete-degraded rendering. Fixing
those now is reasonable because each change is local, deterministic, and adds
no behavior policy. New telemetry fields and planner/verifier/composer test
matrices remain unnecessary.

## Current state

### The trusted prefix already exists

`src/llm/pi-runner.ts:267-269` initializes the provider conversation with the
stage request:

```ts
const messages: ConversationMessage[] = [
  { role: "user", content: request.prompt, timestamp: 0 }
];
```

Successful investigation rounds append structurally valid assistant tool calls
and deterministic tool results. At `src/llm/pi-runner.ts:404-410`, the runner
does not append an assistant message containing a local `invalidToolCall`.
Therefore `messages` still contains the valid pre-response conversation when a
provenance-invalid submit is rejected.

At `src/llm/pi-runner.ts:435-449`, the untrusted submit path schedules repair
with `replaceConversationOverride: true` and immediately `continue`s. That
`continue` happens before repository tools from the same assistant response
could execute, so mixed invalid-submit/tool turns currently produce no orphaned
`toolResult`. Preserve that ordering.

### Explicit false is currently dropped

The local scheduler accepts `replaceConversationOverride?: boolean`, but two
forwarding sites preserve only literal `true`:

- `src/llm/pi-runner.ts:302` forwards the local scheduler input with
  `repair.replaceConversationOverride === true`.
- `src/llm/pi-runner.ts:539` forwards recovery guidance with
  `recovery.replaceConversationOverride === true`.

At `src/llm/pi-runner.ts:2519`, `queueSchemaRepair()` already implements the
required tri-state behavior:

```ts
const replaceConversation = input.replaceConversationOverride ??
  (input.request.schemaRepair?.replaceConversation === true);
```

An explicit `false` must reach this expression. Merely deleting the untrusted
path's current `true` is insufficient because planner, verifier, composer, and
some tests configure ordinary schema repair with `replaceConversation: true`.

### Existing repair prompts remain the authority

Do not add another prompt builder or mode. Keep the current selection order:

1. trusted Stage-7 compact schema repair when its current classification and
   replacement conditions hold;
2. the stage's existing `schemaRepair.buildPrompt`, when provided; otherwise
3. `defaultSchemaRepairPrompt()`.

Those stage builders remain meaningful with `repairInput.submitCalls: []`:

- `src/pipeline/planner.ts:675-750` uses the independently trusted planner
  dossier/hunk inventory; only its invalid-submission list is empty.
- `src/pipeline/verifier.ts:945-980` uses the independently trusted candidate
  projection and explicit provenance classification. Its wrapper also owns
  verifier repair-attempt telemetry.
- `src/pipeline/composer.ts:546-590` uses the independently trusted verified
  finding groups and known ids.
- Production Stage 7 supplies no custom builder, so it uses the bounded default
  repair instruction appended after the original packet prompt/tool history.

The stage-specific prompts can repeat some trusted context after this change.
That is acceptable on the rare provenance-repair path and is safer than
creating a second prompt policy. Existing per-call token telemetry can reveal
material cost if it ever becomes frequent.

### The current test encodes the defect

`tests/phase4-llm.test.ts:2049-2107` covers all five untrusted states but calls
the path “stateless repair” and asserts that the second provider request does
not contain the original Stage-7 prompt. It also already captures the
`schema_repair_scheduled` event, whose bounded data includes
`replaceConversation`. This is the primary regression to reverse.

### Confirmed mechanical hardening

- `src/telemetry/run-artifacts.ts:845-869` already assigns cache hits
  `providerCallCount = 0`, but increments `finalArgumentStates` and
  `finalArgumentErrorKinds` outside that guard. Raw cache-hit records should
  remain; only provider-call aggregates should exclude them.
- `src/github-action/entrypoint.ts:438-440` intentionally maps arbitrary
  non-`CodegenieError` failures to `unknown_error`. The main failure path uses
  it; `src/github-action/entrypoint.ts:229-233` still publishes `Error.name` for
  terminal-post failures.
- `tests/telemetry.test.ts:720-779` asserts that two strings are absent even
  though neither enters the system under test. Parsed record/summary shape is
  the correct assertion surface; raw-delta removal is already exercised in
  `tests/final-tool-arguments.test.ts`.
- `tests/github-action.test.ts:1137-1143` searches three independent raw YAML
  substrings instead of binding the failure path and `always()` guard to the
  parsed upload step.
- `tests/final-tool-arguments.test.ts:84-91` makes both deep-equality clauses
  fail in one fixture, so neither clause is independently protected.
- `tests/pipeline-phase5.test.ts:6621-6646` asserts a fixture field that the
  test itself set instead of asserting complete-degraded output language.

## Required behavior

All requirements are load-bearing:

1. **Reject bad data unchanged.** The untrusted selected submit has no
   `arguments`; its assistant response and accumulated event text never enter
   provider history, cache, validation, telemetry, logs, or artifacts.
2. **Preserve the prior conversation.** The retry receives the original stage
   prompt plus any earlier valid assistant tool calls and deterministic tool
   results. It never receives the rejected assistant turn.
3. **Append existing bounded guidance.** The current stage-specific/default
   builder receives the same bounded classification and untrusted-call
   id/name/state metadata as today, with `submitCalls: []`. No rejected
   argument value is synthesized or supplied.
4. **Keep one forced-submit retry.** Reuse `queueSchemaRepair`; do not add a
   loop, provider retry, repository-tool round, or special Stage-7 second pass.
5. **Discard a mixed invalid turn atomically.** If the same response contains
   valid repository calls and an untrusted named submit, execute none of those
   repository calls and push no results. Schedule only the submit retry.
6. **Keep trusted repairs unchanged.** Trusted schema-invalid Stage-7 compact
   repair, planner/verifier/composer deterministic recovery, semantic
   validation, and terminal stage policies retain their current replacement /
   fallback behavior.
7. **Keep candidate tracking trusted.** Do not read or infer from discarded
   arguments to arm `candidateDrafted`. A context-complete successful redo may
   legitimately return no findings.
8. **No version or provider work.** Do not change schemas, prompt template
   versions, cache schema/version, Pi, provider adapters, or parsing tolerance.
9. **Provider-call aggregates exclude cache replay.** Keep raw cache-hit model
   records and cache counts, but do not count their final-argument state/error
   in provider-call histograms.
10. **Public Action identity stays bounded.** Both failure paths use the same
    `actionErrorCode()` allowlist; arbitrary `Error.name` is not restored.
11. **Test hardening changes no production policy.** Bind tests to the parsed
    Action step, each equality predicate, persisted bounded provenance shape,
    and rendered review language. Do not alter correct production behavior to
    satisfy a test.

## Scope

**Production source in scope**:

- `src/llm/pi-runner.ts`
- `src/telemetry/run-artifacts.ts`
- `src/github-action/entrypoint.ts`

**Test source in scope**:

- `tests/phase4-llm.test.ts`
- `tests/final-tool-arguments.test.ts`
- `tests/telemetry.test.ts`
- `tests/github-action.test.ts`
- `tests/pipeline-phase5.test.ts`

**Contract/status documentation in scope**:

- `specs/plans/112-issue-112-final-tool-argument-provenance.md`
- `specs/plans/114-issue-114-context-preserving-provenance-retry.md`
- `specs/plans/README.md`
- `specs/project/architecture.md`
- `specs/project/components/skills_llm_telemetry.md`

**Read-only drift inputs**:

- `package.json` and `pnpm-lock.yaml`
- `src/pipeline/planner.ts`
- `src/pipeline/verifier.ts`
- `src/pipeline/composer.ts`
- `src/llm/final-tool-arguments.ts`
- `src/output/markdown-renderer.ts`

**Explicitly out of scope**:

- `src/llm/final-tool-arguments.ts`: strict/narrow parsing, deep equality,
  Pi terminal `error` handling, and the argument-less invalid-call shape are
  already correct.
- `src/llm/stage7-submit-repair.ts`: trusted schema-invalid compact repair is
  separate and remains correct.
- `src/pipeline/verifier.ts`: do not alter `candidateDrafted`, verdict policy,
  or empty-submit classification.
- `action.yml`: current failure-artifact wiring is correct. It is a read-only
  test input; do not edit it to make the structural assertion pass.
- `src/output/markdown-renderer.ts`: current behavior is correct. Strengthen
  its test without changing production.
- New telemetry for the deferred question of how often a provenance-lost
  Stage-7 retry later returns no findings. Existing
  `final_argument_repair_outcome` and `packet_review_no_findings` events share
  worker/packet identity and can be analyzed if evidence later justifies a
  publication-policy plan.
- Plan 113, tolerant JSON repair, provider-specific handling, Pi changes,
  retry-budget changes, selection, verification, or publication policy.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Focused runner test | `pnpm exec vitest run tests/phase4-llm.test.ts` | exit 0; all tests pass |
| Focused hardening tests | `pnpm exec vitest run tests/final-tool-arguments.test.ts tests/telemetry.test.ts tests/github-action.test.ts tests/pipeline-phase5.test.ts` | exit 0; all tests pass |
| Type and workflow checks | `pnpm run check` | exit 0; no TypeScript or workflow errors |
| Full tests | `pnpm test` | exit 0; all tests pass |
| Build | `pnpm build` | exit 0 |
| Patch hygiene | `git diff --check` | exit 0; no output |
| Owner regression smoke | `pnpm dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/49f4645b --no-cache` | required expectation holds and coverage/publication remains truthful |

The focused baseline at plan time was green. The changed provenance-context
assertion may fail before the production edit and must pass afterward.

## Implementation steps

### Step 1: Preserve an explicit append override through the repair seam

In `src/llm/pi-runner.ts`:

1. At both boolean forwarding sites, include
   `replaceConversationOverride` whenever it is `!== undefined`, preserving
   both `true` and `false`.
2. In the untrusted selected-submit branch, pass
   `replaceConversationOverride: false`.
3. Do not otherwise change `queueSchemaRepair()`. Its existing nullish
   fallback will now choose append mode for this path.
4. Do not push or sanitize the invalid assistant response. Preserve the
   existing immediate `continue` before repository execution.
5. Keep the prompt-selection order, `forceFinalize`, one-repair accounting,
   correlation/outcome telemetry, cache rejection, and terminal error handling
   unchanged.

This must be a small runner diff. If implementation appears to require a new
request type, retry abstraction, prompt builder, state flag, or stage branch,
STOP and re-read the existing optional boolean seam before proceeding.

### Step 2: Replace the defective assertion with direct boundary regressions

Update `tests/phase4-llm.test.ts`:

1. Revise the existing parameterized test for all five untrusted states:
   `length_stopped`, `partial`, `invalid`, `event_capture_missing`, and
   `event_final_mismatch`.
2. Configure `schemaRepair.replaceConversation: true` in the fixture so the
   test proves explicit `false` overrides a stage's normal replacement policy.
3. Assert the second provider context:
   - contains the original stage prompt;
   - contains the bounded repair builder output/classification;
   - contains neither the local `invalidToolCall` nor rejected argument data.
4. Assert exactly two provider calls, one repair, no cache write for the
   rejected primary, the existing bounded repair outcome, and
   `schema_repair_scheduled.data.replaceConversation === false`.
5. Add one mixed-turn negative control: the primary response contains a valid
   repository call plus an untrusted selected submit. Assert that the
   repository executor is not called, no `toolResult` appears in the retry
   context, the invalid assistant turn is absent, and the original trusted
   request remains.
6. Preserve the existing tests in which the repair is also untrusted,
   dispatch is budget-blocked, a provenance-less cache entry is rejected, and
   normal trusted submits remain byte-for-byte unaffected.

The custom builder used by the parameterized fixture is sufficient to prove
that append mode still invokes the stage builder with bounded metadata. Do not
add separate planner/verifier/composer test matrices: their builder selection
does not change, their source inputs are independently trusted, and existing
tests already cover their prompt-specific behavior.

**Verify**:

`pnpm exec vitest run tests/phase4-llm.test.ts`

Expected: exit 0; every provenance state keeps trusted context, no rejected
assistant data returns, the mixed turn executes no tool, and existing terminal
and cache protections pass.

### Step 3: Apply the confirmed mechanical hardening

Make only these bounded changes:

1. In `RunTelemetryImpl.updateModelSummary()` in
   `src/telemetry/run-artifacts.ts`, increment `finalArgumentStates` and
   `finalArgumentErrorKinds` only when `providerCallCount > 0`. Preserve the
   raw cache-hit record, `totalRecords`, cache counters, and all existing
   token/cost/finalize semantics. In `tests/telemetry.test.ts`, add a cache-hit
   provenance record and prove it remains in `model-calls.jsonl` but not the
   aggregate histograms. Replace the never-seeded string assertions with
   assertions over parsed bounded provenance fields. Do not add a telemetry
   field.
2. In the `terminal_post_failed` catch in
   `src/github-action/entrypoint.ts`, call `actionErrorCode(error)` just like
   the main failure path. Extend the Action test seam with a plain `TypeError`
   terminal-update failure and assert the action record uses `unknown_error`
   without publishing its message/name. Preserve the existing typed
   `github_post_failed` case.
3. In the parsed `action.yml` test, find the run step and upload-artifact step.
   Read the exact `CODEGENIE_FAILURE_PATH` value from the run step, assert that
   value occurs in the upload step's `with.path`, and assert that same upload
   step's `if` contains `always()`. Remove the three unrelated substring
   assertions. Do not edit `action.yml`.
4. Split the event/final mismatch fixture into end-event-only divergence and
   terminal-message-only divergence. Each must yield an argument-less
   `invalidToolCall` with `event_final_mismatch`. Do not change
   `src/llm/final-tool-arguments.ts`.
5. Replace the degraded-planning fixture assertion with rendered output
   assertions: the degraded banner precedes the summary,
   `## ✅ No Findings` appears, and partial/incomplete wording does not. Keep
   the sibling partial test that forbids approval-equivalent clean language.
   Do not change the renderer.

Do not add new measurement assertions linking packet publication, any new
telemetry field, or separate planner/verifier/composer matrices. Those are not
needed to close the confirmed gaps above.

**Verify**:

`pnpm exec vitest run tests/final-tool-arguments.test.ts tests/telemetry.test.ts tests/github-action.test.ts tests/pipeline-phase5.test.ts`

Expected: exit 0; cache aggregates exclude hits, public failure identity is
bounded consistently, and every strengthened test is bound to its real
contract.

### Step 4: Correct the standing trust-boundary documentation

Update only the stale contract language:

- In `specs/plans/112-issue-112-final-tool-argument-provenance.md`, supersede
  the statement that an untrusted submit uses schema-only stateless /
  replace-conversation repair. State that the invalid assistant response and
  its arguments are discarded while the independently constructed prior
  conversation is retained for one clean re-execution. Link Issue 114 and keep
  Issue 112 `IMPLEMENTED (measuring)` until its existing corpus closes.
- Make the same narrow correction in `specs/project/architecture.md` and
  `specs/project/components/skills_llm_telemetry.md`. Preserve the rule that an
  untrusted assistant response never enters provider history or cache.
- Note that the rare repair can consume more input tokens because trusted
  context is resent. Existing per-call telemetry is sufficient; add no cost
  mechanism or field.
- Document that final-argument state/error aggregates count provider calls and
  exclude cache hits; the Plan-112 corpus still filters primary non-cache-hit
  records explicitly.
- Mark Plan 114 `COMPLETE` in this file and `specs/plans/README.md` only after
  Step 5 passes.

Do not revise unrelated Plan-112 measurement, parser, cache, or provider text.

**Verify**:

`rg -n "stateless model repair|always replace conversation history|schema-only" specs/plans/112-issue-112-final-tool-argument-provenance.md specs/project/architecture.md specs/project/components/skills_llm_telemetry.md`

Expected: no standing claim that provenance-invalid retries discard the
trusted request context. Historical wording may remain only when immediately
identified as superseded by Issue 114.

### Step 5: Run release validation

Run, in order:

1. `pnpm run check`
2. `pnpm test`
3. `pnpm build`
4. `git diff --check`
5. `pnpm dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/49f4645b --no-cache`

Inspect the owner smoke rather than relying only on its score:

- the required finding remains present;
- coverage/publication is complete or explicitly partial;
- ordinary strict submits do not schedule new repairs;
- no extra provider call or repository-tool round was introduced; and
- any naturally occurring provenance repair uses one context-preserving retry
  and then the existing stage-local disposition.

The deterministic tests, not stochastic occurrence in the owner smoke, prove
the malformed-submit path. The owner smoke guards broader review quality. If
credentials or the private eval repository are unavailable, leave Plan 114
`PENDING (owner smoke required)` after local checks and report the external
gate.

### Implementation evidence (2026-08-05)

- The runner change preserves explicit `false` through both repair-forwarding
  layers and selects append mode only for an untrusted final submit. The
  invalid assistant turn remains discarded before repository-tool execution,
  validation, history, and cache.
- The five focused files pass 451 tests. The parameterized runner regression
  covers every untrusted provenance state with a stage-level replacement
  policy enabled, and the mixed-turn negative control proves that a repository
  call beside an invalid submit is neither executed nor orphaned.
- Cache-hit provenance remains in `model-calls.jsonl` and cache counts while
  provider-call state/error histograms exclude it. Both Action terminal paths
  use the bounded error-code helper, and the Action YAML, divergence, bounded
  telemetry shape, and degraded-rendering contracts have structural tests.
- `pnpm run check`, the full 843-test suite, `pnpm build`, and
  `git diff --check` pass.
- Owner eval `49f4645b` run 65 passed 1/1 required expectations with one inline
  finding, complete coverage, zero budget overruns, and zero loss before
  candidate generation, verification, or composition. It recorded 12 strict
  final submits, zero schema-invalid calls, and zero repair calls, so no
  malformed submit occurred naturally. Relative to run 64 it used 28 provider
  calls instead of 38 and 61 tool calls instead of 69; deterministic tests,
  not this stochastic delta, prove the repaired path.

## Done criteria

- [x] An untrusted selected submit remains argument-less, non-executable,
      uncached, and absent from provider history.
- [x] Its one retry retains the valid pre-response conversation and appends
      only the existing bounded stage repair instruction.
- [x] Explicit `replaceConversationOverride: false` survives both forwarding
      layers and overrides stage-level `replaceConversation: true`.
- [x] A mixed invalid-submit/repository-tool response executes no repository
      call and produces no orphaned result.
- [x] All five provenance-invalid states, repaired-submit failure, cache
      rejection, and normal trusted submit paths pass focused tests.
- [x] Trusted Stage-7 compact repair, stage builders, candidate tracking,
      retry count, schemas, prompt/cache versions, provider behavior, and
      terminal policies remain unchanged.
- [x] Cache-hit provenance remains in raw records/cache counts but is excluded
      from aggregate final-argument state/error histograms.
- [x] Both Action failure paths use the bounded error-code vocabulary.
- [x] Action upload, divergence, telemetry-shape, and degraded-rendering tests
      assert their real contracts without changing correct production code.
- [x] Plan 112 and standing architecture docs describe context-preserving clean
      re-execution without weakening the invalid-data boundary.
- [x] `pnpm run check`, `pnpm test`, `pnpm build`, and `git diff --check` pass.
- [x] One no-cache `49f4645b` owner smoke passes its required and coverage
      gates, or Plan 114 remains explicitly pending that smoke.

## STOP conditions

Stop and report; do not improvise if any occurs:

- Retaining task context would require appending the invalid assistant turn,
  reconstructing its arguments, accessing accumulated event text, or
  serializing a local `invalidToolCall` back into Pi history.
- The conversation before the rejected response is already structurally
  inconsistent, such as containing an orphaned tool result.
- Explicit false cannot reach `queueSchemaRepair()` without changing trusted
  Stage-7 compact replacement or another existing schema-repair path.
- A stage builder attempts to read rejected arguments rather than using its
  independently trusted dossier/candidate/groups and bounded provenance
  metadata.
- Mechanical hardening appears to require a new telemetry field, schema,
  parser, prompt, or production change to `action.yml`,
  `final-tool-arguments.ts`, or the Markdown renderer.
- A provider requires echoing the invalid assistant response. Do not add a
  provider-specific exception.
- A proposed fix reads untrusted arguments to arm `candidateDrafted`, accepts
  partial/length-stopped data, adds tolerant JSON repair, or adds another model
  call.
- Pi's installed public terminal `error` event is no longer message-shaped.
  Treat that as a separate dependency investigation.
- Focused/full tests or the owner smoke regress review quality, coverage truth,
  or stage-local failure behavior.

## Maintenance notes

- “Trusted conversation” means structurally valid history independently
  constructed before the malformed response. Reviewed repository content is
  still attacker-controlled and remains governed by existing prompt fencing
  and repository-tool containment.
- This is a redo of lost stage work, not repair of rejected JSON. Future code
  and documentation should call it “clean re-execution” or
  “context-preserving retry.”
- A successful informed Stage-7 redo may legitimately return no findings. Do
  not reintroduce an untrusted candidate-like flag. If production evidence
  later suggests a stricter publication policy, existing repair-outcome and
  packet-result telemetry can support a separate measured plan.
- Context-preserving retries deliberately cost more input tokens than the
  schema-only replacement they supersede. Investigate only if existing
  telemetry shows material frequency or cost.
- New publication measurement fields and separate planner/verifier/composer
  matrices remain deliberately excluded. The included hardening is limited to
  confirmed local behavior/contract gaps with direct deterministic tests.
