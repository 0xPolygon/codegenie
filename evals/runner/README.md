# Development eval runner

After `pnpm install && pnpm build`, run the public example with:

```sh
node evals/runner/main.mjs run --campaign evals/runner/public-example.json
```

This uses normal Codegenie provider configuration and credentials. It fetches the pinned public revision into a detached checkout under the user's cache, verifies its parent and clean state, and runs one case through the built eval runner. It never overwrites an existing checkout. Run artifacts stay outside the source checkout; the oracle is not copied into the reviewed tree. Other public cases can be selected by changing `caseDir`, `caseName` and `publicRepo` (`goinfer`, `pi`, or `codegenie`). Optional `outputDir`, `targetDir`, and `repositoryUrl` are resolved from the config location.

This initial single-case entry point does **not** yet implement campaign budgets, physical-call accounting, retries, resumable receipts, or blind exports. Do not use it for the #405 campaign or other cap-controlled comparisons until those features are reviewed and qualified. Live runs require a provider and incur its normal charges.

The in-progress campaign admission primitives use a fixed 15-second interval after a stale OpenRouter key reading and stop after 20 consecutive stale readings at a boundary. They persist the number of initiated reads, an upper bound on actual GETs, and require reconciliation after an interrupted read. These primitives are not yet wired into the public example above.

An HTTP-200 stream with unknown billing is not by itself evidence of a provider failure. Until the physical stream terminal is recorded separately, an associated failed review remains unclassified and needs receipt reconciliation before a retry.

Worker recovery is local to the recorded host. On Linux, PID-based recovery also requires the recorded PID namespace to match; on macOS it assumes a single host. If process identity or exit cannot be verified, the attempt remains blocked for reconciliation.
