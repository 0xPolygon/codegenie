# Issue 109: Restore Summary-Only Publication for Verified Low-Confidence Deltas

Status: PENDING
Planned from: trails-api eval `49f4645b`, runs 52/55/57 and earlier hatch-published runs, 2026-08-04
Planned at: commit `1824056` (branch `master`)
Recommended priority: immediately after Issue 106. Issue 106 improves
calibration; this plan preserves visibility when a valid finding remains low.

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Stop
> on any condition below; do not improvise. Update this plan's row in
> `specs/plans/README.md` when complete.
>
> **Drift check (run first)**:
> `git diff --stat 1824056..HEAD -- src/pipeline/composer.ts tests/pipeline-phase5.test.ts specs/project/components/review_pipeline.md`
> STOP if `applyCaps`, `withholdRepresentativeAnchor`, final representative
> ids, or the low-confidence hatch differ semantically from Current state.

## Execution metadata

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**:
  `specs/plans/106-issue-106-verifier-revision-payload-contract.md`
- **Category**: bug
- **Planned at**: commit `1824056`, 2026-08-04

## Why this matters

The low-confidence escape hatch is intended to publish verifier-confirmed,
evidence-backed behavior deltas. It is unreachable for promotion findings:
their gate-only `backfill_packet_representative` anchor is correctly stripped
before composition, but the hatch then requires an anchor and changed line.
The finding is suppressed instead of routed summary-only.

Run 55 demonstrates the result: an evidence-backed, medium-risk keep on the
expected behavior delta reached composition at low confidence, lost its
untrusted placement, and became “No credible findings.” Removing an unsafe
inline location must not remove an otherwise qualified summary finding.

## Current state

- `withholdRepresentativeAnchor` at `src/pipeline/composer.ts:640-658` removes
  gate-only representative anchors and sets `changedLine: false`; this safety
  invariant must remain intact.
- `lowConfidencePublishableCandidateIds` currently allows every keep/revise,
  without evidence, risk, or completeness checks.
- `isPublishableLowConfidenceBehaviorDelta` requires allowlist membership,
  concrete behavior-delta evidence/text, a confirmation path, and a surviving
  anchor/changed line. The final condition makes the hatch unreachable after
  representative-anchor withholding.
- `FinalFinding.id` is the canonical representative candidate id at the
  `applyCaps` boundary; `mergedCandidateIds` may include siblings with different
  verdict quality.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install --frozen-lockfile` | exit 0 |
| Focused tests | `pnpm exec vitest run tests/pipeline-phase5.test.ts tests/verifier.test.ts` | all selected tests pass |
| Checks | `pnpm run check` | exit 0 |
| Full tests | `pnpm test` | all tests pass |
| Build | `pnpm build` | exit 0 |
| Owner validation | run `pnpm dev eval --eval-dir <case> --no-cache` for `49f4645b`, `0c4d5213`, and `relay-wc` under `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api` | required and `should_not_find` guards hold; no untrusted inline anchor publishes |

## Scope

**In scope**:

- `src/pipeline/composer.ts` — verdict gate and two-outcome hatch.
- `tests/pipeline-phase5.test.ts` — positive, negative, merged-member, and cap
  regressions.
- `specs/project/components/review_pipeline.md` and the plan status row.

**Out of scope**:

- Publishing representative anchors inline; changing confidence/severity
  thresholds or caps; weakening concrete-text/confirmation requirements;
  verifier, promotion, or human-attention behavior; private eval edits.

## Git workflow

- Branch: `fix/verified-low-confidence-publication`
- Suggested commit: `fix(composer): publish verified anchorless deltas summary-only`
- Do not push or open a PR unless asked.

## Steps

### Step 1: Make allowlist membership carry verdict quality

A candidate id qualifies only when its verdict is keep/revise,
`requiredEvidencePresent === true`, `falsePositiveRisk !== "high"`, and
`verificationIncomplete !== true`. Test each rejection condition and valid
keep/revise controls.

Qualification is representative-local at publication: the final
`finding.id`, not any arbitrary `mergedCandidateId`, must be allowlisted. A
non-representative sibling cannot lend hatch eligibility; a non-qualifying
sibling cannot revoke an otherwise qualifying representative.

Add a two-member matrix covering both directions. STOP if `finding.id` is not
the canonical representative at `applyCaps`; that would invalidate this rule.

**Verify**:
`pnpm exec vitest run tests/pipeline-phase5.test.ts` -> all matrix cases pass.

### Step 2: Split the hatch into anchored and anchorless outcomes

Replace the boolean helper with `publish | publish_summary_only | suppress`.
Keep every existing requirement except the anchor check:

- low confidence;
- qualifying representative id;
- pre-cap publication not already suppressed;
- behavior-delta category;
- concrete changed code, non-empty related code, failure mode,
  why-this-matters, and confirmation path.

Return `publish` when a trusted model or merged-recovered anchor survives with
`changedLine: true`. Return `publish_summary_only` when no anchor survives.
Any inconsistent anchor/changed-line shape or failed requirement suppresses.

`toFinalFinding` normally derives `changedLine` from anchor presence, so the
inconsistent shape is not reachable through ordinary composition. Keep the
defensive suppress branch because the helper accepts a structural
`FinalFinding`, but do not export private `applyCaps` or add an artificial
pipeline fixture solely to exercise that branch. The anchored, anchorless, and
failed-requirement integration controls are the required tests.

In `applyCaps`, force the anchorless outcome to `summary-only`, never inline.
Record downgrade reason `low-confidence-anchorless` when applicable. Preserve
the ordinary `maxFindings` report cap and all high/critical guarantee behavior.
Extend `low_confidence_verified_delta_published` with `anchorless` and applied
publication; keep the event name.

**Verify**:
`pnpm exec vitest run tests/pipeline-phase5.test.ts` -> existing anchored and
broad-suppression controls plus both new outcomes pass.

### Step 3: Prove the run-55 path and negative boundaries

Build a promotion-shaped composer input with a valid gate-only representative
anchor, low confidence, concrete logic-bug evidence, and a qualifying medium-
risk keep. Let composition itself withhold the anchor. Assert:

- anchor withholding still fires;
- the finding publishes summary-only with no inline location;
- the hatch event records `anchorless: true`;
- selection has no confidence-threshold suppression;
- the review is not the no-findings fallback.

Negative controls: vague failure mode, evidence-absent verdict, high-risk
verdict, incomplete verdict, reject, pretrim suppression, non-qualifying
representative with qualifying sibling, and report-cap overflow. Preserve the
existing trusted-anchor inline control.

Document the contract, run all gates, then run at least 10 repeats of
`49f4645b` plus both quiet cross-cases. A qualifying representative must never
end with `confidence-threshold`; no representative anchor may publish inline;
and any new `should_not_find` violation is stop-ship evidence that the verdict
gate is too loose, not a reason to tune the eval.

**Verify**: all commands exit 0; `git diff --check` is silent; only Scope files
and the plan status row changed.

## Done criteria

- [ ] Allowlist membership requires evidence-backed, non-high-risk, complete
      keep/revise.
- [ ] Hatch eligibility belongs to the final representative id.
- [ ] Trusted anchored findings retain current publication; qualified
      anchorless findings publish summary-only and never inline.
- [ ] Anchor withholding, negative boundaries, merged-member matrix, and
      report cap remain correct.
- [ ] Focused, full, build, repeat, and cross-case guards pass.
- [ ] Only Scope files and the plan status row changed.

## STOP conditions

Stop if the fix requires publishing a representative anchor, changing a cap
or threshold, weakening concrete-text checks, touching verifier/promotion/note
code, or if `finding.id` is not the representative. Also stop on cross-case
regression or two focused-test failures after a reasonable correction.

## Maintenance notes

Issue 106 reduces how often this path is needed; this plan guarantees the
remaining floor. If summary-only noise rises, tighten the structured verdict
gate—not the placement invariant and not the eval cases.
