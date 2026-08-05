# Issue 111: Fix Observed Structured-Submit Failures and Preserve Safe Diagnostics

Status: PENDING
Planned from: GitHub Action run `30998651040` / job `92281793676`,
trails-api eval `49f4645b` runs 61-62, and `0c4d5213` run 69,
2026-08-05
Planned at: commit `07434ba` (branch `plans`)
Recommended priority: immediate. This plan fixes the observed production
failure and measured Stage-9 friction without waiting for an upstream Pi
release or building a speculative general JSON-repair layer.

> **Executor instructions**: Follow this plan step by step. Read the entire
> plan before changing code. Run every verification command and confirm its
> expected result before continuing. If a STOP condition occurs, stop and
> report; do not add permissive parsing or weaken a submit schema. Update this
> plan's row in `specs/plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat 07434ba..HEAD -- src/llm/llm-runner.ts src/llm/pi-runner.ts src/llm/schema-diagnostics.ts src/llm/schemas.ts src/pipeline/planner.ts src/pipeline/verifier.ts src/pipeline/composer.ts src/skills/prompt-builder.ts src/output/markdown-renderer.ts src/util/coverage-summary.ts src/github-action/entrypoint.ts src/github-action/render.ts action.yml .github/workflows/codegenie-review.yml tests/phase4-llm.test.ts tests/pipeline-phase5.test.ts tests/github-action.test.ts tests/shared-utils.test.ts specs/project/architecture.md specs/project/components/skills_llm_telemetry.md specs/project/components/review_pipeline.md specs/project/components/repository_and_github.md`
> If an in-scope path changed, reconcile every Current state statement against
> live code. STOP if the one-model-repair scheduler, planner fallback,
> verifier incomplete behavior, coverage aggregation, or Action status-comment
> lifecycle changed semantically.

## Execution metadata

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**:
  `specs/plans/106-issue-106-verifier-revision-payload-contract.md`
  (COMPLETE). The shared Plan-95 submit/retry seam is already implemented at
  the planned SHA; no pending Plan-95 work blocks this plan.
- **Category**: bug / resilience / diagnostics
- **Planned at**: commit `07434ba`, 2026-08-05

## Why this matters

The GitHub Action failed after a Stage-5 planner submit and its one repair
were both schema-invalid. Stage 5 set `failAfterRepair: true`, so the runner
made the error fatal before the planner's documented deterministic fallback
could run. The Action then uploaded no report or diagnostic artifact, leaving
only a generic `llm_schema_invalid` line and no safe indication of which
schema rule failed.

The successful owner evals exposed a separate measured cost. Four otherwise
complete Stage-9 verdicts carried `reason` strings of 2,100-2,984 characters
against a 2,000-character schema maximum. All four repairs succeeded, but
every repair was an avoidable paid call and another stochastic failure point.
Run 57 also established that the provider-safe flat verdict schema can accept
`revise` without `finalFinding` or `revisedAnchor`; that semantic omission
currently becomes incomplete without using the available repair attempt.

This plan fixes those observed paths and makes degraded/incomplete output
truthful. It does not implement a general final-JSON parser. Final argument
provenance and loss-suspected input are handled separately by Issue 112 so
this production fix is not blocked on an upstream Pi release.

## Current state

- `src/pipeline/planner.ts:319-336` sets `failAfterRepair: true` even though
  `runPlanner` and `runChunkedPlanner` already catch recoverable failures and
  build deterministic default coverage. The project architecture explicitly
  promises planner degrade-and-disclose behavior.
- `src/llm/pi-runner.ts:259-275` contains Plan 95's single model-repair
  scheduler. `queueSchemaRepair` enforces the one-repair budget; this plan must
  use it rather than creating another retry loop.
- `src/llm/pi-runner.ts:2275-2279` throws the terminal schema error with
  `recoverable` controlled by `failAfterRepair`. Its current context includes
  a truncated validator message which can itself contain the model's complete
  received arguments; that string is not safe for a public artifact.
- Pi's validator formats safe path/rule lines before a blank-line delimiter
  and then appends `Received arguments:` plus the raw payload. Safe diagnostics
  must be reconstructed through an allowlist and must never retain the raw
  suffix or arbitrary validator prose.
- `src/llm/schemas.ts:250-268` caps verifier `reason` at 2,000 characters;
  `SCHEMA_VERSIONS.submit_verdict` is 3. The Stage-9 prompt version is `p9.8`.
- `src/pipeline/verifier.ts:689-727` canonicalizes keep-with-payload and turns
  empty revise into an incomplete result only after `runStructured` returns.
  `classifyVerifierSchemaInvalid` already recognizes
  `revise_without_revision_payload`, but schema-valid empty revise cannot
  currently enter the real repair scheduler.
- `src/llm/pi-runner.ts:2841-2867` computes cache schema validity from submit
  discipline plus TypeBox validation. A new semantic validation hook must also
  participate there so an empty revise is not cached as valid.
- `src/output/markdown-renderer.ts:4-18` renders coverage, but appends
  “No credible findings were found. Everything looks good.” whenever
  `noFindings` is true, including partial reviews.
- `src/util/coverage-summary.ts` already owns complete/partial/degraded
  coverage wording. `RunCoverageStatus` is the existing single source of
  truth and must remain so.
- `src/github-action/entrypoint.ts:194-209` finalizes a generic failure comment
  and rethrows. It writes no report/failure files in that branch.
- `action.yml` and `.github/workflows/codegenie-review.yml` upload only
  `${runner.temp}/codegenie-report.md`; the file does not exist on early
  review failure.
- Telemetry is disabled by default. Failure diagnostics therefore must use
  runner-temp paths and cannot depend on a telemetry run directory.

## Trust and publication policy

Content-stage invalidity remains binary: never use known-invalid model data.
The stage may continue only from independently trusted work or an existing
deterministic fallback.

| Terminal condition after the one repair | Trusted state that remains | Required disposition |
| --- | --- | --- |
| Stage-5 planner invalid | Parsed diff/hunk inventory and deterministic default coverage | Discard every planner field; continue with `degradedPlanning: true`. |
| Stage-7 packet invalid | Successful packet results; failed packet hunks are known gaps | Discard the failed packet; mark its hunks incomplete/partial. |
| Stage-9 verdict invalid or semantic empty revise | Other completed verdicts; this candidate is unverified | Suppress the candidate and increment verification-incomplete coverage. |
| Stage-10 composition invalid | Already verified findings | Use existing deterministic composition; do not drop verified findings. |
| Diff/base/repository identity, authentication, provider-wide availability, or another non-isolatable foundation is untrusted | No trustworthy review foundation | Fail the run and leave the scrubbed failure artifact. |

Run-level publication follows existing coverage truth:

- complete and normal: publish normally;
- complete after planner fallback: publish with a prominent degraded banner;
- partial with verified findings: publish only those findings with a prominent
  incomplete banner and the existing coverage disclosure;
- partial with no findings: publish an explicit “Review Incomplete” conclusion
  and never say “Everything looks good” or otherwise grant a clean bill of
  health;
- foundational failure: do not render a normal review.

Do not add a numeric reviewed-hunk threshold, a second coverage ledger, or a
new partial-run exit-code policy here. A percentage would not express hunk
criticality and is not supported by current evidence. The repository's
documented contract is that partial reviews exit 0 and say they are partial;
changing that product policy requires a separate measured plan.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Runner/schema tests | `pnpm exec vitest run tests/phase4-llm.test.ts tests/shared-utils.test.ts` | all selected tests pass |
| Pipeline/output tests | `pnpm exec vitest run tests/pipeline-phase5.test.ts` | all selected tests pass |
| Action tests | `pnpm exec vitest run tests/github-action.test.ts` | all selected tests pass |
| Checks | `pnpm run check` | exit 0 |
| Full tests | `pnpm test` | all tests pass |
| Build | `pnpm build` | exit 0 |
| Diff hygiene | `git diff --check` | no output |

## Scope

**In scope**:

- `src/llm/schemas.ts`, `src/skills/prompt-builder.ts`,
  `src/pipeline/verifier.ts` — verifier reason target/buffer and semantic
  empty-revise repair.
- `src/llm/llm-runner.ts`, `src/llm/pi-runner.ts`, and one small new
  `src/llm/schema-diagnostics.ts` — pure semantic validation hook plus a
  safe-by-construction schema-failure identity.
- `src/pipeline/planner.ts` — restore documented deterministic fallback after
  terminal planner schema failure.
- `src/util/coverage-summary.ts`, `src/output/markdown-renderer.ts`, and
  `src/pipeline/composer.ts` only as needed for one shared prominent
  degraded/incomplete banner and truthful partial no-findings output.
- `src/github-action/entrypoint.ts`, `src/github-action/render.ts`, `action.yml`,
  `.github/workflows/codegenie-review.yml` — always-available scrubbed failure
  JSON/Markdown and bounded public failure identity.
- Focused tests in `tests/phase4-llm.test.ts`,
  `tests/pipeline-phase5.test.ts`, `tests/github-action.test.ts`, and the
  existing why-ledger guard in `tests/shared-utils.test.ts`.
- Contract updates in `specs/project/architecture.md`,
  `specs/project/components/skills_llm_telemetry.md`,
  `specs/project/components/review_pipeline.md`, and
  `specs/project/components/repository_and_github.md`.

**Out of scope**:

- Any Pi dependency change, final raw-argument parser, `partial-json` change,
  JSONC scanner, `jsonrepair`, JSON5, or new syntax-repair allowlist.
- More than one model repair, provider-specific Codegenie parsing, raw model
  argument persistence, or a second LLM runtime.
- Deterministic truncation of verifier reasons. Reasons from 2,001 through
  4,000 are preserved unchanged; reasons above 4,000 use model repair.
- Duplicate-submit policy changes, generic structured repair-prompt redesign,
  broad recovery telemetry taxonomy, or model-call-cache version changes
  unrelated to semantic empty-revise validity.
- New candidate publication/confidence policy, Stage-7 cleanup behavior,
  composer fallback behavior, eval expectation changes, numeric publication
  thresholds, or partial-run exit-code changes.

## Git workflow

- Branch: `fix/observed-structured-submit-resilience`
- Keep reason-buffer/semantic repair, planner degradation/output truth, and
  Action diagnostics in reviewable logical commits.
- Suggested commit subject:
  `fix(llm): degrade observed submit failures safely`
- Do not push or open a PR unless the operator asks.

## Steps

### Step 1: Give Stage-9 reason text a soft target and hard buffer

1. Define one pair of shared constants, preferably beside the verifier schema:
   `VERIFIER_REASON_TARGET_CHARS = 2_000` and
   `VERIFIER_REASON_HARD_MAX_CHARS = 4_000`. If importing them from the schema
   creates a cycle, use one tiny limits module. Do not repeat the numeric
   literals across schema, prompt, and verifier code.
2. Keep 2,000 as the model-facing target in the primary and stateless repair
   prompts. Say the reason should be concise and at most 2,000 characters.
3. Set `SubmitVerificationVerdictSchema.reason.maxLength` to 4,000. Bump
   `SCHEMA_VERSIONS.submit_verdict` from 3 to 4, Stage 9 from `p9.8` to `p9.9`,
   and update the why ledger.
4. Accept reasons from 2,001 through 4,000 unchanged and without repair. Emit
   one bounded `verification_reason_target_exceeded` event containing only
   candidate id, actual length, target, hard maximum, and whether the accepted
   submit followed a model repair.
5. A reason of 4,001 or more remains schema-invalid and consumes the existing
   single model repair. Do not add a deterministic truncator.

Pin exact historical lengths 2,327, 2,984, 2,102, and 2,285 as primary-call
regressions. Also pin 2,000/2,001/4,000/4,001 boundaries and verify the
submitted reason text is byte-identical after acceptance.

**Verify**:
`pnpm exec vitest run tests/phase4-llm.test.ts tests/pipeline-phase5.test.ts tests/shared-utils.test.ts`
passes; schema/prompt versions are 4/`p9.9`.

### Step 2: Route semantic empty revise through the real one-repair scheduler

Add one optional, pure post-schema validation hook to
`LlmStructuredRequest`, preferably
`validateSubmit?(value: T): LlmSubmitSemanticValidation`. Use a discriminated
result such as:

```ts
type LlmSubmitSemanticValidation =
  | { ok: true }
  | {
      ok: false;
      classification: LlmSubmitSemanticFailureKind;
    };

type LlmSubmitSemanticFailureKind = "revise_without_revision_payload";
```

The hook receives only the adapter-validated submit value. It cannot call a
provider, mutate the value, or synthesize fields.

1. Invoke the hook after every successful submit-schema validation, including
   the primary response, a value returned by `tryRecoverInvalidSubmit`, and the
   model-repair response. Prefer one internal
   schema-then-semantics helper so deterministic recovery cannot return early
   with a semantically invalid value. A semantic failure after deterministic
   recovery declines that recovery and proceeds to the same one model repair.
   A semantic failure after model repair follows the stage's existing terminal
   disposition; never dispatch a second repair.
2. Carry its enum-bounded classification through `LlmSchemaRepairInput` and
   the existing scheduler. Define one central allowlist type for safe terminal
   classifications, including the existing Stage-7 kinds and an `unknown`
   fallback; never publish an arbitrary hook/classifier string. Remove the
   scheduler's internal Stage-7-only cast if necessary, but preserve the
   Stage-7 classifier union and every existing Stage-7 event value at the
   Stage-7 boundary.
3. Include the hook in `schemaValidityForResponse` so a schema-valid but
   semantically invalid submit is not cached as valid.
4. In `runVerifierStructured`, reject only `verdict === "revise"` with neither
   `finalFinding` nor `revisedAnchor`, using classification
   `revise_without_revision_payload`. Either field alone is a valid revision.
   Keep-with-payload remains Plan 106's canonicalized revise and is not a
   semantic failure.
5. Preserve the current incomplete result and telemetry when repair still
   fails or cannot dispatch because budget is exhausted.

Test live runner behavior, not only direct prompt helpers: primary empty revise
dispatches exactly one stateless repair; a deterministic normalizer returning
an empty revise is not accepted and uses that same repair; a valid repaired
revision succeeds; another empty revise becomes incomplete; cache eligibility
is false for the primary invalid response; keep-with-payload behavior remains
unchanged.

**Verify**:
`pnpm exec vitest run tests/phase4-llm.test.ts tests/pipeline-phase5.test.ts`
passes.

### Step 3: Make terminal planner schema failure degrade, not abort

In `src/pipeline/planner.ts`, set planner post-repair schema failure to
recoverable (`failAfterRepair: false`, or remove the override if false is the
runner default). Only terminal planner `llm_schema_invalid` after the existing
one repair may use this fallback. Do not catch authentication errors,
permission failures, provider exhaustion/availability failures, configuration
or programming errors, or another fatal class.

Pin the complete path:

- invalid primary planner submit -> exactly one repair;
- invalid repaired submit -> `llm_schema_invalid` with `recoverable: true`;
- `runPlanner` discards every submitted planner field, writes the existing
  deterministic default `review-plan.json`, and returns
  `degradedPlanning: true`;
- Stage 6 and later stages consume only deterministic default coverage;
- chunked planning falls back only the failed chunk and preserves successful
  chunks;
- auth/provider-wide/fatal-class failures remain fatal;
- no second repair is dispatched.

Add an Action-level fixture equivalent to the observed incident: two invalid
planner submits result in a completed degraded review, not a failed job. Do
not encode the GitHub run id or repository-specific payload.

**Verify**:
`pnpm exec vitest run tests/pipeline-phase5.test.ts tests/github-action.test.ts`
passes.

### Step 4: Make degraded and incomplete reviews prominent and truthful

Use `RunCoverageStatus` as the only coverage/trust ledger.

1. Add one small shared renderer in `src/util/coverage-summary.ts` for the
   prominent trust banner:
   - partial takes precedence and says the review is incomplete; when planning
     was also degraded, include the planner-fallback fact in the same banner;
   - otherwise degraded planning says the planner failed and deterministic
     default coverage was used, and recommends rerunning;
   - normal complete runs return no banner.
2. Render the banner immediately below the Codegenie heading and before the
   model-authored summary in both the full Markdown/status comment and the
   GitHub review body. Keep detailed counts/reasons in the existing coverage
   section; do not duplicate them in the banner.
3. Split the unconditional `noFindings` section:
   - complete: preserve today's heading and sentence byte-for-byte;
   - partial: use “Review Incomplete” and say that completed work produced no
     credible verified findings, but incomplete coverage/verification prevents
     a clean conclusion. Never include “Everything looks good.”
4. Keep independently verified findings publishable on partial runs with the
   same prominent incomplete banner. Do not demote or suppress them because an
   unrelated packet/candidate failed.
5. Planner fallback alone does not set `coverage.partial` when all downstream
   work completes. Zero-work filtered/empty diffs remain complete reviews of
   nothing.

Add regressions for normal complete, planner-degraded complete, partial with a
finding, partial no-findings, all Stage-7 packets failed, Stage-9 incomplete
with no published finding, combined degraded+partial, and foundational Action
failure. Assert banner placement before the summary and that no partial path
contains an approval-equivalent sentence.

**Verify**:
`pnpm exec vitest run tests/pipeline-phase5.test.ts tests/github-action.test.ts`
passes.

### Step 5: Preserve a safe schema-failure identity and always write failure artifacts

Create one pure `src/llm/schema-diagnostics.ts` helper and one bounded type for
failure identity. Suggested shape:

```ts
type StructuredSubmitFailureDiagnostic = {
  schemaVersion: 1;
  stage: ReviewStage;
  role: LlmRole;
  submitTool: string;
  submitSchemaVersion: number;
  attempt: "primary" | "repair";
  classification: StructuredSubmitFailureClassification;
  issues: Array<{
    path: string;
    rule: "required" | "additionalProperties" | "type" |
      "minLength" | "maxLength" | "minItems" | "maxItems" |
      "enum" | "const" | "semantic" | "schema";
    expectedLimit?: number;
  }>;
};
```

Define the diagnostic classification as an explicit union, not `string`, for
example the generic safe kinds (`schema_invalid`, `missing_submit`,
`multiple_submits`, `revise_without_revision_payload`, `unknown`) plus the
existing `Stage7SchemaInvalidKind` union. Map anything outside that set to
`unknown` at the runner boundary and cap serialized classification labels at
64 characters defensively.

Names may match local style, but these safety properties are mandatory:

1. Build the record at the runner boundary while stage, role, tool, schema
   version, attempt, and validation failure are available.
2. For Pi's current thrown validator format, discard everything beginning at
   its blank-line `Received arguments:` delimiter before inspecting the safe
   prefix. Accept only bounded path/rule patterns from an allowlist; normalize
   an unknown/malformed path to `root` and an unknown rule to `schema`.
3. Derive a safe property-name allowlist by walking the request's static
   TypeBox schema, including union/object branches and array items. A retained
   path may contain only names from that schema-derived set plus numeric array
   indexes and is capped at 200 characters; regex shape alone is insufficient.
   If any segment cannot be proven schema-owned, normalize the whole path to
   `root`. Store at most 12 issues. Store numeric schema limits only when an
   allowlisted rule exposes them.
4. Never store raw field values, arbitrary validation prose, prompts, model
   output, arguments, repository snippets, diffs, tool results, stack traces,
   or hashes that could be used as a surrogate payload.
5. Missing/extra submit discipline and semantic empty revise use the same
   record with bounded classifications; they do not invent schema issues.
6. Replace the terminal schema error's raw validation-message context with
   this safe diagnostic. Do not attach the original Pi validation exception as
   `cause`: it contains the complete `Received arguments` payload. If a cause
   is required for internal error chaining, replace it with a new value-free
   bounded error. Repair prompts may continue receiving the original bounded
   error before the terminal throw; public errors/artifacts may not retain it.

Then make the Action failure path always leave evidence:

1. Add `CODEGENIE_FAILURE_PATH`, set to
   `${runner.temp}/codegenie-failure.json` in both Action surfaces.
2. In the Action catch path, project the thrown error through an explicit
   allowlist. Write a schema-versioned JSON record containing Action lane/PR,
   run URL/id when available, error code, and the structured diagnostic when
   present. Never serialize arbitrary `error.context` or `error.message`.
3. Cap the JSON artifact at 16 KiB. Write a separate Markdown report capped at
   4 KiB to `CODEGENIE_REPORT_PATH` on failure. It may show error code,
   stage/tool/attempt/classification, and safe issue path/rule/limit fields,
   then point to the JSON artifact.
4. Pass only the same bounded identity to the status comment and CI log. A
   useful form is “Stage 5 `submit_plan` repair remained schema-invalid
   (`coverage: required`)”; do not print the validator exception.
5. Upload report and failure JSON with `if: always()`. Success behavior remains
   unchanged; the failure JSON may be absent on success without warning.
6. Any file-write problem must not replace the original review error.

Tests must use the real default `runDir: ""` path. Seed a fake secret and a
repository-like snippet in received arguments and exception text; assert that
neither appears in JSON, Markdown, lifecycle log, status comment, or step
output. Also test malformed validator prose, more than 12 issues, unsafe paths,
unknown errors without structured diagnostics, successful reviews, artifact
size caps, and unwritable artifact paths. Recursively inspect the thrown
error's context/cause, JSON serialization, stack/log rendering, and artifacts
to prove the seeded values are absent.

**Verify**:
`pnpm exec vitest run tests/phase4-llm.test.ts tests/github-action.test.ts`
passes.

### Step 6: Document the contracts and run full validation

Update the architecture/component specs with these exact invariants:

- observed Stage-9 verbosity uses a 2,000 target and 4,000 hard schema limit;
- semantic validation shares the one model-repair budget and cache-validity
  decision;
- planner terminal schema failure discards model data and uses deterministic
  fallback;
- complete, degraded, partial, and failed output states are visibly distinct;
- partial reviews never grant a clean bill of health;
- public failure diagnostics are safe-by-construction allowlisted fields and
  exist even when telemetry is disabled;
- final raw-argument parse provenance is deferred to Issue 112 and is not
  approximated by serializing Pi's already-parsed arguments.

Lift the complete “Trust and publication policy” matrix from this plan into
`specs/project/architecture.md`, preserving the distinction between terminal
condition, independently trusted state, and required disposition. Supporting
component specs may summarize the rows relevant to their component, but the
architecture document must retain the full lookup table rather than replacing
it with general degrade-or-fail prose.

Run every command in Commands you will need. Inspect `git status --short` and
the complete diff. The final implementation should contain one semantic hook,
one schema-diagnostic helper, one trust-banner renderer, the existing one
repair scheduler, and the existing coverage ledger.

**Verify**: `pnpm run check`, `pnpm test`, `pnpm build`, and
`git diff --check` all succeed. Only Scope paths plus the plan status row are
changed.

### Step 7: Run provider and owner validation

1. Re-run the PR-19 Action scenario (or an equivalent configured-provider PR)
   and prove a twice-invalid planner submission completes through deterministic
   degraded planning with a prominent header.
2. Force a separate safe fixture failure and download the Action artifact.
   Confirm the report and JSON identify stage/tool/classification without raw
   arguments or repository content.
3. Run no-cache owner evals for `49f4645b`, `0c4d5213`, and `relay-wc` under
   `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api`.
4. Compare against the accepted baselines:
   - the exact four 2.1k-3.0k verifier reasons do not schedule repairs;
   - `revise_without_revision_payload` receives at most one real repair and
     remains incomplete if unrepaired;
   - required findings, `should_not_find` guards, rendered-note guards, and
     publication behavior remain unchanged;
   - no raw failure payload appears in logs or artifacts.

Record run ids and summarized schema-repair counts in this plan before marking
it COMPLETE. Do not weaken eval expectations to pass the gate. Revert or
correct the responsible slice if any fatal class is swallowed, partial output
contains approval wording, a second repair occurs, or an owner eval regresses.

**Verify**: Action/provider smoke and all three owner cases satisfy every
listed invariant.

## Test plan summary

- `tests/phase4-llm.test.ts`: semantic hook on primary/repair/cache paths,
  reason schema boundaries, bounded safe diagnostic extraction.
- `tests/pipeline-phase5.test.ts`: historical reason lengths, empty-revise
  repair, planner fallback, prominent output banners, partial no-findings.
- `tests/github-action.test.ts`: twice-invalid planner success, no-telemetry
  failure artifacts, safe public diagnostics, secret/repository-text absence.
- `tests/shared-utils.test.ts`: prompt version/why-ledger consistency.
- Full check/test/build plus configured-provider and owner-eval gates.

## Done criteria

- [ ] The four historical 2,100-2,984-character reasons pass on the primary
      call unchanged; 2,001-4,000 emits target-exceeded telemetry and 4,001+
      uses exactly one model repair.
- [ ] Schema-valid empty revise enters the real one-repair path, is not cached
      as valid, and remains incomplete if repair cannot produce a payload.
- [ ] Twice-invalid planner output is discarded and deterministic planning
      continues; auth/provider-wide/fatal-class failures remain fatal.
- [ ] Complete degraded and partial reviews show a prominent pre-summary
      banner; partial no-findings never says “Everything looks good.”
- [ ] One safe schema-diagnostic helper records only allowlisted bounded
      metadata and terminal schema errors no longer expose raw validation
      arguments through their context.
- [ ] Action failure always leaves scrubbed Markdown (at most 4 KiB) and JSON
      (at most 16 KiB), including with telemetry disabled and no run attachment.
- [ ] Existing one-repair, stage-local degradation, cache, finding publication,
      and partial-exit-code contracts remain intact.
- [ ] `pnpm run check`, `pnpm test`, `pnpm build`, and `git diff --check` pass.
- [ ] Configured-provider and all three owner-eval gates pass without
      expectation weakening.
- [ ] Architecture/component specs and the README status row are updated.

## STOP conditions

Stop and report; do not improvise if any occurs:

- The current runner no longer has exactly one model-repair scheduler or the
  semantic hook would require a second provider call path.
- Making empty revise repairable requires restoring a provider-rejected root
  union or synthesizing a revision payload.
- Planner fallback would consume any field from the invalid planner response
  rather than only deterministic diff/hunk inputs.
- Safe failure diagnostics require serializing arbitrary error context, raw
  arguments, arbitrary validator messages, prompts, diffs, repository text,
  tool results, or hashes of those values.
- Pi's validator format no longer has a provable safe delimiter before raw
  arguments. Fall back to pathless classification; do not parse or persist an
  uncertain message.
- Prominent disclosure requires a second completeness calculation rather than
  `RunCoverageStatus`.
- The provider rejects the flat Stage-9 schema after the reason limit changes,
  a cross-case eval regresses, or focused tests fail twice after a reasonable
  correction.

## Maintenance notes

- The 2,000-character reason value is a prompt target; 4,000 is the hard
  schema maximum. Revisit either only with measured accepted-length data.
- Safe diagnostics are intentionally less detailed than raw validator errors.
  Add a new field only when it can be proven value-free and bounded.
- Degraded and partial are independent axes: deterministic planner fallback
  can still achieve full hunk coverage, while a normal planner can still be
  followed by partial packet/verification work.
- Do not grow this plan into final JSON parsing. Issue 112 owns that boundary
  and its evidence gate.
