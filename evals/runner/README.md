# Development eval runner

After `pnpm install && pnpm build`, run the public example with:

```sh
node evals/runner/main.mjs run-case --campaign evals/runner/public-example.json
```

This uses normal Codegenie provider configuration and credentials. It fetches the pinned public revision into a detached checkout under the user's cache, verifies its parent and clean state, and runs one case through the built eval runner. It never overwrites an existing checkout. Run artifacts stay outside the source checkout; the oracle is not copied into the reviewed tree. Other public cases can be selected by changing `caseDir`, `caseName` and `publicRepo` (`goinfer`, `pi`, or `codegenie`). Optional `outputDir`, `targetDir`, and `repositoryUrl` are resolved from the config location.

This single-case entry point does **not** apply campaign budgets, physical-call accounting, retries or resumable receipts. Live runs require a provider and incur its normal charges.

The in-progress campaign entry point takes a private, hash-pinned config and schedule:

```sh
node evals/runner/main.mjs run --campaign /private/campaign.json --sha256 <campaign-sha256>
node evals/runner/main.mjs release --campaign /private/campaign.json --sha256 <campaign-sha256>
```

`release` opens only an existing campaign and binds the displayed checkpoint prefix; use it only after the checkpoint disposition. The config binds the schedule path and SHA-256, the campaign identity, private ledger/supervisor/evidence/receipt/work paths, the USD cap and hold amounts, the health model and wire metadata, and the build digest. Each schedule slot binds its case identity, boundary, expected packet IDs and worker config, including the case config hash, per-stage wire expectations, suite and build digests, and optional planner capture binding. Generate the build and suite digests with the exported `buildDigest` and `treeDigest` helpers in `integrity.mjs`. Keep private campaign configs and case labels, credentials, run artifacts and receipts outside the checkout. Authentication uses normal Codegenie provider configuration; do not put keys in the campaign config.

This campaign path is not yet qualified for #405: receipt-bound blind export and the complete #405 offline qualification are still required. The public example remains independent of it.

Budgeted campaigns reject cases with `recommendationJudge`: that optional eval judge uses a separate provider adapter and is not covered by campaign accounting. It remains available in ordinary evals and the single-case entry point.

The in-progress campaign admission primitives use a fixed 15-second interval after a stale OpenRouter key reading and stop after 20 consecutive stale readings at a boundary. They persist the number of initiated reads, an upper bound on actual GETs, and require reconciliation after an interrupted read. These primitives are not yet wired into the public example above.

An HTTP-200 stream with unknown billing is not by itself evidence of a provider failure. Until the physical stream terminal is recorded separately, an associated failed review remains unclassified and needs receipt reconciliation before a retry.

Worker recovery is local to the recorded host. On Linux, PID-based recovery also requires the recorded PID namespace to match; on macOS it assumes a single host. If process identity or exit cannot be verified, the attempt remains blocked for reconciliation.

Sealed attempt trees are read-only to prevent accidental artifact changes. Exports must be written elsewhere; removing an attempt tree later requires restoring its owner's write permission first (for example, `chmod -R u+w`).

Use a provider key dedicated to the campaign, or avoid all other use of that key while the campaign runs. Concurrent use counts against the cap, but spend between slot-boundary snapshots is not observed until the next snapshot.
