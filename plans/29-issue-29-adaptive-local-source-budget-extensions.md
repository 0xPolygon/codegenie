# Issue 29: Adaptive Local Source Budget Extensions

Status: COMPLETE
Planned from: trails-api eval run 5 review, 2026-06-15
Planned at: commit `db41ed7`

## Problem

Plan 25 improved source recovery and precise tool-budget diagnostics. Plan 26 improved global budget accounting. Run 5 shows the next bottleneck: local packet/verifier tool budgets still reject useful source reads even when the global run budget is healthy.

The worst shape is:

1. A packet reviewer or verifier reads broad context.
2. The worker hits `maxResultChars` or `maxToolCalls`.
3. The model asks for a targeted source read, exact symbol, or narrow range that would resolve a candidate.
4. Codegenie rejects the tool call due to local budget.

Run 5 had 23 local tool-call rejections while global budget overruns were zero. Increasing total token caps alone will not fix this. The fix should allow a small, auditable local extension for high-value exact source reads, without opening unbounded exploration.

## Current State

- `src/pipeline/packet-builder.ts:1415-1422` defines packet tool budgets by coverage/profile, for example normal investigate packets get 6 calls and 12,000 result chars, while normal simple packets get 4 calls and 10,000 chars.
- `src/pipeline/verifier.ts:27-33` defines verifier budget as 8 calls, 3 investigation rounds, 16,000 result chars, 6,000 max single result chars, and 4,000 reserved source result chars.
- `src/llm/pi-runner.ts:256-276` rejects tool calls when result budget, call budget, round budget, or unknown tool limits are hit.
- `src/llm/pi-runner.ts:995-1003` emits `tool_call_rejected` events with budget state.
- `review.budgetMultiplier` scales local tool budgets, but it is blunt: it increases budgets everywhere, including low-value packets.

## Plan

1. Add a bounded local extension policy.
   - Introduce a small extension allowance per packet/verifier worker.
   - Allow extensions only when all of the following are true:
     - global budget checkpoint still permits work
     - the requested tool is an exact source read or exact lookup, such as `read_symbol`, `read_range`, `find_definition` with a concrete symbol, or `read_diff_blocks`
     - the request is tied to a medium/high/critical candidate, a verifier, or a deep/high-priority packet
     - the previous rejection reason is local budget pressure, not safety, invalid args, file missing, or path outside repo
   - Do not extend broad search tools by default, such as `search_files` without a tight query or `list_files`.

2. Keep the extension small and auditable.
   - Suggested default extension:
     - verifier: +2 exact source calls and +8,000 result chars
     - packet reviewer: +1 exact source call and +4,000 result chars for deep/high-priority packets only
   - Scale these extension limits with `review.budgetMultiplier`.
   - Never allow repeated extensions for the same worker beyond the configured allowance.

3. Preserve fail-closed behavior.
   - If the extension is exhausted and decisive source is still unavailable, the verifier should reject or mark incomplete rather than keep a helper-dependent finding.
   - Do not publish findings that require unavailable helper/callee evidence.

4. Emit extension telemetry.
   - Add events such as `tool_budget_extension_granted` and `tool_budget_extension_denied`.
   - Include stage, packet/candidate id, tool name, reason, extension chars/calls used, and remaining extension.
   - Include aggregate extension usage in the local context pressure summary from plan 28.

5. Add prompt guidance.
   - Tell packet reviewers and verifiers that exact source reads are preferred when local context is tight.
   - Tell verifiers that broad searches may be refused after local budget is spent, but exact symbol/range reads are more likely to be granted.

6. Add tests.
   - A verifier that exhausts normal result budget can still receive one small exact `read_range` through the extension.
   - A broad `search_files` request is still rejected when local budget is exhausted.
   - A safety rejection such as path outside repo is never extended.
   - Extension telemetry is emitted and summarized.
   - `budgetMultiplier` scales the extension.
   - A helper-dependent verifier rejects/incompletes when decisive source remains unavailable after the extension.

## Likely Files

- `src/llm/pi-runner.ts`
- `src/types.ts`
- `src/pipeline/verifier.ts`
- `src/pipeline/packet-builder.ts`
- `src/skills/prompt-builder.ts`
- `src/telemetry/run-artifacts.ts`
- `src/util/budget.ts`
- `tests/phase4-llm.test.ts`
- `tests/verifier.test.ts`
- `tests/pipeline-phase5.test.ts`
- `tests/telemetry.test.ts`

## Acceptance Criteria

- High-value exact source reads can proceed through a small local extension when global budget is healthy.
- Broad exploration remains bounded.
- Safety and invalid-argument rejections are never bypassed by the extension.
- Verifier quality improves by resolving decisive source reads instead of keeping or rejecting with incomplete evidence.
- Telemetry makes every extension visible.
- The solution is generic and language-agnostic.
