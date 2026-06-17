# Issue 50: Narrow `find_likely_tests` Tool Surface

Status: PENDING
Planned from: trails-api eval runs 14 and 15 tool-use review, 2026-06-17
Recommended priority: after Stage 5 planner dossier efficiency unless test-recall regressions recur first

## Problem

`find_likely_tests` is implemented as a repository exploration capability, but recent eval runs show the model is not using it as a general Stage 7 tool.

That does not mean the capability is useless. It means the current exposure may be in the wrong layer:

- every Stage 7 reviewer pays some schema/prompt attention cost for another tool,
- reviewers are not choosing it organically,
- test-related review quality still benefits from knowing nearby or likely tests,
- the best use of this capability is probably deterministic packet enrichment or targeted verifier support, not broad LLM tool discovery.

The tool should remain available as an internal capability, but codeninja should avoid exposing unused tools to every packet review when there is no concrete testing reason.

## Goal

Keep `find_likely_tests` as a useful repository capability while reducing Stage 7 tool-surface noise.

The desired shape is:

- Stage 7 normal packet reviewers see fewer general-purpose tools.
- Test-related packets still receive useful likely-test context.
- Stage 9 verification can use likely-test lookup when verifying testing findings.
- The implementation remains generic across languages and repos.

## Non-Goals

- Do not delete the `find_likely_tests` implementation yet.
- Do not make Trails-specific or Go-specific test heuristics.
- Do not require every packet to run test lookup.
- Do not add an LLM pass to discover tests.
- Do not turn likely-test matches into findings by themselves.
- Do not hide evidence from the verifier for `testing` candidates.

## Current Evidence

Recent eval tool-use review showed:

- tree-sitter-backed tools are generally healthy,
- tool failures are budget/pressure issues, not backend failures,
- `find_likely_tests` is exposed but not used in runs 14 and 15,
- codeninja still found the ERC20/native balance test-coverage issue in run 15 without the model calling this tool directly.

That suggests `find_likely_tests` is better as structured context at the right moments than as a general tool in every review prompt.

## Plan

1. Audit current tool registration and exposure.
   - Find where `find_likely_tests` is registered.
   - Find which stages receive it in their tool list.
   - Confirm whether Stage 7, Stage 9, or both currently expose it.
   - Confirm whether any tests assert it is always present.

2. Remove or narrow general Stage 7 exposure.
   - Do not expose `find_likely_tests` to every Stage 7 packet reviewer by default.
   - Keep it available only when the packet has a concrete testing reason, such as:
     - packet path is a test file,
     - packet selected lenses include `core/tests`,
     - packet risk tags include test coverage,
     - changed symbol has known related tests from Stage 6,
     - review mode is deep and the packet is explicitly testing-related.
   - Prefer a small helper such as `shouldExposeLikelyTestsTool(packet, context)` over inline conditionals.

3. Add deterministic packet enrichment where cheap and relevant.
   - For testing-related packets, run likely-test lookup before the LLM call when it is inexpensive and bounded.
   - Store results as concise packet context, for example:
     - `relatedTests`,
     - `likelyTests`,
     - or `testCoverageHints`.
   - Keep entries compact:
     - path,
     - symbol/test name when available,
     - short reason,
     - line range if known.
   - Do not include large test source blocks unless the packet context budget explicitly allows it.

4. Keep verifier access for testing candidates.
   - Stage 9 should be allowed to use likely-test lookup when verifying `category: "testing"` findings.
   - This helps the verifier answer whether a test rewrite dropped meaningful coverage without forcing every Stage 7 reviewer to carry the tool.
   - If the verifier already has sufficient packet/test context, it does not need to call the tool.

5. Preserve generic behavior.
   - Use existing repository indexing, tree-sitter summaries, path/test-role facts, and symbol names.
   - Fall back to text/path heuristics only through existing generic mechanisms.
   - Avoid language-specific rules unless routed through the existing language adapter layer.

6. Add telemetry.
   - Record when likely-test lookup is:
     - exposed as an LLM tool,
     - run deterministically for packet enrichment,
     - used by Stage 9 verification,
     - skipped because the packet was not testing-related,
     - skipped because of budget or unsupported language.
   - This lets future evals prove whether the narrower exposure helps or hurts.

7. Add focused tests.
   - Test that ordinary non-test packets do not expose `find_likely_tests`.
   - Test that test-related packets can still receive likely-test context or tool access.
   - Test that `testing` candidates in verification can access the capability.
   - Test that deterministic enrichment stays bounded and source-light.
   - Use generic fixture names and more than one language where practical.

8. Validate with eval telemetry.
   - On the next comparable eval, check:
     - Stage 7 tool list is smaller for ordinary packets,
     - test-related packets still have test context,
     - no regression in test-coverage findings,
     - no increase in verifier rejections for insufficient test evidence,
     - tool-call count and prompt/tool schema size do not increase.

## Likely Files

- `src/tools/*`
- `src/pipeline/review-runner.ts` or equivalent Stage 7 tool-selection code
- `src/pipeline/packet-builder.ts`
- `src/pipeline/verifier.ts`
- `src/types.ts` if packet context or telemetry types need a small addition
- `tests/*tools*`
- `tests/*packet*`
- `tests/*verification*`

## Commands

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Focused tool tests | `pnpm exec vitest run tests/*tool*.test.ts` | exits 0 if matching tests exist |
| Focused packet/verifier tests | `pnpm exec vitest run tests/*packet*.test.ts tests/*verif*.test.ts` | exits 0 if matching tests exist |
| Full tests | `pnpm test` | exits 0 |
| Build | `pnpm run build` | exits 0 |

## Acceptance Criteria

- `find_likely_tests` is no longer exposed to every ordinary Stage 7 packet review.
- Test-related packets still get useful likely-test context or targeted tool access.
- Stage 9 verification can still use likely-test lookup for testing candidates.
- The implementation is generic and not tied to Trails, Go, ERC20, or any one eval expectation.
- Telemetry reports whether likely-test lookup was exposed, used, enriched, or skipped.
- Existing test-coverage recall does not regress on the next eval.

## Stop Conditions

Stop and reassess if:

- narrowing the tool surface causes test-coverage findings to disappear before candidate generation,
- the deterministic enrichment requires expensive repository-wide scans per packet,
- the implementation duplicates test-discovery logic already present in Stage 6,
- language-specific test matching leaks into core pipeline code,
- verifier precision drops because testing candidates receive too much weak test context.

## Maintenance Notes

This is a tool-surface cleanup, not a capability removal.

The clean boundary is:

- Stage 6 can enrich packets with cheap, bounded likely-test facts.
- Stage 7 should not carry unused tools on every packet.
- Stage 9 should have targeted access when test evidence matters.

If future evals show `find_likely_tests` remains unused even after targeted exposure, then deletion can be reconsidered with real evidence.
