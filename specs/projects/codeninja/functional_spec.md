---
status: complete
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

The command supports three input modes:

```bash
codeninja review --pr 123
codeninja review --base main --head HEAD
codeninja review --diff path/to.diff
```

All v1 modes require running from inside a local git worktree. This means the repository must exist locally so codeninja can inspect files, parse source, map diff paths to source files, and run read-only repository tools. The `--pr` mode uses GitHub metadata for PR context and posting, but the reviewed diff, changed files, and commit information should come from local git whenever possible.

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

### `--base` / `--head`

`--base <ref> --head <ref>` reviews the diff from a local git comparison.

Behavior:

- Compute the effective diff between the base and head refs.
- Collect commit titles and commit descriptions across the reviewed range as planner input.
- Prefer merge-base semantics for branch review so the reviewed diff matches pull-request-style changes.
- Do not attempt to post GitHub comments unless `--pr` is also provided or enough GitHub PR context is available.

### `--diff`

`--diff <path>` reviews an existing unified diff file. This mode is useful for reviewing a patch produced by another tool, an evaluation fixture, a CI artifact, or a downloaded `.diff` file while still allowing codeninja to inspect the local repository.

Behavior:

- Read the diff from disk.
- Use the local worktree for source inspection when diff paths match files in the repo.
- Treat PR metadata and commit descriptions as unavailable unless separately provided by future options.
- Do not post GitHub comments in v1 from diff-file mode.

## Review Pipeline

codeninja should use a staged review pipeline:

1. Parse the diff and changed file list.
2. Build syntax-aware changed-symbol information where supported.
3. Run a PR scout/planning pass.
4. Build compact review packets per hunk or file.
5. Run selected lenses on relevant packets, with bounded parallelism where packets can be reviewed independently.
6. Run cross-file/system review where the planner identifies systemic risk.
7. Verify candidate findings.
8. Deduplicate, rank, and compose final output.
9. Optionally post verified inline comments and a PR summary through GitHub.

The unit of candidate review is the changed hunk or file. The unit of understanding is the affected system.

The planner should choose review order and lenses based on language, changed symbols, risk tags, touched subsystems, tests touched or missing, and project configuration. It should not run every lens on every hunk by default.

## Parallel Review Execution

codeninja should parallelize review work when doing so does not reduce review quality.

V1 should support bounded concurrency for independent hunk/file review packets. The planner should produce packet groups that can be reviewed in parallel, while preserving ordered review intent for dependent or high-risk areas.

Parallel execution rules:

- Hunk/file candidate-generation passes may run concurrently.
- The scout/planning pass must run before parallel packet review.
- Cross-file/system review should run after packet review has produced initial signals, unless the planner explicitly schedules a focused system pass earlier.
- Verification may run concurrently per candidate finding.
- Deduplication and final composition must run after verification.
- Concurrency must be configurable and have a safe default.

The system should track which sub-agent or worker reviewed each packet so findings can be traced back to the exact stage, lens, packet, and source evidence that produced them.

## Review Packets

For each relevant hunk or file, codeninja should construct a deterministic review packet before invoking reviewer lenses.

Each packet should include:

- PR or diff summary.
- File path and language.
- Unified diff hunk content.
- Absolute new-file line numbers for changed lines.
- Changed line numbers.
- Enclosing symbol information when available.
- Nearby syntax-aware context.
- Imports or dependencies visible from the changed file.
- Related tests when discoverable.
- Related file hints from the planner.
- Risk tags selected by the scout pass.

Review packets should be compact. They should not contain the whole repository or large unrelated file dumps.

## Repository Tools

Reviewer and verifier passes should receive tools for targeted repository exploration instead of raw full-repo context.

V1 tools should be read-only by default and may include:

- Get enclosing symbol for a path and line.
- List symbols in a file.
- Get source for a symbol or line range.
- Get changed symbols for the diff.
- Find imports for a file.
- Find likely tests for a symbol or file.
- Search for references or similar patterns.
- Read relevant files or line ranges.

Tree-sitter should be the default cross-language syntax layer. It should power syntax-aware packets, changed-symbol extraction, and static signals where language grammars are available.

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
- Findings without a valid changed-line anchor must not be posted as inline GitHub comments.

## Verification And Deduplication

Every candidate finding must pass through an independent verifier before publication.

The verifier should receive the candidate finding, changed hunk, relevant source snippets, and repository tools. It must decide whether to keep, reject, or revise the finding.

The verifier should reject findings when:

- Required evidence is missing.
- The issue is speculative.
- The finding misunderstands surrounding code.
- The finding depends on an unresolved symbol or call path without enough confidence.
- The comment is style-only and style review is not enabled.
- The issue cannot be tied to changed behavior.

After verification, codeninja should deduplicate related findings, group same-root-cause issues, and rank by severity, confidence, impact, and actionability.

The final composer should prefer no comments over weak comments. The default target is roughly 3-7 high-signal comments per PR, but this is a soft cap: verified critical and high-severity findings should not be hidden only to satisfy the default limit.

## Output Behavior

### Stdout

When `--post-github-comments` is not used, codeninja should print a clean, structured Markdown report to stdout.

The Markdown report should include:

- Review summary.
- Findings grouped by severity.
- File and line references.
- Evidence and failure mode for each finding.
- Suggested fix or suggested test when useful.
- A clear "no findings" result when no credible findings are found.

When `--post-github-comments` is used, stdout should not print the full report by default. It should print a concise run summary with counts, posting status, and any fatal or skipped-posting errors.

### GitHub Comments

GitHub posting is opt-in with:

```bash
codeninja review --pr 123 --post-github-comments
```

When enabled, codeninja should:

- Post inline comments for verified findings with valid changed-line anchors.
- Avoid posting low-confidence findings.
- Include medium-confidence and high-confidence findings.
- Include a short PR-level summary comment or review body with the total finding count and any broad findings that cannot be anchored inline.
- Avoid duplicate comments from previous codeninja runs when possible.

Duplicate avoidance should use a stable fingerprint derived from the finding identity, anchor, evidence, and message. On rerun, codeninja should skip or update prior codeninja-authored comments when it can identify them safely.

## Configuration

The repository config file should be named:

```text
codeninja.toml
```

V1 configuration should support:

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
- Unsupported or unavailable parser for a file language when syntax-aware context is required.
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
