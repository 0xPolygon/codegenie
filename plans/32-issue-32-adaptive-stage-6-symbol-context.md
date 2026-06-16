# Issue 32: Adaptive Stage 6 Symbol Context

Status: COMPLETE
Planned from: trails-api eval run 6 review, 2026-06-16
Planned at: commit `506fa43`

## Problem

Run 6 passed and produced a strong final review, but Stage 6 is still sending too many packets with degraded enclosing-symbol context. That likely pushes Stage 7 workers into extra repository tool loops to recover source that Stage 6 already knew how to find.

Observed in `/home/peter/Dev/0xPolygon/codeninja-private-evals/trails-api/logs/6`:

- Stage 6 built 73 packets for 131 hunks.
- Packet context quality was 38 `full`, 28 `sliced`, and 7 `outline_only`.
- That means 35 of 73 packets, about 48%, shipped with sliced or outline-only context.
- Stage 6 emitted many `packet_symbol_source_truncated` warnings for important enclosing symbols.
- Stage 7 then made 194 model calls, cost about `$17.57`, and took about 631 seconds wall time.
- Stage 7 tool use repeatedly read definitions and symbols that Stage 6 could often have attached up front.

The most suspicious implementation detail is the fixed Stage 6 symbol source cap:

```ts
const MAX_CONTEXT_CHARS = 8_000;
const MAX_SYMBOL_CONTEXT_CHARS = 3_000;
```

The total packet context budget is 8,000 characters, but every enclosing symbol source is capped at 3,000 characters before the final packet context is assembled. For large but central changed symbols, that flat cap can truncate the exact function or method the packet reviewer needs, even when the packet still has room to carry more useful symbol context.

Codeninja should adapt symbol context to packet risk and available space. It should not blindly dump larger snippets into every packet.

## Current State

- `src/pipeline/packet-builder.ts` reads enclosing symbol source during Stage 6 packet construction.
- `readEnclosingSymbolSource` renders the full symbol block, then slices/truncates it when it exceeds `MAX_SYMBOL_CONTEXT_CHARS`.
- `renderPacketContextText` later enforces the broader `MAX_CONTEXT_CHARS` cap over combined packet context.
- Packet quality can be reported as `full`, `sliced`, `outline_only`, or `path_only`.
- Some packets can currently be marked with `contextQuality: "full"` while still being degraded for other reasons, such as patch truncation. That makes Stage 6 artifacts harder to interpret.
- Earlier plans improved local source budget extensions and diagnostics, but the initial Stage 6 packet context still has a hard symbol cap.

## Non-Goals

- Do not dump whole files or whole repositories into packet context.
- Do not raise every packet's symbol context from 3,000 to 8,000 characters.
- Do not weaken the final packet context cap.
- Do not make this Go-specific or trails-api-specific.
- Do not change Stage 7 tool permissions or verification policy as part of this plan.
- Do not remove source recovery tools; reviewers still need tools for genuinely cross-symbol or cross-file investigation.

## Plan

1. Replace the flat symbol cap with an adaptive symbol context budget.
   - Introduce a small helper in `src/pipeline/packet-builder.ts`, for example `computeSymbolContextBudget(...)`.
   - The helper should derive a per-symbol budget from:
     - total packet context budget
     - patch text size
     - number of hunks in the packet
     - number of changed/enclosing symbols
     - packet coverage: `light`, `normal`, or `deep`
     - review priority or risk score, if already available in the packet inputs
     - whether the packet has a single primary enclosing symbol
   - Keep compact defaults for ordinary packets.
   - Allow a single primary symbol on a high-priority or `deep` packet to use more than 3,000 characters when the packet has room.
   - Keep an absolute upper bound below or equal to the remaining packet context budget. A reasonable first target is to allow about 6,000 characters for a single primary symbol only when budget pressure is low.
   - Do not let adaptive symbol context crowd out the changed hunk itself.

2. Make slicing changed-line-centered, not prefix-centered.
   - When the full symbol cannot fit, preserve the most review-relevant parts:
     - symbol signature or declaration
     - line range
     - changed lines
     - nearby control-flow context around each changed line
     - useful tail context only if budget remains
   - If there are multiple changed ranges inside one symbol, split the budget across those ranges instead of only showing the first region.
   - Include explicit omission markers with original line ranges so the reviewer can tell what was skipped.
   - Avoid a final blind substring truncation that can cut off changed-line excerpts or line-number structure.

3. Keep the final packet context cap authoritative.
   - `renderPacketContextText` should remain the final guardrail for packet prompt size.
   - Add tests that prove adaptive symbol context never makes `contextText` exceed `MAX_CONTEXT_CHARS`.
   - If the combined context is still too large, prefer deterministic degradation in this order:
     - trim lower-priority related context
     - trim sibling or outline context
     - slice large symbol context around changed lines
     - fall back to outline-only for truly huge symbols
   - The changed hunk and changed-line anchors must remain present.

4. Make context quality and degradation reasons more precise.
   - Do not let `contextQuality: "full"` imply a fully rich packet when the primary patch or primary symbol was materially truncated.
   - If the existing four-value type is sufficient, map material symbol truncation to `sliced`.
   - If current artifacts need more detail, add separate degradation metadata instead of expanding the quality enum unnecessarily:
     - `symbolContextMode`: `full`, `adaptive_full`, `adaptive_sliced`, `outline_only`
     - `symbolContextBudgetChars`
     - `symbolContextChars`
     - `symbolContextOmittedChars`
     - `symbolContextBudgetReason`
   - Keep these fields optional and scoped to debug/telemetry artifacts if they do not belong in public review output.

5. Improve Stage 6 telemetry for this decision.
   - Update `packet_symbol_source_truncated` or add a replacement event that records:
     - path
     - symbol name
     - coverage
     - original symbol chars
     - selected budget chars
     - emitted symbol chars
     - whether the packet had a single primary symbol
     - reason for slicing
   - Add aggregate Stage 6 metrics:
     - adaptive full symbol contexts
     - adaptive sliced symbol contexts
     - outline-only symbol contexts
     - packets with material symbol omission
   - This should make future run reviews show whether Stage 6 is reducing avoidable Stage 7 source-recovery work.

6. Add focused tests around packet context construction.
   - Extend `tests/pipeline-phase5.test.ts` unless a more specific packet-builder test file exists.
   - Test that a `deep` or high-priority single-symbol packet can include more than 3,000 characters of enclosing symbol source when the total packet context has room.
   - Test that a normal low-priority packet with multiple hunks or multiple symbols remains compact.
   - Test that a very large symbol is sliced around changed lines and retains signature, changed lines, and omission markers.
   - Test that the final packet context remains within `MAX_CONTEXT_CHARS`.
   - Test that material symbol truncation produces `sliced` or explicit degradation metadata, not a misleading clean `full` context.
   - Keep the tests language-neutral where possible by using synthetic source fixtures. If an existing tree-sitter fixture is easiest, do not assert language-specific semantics beyond symbol range extraction.

7. Re-run targeted validation.
   - Run the packet-builder tests first:
     - `pnpm test -- tests/pipeline-phase5.test.ts`
   - Run broader validation if the touched code affects shared packet types:
     - `pnpm test`
     - `pnpm run build`
   - If the eval can be rerun, compare the next trails-api run against run 6 for:
     - fewer `packet_symbol_source_truncated` warnings
     - fewer Stage 7 `read_symbol` / `find_definition` calls for primary enclosing symbols
     - fewer Stage 7 continuation/finalize calls on no-finding packets
     - no regression in expected finding recall

## Likely Files

- `src/pipeline/packet-builder.ts`
- `src/types.ts`
- `src/telemetry/run-artifacts.ts`
- `tests/pipeline-phase5.test.ts`

## Acceptance Criteria

- Stage 6 no longer applies a flat 3,000 character cap to every enclosing symbol source.
- High-priority or `deep` packets with a single primary symbol can carry richer symbol context when budget is available.
- Ordinary packets remain compact and do not grow just because adaptive budgeting exists.
- The changed hunk and changed-line anchors always remain present.
- The final packet context still respects `MAX_CONTEXT_CHARS`.
- Large symbols are sliced around changed lines with clear omission markers.
- Packet artifacts and telemetry explain why a symbol was included fully, sliced, or reduced to outline-only.
- Tests cover adaptive growth, compact fallback, changed-line-centered slicing, and context cap enforcement.

## Expected Effect

This should reduce avoidable Stage 7 tool loops and finalize pressure by giving packet reviewers the most relevant enclosing source up front.

Expected improvements:

- Better packet-level review quality for large changed functions and methods.
- Fewer repeated source-recovery tool calls.
- Lower Stage 7 latency and cost on large PRs.
- Cleaner debug artifacts that distinguish truly full context from degraded context.

## Stop Conditions

- Stop if the implementation requires changing Stage 7 prompts or verifier policy to make the Stage 6 change work.
- Stop if adaptive context makes ordinary packets materially larger without a clear risk signal.
- Stop if tests show the changed hunk or changed-line anchors can be evicted by richer symbol context.
- Stop if the solution becomes language-specific. Tree-sitter can help locate symbols, but the budgeting policy should be generic.

## Sanity Check

This plan intentionally does not solve the problem by simply increasing `MAX_SYMBOL_CONTEXT_CHARS`. A global cap increase would make every packet larger, worsen attention dilution, and increase provider prompt-cache write cost.

The better fix is to spend context where it has review value:

- single primary symbol
- high priority or `deep` coverage
- enough remaining packet budget
- changed-line-centered slices when the full symbol still cannot fit

That matches Codeninja's core design: focused packets plus targeted tools, not full-repo or full-file context dumps.
