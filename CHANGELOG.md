# Changelog

## 0.9.7

### Fixed

- `search_files` can suggest a corrected call to search for the exact text when a regular expression fails to parse. [#454](https://github.com/0xPolygon/codegenie/issues/454)
- A confirmed provider outage ends the review early when a planner, packet review, or verifier call exhausts its retry limit. The CLI and GitHub Action name the provider and model and include the redacted provider message when available. Final composition retains its deterministic fallback. [#459](https://github.com/0xPolygon/codegenie/issues/459)
- Codegenie classifies explicit content-policy errors in HTTP 200 streams across providers and policy refusals detected in OpenRouter HTTP 5xx responses as `provider_policy_block`. These requests stop retrying, and Codegenie records the upstream provider when OpenRouter reports it. [#348](https://github.com/0xPolygon/codegenie/issues/348)

### Changed

- Tool-argument whitespace guard diagnostics count whitespace by its position relative to JSON strings. The guard still enforces the same limit. [#456](https://github.com/0xPolygon/codegenie/issues/456)
- The development-only eval runner aliases registered hunk IDs in blind-sheet prose using a consistent alias within each sheet. The npm package excludes `evals/`. [#462](https://github.com/0xPolygon/codegenie/issues/462)

### Removed

- `review.assignedEffects` was removed (it was an experimental opt-in, off by default). Configs that set it now fail validation with an unknown-key error. Delete the key. [#464](https://github.com/0xPolygon/codegenie/issues/464)

## 0.9.6

### Telemetry

- OpenAI-format streams that end without provider usage now leave token and cost fields absent. Provider-reported zero stays zero. Run and per-stage summaries include `usageUnknownCalls`. Unknown calls still count toward the model-call limit and contribute no tokens to Codegenie's local token budget. [#436](https://github.com/0xPolygon/codegenie/issues/436) · [PR #438](https://github.com/0xPolygon/codegenie/pull/438)

### Providers

- Direct `anthropic` Messages requests with adaptive thinking now send the selected effort in top-level `output_config.effort`. This aligns request encoding on the direct route and causes a one-time local model-call cache miss there. [#443](https://github.com/0xPolygon/codegenie/issues/443) · [PR #446](https://github.com/0xPolygon/codegenie/pull/446) · [Pi #12464](https://github.com/earendil-works/pi/issues/12464) · [Removal tracker #432](https://github.com/0xPolygon/codegenie/issues/432)

### Development

- Source checkouts include the eval campaign launcher's accounting, blinded export, and offline qualification, plus stream-terminal evidence for individual provider attempts. The npm package excludes `evals/`. [#427](https://github.com/0xPolygon/codegenie/issues/427) · [PR #440](https://github.com/0xPolygon/codegenie/pull/440) · [PR #444](https://github.com/0xPolygon/codegenie/pull/444) · [#439](https://github.com/0xPolygon/codegenie/issues/439) · [PR #445](https://github.com/0xPolygon/codegenie/pull/445)

## 0.9.5

### Repository tools

- Source-selector descriptions show the supported object shapes and where to put filters. When a malformed call has an unambiguous correction, the `invalid_args` response includes the corrected call. This covers `find_definition` and `find_likely_tests` on the default surface and `find_usages` and `search_files` on the six-tool surface. [#425](https://github.com/0xPolygon/codegenie/issues/425)

### Providers

- Direct OpenAI Responses now declares tools at the top level and sends the selected reasoning effort on each request, matching the existing `openai-codex` workaround. ChatGPT sign-in already sent the selected effort and now declares tools at the top level too. [#431](https://github.com/0xPolygon/codegenie/issues/431) · [Pi #12464](https://github.com/earendil-works/pi/issues/12464) · [Removal tracker #432](https://github.com/0xPolygon/codegenie/issues/432)

### Experimental review option

- Set `review.assignedEffects = true` to try structured effect reporting for the changed hunks assigned to each review packet. The option defaults to off, and its effect on review quality is unmeasured. [#405](https://github.com/0xPolygon/codegenie/issues/405)

### Development

- Source checkouts include a development entry point under `evals/runner` for running one pinned public eval case. It is excluded from the npm package. [#429](https://github.com/0xPolygon/codegenie/pull/429)

## 0.9.4

### Repository tool fixes

- `read_definition` accepts a directory scope on the selected revision, with bounded discovery and cursors. Dotted names in `find_symbol_mentions` now match qualified member references.
- Empty cursors start at the first page; invalid or mismatched cursors explain how to recover. Search reports unclosed regular-expression groups with guidance. Tool descriptions clarify selector requirements.
- Budget refusals are consistently recorded as rejected rather than errors. Invalid tool arguments are retained in redacted telemetry for diagnosis, and interrupted argument streams record the available tool and partial progress.

### Review quality

- Oversized patch packets prioritize changed lines and identify omitted ranges. Import and export changes receive bounded repository tools when needed.
- Generated-file detection checks leading comments rather than matching marker text embedded in source. Fallback composition can combine same-cause findings across hunks when they cite each other; promoted questions can use their verified evidence during composition.
- Verification scheduling telemetry records the effective concurrency and reservation mode.
- Composition removes invalid or redundant references where it can do so safely, reducing avoidable fallback reports while retaining source evidence.

### Security

- Packet, source and repair-text caps move boundaries out of recognized or registered credentials rather than splitting them. Selection and packing budgets retain their original decisions; complete examples remain available to the model.
- Persisted telemetry and debug records redact credentials in property names as well as values, preserving all values when redacted names collide. These protections cover recognized patterns and registered secrets; they do not promise redaction of every possible secret format.

### Provider and CLI

- Review model selection accepts provider-qualified model names with any configured provider. Local reviews accept Git ancestry expressions such as `HEAD~1`. The authentication-status command lists authenticated providers.

### Portable tool schemas

- Repository tools, submissions and repair requests use a more portable schema subset. Line ranges retain their `[start, end]` shape, and runtime validation continues to enforce range and repair constraints. Some planner, verifier and repair request schemas change; live compatibility with every provider has not been tested.

## 0.9.3

- `openai-codex` now declares tools at the top level and sends the selected reasoning effort directly on each request. In tests, this restored reported reasoning on most tool turns for two of three fixtures. The third reported reasoning on one of five draws with either format. OpenRouter request bodies matched the previous release byte for byte. [Codegenie #385](https://github.com/0xPolygon/codegenie/pull/385), [Pi #12361](https://github.com/earendil-works/pi/issues/12361), [Codex #47843](https://github.com/openai/codex/issues/47843).

## 0.9.2

### Repository tool fixes

- Source reads, definitions, symbol mentions, outlines, searches, and diff windows give absolute line numbers and file lengths when showing source. Bounded reads keep whole lines, report the delivered span, and point to the first unread location. Diff windows report positions on both revisions.
- A definition is `found` only when verified. Text matches are labelled as unverified leads. A bounded scan with no verified declaration can now report `lookupStatus: "incomplete"` in both `find_definition` and `read_definition`, with a locator when available. This replaces some previous `ambiguous` and `unavailable` results. Telemetry consumers should handle the new value.
- Search and file listings can continue with cursors, and clipped test references point to the next source location. Tool results distinguish incomplete discovery from backend and caller delivery limits. Search errors show how to escape literal characters in regular expressions. A path glob that selects no tracked files has its own message, and source-selector errors show the expected object form.
- When a tool result cannot fit, the runner returns a typed budget refusal in place of a sliced status line or a successful result with no deliverable evidence. An exhausted result pool stops further tool calls and tells the reviewer to submit. When a local target is reached, the notice reports the hard calls, rounds, and result characters remaining on both surfaces. Previously cached model calls miss once because the runner message version changed.

### Review quality

- Concrete open questions can use remaining verification slots, ranked by proximity to changed code. The default cap is four promotions per review, scaled by `review.budgetBoost`. This can add verifier calls.
- Questions the verifier conclusively refutes, including exact copies, stay out of reader attention. Unresolved concerns keep their original question when a rewrite adds no resolution.
- When model composition is unavailable, fallback output groups reports at the same changed line and category into one finding. It preserves the individual reports and withholds conflicting fixes. Supported test-file fixes can appear in the test section.
- Packet building can recover verified symbol context when the planner points to the wrong file. In the experimental six-tool mode, completion is scoped to the packet's assigned changed lines. Sibling hunks are available as context, and an unresolved sibling concern can be carried forward as a question.

### Experimental six-tool surface

- Set `review.toolSurface = "six"` to try `read_change`, `read_range`, `read_definition`, `find_usages`, `search_files`, and `list_files` during review and verification. The development comparison favored keeping `current`, which remains the default and recommended setting.
- `read_change` lists changed files and hunks, and can return numbered base and head rows with enclosing function context. A hunk ID can be paired with its matching path, including the old path on a rename.
- `read_range` supports small whole-file reads and paged declaration maps for larger files without explicit bounds. Unambiguous bounds nested in `source` are normalized. `read_definition` pages declaration locations, recognizes object-literal methods, and reports directory selectors as invalid. `find_usages` reports lexical TypeScript and Go uses with enclosing declarations and binding evidence, with text-only leads marked separately. Search supports literal and regular-expression queries.

### Provider selection

- `codegenie use` and `codegenie provider use` accept `--provider <name>`, `provider/model`, and `provider:model`. All three use fuzzy matching within the selected provider and preserve `:reasoning` suffixes. For example, `codegenie use openai-codex/luna:high` sets the default to the matching Codex model.
- With an unqualified name, the command lists close matches from other providers. A best-rank tie across providers keeps your current provider if it is among them. Otherwise the command asks you to choose explicitly. A scoped match also reports tied models within the selected provider.

### Security

- Redact registered and recognized credentials before truncating telemetry diagnostics and debug previews to prevent fragments at those caps. Persisted records also redact escaped forms of registered credentials and multiline components of at least six characters. Repair-prompt diagnostics longer than 2,000 characters apply credential redaction before truncation.
- Updated transitive dependencies in the Vitest test stack to versions that address reported vulnerabilities.

### Evaluation and tests

- Expanded the public Codegenie, Pi, and goinfer cases, corrected oracle labels and compatibility controls, added verifier analyses and offline tools for partial receipts and source adjudication, froze a reproducible 20-case development and 31-case confirmation split, and removed incidental retry jitter from integration tests.

## 0.9.1

- **Breaking:** Remove `--depth` from CLI commands, `review.depth` from user and repository TOML and eval cases, and `depth` from GitHub Action inputs. Legacy provider `settings.json` files still load. Codegenie silently ignores `defaultDepth` and drops it on the next save. The `run.json` depth field still records `null`.
- Review local changes with `codegenie review --staged` (HEAD to index) or `codegenie review --uncommitted` (HEAD to tracked working tree). Both use local snapshots and disallow GitHub posting. Use `git add -N <path>` to include a new file in an uncommitted review.
- The GitHub Action accepts `stage-models` alongside `model` to set model and reasoning for plan, review, verify, and compose. Missing fields inherit the global selection. An authorized comment that selects a configured alias applies that alias to every stage.
- Public eval cases `go-11`, `pi-n2`, and `pi-n3` remain available for exploratory reviews and are excluded from clean-control and required-detection scoring in future comparisons.

## 0.9.0

- Reviews use one mode. The removed `--depth` and `review.depth` settings (`light`, `normal`, and `deep`) are accepted and ignored with a warning for one release; reviews use the former normal behavior and `run.json` records depth as null.
- The targeted Stage 8 follow-up was removed. The planner no longer skips eligible hunks.
- Published findings no longer include the original-assessments appendix. Composition sources retain the original assessments when telemetry is enabled; ordinary telemetry-off reviews do not retain them separately.
- Reports distinguish shown and omitted unresolved questions. Findings are grouped by severity and then ordered by file and line. Low-confidence findings admitted by the verified exception move to `summaryOnlyFindings` below the inline confidence floor; the floor is applied before inline-slot accounting.
- Streamed tool arguments are bounded. Stage 6 `degradedHunks` now counts real context loss and is not comparable across this change. Sliced context is recorded in the Stage 6 `pipeline_metrics` event rather than exposed as `slicedContextHunks` in the public budget summary.
- `final-review.json` can include `health.verificationCandidateCount`. The `human-attention-notes.json` artifact advances from schema version 3 to 4: always-empty legacy suppression and fallback fields are removed, while `keptForOutputGroupIds` remains.
- Bedrock Claude uses automatic tool choice. `forceSubmitToolChoice=false` also selects automatic choice for Bedrock models; other Bedrock models retain the named default.
- Advanced user-scoped `llm.stages` settings can override model and reasoning for plan, review, verify, and compose; run statistics include optional `stageModels` when used. Mixed-model quality is unmeasured and no model mix is recommended.
- Run retention only prunes authenticated, expired managed runs. A per-user HMAC seal from the run's configured home binds the resolved runs root, run ID, inode, and expiry. The live window is three times the greater of the effective per-run `maxTime` and 30 minutes (90-minute minimum; `--max-time` is honored). If the key path is in a Git worktree or is not a regular file, sealing and pruning are disabled with a warning. Unsealed legacy runs, runs using a different key, and runs whose resolved root changed are preserved and may require manual cleanup. Caller-selected artifact directories are not pruned; the prune event records the deletion count and a bounded name sample.
- Adaptive Stage 7 cache draws have separate cache identities, so cached supplemental reviews no longer reuse the primary draw.
- Invalid or inaccessible review targets now produce concise CLI usage errors instead of internal pipeline diagnostics.
- Provider credentials for reviews, evals and recommendation judging use the same resolved Codegenie home as configuration.
- Public eval labels and pins were corrected, and lexical matcher results require source adjudication.
