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

When a health probe exposes a provider error message, the campaign step reports its credential-redacted excerpt and `diagnosticSHA256`. The matching `health_diagnostic` receipt in the private evidence directory binds that excerpt to the physical request, HTTP status and stream terminal. Admission still uses the separate health receipt.

Worker recovery is local to the recorded host. On Linux, PID-based recovery also requires the recorded PID namespace to match; on macOS it assumes a single host. If process identity or exit cannot be verified, the attempt remains blocked for reconciliation.

Sealed attempt trees are read-only to prevent accidental artifact changes. Exports must be written elsewhere; removing an attempt tree later requires restoring its owner's write permission first (for example, `chmod -R u+w`).

Use a provider key dedicated to the campaign, or avoid all other use of that key while the campaign runs. Concurrent use counts against the cap, but spend between slot-boundary snapshots is not observed until the next snapshot.

Blind grading uses an existing, terminal campaign and never contacts a provider:

```sh
node evals/runner/main.mjs export-blind --campaign /private/campaign.json --sha256 <campaign-sha256> --output /private/blind --mapping /private/sealed/mapping.json
node evals/runner/main.mjs reveal --campaign /private/campaign.json --sha256 <campaign-sha256> --request /private/reveal-request.json --request-sha256 <request-sha256>
```

The hashed campaign config's `blind` object binds `mappingFile`, `locatorManifestPath`, `locatorManifestSHA256`, `oracleManifestPath` and `oracleManifestSHA256`. The oracle manifest is `{cases:[{caseId,sha256,causes:[{id,optional,anchors:[{path,lineRange}]}]}]}`; use an explicit empty `causes` array for a control. Required and optional causes both receive grading decisions, but optional causes stay out of the primary count. The locator manifest is `{cases:[{caseId,label,sourceLocator,oracleLocator,sourceRoot,sourceRevision,oraclePath,oracleSHA256}]}`. Locators are neutral relative names; the actual source revision and oracle bytes are checked before export. A schedule's `blind` slot binds `arm` (`control` or `treatment`) and `draw`; its worker binds the packet templates. The mapping file is private (0600) and belongs outside the analyst sheet directory. A campaign binds exactly one mapping and manifest; loss or drift requires reconciliation.

The first-lock manifest contains the selected sheet hashes. The command prints its detached hash. The reveal request names `manifestFile`, `manifestSHA256`, `mappingFile`, `locks` (two `{path,sha256}` entries), `reconciliation` (`{path,sha256}`) and `outputFile`. Each lock JSON names its `analyst`, the `manifestSHA256`, and a `grades` array covering every sheet and registered cause. Each grade records the raised, promotion, verification, publication and earliest-loss judgments, candidate/publication references, and other-claim classifications. A sheet with no applicable causes sets `noApplicableCauses:true`. Reconciliation names the same manifest, both `lockSHA256` values and a complete reconciled `grades` array. Reveal verifies these files against the original export and binds one reconciliation hash before writing a separate 0600 pairing file without the secret export key.

Each blinded slot also binds `workerConfig.packetTemplates`, an array of `{packetId, templates}` entries covering its complete expected packet inventory. Derive the versions with `derivePacketTemplates` from the actual packets and product prompt builder. The worker checks and records each packet call's ID, kind and version. Blind export rejoins those tuples to model-call telemetry and debug request artifacts. Location clarification keeps its own purpose and template.

For a case with `llm.stages`, resolve its effective config with `resolveEvalCaseConfig` and derive the slot's `expectedCalls` with `deriveExpectedCalls`. A blind campaign using per-case stage selections also seals `blind.stageSelections` with `control` and `treatment` entries, each `{provider, modelId, reasoning}`. Campaign open checks each arm and its expected calls against the case's effective config before admission. Terminal and historical verification also compare the receipt-inventoried effective Stage 7 settings and native calls to those expectations.

If a projected first-lock sheet contains treatment-specific vocabulary or a treatment template marker, export refuses before writing sheets or a mapping and reports only aggregate affected-sheet and hit counts. Record that refusal for operator disposition; do not redact the markers into visible replacement tokens.

### Blind grading rule `clean-control.v2`

New blind campaigns bind an oracle manifest `{version:2,cases:[...]}`. Each case has `role` (`positive`, `negative-control`, `contaminated-control`, or `compatibility-question`), `causes` with `id`, `optional`, and `anchors`, and `rejects` with neutral IDs and anchors. A negative-control locator binds `admissionAudit: {path, sha256}`. The audit is a JSON record containing case and pinned base/head revisions, the binary diff SHA-256, distinct analyst and curator, disposition, oracle SHA-256, nonempty changed-path scope entries `{path,side,coverage}`, and findings `{ref,verified,causeId?}`. Verified defects on a negative control must map to optional causes. V1 is interpreted in memory when reopening existing campaigns; its export bytes are unchanged.

A primary grade can classify an unlinked claim as `unresolved` with `missingEvidence`. A v2 grade supplies a sparse `assertions` array (empty when none); each entry names a published ID with `status: refuted` and `evidence`, or `status: unresolved` and `missingEvidence`. `rejects` covers each registered reject as `{rejectId,publishedIds}`; every named ID must be a wholly false unlinked claim or have a refuted assertion. E2 counts false-bearing negative-control reviews and E3 counts false claim IDs; their lower bounds count refuted claims and upper bounds add unresolved ones. A T≤C gate passes only if T's upper bound is at most C's lower bound.

After two grade locks, reconciliation and reveal, `node evals/runner/main.mjs score --campaign <file> --sha256 <hash> --request <file> --request-sha256 <hash>` verifies the bundle and writes a deterministic private score. The request contains `outputFile` and `bundles`, each with `manifestFile`, `manifestSHA256`, `mappingFile`, `locks`, `reconciliation`, `revealFile`, and `revealSHA256`; a bundle from another current-format campaign also supplies `campaignFile` and `campaignSHA256` so its supervisor and export authority can be verified. Each lock and reconciliation entry has `{path,sha256}`. Historical studies use `score-historical.mjs` over already authenticated evidence; missing legacy assertion annotations are unmeasured, not zero.
