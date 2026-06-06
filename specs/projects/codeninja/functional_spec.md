---
status: draft
---

# Functional Spec: codeninja

## Purpose

codeninja is a TypeScript CLI for high-signal AI code review of pull-request-style changes. It reviews diffs in a local git repository, uses focused repository exploration tools instead of dumping the whole repo into context, and produces staff-engineer-quality findings with concrete evidence, impact, and actionable fixes.

The default review stance is correctness-first. codeninja should find real bugs, logical errors, security issues, architectural risks, performance problems, missing tests, and maintainability concerns that matter. It should suppress style-only, naming, formatting, and subjective comments unless the user explicitly enables a lint/style lens.

## Users

Primary users are developers and engineering teams who want an expert code-review assistant for local branches and GitHub pull requests.

Secondary users are maintainers who want to define project-specific review lenses and Markdown skills that teach codeninja how to review their codebase, language, or domain more precisely.

## V1 Input Modes

codeninja should expose a primary command:

```bash
codeninja review
```

The command supports three primary review targets:

```bash
codeninja review --pr 123
codeninja review --branch feature-branch [--base main]
codeninja review <commit> [end-commit]
```

The command also supports a utility diff-file mode for evals, CI artifacts, downloaded patches, and test fixtures:

```bash
codeninja review --diff /path/review.diff
```

Common review options:

```bash
codeninja review --depth light|normal|deep
```

`--depth` controls the global review budget and planner bias. The default is `normal`. `light` should favor cheaper packet review and smaller tool budgets. `deep` should allow more `deep` packet coverage, larger tool budgets, and more system follow-up work. Per-hunk coverage may still vary inside the selected depth when the planner sees concrete risk evidence.

All v1 modes require running from inside a local git worktree. This means the repository must exist locally so codeninja can inspect files, map diff paths to source files, build context, and run read-only repository tools. The `--pr` mode uses GitHub metadata for PR context and posting, but the reviewed diff, changed files, and commit information should come from local git whenever possible.

### `--pr`

`--pr <number>` reviews a GitHub pull request for the current repository.

Behavior:

- Use the `gh` CLI as the GitHub integration layer for PR metadata, authentication, and comment posting.
- Fetch PR title, body, base/head refs or SHAs, and posting metadata through `gh`.
- Compute changed files, commit metadata, commit messages/descriptions, and unified diff from local git whenever possible.
- Include commit titles and commit descriptions across the reviewed range as planner input.
- Use the local worktree for source inspection, diff mapping, and repository tooling.
- Support posting inline GitHub comments only when `--post-github-comments` is passed.
- Do not support GitLab in v1.

### `--branch` / `--base`

`--branch <branch-name> [--base <base-branch>]` reviews the head of a branch against a base branch.

Behavior:

- Compute the effective diff between the base branch and branch head.
- Resolve the base branch in this order:
  - `--base <base-branch>` when passed on the CLI.
  - The configured default base branch in `codeninja.toml`.
  - A local or remote `master` branch, if it exists.
  - A local or remote `main` branch, if it exists.
- If no base branch can be resolved, fail with a clear error asking the user to pass `--base` or configure the default base branch.
- Collect commit titles and commit descriptions across the reviewed range as planner input.
- Prefer merge-base semantics for branch review so the reviewed diff matches pull-request-style changes.
- Do not attempt to post GitHub comments in v1 from branch-review mode.

### Commit Or Commit Range

`codeninja review <commit> [end-commit]` reviews one commit or a commit range.

Behavior:

- With one commit, review the changes introduced by that commit.
- With two commits, review the range from the first commit to the second commit.
- Collect commit titles and commit descriptions across the reviewed commit or range as planner input.
- Do not attempt to post GitHub comments in v1 from commit or commit-range mode.

### `--diff`

`--diff <file-path>` reviews an existing unified diff file. This mode is useful for reviewing a patch produced by another tool, an evaluation fixture, a CI artifact, or a downloaded `.diff` file while still allowing codeninja to inspect the local repository.

Behavior:

- Read the diff from disk.
- Use the local worktree for source inspection when diff paths match files in the repo.
- Treat PR metadata and commit descriptions as unavailable unless separately provided by future options.
- Do not post GitHub comments in v1 from diff-file mode.

## Review Pipeline

codeninja should use a staged review pipeline:

1. Parse the diff and changed file list.
2. Filter ignored, generated, vendored, binary, and lock files.
3. Classify files into simple processing facts: language, processing mode, package root, test/generated/vendor/lock/binary status, configured labels, and configured priority.
4. Build syntax-aware changed-symbol information where supported.
5. Run a PR scout/planning pass.
6. Build compact review packets per hunk or file.
7. Run selected lenses on relevant packets, with bounded parallelism where packets can be reviewed independently.
8. Run cross-file/system follow-up review where the planner or packet reviewers identify systemic risk.
9. Verify candidate findings, with only minimal duplicate suppression needed to avoid repeated verifier calls.
10. Deduplicate, rank, and compose final output.
11. Optionally post verified inline comments and a PR summary through GitHub.

The unit of candidate review is the changed hunk or file. The unit of understanding is the affected system.

The planner should choose review order and lenses based on language, changed symbols, touched subsystems, tests touched or missing, configured labels/priorities, and the actual diff content. It should not run every lens on every hunk by default.

The v1 pipeline should remain useful even when syntax intelligence is incomplete. Basic diff parsing, file filtering, file classification, seed context, selected lenses, structured findings, verification, deduplication, and telemetry are required. Tree-sitter changed-symbol extraction for Go and TypeScript/JavaScript should improve packet quality, but parser gaps should degrade gracefully rather than block review.

## Stage 1: Diff Parsing And Change Inventory

Stage 1 resolves the requested review target into a deterministic local change inventory.

Inputs can come from `--pr`, `--branch`, commit/range mode, or `--diff`, but the output should be normalized into the same internal shape: changed files, hunks, absolute old/new line mappings, file statuses, and commit or PR metadata when available.

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

Deleted files and deletion-only hunks are part of the review inventory. codeninja should not silently drop them merely because the file no longer exists in the head worktree. Stage 1 should retain their old-side line numbers and old path so later stages can review removed behavior, removed tests, removed exports, removed cleanup, and broken references caused by deletion.

## Stage 2: Filtering Ignored And Non-Reviewable Files

Stage 2 removes files that should not enter the review pipeline and records why they were filtered.

Filtering should be deterministic and explainable. It should apply built-in generated/vendor/binary/lockfile detection, repository ignore rules where appropriate, and explicit `codeninja.toml` skip rules.

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

Deleted reviewable source, test, config, migration, or documentation files should remain in scope by default. If deleted-file context cannot be reconstructed from local git or the diff, codeninja should mark the file as degraded or partially reviewed rather than pretending it was reviewed normally.

## Stage 3: File Classification

File classification should be deterministic, narrow, and auditable by default. It should not require an LLM. The classifier produces processing facts for the planner; it does not produce findings and should not try to infer business risk from a built-in keyword taxonomy.

Each changed file should receive a processing mode:

- `per-hunk`: default for ordinary reviewable source files.
- `whole-file`: for files that are better reviewed as a unit, such as small added files or files explicitly configured this way.
- `skip`: for generated, vendored, binary, lock, ignored, or explicitly skipped files.

Each changed file should also receive reliable facts when available:

- Language, primarily from extension and known filenames.
- Package root when a nearby package marker is found.
- Test status from established test filename/path conventions.
- Generated-file status from generated markers and generated-file detectors.
- Vendor/dependency status from well-known dependency directories.
- Lockfile status from known lockfile names.
- Binary status from git or diff metadata.
- Changed-line and hunk counts.
- Configured labels and review priority from `codeninja.toml`.
- Reasons and provenance for every processing-mode decision and configured label.

The core classifier should not ship with hardcoded domain/risk keyword lists such as payments, auth, routes, or database. Those concerns belong in the planner's model reasoning, language/static signals, bundled or repo-owned skills, and explicit project configuration.

`codeninja.toml` should allow teams to define path-based handling rules. For example, a team can mark `lib/payments/**` as `critical`, attach labels such as `payments` and `critical-path`, force whole-file or per-hunk review, or skip generated folders. Configured rules should be recorded in telemetry and used by the planner, but the labels are user-provided facts rather than codeninja-inferred risk truth.

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

The scout/planning pass is the first LLM reasoning stage, but it is not a review pass and must not produce publishable findings.

V1 planner input should be a compact deterministic dossier: PR metadata, commit messages, changed file inventory, file processing facts, configured review depth, configured labels/priorities, hunk ranges, `HunkSymbolFacts`, changed symbol summaries, touched tests, static signals, and available lenses.

The v1 planner should not receive repository exploration tools by default. If it cannot decide from the dossier, it should mark uncertainty and schedule deeper hunk/file review or a system follow-up task rather than opening files itself.

Planner output should include review intent, risk areas, review order, per-hunk coverage decisions, selected lenses, system follow-up tasks, missing-test suspicions, and partial-review disclosure when needed.

The planner must not skip a reviewable changed hunk without a reason.

The planner owns coverage and lens decisions. It should decide `light`, `normal`, `deep`, or `skip` for each changed hunk, and select the lenses that should review that hunk or related system task. Later stages may validate or fall back from invalid planner output, but they should not become independent risk classifiers.

Configured review depth should influence budgets and defaults, not replace judgment. A `light` run may still review a concrete critical-risk hunk at `normal`; a `deep` run may still skip generated files or keep mechanical hunks at `light`.

## Large Review Handling

codeninja must handle large PRs and large commit ranges without trying to fit the entire diff into one model context.

For large reviews, codeninja should use hierarchical planning:

1. Build a complete deterministic inventory of changed files, hunks, languages, file processing facts, tests, generated files, configured labels/priorities, and any available changed symbols or static signals.
2. Group changes by subsystem, package, language, file type, configured labels, and planner-inferred risk areas.
3. Produce compact group summaries.
4. Run sub-planners for groups when the full inventory exceeds the planner budget.
5. Run a meta-planner that merges group plans into one prioritized review plan.

Every changed hunk should receive an explicit coverage decision:

- `deep` for changes with strong risk evidence, such as configured critical paths, exported API/interface changes, migrations, lifecycle/concurrency-sensitive code identified by symbols or skills, or planner-inferred risks backed by concrete diff evidence.
- `normal` for ordinary application logic.
- `light` for low-risk or mostly mechanical changes.
- `skip` for generated, vendored, or irrelevant changes, with a reason.

If codeninja cannot review the full change set within the configured time or token budget, it should produce a partial-review result rather than pretending the review is complete. The stdout report and GitHub summary, when posted, must disclose reviewed hunk counts, skipped hunk counts, coverage levels, and the reason for partial coverage.

## Parallel Review Execution

codeninja should parallelize review work when doing so does not reduce review quality.

V1 should support bounded concurrency for independent hunk/file review packets. The planner should produce packet groups that can be reviewed in parallel, while preserving ordered review intent for dependent or high-risk areas.

Parallel execution rules:

- Hunk/file candidate-generation passes may run concurrently.
- The scout/planning pass must run before parallel packet review.
- Cross-file/system follow-up review should run after packet review has produced initial signals, unless the planner explicitly schedules a focused follow-up earlier.
- Verification may run concurrently per candidate finding.
- Deduplication and final composition must run after verification.
- Concurrency must be configurable and have a safe default.

The system should track which sub-agent or worker reviewed each packet so findings can be traced back to the exact stage, lens, packet, and source evidence that produced them.

## Stage 6: Review Packet Construction

For each relevant hunk or file, codeninja should construct a deterministic review packet before invoking reviewer lenses.

A `ReviewPacket` is the unit of model review. Every packet contains one or more changed hunks. The packet kind explains why those hunks are reviewed together, such as a single hunk, nearby coalesced hunks, a small file diff, or a whole-file review.

Review packet construction is deterministic in v1. It must not call the LLM and should not perform broad repository searches. It assembles planned hunk/file work orders from the diff, file facts, `HunkSymbolFacts`, compact local context, configured labels, planner notes, selected lenses, and tool budgets.

Default packet construction should be hunk-first. Coalesce only nearby hunks in the same file or same enclosing symbol. Use file/whole-file packets for single-hunk files, small added files, small configured files, or explicit `processingMode = "whole-file"` rules.

The packet builder validates and assembles planner decisions; it does not make primary coverage decisions. If a reviewable hunk has no valid planner coverage, the packet builder should fall back to `normal` with a recorded reason. If the planner skips a reviewable hunk without a valid reason, the packet builder should also fall back to `normal`.

Packet grouping should stay conservative in v1:

- Default to one packet per hunk.
- Coalesce only within the same file.
- Prefer coalescing hunks with the same enclosing symbol.
- Allow very nearby same-file hunks to coalesce when the combined packet stays below strict size limits.
- Do not create cross-file review packets in v1.
- Route cross-file concerns to the system follow-up stage instead.
- Split packets back into smaller packets when patch or context size limits would be exceeded.

Each packet should include:

- PR or diff summary.
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
- Nearby context, syntax-aware when available.
- Imports or dependencies visible from the changed file.
- Related tests when discoverable.
- Related file hints from the planner.
- Configured labels and planner risk notes.

Review packets should be compact. They should not contain the whole repository or large unrelated file dumps.

Deleted files and deletion-only hunks should produce review packets when they are reviewable. These packets should clearly mark that the changed content is old-side/deleted content, include removed-line numbers, and include base-revision context when available. Reviewers should focus on risks caused by removal: removed required behavior, removed tests, removed security checks, removed cleanup, removed exports, broken callers, stale references, and migration/config consequences.

## Stage 7: Lens Review Execution

Lens review execution is the candidate-generation stage. It runs selected lenses against planned review packets and produces structured candidate findings, follow-up hints, and uncertainties. It must not publish comments directly.

V1 should run one composite review task per packet. If a packet has multiple selected lenses, those lenses should be included in one model task rather than running one model call per lens. This keeps cost and latency bounded while still letting language, core correctness, tests, and project-specific guidance work together.

Execution should be coverage-aware:

- `light`: compact packet, tiny optional read-only tool budget.
- `normal`: real read-only tool access with focused review instructions and bounded investigation.
- `deep`: real read-only tool access, larger budget, and more focused investigation rounds.

Normal and deep packet reviewers may use the same read-only tool suite. The difference is budget, investigation depth, and prompting, not capability.

Reviewer workers should submit an empty finding list when the packet evidence is insufficient. They should use tools only to support, narrow, or reject a concrete changed-code concern, not for broad repository exploration.

Skill and lens prompt content should be projected and capped for the review stage. codeninja should include only the guidance relevant to candidate generation rather than pasting entire large skill files into every packet prompt.

After each packet review, codeninja should validate the structured result before sending candidates to verification. It should record schema failures, out-of-hunk anchors, missing evidence, low-confidence findings, tool calls, prompt size, token usage, runtime, and task status in telemetry. Findings outside the changed hunk should not be treated as inline candidates unless they can be re-anchored to a changed line with concrete evidence.

## Stage 8: Cross-File / System Follow-Up Review

Cross-file/system follow-up review is a focused follow-up stage, not a second broad review of the whole PR.

Stage 8 should run after packet review so it can use both planner follow-up tasks and packet review outputs. Inputs include planner `systemFollowUpTasks`, structured packet follow-up hints, packet uncertainties, candidate findings, packet metadata, changed symbols, and file facts.

Packet reviewers should emit structured follow-up hints when they need cross-file evidence:

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

The orchestrator should build a deterministic cross-packet signal index before scheduling system follow-up tasks. It should normalize planner tasks, packet hints, candidate findings, and uncertainties into review signals:

```ts
type ReviewSignal = {
  // Stable signal id for telemetry, dedupe, and system-task source tracking.
  id: string
  // Where this signal came from.
  source: "planner" | "packet_hint" | "candidate" | "uncertainty"
  // Packet reviews that produced or relate to this signal.
  packetIds: string[]
  // Files named by the source signal.
  files: string[]
  // Symbols named by the source signal.
  symbols: string[]
  // Lenses relevant to investigating this signal.
  lenses: string[]
  // Optional finding/review category for clustering.
  category?: string
  // Optional concrete question to answer in system follow-up review.
  question?: string
  // Human-readable reason this signal matters.
  reason: string
  // Scheduling priority derived from planner coverage, severity, labels, or confidence.
  priority: "critical" | "high" | "normal" | "low"
}
```

Signals should be indexed by symbol, file, category, configured labels, and candidate root keys. This lets codeninja detect overlap between independently reviewed packets without asking an LLM to rediscover the overlap.

System follow-up tasks should be created only when there is a concrete, bounded question. Promotion reasons include:

- Planner requested a system follow-up task.
- Multiple packet signals mention the same symbol, interface, API, file, or root cause.
- A medium/high-confidence packet hint names related files or symbols.
- A candidate finding needs related files to confirm impact or scope.
- A changed API/interface appears to affect multiple implementations, callers, or tests.

System follow-up tasks should be suppressed when:

- They do not name specific files or symbols.
- They are based on only one weak, low-confidence hint.
- They are too broad for the configured file or tool budget.
- They duplicate another scheduled system task.

Each system follow-up task should be question-sized:

```ts
type SystemFollowUpTask = {
  // Stable task id used by scheduler, telemetry, and final traceability.
  id: string
  // Short label for the system concern being reviewed.
  topic: string
  // Concrete question the follow-up reviewer must answer.
  question: string
  // ReviewSignal ids that caused this task to be scheduled.
  sourceSignals: string[]
  // Packet ids whose hunks/results are relevant to this task.
  relatedPacketIds: string[]
  // Bounded file set the follow-up reviewer should focus on.
  files: string[]
  // Bounded symbol set the follow-up reviewer should inspect or trace.
  symbols: string[]
  // Lenses active for this focused system follow-up review.
  lenses: string[]
  // Scheduler priority for ordering and budget allocation.
  priority: "critical" | "high" | "normal" | "low"
  // Read-only tool and investigation limits for this task.
  toolBudget: ToolBudget
}
```

System follow-up workers may use the same read-only semantic tool suite as packet reviewers, but with task-specific file/symbol constraints. They should produce structured candidate findings, resolved/rejected hint notes, and uncertainties. Findings still go through verification and deduplication before publication.

System follow-up review should be tightly capped by default: maximum tasks, maximum files per task, maximum tool calls, maximum result size, and task timeout. Prefer skipping a vague follow-up over running an expensive broad pass.

## Stage 9: Candidate Verification

Candidate verification is the false-positive control stage. Findings from packet reviewers, system follow-up workers, and promoted static signals are not publishable until they pass verification.

Before spending LLM verifier calls, codeninja should run deterministic pre-verification gates:

- Validate candidate schema.
- Validate changed-line anchor when inline publication is requested.
- Reject or suppress candidates with no changed-code evidence.
- Reject or suppress candidates with no concrete failure mode.
- Suppress low-confidence candidates by default.
- Pre-cluster exact or obvious duplicate candidates so the verifier does not check the same issue repeatedly.

Pre-clustering in this stage is a verifier scheduling optimization, not final deduplication. It may choose a representative candidate for identical or near-identical copies and preserve the losing candidates as lineage, but it must not perform semantic grouping, ranking, comment-cap enforcement, or final wording decisions. Those belong to final composition.

Every surviving candidate should be verified by an independent LLM verifier by default. Verification may be disabled only through explicit configuration for faster local experimentation, not as the default v1 behavior.

The verifier receives one candidate at a time, its originating packet or system follow-up context, the relevant changed hunk(s), cited evidence, active lens criteria, and the read-only semantic tool suite. The verifier should use tools only to prove, narrow, or reject the candidate. It must not search for new issues.

Verifier output should be structured:

```ts
type VerificationVerdict = {
  verdict: "keep" | "reject" | "revise"
  reason: string
  requiredEvidencePresent: boolean
  falsePositiveRisk: "low" | "medium" | "high"
  finalFinding?: CandidateFinding
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
- Candidates that remain unverified after retry should be marked `verification_incomplete` and suppressed from publication by default.
- The final report should disclose verification incompleteness when it affects review coverage or suppressed high-severity candidates.

Verification should run with bounded concurrency and record telemetry for every candidate: pre-gate decision, verifier prompt size, tool calls, token usage, runtime, verdict, revision details, rejection reason, and incomplete-verification reason.

The output of this stage is a set of verified, rejected, revised, or incomplete findings with traceable lineage. Stage 9 does not decide the final review shape.

## Repository Tools

Reviewer and verifier passes should receive tools for targeted repository exploration instead of raw full-repo context.

V1 tools should be read-only by default. They should feel like familiar read/list/search tools, but each tool should have a stable semantic contract independent of the backend used to answer it.

The repository tool layer should support pluggable backends:

- Tree-sitter backend: preferred when a grammar is available for the file language. It should provide symbols, enclosing blocks, imports, syntax-aware snippets, and structured source ranges.
- Text backend: required fallback for every repository. It should use `rg`, file listing, line windows, and simple filename/test conventions when tree-sitter is unavailable or parsing fails.
- Language analyzer backend: optional future enrichment for languages where deeper semantic analysis is available.

Callers should not need to know which backend answered a tool call. Tool results should include backend provenance such as `tree-sitter`, `text`, or `language-analyzer`, and should record degraded results when a semantic request falls back to text search.

Minimum required v1 tools:

- `read_range(path, startLine, endLine, source?)`.
- `read_enclosing_symbol(path, line)`.
- `list_symbols(path)`.
- `read_diff_blocks(packetId | path)`.
- `search_files(query, pathGlob?, contextMode)`, where `contextMode` can return no context, line windows, or enclosing symbols.
- `list_files(glob)`.

Expected backend behavior:

- `read_range` uses file/git reads and does not require tree-sitter.
- `read_enclosing_symbol` uses tree-sitter when available and falls back to a bounded line window with a degraded-result marker.
- `list_symbols` uses tree-sitter when available and falls back to lightweight language heuristics or an empty degraded result.
- `read_diff_blocks` uses parsed diff data and does not require tree-sitter.
- `search_files` uses `rg` for discovery, then may enrich matches with tree-sitter enclosing symbols when `contextMode` asks for semantic context.
- `list_files` uses filesystem/git listing and does not require tree-sitter.

Best-effort v1 tools when syntax support is available:

- `read_symbol(path, symbolName | line)`.
- `find_references(symbolName, pathGlob?)`.
- `find_likely_tests(path | symbol)`.

For best-effort tools, tree-sitter should be used when possible, but text fallback is still useful. For example, `find_references` may use syntax-aware identifiers when available and `rg` fallback otherwise; `find_likely_tests` may combine test filename conventions with symbol extraction when available.

Source-reading tools should read the head worktree by default and support base-revision reads when the review target has a base revision. Base reads are required for reviewing deleted files and removed-line context when local git can provide the content.

Tool outputs must be capped by count and characters. They should include file paths, line numbers, backend provenance, and degradation notes. They should prefer semantic source blocks over whole files, and record truncation or omitted-result counts in telemetry.

Tree-sitter should be the default cross-language syntax layer. It should enrich packets, changed-symbol extraction, and static signals where language grammars are available.

Language-specific analyzers may enrich the common tool interface later, but v1 should remain useful with tree-sitter-backed support.

## Telemetry And Debug Traces

codeninja needs first-class local telemetry so review quality, cost, latency, and failure modes can be analyzed during development and evaluation.

Telemetry should be local by default. codeninja must not send source code, prompts, findings, or usage data to an external telemetry service unless the user explicitly configures such behavior in the future.

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
- Repository tools invoked, including tool name, target path or symbol, duration, and success/failure.
- Candidate findings produced.
- Verification verdicts.
- Findings rejected and rejection reasons.
- Deduplication/grouping decisions.
- GitHub posting attempts and results.

Debug traces should make the review process inspectable. When enabled, codeninja should record step-by-step events describing:

- Current stage.
- File, hunk, symbol, or candidate finding being processed.
- Lens or skill being applied.
- Relevant line ranges.
- Tool calls made.
- What the reviewer found or rejected.
- Why a candidate finding was kept, revised, or suppressed.

Debug traces may include source snippets, prompts, and model outputs, so they should be opt-in and written to local files rather than mixed into normal stdout output.

Telemetry artifacts should support the eval workflow. An evaluator should be able to run codeninja against a real remote repository or branch, define expected findings externally, and inspect telemetry to understand whether misses came from packet construction, lens selection, tool behavior, model output, verification, deduplication, or final composition.

## Skills And Lenses

V1 skills and user-provided extensions should be Markdown files only.

A skill defines review guidance, concrete checks, examples, false-positive rules, safe patterns, and output constraints. Skills should not be mostly persona text.

A lens is the user-facing review perspective. A lens may map to one or more skills.

Bundled v1 lenses should include at least:

- Core code review.
- Logic/correctness bugs.
- Architecture/design.
- Tests.

Language and domain lenses may be added as bundled skills when available, such as Go, TypeScript, security, database, performance, and concurrency.

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
- A clear "no findings" result when no credible findings are found.
- Posting plan for GitHub mode.

### Stdout Markdown

When `--post-github-comments` is not used, codeninja should print the final review as clean, structured Markdown to stdout.

The Markdown report should include:

- Review summary.
- Coverage summary, including partial-review disclosure when applicable.
- Findings grouped by severity.
- File and line references.
- Evidence and failure mode for each finding.
- Suggested fix or suggested test when useful.
- A clear "no findings" result when no credible findings are found.

When `--post-github-comments` is used, stdout should not print the full report by default. It should print a concise run summary with counts, posting status, and any fatal or skipped-posting errors.

## Stage 11: GitHub Publishing

Stage 11 is optional and runs only when GitHub posting is requested.

GitHub posting is opt-in with:

```bash
codeninja review --pr 123 --post-github-comments
```

When enabled, codeninja should:

- Post inline comments for verified findings with valid changed-line anchors.
- Use `RIGHT` anchors for new/head-side lines and `LEFT` anchors for removed/base-side lines when GitHub accepts old-side review comments.
- Avoid posting low-confidence findings.
- Include medium-confidence and high-confidence findings.
- Include a short PR review body with the total finding count and any broad findings that cannot be anchored inline.
- Disclose partial coverage in the PR-level summary when the review did not cover the full change set.
- Avoid duplicate comments from previous codeninja runs when possible.

Duplicate avoidance should use a stable fingerprint derived from the finding identity, anchor, evidence, and message. On rerun, codeninja should skip or update prior codeninja-authored comments when it can identify them safely.

If a deleted-line or other inline anchor fails validation or GitHub rejects it, codeninja should move that finding to the PR review body rather than dropping it silently. This is especially important for deleted files, because valuable findings may be about removed behavior even when an inline anchor is unavailable.

V1 GitHub publishing should use `gh` and should be supported only for `--pr` mode. Branch, commit, commit-range, and diff-file modes should not post GitHub comments in v1 unless a future option explicitly supplies PR posting context.

## Configuration

The repository config file should be named:

```text
codeninja.toml
```

V1 configuration should support:

- Default base branch for branch review.
- Default review depth: `light`, `normal`, or `deep`.
- Path-based file handling rules, including processing mode, review priority, labels, and reasons.
- Enabling and disabling lenses.
- Extra Markdown skill paths.
- Severity and confidence thresholds.
- Maximum findings or soft comment cap.
- GitHub posting defaults.
- Model/provider options for `@earendil-works/pi-ai`.
- Runtime and per-pass timeouts.
- Review concurrency.
- Read-only tool permissions.
- Optional test/typecheck commands.
- Local telemetry and debug trace settings.

If no config exists, codeninja should run with sensible defaults:

- Core correctness-oriented lenses enabled.
- Review depth set to `normal`.
- Style/lint lenses disabled.
- Low-confidence findings suppressed.
- GitHub posting disabled.
- Runtime budget of 30 minutes.
- Safe bounded concurrency.
- Tests/typecheck disabled unless explicitly enabled.
- External telemetry disabled.

## Test And Command Execution

Repository mutation is out of scope for v1 review mode.

By default, codeninja should not run tests, typecheck, build commands, or arbitrary shell commands. Users may enable configured test/typecheck commands explicitly through config or flags. When enabled, commands must run with timeouts and their results should be treated as evidence, not automatic findings.

Editing and auto-fixing code should be a separate future mode, not part of v1 review.

## Error Handling

codeninja should fail clearly for:

- Not running inside a git worktree.
- Invalid or missing input mode.
- Invalid diff file path.
- Missing `gh` CLI for GitHub PR mode.
- `gh` authentication or permission failures.
- PR not found.
- Diff parsing failures.
- Unsupported or unavailable parser for a file language when no graceful fallback is possible.
- Config parse errors.

Parser or language-support failures for individual files should degrade gracefully when possible. codeninja may still review with raw diff context and basic file tools, but it should report degraded context in the run summary.

## Exit Codes

V1 should not fail the process merely because review findings were found.

Exit behavior:

- Exit `0` when review completes successfully, including when findings are present.
- Exit nonzero for runtime, configuration, authentication, parsing, or posting failures that prevent the requested operation from completing.

CI failure thresholds such as `--fail-on high` are out of scope for v1 unless explicitly added later.

## Out Of Scope For V1

- GitLab support.
- Auto-fixing or editing code.
- Executable TypeScript skill packages from users.
- Posting GitHub comments from `--diff` mode.
- Full-repository prompt dumping.
- Running every lens on every hunk.
- Style, naming, formatting, or lint review by default.
- CI failure thresholds based on finding severity.
