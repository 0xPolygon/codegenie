---
repo: pi
case: pi-15
role: positive
intro: e4f50d76db4fc62ef16cf24f74ce6744f3e05da9
base: 7c05885bc401d24f6ac0f250f5aa5a07a419899a
introDate: 2026-11-19
contaminationSplit: post-2026-08-01
fix: 3107a58d2e9a1b426a94bf877bd58dd1282cd1ae
kind: resource-ownership
severity: low
pr: 12283
---

# pi pi-15

Review [7c05885bc401](https://github.com/earendil-works/pi/commit/7c05885bc401d24f6ac0f250f5aa5a07a419899a) against its child [e4f50d76db4f](https://github.com/earendil-works/pi/commit/e4f50d76db4fc62ef16cf24f74ce6744f3e05da9).

## Expected finding for unstarted-tui-captures-suspend

Setting a suspend handler on a fresh TUI registers a process SIGTSTP listener before the TUI starts. The initial stopped flag is false even though it has not taken terminal ownership. The handler can intercept a suspend intended for the actual terminal owner.

## Why the diff introduces it

The parent has no process suspend subscription owned by TuiBase. This change adds one and uses the stopped flag as the subscription condition. An unstarted renderer is therefore treated as an owner.

## Anchors

[packages/tui/src/tui.ts:1094–1104](https://github.com/earendil-works/pi/blob/e4f50d76db4fc62ef16cf24f74ce6744f3e05da9/packages/tui/src/tui.ts#L1094-L1104).

## Severity floor

The prefilter uses low. Expected severity is low. Adjudicate severity independently of detection.

## Fixing evidence

The fix tracks terminal ownership separately. Its tests assert that constructing the TUI and setting the handler leave the process listener count unchanged until start. [Fixing commit](https://github.com/earendil-works/pi/commit/3107a58d2e9a1b426a94bf877bd58dd1282cd1ae)
