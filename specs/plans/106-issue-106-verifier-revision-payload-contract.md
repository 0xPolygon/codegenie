# Issue 106: Enforce Meaningful Verifier Revisions and Calibrate Confidence

Status: PENDING
Planned from: trails-api eval `49f4645b`, especially runs 55 and 57, 2026-08-04
Planned at: commit `1824056` (branch `master`)
Recommended priority: immediate. Stage 9 proved the expected predicate but
lost it through malformed revision semantics and uncalibrated confidence.

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Stop
> on any condition below; do not improvise. Update this plan's row in
> `specs/plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat 1824056..HEAD -- src/llm/schemas.ts src/pipeline/verifier.ts src/skills/prompt-builder.ts src/evals/eval-scoring.ts tests/phase4-llm.test.ts tests/verifier.test.ts tests/pipeline-phase5.test.ts tests/evals.test.ts tests/shared-utils.test.ts specs/project/components/review_pipeline.md specs/project/components/evals.md`
> STOP if the verdict schema, one-repair seam, or verification artifact shape
> no longer matches Current state.

## Execution metadata

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `1824056`, 2026-08-04

## Why this matters

Run 57's verifier proved the exact-output under-delivery chain, then submitted
`verdict: "revise"` without `finalFinding` or `revisedAnchor`. Both fields are
optional today, so the harness completed the revision while retaining the
original low-confidence candidate; composition then withheld its gate-only
anchor and suppressed it.

Run 55 exposed the sibling contract problem: the verifier kept the same proven
predicate at low confidence solely because a secondary lookup hit budget.
Run 53 published when the verifier instead returned calibrated medium
confidence. Stage 9 needs an explicit rule: keep means unchanged; any
structured change uses revise; confidence follows decisive verified evidence,
not inherited generation confidence or secondary tool pressure.

## Current state

- `SubmitVerificationVerdictSchema` at `src/llm/schemas.ts:250-262` is one
  object with optional `finalFinding` and `revisedAnchor` for every verdict.
- `normalizeSubmittedVerdict` accepts every evidence-backed non-reject and
  does not reject an empty revise.
- `runVerifierStructured` already provides exactly one compact schema-repair
  attempt and maps persistent failure to an incomplete verdict. Reuse it.
- `verifyCandidate` applies `finalFinding` whenever present, even on `keep`;
  historical provider output therefore includes keep-with-payload records.
- Stage 9 prompt `p9.6` explains when to revise but not the payload or
  confidence contract.
- `verificationOutcome` reports all incomplete records as
  `verification-incomplete`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Focused tests | `pnpm exec vitest run tests/phase4-llm.test.ts tests/verifier.test.ts tests/pipeline-phase5.test.ts tests/evals.test.ts tests/shared-utils.test.ts` | all selected tests pass |
| Checks | `pnpm run check` | exit 0 |
| Full tests | `pnpm test` | all tests pass |
| Build | `pnpm build` | exit 0 |
| Provider/case validation | run `pnpm dev eval --eval-dir <case> --no-cache` for `49f4645b`, `0c4d5213`, and `relay-wc` under `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api` | provider accepts the schema; required and `should_not_find` guards hold |

## Scope

**In scope**:

- `src/llm/schemas.ts`, `src/pipeline/verifier.ts`,
  `src/skills/prompt-builder.ts`, `src/evals/eval-scoring.ts`.
- `tests/phase4-llm.test.ts`, `tests/verifier.test.ts`,
  `tests/pipeline-phase5.test.ts`, `tests/evals.test.ts`, and
  `tests/shared-utils.test.ts` only for the why-ledger guard.
- `specs/project/components/review_pipeline.md`,
  `specs/project/components/evals.md`, and the plan status row.

**Out of scope**:

- Composer thresholds, representative-anchor publication, promotion policy,
  additional repair attempts, private eval configuration, or historical
  artifact rewrites.
- Making an exact anchor mandatory for a real unanchorable finding.

## Git workflow

- Branch: `fix/verifier-revision-contract`
- Suggested commit: `fix(verifier): enforce meaningful revisions`
- Do not push or open a PR unless asked.

## Steps

### Step 1: Encode the non-empty revision contract

Replace the permissive schema with an object union:

1. `keep | reject`, retaining today's optional payload properties for provider
   and historical compatibility;
2. `revise` with required `finalFinding` and optional `revisedAnchor`;
3. `revise` with required `revisedAnchor` and optional `finalFinding`.

Both revise forms use `additionalProperties: false`; both payloads together
remain valid. Bump `SCHEMA_VERSIONS.submit_verdict` from 1 to 2. Through the
real `validateToolCall` path, test minimal keep/reject, legacy keep-with-finding,
both valid revise forms, revise-with-both, empty revise, and an extra property.

After local tests, the operator must run a real configured-provider Stage-9
smoke before further implementation is considered mergeable. Local validation
does not prove that the provider accepts a root object-union tool schema. If it
rejects the schema, STOP and replace the schema strategy in a fresh reviewed
plan; do not add provider-specific rewriting here.

**Verify**:
`pnpm exec vitest run tests/phase4-llm.test.ts` -> all schema cases pass, then
the provider smoke reaches Stage 9 without a tool-schema rejection.

### Step 2: Make verdict and confidence semantics explicit

Bump Stage 9 prompt `p9.6` to `p9.7` and add one compact contract:

- bare `keep` means confidence, severity, evidence, wording, and placement are
  publishable unchanged;
- any structured change uses `revise`; revise without `finalFinding` or
  `revisedAnchor` is invalid, and prose in `reason` changes nothing;
- when a low-confidence promoted predicate is confirmed, return a complete
  `finalFinding` with calibrated confidence/evidence; add `revisedAnchor` only
  when exact changed-line placement is proven;
- medium is appropriate when decisive changed-code evidence and the failure
  mode are confirmed even if a narrow secondary check remains unresolved;
- tool refusal, truncation, or budget pressure on a secondary check must not
  hold confidence low; if the decisive predicate is unconfirmed, reject or set
  `requiredEvidencePresent: false`;
- low remains appropriate for speculative reachability, ambiguous intent, or
  weak path matching.

Add generic why-ledger entries for the run-57 empty revision and run-55
secondary-budget confidence cap. Test key phrases, not the full prompt.

**Verify**:
`pnpm exec vitest run tests/pipeline-phase5.test.ts tests/shared-utils.test.ts`
-> all tests pass.

### Step 3: Repair empty revisions and canonicalize legacy keeps

Extend `VerifierSchemaInvalidKind` with
`revise_without_revision_payload`. Classify a submit call with `verdict:
"revise"` and neither non-null payload before generic invalid-arguments
classification. Its compact repair prompt must require one valid payload or a
change to keep/reject. Preserve the existing one-attempt repair, counters, and
budget behavior.

In `normalizeSubmittedVerdict`, before the evidence check:

- canonicalize `keep` with either payload to `revise`, preserve the payload,
  and emit `verification_keep_payload_canonicalized` with candidate id and
  payload kinds; bare keep remains unchanged;
- map an empty revise from a non-validating adapter/test double to incomplete,
  emit `verification_semantic_invalid` with the stable reason, and never treat
  it as verifier rejection.

Tests must cover successful repair, repair failure, budget-exhausted repair,
legacy keep canonicalization, bare keep, and the non-validating empty-revise
defense. A completed empty revise must never enter `verified`.

**Verify**:
`pnpm exec vitest run tests/verifier.test.ts tests/pipeline-phase5.test.ts` ->
all cases pass.

### Step 4: Attribute the unrecovered loss and validate broadly

In `verificationOutcome`, map an incomplete reason containing
`revise_without_revision_payload` to stable subreason `empty-revision`; retain
`verification-incomplete` for every other incomplete cause. Add both eval
tests and document the schema, repair, canonicalization, telemetry, and loss
contract.

Run all gates and the three eval cases. Across at least 10 repeats of
`49f4645b`, require zero completed empty revisions. Inspect low-confidence
keep/revise records: none may cite only secondary tool pressure while claiming
the decisive predicate is confirmed. Any new `should_not_find` violation or
material publication inflation on the two quiet cases is a stop-ship signal
for the confidence wording, not a reason to tune the cases.

**Verify**: all commands exit 0; `git diff --check` is silent; only Scope files
and the plan status row changed.

## Done criteria

- [ ] Empty revise is schema-invalid, repaired once, or persisted incomplete.
- [ ] Bare keep means unchanged; keep-with-payload canonicalizes to revise.
- [ ] A real configured provider accepts the schema before merge.
- [ ] Stage 9 carries the revision and confidence contract at `p9.7` (or the
      next legitimate version) with why-ledger coverage.
- [ ] Eval scoring distinguishes `empty-revision` from other incomplete work.
- [ ] Revised-anchor-only and unanchored complete-finalFinding behavior remains
      valid.
- [ ] Focused, full, build, repeat, and cross-case guards pass.
- [ ] Only Scope files and the plan status row changed.

## STOP conditions

Stop if local or real-provider schema validation rejects a valid verdict; the
runner no longer owns one repair attempt; revised-anchor-only or unanchored
complete findings regress; the fix requires changing publication thresholds or
publishing a gate-only anchor; cross-case guards regress; or focused tests fail
twice after a reasonable correction.

## Maintenance notes

Verdict meaning belongs in structured state, never inferred from prose. Keep
the adapter defense even after provider validation. Any future requirement that
every confirmed promotion return `finalFinding` is a separate schema migration.
