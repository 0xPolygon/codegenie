---
status: complete
---

# Phase 4: One-Repeat Treatment Retry

## Overview

Complete only the repaired retry of Plan 102 step 7. Re-verify the six current strict private cases, both materializable Go fixtures, the no-model treatment proof, budget authorization, and exact clean runtime provenance at commit `bb96fd3`. Then execute one cache-off repeat-one A/B/C invocation, analyze that exact invocation UUID with the packet-packing report, preserve the resulting JSON report immutably, and reconcile actual/projected validation spend. The retry gate failed: consistency B/C did not treat the target, and independently sampled B/C planner hints changed standalone profiles relative to A in both families. The phase stops without a third paid invocation. One-sample recall remains measurement only. Repeat ten, arm selection, collateral, production validation, rollout, and teardown remain out of scope.

## Steps

1. Confirm `HEAD` is exactly `bb96fd3439c715130756a93efd8e679772f81a9b`, the repository and Plan 102 in-scope paths are clean, all six private YAMLs remain `repeat: 1`, and the invalid cohort/logs/report retain their recorded hashes and contents.
2. Hash the six current YAMLs and both fixture trees, strictly load the suite, compare A/B/C definitions within each family, and prove that arm differences remain limited to name plus `review.packSameFileHunks` and `review.packedToolBudgetMode`. Verify cache disabled and the exact provider/model/reasoning/concurrency/depth/lens/time/token/cost settings.
3. Materialize both fixture base/feature repositories without model calls and run `go test ./...` in every materialized revision. Re-run the deterministic local treatment validator to prove exact hunk/atom order and bijection, five-hunk/12K caps, coverage/lens/profile/budget/rank invariants, A one-atom targets, B/C multi-atom targets, and reduced packed packet counts.
4. Reconcile the paid gate immediately before launch: cumulative actual spend is `$5.207657`; the retry reserves at most `$60`; the placeholder repeat-10 projection is `$52.076570`; the known later production reservation is `$95`; and `$212.284227 <= approvedValidationCostUSD: $500`. Record exact clean runtime provenance and launch exactly one complete `pnpm dev -- eval --eval-dir .../recall --no-cache` invocation.
5. Resolve the new invocation UUID and its six review run IDs from the invocation manifest. Run exactly `packet-packing-report.ts eval --cohort <new invocation UUID> --expected-repeats 1`, never `latest`, and inspect the JSON for zero provider/configuration/evidence failures, valid B/C treatment in both families, and every deterministic/artifact invariant.
6. Copy the new JSON report without altering it into `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-packing/reports/`, record its SHA-256, and leave the invalid cohort, all logs, and all reports untouched. If treatment or report validation fails, stop with the exact diagnosis and do not launch a third paid invocation.
7. Update Plan 102 reconciliation with invocation/cohort/run/review IDs, per-run and exact cohort cost, cumulative actual cost including `$5.207657`, `10 * validPreflightCostUSD`, the known future `$95` production reservation, total projected spend, and comparison with the `$500` ceiling. State that one-repeat recall is measurement only and that steps 8–12 remain `not_run`.
8. Run the focused Plan 102 tests, repository checks, complete test suite, and build. Do not change any private case to repeat ten, select an arm, start collateral or production validation, or tear down experiment scaffolding.

## Tests

- `clean runtime provenance and immutable evidence`: proves the paid command ran from exact commit `bb96fd3`, with a clean worktree, and that the prior invalid cohort/logs/report remained byte-identical.
- `strict repaired suite preflight`: proves all six repeat-one YAMLs parse, use only `lang/go`, differ only by the two permitted arm settings, disable cache, and retain identical paid configuration within each family.
- `fixture materialization and no-model treatment proof`: proves both fixture revisions pass `go test ./...` and the deterministic A/B/C treatment validator passes all atom, packet, cap, coverage, lens, profile, budget, and rank invariants without model calls.
- `exact paid cohort report`: proves the explicit new invocation contains six complete executions, both B/C arms receive the target treatment for both cases, paid evidence and costs reconcile, and all deterministic/artifact failure lists are empty.
- `repository focused and complete gates`: verifies packet packing, configuration, eval loading, reporting, lint/format/type checks, all tests, and the production build remain clean after reconciliation.

## Outcome

Invocation `5bd80f2c-865e-40f0-a605-07387138b904` completed six cache-off executions with zero errored cases and authoritative reconstructed cost `$3.986221`. The exact explicit-cohort report exited `1` with two consistency `insufficient_treatment` failures and four cross-arm standalone-profile `treatment_invariant` failures. It is preserved at `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-packing/reports/plan102-eval-preflight-retry-invalid-5bd80f2c.json`, SHA-256 `650113d24d092e6fd712303e1828b297010c76f672d7efb799f5081f79635517`. Cumulative actual validation spend is `$9.193878`, within the `$500` ceiling. Steps 8–12 remain `not_run`; the next separately reviewed phase owns the required step-12 failure teardown.
