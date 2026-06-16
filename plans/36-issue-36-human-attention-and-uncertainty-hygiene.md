# Issue 36: Human-Attention and Uncertainty Hygiene

Status: PENDING
Planned from: trails-api eval run 6 review and Opus 4.8 notes, 2026-06-16
Planned at: commit `506fa43`

## Problem

Run 6 generated more unresolved human-attention and uncertainty material than the final review needed. Opus 4.8 reported 92 raw human-attention notes and only 5 emitted. It also pointed out a sharper issue: a note can cite a nonexistent path and then evade suppression because the final finding or verifier verdict cites the real path.

This plan bundles the human-attention cleanup work:

- cap low-value follow-up hints and uncertainties at the source.
- validate note paths before final output and suppression.
- normalize `human-attention-notes.json` to avoid repeated expanded copies.
- tighten uncertainty promotion so Stage 9 does not spend verifier calls on broad unresolved questions.

This is about reducing noise and wasted verifier work. It must not suppress real candidate findings.

## Current State

Relevant files:

- `src/pipeline/lens-runner.ts` accepts and records packet-level `followUpHints` and `uncertainties`.
- `src/pipeline/system-reviewer.ts` groups repeated follow-up hints for Stage 8.
- `src/pipeline/composer.ts` builds raw/grouped human-attention notes and suppresses notes covered by findings or verification.
- `src/pipeline/uncertainty-promotion.ts` promotes selected hints/uncertainties into verifier candidates.
- `tests/pipeline-phase5.test.ts`, `tests/pipeline-phase8.test.ts`, `tests/uncertainty-promotion.test.ts`, and `tests/verifier.test.ts` cover the relevant behavior.

Current packet-level hint validation only checks for pointer richness:

```ts
// src/pipeline/lens-runner.ts:130-148
const question = hint.question.trim();
const pointerRich = hint.files.length > 0 || hint.symbols.length > 0;
const valid = pointerRich && question.length > 0;
return valid ? [{ ...hint, question }] : [];
```

Current artifact writes repeated expanded views:

```ts
// src/pipeline/composer.ts:206-212
await telemetry.writeArtifact("human-attention-notes.json", scrubGitHubSecrets({
  raw: attention.raw,
  grouped: attention.groups.map(attentionGroupArtifact),
  composerPromptNotes,
  outputNotes: humanAttention.notes,
  omittedCount: humanAttention.omittedCount,
  suppressedByFindings: humanAttention.suppressedByFindings,
```

Current suppression requires file or symbol overlap before term similarity matters:

```ts
// src/pipeline/composer.ts:984-993
const sharesSymbol = groupSharesFindingSymbol(group, finding, packetsById);
const sharesFile = groupSharesFindingFile(group, finding);
if (!sharesSymbol && !sharesFile) {
  return false;
}
```

Current uncertainty promotion is bounded but still broad:

```ts
// src/pipeline/uncertainty-promotion.ts:157-182
function promotionDecision(source: PromotionSource): { eligible: boolean; reason: string } {
  ...
  if (source.files.length === 0 && source.symbols.length === 0) {
    return { eligible: false, reason: "no_concrete_file_or_symbol" };
  }
  ...
  return { eligible: true, reason: "eligible" };
}
```

## Plan

1. Cap follow-up hints and uncertainties at the packet boundary.
   - Add deterministic caps in `runPacket`.
   - Recommended first version:
     - max 2 `followUpHints` per packet.
     - max 1 `uncertainty` per packet.
   - Rank before capping:
     - pointer-rich hints first.
     - medium/high confidence before low.
     - hints with both file and symbol before file-only.
     - changed-file or packet-path hints before broad repo hints.
     - shorter concrete questions before broad questions.
   - Emit telemetry for dropped items:
     - `follow_up_hint_capped`
     - `uncertainty_capped`
     - packet id
     - dropped count
     - cap value

2. Tighten Stage 7 prompt guidance.
   - Tell packet reviewers:
     - unresolved notes are for concrete, actionable questions only.
     - do not emit broad "someone should check X" notes.
     - prefer a candidate finding when changed-line evidence is concrete.
     - prefer no finding and no hint when the concern is speculative.
     - emit at most one or two high-value follow-up questions.
   - Do not use prompt wording to suppress real candidate findings.

3. Validate note paths before grouping and output.
   - Build a lightweight known-path index from data already available:
     - packet paths and old paths
     - diff paths
     - final finding paths
     - related-code paths
     - repository file list only if already available cheaply
   - For each note file:
     - keep valid known repo paths.
     - keep old paths for renamed/deleted files when packet metadata supports them.
     - drop empty, absolute, traversal, outside-repo, or unknown paths.
   - Emit telemetry:
     - `human_attention_note_path_dropped`
     - packet id
     - original path
     - reason
   - If all files are dropped but symbols remain, keep the note as symbol-scoped.
   - If all files are dropped and there are no symbols, drop the note.

4. Make suppression resolver-aware for invalid-path notes.
   - Track whether a note/group had invalid files removed.
   - For groups with valid paths, keep current conservative matching.
   - For groups whose paths were invalid, allow suppression when:
     - symbols overlap, or
     - question keys match, or
     - normalized terms are highly similar to a final finding or verifier resolution.
   - Do not suppress solely on common words.
   - Keep same-symbol but different-valid-file notes when the verifier resolved only one scope.

5. Preserve Stage 8 signal quality.
   - Apply caps and path validation per packet, not globally before Stage 8 can see repeated concrete hints.
   - Repeated valid symbol-scoped hints should still create targeted Stage 8 tasks.
   - Invalid paths should not create fake cross-packet task scopes.

6. Tighten uncertainty promotion.
   - Add a concrete predicate gate before promotion.
   - Promote only when the source describes a specific failure condition and has a changed-line anchor tied to the predicate.
   - Do not promote broad follow-ups such as "verify this is safe" or "check if this needs tests".
   - Require actionable evidence already present in the packet:
     - changed hunk text containing the referenced behavior, or
     - packet symbol facts matching the referenced symbol, or
     - related context attached to the packet.
   - Keep the test-coverage lane, but require both:
     - changed/deleted test scope, and
     - named production behavior or symbol that lost coverage.
   - Emit not-promoted reasons:
     - `no_concrete_failure_predicate`
     - `no_changed_anchor_for_predicate`
     - `insufficient_promotion_evidence`
     - `broad_follow_up_only`

7. Normalize `human-attention-notes.json`.
   - Store raw notes once with stable IDs.
   - Store derived views as IDs plus lightweight metadata instead of repeated full note bodies.
   - Include validation metadata:
     - dropped paths
     - original path count
     - validated path count
     - suppressed-by-finding and suppressed-by-verification references.
   - Keep compatibility or update eval readers if any eval tooling reads the old artifact shape.

8. Add tests.
   - Packet-level caps keep top-ranked hints and drop weaker ones with telemetry.
   - Repeated concrete hints still trigger Stage 8.
   - Nonexistent paths are dropped or converted to symbol-scoped notes.
   - Invalid paths cannot prevent suppression when a finding/verdict resolves the same predicate.
   - Valid different-file scopes remain unsuppressed.
   - Broad uncertainty does not promote.
   - Concrete test-coverage uncertainty still promotes.
   - Normalized artifact stores raw notes once and references them from derived views.

## Opus 4.8 Comparison

This bundle covers the overlapping human-attention findings:

- Opus's note volume/artifact duplication point.
- Opus's sharpened nonexistent-path suppression failure.
- ChatGPT's uncertainty-promotion efficiency concern, with Opus's correction that the verifier was doing the right thing and the waste was earlier.

The implementation should stay generic and should not contain trails-api-specific paths, symbols, or expected findings.

## Likely Files

- `src/pipeline/lens-runner.ts`
- `src/skills/prompt-builder.ts`
- `src/pipeline/system-reviewer.ts`
- `src/pipeline/composer.ts`
- `src/pipeline/uncertainty-promotion.ts`
- `src/evals/eval-artifacts.ts`
- `src/evals/eval-scoring.ts`
- `src/types.ts`
- `tests/pipeline-phase5.test.ts`
- `tests/pipeline-phase8.test.ts`
- `tests/uncertainty-promotion.test.ts`
- `tests/verifier.test.ts`

## Verification Commands

- `pnpm test -- tests/pipeline-phase5.test.ts`
- `pnpm test -- tests/pipeline-phase8.test.ts`
- `pnpm test -- tests/uncertainty-promotion.test.ts`
- `pnpm test -- tests/verifier.test.ts`
- `pnpm test -- tests/evals.test.ts`
- `pnpm run build`

Expected result: all commands exit 0.

## Acceptance Criteria

- Packet results no longer carry unbounded follow-up hints or uncertainties.
- Dropped hints, uncertainties, and invalid paths are visible in telemetry.
- Repeated high-value hints can still reach Stage 8.
- Notes do not present nonexistent paths as actionable final-output locations.
- Invalid paths cannot make an already resolved note survive suppression.
- Broad unresolved questions are not promoted to verifier candidates.
- Concrete changed-line uncertainty can still be promoted when it has evidence and a predicate.
- `human-attention-notes.json` stores raw notes once and references them from derived views.

## Stop Conditions

- Stop if source-side caps reduce candidate finding recall.
- Stop if Stage 8 no longer receives repeated concrete hints.
- Stop if path validation requires a broad expensive repo scan during composition.
- Stop if stricter promotion removes all concrete test-coverage promotions.
- Stop if artifact normalization would break eval scoring without a compatibility path.
