# Issue 40: Stage 7 Closeout Recall Regression

Status: COMPLETE
Planned from: trails-api eval run 7 review, 2026-06-16
Planned at: commit `ed44aeb`

## Implementation Note

Implemented in this plan:

- safe Stage 7 compact-closeout policy with full closeout as the default for risky, budget-exhausted, degraded, or tool-using packets
- forced-finalize prompt changes so the model is no longer instructed to empty `followUpHints` and `uncertainties`
- uncertainty promotion input widened to concrete `unresolvedQuestions` from completed or incomplete packet reviews
- non-test uncertainties routed through the correctness lane instead of the test-coverage lane
- closeout policy telemetry and regression tests

The broader test-rewrite metadata work in step 8 is intentionally deferred. The run-7 ERC20 coverage miss was a separate no-finding judgment, not the compact-closeout failure that caused the fee-calculator misses. It should become its own plan only if another eval shows recurring test-rewrite recall loss.

## Problem

Eval run 7 regressed sharply against run 6:

- Run 6: `pass`, 7 final findings, 17 candidates, 131/131 hunks reviewed, `$22.78`, 1066s.
- Run 7: `fail`, 2 final findings, 3 candidates, 56/131 hunks reviewed, `$13.05`, 564s.
- Run 7 marked 75 hunks failed because 35 packet reviews returned `reviewStatus: "incomplete"`.
- The missed expectations were lost before candidate generation:
  - `zero-native-price-fee-calculator`
  - `amountfromusd-zero-decimal-token`
  - `erc20-balanceof-test-coverage`

The speed/cost work succeeded mechanically, but Stage 7 recall suffered. The dominant failure mode is not provider failure, schema invalid output, tree-sitter failure, or broken source lookup. It is closeout policy.

Run 7 used compact forced closeout for many budget-exhausted packet reviews. For no-drafted-candidate packets, the runner replaced the full conversation with a compact no-finding closeout prompt. That prompt often omitted decisive source/tool evidence that had already been read, so the model responded with `reviewStatus: "incomplete"` and unresolved questions. Coverage then treated those packets as failed.

Examples from run 7:

- Packet `72a8...` read `CalculateAmountUSD`, `DecimalsFactor`, and `getNativeTokenPriceUSD`, but compact closeout said the validation path could not be confirmed.
- Packet `a81d...` found `AmountFromUSD`, but compact closeout said the source was not shown.
- Packet `e97a...` read `CalculateAmountUSD`, but compact closeout said the helper body/validation was missing.
- The ERC20 balance test packet completed with no findings after reading mostly head-side code and treating deleted RPC/ABI coverage as trivial wrapper coverage.

This means Plan 33's compact finalize was a net negative in its current form. It saved cost and wall time, but it did so by dropping the evidence needed for candidate generation on important packets.

The right response is quality-first rollback, not a larger optimization stack. Keep the useful parts of Plan 33 only where they are clearly safe:

- first-class `reviewStatus: "no_findings"` results
- no-finding telemetry and finalize cost accounting
- close nudges that encourage clean submission after concrete risk is resolved
- compact forced closeout only for genuinely simple, low-risk, fully represented packets

Disable the lossy compact forced-closeout path for investigation-heavy packets. If cost rises back toward run 6, that is acceptable; recall and correctness are the product.

## Diagnosis

The current Stage 7 closeout behavior has three issues:

1. `candidateDrafted` is too narrow.
   - It only becomes true after the model submits a structured finding.
   - A packet can be high-risk, mid-investigation, and tool-budget-exhausted without a drafted finding.
   - Those packets are currently routed through compact `target: "no_findings"` closeout.

2. Compact closeout does not preserve decisive evidence.
   - It includes tool summaries, but not enough exact source from successful `read_symbol`, `read_range`, or `find_definition` calls.
   - It can summarize "lookup found" without the code body that proves or disproves the defect.
   - The model then correctly refuses to invent a finding and marks the packet incomplete.

3. Coverage semantics are too blunt.
   - `reviewStatus: "incomplete"` currently maps to failed hunks.
   - Some packets really should be incomplete, for example provider failure or no meaningful review performed.
   - But "reviewed the hunk, found no concrete defect, still has unresolved speculative questions" should not always mean the hunk was unreviewed.

4. Forced finalize empties the promotion pipeline.
   - The shared no-result instruction (`STAGE7_NO_FINDINGS_SUBMIT_INSTRUCTION`, wired as `finalization.noResultInstruction` in `src/pipeline/lens-runner.ts`) tells the model to submit `followUpHints: []` and `uncertainties: []`, and steers leftover concerns into `unresolvedQuestions`.
   - This instruction is applied on BOTH the compact and full forced-finalize paths, so it is not fixed by the closeout-mode gate in diagnosis 1.
   - Uncertainty promotion reads `followUpHints`/`uncertainties`, not `unresolvedQuestions`. Run 7 therefore considered 1 hint for promotion vs run 6's 92, and promoted 0 vs 3.
   - In run 6, `amountfromusd-zero-decimal-token` was a promotion-sourced candidate (promoted decision "Can originTokenForTotals.Decimals legitimately be 0..." on `fee_calculator.go` / `AmountFromUSD`). Starving promotion loses it independently of the closeout-context fix.

## Non-Goals

- Do not preserve compact closeout for its own sake. If a compact path risks recall, remove or disable it.
- Do not turn speculative concerns into findings.
- Do not hide true incomplete reviews as complete.
- Do not add trails-api-specific rules or Go-only heuristics.
- Do not raise all Stage 7 budgets as the primary fix.
- Do not bypass Stage 9 verification for real candidates.
- Do not add a complex recovery subsystem before restoring the safer closeout behavior.

## Plan

1. Roll back the unsafe Plan 33 closeout route.
   - Stop using compact forced closeout as the default path for no-candidate packet reviews.
   - Use the full transcript closeout for any packet that is not clearly safe for compaction.
   - Treat compact forced closeout as opt-in, not fallback.
   - A packet is not safe for compact forced closeout when any of these are true:
     - `packet.reviewProfile === "investigate"`
     - `packet.coverage === "deep"`
     - `packet.riskNotes.length > 0`
     - `packet.contextQuality !== "full"`
     - closeout reason is `tool_budget_exhausted`
     - the packet contains omitted changed lines or truncated hunk data
     - the model used source-reading tools during the packet review
     - tool results were denied, truncated, or omitted by a source/tool budget
   - Keep compact forced closeout only for ordinary packets where:
     - the changed hunk was fully represented
     - no risk note/static signal/deep planner coverage is attached
     - no repository tools were needed or the tool history is trivial metadata
     - the closeout reason is not budget exhaustion
   - If in doubt, use full transcript closeout.

2. Stop forced finalize from emptying follow-up hints and uncertainties.
   - Remove the `followUpHints: []` / `uncertainties: []` directive from the shared no-result instruction (`STAGE7_NO_FINDINGS_SUBMIT_INSTRUCTION` in `src/pipeline/lens-runner.ts`).
   - Forced finalize (compact and full) must still allow a clean no-finding submission, but must let the model emit concrete, pointer-rich follow-up hints and uncertainties when real unresolved risk remains.
   - Keep the "do not invent findings" and "budget exhaustion is not a finding" guidance.
   - Goal: concerns the model would otherwise bury in `unresolvedQuestions` land in `followUpHints`/`uncertainties`, where uncertainty promotion can see them. This is required even after step 1, because the instruction fires on the full path too.

3. Restore and harden uncertainty-promotion input.
   - Feed concrete, changed-line-anchored `unresolvedQuestions` from `no_findings`/`incomplete` packets into the same promotion candidate pool as `followUpHints`, so a budget-exhausted-but-risky packet can still surface a candidate for Stage 9.
   - Keep the existing promotion gate (concrete failure predicate + changed anchor + evidence). Do not lower it; only widen the input source.
   - Fix the Plan 36 test-lane misclassification in `src/pipeline/uncertainty-promotion.ts`: run 7's only considered uncertainty (a routing-contract question on `SolveQuoteRoutingWithFallbacks`/`QuoteIntent`) was rejected with `test_risk_without_changed_test_or_deleted_coverage`. The test-lane predicate must apply only to test-scoped sources; non-test uncertainties must be judged on the normal correctness lane, not rejected for missing test coverage.
   - Add promotion telemetry: considered count, promoted count, and not-promoted reasons, so a future run shows promotion starvation immediately.

4. Keep the useful Plan 33 pieces.
   - Keep `reviewStatus: "findings" | "no_findings" | "incomplete"`.
   - Keep `noFindingReason` and `unresolvedQuestions`.
   - Keep telemetry that separates no-finding submissions, compact finalize calls, full finalize calls, candidate finalize cost, and no-finding finalize cost.
   - Keep prompt guidance that says no finding is a successful review outcome after concrete risk is resolved.
   - Keep depth-aware close nudges only if they do not force premature closeout after a denied or truncated source read.

5. Add an explicit closeout policy helper.
   - Centralize the decision in one small deterministic function, for example `chooseFinalizeMode`.
   - Inputs should be facts already available to the runner:
     - candidate drafted
     - packet coverage/profile/context quality
     - risk note/static signal presence
     - closeout reason
     - whether hunk/source/tool data was omitted or truncated
     - whether any source-reading tool was used
   - Output should be simple:
     - `full`
     - `compact`
   - Do not introduce several closeout modes unless later evidence shows two modes are insufficient.

6. Preserve exact source evidence and the full changed hunk when compact closeout remains enabled.
   - Even on the narrow compact path, always include the complete changed hunk(s); only tool-result transcripts may be compacted. Never truncate changed lines — drop the `COMPACT_FINALIZE_MAX_CHANGED_LINES` cap, or apply it only to surrounding context lines, not changed lines.
   - For the narrow compact path, keep tool summaries small and deterministic.
   - If the packet used `read_symbol`, `read_range`, `find_definition`, or `read_diff_blocks`, prefer full closeout rather than trying to summarize evidence.
   - If compact closeout includes source metadata, include an explicit marker when source was available but omitted. That case should usually force full closeout under step 1.
   - Avoid building an elaborate evidence-preserving compact transcript now. That can be a future optimization after recall is restored.

7. Refine packet result status semantics.
   - Keep `reviewStatus: "incomplete"` for true incomplete review:
     - provider failure
     - schema failure after repair
     - no meaningful packet review performed
     - decisive changed lines unavailable at closeout
   - Prefer deriving a softer internal coverage status from existing packet output before expanding the public LLM schema:
     - keep `reviewStatus: "no_findings"` plus `unresolvedQuestions` when the packet was reviewed and the remaining questions are speculative or non-decisive
     - record an internal coverage/debug status such as `reviewed_with_unresolved_questions`
     - add a new model-visible `reviewStatus` value only if the existing schema cannot express this cleanly
   - Coverage should distinguish:
     - `reviewed`
     - `reviewed_with_unresolved_questions`
     - `review_failed`
   - Final reports should still say partial when true review failures exist, but should not mark a hunk failed merely because a speculative predicate remained unresolved after successful review.

8. Tighten test-rewrite packet handling (deferred; secondary).
   - Note: the `erc20-balanceof-test-coverage` loss is not a closeout-context failure — that packet completed `no_findings` after 2 of 5 budget rounds without hitting compact finalize, so it is partly LLM nondeterminism. This step reduces but may not eliminate it; keep it lower priority than steps 1-3 and split it into its own plan if it grows.
   - For large test-file rewrites/deletions, Stage 7 should compare removed test coverage against replacement coverage, not only inspect the new helper tests.
   - Add deterministic packet metadata or closeout evidence for test-heavy packets:
     - deleted test names
     - added test names
     - removed mock/helper names
     - production symbols previously exercised by deleted tests when inferable
   - Prompt guidance should say:
     - removed integration-boundary tests can be a real finding even when pure helper tests remain
     - do not dismiss RPC/ABI/IO wrapper coverage as "trivial" unless replacement tests exercise the same integration boundary
   - Keep this generic across languages:
     - "test symbols", "mocks/fakes", "fixtures", "integration boundary", and "production symbols" rather than Go-specific concepts.

9. Improve telemetry and debug artifacts.
   - For every forced closeout, record:
     - closeout mode
     - closeout reason
     - prompt chars
     - whether exact source/tool evidence was available in the transcript
     - whether compact closeout omitted source/tool evidence
     - whether successful source reads were available but not included
     - packet risk/profile/coverage/context quality
   - For incomplete packet reviews, record:
     - which closeout mode was used
     - whether the packet would have been ineligible for compact closeout
     - whether the incomplete reason references source that had already been read
   - Update budget/coverage summaries so context pressure can show:
     - failed hunks
     - reviewed-with-unresolved hunks
     - compact closeout calls
     - full closeout calls

10. Add regression tests.
   - Forced finalize (compact and full) no longer instructs empty `followUpHints`/`uncertainties`; a budget-exhausted risky packet can still emit a concrete hint.
   - A concrete, changed-line-anchored `unresolvedQuestion` from a no-finding/incomplete packet can feed uncertainty promotion and become a candidate.
   - A non-test uncertainty is not rejected by the test-coverage lane.
   - Compact closeout for a low-risk no-finding packet can stay compact and mark reviewed.
   - High-risk `investigate` packet with tool-budget exhaustion uses full closeout.
   - Any packet with source-reading tool calls uses full closeout unless it is explicitly classified safe.
   - Any packet with truncated/omitted hunk or tool evidence uses full closeout.
   - Budget-exhausted packets do not become compact no-finding closeouts by default.
   - If full closeout still returns incomplete, coverage remains partial and visible.
   - Large test rewrite packets include deleted/added test symbol summaries and removed mock/helper hints.
   - The ERC20-style case is represented generically as "deleted integration-boundary test coverage", not as a hard-coded repository example.

## Likely Files

- `src/llm/pi-runner.ts`
- `src/pipeline/lens-runner.ts`
- `src/pipeline/review-runner.ts`
- `src/pipeline/uncertainty-promotion.ts`
- `src/pipeline/packet-builder.ts`
- `src/skills/prompt-builder.ts`
- `src/types.ts`
- `src/telemetry/run-artifacts.ts`
- `src/output/markdown-renderer.ts`
- `tests/phase4-llm.test.ts`
- `tests/pipeline-phase5.test.ts`
- `tests/pipeline-phase6.test.ts`
- `tests/uncertainty-promotion.test.ts`
- `tests/telemetry.test.ts`

## Acceptance Criteria

- Stage 7 restores run-6-level recall behavior before optimizing forced closeout cost again.
- Plan 33's compact forced-closeout behavior is disabled for high-risk, investigation-heavy, budget-exhausted, truncated, or tool-using packets.
- The useful Plan 33 pieces remain: explicit no-finding outcomes, no-finding telemetry, and close nudges.
- High-risk or investigation-heavy packets do not lose decisive source evidence during forced closeout.
- A packet is not marked failed solely because compact closeout omitted source that had already been read.
- True incomplete packet reviews remain visible as partial review coverage.
- Candidate recall on large refactor PRs does not collapse when tool budget is exhausted.
- The solution is generic and language-agnostic.
- Telemetry explains closeout decisions clearly enough to diagnose future regressions without reading raw LLM prompts.
- Uncertainty promotion is no longer starved: forced finalize allows concrete hints, and promotion input recovers toward run-6 levels.
- Non-test uncertainties are evaluated on the correctness lane, not rejected as missing test coverage.

## Expected Effect

This should restore the quality profile of run 6 first. Some of run 7's speed/cost improvement may be lost, and that is acceptable if recall recovers:

- More Stage 7 candidates for high-risk packets.
- Fewer false `review_failed` hunks caused by lossy closeout.
- Better recall on behavior-preserving refactors where decisive evidence lives in helper functions.
- Better recall on large test rewrites that delete integration-boundary coverage.
- Clearer telemetry for compact/full closeout behavior.

## Validation

After implementation, run the trails-api eval again and compare against runs 6 and 7:

- Candidate count should increase materially from run 7's 3 without returning to unnecessary run 6 cost.
- Failed hunk count should drop from run 7's 75.
- Expected fee-calculator findings should be generated before verification.
- The ERC20 balance test coverage issue should either become a candidate or produce a reviewed-with-unresolved status that identifies the deleted integration-boundary coverage.
- Cost may move closer to run 6 than run 7. That is acceptable if candidate recall and reviewed hunk coverage recover.
- Compact finalize calls should be rare and limited to low-risk/full-context packets.
- Uncertainty promotion `considered` should recover from run 7's 1 toward run-6 levels and promote real candidates again.
