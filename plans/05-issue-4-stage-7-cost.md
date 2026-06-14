# Issue 4: Stage 7 Cost

## Problem

The trails-api run spent about $18.90 in Stage 7, with 231 packet-review model calls for 73 packets. Normal mode routed almost every packet through `lang/go`, `core/code-review`, and `core/tests`, causing broad repeated investigation across similar quote-helper hunks.

Stage 7 should remain high-quality, but normal mode needs stronger cost discipline and better lens selection.

## Plan

1. Tighten lens routing:
   - `core/tests` only for test files, deleted tests, static test signals, planner test risk, or behavior changes with no related tests.
   - `core/code-review` only for source hunks with meaningful behavior/design risk.
   - Language lens remains the broad default for supported languages.
   - Mechanical import-only hunks should usually be language-only/light unless tied to a risky symbol packet.

2. Add packet complexity tiers:
   - `simple`: one call, no tool use unless model identifies a concrete concern.
   - `standard`: current normal behavior with tighter tool cap.
   - `investigate`: allowed multi-round tool use.
   - Planner/depth can promote packets, but deterministic facts can demote obvious mechanical hunks.

3. Adjust tool budgets:
   - Normal default should likely be lower than 8 tool calls / 3 rounds for most packets.
   - Keep deep packets capable.
   - Add per-run caps for total Stage 7 model calls and tool calls separate from packet count.

4. Add repeated-context mitigation:
   - Detect repeated helper-migration patterns across files.
   - Encourage first packet to investigate shared helper deeply, later packets to reuse concise known context from packet facts or review notes.
   - Consider a deterministic shared context note for common changed helpers instead of each packet rediscovering them.

5. Improve scheduling:
   - Review high-risk/deep packets first.
   - Dispatch cheap/light packets earlier only when budget allows, or batch them with one-call no-tool profiles.
   - Reserve enough call budget for Stage 9/10 before Stage 7 starts.

## Tests

- Lens routing test proving `core/tests` is not selected for every source packet.
- Normal-mode budget profile test for a synthetic 100-hunk PR.
- Scheduler test proving deep/high-priority packets dispatch before low-risk worker-loop light packets.
- Fake LLM test showing simple packet completes with one call and no tools.

## Acceptance Criteria

- Normal mode reviews large PRs with materially fewer Stage 7 calls.
- Important packets still get deep/tool-capable review.
- Cost reductions do not come from hiding skipped work; coverage remains honest.
