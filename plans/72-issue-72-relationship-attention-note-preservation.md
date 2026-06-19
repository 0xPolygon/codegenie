# Issue 72: Relationship Attention Note Preservation

Status: COMPLETE
Planned from: trails-api eval `49f4645b/logs/17` compared with `49f4645b/logs/16`, with code confirmation in `src/pipeline/packet-builder.ts`, 2026-06-19
Recommended priority: high. Run 17 shows Plan 71 fixed Stage 5 first-submit reliability, but a healthy planner's focus notes crowded out deterministic changed-symbol relationship notes that were decisive in run 16.

Update after trails-api `0c4d5213/logs/32`: run 32 exposed a separate Stage 5 schema/prompt issue where `surroundingContextHints` was omitted after the prompt said to omit empty arrays. That is not part of this plan; it should be handled by making the hint array optional/defaulted and by scoping the prompt wording. Run 32 also reinforces a broader, independent coverage-breadth gap: healthy planner coverage can under-deep compared with the degraded safety net, and the safety path produced stronger expectation matches in run 32. This plan should not grow into a general coverage-breadth redesign. Keep this issue focused on preserving deterministic relationship signals that already exist on the packet.

## Problem

Run 17 failed after Plan 70 and Plan 71, but the failure was not caused by Stage 10 publication or Stage 5 schema invalidity.

The key packet-level evidence is the `GetQuote` packet:

```text
Run 16, found the issue:
  attentionNotes:
    Changed symbol GetQuote mentions changed symbol scaleAmount.
    Changed symbol GetQuote mentions changed symbol processQuote.
    Changed symbol GetQuote mentions changed symbol quoteParams.

Run 17, missed the issue:
  attentionNotes:
    This is the core bug-fix hunk: the decimal-normalized collateral sufficiency comparison.
    Confirm requiredCollateral scales transferAmount from origin to destination decimals...
    Verify the comparison operator/threshold still rejects insufficient collateral...
```

The packet was `deep` and `investigate` in both runs. That corrects the earlier hunk-level interpretation: run 17 did not miss because the packet was budget-starved. The exact-output hunk had `light` coverage in the Stage 5 plan, but it coalesced into a `deep` `GetQuote` packet. The packet had enough budget.

The miss happened because the attention notes changed.

Code confirms the mechanism:

```ts
const MAX_ATTENTION_NOTES = 3;

function mergeAttentionNotes(
  plannerAttentionNotes: string[],
  relatedChangedContext: RelatedChangedContext[]
): string[] {
  const notes = [
    ...plannerAttentionNotes,
    ...relatedChangedContext.map((context) => context.reason)
  ];
  return normalizeAttentionNotes(notes);
}

function normalizeAttentionNotes(notes: string[]): string[] {
  return dedupe(notes.map(normalizeNote).filter((note) => note.length > 0)).slice(0, MAX_ATTENTION_NOTES);
}
```

When the planner degraded in run 16, there were no planner focus notes, so deterministic relationship notes filled the packet and pointed Stage 7 down the changed data-flow path. When the planner submitted cleanly in run 17, three planner notes filled the cap first, and the deterministic `GetQuote -> scaleAmount/processQuote/quoteParams` relationship notes were sliced off.

That changed Stage 7's review frame:

```text
Run 16:
  review related changed symbols and follow the data flow
  -> direct correctness candidate

Run 17:
  review collateral normalization only
  -> no direct candidate, only weak uncertainty stubs
```

This is not a verifier problem. Stage 9 kept the strong direct candidate in run 16 and rejected weak question-shaped promotions in run 17. That is correct.

This is not a Plan 70 problem. Plan 70 only changes publication anchor recovery after findings are kept. Run 17 had no kept finding to publish.

This is mostly not a coverage-floor problem. A structural coverage floor may still be useful for isolated light hunks that do not coalesce into deeper packets, but it would not have fixed the motivating run because the relevant packet was already deep.

The actual weakness is attention-note merging:

```text
planner notes first + hard cap of 3
  -> deterministic relationship notes disappear
  -> Stage 7 loses the changed-symbol map
  -> related context is present but not made salient
  -> direct candidate generation becomes variance-dependent
```

## Goal

Preserve deterministic changed-symbol relationship notes in packets that include related changed context, even when the planner emits multiple focus notes.

Desired behavior:

```text
If relatedChangedContext is attached:
  at least the strongest deterministic relationship notes survive the note cap

If planner focus notes are present:
  keep them, but relationship notes should lead the final list when they are present

If Stage 7 submits no_findings:
  no-finding reasoning should address attached related changed context when it exists
```

This is an attention-preservation fix, not a bug taxonomy and not a finding shortcut.

The implementation should preserve the current architecture:

- Stage 5 remains a lightweight scout.
- Stage 6 remains deterministic packet/context construction.
- Stage 7 remains issue finding.
- Stage 8 remains narrow and Stage-7-triggered.
- Stage 9 remains strict verification.

## Non-Goals

- Do not revert Plan 70 or Plan 71.
- Do not reintroduce review questions, proof obligations, or risk-area accounting.
- Do not add a taxonomy of rounding, conversion, exact-output, finance, protocol, validation, or language-specific risks.
- Do not make Stage 5 responsible for identifying the bug.
- Do not blanket-upgrade clean plans to deep coverage.
- Do not loosen verifier standards.
- Do not force Stage 8 to run for single hints in this plan.
- Do not encode trails-api, Hyperlane, Go, decimal scaling, bridge semantics, or this eval's expected finding.

## Design

### 1. Relationship-First Reservation or Interleaving

Fix `mergeAttentionNotes` so deterministic relationship notes cannot all be sliced off by planner notes.

Current behavior:

```text
planner notes
then relationship notes
dedupe
slice first 3
```

Desired behavior:

```text
collect planner notes
collect relationship notes
rank/dedupe both
reserve or interleave relationship notes
place the selected relationship notes before planner focus notes
slice final list to MAX_ATTENTION_NOTES
```

V1 should be simple and deterministic.

Recommended approach:

```text
MAX_ATTENTION_NOTES = 3

if relationship notes are present:
  keep up to 2 relationship notes
  keep remaining slots for planner notes
  put relationship notes first in the final list
  prefer strong source-code relationship notes
  preserve stable order

if fewer relationship notes are present:
  fill remaining slots with planner notes

if no relationship notes are present:
  use existing planner-note behavior
```

Why reserve 2, not 1:

- run 16's decisive packet had both `GetQuote -> scaleAmount` and `GetQuote -> processQuote`;
- one note points to the transformed amount;
- the other points to the downstream output/reporting path;
- preserving only one could still leave Stage 7 with an incomplete path.

Why relationship notes should lead:

- run 17 did not only lose relationship notes; it also led the reviewer with a narrow planner framing note about the collateral hunk;
- run 16's winning packet led with deterministic relationship notes because no planner notes were present;
- putting preserved relationship notes after a strong planner characterization can still anchor the reviewer on the local planner frame.

Ranking should remain structural:

1. source-code related context before test/doc context;
2. strong relationships before medium/weak;
3. symbol mention / call-site / same-symbol relationships before nearby or weaker adjacency;
4. stable existing order as the final tiebreaker.

Do not add semantic categories. Do not detect "amount", "rounding", "quote", or any domain term.

### 2. Keep Planner Notes, But Do Not Let Them Dominate

Planner focus notes are still useful. This plan should not discard them wholesale.

The final note list should usually look like:

```text
deterministic relationship note
deterministic relationship note
planner focus note
```

or, if planner notes are absent:

```text
deterministic relationship note
deterministic relationship note
deterministic relationship note
```

or, if relationship notes are absent:

```text
planner focus note
planner focus note
planner focus note
```

This keeps the planner's hunk-scoped scout signal while preserving deterministic changed-symbol topology.

The cap choice should be explicit during implementation. Keeping `MAX_ATTENTION_NOTES = 3` and reserving two relationship slots is the conservative default for prompt size. A modest packet-local cap bump to 4 or 5 is an acceptable alternative only if it stays scoped to packets with related changed context and telemetry shows the extra notes are useful rather than noisy. The ordering rule is not optional either way: relationship notes should precede planner notes when selected.

### 3. Stage 7 Related-Context Reconciliation

Strengthen the Stage 7 prompt in a generic way.

Current behavior can treat related changed context as background. The desired behavior is:

```text
When related changed context is attached, reconcile it with the local changed hunk.
Before submitting no_findings, state why the related changed context does or does not change the observable behavior of the local hunk.
If the concern remains concrete but unproven, preserve the exact predicate and both sides of the path in a candidate or follow-up hint.
```

Keep this small. Do not list domain examples. Do not mention rounding, amounts, guarantees, tokens, protocols, tests, or any target-language concept.

The prompt should emphasize:

- local helper correctness is not enough if attached caller/callee/output context changes the observable contract;
- no-finding reasoning should address attached related changed context when it exists;
- a follow-up hint must carry the concrete predicate, not just "verify behavior."

### 4. Telemetry and Packet Artifacts

Make note preservation visible.

Emit Stage 6 telemetry when relationship notes are preserved under pressure:

- `relationship_attention_notes_preserved`
- planner note count;
- relationship note count;
- final note count;
- relationship notes kept;
- relationship notes omitted due cap;
- relationship sources and strengths.

Packet artifacts should make it easy to audit:

```text
attentionNotes: [...]
attentionNoteSources:
  planner: [...]
  relationship: [...]
  omittedByCap: [...]
```

Exact artifact shape can differ. The important requirement is diagnosability: future eval reviews should be able to tell whether relationship notes were present, kept, or sliced off.

### 5. Secondary Hardening: Structural Coverage Floor

Demote the original coverage-floor idea to secondary/backstop hardening.

It does not fix run 17 because the relevant packet was already `deep + investigate`.

It may still be useful for a different class:

```text
relationship-active hunk stays light
and does not coalesce into a deeper packet
and receives only simple/no-tool review
```

If implemented in this issue, keep it very conservative:

- only raise source-code hunks with strong changed-symbol relationships from `light` to `normal`;
- prefer `normal + standard/investigate profile` over `deep`;
- cap promotions;
- record coverage source as deterministic relationship floor;
- do not make this the validation target for `49f4645b/run17`.

Prefer deferring this secondary hardening unless it falls out as a very small, well-tested change. Run 32 adds evidence that clean planner coverage can be narrower than the safety path, but solving broad coverage calibration should be a separate plan if it remains a problem after relationship notes are preserved. This issue's primary success metric is note preservation, not increasing deep coverage.

If validation shows relationship notes are preserved and ordered first but the same finding still misses, do not keep expanding this plan. The next likely lever is planner framing: softening authoritative per-hunk characterizations such as "this is the core bug-fix hunk" when they can cause Stage 7 to treat other attached changed context as secondary. That would be a separate Stage 5 prompt/calibration plan.

## Implementation Notes

Likely files:

- `src/pipeline/packet-builder.ts`
- `src/skills/prompt-builder.ts`
- `src/types.ts` if packet artifacts gain note-source metadata
- `tests/pipeline-phase5.test.ts`
- `tests/pipeline-phase6.test.ts`
- functional spec / architecture docs if they describe Stage 5-7 contracts

Suggested implementation shape:

```text
attentionNotesForDecisions(decisions)
  -> planner notes

buildRelatedChangedContext(...)
  -> related context with reason/source/strength/sourceKind

mergeAttentionNotes(plannerNotes, relatedChangedContext)
  -> rank relationship notes
  -> reserve/interleave
  -> cap
  -> telemetry/debug metadata
```

If adding metadata would make the implementation much larger, implement the ordering/reservation first and add only minimal telemetry. The critical correctness fix is the final note selection.

## Implementation Steps

1. Add relationship-note selection helper.
   - Convert `relatedChangedContext` into normalized note candidates.
   - Rank source-code + strong relationship notes first.
   - Preserve stable order within equal rank.
   - Dedupe against planner notes and other relationship notes.

2. Change `mergeAttentionNotes`.
   - Reserve up to 2 slots for relationship notes when available.
   - Keep at least 1 planner note when available.
   - Fall back to current behavior when no relationship notes exist.
   - Keep `MAX_ATTENTION_NOTES` small unless tests prove a larger cap is necessary.

3. Add tests for the run-17 failure mode.
   - Planner emits 3 focus notes.
   - Related context contains `caller -> helper` and `caller -> downstream` relationship notes.
   - Final packet attention notes include at least 2 relationship notes.
   - Planner notes do not fully evict relationship notes.

4. Add no-regression tests.
   - No related context: planner notes still cap to 3.
   - One related note: it is preserved.
   - Weak/test/doc related notes do not displace stronger source-code notes.
   - Duplicate relationship notes are deduped.

5. Update Stage 7 prompt guidance.
   - Add a short generic related-context reconciliation instruction.
   - Bump the Stage 7 prompt version.
   - Avoid domain examples.

6. Add telemetry/artifact support if practical.
   - Emit `relationship_attention_notes_preserved` when relationship notes would previously have been omitted.
   - Include counts and source/strength metadata.
   - Keep snippet bodies out of telemetry.

7. Optionally implement the secondary coverage floor.
   - Only if it is small and clean after the note fix.
   - Do not treat it as necessary for run 17.

## Validation

Unit tests:

```bash
pnpm exec vitest run tests/pipeline-phase5.test.ts tests/pipeline-phase6.test.ts
pnpm test
```

Static checks:

```bash
pnpm run typecheck
pnpm run build
git diff --check
```

Eval validation:

```bash
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/49f4645b --no-cache
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/0c4d5213 --no-cache
```

Expected diagnostic improvements for `49f4645b`:

- Stage 5 can still first-submit cleanly.
- The `GetQuote` packet keeps deterministic relationship notes such as changed-symbol links to `scaleAmount` and `processQuote` even when planner notes exist.
- Stage 7 no-finding reasoning addresses attached related changed context.
- Stage 7 should be more likely to produce a direct candidate or a concrete follow-up carrying both sides of the changed behavior path.
- Stage 9 should still reject weak, question-shaped candidates.
- Plan 70 publication behavior should be unchanged unless a finding is verified.

Because this finding has shown run-to-run variance, validate with 2-3 `49f4645b` runs rather than a single run. The first success metric is not only final pass/fail; it is whether the packet artifacts preserve the deterministic relationship notes under a healthy planner.

Expected no-regression checks for `0c4d5213`:

- Stage 7 cost should stay within recent ranges.
- Existing should-find expectations should remain matched.
- The should-not-find false positive should remain absent.
- Large packets should not become noisy with too many attention notes.

## Success Criteria

- Planner focus notes no longer evict all deterministic relationship notes.
- Packets with related changed context preserve at least the strongest relationship notes under the note cap.
- Stage 7 is explicitly reminded to reconcile attached related context before no-findings.
- The fix improves recall without weakening Stage 9.
- The implementation remains structural, language-neutral, and bounded.

## Stop Conditions

Do not proceed if the implementation:

- expands attention notes so much that packet prompts become noisy;
- turns relationship-note ranking into a domain taxonomy;
- uses target-repo names, language-specific syntax assumptions, or eval-specific patterns;
- reintroduces planner questions or obligations;
- routes single hints through Stage 8 by default;
- increases large-PR cost without caps and telemetry;
- discards planner focus notes wholesale;
- loosens verifier policy to keep incomplete claims.
