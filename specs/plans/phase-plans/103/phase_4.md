---
status: in progress (preconditions complete; no paid call yet)
---

# Phase 4: Paid Validation

## Overview

Plan 103 step 8, plus step 6 carried forward from Phase 3. Every free precondition runs before the first paid call, in the order the plan requires: fixture construction, expectation validation under the fake provider, the authored frozen plan, the reference-draw realism gate, and the model-free treatment proof.

## Authorization

**`approvedValidationCostUSD: $300`**, recorded in the plan on 2026-07-25. The owner approved the `$119` reservation and raised the ceiling to `$300`, and authorized running the production capacity pair inside this phase rather than deferring it. Provider credentials are present (`anthropic`, default `claude-opus-4-8`).

Spend to date: **`$0.00`**.

## Completed

**Fixture.** `evals/packet-dilution/repos/dilution/{base,feature}` — one Go file, fifteen independent guard functions separated by ~62 lines, comfortably beyond `NEARBY_GAP_LINES = 30`, so today's grouper yields exactly fifteen atoms. Three bugs at atom positions 1, 10 and 13:

- atom 1 — `WithinTransferLimit` changes an inclusive bound to exclusive, rejecting the limit value itself;
- atom 10 — `ShouldRetry` changes `<` to `<=`, allowing one attempt beyond the maximum;
- atom 13 — `ShardIndex` maps onto `shards + 1`, producing an index outside the configured range.

Atom 7 is the negative control: `used >= capacity` rewritten as `!(used < capacity)`, which looks like a boundary edit and is provably equivalent. The remaining eleven guards are safe range additions.

**Treatment proof.** `packet-packing-report.ts treatment` rebuilds Stage 6 at caps 1/3/5 with zero model calls and asserts the exact shape the curve depends on:

| Cap | Packets | Target packet size | Distinct target packets |
| ---: | ---: | --- | ---: |
| 1 | 15 | 1, 1, 1 | 3 |
| 3 | 5 | 3, 3, 3 | 3 |
| 5 | 3 | 5, 5, 5 | 3 |

No two targets share a packet at any cap. Preserved at `packet-dilution/reports/plan103-treatment-proof.json`.

### The proof caught a fixture defect on first run

The initial invocation targeted the hunk at line 679, which is atom **11**, not atom 10. At cap 5 that places two targets inside `[11-15]`, collapsing two of the three recall opportunities into one packet and one model conversation — exactly the clustering defect the review flagged before implementation. The `targets_share_packet` check failed closed and the target was corrected to line 617. Had the proof not existed, the curve would have run at $14 with two of three observations correlated.

## Remaining before the first paid call

1. **Step 6 — the pinned-plan seam.** Versioned `PinnedPlanArtifact` with `baseSha`, `headSha`, `planSha256` over a canonical sorted-key serialization; `review.pinnedPlanPath` validation failing closed on wrapper schema, plan schema, hash, base, head, and hunk-ID membership; `scripts/draw-pinned-plan.ts` as an internal script rather than a CLI verb; one test per failure mode.
2. **Eval case YAMLs** — `cap1.yml`, `cap3.yml`, `cap5.yml` at `repeat: 6`, cache off, `lang/go` only, identical except `packMaxHunks`, all pinned to one authored plan.
3. **Expectation validation under the fake provider** — confirm each `should_find` matcher fires on the expected finding shape, and the `should_not_find` control does not, for `$0`.
4. **Authored frozen plan plus three reference draws** and the realism report requiring at least 2 of 3 to place every target in a five-hunk packet at cap 5.

Only after all four does the `6 × 3` curve run.

## Outcome

_Preconditions complete; paid validation not started._
