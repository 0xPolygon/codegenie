# Issue 43: Stage 7 Compact Removal and Generic Test-Rewrite Recall

Status: COMPLETE
Planned from: trails-api eval run 8 review, 2026-06-16

## Problem

Plan 40 restored Stage 7 recall by routing all risky closeouts through full transcript finalize. In run 8, Stage 7 used:

- `44` full finalize calls
- `0` compact finalize calls
- `0` packet-review failures

That means the compact closeout path is currently dead weight for this workload. More importantly, the prior compact path caused the run-7 recall regression by dropping evidence during forced closeout. Keeping an unused and previously harmful optimization increases code and prompt complexity without a demonstrated benefit.

Run 8 also exposed one remaining real product miss: the `erc20-balanceof-test-coverage` expectation.

The packet was correctly routed:

- path: `workers/balance_increase_test.go`
- coverage: `deep`
- lens: `core/tests`
- result: `no_findings`

The reviewer saw the new generic `verifyBalanceIncrease` helper tests and decided coverage was equivalent or better. The missed issue is generic, not trails-api specific: when a PR replaces specialized integration/adaptor tests with generic helper tests, the review must verify that protocol-specific wiring remains covered. Generic helper tests do not prove deleted tests' RPC, ABI, IO, serialization, callback, or adapter boundaries are still exercised.

## Goals

- Remove the unused compact Stage 7 finalize path unless there is a clear non-risky use case.
- Keep the quality-preserving pieces of Plan 33/40: `no_findings`, `noFindingReason`, closeout telemetry, and full finalization.
- Improve generic test-rewrite recall for deleted integration/adaptor coverage.
- Avoid language-specific or trails-api-specific hard-coding.
- Keep implementation simple.

## Non-Goals

- Do not reintroduce compact closeout as a more complex evidence-preserving system.
- Do not force the model to publish test findings whenever tests are rewritten.
- Do not hard-code ERC20, `balanceOf`, Go, RPC, or this repository.
- Do not expand Stage 7 budgets as the primary fix.
- Do not weaken verifier standards.

## Scope and Sequencing

This plan bundles two independent changes; ship them as separate commits:

- **Compact removal** (steps 1-2) is low-risk cleanup. It does give up a future cost lever on trivial-PR workloads — run 8 had zero compact calls only because it was a large refactor — which is an acceptable simplicity trade.
- **Test-rewrite recall** (steps 3-7) is a feature. Before building the deterministic metadata subsystem, first confirm the erc20-style miss is systematic, not run-to-run variance: it was caught in run 6 and missed in runs 7-8, so run 2-3 replays. Then try the cheapest lever first — the `core/tests` lens-prompt change (step 5) alone, re-run, and only build the metadata machinery (steps 3-4, 6) if the prompt change does not hold.

## Plan

1. Delete or disable Stage 7 compact finalize.
   - Remove Stage 7's `buildCompactPrompt` usage and `shouldUseCompactPrompt` policy if no other stage uses it.
   - Prefer one simple Stage 7 closeout behavior:
     - full transcript finalize
     - submit-only tool
     - no new repo tools during forced finalize
   - Keep no-finding finalize telemetry:
     - no-finding call count
     - prompt chars
     - cost
     - closeout reason
   - If generic `LlmRunner` compact hooks are only used by Stage 7, remove them too. If another stage uses them, keep the runner hook but stop wiring it from Stage 7.
   - Update tests that expected compact mode to assert full closeout instead.

2. Simplify closeout policy docs and telemetry.
   - Replace "compact vs full" as a product concept with "forced finalization after review budget".
   - Telemetry should still expose:
     - forced finalize count
     - closeout reason
     - `no_findings` count
     - `incomplete` count
     - budget/tool pressure
   - Keep historical fields stable where practical, but allow `compactCalls: 0` or deprecate the field after tests/docs are updated.

3. Add deterministic test-rewrite metadata to packets.
   - For packets whose path is a test file or whose diff is mostly test code, compute:
     - deleted test symbols
     - added test symbols
     - deleted helper/mock/fake/fixture symbols
     - added helper/mock/fake/fixture symbols
     - deleted imports and added imports
     - production symbols referenced by deleted and added tests when syntactically inferable
   - Keep this metadata compact and language-agnostic:
     - symbol names
     - line ranges
     - simple call/import references
   - Do not attempt full semantic call graphs.

4. Add a generic "specialized coverage replaced by generic helper tests" signal.
   - Generate a static review signal when a test rewrite deletes specialized boundary coverage and replaces it mostly with helper-level tests.
   - Examples of boundary indicators:
     - deleted mocks/fakes/transports/fixtures
     - deleted tests containing protocol/API/client/RPC/HTTP/DB/filesystem/serialization/ABI/event/log keywords
     - deleted tests calling production methods through real adapters or closures
     - added tests mostly call a generic helper function directly
   - The signal should be advisory, not an automatic finding.
   - Phrase it generically, for example:
     - "Deleted tests exercised an integration/adaptor boundary; replacement tests appear to exercise only a generic helper. Verify boundary wiring remains covered."

5. Strengthen the `core/tests` lens prompt.
   - Add explicit guidance:
     - "Do not treat helper-level tests as equivalent to deleted integration/adaptor tests unless they exercise the same boundary."
     - "When tests are deleted, compare what production behavior the deleted tests protected against what the new tests still exercise."
     - "Removed coverage can be a correctness risk even when the new helper tests are cleaner."
   - Keep the default no-nit stance.
   - Require concrete evidence:
     - deleted test names or deleted boundary helper/mocks
     - replacement tests that do not exercise the same path
     - production path that still depends on the boundary

6. Improve Stage 7 packet behavior for large test rewrites.
   - If a test packet has heavy deleted coverage and truncated hunk context, prefer including deleted symbol summaries over more generic surrounding context.
   - Ensure deleted-only lines are visible enough for the reviewer to compare old coverage to new coverage.
   - If a packet includes one large test rewrite, do not hide deleted tests behind a generic `patch truncated` message without structured deleted symbol summaries.

7. Add regression tests with generic fixtures.
   - Create a small fixture where:
     - old tests exercise an adapter/protocol boundary through a mock transport/client
     - new tests exercise only a pure helper callback
     - the production adapter path still exists
   - Verify packet metadata includes deleted boundary tests/helpers and added helper tests.
   - Verify the test lens prompt packet includes the metadata.
   - Verify no hard-coded words such as ERC20 or `balanceOf` are required for the signal.
   - If there is an LLM-free unit boundary for signal generation, test that directly.

8. Re-run / replay validation.
   - Run unit tests and build.
   - Re-score run 8 after Plan 41; this plan should not be required for routing/native-price credit.
   - Run one live eval after implementation to check whether the ERC20-style test coverage miss recurs.
   - Compare cost and Stage 7 telemetry:
     - compact calls should be removed or remain 0 by design
     - packet failures should remain 0
     - no-finding finalize cost may remain similar; do not optimize it until recall is stable

## Likely Files

- `src/llm/llm-runner.ts`
- `src/llm/pi-runner.ts`
- `src/pipeline/lens-runner.ts`
- `src/pipeline/packet-builder.ts`
- `src/repo/static-signals.ts`
- `bundled-skills/core/tests.md`
- `src/types.ts`
- `tests/pipeline-phase5.test.ts`
- `tests/phase4-llm.test.ts`
- `tests/packet-builder*.test.ts`

## Validation

- Stage 7 no longer wires compact closeout for packet review.
- Forced finalize remains robust and allows `followUpHints` / `uncertainties`.
- Test packets include deleted-vs-added coverage metadata.
- Generic adapter-boundary test rewrite fixture produces a signal.
- trails-api-style ERC20 miss is addressed through generic metadata/prompting, not repository-specific logic.
