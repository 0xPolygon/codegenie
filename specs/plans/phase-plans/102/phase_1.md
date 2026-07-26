---
status: complete
---

# Phase 1: Dark Same-File Packet Packing

## Overview

Implement Plan 102 steps 1–4 only. This phase adds temporary experiment configuration, preserves the current hunk-first groups as explicit indivisible atoms, packs only compatible same-file atoms behind the dark flag, preserves each atom's exact standalone review profile and routed-lens/focus safeguards, emits Stage-6 treatment provenance, and keeps base versus atom-scaled tool budgets experimentally separable. The report script, retained-run replay, paid evals, rollout decision, and teardown remain out of scope.

## Steps

1. Extend `src/types.ts`, `src/config/schema.ts`, `src/config/config-loader.ts`, and `src/evals/eval-runner.ts` with temporary `review.packSameFileHunks: boolean` and `review.packedToolBudgetMode: "base" | "atom-scaled"` fields. Default them to `false` and `base`, apply user/repository/eval overrides through strict schemas, mark both repository-safe, record config-source winners, and expose the effective values in eval run metadata.
2. Refactor only `hunkFirstGroups()` results in `src/pipeline/packet-builder.ts` into internal hunk-first groups and explicit packet atoms. Give atoms stable ordered-hunk IDs, exact rendered patch size, source position, effective coverage, normalized sorted/deduplicated planner-lens signature, and the exact standalone packet profile derived by the existing Stage-6 build path. Preserve the direct whole-file and content-probed file-diff returns, and bypass all atom work when packing is disabled so packet artifacts, IDs, order, profiles, context, lenses, and budgets remain unchanged.
3. Add a stable compatible-atom pass for hunk-first atoms only. Partition by effective coverage and normalized planner-lens signature, greedily pack in partition source order under five-hunk/12,000-character caps, restore packet order by first source position, preserve atom and hunk ordering, merge degradation reasons deterministically, and rebuild packet kind/context/routing/dispatch rank through existing helpers. Dry-build candidates against isolated relationship telemetry so a newly lost standalone routed lens or high/critical focus note leaves atoms separate. Apply an explicit `simple < standard < investigate` profile floor from exact standalone profiles and emit `same_file_atoms_packed` Stage-6 provenance without changing prompts or packet IDs.
4. Add the isolated budget policy in `src/pipeline/packet-builder.ts`. `base` uses the existing budget from the effective profile. `atom-scaled` applies only to non-simple packets that combine multiple pre-existing atoms, adds at most one call and 2,000 result characters per additional atom subject to 1.75x ceilings, leaves investigation rounds and source-extension policy unchanged, and applies `budgetBoost` last.
5. Add focused coverage in `tests/config-loader.test.ts`, `tests/evals.test.ts`, and `tests/pipeline-phase5.test.ts` for strict/default/source config behavior, eval propagation, flag-off parity, atom identity/profile capture, whole-file bypass, compatible packing, atom/cap/source-order/coverage/lens/focus/degradation/dispatch invariants, relationship-driven profile floors (including `symbol_mention`, `planner_hint`, ordinary context, `primarySymbols`, and `same_symbol` controls), Stage-6 provenance, and base/atom-scaled budgets.
6. Run the focused Plan 102 commands, then the full repository workflow: `pnpm run check`, `pnpm test`, and `pnpm build`. Fix all failures without implementing Plan 102 step 5 or later.

## Tests

- `config loader defaults and precedence for packet-packing experiment fields`: proves `false`/`base` defaults, repository-safe overrides, source attribution, and strict enum rejection.
- `eval packet-packing review overrides`: proves strict YAML parsing, both overrides reaching effective run config, and invalid budget modes failing closed.
- `packet atom flag-off parity and whole-file bypass`: proves dark mode preserves packet/artifact shape and direct whole-file/file-diff construction never enters the packer.
- `same-file packing compatibility and invariants`: proves atoms remain indivisible, coverage and requested-lens boundaries hold, interleaved partitions restore stable order, all hunks appear once in source order, caps split correctly, degradation reasons merge deterministically, and dispatch rank uses the existing combined changed-line formula.
- `same-file packing focus and lens safeguards`: proves a candidate that would newly omit a standalone routed lens or high/critical focus is left unpacked.
- `same-file packing profile floor`: proves absorbed strong `symbol_mention`/`planner_hint`, ordinary related context, and the same-name `primarySymbols` case cannot reduce effective profile or base budget, while `same_symbol` alone does not invent an investigate profile.
- `packed tool budget policies`: proves base parity, simple zero budget, one-atom/five-hunk parity, per-additional-atom scaling and 1.75x caps across standard/investigate/deep packets, unchanged rounds/source extension, and boost-last behavior.
