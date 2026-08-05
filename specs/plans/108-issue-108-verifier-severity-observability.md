# Issue 108: Add a Verifier Severity Rubric and Revision Telemetry

Status: PENDING
Planned from: trails-api eval `49f4645b`, run 56 severity inflation, 2026-08-04; reduced to measurement-first scope after overfit review
Planned at: commit `1824056` (branch `master`)
Recommended priority: after Issue 106. This shares the Stage-9 prompt cadence
but deliberately adds no deterministic severity cap.

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Stop
> on any condition below; do not improvise. Update this plan's row in
> `specs/plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat 1824056..HEAD -- src/types.ts src/pipeline/verifier.ts src/pipeline/severity-policy.ts src/skills/prompt-builder.ts tests/verifier.test.ts tests/pipeline-phase5.test.ts tests/shared-utils.test.ts specs/project/components/review_pipeline.md`
> Issue 106 is expected to change verifier and prompt files. Rebase the line
> references and prompt version onto its landed result. STOP if severity no
> longer flows through `revisedFinding` and `applySeverityPolicy` as described.

## Execution metadata

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**:
  `specs/plans/106-issue-106-verifier-revision-payload-contract.md`
- **Category**: bug
- **Planned at**: commit `1824056`, 2026-08-04

## Why this matters

Run 56 published a bounded rounding issue as high severity after one verifier
raised a low candidate by two levels, while the actual impact was below one
origin base unit. Severity inflation erodes reviewer trust, but one observed
incident is not enough evidence for permanent schema and capping machinery.

The generic response is a clear Stage-9 rubric plus passive audit data. This
plan changes model guidance and observability only. It does not cap, rewrite,
or otherwise alter submitted severity in deterministic code.

## Current state

- `src/pipeline/verifier.ts:880-918` accepts the submitted final-finding
  severity and then applies only the existing behavior-change policy.
- `src/pipeline/severity-policy.ts` caps high/critical only for
  `intentional_needs_confirmation` and preserves `severityBeforeCap` for the
  existing never-hide guarantee. This plan must not change that behavior.
- No verdict metadata or event records original, submitted, and applied
  severity together.
- Stage 9 has detailed confidence and false-positive guidance but no compact
  magnitude/reach severity rubric.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Focused tests | `pnpm exec vitest run tests/verifier.test.ts tests/pipeline-phase5.test.ts tests/shared-utils.test.ts` | all selected tests pass |
| Checks | `pnpm run check` | exit 0 |
| Full tests | `pnpm test` | all tests pass |
| Build | `pnpm build` | exit 0 |
| Owner live eval | run `pnpm dev eval --eval-dir <case> --no-cache` for `49f4645b`, `0c4d5213`, and `relay-wc` under `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api` | cases complete; required and `should_not_find` guards hold |

## Scope

**In scope**:

- `src/skills/prompt-builder.ts` — rubric, next Stage-9 version, why ledger.
- `src/pipeline/verifier.ts` — passive revision metadata and telemetry.
- `src/types.ts` — optional persisted audit record.
- `tests/verifier.test.ts`, `tests/pipeline-phase5.test.ts`, and
  `tests/shared-utils.test.ts` only for the why-ledger guard.
- `specs/project/components/review_pipeline.md` and the plan status row.

**Out of scope**:

- Any deterministic severity cap, new verdict schema field, composer change,
  or `severityBeforeCap` change.
- Parsing impact prose, category-specific exceptions, base-severity changes,
  confidence policy, or historical artifact rewrites.
- Writing a future cap design before telemetry establishes the problem rate.

## Git workflow

- Branch: `fix/verifier-severity-observability`
- Suggested commit: `feat(verifier): add severity rubric and revision telemetry`
- Do not push or open a PR unless asked.

## Steps

### Step 1: Add the generic severity rubric

In `src/skills/prompt-builder.ts`, bump Stage 9 from Issue 106's landed prompt
version to the next version and add one compact rule:

- low: bounded or localized impact;
- medium: material but limited impact;
- high: broad or serious user/system impact;
- critical: catastrophic impact or a security-boundary compromise;
- severity measures magnitude and reach, not merely whether a correctness
  invariant is technically violated;
- a change of more than one level from the input candidate must quantify the
  concrete impact bound in verification text.

Add a why-ledger entry citing the run-56 low-to-high inconsistency without
case-specific files or symbols. Add narrow prompt assertions; do not snapshot
the full prompt.

**Verify**:
`pnpm exec vitest run tests/pipeline-phase5.test.ts tests/shared-utils.test.ts`
-> all tests pass.

### Step 2: Audit original, submitted, and applied severity

In `verifyCandidate`, when a complete submitted `finalFinding` produces a
revised candidate, compare:

- `original`: `candidate.severity`;
- `submitted`: the model's `finalFinding.severity` before policy;
- `applied`: the revised candidate severity after existing policy.

Attach this optional verdict record:

```ts
severityRevision?: {
  original: Severity;
  submitted: Severity;
  applied: Severity;
  deltaLevels: number; // signed: submitted rank minus original rank
};
```

Emit `verification_severity_revision` with the same bounded fields plus
candidate id, category, and behavior change. Use info level for
`deltaLevels >= 2` and debug otherwise. Do not include long evidence text and
do not alter applied severity.

Add tests for a decrease, no change, a one-level increase, a two-level
increase, and an existing behavior-change cap. Assert signed deltas, applied
severity, event level, backward-compatible optional metadata, and no change to
`severityBeforeCap` behavior.

**Verify**:
`pnpm exec vitest run tests/verifier.test.ts tests/pipeline-phase5.test.ts`
-> all tests pass.

### Step 3: Document, validate broadly, and finish

Document the rubric, record, event, and measurement rule below. Run all gates
and the three owner eval cases. Any new required-expectation loss,
`should_not_find` violation, or unexplained publication change attributable to
the prompt is a stop-ship regression; revise the generic wording, never the
eval cases.

**Verify**: all commands exit 0; `git diff --check` is silent; only Scope files
and the plan status row changed.

## Measurement rule for any future cap

After landing, collect at least 20 runs spanning all three named eval cases.
Open a **new plan against the then-current HEAD** only if review finds either:

- at least three multi-level increases (`deltaLevels >= 2`) whose verification
  text does not quantify a commensurate impact; or
- one operator-confirmed severe calibration failure with material user-facing
  consequences.

The future plan must use that corpus to define its policy, schema, and tests.
Do not preserve or implement a speculative cap in this plan.

## Done criteria

- [ ] Stage 9 has the generic magnitude/reach rubric and why-ledger entry.
- [ ] Complete final-finding submissions persist and emit original,
      submitted, applied, and signed-delta severity data.
- [ ] Deterministic applied-severity behavior is unchanged.
- [ ] Decrease, unchanged, one-level, multi-level, and behavior-cap tests pass.
- [ ] All three cross-case eval guards pass.
- [ ] `pnpm run check`, `pnpm test`, and `pnpm build` exit 0.
- [ ] Only Scope files and the plan status row changed.

## STOP conditions

Stop if Issue 106 has not landed; if audit metadata requires changing applied
severity; if the existing behavior-change guarantee regresses; if cross-case
guards regress; or if focused tests fail twice after a reasonable correction.

## Maintenance notes

The telemetry is the policy input, not a pretext for a cap. Repeated model
severity changes are hypotheses until source evidence and human review show a
real calibration failure. If the measurement rule fires, write a fresh,
self-contained plan rather than extending this one in place.
