# Issue 9: Human Attention Noise

## Problem

The completed trails-api run produced strong main findings, but the `Needs Human Attention` section was too long and repetitive. It repeated the same themes many times:

- `LockForStatusUpdate` column/timestamp parity.
- USD math / rounding / zero-price behavior across route providers.
- worker loop WaitGroup questions.
- parse helper behavior.

This section is useful as an appendix for unresolved investigation, but the current output violates the product goal: a staff-level review with concise, high-signal comments and no fluff.

## Plan

1. Add a structured human-attention note model:
   - Normalize packet `followUpHints` and `uncertainties` into a shared internal shape.
   - Preserve:
     - `question`
     - `reason`
     - `files`
     - `symbols`
     - `confidence`
     - source packet ids.
   - Keep this as a final-output concern, not a packet-review concern.

2. Deduplicate notes by root cause:
   - Build a root-cause key from normalized question/reason tokens, symbols, and file families.
   - Merge near-duplicate notes even when wording differs.
   - Merge file/symbol sets from duplicates.
   - Keep the clearest question and strongest confidence.
   - Explicitly group common patterns such as:
     - same helper name plus same semantic concern
     - same file family plus same changed helper
     - repeated "parity with old implementation" questions.

3. Suppress notes already covered by final findings:
   - If a final finding covers the same symbol/root-cause terms, do not repeat it in `Needs Human Attention`.
   - Keep only materially different unresolved questions.
   - Example: after publishing the explicit-preference routing finding, suppress generic routing-fallback uncertainty notes.

4. Cap the section:
   - Default max: 5 grouped notes.
   - Prefer medium/high confidence notes.
   - Prefer notes that mention concrete files and symbols.
   - Suppress low-confidence notes unless there are not enough higher-confidence notes.
   - Add a compact overflow line such as: `Additional low-confidence follow-ups suppressed: N`.

5. Use the deduped notes everywhere:
   - Feed only deduped/capped notes into the LLM composer prompt.
   - Render only deduped/capped notes in deterministic fallback.
   - Persist the full raw note list in artifacts for eval/debug analysis.

## Likely Files

- `src/pipeline/composer.ts`
- `src/output/markdown-renderer.ts`
- `src/skills/prompt-builder.ts`
- `src/types.ts` if a shared note type is needed
- `tests/pipeline-phase5.test.ts`
- `tests/pipeline-phase6.test.ts`

## Tests

- Duplicate follow-up hints about the same helper collapse into one note.
- Notes covered by a final finding are suppressed.
- Low-confidence notes are omitted when higher-confidence notes fill the cap.
- Renderer emits at most 5 human-attention notes plus an overflow count.
- Composer prompt receives deduped notes, not raw packet-level noise.

## Acceptance Criteria

- The trails-api final review would show a short `Needs Human Attention` section, not dozens of repeated bullets.
- Main findings remain unchanged.
- Raw follow-up/uncertainty telemetry is still preserved for debugging and evals.
- Final Markdown is readable without manual cleanup.
