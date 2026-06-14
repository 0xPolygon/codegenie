# Issue 2: Packet Context Degradation

## Problem

The real run produced degraded packet context for 38 of 73 packets. Some degradation is expected for import hunks and huge symbols, but important packets were degraded too. The worst example was a deep relay packet where one import/top-of-file hunk had no symbol and the packet-level context became only `{ packageName, path }`, despite other hunks in the same packet having useful `processRelayQuote` symbol facts.

Stage 6 should degrade locally and gracefully, not allow one no-symbol hunk to erase useful context for the whole packet.

## Plan

1. Change packet context selection from "single enclosing symbol or degraded" to "best available context":
   - For multi-hunk packets, choose the dominant enclosing symbol when most changed lines share it.
   - Ignore heuristic/no-symbol import hunks when selecting the primary symbol.
   - If multiple real symbols exist, include a compact `packetSymbols` list and context for the highest-risk/highest-line-count symbol.

2. Improve no-symbol handling:
   - Top-level/import hunks should get file outline and nearby top-level declarations.
   - Mark the hunk as `no_enclosing_symbol` but do not mark the whole packet as `symbol not found` if other hunks have symbols.

3. Improve large-symbol truncation:
   - Include signature, line range, changed-line windows, and outline even when full symbol source is too large.
   - For huge functions, include deterministic slices around changed hunks instead of a blind first-N truncation.
   - Add a clear `contextText` section:
     - `Primary symbol`
     - `Changed ranges`
     - `Relevant source excerpts`
     - `Outline`

4. Add context quality scoring:
   - `contextQuality: "full" | "sliced" | "outline_only" | "path_only"`
   - `contextDegradationReasons: string[]`
   - Keep coverage degradation separate from context-quality notes.

5. Update telemetry:
   - Count degradation by reason and by packet coverage.
   - Emit warnings only for high-risk packets that degrade to `outline_only` or `path_only`.

## Tests

- Multi-hunk packet with import hunk plus function hunks selects the function as primary context.
- Huge function includes changed-line slices and outline instead of path-only context.
- Import-only hunk gets outline context without `symbol not found` as a scary run-level reason.
- Existing tree-sitter fixtures cover Go and TypeScript symbol selection.

## Acceptance Criteria

- Deep/normal packets with real symbol facts do not degrade to path-only context.
- `symbol not found` is limited to hunk-local metadata when appropriate.
- Final coverage no longer treats benign import hunk context gaps as review-quality failures.
