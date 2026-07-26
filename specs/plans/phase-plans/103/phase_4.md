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

## Paid validation log

| Step | Executions | Cost | Result |
| --- | ---: | ---: | --- |
| Matcher-calibration smoke, cap 1, repeat 1 | 1 | `$1.5154` | **pass, 4/4 expectations**, zero losses |
| Realism draws, three unpinned cap-5 runs | 3 | `$2.8480` | **gate failed 0/3** |

**Total spend `$4.3634`** of the `$300` ceiling. The `$27.36` curve was not run.

## The realism gate failed — stop condition reached

All three unpinned draws placed every target in a **three**-hunk packet, not five, and put **all three targets in the same packet**:

```
draw 1   packet deep  3h  starts: 59, 617, 806
draw 2   packet deep  3h  starts: 59, 617, 806
draw 3   packet deep  3h  starts: 59, 617, 806
```

The real planner grades exactly the three bug hunks `deep` and everything else `normal`/`light`, so the fifteen atoms split across three coverage partitions. The authored plan's uniform `normal` coverage produces one partition and five-hunk packets; production produces three partitions and a three-atom deep packet. The curve would have measured dilution at a packet shape production does not build for these hunks.

It also collapses the independence the fixture was designed for: three targets in one packet is one model conversation, not three, which is the clustering defect the treatment proof was written to prevent — reappearing through the planner rather than through my choice of line numbers. Draws 1 and 3 are byte-identical, so this is deterministic behaviour, not sampling variance.

**Cause: the fixture violates this plan's own rule 3** — *each bug must be one the planner grades ordinarily; a bug obvious enough to draw a `deep` grade on its own lands in a different partition and never packs*. Comparator-boundary bugs are exactly that obvious. This is the same structural finding the artifact-only diagnostics produced before implementation, now confirmed live: the planner grades risky hunks differently from their safe siblings.

Per the pre-registered stop condition, the fixture must be redesigned before any reviewer call. The gate cost `$2.85` and prevented `$27.36` of measurement at the wrong shape.

### Three ways forward, for the owner to choose

1. **Subtler bugs.** Rewrite the three defects so the planner grades them `normal`, putting them in the majority partition. Risk: a bug subtle enough to be graded ordinary may also be one the reviewer never finds, collapsing `R1` and voiding the curve from the other direction.
2. **Re-target the curve at the shape production builds.** Measure 1 → 2 → 3 rather than 1 → 3 → 5, since a three-atom deep packet is what these hunks actually produce. Needs more bug-bearing atoms so targets do not share a packet at the upper caps.
3. **Keep the authored plan and downgrade the claim.** Run the curve as a controlled isolation instrument and state explicitly that it measures dilution at a five-hunk shape the planner did not choose for this fixture, so it bounds harm rather than describing production.

Option 2 is the most faithful to what the plan is trying to establish, and it is the cheapest to reach from here.

### Side evidence, not a gate result

The three unpinned draws are real cap-5 recall samples under a live planner: two found all three bugs, one lost the retry bug at verification (`lost-at-verification=1`, zero missed before candidate generation). The pinned cap-1 smoke run found all three. Nine of ten target opportunities were hit across four paid executions. This is not a controlled comparison and decides nothing, but nothing so far suggests packing is harmful.

## Superseded plan

**The smoke run replaced the planned fake-provider validation.** The fake runner emits a generic trigger-based finding, so it can only exercise wiring, not matcher semantics — and matcher semantics is exactly what killed three of Plan 102's executions. One real cap-1 execution answered the real question instead: all three bugs found, the `AtCapacity` control correctly not flagged, `missed-before-candidate-generation=0`, `lost-at-verification=0`, `partial-match=0`. No matcher calibration was needed.

It also confirmed the pinned-plan seam end to end: `planner_plan_pinned` fired once, Stage 5 made no planner call, and Stage 6 produced exactly 15 packets at cap 1 — the treatment-proof shape, now verified in a live review rather than only model-free.

**Cost is 2× the plan's projection.** Measured `$1.5154` per execution against the `$0.78` estimated from Plan 102's Go fixtures — this fixture is larger (15 hunks, 935 lines) and runs at `reasoning: high` on `claude-opus-4-8`. Revised projections:

| Phase | Executions | At `$1.52` |
| --- | ---: | ---: |
| Smoke (spent) | 1 | `$1.52` |
| Realism draws | 3 | `$4.56` |
| Curve, 6 repeats × 3 arms | 18 | `$27.360` |
| Reserved extension, if triggered | 18 | `$27.36` |
| Reserved Void rerun, if triggered | 18 | `$27.36` |
| Production capacity pair | 2 | `$50` |
| **Worst case, all contingencies** | | **`$138`** |

Comfortably inside the `$300` ceiling; the plan's `$119` reservation would have been tight had both contingencies fired.

### Original remaining-work list, now superseded by the gate failure

1. **Step 6 — the pinned-plan seam.** Versioned `PinnedPlanArtifact` with `baseSha`, `headSha`, `planSha256` over a canonical sorted-key serialization; `review.pinnedPlanPath` validation failing closed on wrapper schema, plan schema, hash, base, head, and hunk-ID membership; `scripts/draw-pinned-plan.ts` as an internal script rather than a CLI verb; one test per failure mode.
2. **Eval case YAMLs** — `cap1.yml`, `cap3.yml`, `cap5.yml` at `repeat: 6`, cache off, `lang/go` only, identical except `packMaxHunks`, all pinned to one authored plan.
3. **Expectation validation under the fake provider** — confirm each `should_find` matcher fires on the expected finding shape, and the `should_not_find` control does not, for `$0`.
4. **Authored frozen plan plus three reference draws** and the realism report requiring at least 2 of 3 to place every target in a five-hunk packet at cap 5.

Only after all four does the `6 × 3` curve run.

## Outcome

_Preconditions complete; paid validation not started._
