# Issue 33: Stage 7 Compact Finalize for No-Finding Packet Reviews

Status: COMPLETE
Planned from: trails-api eval run 6 review, 2026-06-16
Planned at: commit `506fa43`

## Problem

Run 6 passed and produced good findings, but Stage 7 remains the dominant cost and latency center.

Observed in `/home/peter/Dev/0xPolygon/codeninja-private-evals/trails-api/logs/6`:

- Stage 7 made 194 model calls.
- Stage 7 cost about `$17.57` out of `$22.78`.
- Stage 7 took about 631 seconds wall time at concurrency 4.
- 58 of 73 packets produced no candidate findings, but still cost about `$11.21`.
- Stage 7 finalize calls alone cost about `$7.83`.
- No-candidate finalize calls cost about `$4.47`.

This does not mean no-finding packets are waste. A good reviewer must inspect code and decide there is no material issue. The inefficiency is that many packets reach a forced finalization call after investigation, and that close-out call resends a large packet/tool transcript just to submit an empty result.

Codeninja should make "no findings" a first-class, cheap, auditable outcome while preserving the ability to investigate deeply when the packet has concrete risk.

## Sequencing Note

This plan is still worthwhile, but it should not be treated as the first cost lever. Opus 4.8's run 6 review correctly pointed out that compact finalize treats a symptom after Stage 7 has already done extra work. Execute this after, or at least alongside, the upstream work in:

- `plans/32-issue-32-adaptive-stage-6-symbol-context.md`
- `plans/34-issue-34-run-level-tool-result-memoization.md`

Those plans reduce the amount of avoidable investigation before finalization. This plan then makes the remaining no-finding finalization path cheaper and more explicit.

## Current State

- Packet review agents can return structured review results, including zero findings.
- Stage 7 supports tool use and a forced finalization path.
- `normal` and `deep` reviews intentionally allow real repository tools.
- Stage 7 already has local tool budgets, source-budget extensions, and telemetry for tool-budget pressure.
- The current forced finalization path is too expensive for packets with no drafted finding.
- The prompt does not strongly teach the model that submitting `findings: []` is a successful review outcome once the changed hunk and targeted context have been checked.

## Non-Goals

- Do not skip Stage 9 verification for real candidate findings.
- Do not suppress candidate findings before verification to save cost.
- Do not reduce the default quality posture for `deep` packets.
- Do not make budget exhaustion silently look like a clean no-finding review.
- Do not add project-specific rules based on trails-api.

## Plan

1. Make no-finding submission an explicit review outcome.
   - Add or clarify structured packet-review output fields:
     - `reviewStatus: "findings" | "no_findings" | "incomplete"`
     - `findings: CandidateFinding[]`
     - `noFindingReason?: string`
     - `unresolvedQuestions?: string[]`
   - If the current schema already has equivalent fields, reuse them instead of adding duplicates.
   - Treat `findings: []` plus `reviewStatus: "no_findings"` as a successful completed review, not a fallback.
   - Require a short reason that states what was inspected, for example:
     - "Reviewed the changed hunk and the requested helper source; no concrete changed-line correctness/security/testing issue with evidence."

2. Update packet-review prompts to encourage early clean submission.
   - In `src/skills/prompt-builder.ts`, tell packet reviewers:
     - no finding is a valid high-quality result
     - after resolving the packet's concrete risk, submit immediately instead of continuing broad exploration
     - only continue tool use when one targeted source read can decide a concrete failure mode
   - Keep this depth-aware:
     - `light`: submit after packet-only review unless a concrete issue is visible
     - `normal`: allow targeted tools, but close once the risk is resolved
     - `deep`: allow more investigation before closing
   - Preserve the rule that low-confidence speculation should not become a finding.

3. Add a compact forced-finalize prompt.
   - When Stage 7 must force finalization and the packet has no drafted candidate finding, do not resend the full packet and full tool transcript.
   - Build a compact close-out context containing:
     - packet id, path, coverage, lenses
     - hunk headers and changed-line summary
     - concise packet risk notes
     - tool calls made: tool name, target path/symbol/query, status, and short result summaries
     - unresolved questions, if any
     - explicit instruction: submit findings or `reviewStatus: "no_findings"` only
   - Keep this context capped independently from normal review context.
   - If a candidate finding has already been drafted, keep the richer finalize behavior needed to preserve evidence.

4. Summarize tool results before compact finalization.
   - Add a deterministic tool-result summarizer for close-out only.
   - For source-reading tools, include:
     - path
     - symbol or line range
     - whether lookup succeeded
     - result length and truncation/degradation status
     - first meaningful signature/header when available
   - Avoid copying the same helper source repeatedly into the finalize prompt.
   - Do not use an LLM to summarize tool results; this should be deterministic and cheap.

5. Add review-depth-aware close nudges.
   - After each tool continuation, if the packet has no candidate and the model requests broad exploration, add a short harness-side instruction:
     - "Only continue if the next tool call is targeted to a concrete suspected failure mode; otherwise submit no findings."
   - For `normal`, apply this after one or two investigation rounds.
   - For `deep`, apply later.
   - For `light`, apply immediately after the first continuation.
   - Make the nudge visible in debug artifacts so evals can explain why the model stopped.

6. Improve telemetry for clean no-finding outcomes.
   - Track:
     - `stage7.noFindingSubmissions`
     - `stage7.compactFinalizeCalls`
     - `stage7.fullFinalizeCalls`
     - `stage7.noFindingFinalizeCostUSD`
     - `stage7.candidateFinalizeCostUSD`
     - `stage7.noFindingFinalizePromptChars`
   - Record whether no-finding came from:
     - initial submit
     - normal tool continuation submit
     - compact forced finalize
     - full forced finalize
   - Add these metrics to run artifacts and final budget/debug reporting.

7. Add tests.
   - A packet reviewer can submit `reviewStatus: "no_findings"` with `findings: []`, and Stage 7 records the packet as successfully reviewed.
   - A no-finding forced finalize uses compact context and does not include full repeated tool outputs.
   - A packet with a drafted candidate uses the richer finalize path.
   - Depth-aware close nudges are emitted at the expected investigation round for light/normal/deep.
   - Telemetry separates no-finding finalize cost from candidate finalize cost.
   - Budget/degraded/incomplete packets are not mislabeled as clean no-finding reviews.

## Likely Files

- `src/pipeline/lens-runner.ts`
- `src/llm/llm-runner.ts`
- `src/skills/prompt-builder.ts`
- `src/types.ts`
- `src/telemetry/telemetry-recorder.ts`
- `src/telemetry/run-artifacts.ts`
- `tests/phase4-llm.test.ts`
- `tests/pipeline-phase5.test.ts`
- `tests/telemetry.test.ts`

## Acceptance Criteria

- No-finding packet reviews can complete without a large forced-finalize call.
- Compact forced finalization is used only when no candidate finding has been drafted.
- Candidate-producing packets keep their existing evidence-preserving finalize behavior.
- Stage 7 telemetry reports no-finding vs candidate finalize cost separately.
- Review completeness remains accurate: budget-limited or incomplete packets are not marked as clean no-finding.
- The implementation is generic and depth-aware, with no eval-specific or language-specific shortcuts.

## Expected Effect

The target is to reduce Stage 7 no-candidate finalize cost and latency without lowering recall:

- Lower total Stage 7 cost on large PRs.
- Fewer long no-finding finalize calls.
- Similar or better candidate recall.
- Better debug visibility into why a packet ended with no findings.
