---
repo: pi
case: pi-n4
role: negative-control
intro: a2fd9783f5ecdeaac694d7a8f791f6510164acf7
base: 7edcfe25e43a53dcd976468e8025f5c95b5b052c
introDate: 2026-08-14
contaminationSplit: post-2026-08-01
kind: control/behavior-preserving-refactor
severity: medium
---

# pi pi-n4

Review [7edcfe25e43a](https://github.com/earendil-works/pi/commit/7edcfe25e43a53dcd976468e8025f5c95b5b052c) against its child [a2fd9783f5ec](https://github.com/earendil-works/pi/commit/a2fd9783f5ecdeaac694d7a8f791f6510164acf7).

## Control rationale

The in-memory session repository already imports StorageState from storage-state.ts. This commit replaces its private key helper with the identical function in the module it already depends on. Both helpers concatenate the same namespace, NUL separator and key. The caller inputs, snapshot format and storage-state call sites are identical. Inspecting the imported module and its commit helper shows no reverse runtime dependency on the memory repository.

## Anchors

[packages/agent/src/harness/session/memory.ts:4–4](https://github.com/earendil-works/pi/blob/a2fd9783f5ecdeaac694d7a8f791f6510164acf7/packages/agent/src/harness/session/memory.ts#L4-L4), [packages/agent/src/harness/session/storage-state.ts:35–37](https://github.com/earendil-works/pi/blob/a2fd9783f5ecdeaac694d7a8f791f6510164acf7/packages/agent/src/harness/session/storage-state.ts#L35-L37).

Medium-or-higher reports in these spans are leads for source adjudication.
