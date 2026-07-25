---
status: complete
---

# Phase 2: Multi-Member Context, Transactional Rejection, and the Profile Floor

## Overview

Implement Plan 103 steps 4–5, plus the atom metadata deferred from Phase 1. A packed packet now carries surrounding source for every member symbol under an explicit budget, candidates are evaluated in isolation and abandoned rather than committed when they would lose something, and a packed packet can never review below its strongest standalone member's profile.

The pinned-plan seam, the report script, the replay, and every paid phase remain out of scope.

## Steps

1. Add `PACKET_SYMBOL_CONTEXT_BUDGET = 5_000`, `MIN_MEMBER_SYMBOL_CHARS = 800`, and `MIN_SLICED_MEMBER_CHARS = 600`, and implement `readMemberSymbolSources()`: participants are distinct resolvable primary symbol identities, each gets `floor(budget / count)` subject to the floor, one redistribution pass hands surplus from members needing less to members needing more in source order, and a single-symbol packet delegates unchanged to `readEnclosingSymbolSource()` so flag-off behaviour is untouched.
2. Thread member symbol facts through `buildContext()` and `buildPacket()`, and return per-member emitted characters alongside the packet.
3. Apply the profile floor **before** lens routing, since `routedPacketLenses()` prunes `core/code-review` at a `simple` profile — raising the profile afterwards would leave a lens dropped that the floor exists to preserve.
4. Evaluate every multi-atom candidate transactionally: build each member standalone and the candidate itself against a scratch relationship accumulator and a suppressed telemetry sink, compare, then either rebuild for real or emit the members separately with a recorded reason.
5. Add focused coverage and run the full repository gate.

## Tests

- `renders every member's symbol source in a packed packet`: three distinct symbols all appear in the packed context.
- `keeps symbol source inside its budget`: symbol section stays within the 5,000-character allowance, total context within 8,000, and all four members survive final rendering.
- `cannot starve a member at the shipped cap`: pins the arithmetic that makes the budget rejections dormant at cap 5.
- `floors a packed profile to its strongest standalone member`: a `same_symbol` edge absorbed by packing cannot lower the effective profile below what the members held alone.
- `shares one symbol budget when packed members resolve to the same symbol`: identical name *and* range is one participant, not several.

## Verification commands

```bash
pnpm exec vitest run tests/pipeline-phase5.test.ts
pnpm run check && pnpm test && pnpm build
```

## Outcome

Complete. `pnpm run check`, `pnpm test`, and `pnpm build` pass; 773 → 778 tests with no existing test modified.

**Multi-member symbol context.** `readMemberSymbolSources()` reads every distinct primary symbol under a shared 5,000-character budget, leaving at least 3,000 of `MAX_CONTEXT_CHARS` for outline, tests, and hints. Symbol source renders at the head of the packet context and `truncateTail()` keeps the head, so the reserve is what guarantees survival — the budget cannot be crowded out by later sections. Per-member survival is nevertheless verified against the final rendered text by locating each member's `Primary symbol:` header, so rule 7 is checked rather than assumed.

**Transactional evaluation.** Candidates dry-build against `scratchRelationshipGraph()` — a shallow clone with fresh `relatedContextAttached`/`relatedContextOmitted` accumulators — and a quiet telemetry sink, with throwaway symbol-context and build metrics. Only a candidate that passes every check is rebuilt against the real recorder. Single-atom packets build once, unchanged; packed packets cost two builds, which is acceptable given Stage-6 repository-tool runtime was 5.2 seconds across the whole motivating run.

**Profile floor.** Applied before routing, for the reason in step 3. Verified end-to-end with the case Plan 102 described: `h1` and `h3` share an enclosing symbol but are separated by `h2`, so the grouper yields three atoms with a `same_symbol` edge; packing absorbs the edge target, which would otherwise derive a weaker profile.

### Two findings that changed the design

**A short symbol is not a collapsed member.** The first implementation rejected any member emitting fewer than `MIN_SLICED_MEMBER_CHARS`, which fails a packet whose symbol is simply small — a 500-character function is *fully* represented. Members now carry a `complete` flag and only an incomplete member below the floor counts as collapsed. Without this, packing would have been rejected for most real packets; four tests caught it immediately.

**Both budget rejections are unreachable at the shipped cap, and that is now pinned.** A packet holds at most 5 hunks, so at most 5 distinct primary symbols. `5 × 800 = 4,000 ≤ 5,000`, so oversubscription cannot fire; and the smallest share is `5,000 / 5 = 1,000`, above the 600 sliced minimum, so truncation-collapse cannot fire either. They are retained as defensive invariants because the plan specifies them and because a cap increase past six would make them live. Rather than contrive an unreachable end-to-end scenario, a test pins the arithmetic so any future cap change surfaces here. Two originally-drafted tests were removed for asserting behaviour that cannot occur.

The same reasoning applies to `routed_lens_lost`: the partition key already forces identical requested lens sets across a candidate's members, so ordinary lens loss cannot occur. It remains reachable only through packet-level routing predicates such as `shouldKeepTestsLens()` reacting to a combined packet's `relevantTests`, which is why the check stays.

**Still not enabled.** The flag remains `false`. Phase 3 owns the pinned-plan seam, the report script, and the four-run replay whose fixed-slot hunk yield gate decides whether any paid phase is authorized.
