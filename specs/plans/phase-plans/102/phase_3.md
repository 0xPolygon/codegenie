---
status: complete
---

# Phase 3: One-Repeat Packet-Packing Treatment Preflight

## Overview

Implement Plan 102 step 7 only. This phase creates two private, materializable Go fixtures and six repeat-one A/B/C recall cases, records the owner-approved paid-validation ceiling before model use, executes the cache-off one-repeat suite, and runs the exact cohort report preflight. The first cohort is retained as treatment-invalid evidence: it exposed real independent-planner variance, a fixture/config incompatibility, and three report artifact-contract bugs. This phase fixes the report bugs, repairs and revalidates the fixtures without model calls, and stops with a second paid repeat-one cohort pending. One-sample recall is measurement only; retry execution, repeat-10 execution, arm selection, collateral checks, production validation, rollout, and teardown remain out of scope.

## Steps

1. Reconcile current drift and working-tree state for Plan 102, inspect the private-eval conventions and existing eval schema, and record `approvedValidationCostUSD: $500` (superseding the earlier $200 authorization), current actual spend, preflight projection assumptions, and authorized scope in Plan 102 before any paid model call.
2. Create `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-packing/recall/repos/dilution-control/{base,feature}` as a compact materializable Go repository. Put a locally detectable boundary regression in one separated function and safe unrelated edits in separated sibling functions so A keeps the target in one source atom while B/C combine it with unrelated atoms.
3. Create `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-packing/recall/repos/cross-atom-consistency/{base,feature}` as a compact materializable Go repository. Change five separated sibling functions so four add a shared validation/veto while the fifth omits it, and keep baseline atom boundaries separate while allowing B/C to combine the inconsistent siblings.
4. Add `dilution-{a,b,c}.yml` and `consistency-{a,b,c}.yml` with `repeat: 1`, cache disabled, precise candidate/final expectations, and identical model/provider/reasoning/concurrency/depth/lens/time/token settings. Limit arm differences to A `false`/`base`, B `true`/`base`, and C `true`/`atom-scaled`.
5. Parse/materialize the private suite without model calls and compare all six YAMLs structurally to prove that only the permitted arm fields and case-specific identity/fixture/expectation fields differ.
6. Run `pnpm dev -- eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/packet-packing/recall --no-cache` once, then run the exact `pnpm exec tsx scripts/packet-packing-report.ts eval --logs .../recall/logs --cohort latest --expected-repeats 1 --output /tmp/plan102-eval-preflight.json` command.
7. Inspect and preserve the invalid cohort evidence. Record invocation/cohort/run IDs, the immutable failed-report path/hash, actual preflight and cumulative costs, `10 * preflightCostUSD`, projected spend assumptions, the active $500 ceiling, target telemetry, root-cause classification, and one-repeat recall limitations. Stop paid work because all four B/C target treatments are invalid.
8. Fix only the three demonstrated report artifact-contract defects: packet-ID attention reconciliation, Stage-9 uncertainty-promotion provenance, and the distinction between valid A-side Stage-6 lens pruning and B/C routed-lens loss. Add focused positive/negative regressions and rerun the report locally over the immutable cohort to expose the remaining real treatment failures.
9. Repair the private deterministic preconditions without model calls. Restrict all arms to `lang/go`, make every sibling hunk a plausibly comparable boundary/validation-risk change while retaining the dilution boundary bug and consistency omission, rerun strict YAML/arm parsing, materialized Go tests, and the local atom/packing/cap/profile/budget/rank validator. Record the retry as pending; do not start it.
10. Run the focused Plan 102 test command, `pnpm run check`, the complete test suite, and the build. Do not change any case to repeat ten, run a later paid phase, select an arm, remove experiment flags, or commit.

## Tests

- `private packet-packing suite parses and materializes`: verifies all six strict YAML cases load with `lang/go` only, both Go repos materialize, and main/feature compile and pass `go test ./...` without model use.
- `A/B/C structural comparison`: verifies repeat/cache/model/provider/reasoning/concurrency/depth/lenses/time/token/fixture/expectation inputs match within each case and only the two permitted review fields differ across arms.
- `report artifact-contract regressions`: verifies attention joins by unique packet ID regardless of producer order, admits Stage 9 only for relational uncertainty promotion, and preserves the distinction between requested and validly routed lenses while still detecting B/C routed-lens loss.
- `local repaired treatment validator`: assigns identical normal coverage and `lang/go` to every hunk, then verifies A target packets contain one source atom, B/C targets combine all source atoms and reduce target-file packets, and all hunk/atom/cap/coverage/lens/profile/budget/rank invariants pass with zero model calls.
- `repository focused and complete gates`: verifies packet packing, configuration, eval loading, reporting, type/lint/format checks, all tests, and the production build remain clean after evidence is recorded.
