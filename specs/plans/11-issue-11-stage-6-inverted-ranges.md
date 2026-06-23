# Issue 11: Stage 6 Inverted Range Reads

Status: COMPLETE

Completed by: Issue 18 plus follow-up audit

Audit note: Issue 18 implemented the Stage 6 range guard for derived context reads, including skipped/clamped debug telemetry. Current Stage 6 code also uses base-side reads for deleted whole-file content and old-side symbol facts, head-side reads for new-side facts, and the same range guard for planner packet-context hints. Mixed hunks keep deleted lines in the packet diff and use valid head-side symbol context when additions exist; deleted/exported base-side signals are handled by repository static-signal extraction. No remaining invalid-range implementation work is tracked here.

## Problem

Stage 6 packet construction can produce invalid internal `read_range` calls when it mixes base/head line coordinates or asks for context around an empty side of a hunk. One observed run emitted errors like:

```text
readRange requires 1 <= startLine <= endLine
path: lib/intentmachine/routingsolver/fallbacks.go
source: head
startLine: 18
endLine: 9..12
```

This did not break the run, but Stage 6 should never call repository tools with invalid ranges. Packet-context construction should handle deleted hunks, moved symbols, and line-range mismatches deterministically before calling `readRange`.

## Plan

1. Add a packet-context range guard:
   - Input:
     - path
     - source side (`base` or `head`)
     - desired start/end
     - reason/context label
   - Output:
     - normalized valid range
     - or a typed skipped-range reason.
   - It should reject or skip inverted ranges before calling `repoIndex.tools.readRange`.
   - Do not silently swap `startLine` and `endLine`; an inverted range usually means the caller chose the wrong side or there is no valid range to read.
   - Clamp only simple boundary issues such as `startLine < 1`.

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
   - Planner hints should never bypass packet-builder side/range validation.

5. Improve telemetry:
   - Count skipped invalid ranges separately from repository-tool errors.
   - Keep true repository/tool failures visible.
   - Do not report expected deleted-hunk skips as scary degradation.
   - Include enough fields to debug the caller bug: requested side, requested start/end, hunk id, and reason.

## Likely Files

- `src/pipeline/packet-builder.ts`
- `src/repo/repository-index.ts` only if caller-facing behavior needs a clearer error shape
- `tests/pipeline-phase5.test.ts`
- `tests/pipeline-phase6.test.ts`
- `tests/repository-intelligence.test.ts` only if repository-tool behavior changes

## Tests

- Deleted-only hunk reads base context and does not call `readRange` with a head-side inverted range.
- Mixed hunk reads valid head and base ranges separately.
- Planner hint with `startLine > endLine` is skipped with telemetry and no tool error.
- Stage 6 packet builder emits no `read_range` tool errors for inverted ranges.
- Inverted ranges are not "fixed" by swapping start/end.
- Existing past-EOF `readRange` behavior remains unchanged.

## Acceptance Criteria

- Stage 6 never emits `read_range` calls with `startLine > endLine`.
- Deleted or side-specific hunks still receive useful context where possible.
- Invalid range telemetry is clear and non-fatal.
- Observed inverted-range cases produce skipped context telemetry, not repository-tool errors.
