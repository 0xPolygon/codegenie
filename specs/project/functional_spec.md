---
status: complete
---

# Functional Spec: codegenie

## Purpose

codegenie is a TypeScript CLI for high-signal AI code review of pull-request-style changes. It reviews diffs in a local git repository, uses focused repository exploration tools instead of dumping the whole repo into context, and produces staff-engineer-quality findings with concrete evidence, impact, and actionable fixes.

The default review stance is correctness-first. codegenie should find real bugs, logical errors, security issues, architectural risks, performance problems, missing tests, and maintainability concerns that matter. It should suppress style-only, naming, formatting, and subjective comments unless the user explicitly enables a lint/style lens.

codegenie's reviewer voice should be that of a detail-oriented senior individual contributor who will own the code long term. It should be direct and specific when there is a real problem, polite without softening correctness or design issues, and focused on advice that matters because the reviewer may need to maintain the code long after the original author has moved on.

## Users

Primary users are developers and engineering teams who want an expert code-review assistant for local branches and GitHub pull requests.

Secondary users are maintainers who want to define project-specific review lenses and Markdown skills that teach codegenie how to review their codebase, language, or domain more precisely.

## V1 Input Modes

codegenie should expose a primary command:

```bash
codegenie review
```

The command supports these primary review target forms:

```bash
codegenie review --pr 123
codegenie review <branch-name>
codegenie review --branch feature-branch [--base main]
codegenie review --head <head-ref> --base <base-ref>
codegenie review <base-ref>...<head-ref>
codegenie review <commit> [end-commit]
```

With no target arguments, `codegenie review` reviews the current branch against the resolved base branch, equivalent to `--branch <current-branch>` with the same base-resolution and merge-base semantics. If the current branch is the resolved base itself, or no base branch can be resolved, codegenie should fail with a clear error asking for an explicit review target. Reviewing uncommitted working-tree changes is out of scope for v1.

Common review options:

```bash
codegenie review --depth light|normal|deep
codegenie review --lens <lens-name> [--lens <lens-name> ...]
codegenie review --provider <provider>
codegenie review --model <model-or-provider/model>
codegenie review --reasoning low|medium|high|xhigh|auto
codegenie review --format markdown|json
codegenie review --ci
codegenie review --no-progress
```

`--depth` controls the global review budget and planner bias. The default is `normal`. `light` should favor cheaper packet review and smaller tool budgets. `deep` should allow more `deep` packet coverage and larger tool budgets. Per-hunk coverage may still vary inside the selected depth when the planner sees concrete risk evidence.

`--lens` restricts the run to the named lenses and may be repeated. It overrides the config-enabled lens set for the run, and it may explicitly enable a lens that is disabled by default, such as a lint/style lens. The planner still decides which of the selected lenses apply to each hunk.

`--format` selects the stdout output format. The default is `markdown`. `json` prints the final review object instead of the Markdown report.

Interactive review runs should show a small ASCII progress spinner on stderr, including the active pipeline stage number when known. The progress line must clear before the final Markdown or JSON report is printed to stdout. Progress output is disabled automatically when stderr is not a TTY or `CI` is set, and it is disabled explicitly by `--ci` or `--no-progress`.

`--provider`, `--model`, and `--reasoning` override the user-level provider defaults for one review run. `--provider` scopes model resolution. `--model` may be a provider-specific model id when `--provider` is also passed, or a provider-qualified `<provider>/<model>` value when no provider flag is passed; a qualified value is split on the first `/` only when the prefix matches a Pi-known provider id, otherwise the whole value is the model id (model ids may themselves contain slashes). `--reasoning auto` clears the CLI layer only; resolution then continues `CODEGENIE_REASONING` > `~/.codegenie/settings.json` > `~/.codegenie/config.toml` > the built-in `high` default. Providers exposing different reasoning scales map them onto codegenie's four levels (`low|medium|high|xhigh`).

All v1 modes require running from inside a local git worktree. This means the repository must exist locally so codegenie can inspect files, map diff paths to source files, build context, and run read-only repository tools. The `--pr` mode uses GitHub metadata for PR context and posting, but the reviewed diff, changed files, and commit information should come from local git whenever possible.

The checked-out worktree does not need to match the reviewed head. Reviewed source reads resolve against the reviewed revisions through git, so codegenie can review a PR or branch that is not checked out, and reviewed source content is unaffected by dirty worktree state. Review policy, config, and skills load separately from the trusted local checkout.

### `--pr`

`--pr <number>` reviews a GitHub pull request for the current repository.

Behavior:

- Use the `gh` CLI as the GitHub integration layer for PR metadata, authentication, and comment posting.
- Fetch PR title, body, base/head refs or SHAs, and posting metadata through `gh`.
- List codegenie's own prior review comments through `gh` for rerun duplicate avoidance (see Stage 11).
- Fetch the PR head and base commits into the local repository through `gh` or git when they are not already present locally, and fail clearly when they cannot be fetched.
- Compute changed files, commit metadata, commit messages/descriptions, and unified diff from local git whenever possible.
- Include commit titles and commit descriptions across the reviewed range as planner input.
- Use the local repository for source inspection, diff mapping, and repository tooling, with source reads resolved against the reviewed base/head revisions through git plumbing.
- Support posting inline GitHub comments only when `--post-github-comments` is passed.
- Do not support GitLab in v1.

### `--branch` / `--base`

`--branch <branch-name> [--base <base-branch>]` reviews the head of a branch against a base branch. `codegenie review <branch-name> [--base <base-branch>]` is shorthand for the same branch review when the single positional target resolves as a local or remote branch.

Behavior:

- Compute the effective diff between the base branch and branch head.
- Resolve the base branch in this order:
  - `--base <base-branch>` when passed on the CLI.
  - The configured default base branch in `codegenie.toml`.
  - A local or remote `master` branch, if it exists.
  - A local or remote `main` branch, if it exists.
- If no base branch can be resolved, fail with a clear error asking the user to pass `--base` or configure the default base branch.
- Collect commit titles and commit descriptions across the reviewed range as planner input.
- Prefer merge-base semantics for branch review so the reviewed diff matches pull-request-style changes.
- Prefer branch interpretation for a single positional target that resolves as a branch. If the target does not resolve as a branch, fall back to single-commit review.
- Allow `--base` with the single positional shorthand only when the target resolves as a branch; otherwise fail clearly and ask for `<base>...<head>` when the user intended explicit head/base review.
- Do not attempt to post GitHub comments in v1 from branch-review mode.

### `--head` / `--base` And `<base>...<head>`

`--head <head-ref> --base <base-ref>` reviews a pinned head ref or commit against an explicit base ref.

`codegenie review <base-ref>...<head-ref>` is shorthand for the same pinned PR-style review, following Git and GitHub compare ordering. For example, `codegenie review master...49f4645b40e3` is equivalent to `codegenie review --head 49f4645b40e3 --base master`.

Behavior:

- Resolve both refs locally and fail clearly if either ref is missing.
- Compute the merge base between base and head.
- Diff `mergeBase..head` so the output matches pull-request-style changes from base to head.
- Collect commit titles and commit descriptions across `mergeBase..head` as planner input.
- Treat this as distinct from one-commit review: `codegenie review <commit>` reviews that single commit against its first parent, while `<base>...<head>` reviews the full merge-base comparison.
- Do not attempt to post GitHub comments in v1 from explicit head/base mode.

### Commit Or Commit Range

`codegenie review <commit> [end-commit]` reviews one commit or a commit range.

Behavior:

- With one positional target that does not resolve as a branch, review the changes introduced by that commit.
- With two commits, review the range from the first commit to the second commit.
- Collect commit titles and commit descriptions across the reviewed commit or range as planner input.
- Do not attempt to post GitHub comments in v1 from commit or commit-range mode.

## GitHub Action Mode

`codegenie github-action` is the entrypoint the bundled composite action (`action.yml`) invokes inside GitHub Actions runners; it is not intended for interactive use. It reads the standard Actions environment (`GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`), decides whether the event should trigger a review, and when it should, runs the ordinary `--pr` review with a live status comment on the PR (see `components/repository_and_github.md`, GitHub Action Adapter). With `preflight-only: true`, it performs the same trigger and live-permission checks without claiming a comment or starting a review, and returns `should-run`/`pr-number` Action outputs.

- Trigger lanes: `pull_request` (opened/synchronize/ready_for_review; drafts and fork heads skip) and `issue_comment` (created, on an open PR; the trimmed comment must equal the configured trigger phrase, default `codegenie review`, or start with it followed by whitespace — trailing text is ignored and never parsed into options).
- Authorization: payload author association must be in the allowlist (default OWNER/MEMBER/COLLABORATOR) and a live collaborator-permission check must report write or admin; `allowed-users` bypasses both explicitly. Bot actors are ignored unless allowlisted. Workflow templates run an authoritative non-cancellable preflight job with the same configured values; only `should-run: true` admits the downstream review job that owns `cancel-in-progress` concurrency. A payload-only YAML approximation is forbidden.
- Comment-author identity resolves as `bot-login` input → `/user` lookup → `github-actions[bot]`; status-comment reclaim requires an exact case-insensitive author match against it.
- A non-triggering event is a skip: exit `0`, one-line stdout reason, nothing posted. Review and posting failures keep their existing nonzero exit semantics.
- Inline posting maps to the existing `--post-github-comments` flag; the status comment is enabled only by this entrypoint. Repo-resident config can enable neither.
- Model selection is a single spec input, `provider/model[:reasoning]` (reasoning defaults to `high` in action context; a `:suffix` that is not a reasoning level stays part of the model id). A generic `LLM_API_KEY` env var/input is routed to the env variable the named provider reads (via the provider registry's env-var map); provider-native env vars keep working and are never overwritten.
- Telemetry remains disabled by default. Gate decisions and bounded terminal lifecycle/status counters are logged in CI. Terminal pre/post-cap body sizes are UTF-8 byte counts over the complete attempted payload including the status marker. The same terminal lifecycle object is persisted as `github-action.json` only when telemetry is enabled and the review exposes a run directory; preflight/skips are log-only because no review run exists.

## Provider And Model CLI

codegenie should expose a provider command namespace for LLM provider setup, backed by Pi's provider/model registry and auth storage:

```bash
codegenie provider list
codegenie provider login <provider>
codegenie provider logout [provider]
codegenie provider auth-status [provider]
codegenie provider models [provider-or-search] [--all]
codegenie provider config
codegenie provider config set-provider <provider>
codegenie provider config set-model <provider> <model>
codegenie provider config set-depth <light|normal|deep>
codegenie provider config set-reasoning <low|medium|high|xhigh|auto>
```

Behavior:

- `provider list` prints providers known to Pi's model registry, including whether auth appears configured.
- `provider login <provider>` uses Pi OAuth/device-code flow when available; otherwise it prompts for an API key for API-key providers. Credentials are stored in user-scoped codegenie auth state.
- `provider logout [provider]` removes stored credentials for one provider, or all providers after confirmation.
- `provider auth-status [provider]` reports whether auth is available and where it came from, such as stored credentials, environment variables, runtime override, or model-registry configuration. It must not print secret values.
- `provider models [provider-or-search] [--all]` lists models from Pi's registry. By default it lists authenticated/available models; `--all` lists every known model. Output should include provider, model id, context window, max output tokens when known, reasoning support, and vision/input capability when known.
- `provider config` prints user-level effective defaults as JSON, including the codegenie home directory, auth path, models path, settings path, default provider/model, default depth, default reasoning override, and effective depth/reasoning.
- `provider config set-provider` sets the user-level default provider after validating that the provider exists.
- `provider config set-model` validates the model exists for the provider and stores both the default provider and default model.
- `provider config set-depth` stores the user-level default review depth using codegenie's `light|normal|deep` depth vocabulary.
- `provider config set-reasoning` stores a user-level reasoning override; `auto` clears the stored override, letting resolution fall through to `~/.codegenie/config.toml` and then the built-in `high` default. Providers with different reasoning scales map onto codegenie's four levels.

User provider state should live under `~/.codegenie/` by default, overridable with `CODEGENIE_HOME`:

```text
~/.codegenie/
  auth.json       # provider credentials, chmod 0600
  models.json     # Pi model registry custom providers/models when supported
  settings.json   # default provider/model/depth/reasoning, chmod 0600
  config.toml     # optional user-level config overrides and trust opt-ins
  sessions/       # provider/session state when Pi needs it
```

The home directory should be created with mode `0700` where supported. Auth material must be registered with the redaction layer before any logging, telemetry, cache, debug trace, or error context can include it.

Model selection precedence for `review` and `eval` runs (repo `codegenie.toml` never participates for these keys; `CODEGENIE_PROVIDER`, `CODEGENIE_MODEL`, `CODEGENIE_REASONING`, and `CODEGENIE_HOME` are the only codegenie environment variables in v1):

```text
CLI flags > environment variables > ~/.codegenie/settings.json > ~/.codegenie/config.toml > Pi/provider defaults
```

Within user scope, `settings.json` outranks `config.toml` because the dedicated `provider config set-*` commands write `settings.json`.

Stored `defaultDepth` participates in review-depth resolution; repo project policy outranks the personal default, and depth has no environment layer:

```text
--depth > repo codegenie.toml > settings.json defaultDepth > config.toml > built-in normal
```

If no authenticated model can be resolved, codegenie should fail before Stage 5 with a clear `config_error`, for example: `no authenticated provider model is available; run: codegenie provider login <provider>`.

## Review Pipeline

codegenie should use a staged review pipeline:

1. Parse the diff and changed file list.
2. Filter ignored, generated, vendored, binary, and lock files.
3. Classify files into simple processing facts: language, processing mode, package root, test/generated/vendor/lock/binary status, configured labels, and configured priority.
4. Build syntax-aware changed-symbol information where supported.
5. Run the planning pass.
6. Build compact review packets per hunk or file.
7. Run selected lenses on relevant packets, with bounded parallelism where packets can be reviewed independently.
8. Run optional cross-file/system follow-up review only for repeated scoped follow-up hints from Stage 7; skip otherwise.
9. Verify candidate findings, with only minimal duplicate suppression needed to avoid repeated verifier calls.
10. Deduplicate, rank, and compose final output.
11. Optionally post verified inline comments and a PR summary through GitHub.

Stage ids are stable for telemetry and evals. Mentally, the pipeline is six phases: Inventory (stages 1-4), Plan (5), Review (6-7 plus the optional Stage 8 follow-up), Verify (9), Compose (10), Publish (11). Stage 8 is intentionally narrow and often skips itself.

The unit of candidate review is the changed hunk or file. The unit of understanding is the affected system.

The planner should choose coverage and lenses based on language, changed symbols, touched subsystems, tests touched or missing, configured labels/priorities, and the actual diff content. It should not run every lens on every hunk by default.

The v1 pipeline should remain useful even when syntax intelligence is incomplete. Basic diff parsing, file filtering, file classification, seed context, selected lenses, structured findings, verification, deduplication, and telemetry are required. Tree-sitter changed-symbol extraction for Go and TypeScript/JavaScript should improve packet quality, but parser gaps should degrade gracefully rather than block review.

## Stage 1: Diff Parsing And Change Inventory

Stage 1 resolves the requested review target into a deterministic local change inventory.

Inputs can come from `--pr`, `--branch`, or commit/range mode, but the output should be normalized into the same internal shape: changed files, hunks, absolute old/new line mappings, file statuses, and commit or PR metadata when available.

Stage 1 should:

- Resolve the base and head revisions for the selected input mode.
- Collect commit titles and descriptions across the reviewed range.
- Parse the unified diff into files and hunks.
- Preserve old/new line numbers for every hunk line.
- Identify file status such as added, modified, renamed, copied, deleted, binary, or mode-only.
- Preserve diff side information for each changed line so added lines, removed lines, and context lines can be reviewed and anchored correctly.
- Record GitHub PR metadata when `--pr` is used.
- Fail clearly when the target cannot be resolved or the diff cannot be parsed.

This stage must not call the LLM. Its output is the source of truth for later anchor validation, hunk ids, changed-line detection, and GitHub inline-comment mapping.

Deleted files and deletion-only hunks are part of the review inventory. codegenie should not silently drop them merely because the file no longer exists in the head worktree. Stage 1 should retain their old-side line numbers and old path so later stages can review removed behavior, removed tests, removed exports, removed cleanup, and broken references caused by deletion.

## Stage 2: Filtering Ignored And Non-Reviewable Files

Stage 2 removes files that should not enter the review pipeline and records why they were filtered.

Filtering should be deterministic and explainable. Stage 2 runs the shared deterministic detectors the skip policy needs — built-in generated/vendor/binary/lockfile detection, repository ignore rules where appropriate, and explicit `codegenie.toml` skip rules — and applies policy over their results. Detection results are recorded with provenance on each filter decision and reused by Stage 3 classification for kept files: nothing is detected twice, and filtered files receive no further classification, parsing, or review work.

Stage 2 should filter or mark:

- Generated files.
- Vendored or dependency files.
- Binary files.
- Lockfiles.
- Ignored paths.
- Files explicitly skipped by configuration.
- Mode-only files when v1 cannot review them usefully.
- Deleted generated/vendor/lock/binary files when they match ordinary skip rules.

Filtering decisions must be recorded in telemetry and surfaced in coverage summaries when they affect review completeness. Filtered files should not produce candidate findings, but their counts and paths may still be visible to the planner as review-scope facts.

Deleted reviewable source, test, config, migration, or documentation files should remain in scope by default. If deleted-file context cannot be reconstructed from local git or the diff, codegenie should mark the file as degraded or partially reviewed rather than pretending it was reviewed normally.

## Stage 3: File Classification

File classification should be deterministic, narrow, and auditable by default. It should not require an LLM. The classifier runs on kept files only — skip decisions already happened in Stage 2 — and produces processing facts for the planner; it does not produce findings and should not try to infer business risk from a built-in keyword taxonomy.

Each kept file should receive a processing mode:

- `per-hunk`: default for ordinary reviewable source files.
- `whole-file`: for files that are better reviewed as a unit, such as small added files or files explicitly configured this way.

(`skip` is not a kept-file processing mode: configured `processingMode = "skip"` path rules are consumed by the Stage 2 filter, and skipped files are represented by their filter decisions rather than full classification facts.)

Each kept file should also receive reliable facts when available:

- Language, primarily from extension and known filenames.
- Package root when a nearby package marker is found.
- Test status from established test filename/path conventions.
- Generated, vendor, lockfile, and binary status, copied from the Stage 2 detection results rather than re-detected.
- Changed-line and hunk counts.
- Configured labels and review priority from `codegenie.toml`.
- Reasons and provenance for every processing-mode decision and configured label.

The core classifier should not ship with hardcoded domain/risk keyword lists such as payments, auth, routes, or database. Those concerns belong in the planner's model reasoning, language/static signals, bundled or repo-owned skills, and explicit project configuration.

`codegenie.toml` should allow teams to define path-based handling rules. For example, a team can mark `lib/payments/**` as `critical`, attach labels such as `payments` and `critical-path`, force whole-file or per-hunk review, or skip generated folders. Configured rules should be recorded in telemetry and used by the planner, but the labels are user-provided facts rather than codegenie-inferred risk truth.

## Stage 4: Syntax-Aware Changed-Symbol Extraction

Changed-symbol extraction must be deterministic in v1. It should not call the LLM. It parses changed files locally, maps changed hunk lines to enclosing symbols, and emits compact per-hunk metadata for the planner and packet builder. The goal is to reduce token waste and improve review targeting, not to perform semantic proof.

Stage 4 should use tree-sitter where a grammar is available and fall back to simple line or regex-based detection when parsing is unavailable. Parser gaps should degrade the quality of packet context, not block the review.

`HunkSymbolFacts` is the compact per-hunk metadata produced by changed-symbol extraction. It includes the hunk id, path, changed lines, enclosing symbol name/kind/range, signature when available, and whether the facts came from tree-sitter or fallback detection. The full TypeScript schema is defined in `architecture.md`.

Example per-hunk symbol metadata:

```ts
{
  path: "store/user.go",
  hunkId: "...",
  enclosingSymbol: "(*Store).SaveUser",
  symbolKind: "method",
  symbolRange: [42, 91],
  changedLines: [55, 56],
  signature: "func (s *Store) SaveUser(ctx context.Context, user User) error"
}
```

## Static Signals

Static signals are deterministic hints produced by syntax, diff, or language-specific checks. They are not findings and must not be published directly.

Static signals should help the planner and reviewers notice patterns worth investigating, such as deleted tests, exported API changes, context/lifecycle-sensitive code, concurrency primitives, migration files, ignored errors, resource cleanup patterns, or configured critical paths. They should be conservative, traceable, and cheap to compute.

V1 ships exactly two cross-language rules: `core/deleted-test-file` and `core/exported-api-change`. Per-language signal packs are a Future Consideration.

Each static signal should include:

- Rule id.
- File path.
- Line number and diff side when applicable.
- Category or lens hint.
- Confidence.
- Short explanation.
- Source snippet or changed-line reference when useful.

The LLM decides whether a signal matters in the context of the PR. A static signal without reviewer and verifier evidence is not a candidate finding.

## Stage 5: PR Scout / Planning Pass

The planning pass is the first LLM reasoning stage, but it is not a review pass and must not produce publishable findings.

V1 planner input should be a compact deterministic dossier: PR metadata, commit messages, changed file inventory, file processing facts, configured review depth, configured labels/priorities, hunk ranges, `HunkSymbolFacts`, changed symbol summaries, touched tests, static signals, and available lenses.

The planner should explicitly build a diff understanding before assigning coverage and lenses. It should distinguish declared intent from inferred behavior:

```ts
type DiffUnderstanding = {
  declaredIntent: string
  inferredBehavior: string
}
```

Declared intent comes from PR title/body, commit titles/descriptions, and branch names when useful. Inferred behavior comes from the changed files, changed symbols, tests, static signals, and diff summary.

The v1 planner should not receive repository exploration tools by default. If it cannot decide from the dossier, it should mark uncertainty and schedule deeper hunk/file review rather than opening files itself.

Planner output should include the diff understanding, risk areas, targeted per-hunk coverage overrides, selected lenses, and partial-review disclosure when needed. The planner is not required to emit one coverage decision for every hunk; omitted reviewable hunks receive deterministic `normal` coverage with default core/language lenses in Stage 6.

Findings claiming the implementation contradicts its declared intent must cite both the intent evidence and the changed-code behavior.

The planner should also identify where surrounding-code inspection matters. It should not broadly read files itself by default; instead it should name the hunks, symbols, files, tests, or existing patterns that later stages should inspect. Examples include sibling methods that establish a consistency pattern, call sites affected by a changed API, tests for the changed behavior, or nearby lifecycle/resource-management code.

The planner must not skip a reviewable changed hunk without a reason.

The planner owns coverage and lens overrides. It should emit `light`, `normal`, `deep`, or `skip` decisions only for hunks where concrete evidence justifies non-default coverage, specific lenses, context hints, or a skip. Later stages may validate malformed planner output or apply deterministic default coverage to omitted hunks, but they should not become independent risk classifiers.

Configured review depth should influence budgets and defaults, not replace judgment. A `light` run may still review a concrete critical-risk hunk at `normal`; a `deep` run may still skip generated files or keep mechanical hunks at `light`.

## Large Review Handling

codegenie must handle large PRs and large commit ranges without trying to fit the entire diff into one model context.

V1 large-review handling is deliberately simple:

1. Build a complete deterministic inventory of changed files, hunks, languages, file processing facts, tests, generated files, configured labels/priorities, and any available changed symbols or static signals. The inventory is always complete even when model context is limited.
2. Compact the planner dossier deterministically when it exceeds the planner budget: summarize per directory/package instead of per hunk, and record omitted detail with counts and reasons.
3. If even the compacted dossier does not fit, split the inventory deterministically by package/directory and run the same planner prompt once per chunk, mechanically concatenating the per-hunk decisions. There is no meta-planner and no model-driven grouping in v1.

Hierarchical planning — compact group summaries, per-group sub-planners, and a meta-planner that merges group plans — is deferred (see Future Considerations) until telemetry shows chunked planning degrading plan quality on real reviews.

Every changed hunk should receive an explicit coverage decision:

- `deep` for changes with strong risk evidence, such as configured critical paths, exported API/interface changes, migrations, lifecycle/concurrency-sensitive code identified by symbols or skills, or planner-inferred risks backed by concrete diff evidence.
- `normal` for ordinary application logic.
- `light` for low-risk or mostly mechanical changes.
- `skip` for generated, vendored, or irrelevant changes, with a reason.

If codegenie cannot review the full change set within the configured time or token budget, it should produce a partial-review result rather than pretending the review is complete. The stdout report and GitHub summary, when posted, must disclose reviewed hunk counts, skipped hunk counts, coverage levels, and the reason for partial coverage.

## Failure And Budget Semantics

codegenie should degrade predictably when model calls fail or budgets run out. Completed review work must never be lost silently, and failures must surface in coverage disclosure rather than disappear.

Per-stage LLM failure policy:

- Every structured LLM call gets one schema-repair retry.
- Stage 5 planner: if the planner call fails terminally, codegenie must fall back to a deterministic default plan — all reviewable hunks at `normal` coverage, core lenses plus the file's language lens — and mark the run as degraded-planning in coverage disclosure. Later stages run normally.
- Stage 7 packet workers: transient or schema failures get one retry. Terminal failure marks the packet's hunks as `review_failed` in coverage accounting, counts toward partial-review disclosure, and never silently drops hunks.
- Stage 9: verification failure rules are unchanged from the Stage 9 section.
- Stage 10 composer: one repair retry. Terminal failure triggers a deterministic fallback composition — verified findings rendered with template wording, fingerprint-level grouping only, ranked by severity and confidence — with a disclosure note that semantic composition was skipped.
- Authentication or provider-wide failures at any stage fail the run.

Budget exhaustion ladder, applying to `timeoutMs`, `maxBudgetTokens`, and `maxModelCalls`:

- Budgets are checked before each new model call or worker dispatch.
- On exhaustion: stop scheduling new packet reviews, then verify already-produced candidates using the reserved budget slice, and always run composition and emit a partial-review disclosure.
- codegenie should reserve approximately 15% of the configured token and model-call budgets, and a fixed tail of the runtime budget, for Stages 9-10 so completed review work is never lost to exhaustion.
- A hard kill at 2x the configured runtime budget is fatal; even then codegenie should attempt to write telemetry artifacts before exiting.
- The run-level coverage status is owned by the orchestrator. It aggregates plan-time coverage, runtime failures, budget stops, and verification incompleteness into the final coverage summary, not only the planner's partial-review flag.
- Successful runs should finalize as either `completed_full` or `completed_partial` in `run.json`. A partial run still exits `0` by default, but `run.json`, `telemetry.json`, `coverage.json`, and the Markdown report must include the budget stop reason and grouped unreviewed hunk paths when budget exhaustion caused the partial review.

Provider rate limiting: 429 and transient 5xx responses should get up to 3 retries with exponential backoff, and retries count against budgets.

Zero-work path: if the resolved diff is empty, or every changed file is filtered at Stage 2, codegenie should short-circuit after Stage 2, before Stage 3 (hence zero LLM calls and no classification work), print a "nothing to review" report including the filter summary, write telemetry, and exit `0`.

## Parallel Review Execution

codegenie should parallelize review work when doing so does not reduce review quality.

V1 should support bounded concurrency for independent hunk/file review packets. Packets are independent by construction in v1 — workers have isolated context and packets never span files — so all packets may run concurrently up to the configured limit. Scheduling order is per-packet priority derived from coverage level and configured priority; under budget pressure, higher-priority packets are dispatched first. The planner does not emit scheduling groups in v1 (see Future Considerations).

Parallel execution rules:

- Hunk/file candidate-generation passes may run concurrently.
- The planning pass must run before parallel packet review.
- Verification may run concurrently per candidate finding.
- Deduplication and final composition must run after verification.
- Concurrency must be configurable and have a safe default.

The system should track which sub-agent or worker reviewed each packet so findings can be traced back to the exact stage, lens, packet, and source evidence that produced them.

## Stage 6: Review Packet Construction

For each relevant hunk or file, codegenie should construct a deterministic review packet before invoking reviewer lenses.

A `ReviewPacket` is the unit of model review. Every packet contains one or more changed hunks. The packet kind explains why those hunks are reviewed together, such as a single hunk, nearby coalesced hunks, a small file diff, or a whole-file review.

Review packet construction is deterministic in v1. It must not call the LLM and should not perform broad repository exploration. It assembles planned hunk/file work orders from the diff, file facts, `HunkSymbolFacts`, compact local context, configured labels, hunk-scoped planner notes, selected lenses, and tool budgets. It may use bounded repository tools to resolve exact symbol bodies, explicit planner context hints, and a lean changed-hunk relationship graph.

Default packet construction should be hunk-first. Coalesce only nearby hunks in the same file or same enclosing symbol. Use file/whole-file packets for single-hunk files, small added files, small configured files, or explicit `processingMode = "whole-file"` rules.

The packet builder validates and assembles planner decisions; it does not make primary risk decisions. If a reviewable hunk has no planner coverage, the packet builder quietly applies deterministic `normal` coverage with default core/language lenses. If the planner skips a reviewable hunk without a valid reason, the packet builder falls back to `normal` and records the malformed skip.

Planner notes must be hunk-scoped. Stage 5 may include short `focusNotes`, concrete `relatedSymbols`, concrete `relatedFiles`, and `surroundingContextHints` on a coverage decision. Stage 6 carries those notes into the packet only as advisory `attentionNotes`; it must not turn broad planner prose into review obligations. When deterministic related changed context is attached, the strongest relationship notes should be preserved ahead of planner notes under the attention-note cap so caller/callee/output topology remains visible to Stage 7.

Packet grouping should stay conservative in v1:

- Default to one packet per hunk.
- Coalesce only within the same file.
- Prefer coalescing hunks with the same enclosing symbol.
- Allow very nearby same-file hunks to coalesce when the combined packet stays below strict size limits.
- Do not create cross-file review packets in v1.
- Cross-file concerns are recorded as follow-up hints (see Stage 8).
- Split packets back into smaller packets when patch or context size limits would be exceeded.

Stage 6 also builds a small deterministic relationship graph among changed hunks and changed symbols. V1 edges are limited to same enclosing symbol, changed-symbol mention, and explicit planner symbol/file hints. The graph is not a semantic risk classifier. It is used only to attach bounded `relatedChangedContext` snippets to packets when another changed hunk/symbol is mechanically related. Cross-file packets are still forbidden.

Each packet should include:

- PR or diff summary.
- The declared intent of the change, fenced as data.
- File path and language.
- Packet kind: `hunk`, `coalesced-hunks`, `file-diff`, or `whole-file`.
- Coverage: `light`, `normal`, or `deep`.
- Selected lenses.
- One or more hunks with unified diff content.
- Absolute new-file line numbers for changed lines.
- Absolute old-file line numbers for removed lines.
- Diff side metadata for added, removed, and context lines.
- Changed line numbers.
- Deterministic enclosing symbol metadata when available.
- Rendered enclosing-symbol source, file outline, and likely tests when available.
- Surrounding-context hints from the planner or deterministic repository intelligence.
- Configured labels and advisory hunk-scoped attention notes from Stage 5.
- Bounded related changed context when the changed-symbol graph mechanically links another changed hunk/symbol.

Review packets should be compact. They should not contain the whole repository or large unrelated file dumps.

Stage 6 should include cheap deterministic surrounding context when it improves reviewer accuracy without blowing the context budget: the enclosing symbol source, a file outline, and likely tests. Richer pre-attached context — sibling symbols, AST summaries, nearby imports — is a Future Consideration; reviewers fetch that context on demand with read-only tools. Stage 6 should not perform broad repo exploration or try to prove findings.

Deleted files and deletion-only hunks should produce review packets when they are reviewable. These packets should clearly mark that the changed content is old-side/deleted content, include removed-line numbers, and include base-revision context when available. Reviewers should focus on risks caused by removal: removed required behavior, removed tests, removed security checks, removed cleanup, removed exports, broken callers, stale references, and migration/config consequences.

## Stage 7: Lens Review Execution

Lens review execution is the candidate-generation stage. It runs selected lenses against planned review packets and produces structured candidate findings, follow-up hints, and uncertainties. It must not publish comments directly.

V1 should run one composite review task per packet. If a packet has multiple selected lenses, those lenses should be included in one model task rather than running one model call per lens. This keeps cost and latency bounded while still letting language, core correctness, tests, and project-specific guidance work together.

Packet reviews should run in a parallelizable sub-agent-like worker system owned by codegenie. The orchestration ideas can be informed by Pi subagent patterns such as focused child tasks, fresh or forked context, parallel workers, bounded background execution, progress/status tracking, artifacts, and compact result handoff, but codegenie should not depend on the `pi-subagents` package directly in v1. The parent orchestrator owns scheduling, concurrency, cancellation, telemetry, tool permissions, and result validation.

Each packet worker should have:

- A stable worker id.
- One review packet.
- Selected lenses and projected skill guidance.
- A bounded read-only tool budget.
- A structured output schema.
- Isolated prompt context so workers do not share mutable conversation state.
- Telemetry and logs tied to the worker id, packet id, stage, and run id.

Execution should be coverage-aware:

- `simple`: one structured call with no repository tools, used for light packets or obvious mechanical changes.
- `standard`: real read-only tool access with focused review instructions and a reduced normal-mode tool budget.
- `investigate`: real read-only tool access, larger budget, and more focused investigation rounds for deep/high-risk packets.

Standard and investigate packet reviewers may use the same read-only tool suite. The difference is budget, investigation depth, and prompting, not capability. Simple packets receive no repository tools and should return no findings unless the issue is clear from packet text.

Stage 6 should deterministically prune low-value lenses before Stage 7. The language lens remains the broad default for supported languages. `core/tests` should be kept for test files, deleted tests, static test signals, planner test hints, hunk-scoped attention notes, or important untested behavior; it should not be attached to every routine source packet. `core/code-review` should be kept for real source behavior/design risk, but mechanical import-only packets should usually be language-only/simple unless a configured priority, deep coverage, planner hint, or hunk-scoped attention note promotes them.

Reviewer workers should submit an empty finding list when the packet evidence is insufficient. They should use tools only to support, narrow, or reject a concrete changed-code concern, not for broad repository exploration. If Stage 6 attached related changed context, a no-findings result should account for why that related caller/callee/output context does not change the packet's observable behavior.

Packet reviewers should not review a hunk in isolation. They should use packet context first, then use read-only repository tools when needed to inspect the surrounding code that determines correctness:

- Enclosing symbols and relevant surrounding lines.
- Sibling functions, methods, classes, or modules that show local patterns.
- Call sites or references affected by the change.
- Tests for the changed behavior.
- Nearby setup, cleanup, lifecycle, authorization, configuration, or resource-management code.
- Existing patterns in the same file, package, or component.

Tool use should remain bounded by the packet coverage and tool budget. Reviewers should inspect surrounding code to prove, narrow, or reject a concrete concern, not to conduct a broad exploratory audit.

Skill and lens prompt content should be projected and capped for the review stage. codegenie should include only the guidance relevant to candidate generation rather than pasting entire large skill files into every packet prompt.

After each packet review, codegenie should validate the structured result before sending candidates to verification. It should record schema failures, out-of-hunk anchors, missing evidence, low-confidence findings, tool calls, prompt size, token usage, runtime, and task status in telemetry. Findings outside the changed hunk should not be treated as inline candidates unless they can be re-anchored to a changed line with concrete evidence.

## Stage 8: Cross-File / System Follow-Up Review

Stage 8 is a narrow targeted follow-up, not a broad whole-repo review pass. It promotes repeated, scoped Stage 7 follow-up hints into a small number of focused system review tasks. If no repeated scoped hints exist, Stage 8 records `system_review_skipped` and performs no model work.

Packet reviewers emit structured follow-up hints when they need cross-file evidence they cannot resolve locally:

```ts
type FollowUpHint = {
  // Specific cross-file question the packet reviewer could not resolve locally.
  question: string
  // Files the reviewer believes are needed to answer the question.
  files: string[]
  // Symbols, functions, types, methods, interfaces, or constants involved.
  symbols: string[]
  // Lenses that should be active if this hint becomes a system follow-up task.
  suggestedLenses: string[]
  // Why this follow-up is needed and what evidence triggered it.
  reason: string
  // Reviewer confidence that the follow-up is worth scheduling.
  confidence: "high" | "medium" | "low"
}
```

Hints must be pointer-rich. Vague hints such as "check architecture" should be rejected or ignored unless they include a specific question with named files or symbols.

Stage 8 should:

- Ignore low-confidence hints.
- Group hints by normalized question plus concrete file/symbol scope.
- Require the same scoped question to appear from more than one packet before scheduling work.
- Cap work to a small number of tasks per run.
- Give each task the same read-only repository tool suite as packet review, under a stricter task budget.
- Produce either candidate findings, resolved hint notes, or no output.
- Send every Stage 8 candidate finding through Stage 9 verification before it can reach composition or publishing.
- Suppress duplicate human-attention notes only when Stage 8 explicitly resolves the same scoped question.

Hints that are not promoted, or that remain unresolved, are still recorded in telemetry. Medium- and high-confidence unresolved hints are surfaced in the final report as "needs human attention" notes so the cross-file question reaches a human reviewer instead of disappearing silently.

## Stage 9: Candidate Verification

Candidate verification is the false-positive control stage. Candidate findings from packet reviewers are not publishable until they pass verification.

Before spending LLM verifier calls, codegenie should run deterministic pre-verification gates:

- Validate candidate schema.
- Validate changed-line anchor when inline publication is requested.
- Reject or suppress candidates with no changed-code evidence.
- Reject or suppress candidates with no concrete failure mode.
- Suppress low-confidence candidates by default, except critical/high severity, which go to verification (the verifier is the right place to resolve uncertain-but-critical claims).
- Pre-cluster exact or obvious duplicate candidates so the verifier does not check the same issue repeatedly.

Pre-clustering in this stage is a verifier scheduling optimization, not final deduplication. It may choose a representative candidate for identical or near-identical copies and preserve the losing candidates as lineage, but it must not perform semantic grouping, ranking, comment-cap enforcement, or final wording decisions. Those belong to final composition.

Every surviving candidate should be verified by an independent LLM verifier by default. Verification may be disabled only through explicit configuration for faster local experimentation, not as the default v1 behavior.

The verifier receives one candidate at a time, its originating packet context, the relevant changed hunk(s), cited evidence, active lens criteria, and the read-only semantic tool suite. The verifier should use tools only to prove, narrow, or reject the candidate. It must not search for new issues.

The verifier may inspect surrounding code, but only to validate the candidate's specific claim. It should not expand into a new review pass or introduce unrelated findings.

Verifier output should be structured:

```ts
type VerificationVerdict = {
  candidateId: string
  verdict: "keep" | "reject" | "revise"
  reason: string
  requiredEvidencePresent: boolean
  falsePositiveRisk: "low" | "medium" | "high"
  finalFinding?: CandidateFinding
  revisedAnchor?: DiffAnchor
  verificationIncomplete?: boolean
}
```

Verifier rules:

- `keep` only when the issue is real, tied to changed behavior, sufficiently evidenced, and not style-only.
- `reject` when evidence is missing, the issue is speculative, surrounding code mitigates it, it is outside the active lens scope, or it cannot be tied to changed behavior.
- `revise` when the issue is real but severity, confidence, wording, evidence, suggested fix, suggested test, or publication mode should be narrowed.
- Preserve candidate lineage when revising so telemetry can trace the final finding back to the original packet, lens, and candidate.
- Preserve the original validated anchor unless the verifier proposes a new anchor that also validates against a changed diff line.
- If a real issue cannot be anchored to a changed line, convert it to a summary-only finding rather than an inline comment.

Verification failure should be conservative:

- Authentication or provider-wide failures should fail the run or mark the review incomplete.
- Individual verifier schema/parse failures should get one repair attempt.
- Candidates that remain unverified after retry should be marked `verificationIncomplete` and suppressed from publication by default.
- The final report should disclose verification incompleteness when it affects review coverage or suppressed high-severity candidates.

Verification should run with bounded concurrency and record telemetry for every candidate: pre-gate decision, verifier prompt size, tool calls, token usage, runtime, verdict, revision details, rejection reason, and incomplete-verification reason.

The output of this stage is a set of verified, rejected, revised, or incomplete findings with traceable lineage. Stage 9 does not decide the final review shape.

## Repository Tools

Reviewer and verifier passes should receive tools for targeted repository exploration instead of raw full-repo context.

V1 tools should be read-only by default. They should feel like familiar read/list/search tools, but each tool should have a stable semantic contract independent of the backend used to answer it.

The repository tool layer should support pluggable backends:

- Tree-sitter backend: preferred when a grammar is available for the file language. It should provide symbols, enclosing blocks, imports, syntax-aware snippets, and structured source ranges.
- Text backend: required fallback for every repository. It should use git plumbing reads and `git grep` at the reviewed revisions, file listing, line windows, and simple filename/test conventions when tree-sitter is unavailable or parsing fails.
- Language analyzer backend: optional future enrichment for languages where deeper semantic analysis is available.

Callers should not need to know which backend answered a tool call. Tool results should include backend provenance such as `tree-sitter`, `text`, or `language-analyzer`, precision such as `exact`, `semantic`, `syntactic`, `heuristic`, or `text`, and degraded-result metadata when a semantic request falls back to an approximate implementation.

Minimum required v1 tools:

- `read_range(path, startLine, endLine, source?)`.
- `read_file_outline(path, source?)`.
- `read_symbol(path, symbolName | line, source?)`.
- `find_definition(symbolName, pathGlob?, source?)`.
- `read_diff_blocks(packetId | path)`.
- `search_files(query, pathGlob?, contextMode)`, where `contextMode` can return no context, line windows, or enclosing symbols.
- `find_symbol_mentions(symbolName, pathGlob?, source?)`.
- `find_likely_tests(path | symbol, source?)`.
- `list_files(glob)`.

Expected backend behavior:

- `read_range` uses file/git reads and does not require tree-sitter.
- `read_file_outline` uses tree-sitter when available to return package/module name, imports, top-level symbols, classes/types, functions/methods, and test markers; it falls back to extension/name heuristics and a compact text outline.
- `read_symbol` uses tree-sitter when available; given a line selector it returns the enclosing symbol; falls back to exact-name text search plus bounded line windows.
- `find_definition` uses `git grep` to find candidate files at the reviewed revision, then tree-sitter parsing to return only definition sites; it falls back to text matches marked degraded when parsing is unavailable. Import questions are answered by `read_file_outline`, which includes the file's imports.
- `read_diff_blocks` uses parsed diff data and does not require tree-sitter.
- `search_files` uses `git grep` at the reviewed revision for discovery, then may enrich matches with tree-sitter enclosing symbols when `contextMode` asks for semantic context.
- `find_symbol_mentions` uses syntax-aware identifier matching when available and `git grep` at the reviewed revision otherwise. It does not claim compiler-grade reference resolution unless a language analyzer backend explicitly marks the result as semantic or exact.
- `find_likely_tests` combines test filename conventions with symbol extraction when available and filename/path heuristics otherwise.
- `list_files` uses filesystem/git listing and does not require tree-sitter.

Source-reading tools should read from the resolved head revision through git by default, and support base-revision reads when the review target has a base revision. The checked-out worktree must not be trusted as review content. Base reads are required for reviewing deleted files and removed-line context when local git can provide the content.

Tool outputs must be capped by count and characters. They should include file paths, line numbers, backend provenance, and degradation notes. They should prefer semantic source blocks over whole files, and record truncation or omitted-result counts in telemetry.

Tree-sitter should be the default cross-language syntax layer. It should enrich packets, changed-symbol extraction, and static signals where language grammars are available.

Language-specific analyzers may enrich the common tool interface later, but v1 should remain useful with tree-sitter-backed support.

Tree-sitter-backed tools provide syntax-aware evidence, not full semantic truth. Reviewers and verifiers may use `find_symbol_mentions` to discover likely call sites or affected code, but publishable findings still need changed-code evidence and surrounding-code confirmation.

## Telemetry And Debug Traces

codegenie needs first-class local telemetry so review quality, cost, latency, and failure modes can be analyzed during development and evaluation.

Telemetry should be local by default. codegenie must not send source code, prompts, findings, or usage data to an external telemetry service unless the user explicitly configures such behavior in the future.

codegenie should also have structured application logging. Logs are not a replacement for typed telemetry artifacts, but they should provide a readable chronological trace that humans or later LLM analysis can inspect.

The logger should support `debug`, `info`, `warn`, and `error` levels, ISO timestamps, and structured metadata. Every log event emitted by the review pipeline must include:

- `runId`.
- `stage`, using the numeric stage from this spec, such as `1` for diff parsing or `7` for lens review execution.
- `event`, a stable event name.
- `message`, a concise human-readable summary.
- Relevant ids when available, such as `workerId`, `packetId`, `hunkId`, `path`, `candidateId`, `findingId`, `toolName`, or `lensId`.

Normal stdout should stay focused on the final report or concise run summary. Debug/info logs should be written to local run files when enabled; warnings and errors may also be shown on stderr when useful.

V1 telemetry should capture:

- Total runtime.
- Runtime per stage.
- Runtime per worker or sub-agent.
- Number of LLM provider calls.
- Token usage per LLM call when available.
- Aggregate prompt, completion, and total token usage.
- Model/provider used per call.
- Review packets generated.
- Lenses selected and skipped, including why.
- Coverage decisions for each hunk or file.
- Reviewed, skipped, and partially reviewed hunk counts.
- Every repository tool call, always on rather than debug-gated: tool name, normalized arguments (path, symbol, line range, query, glob, source revision), initiator (model-issued inside an LLM tool loop, or harness-issued by a deterministic stage), duration, status, result size and count, and the worker, packet, task, candidate, and model call that issued it.
- Tool backend provenance, precision, and degradation/truncation reasons for every tool call.
- Worker lifecycle events: scheduled, started, completed, failed, cancelled, retried, or timed out.
- Candidate findings produced.
- Verification verdicts.
- Findings rejected and rejection reasons.
- Deduplication/grouping decisions.
- GitHub posting attempts and results.
- Final-selection decisions and reasons for omitted verified findings.
- Local cache hits/misses when caching is enabled.

Debug traces should make the review process inspectable. When enabled, codegenie should record step-by-step events describing:

- Current stage.
- File, hunk, symbol, or candidate finding being processed.
- Lens or skill being applied.
- Relevant line ranges.
- Tool calls made.
- What the reviewer found or rejected.
- Why a candidate finding was kept, revised, or suppressed.

Debug traces may include source snippets, prompts, and model outputs, so they should be opt-in and written to local files rather than mixed into normal stdout output.

Telemetry artifacts should support the eval workflow. An evaluator should be able to run codegenie against a real remote repository or branch, define expected findings externally, and inspect telemetry to understand whether misses came from packet construction, lens selection, tool behavior, model output, verification, deduplication, or final composition.

Suggested local artifacts include:

- `run.log` for structured application logs.
- `events.jsonl` for structured stage events.
- `model-calls.jsonl` and `model-calls-summary.json`.
- `tool-calls.jsonl` (one structured record per tool call) and `tool-calls-summary.json` (per-tool and per-stage aggregates: counts, error/degradation rates, durations, result sizes).
- `review-plan.json`.
- `packets/<packet-id>.json` (one file per packet).
- `candidate-findings.json`.
- `verification.json`.
- `final-selection.json`.
- `final-findings.json`.
- `cost-profile.json`.
- Debug prompt and model-result files when explicitly enabled.

## Eval System

codegenie should include an eval command for end-to-end quality testing against real repositories, fixture repositories, and previously captured artifacts.

The v1 eval command should support:

```bash
codegenie eval --eval-dir /path/to/evals
codegenie eval --eval-dir /path/to/evals --cache
codegenie eval --eval-dir /path/to/evals --no-cache
codegenie eval --from-artifacts /path/to/eval/logs/42
```

`--from-artifacts` re-scores a previously captured run directory against the case expectations without re-running the review; it is the only artifact-replay mode in v1.

Eval cases should be YAML files stored outside the codegenie repository when they reference private or real customer-like repositories. A case may point at:

- An external local repository path.
- A fixture repository.
- A branch, commit, commit range, or PR target.
- Review settings such as depth, lenses, max findings, concurrency, cache on/off, verification on/off, provider/model/reasoning overrides, and telemetry/debug options.
- Expected final findings.
- Expected candidate findings.
- Findings that must not appear.
- Cost, runtime, model-call, prompt-size, and tool-call budgets.

The eval runner should write incrementing run directories under the eval suite, such as `logs/1`, `logs/2`, and so on. Each run directory should include the rendered review output, structured application log, run info, telemetry artifacts, debug prompts/results when enabled, and comparison artifacts against the previous run when available.

Eval scoring should not only report pass/fail. It should attribute every lost expected finding to one of four coarse loss labels:

- Missed before candidate generation.
- Lost at verification (pre-gate or verifier).
- Lost at composition (deduped, merged, or capped).
- Partial match (right file, wrong root cause).

When an expected finding appears only as a follow-up hint, the scorer records the hint's presence as supporting detail on the loss label rather than as a separate label.

This eval system should reuse normal review artifacts rather than running a separate review engine. It should be suitable for private eval suites like real-repo regression cases, and for public fixture-based evals that can run in CI.

## Local Review Cache

The local review cache is a model-call cache. When enabled, LLM responses are cached locally, keyed by model, provider, and the normalized request: prompt content, tool definitions, and structured-output schema. Re-running an identical review, most commonly during development and eval iteration, replays identical calls from cache instead of spending provider tokens.

The normalized request is the cache contract. The architecture enumerates the inputs that must flow into it (stage id, prompt template version, reasoning settings, skill content hashes, conversation prefix including tool results, tool budget, repository identity, review target revisions, and cache schema version) so that identical requests hit and anything prompt-affecting misses.

The cache stores model interactions only. Deterministic stages are cheap to recompute and are not cached in v1. Cache hits and misses must be recorded in telemetry, and `codegenie eval --cache` / `--no-cache` toggle this cache per eval run.

The cache is disabled by default and must be explicitly enabled in configuration or per run.

## Skills And Lenses

V1 skills and user-provided extensions should be Markdown files only.

A skill defines review guidance, concrete checks, examples, false-positive rules, safe patterns, and output constraints. Skills should not be mostly persona text.

A lens is the user-facing review perspective. A lens may map to one or more skills.

Bundled v1 lenses should include:

- Core code review, which absorbs logic/correctness and architecture/design guidance as sections of one strong core skill.
- Tests.
- Go.
- TypeScript/JavaScript.

Logic-bugs and architecture exist as sections of the `core` skill, not separate lenses, because v1 runs one composite review task per packet; separate lenses would not change what runs.

`core/code-review` explicitly includes security-correctness checks — injection, authorization gaps, secret handling, unsafe deserialization — in v1; dedicated security/domain lenses remain post-v1.

Additional language and domain lenses, such as security, database, performance, and concurrency, may be added as bundled skills after v1.

Style, formatting, naming, and lint-like lenses are disabled by default.

## Candidate Findings

Reviewer passes must produce structured candidate findings, not free-form comments.

Each candidate finding must include:

- Title.
- Severity: critical, high, medium, or low.
- Confidence: high, medium, or low.
- Category.
- File path.
- GitHub/diff anchor metadata when available.
- Diff side: `RIGHT` for new/head lines or `LEFT` for removed/base lines.
- Whether the anchor is on a changed line.
- Evidence from changed code.
- Related code evidence when used.
- Concrete failure mode.
- Why the issue matters.
- Suggested fix when useful.
- Suggested test when useful.
- Verification notes.

Rules:

- No evidence means no finding.
- No concrete failure mode means no finding.
- Low-confidence findings are suppressed by default.
- Medium-confidence findings may appear in stdout and GitHub comments.
- Style-only findings are suppressed unless explicitly enabled.
- Findings without a valid changed-line anchor or valid deleted-line old-side anchor must not be posted as inline GitHub comments.

## Stage 10: Final Deduplication, Ranking, And Composition

Stage 10 takes verified findings and turns them into the final review. This is the first stage that performs semantic deduplication, same-root-cause grouping, final ranking, comment-cap handling, and final wording.

Stage 10 should:

- Deduplicate related findings.
- Group same-root-cause issues.
- Prefer the clearest changed-line anchor when multiple verified findings describe the same issue.
- Rank findings by severity, confidence, impact, evidence strength, and actionability.
- Apply the soft comment cap without hiding verified critical or high-severity findings only to satisfy the default limit.
- Rewrite comments into concise, staff-engineer-quality Markdown.
- Decide whether each final finding should be inline, summary-only, or suppressed from publication.
- Preserve lineage back to verified candidates, packets, lenses, and source evidence.

The final composer should prefer no comments over weak comments. The default target is roughly 3-7 high-signal comments per PR, but this is a soft cap: verified critical and high-severity findings should not be hidden only to satisfy the default limit.

The composer should produce a final review object containing:

- Review summary.
- Coverage summary, including partial-review disclosure when applicable.
- Final findings grouped by severity.
- File and line references.
- Evidence and failure mode for each finding.
- Suggested fix or suggested test when useful.
- Summary-only findings that cannot be anchored inline.
- "Needs human attention" notes for unresolved medium- and high-confidence follow-up hints (see Stage 8).
- A clear "no findings" result when no credible findings are found.
- Posting plan for GitHub mode.

### Stdout Output

When `--post-github-comments` is not used, codegenie should print the final review as clean, structured Markdown to stdout.

The Markdown report should include:

- Review summary.
- Coverage summary, including partial-review disclosure when applicable.
- Findings grouped by severity.
- File and line references.
- Evidence and failure mode for each finding.
- Suggested fix or suggested test when useful.
- "Needs human attention" notes for unresolved medium- and high-confidence follow-up hints.
- A clear "no findings" result when no credible findings are found.

When `--format json` is used, codegenie should print the final review object as JSON to stdout instead of the Markdown report. The JSON output should carry the same content as the Markdown report: summary, coverage, final findings with anchors, evidence, failure modes, suggested fixes and tests, summary-only findings, and needs-human-attention notes. Suppressed findings are not part of the report in either format; they are recorded only in run artifacts.

When `--post-github-comments` is used, stdout should not print the full report by default. It should print a concise run summary with counts, posting status, and any fatal or skipped-posting errors. When combined with `--format json`, that run summary should be emitted as JSON; its shape is the publisher's posting record (`components/repository_and_github.md` owns it).

## Stage 11: GitHub Publishing

Stage 11 is optional and runs only when GitHub posting is requested.

GitHub posting is opt-in with:

```bash
codegenie review --pr 123 --post-github-comments
```

GitHub posting cannot be enabled from configuration in v1; it requires the explicit `--post-github-comments` flag on each run.

When enabled, codegenie should:

- Post inline comments and the summary as a single GitHub review with event type `COMMENT`. codegenie must not approve or request changes in v1.
- Post inline comments for verified findings with valid changed-line anchors.
- Use `RIGHT` anchors for new/head-side lines and `LEFT` anchors for removed/base-side lines when GitHub accepts old-side review comments.
- Avoid posting low-confidence findings.
- Include medium-confidence and high-confidence findings.
- Include a short PR review body with the total finding count and any broad findings that cannot be anchored inline.
- Disclose partial coverage in the PR-level summary when the review did not cover the full change set.
- Avoid duplicate comments from previous codegenie runs when possible.

Duplicate avoidance should use a stable fingerprint derived from durable finding identity (path, enclosing symbol or hunk identity, category, and lens), excluding model-authored wording. On rerun, codegenie should skip or update prior codegenie-authored comments when it can identify them safely.

If a deleted-line or other inline anchor fails validation or GitHub rejects it, codegenie should move that finding to the PR review body rather than dropping it silently. This is especially important for deleted files, because valuable findings may be about removed behavior even when an inline anchor is unavailable.

Posting requires the `gh` auth identity to have pull-request write access only; a fine-grained token or machine account is recommended for shared or CI use.

V1 GitHub publishing should use `gh` and should be supported only for `--pr` mode. Branch, commit, and commit-range modes should not post GitHub comments in v1 unless a future option explicitly supplies PR posting context.

## Configuration

The repository config file should be named:

```text
codegenie.toml
```

This section covers the resolved configuration surface. Repo `codegenie.toml` may set only the safe subset described under Trust Boundaries; provider credentials, default provider/model, and reasoning effort come from CLI flags, environment variables, or user-scoped provider state.

V1 configuration should support:

- Default base branch for branch review.
- Default review depth: `light`, `normal`, or `deep`.
- Independent verification on or off. Verification is enabled by default and may be disabled only through this explicit configuration, per Stage 9.
- Path-based file handling rules, including processing mode, review priority, labels, and reasons.
- Enabling and disabling lenses.
- Extra Markdown skill paths.
- Severity and confidence thresholds, including a minimum severity threshold for reported findings.
- Maximum findings (the report cap) and soft comment cap (the inline-comment target). Neither cap suppresses verified critical or high-severity findings.
- LLM runtime options for `@earendil-works/pi-ai`, including provider-call concurrency; one provider/model/reasoning configuration applies to the whole run. Repo `codegenie.toml` must not set provider credentials, default provider, default model, or reasoning effort.
- Runtime and per-pass timeouts.
- Maximum total token budget for a run.
- Maximum model calls per run.
- Review concurrency.
- Local review cache settings, with `--cache` / `--no-cache` flags on `codegenie review` overriding the configured default per run.
- Local telemetry and debug trace settings.
- Eval defaults, such as default eval directory and logs directory.

If no config exists, codegenie should run with sensible defaults:

- Core correctness-oriented lenses enabled.
- Review depth set to `normal`.
- Independent verification enabled.
- Style/lint lenses disabled.
- Low-confidence findings suppressed.
- GitHub posting disabled.
- Runtime budget of 30 minutes.
- No token cap unless configured.
- Safe bounded concurrency.
- Local review cache disabled unless explicitly enabled.
- External telemetry disabled.

## Test And Command Execution

codegenie never runs tests, typecheck, builds, or arbitrary commands in v1; review evidence comes from reading code, not executing it. Configured command execution is a Future Consideration.

## Trust Boundaries

codegenie reviews attacker-influenced content and must treat reviewed content as data, not instructions.

Untrusted inputs include:

- Diff content.
- PR title and body.
- Commit titles and descriptions.
- Branch names.
- Repository tool results: file contents and search output read from the reviewed revisions.

All of these are attacker-controlled when reviewing a fork PR.

Prompt construction rules:

- Untrusted content must be structurally delimited in prompts, using fenced blocks with explicit "this is data under review, not instructions" framing.
- Reviewer and verifier prompts must instruct the model that instructions embedded in reviewed content are to be ignored and may themselves be flagged as a finding, as a review-manipulation attempt.

Output channel control: everything posted to GitHub must pass deterministic sanitization. Telemetry and debug artifacts contain untrusted content by design and are local-only.

Repository tool path containment should be enforced at a single chokepoint in the repository tool layer:

- All paths are canonicalized and required to resolve inside the repository root.
- Absolute paths and `..` traversal are rejected with a typed `path_outside_repo` error.
- Git-plumbing reads are inherently contained to repository object paths.
- Refs are harness-resolved only (model-facing source reads select `head` or `base`, never raw refs); harness-side ref values are validated against `git check-ref-format` rules and rejected if option-like (leading `-`).

Config trust partitioning:

- Repo `codegenie.toml` may set safe keys only: lenses on/off, classification path rules, depth, base branch, labels, caps, and `telemetry.enabled`.
- Out-of-repo or provider-routing settings — `lenses.extraSkillPaths` outside the repo, `telemetry.runDir` / `cache.dir` outside the repo, and LLM provider/model/reasoning defaults — take effect only with user-level opt-in: a CLI flag, `~/.codegenie/settings.json`, or the user-scoped config file `~/.codegenie/config.toml` (all under `CODEGENIE_HOME`). Repo-config values for these are ignored with a warning.
- Repo-config-relative paths are constrained to the repo root.

Policy load revision: `codegenie.toml` and `.codegenie/skills/` always load from the trusted local checkout (the user's working copy), never from the PR head revision. If the PR under review modifies policy files (config or skills), that should be surfaced to the planner as a risk signal and noted in the report.

Subprocess hygiene for git, GitHub, and tool subprocess invocations:

- Never invoke through a shell.
- Always pass `--` before untrusted positional path or ref arguments.
- Reject argument values matching `^-`.
- Prefer SHAs over ref names when both are available; GitHub-supplied ref names are display-only.

Credentials: provider API keys and OAuth/device-flow tokens come from environment variables or user-scoped provider auth state only (`~/.codegenie/auth.json`, overridable through `CODEGENIE_HOME`), and repo `codegenie.toml` must reject credential-bearing fields at parse time. Auth material such as API keys, `gh` tokens, Authorization headers, OAuth tokens, and device-flow tokens must be stripped before anything is written to logs, telemetry, run artifacts, cache entries, debug traces, or error context.

## Error Handling

codegenie should fail clearly for:

- Not running inside a git worktree.
- Invalid or missing input mode.
- Missing `gh` CLI for GitHub PR mode.
- `gh` authentication or permission failures.
- PR not found.
- PR head or base commits that cannot be resolved or fetched locally.
- Diff parsing failures.
- Unsupported or unavailable parser for a file language when no graceful fallback is possible.
- Config parse errors.
- No authenticated provider model available for the run, with a `codegenie provider login <provider>` hint.

Parser or language-support failures for individual files should degrade gracefully when possible. codegenie may still review with raw diff context and basic file tools, but it should report degraded context in the run summary.

## Exit Codes

V1 should not fail the process merely because review findings were found.

Exit behavior:

- Exit `0` when review completes successfully, including when findings are present.
- Exit nonzero for runtime, configuration, authentication, parsing, or posting failures that prevent the requested operation from completing.
- Disclosed partial reviews and reviews with `verificationIncomplete` suppressions are successful completions and exit `0`. The disclosure lives in the report and artifacts (`completed_partial`), not the exit code.

CI failure thresholds such as `--fail-on high` are out of scope for v1 unless explicitly added later.

## Future Considerations

These designs are deliberately deferred from v1. They are recorded as target shapes to build only when telemetry or evals show the simple v1 behavior falling short — never speculatively.

- Hierarchical planning. Compact group summaries, per-group sub-planners, and a meta-planner that merges group plans into one prioritized review plan. V1 uses a single planner call with deterministic dossier compaction and, when necessary, deterministic chunked planning with mechanical concatenation. Build when chunked planning measurably degrades plan quality on large reviews.
- Cross-packet review-signal index. Normalizing planner tasks, packet hints, candidate findings, and uncertainties into typed `ReviewSignal` records indexed by symbol, file, category, and configured labels, with graded promotion rules. This is the richer follow-on shape for the narrow Stage 8 repeated-hint rule. Build when the simple promotion rule misses real cross-file findings or produces noisy/duplicate system tasks.
- Broad cross-file/system review. The shipped Stage 8 only promotes repeated scoped packet hints into a few focused tasks. The broader target shape remains deferred: the planner may emit `systemFollowUpTasks`; packet hints, candidate findings, and uncertainties may be promoted through a typed signal index; each task carries a stable topic, sources, related packet ids, bounded file/symbol sets, lenses, priority, and a tool budget; system workers may inspect wider subsystem relationships under explicit constraints. Build when telemetry shows recurring medium/high-confidence hints left unresolved, or evals attribute missed findings to the narrow repeated-hint rule.
- Planner scheduling groups. Planner-emitted hunk groups carrying parallelism and ordering intent. V1 packets are independent by construction and scheduling is priority-only; groups become meaningful only if cross-packet context sharing or dependent review ordering is introduced.
- Changed-symbol graph edges. Caller, implements, imports, and test relationships between changed symbols (`SymbolEdge`, `ChangedSymbolGraph`). V1 ships `HunkSymbolFacts` and file outlines only; reviewers answer relationship questions on demand with `find_symbol_mentions` and `find_likely_tests`. Build when evals show reviewer or verifier misses attributable to missing precomputed relationship data.
- Language analyzer backends. Optional semantic enrichment (gopls, TypeScript compiler API, Rust Analyzer) behind the same repository tool contract, already anticipated by the tool layer's backend and precision metadata.
- Diff-file review mode (`--diff <path>`). Reviewing a loose unified diff file with the worktree treated as head for source reads, per-hunk staleness validation of context lines against the worktree, and degraded-coverage disclosure for non-matching files. Build when a real consumer needs loose-patch review that `git apply` to a branch cannot serve.
- Spec/doc discovery and spec alignment. Deterministic discovery of repo-resident specs through configured `specs.paths` globs (path proximity to changed package roots, then filename/title keyword overlap; top 5 docs as capped snippets), plus `relevantSpecs` and `specAlignmentQuestions` on the planner's diff understanding, with spec-alignment findings citing both the spec evidence and the changed-code behavior. V1 compares declared intent against inferred behavior only. Build when evals show intent-only alignment missing real spec violations.
- Human-thread awareness. Fetching existing PR review comments and threads, passing deterministically extracted and truncated summaries to the planner as hints (never findings), and composer acknowledgment of overlap with existing threads — without dropping verified findings or adopting an existing comment without codegenie's own evidence and verification. V1 lists only codegenie's own prior comments, for rerun duplicate avoidance. Build when codegenie is observed re-raising points humans already made on the thread.
- Configured command execution. Opt-in `tools.testCommands` for test/typecheck/build commands run with timeouts, results treated as evidence rather than automatic findings, enabled only through user-level trust. V1 never executes repository commands. Build when evals show findings that only execution evidence could confirm or reject.
- Per-role model/reasoning tiering. Optional per-role model and reasoning overrides (planner, packet reviewer, verifier, composer) supplied from user-level config or CLI. V1 runs one provider/model/reasoning configuration for the whole run. Build when evals identify roles where cheaper models or lower reasoning hold review quality.
- Rich pre-attached packet context. Sibling symbol names, AST summaries, nearby imports, and small examples of nearby established patterns assembled into packets at construction time. V1 packets carry enclosing-symbol source, a file outline, and likely tests; reviewers fetch the rest on demand with read-only tools. Build when tool-call telemetry shows reviewers repeatedly refetching the same local context.
- Per-language static-signal packs. Language-specific deterministic signal rules — ignored errors, concurrency primitives, migration files, resource cleanup, lifecycle-sensitive code — beyond the two v1 cross-language rules. Build when evals show planner risk-targeting misses attributable to absent signals.
- Cost-based run budgets. A maximum-cost budget alongside tokens and model calls; in v1, unknown-cost calls counting zero made it a loophole, and the token budget covers the need. Build when Pi-reported pricing is reliable.
- Fine-grained eval attribution. The five-label loss taxonomy (candidate-only loss, verifier rejection, dedup/merge loss, selection-cap loss, and hint-only presence as first-class labels), verifier and deduplication/merge expectations in eval cases, and additional replay modes such as candidate-recall and merge-only replay. V1 scores four coarse loss labels and supports `--from-artifacts` re-scoring only. Build when coarse labels are insufficient to localize a regression.

## Out Of Scope For V1

- GitLab support.
- Reviewing uncommitted working-tree changes.
- Approving or requesting changes through GitHub reviews.
- Auto-fixing or editing code.
- Executable TypeScript skill packages from users.
- Full-repository prompt dumping.
- Running every lens on every hunk.
- Style, naming, formatting, or lint review by default.
- CI failure thresholds based on finding severity.
