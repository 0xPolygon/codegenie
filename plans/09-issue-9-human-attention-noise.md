# Issue 9: Human Attention Noise

Status: PENDING

## Problem

The `Needs Human Attention` section can become too long when many packet reviewers raise similar unresolved questions. This section is useful only when it is short, specific, and materially different from the final findings. If it repeats the same concern across multiple packets, the final review starts to feel like raw agent telemetry instead of a staff-level review.

The fix should be generic: reduce repeated unresolved notes from any large PR without adding project-specific grouping rules.

## Plan

1. Add a small structured human-attention note model:
   - Normalize packet `followUpHints` and `uncertainties` into a shared internal shape.
   - Preserve:
     - `question`
     - `reason`
     - `files`
     - `symbols`
     - `confidence`
     - source packet ids.
   - Keep this as a final-output concern, not a packet-review concern.

2. Deduplicate notes with deterministic keys:
   - Build a stable key from normalized question text, sorted symbols, and normalized file paths.
   - Also create a coarser key from the strongest symbol plus the main semantic phrase when the exact question wording differs.
   - Keep this deterministic; do not add a second LLM pass just to dedupe notes.
   - Merge file/symbol sets from duplicates.
   - Keep the clearest question and strongest confidence.

3. Suppress notes already covered by final findings:
   - If a final finding covers the same changed symbol and same semantic concern, do not repeat it in `Needs Human Attention`.
   - Keep only materially different unresolved questions.

4. Cap the section:
   - Default max: 5 grouped notes.
   - Prefer medium/high confidence notes.
   - Prefer notes that mention concrete files and symbols.
   - Suppress low-confidence notes by default.
   - Add a compact overflow line such as: `Additional unresolved notes suppressed: N`.

5. Use the deduped notes everywhere:
   - Feed only deduped/capped notes into the LLM composer prompt.
   - Render only deduped/capped notes in deterministic fallback.
   - Persist the full raw note list in artifacts for eval/debug analysis.
   - Omit the `Needs Human Attention` section entirely when no notes survive filtering.

## Likely Files

- `src/pipeline/composer.ts`
- `src/output/markdown-renderer.ts`
- `src/skills/prompt-builder.ts`
- `src/types.ts` if a shared note type is needed
- `tests/pipeline-phase6.test.ts`
- `tests/pipeline-phase7.test.ts`

## Tests

- Duplicate follow-up hints about the same helper collapse into one note.
- Notes covered by a final finding are suppressed.
- Low-confidence notes are omitted when higher-confidence notes fill the cap.
- Renderer emits at most 5 human-attention notes plus an overflow count.
- Composer prompt receives deduped notes, not raw packet-level noise.
- Empty note sets do not render a `Needs Human Attention` section.

## Acceptance Criteria

- Large-PR final reviews show a short `Needs Human Attention` section, not raw repeated packet notes.
- Main findings remain unchanged.
- Raw follow-up/uncertainty telemetry is still preserved for debugging and evals.
- Final Markdown is readable without manual cleanup.
