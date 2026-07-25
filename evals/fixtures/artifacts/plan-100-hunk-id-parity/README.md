# Plan 100 cross-version fixture

This tracked fixture is the semantic projection of two live deterministic fake-runner executions of `fixture-typescript-lens` with the same case hash:

- `historical-full-ids.json`: fixture run 57, before Plan 100, with 64-character operational hunk IDs.
- `post-change-short-ids.json`: fixture run 65, after Plan 100, with short operational IDs and full `hunkHash` values in the diff artifact.

The projection retains every identity-bearing join needed by the release gate: parsed hunks, planner coverage, packet composition, candidates and anchors, verifier verdicts, coverage records, and final findings. `tests/evals.test.ts` establishes hunk/packet/candidate bijections, validates referential integrity and changed-line anchors, normalizes only those identities, and requires all remaining semantics to compare equal.
