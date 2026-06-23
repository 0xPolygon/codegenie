# Issue 18: Stage 6 Read Range Guard

Status: COMPLETE
Planned at: a47a23b, 2026-06-14
Completed at: 2026-06-14

## Problem

Both the direct review run and eval run logged Stage 6 `read_range` errors for inverted ranges such as `startLine=18` and `endLine=9`. These errors are not fatal, but they waste work, create noisy telemetry, and can reduce packet context quality.

This overlaps with Issue 11, but this plan scopes the implementation around the observed Stage 6 failure mode and the `read_range` call boundary.

## Plan

1. Add a small range normalization helper for Stage 6 context reads.
2. Validate every derived range before calling `read_range`:
   - reject ranges where `startLine < 1`
   - reject ranges where `endLine < startLine`
   - clamp ranges to known file line count when available
3. Do not silently swap inverted ranges. An inverted range means the caller chose the wrong boundary, so skip the optional context read and emit a debug telemetry event.
4. Apply the guard to symbol context, nearby context, and related file snippets.
5. Keep packet construction deterministic even when optional context reads are skipped.

## Likely Files

- `src/pipeline/packet-builder.ts`
- `src/repo/packet-context.ts`
- `src/repo/repository-index.ts`
- `src/repo/repo-tools.ts`
- `tests/pipeline-phase6.test.ts`
- `tests/repo-tools.test.ts`

## Tests

- Unit test: inverted range is skipped before `read_range` is invoked.
- Unit test: valid ranges still produce expected context.
- Unit test: oversized range is clamped when file line count is known.
- Regression fixture: route fallback packet no longer emits the observed inverted-range error.

## Acceptance Criteria

- Stage 6 produces no `read_range requires 1 <= startLine <= endLine` errors for derived context.
- Invalid optional context ranges degrade gracefully with debug telemetry.
- Packet hunk coverage and changed-line anchoring are unchanged.
