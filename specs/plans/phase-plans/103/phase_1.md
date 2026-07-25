---
status: complete
---

# Phase 1: Dark Compatible-Atom Packing

## Overview

Implement Plan 103 steps 1–3 only. This phase adds the two eval/internal-only settings, wraps today's `hunkFirstGroups()` output as explicit indivisible atoms, and implements Plan 102's compatibility partition and source-order greedy fill behind the dark flag. It reproduces Plan 102's already-validated packet counts and nothing more.

Multi-member symbol context, transactional rejection, the profile floor, the pinned-plan seam, the report script, and every paid phase are out of scope. Because this phase deliberately stops short of the context work, packing must remain **off by default** and no packed packet may be dispatched in a real review until Phase 2 lands — a packed packet without multi-member context would silently drop non-primary members' surrounding source.

## Steps

1. Add `review.packCompatibleAtoms: boolean` (default `false`) and `review.packMaxHunks: number` (default `5`, rejected above `MAX_HUNKS_PER_PACKET`) to `CodegenieConfig`, `codegenieConfigSchema`, and `defaultConfig`. Add both to the strict eval-case `review` schema and `applyCaseReviewConfig()`. Do **not** add either to `rawConfigSchema`, `DEFAULT_SOURCE_PATHS`, or `REPO_SAFE_REVIEW_KEYS`: no `codegenie.toml` may set them and no config-source attribution is claimed for a value that cannot come from a config file. Add `evals/packet-dilution/logs/` and the currently missing `evals/skill-semantics/logs/` to `.gitignore`.
2. Refactor `hunkFirstGroups()` results in `src/pipeline/packet-builder.ts` into explicit packet atoms without changing their membership. Each atom carries its ordered `PlannedHunk[]`, hunk count, `combinedPatchChars()` size, first source position, effective coverage, normalized planner lens signature (stable serialization of the sorted deduplicated union of `decision.lenses`), and a stable ID derived from ordered hunk IDs. **Scope correction:** the plan's atom description also lists standalone review profile and standalone per-member context quality. Both require the dry-build machinery that Phase 2 owns, and neither is needed to partition or fill, so they are captured in Phase 2 alongside the transactional evaluation that computes them rather than half-built here. Preserve the direct `whole-file` and content-probed `file-diff` returns from `groupHunks()` so they bypass the packer entirely, and bypass all atom work when the flag is off so packet artifacts, IDs, ordering, profiles, context, lenses, and budgets stay byte-identical.
3. Implement the compatibility partition and fill. Partition each file's atoms by `(effectiveCoverage, normalizedPlannerLensSignature)`; fill greedily in source order under `packMaxHunks` and `MAX_PATCH_CHARS`; order packets by earliest member hunk and render each packet's hunks by file position. Materialize combined groups through the existing `packetGroup()`/`packetKind()` rules, carry non-empty `degradationReason` values through a sorted deduplicated `"; "` join, do not synthesize `wholeFileText` or `fileContext`, and recompute `dispatchRank` with the unchanged `packetDispatchRank(filePath, facts, combinedChangedLines)` formula.
4. Add focused coverage in `tests/config-loader.test.ts`, `tests/evals.test.ts`, and `tests/pipeline-phase5.test.ts`.
5. Run the focused commands below, then `pnpm run check`, `pnpm test`, and `pnpm build`. Fix all failures without starting Phase 2.

## Tests

- `config defaults and eval-only surface`: proves `false`/`5` defaults, eval-case overrides reaching resolved config, `packMaxHunks > 5` rejected, and a `codegenie.toml` setting either key failing strict parsing rather than being silently accepted or filtered.
- `packet atom identity and flag-off parity`: proves atoms preserve today's group membership exactly, atom IDs are stable under reordering of equivalent inputs, and flag-off packet artifacts and telemetry are byte-identical to the pre-change baseline.
- `whole-file bypass`: proves direct whole-file and content-probed file-diff groups never enter the packer.
- `compatible partition and fill`: proves atoms are never split, every reviewable hunk appears exactly once, hunks render in file position order within a packet, packets order by earliest member, coverage and lens signature both gate membership, cap splits occur at `packMaxHunks` and `MAX_PATCH_CHARS`, interleaved partitions restore stable order, degradation reasons merge deterministically, and dispatch rank equals the existing formula over combined changed lines.
- `packMaxHunks parameterization`: proves caps of 1, 3, and 5 produce the packet shapes the Phase 4 curve depends on.

## Verification commands

```bash
pnpm exec vitest run tests/config-loader.test.ts tests/evals.test.ts
pnpm exec vitest run tests/pipeline-phase5.test.ts
pnpm run check && pnpm test && pnpm build
```

## Outcome

Complete. `pnpm run check`, `pnpm test`, and `pnpm build` all pass; the suite grew from 761 to 773 tests with no existing test modified.

**Config surface.** `review.packCompatibleAtoms` (default `false`) and `review.packMaxHunks` (default `5`) exist in `CodegenieConfig`, `codegenieConfigSchema`, `defaultConfig`, the strict eval-case schema, and `applyCaseReviewConfig()`. They are absent from `rawConfigSchema`, `DEFAULT_SOURCE_PATHS`, and `REPO_SAFE_REVIEW_KEYS`, and tests prove a `codegenie.toml` or user `config.toml` setting either key throws `invalid config file` rather than being silently filtered. `MAX_PACK_HUNKS` is duplicated in `schema.ts` rather than imported from `packet-builder.ts` to keep the config schema free of pipeline dependencies; a test asserts it equals 5 and the resolved schema rejects 6.

**Packer.** `PacketGroup` gained a required `origin` field so the direct whole-file and content-probed file-diff returns are structurally excluded from packing rather than inferred from `kind`, which is ambiguous — `packetGroup()` can also produce `file-diff`. `packCompatibleAtoms()` partitions a file's atoms by `(effectiveCoverage, normalizedLensSignature)`, fills sequentially in source order under `packMaxHunks` and `MAX_PATCH_CHARS`, orders packets by earliest member, and rebuilds combined groups through the existing `packetGroup()`/`packetKind()` rules with degradation reasons merged by sorted deduplicated join.

Fill is sequential-flush, matching Plan 102's described algorithm, not the best-fit search used in the planning simulation. Sequential preserves strict source order; best-fit would let a later small atom jump ahead of an earlier larger one. The two differ by about one packet on the retained runs, inside the documented residual, and Phase 3's replay measures the real number.

**Verified behaviours.** Packing 6 compatible atoms at cap 5 yields `[h1-h5][h6]`; a one-hunk cap is byte-identical to flag-off (asserted by full artifact comparison, which is the strongest parity check available without a pre-change baseline); a `deep` hunk among `normal` siblings and a `core/tests` hunk among `core/code-review` siblings both stay separate; every hunk appears exactly once with in-packet source ordering; a two-hunk atom survives a one-hunk cap intact; whole-file groups never enter the packer; dispatch rank equals the existing formula over combined changed lines; and caps 1/3/5 over 15 atoms produce exactly the 15/5/3 packet shapes Phase 4's recall curve depends on.

**Not yet safe to enable.** Multi-member symbol context is Phase 2. Until it lands, a packed packet containing atoms with different primary symbols would carry only the top-ranked symbol's source, leaving the rest as bare diffs. The flag stays `false` and no packed packet may reach a real review before Phase 2.
