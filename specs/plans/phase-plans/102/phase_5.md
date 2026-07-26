---
status: complete
---

# Phase 5: Failed-Gate Teardown and Final Repository Gate

## Overview

Complete Plan 102 step 12 through its failed-outcome branch, then run step 13. Preserve every JSON report actually produced by completed phases and prove its immutable checksum manifest before deleting experiment scaffolding. Restore the original single packet-builder path, remove both temporary configuration fields and all experiment-only reporting, atom/profile-floor/provenance/budget/telemetry surfaces, and keep only generally useful hardening that remains independently used and tested. Retire private B/C declarations and retain an A declaration only when its baseline result satisfied the suite's existing expectation policy; keep all private fixture repositories, logs, reports, and invocation manifests unchanged. Reconcile Plan 102 as a complete failed outcome without claiming rollout, and execute the exact teardown checks plus the full repository gate without model calls.

## Steps

1. Reconcile the clean Phase 4 commit against pre-experiment commit `5aca256`, classify every experiment-series change as required teardown, dead report support, or independently used hardening, and verify that no unrelated working-tree changes overlap the phase.
2. Before product deletion, stage `/tmp/plan102-packet-shape.json` in the workspace together with a private-evidence application manifest. Verify the deterministic replay hash `77af0c38937bd6957806f05ad201cbad32461414c1d667824096208473c276fa` and both immutable invalid-preflight hashes already under the approved private reports root. Define `manifest.sha256` over exactly those three preserved JSON report basenames, then ask the primary context to mechanically copy the replay and install the manifest without changing any existing report, log, or invocation artifact.
3. Restore the pre-experiment packet-building product path in `src/pipeline/packet-builder.ts`: remove compatible-atom packing, atom-scaled budgets, atom wrappers/IDs/provenance, member-atom profile floors, treatment telemetry, and experiment-only exported helpers or metadata while preserving the original `hunkFirstGroups()` behavior and packet budgets.
4. Remove `packSameFileHunks` and `packedToolBudgetMode` from `src/types.ts`, `src/config/schema.ts`, `src/config/config-loader.ts`, `src/evals/eval-runner.ts`, and every remaining eval/config/runtime artifact path. Remove dead report-only support from eval artifacts/commands, pipeline composition/review/verification, telemetry artifacts, and tests unless a surface remains generally used and independently covered after the report is gone.
5. Delete `scripts/packet-packing-report.ts` and `tests/packet-packing-report.test.ts`; remove all packet-packing-only cases from `tests/pipeline-phase5.test.ts`, `tests/config-loader.test.ts`, and `tests/evals.test.ts`, preserving focused tests for the restored baseline behavior. Confirm no packet-packing golden fixture exists.
6. Stage private suite mutations in the workspace for primary-context mechanical application. Remove `consistency-{b,c}.yml` and `dilution-{b,c}.yml`. Because `consistency-a` failed both declared expectations and `dilution-a` failed its final expectation, remove both active A declarations under the suite's existing pass policy. Do not touch `repos/`, `logs/`, `reports/`, invocation manifests, or create production/collateral cases.
7. Update Plan 102 with the final evidence inventory, both paid invocation UUIDs and all twelve review run IDs, private log/report paths and hashes, final cumulative cost `$9.193878` against the `$500` ceiling, steps 8–11 as `not_run` for the failed repaired retry gate, and step 12 complete through baseline restoration. Mark the plan and plan index `COMPLETE (failed gate; baseline restored)` according to repository conventions and update any affected normative project documentation only where it currently describes the temporary experiment as shipped behavior.
8. Run the exact evidence-manifest checksum check, both live-code/private-active-YAML retired-field greps, strict private suite parsing with no model calls, report script/test absence, and focused baseline tests. Verify the private report directory contains exactly the three produced JSON reports covered by `manifest.sha256` and that fixture repositories, logs, reports, and invocation manifests remain present and unchanged.
9. Run the complete step-13 gate: `pnpm run check`, `pnpm test`, `pnpm build`, and `git diff --check`. Iterate until every check passes and report the failed-outcome teardown ready for review without committing.

## Tests

- `evidence manifest`: `sha256sum -c manifest.sha256` passes for exactly the deterministic replay and two invalid one-repeat preflight reports.
- `live-code teardown`: retired config names have no matches under `src`, `scripts`, `tests`, or `evals`; report script and report tests do not exist.
- `private active declarations`: no retired fields remain in active YAML, B/C and failing A declarations are absent, retained suite directories strictly parse when active YAML exists, and no model call is made.
- `focused baseline behavior`: `pnpm test -- tests/pipeline-phase5.test.ts tests/evals.test.ts` passes with the original `hunkFirstGroups()` packet path and ordinary tool-budget behavior.
- `complete repository gate`: `pnpm run check`, `pnpm test`, `pnpm build`, and `git diff --check` all exit zero.

## Outcome

The failed-outcome branch is complete. Three produced JSON reports are preserved under the private reports root and pass their exact three-entry manifest; both fixture repositories, all 12 paid run directories, and both invocation manifests remain unchanged. All six active A/B/C declarations were retired because neither A baseline satisfied the suite's all-expectations-pass policy. The live product, configuration, eval, telemetry, report, and test surfaces are restored to the pre-experiment baseline with no dark packing path. Plan 102 and its index record `COMPLETE` as a failed gate with baseline restoration, steps 8–11 remain `not_run`, cumulative spend is `$9.193878` against the `$500` ceiling, and the focused plus complete repository gates pass without model calls.
