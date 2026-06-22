# Issue 22: Cache Telemetry Clarity

Status: COMPLETE
Planned at: a47a23b, 2026-06-14

## Problem

Run and eval telemetry currently make it too easy to confuse local Codegenie model-call caching with provider-side prompt caching. This is especially confusing during evals where `--cache` controls local reuse, while provider metrics may still report cache reads/writes and affect cost.

This complements Issue 15 by applying the terminology consistently across run summaries, eval summaries, and comparison output.

## Plan

1. Rename or group telemetry fields so local cache and provider cache are visibly separate:
   - local model-call cache: hit, miss, write, disabled
   - provider prompt cache: input cached tokens, cache read cost, cache write cost if available
2. Update run summaries and eval summaries to use the same terms.
3. Update eval compare output so cache changes do not look like model behavior changes.
4. Preserve backward compatibility for old run artifacts by reading legacy field names.
5. Add docs or CLI help text clarifying what `--cache` does.
6. Add tests that assert local cache metrics and provider cache metrics are reported separately.

## Likely Files

- `src/telemetry/telemetry-recorder.ts`
- `src/telemetry/run-artifacts.ts`
- `src/evals/eval-runner.ts`
- `src/evals/eval-compare.ts`
- `src/cli/main.ts`
- `tests/telemetry.test.ts`
- `tests/evals.test.ts`
- `README.md`

## Tests

- Unit test: local cache hit/miss metrics render separately from provider cache token metrics.
- Unit test: eval compare labels local cache and provider cache distinctly.
- Unit test: old artifacts with legacy fields still load.
- CLI/help test if existing test infrastructure covers command help.

## Acceptance Criteria

- A user can tell whether `--cache` changed local replay behavior or the provider reported prompt cache usage.
- Eval reports remain comparable across cached and uncached runs.
- Existing telemetry artifacts do not break.
