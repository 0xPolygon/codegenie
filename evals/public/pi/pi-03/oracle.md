---
repo: pi
case: pi-03
role: positive
intro: b94482762321ed0b9f8f245be57c84d786a7105d
base: f4f0ac7adaef08f2ec750ccb4c76cd90e93922a7
introDate: 2026-05-19
fix: 4438c58ba2208a8a5d0d27f0ca0b8139748f8ff3
kind: api-contract
severity: high
contaminationSplit: pre-2026-08-01
---

# pi pi-03

Review base `f4f0ac7adaef08f2ec750ccb4c76cd90e93922a7` (the parent) against head `b94482762321ed0b9f8f245be57c84d786a7105d`.

## Expectation `abort-leaves-tool-calls-unanswered`

### Expected finding

The added `if (signal?.aborted) break` statements leave the tool-call loops as soon as the signal is aborted. Tool calls in the same assistant message that the loop has not reached never get a `tool_execution_end` event or a tool-result message. The session therefore keeps an assistant message whose tool calls are only partly answered. Every tool call needs a result, so the remaining calls should get an "Operation aborted" error result.

### Anchor

packages/agent/src/agent-loop.ts:440-442 (sequential loop), 478-480 and 497-499 (parallel loop); a finding at any one site counts. Do not credit findings only about the new aborted checks inside prepareToolCall (lines 589-611).

### Severity floor

The matcher floor is low. Expected severity is high; record it as a calibration note, not as a miss.

### Fixing evidence

4438c58ba removes exactly these three breaks, returns "Operation aborted" from prepareToolCall up front, and adds 123 lines of tests (closes #9986).

