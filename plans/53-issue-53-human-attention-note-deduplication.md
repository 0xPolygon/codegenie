# Issue 53: Human-Attention Note Deduplication

Status: PENDING
Planned from: trails-api eval run 17, 2026-06-17
Recommended priority: after Stage 7 schema repair cost

## Problem

Run 17 passed and produced a useful final review, but the `Needs Human Attention` section contained duplicate or near-duplicate notes.

The most visible duplication was around `LockForStatusUpdate`:

- one note asks whether relay/lz/hyperlane/intent transaction implementations match the generic helper,
- another asks almost the same question with overlapping files and symbols,
- a third asks whether unverified implementations dropped update columns or field mutations.

These are not wrong, but they make the final report feel less polished and spend human attention on repeated work.

## Goal

Deduplicate human-attention notes more aggressively after verification and before final composition.

The desired behavior is:

- keep truly distinct unresolved concerns,
- merge notes with the same root question,
- preserve all useful files/symbols/reasons,
- avoid hiding unresolved system risks,
- keep output concise.

## Architecture Guidance

This is the one plan in this group where a small refactor is justified.

The human-attention pipeline is currently embedded in `composer.ts`, which makes it harder to evolve without bloating composition logic. If this plan is implemented, first extract the note lifecycle into a focused module such as `src/pipeline/human-attention.ts`:

- raw hint/uncertainty normalization,
- path validation,
- grouping/deduplication,
- suppression by findings/verifier verdicts,
- output selection,
- artifact shaping helpers.

`composer.ts` should orchestrate these functions, not own the detailed note-processing algorithms.

## Non-Goals

- Do not remove the human-attention section.
- Do not suppress notes only because they are low confidence.
- Do not use LLM calls solely to dedupe notes.
- Do not hard-code Trails, Go, `LockForStatusUpdate`, or route-specific names.
- Do not dedupe findings and human-attention notes through the same exact logic if their semantics differ.

## Plan

1. Audit current human-attention lifecycle.
   - Identify where raw follow-up hints and uncertainties are collected.
   - Identify where notes are grouped, suppressed by findings, suppressed by verification, capped, and rendered.
   - Confirm which normalized fields are already available:
     - files,
     - symbols,
     - question,
     - reason,
     - source packet ids,
     - verification linkage.
   - Identify the smallest clean module boundary before changing behavior.

2. Add a normalized note fingerprint.
   - Normalize:
     - lowercased question text,
     - stemmed or tokenized important terms,
     - sorted files,
     - sorted symbols,
     - category/risk type when available.
   - Build a fingerprint that groups obvious same-root notes without requiring exact text equality.
   - Keep this deterministic and cheap.

3. Add near-duplicate clustering.
   - Merge notes when they share:
     - a dominant symbol overlap and meaningful file overlap,
     - or the same risk category plus same files/symbols.
   - Use normalized question-token overlap only as a tiebreaker inside those structural gates.
   - Do not merge notes on question-token overlap alone.
   - Require enough overlap that unrelated notes in the same subsystem are not collapsed.

4. Merge note content conservatively.
   - Keep one canonical question.
   - Union files and symbols.
   - Combine reasons into a short synthesized reason when distinct.
   - Preserve packet ids and source ids for traceability.
   - Track merged note count.

5. Prefer finding/verdict-aware suppression before output.
   - If a final finding or verified rejected verdict already answers the note, suppress it.
   - Match by normalized file/symbol/root-cause, not only exact path equality.
   - Validate paths before using them for suppression so hallucinated or stale paths do not evade dedupe.

6. Keep output cap meaningful.
   - Apply final cap after dedupe, not before.
   - Rank notes by:
     - severity/risk if present,
     - number of packets contributing,
     - changed files touched,
     - whether the note points to a concrete unresolved predicate.
   - Avoid outputting multiple notes that ask the same human to inspect the same files.

7. Normalize artifacts.
   - Store raw notes once.
   - Store derived grouped/suppressed/output views by note ids or group ids where practical.
   - Avoid duplicating full note payloads across many artifact sections.
   - Keep the artifact writer simple: raw notes once, derived views by ids/groups where practical.

8. Add telemetry.
   - Report:
     - raw notes,
     - exact duplicates merged,
     - near duplicates merged,
     - suppressed by findings,
     - suppressed by verification,
     - invalid-path notes dropped,
     - output notes.

9. Add focused tests.
   - Three differently worded notes about the same files/symbols merge into one.
   - Two distinct concerns in the same file do not merge.
   - Findings suppress overlapping notes.
   - Rejected verifier verdicts suppress notes whose predicate was disproven.
   - Invalid-path notes do not avoid suppression.
   - Output cap is applied after grouping.

## Likely Files

- `src/pipeline/human-attention.ts` or equivalent note processing module
- `src/pipeline/composer.ts`
- `src/telemetry/run-artifacts.ts`
- `src/types.ts`
- `tests/*human*.test.ts`
- `tests/*composer*.test.ts`

## Acceptance Criteria

- Run-17-style duplicate `LockForStatusUpdate` notes would be rendered as one concise note.
- Distinct unresolved concerns are preserved.
- Human-attention artifacts expose raw and grouped counts clearly.
- The final report is shorter without losing real unresolved review work.
- No new LLM calls are added for note dedupe.

## Validation

Run focused tests:

```text
pnpm exec vitest run tests/*human*.test.ts tests/*composer*.test.ts
```

Then run:

```text
pnpm test
pnpm run build
```

On the next eval, check:

- `Needs Human Attention` has no obvious repeated root question.
- `unresolvedNotesSuppressed` and grouped note counts are understandable.
- No expected finding disappears because a note was mistakenly suppressed.

## Stop Conditions

Stop and reassess if:

- near-duplicate matching becomes fuzzy enough to hide distinct risks,
- token overlap alone can merge notes without shared file/symbol structure,
- implementation needs an LLM dedupe pass,
- note artifacts become harder to debug,
- path/symbol normalization becomes language-specific in core code.
