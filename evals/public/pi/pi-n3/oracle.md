---
repo: pi
case: pi-n3
role: contaminated-control
intro: 9022a5b5eaa8bb0938e9b8b28f98b4d76a0519e9
base: cbe1a8b732e45359f20be58b367ea48af9c93acf
introDate: 2026-03-30
contaminationSplit: pre-2026-08-01
---

# pi pi-n3

Review base `cbe1a8b732e45359f20be58b367ea48af9c93acf` (the parent) against head `9022a5b5eaa8bb0938e9b8b28f98b4d76a0519e9`.

## Exclusion rationale

The base ignores the promise returned by a subscriber. The head awaits it and documents `agent_end` as the final event. If an async subscriber rejects on `agent_end`, that rejection now reaches the run failure handler, which emits a second `agent_end`. The base already has the failure handler and can repeat the event on a synchronous throw. The promise rejection path is introduced by this change. [Pinned change](https://github.com/earendil-works/pi/commit/9022a5b5eaa8bb0938e9b8b28f98b4d76a0519e9)

The subscription example already showed immediate unsubscription at base. The new callback changes what the snippet illustrates. The two terminal-event reports concern the runtime in `packages/agent/src/agent.ts:450-474` and `:531-537`. Keep this as an exploratory input and exclude it from the clean-control and required-detection denominators.
