# Issue 11: Stage 6 Inverted Range Reads

## Problem

The latest trails-api run completed successfully, but Stage 6 emitted four internal `read_range` errors:

```text
readRange requires 1 <= startLine <= endLine
path: lib/intentmachine/routingsolver/fallbacks.go
source: head
startLine: 18
endLine: 9..12
```

This did not break the run, but Stage 6 should never call repository tools with invalid ranges. Packet-context construction should handle deleted hunks, moved symbols, and line-range mismatches deterministically before calling `readRange`.

## Plan

1. Add a range-normalization helper in packet building:
   - Input:
     - path
     - source side (`base` or `head`)
     - desired start/end
     - reason/context label
   - Output:
     - normalized valid range
     - or a typed skipped-range reason.
   - It should reject or skip inverted ranges before calling `repoIndex.tools.readRange`.

2. Make hunk-side selection explicit:
   - For deleted-only hunks, use base-side ranges when reading deleted code.
   - For added/modified hunks, use head-side ranges.
   - For mixed hunks, read changed head ranges and optionally deleted base ranges separately.
   - Avoid constructing head-side ranges from old/deleted line numbers.

3. Handle empty head ranges cleanly:
   - If a hunk has no valid head range, do not call `readRange` on head.
   - Record `packet_context_range_skipped` with:
     - path
     - source
     - requested start/end
     - reason.
   - Treat this as context degradation only if no other useful context exists.

4. Prevent invalid planner context hints:
   - Apply the same helper to planner-provided `packetContextHints`.
   - Invalid hints should become unresolved hints, not tool errors.

5. Improve telemetry:
   - Count skipped invalid ranges separately from repository-tool errors.
   - Keep true repository/tool failures visible.
   - Do not report expected deleted-hunk skips as scary degradation.

## Likely Files

- `src/pipeline/packet-builder.ts`
- `src/repo/repository-index.ts` only if caller-facing behavior needs a clearer error shape
- `tests/pipeline-phase5.test.ts`
- `tests/repository-intelligence.test.ts` if repository-tool behavior changes

## Tests

- Deleted-only hunk reads base context and does not call `readRange` with a head-side inverted range.
- Mixed hunk reads valid head and base ranges separately.
- Planner hint with `startLine > endLine` is skipped with telemetry and no tool error.
- Stage 6 packet builder emits no `read_range` tool errors for inverted ranges.
- Existing past-EOF `readRange` behavior remains unchanged.

## Acceptance Criteria

- Stage 6 never emits `read_range` calls with `startLine > endLine`.
- Deleted or side-specific hunks still receive useful context where possible.
- Invalid range telemetry is clear and non-fatal.
- The trails-api `fallbacks.go` case would produce no Stage 6 tool errors.
