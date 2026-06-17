# Issue 50: Narrow `find_likely_tests` Tool Surface

Status: COMPLETE
Planned from: trails-api eval runs 14 and 15 tool-use review, 2026-06-17
Recommended priority: small tool-surface cleanup after the higher-cost schema/report hygiene plans

## Problem

`find_likely_tests` is implemented as a repository exploration capability, but recent eval runs show the model is not using it as a general Stage 7 tool.

Important current-state note: Stage 6 already runs bounded likely-test discovery through packet context construction and attaches `relevantTests` to review packets. This plan should not add a second deterministic enrichment path unless later telemetry proves the existing packet context is insufficient.

That does not mean the capability is useless. It means the current exposure may be in the wrong layer:

- every Stage 7 reviewer pays some schema/prompt attention cost for another tool,
- reviewers are not choosing it organically,
- test-related review quality still benefits from knowing nearby or likely tests,
- the best use of this capability is probably deterministic packet enrichment or targeted verifier support, not broad LLM tool discovery.

The tool should remain available as an internal capability, but codeninja should avoid exposing unused tools to every packet review when there is no concrete testing reason. This is not correctness-critical, but it is a low-risk cleanup because run 17 shows the direct LLM tool had zero executions while Stage 6 still supplied likely-test context.

## Goal

Keep `find_likely_tests` as a useful repository capability while preserving the existing Stage 6 packet enrichment and, if justified, reducing Stage 7 tool-surface noise.

The desired shape is:

- Stage 7 normal packet reviewers may see fewer general-purpose tools if a simple tool-policy layer is added.
- Test-related packets still receive useful likely-test context from existing Stage 6 `relevantTests`.
- Stage 9 verification can use likely-test lookup when verifying testing findings.
- The implementation remains generic across languages and repos.

## Non-Goals

- Do not delete the `find_likely_tests` implementation yet.
- Do not make Trails-specific or Go-specific test heuristics.
- Do not add another test lookup per packet.
- Do not add an LLM pass to discover tests.
- Do not turn likely-test matches into findings by themselves.
- Do not hide evidence from the verifier for `testing` candidates.

## Current Evidence

Recent eval tool-use review showed:

- tree-sitter-backed tools are generally healthy,
- tool failures are budget/pressure issues, not backend failures,
- `find_likely_tests` is exposed but not used in runs 14, 15, and 17,
- codeninja still found the ERC20/native balance test-coverage issue in run 15 without the model calling this tool directly.
- run 17 found the ERC20 boundary-coverage issue using packet context/static test signals and verifier reasoning, not a direct `find_likely_tests` tool call.

That suggests the current Stage 6 packet context is doing the useful part. The extra Stage 7/Stage 9 tool schema is worth narrowing, but this plan should stay focused on exposure policy rather than deleting the capability or adding new enrichment.

## Plan

1. Audit current tool registration and exposure.
   - Find where `find_likely_tests` is registered.
   - Find which stages receive it in their tool list.
   - Confirm whether Stage 7, Stage 9, or both currently expose it.
   - Confirm whether any tests assert it is always present.

2. Introduce the smallest practical tool-exposure policy.
   - Prefer an optional argument on `buildRepositoryToolDefinitions`, such as `{ includeLikelyTests?: boolean }`.
   - Keep the default backward-compatible unless call sites explicitly opt out.
   - Avoid a generalized tool-policy framework unless another tool needs stage-specific exposure later.
   - Avoid sprinkling tool-name conditionals across Stage 7, Stage 9, and system review code.

3. Remove or narrow general Stage 7 exposure only through that policy.
   - Do not expose `find_likely_tests` to every Stage 7 packet reviewer by default.
   - Keep it available only when the packet has a concrete testing reason, such as:
     - packet path is a test file,
     - packet selected lenses include `core/tests`,
     - packet risk tags include test coverage,
     - review mode is deep and the packet is explicitly testing-related.
   - Do not use Stage 6 `relevantTests` alone as a Stage 7 exposure trigger; those facts are already in the packet and should not re-expand the broad tool surface.
   - Prefer a small helper such as `shouldExposeLikelyTestsTool(packet, context)` over inline conditionals.

4. Do not add new deterministic packet enrichment in this plan.
   - Stage 6 already attaches `relevantTests` using `findLikelyTestsForInput`.
   - If this context is insufficient, improve the existing Stage 6 context path rather than adding a second pre-LLM lookup.
   - Keep entries source-light and bounded as they are today.

5. Keep verifier access for testing candidates.
   - Stage 9 should be allowed to use likely-test lookup when verifying `category: "testing"` findings.
   - This helps the verifier answer whether a test rewrite dropped meaningful coverage without forcing every Stage 7 reviewer to carry the tool.
   - If the verifier already has sufficient packet/test context, it does not need to call the tool.

6. Preserve generic behavior.
   - Use existing repository indexing, tree-sitter summaries, path/test-role facts, and symbol names.
   - Fall back to text/path heuristics only through existing generic mechanisms.
   - Avoid language-specific rules unless routed through the existing language adapter layer.

7. Do not add new telemetry unless implementation reveals a gap.
   - Existing debug request artifacts already show whether the tool was exposed.
   - Existing tool-call telemetry already shows whether the tool was used.
   - Stage 6 packet artifacts already show whether `relevantTests` were attached.
   - Add new telemetry only if tests or eval review cannot answer those questions from existing artifacts.

8. Add focused tests.
   - Test that ordinary non-test packets do not expose `find_likely_tests`.
   - Test that test-related packets can still receive likely-test context or tool access.
   - Test that `testing` candidates in verification can access the capability.
   - Test that existing Stage 6 `relevantTests` behavior stays bounded and source-light.
   - Use generic fixture names and more than one language where practical.

9. Validate with eval telemetry.
   - On the next comparable eval, check:
     - Stage 7 tool list is smaller for ordinary packets,
     - test-related packets still have test context,
     - no regression in test-coverage findings,
     - no increase in verifier rejections for insufficient test evidence,
     - tool-call count and prompt/tool schema size do not increase.

## Likely Files

- `src/tools/*`
- `src/pipeline/lens-runner.ts`
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

- If implemented, `find_likely_tests` is no longer exposed to every ordinary Stage 7 packet review.
- Test-related packets still get useful likely-test context or targeted tool access.
- Stage 9 verification can still use likely-test lookup for testing candidates.
- The implementation is generic and not tied to Trails, Go, ERC20, or any one eval expectation.
- Existing artifacts remain sufficient to tell whether likely-test lookup was exposed, used, or supplied through Stage 6 packet context.
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

- Stage 6 already enriches packets with cheap, bounded likely-test facts.
- Stage 7 should not carry unused tools on every packet.
- Stage 9 should have targeted access when test evidence matters.

If future evals show `find_likely_tests` remains unused even after targeted exposure, then deletion can be reconsidered with real evidence.
