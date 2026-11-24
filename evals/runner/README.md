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

An HTTP-200 stream with unknown billing is not by itself evidence of a provider failure. The ledger records a separate per-physical stream terminal. Only an explicit provider error event or body reset, joined to the typed failing call, can support provider-failure attribution. Clean EOF without a terminal, local cancellation and ambiguous evidence require reconciliation. The recovered-reset exception still requires a body reset, the full hold and the other registered retry and submit evidence.

Worker recovery is local to the recorded host. On Linux, PID-based recovery also requires the recorded PID namespace to match; on macOS it assumes a single host. If process identity or exit cannot be verified, the attempt remains blocked for reconciliation.

Sealed attempt trees are read-only to prevent accidental artifact changes. Exports must be written elsewhere; removing an attempt tree later requires restoring its owner's write permission first (for example, `chmod -R u+w`).

Use a provider key dedicated to the campaign, or avoid all other use of that key while the campaign runs. Concurrent use counts against the cap, but spend between slot-boundary snapshots is not observed until the next snapshot.

Blind grading uses an existing, terminal campaign and never contacts a provider:

```sh
node evals/runner/main.mjs export-blind --campaign /private/campaign.json --sha256 <campaign-sha256> --output /private/blind --mapping /private/sealed/mapping.json
node evals/runner/main.mjs export-mechanism --campaign /private/campaign.json --sha256 <campaign-sha256> --request /private/mechanism-request.json --request-sha256 <request-sha256>
node evals/runner/main.mjs reveal --campaign /private/campaign.json --sha256 <campaign-sha256> --request /private/reveal-request.json --request-sha256 <request-sha256>
```

The hashed campaign config's `blind` object binds `mappingFile`, `locatorManifestPath`, `locatorManifestSHA256`, `oracleManifestPath` and `oracleManifestSHA256`. The oracle manifest is `{cases:[{caseId,sha256,causes:[{id,optional,anchors:[{path,lineRange}]}]}]}`; use an explicit empty `causes` array for a control. Required and optional causes both receive grading decisions, but optional causes stay out of the primary count. The locator manifest is `{cases:[{caseId,label,sourceLocator,oracleLocator,sourceRoot,sourceRevision,oraclePath,oracleSHA256}]}`. Locators are neutral relative names; the actual source revision and oracle bytes are checked before export. A schedule's `blind` slot binds `arm` (`control` or `treatment`) and `draw`; its worker binds the matching `assignedEffects` boolean and packet template. The mapping file is private (0600) and belongs outside the analyst sheet directory. A campaign binds exactly one mapping and manifest; loss or drift requires reconciliation.

The first-lock manifest contains the hashes of the selected sheets and a detached manifest hash is printed by the command. The mechanism request names `manifestFile`, `manifestSHA256`, `mappingFile`, `locks` (two `{path,sha256}` entries), `reconciliation` (`{path,sha256}`) and `outputDirectory`. Each lock JSON names its `analyst`, the `manifestSHA256`, and a `grades` array covering every sheet and registered cause. Each grade records the raised, promotion, verification, publication and earliest-loss judgments, candidate/publication references, and other-claim classifications; a sheet with no applicable causes explicitly sets `noApplicableCauses:true`. Reconciliation names the same manifest, both `lockSHA256` values and a complete reconciled `grades` array. Unclassified published findings or medium-and-higher surviving candidates block the mechanism export. No mechanism files are written unless those checks pass. The reveal request additionally names `mechanismManifestFile`, `mechanismManifestSHA256`, `coding` (`{path,sha256}`), and `outputFile`; the coding JSON must contain `frozen:true`, the same mechanism manifest hash, and one complete cause-coding record for every treatment sheet. A positive match cites a supplied assigned-hunk effect row with a source-validity judgment; dispositions and uncovered-on-incomplete diagnostics are derived from the bound mechanism evidence. A sheet with no applicable causes explicitly says so. Reveal emits a separate 0600 pairing file without the secret export key.

For #405, seal the registration receipt with `seal405Registration` before calling `generate405Order` from `qualification-405.mjs`. The registered seed is `405-dev20-c9ed7a82`; the receipt records the deterministic ordering rule and oracle-manifest hash. Registration also takes one SHA-bound raw diff per case and mechanically freezes oracle-anchor overlap for diagnostics, recording unmapped causes explicitly. Anchor overlap never restricts a source-valid match on another assigned hunk. The campaign's `qualification405` binds `registrationFile`, `registrationSHA256` and `verifierConcurrency: "native"`. The complete schedule binds its seed, native concurrency, all 80 slots and `pauseAfterSlot` at slot eight. These checks do not authorize a live campaign; the reviewed build, 20 dossier identities and separate operator dispatch approval remain required.

Each blinded slot also binds `workerConfig.packetTemplates`, an array of `{packetId, templates}` entries covering its complete expected packet inventory. `templates` binds the prompt version for `initial`, `tool-continuation`, `repair` and `finalize`. For #405, `qualification405.packetReceiptFile` and `packetReceiptSHA256` bind a separate offline qualification receipt and its hashed packet inventory. Preflight checks the original product `dist` and runner digests, the replay identities and every qualified packet byte, then recomputes the map with the product prompt builder before admission. The worker records each packet call's ID, kind and version; blind export rejoins those tuples to model-call telemetry and debug request artifacts. Location clarification keeps its own purpose and template.

If a projected first-lock sheet contains treatment-specific vocabulary or a treatment template marker, export refuses before writing sheets or a mapping and reports only aggregate affected-sheet and hit counts. Record that refusal for operator disposition; do not redact the markers into visible replacement tokens.
