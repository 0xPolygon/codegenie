# Development eval runner

After `pnpm install && pnpm build`, run the public example with:

```sh
node evals/runner/main.mjs run --campaign evals/runner/public-example.json
```

This uses normal Codegenie provider configuration and credentials. It fetches the pinned public revision into a detached checkout under the user's cache, verifies its parent and clean state, and runs one case through the built eval runner. It never overwrites an existing checkout. Run artifacts stay outside the source checkout; the oracle is not copied into the reviewed tree. Other public cases can be selected by changing `caseDir`, `caseName` and `publicRepo` (`goinfer`, `pi`, or `codegenie`). Optional `outputDir`, `targetDir`, and `repositoryUrl` are resolved from the config location.

This initial single-case entry point does **not** yet implement campaign budgets, physical-call accounting, retries, resumable receipts, or blind exports. Do not use it for the #405 campaign or other cap-controlled comparisons until those features are reviewed and qualified. Live runs require a provider and incur its normal charges.
