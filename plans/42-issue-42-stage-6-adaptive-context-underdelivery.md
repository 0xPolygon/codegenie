# Issue 42: Stage 6 Adaptive Context Underdelivery

Status: COMPLETE
Planned from: trails-api eval run 8 review, 2026-06-16
Depends on: Issue 32
Recommended priority: before Issue 43 if the next goal is review-quality stability

## Problem

Issue 32 added adaptive Stage 6 symbol context, but eval run 8 shows the adaptive path is barely activating.

Observed in `/home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/logs/8`:

- `adaptiveFull: 3`
- `adaptiveSliced: 0`
- `defaultFull: 35`
- `defaultSliced: 28`
- `materialOmission: 28`
- `outlineOnly: 7`
- `degradedHunks: 78`

The context-quality distribution barely improved from run 6 and may be marginally worse:

- run 6: 38 full, 28 sliced, 7 outline-only
- run 8: 36 full, 30 sliced, 7 outline-only

This matters because the central correctness packets are still receiving sliced primary-symbol context. Stage 7 then has to rediscover local source through tools, and candidate quality becomes more variable. Run 6 produced a sharper direct `amountfromusd` finding; run 8 only produced a weaker promoted uncertainty that the verifier correctly rejected as unproven. The likely upstream cause is still degraded Stage 6 context.

Caveat: richer Stage 6 context improves candidate sharpness (run-6-level direct findings have passed eval matching), but it is not guaranteed to make `amountfromusd` provable — the verifier may still need cross-file reachability the enclosing symbol alone does not supply. Issue 41's `acceptHumanAttention` is the honest backstop if it stays unprovable. Judge this plan on aggregate Stage 6 context quality and Stage 7 tool-loop reduction, not solely on whether it recovers one finding. (Confirmed: the run-8 `amountfromusd` packet `a81d5adf` is `sliced`/`investigate`/`normal` coverage with a risk note — eligible under this plan's broadened policy but not under Issue 32's `deep`-only gate.)

The current adaptive budget policy is too conservative:

- It requires a single primary symbol.
- It requires `deep` or high-priority coverage.
- It treats high patch pressure or high hunk pressure as a reason to keep the default compact 3,000 character budget.
- It does not adapt for packets where the primary symbol was materially sliced in a previous/default path.

High patch or hunk pressure should not automatically mean "stay compact." It should usually mean "do not dump the whole symbol; include a changed-line-centered adaptive slice."

## Non-Goals

- Do not raise the default symbol context cap for every packet.
- Do not dump full files or whole large symbols into packet prompts.
- Do not weaken the final packet context cap.
- Do not make this trails-api-specific, Go-specific, or expectation-specific.
- Do not change Stage 7 prompts, verifier policy, or eval matching in this plan.
- Do not remove repository tools; this plan improves initial packets, but tools remain necessary for cross-symbol and cross-file review.

## Plan

1. Add an adaptive eligibility audit before changing behavior.
   - Extend Stage 6 symbol-context telemetry with enough data to answer why a packet did or did not receive adaptive context.
   - Include:
     - path
     - hunk ids
     - primary symbol
     - coverage
     - review priority
     - patch chars
     - hunk count
     - unique symbol count
     - original symbol chars
     - selected budget chars
     - selected mode
     - blocked reason, if not adaptive
     - whether the final symbol source was materially omitted
   - Keep this as debug/telemetry metadata, not public review output.

2. Separate "adaptive full" from "adaptive sliced" policy.
   - Full adaptive symbol context should remain conservative.
   - Sliced adaptive symbol context should be available for high-pressure packets.
   - High patch pressure or high hunk pressure should block `adaptive_full`, not all adaptive behavior.
   - For high-pressure packets with one primary symbol, select an `adaptive_sliced` budget and render changed-line-centered excerpts.

3. Broaden eligibility with generic risk and degradation signals.
   - Keep `deep` and high review priority as strong signals.
   - Also allow adaptive slicing when:
     - the default symbol source would be materially omitted
     - the packet has planner risk notes or high-risk lenses
     - the packet has correctness/security/testing/performance/architecture risk tags
     - the packet touches public API or exported surface metadata already known to Stage 6
   - Do not use repository-specific paths, language-specific names, or eval expectation names.

4. Handle same-symbol multi-hunk packets more intelligently.
   - If multiple hunks share the same symbol identity and line range, treat the packet as a single-symbol packet for adaptive slicing.
   - If hunks touch different symbols, keep the current compact behavior unless a later system-review or packet grouping rule chooses otherwise.
   - Preserve the guard that same-named symbols with different ranges are not collapsed.

5. Make high-pressure adaptive slices changed-line-centered.
   - Keep the signature/declaration and line range.
   - Include excerpts around every changed range in the primary symbol.
   - Split budget across changed ranges instead of only preserving the first region.
   - Include explicit omission markers with source line ranges.
   - Avoid blind substring cuts that break line-number structure or remove the changed lines.

6. Protect the changed hunk and final packet budget.
   - The hunk patch and changed-line anchors must stay present.
   - The final packet context cap remains authoritative.
   - If context pressure is still high, degrade in this order:
     - lower-priority surrounding context
     - sibling/outline details
     - non-primary symbol context
     - primary symbol excerpts, while preserving changed-line excerpts
   - Never let adaptive symbol context evict the primary changed hunk.

7. Make the Stage 6 metrics prove the fix is active.
   - Keep the existing aggregate counters.
   - Add or refine counters for:
     - adaptive eligible packets
     - adaptive blocked packets by reason
     - adaptive full
     - adaptive sliced
     - default sliced with material omission
   - The next eval review should be able to tell whether run 8's `adaptiveFull: 3`, `adaptiveSliced: 0` pattern is fixed.

8. Add focused regression tests.
   - A deep/high-priority single-symbol packet under high patch pressure should use `adaptive_sliced`, not default sliced.
   - A packet with multiple hunks in the same symbol/range should be eligible for adaptive slicing.
   - A same-name/different-range packet should remain compact.
   - An ordinary low-risk packet should remain compact.
   - Adaptive slicing should preserve changed lines, signature, and omission markers.
   - The final packet context should remain under the global packet context cap.
   - Telemetry should report the selected mode and blocked reason.

9. Validate against artifacts, then tests.
   - Before implementation, inspect run 8 packet artifacts for a few default-sliced high-value packets and confirm their budget reasons.
   - After implementation, run packet-builder tests.
   - Run the full test suite and build if shared packet types or telemetry schemas change.
   - On the next eval run, compare:
     - more adaptive sliced contexts
     - fewer default sliced material omissions on important packets
     - fewer Stage 7 primary-symbol recovery tool calls
     - no regression in total packet count or changed hunk coverage
     - total cost stays under the `maxCostUSD` (30) ceiling; richer context enlarges packets, so watch the trend toward/past run 6's $22.78

## Likely Files

- `src/pipeline/packet-builder.ts`
- `src/types.ts`
- `src/telemetry/run-artifacts.ts`
- `tests/pipeline-phase5.test.ts`
- Optional: `src/pipeline/review-plan.ts` or related packet metadata only if existing risk/priority signals are not already available to Stage 6

## Acceptance Criteria

- Stage 6 no longer treats high patch/hunk pressure as a blanket reason to keep default compact symbol context.
- Important high-pressure packets can receive changed-line-centered adaptive slices.
- Ordinary packets remain compact.
- Same-symbol multi-hunk packets can use adaptive slicing without collapsing distinct same-named symbols.
- Adaptive symbol context never evicts changed hunks or exceeds the final packet context cap.
- Stage 6 telemetry explains both adaptive selection and adaptive blocking.
- Tests cover adaptive sliced, adaptive full preservation, compact fallback, and budget enforcement.

## Expected Effect

This should reduce avoidable Stage 7 source recovery and improve candidate stability for correctness findings that depend on a large enclosing symbol.

Expected improvements:

- More stable packet-level findings on large functions/methods.
- Fewer weak uncertainty-only candidates caused by missing local context.
- More actionable Stage 6 telemetry.
- Less run-to-run variance on high-value correctness packets.

## Stop Conditions

- Stop if the implementation becomes a global context-size increase.
- Stop if adaptive slicing makes most ordinary packets larger.
- Stop if changed hunks can be omitted or truncated by richer symbol context.
- Stop if the solution depends on trails-api paths, ERC20 terms, fee-calculator names, or Go-specific behavior.

## Sanity Check

Issue 32 introduced the right mechanism, but run 8 shows the eligibility policy is too narrow. The fix should not remove the adaptive mechanism or simply raise a constant. It should make the mechanism activate for the packets where the default compact context is demonstrably degrading review quality.

The key policy change is:

- low pressure + important single symbol -> adaptive full if it fits
- high pressure + important single symbol -> adaptive sliced around changed lines
- ordinary or multi-symbol packets -> compact unless another generic risk/degradation signal justifies richer context
