---
status: complete
---

# Component: Repository And GitHub

This component owns `src/git/*` and `src/github/*`: the `GitClient` and `GitHubClient` subprocess layers, the review input resolver, the diff parser, deterministic file classification and filtering, GitHub anchor validation, duplicate detection, and GitHub publishing. It implements Stages 1-3 of the pipeline plus Stage 11 posting, and supplies the git plumbing primitives that the repository tool layer builds on. For Stages 2-3 it owns the detector, classifier, and filter pure functions; `components/review_pipeline.md` owns when they run, the coverage-ledger writes, and the zero-work short-circuit.

All data contracts referenced here — `ReviewInput`, `ResolvedReviewInput`, `PullRequestMetadata`, `ExistingReviewThread`, `CommitInfo`, `UnifiedDiff`, `DiffFile`, `DiffHunk`, `DiffLine`, `FileFacts`, `FileFilterDecision`, `FactProvenance`, `DiffAnchor`, `FinalFinding`, `ReviewResult`, `CodegenieConfig`, `CodegenieError` — are defined in `architecture.md` and are used here unchanged.

## Purpose And Scope

This component is responsible for:

- The `GitClient` and `GitHubClient` implementations behind the interface seams defined in `architecture.md`, including subprocess invocation via `execa` with the Trust Boundaries subprocess-hygiene rules (no shell, `--` separators, option-injection rejection, SHA preference, credential scrubbing).
- The review input resolver: turning a `ReviewInput` for the resolved modes (`github_pr`, `branch`, `head`, `commit_range`), plus CLI-only default and single-ref targets, into a `ResolvedReviewInput` with pinned SHAs, merge base, commit metadata, and raw unified diff.
- PR ref fetching: the `refs/codegenie/pr/<n>/*` lifecycle, fork-PR head fetching via `refs/pull/<n>/head`, `baseRefOid`/`headRefOid`-anchored diffs, and the fixed diff flags shared by all modes.
- Shallow/partial clone detection and bounded deepening.
- Prior codegenie comment listing (`listOwnComments`): REST pagination, deterministic `ExistingReviewThread` mapping, and codegenie-author fingerprint detection for rerun duplicate avoidance. (Human review-thread fetching is deferred to Future Considerations — see architecture.md.)
- The diff parser: `UnifiedDiff`/`DiffFile`/`DiffHunk`/`DiffLine` construction, absolute old/new line mapping, stable hunk-id hashing, file status detection including `copied`, binary, and mode-only, and rename/deleted path semantics.
- Detection, filtering, and classification: the shared deterministic detector library (generated/vendor/lockfile/binary detectors, package-root detection, test-status conventions, `codegenie.toml` path rules, `FactProvenance`), consumed first by the Stage 2 detect/filter pass and then by Stage 3 `FileFacts` enrichment of kept files.
- GitHub anchor validation: the changed-line LEFT/RIGHT validation used by packet output validation, pre-verification gates, and pre-posting checks.
- Duplicate detection against prior codegenie comments: the stable finding fingerprint, author-verified marker parsing, and the ±5-line fuzzy match.
- GitHub publishing: the single `COMMENT` review, 422 recovery with suspect-class dropping and the summary-only fallback, and deterministic comment sanitization (mention neutralization, HTML-comment stripping, body caps, secret scrubbing).
- Commit-mode boundary cases: root-commit empty-tree diffs, submodule pointer bumps, and symlink entries.

This component is explicitly not responsible for:

- The `RepositoryTools` layer, `SourceSelector` resolution, the path-containment chokepoint for tool calls, and revision-read tools — `components/context_and_tools.md` (it consumes this component's `GitClient` as its git plumbing primitive).
- Pipeline orchestration, planner dossier construction, packet construction, coverage aggregation, and the budget ladder — `components/review_pipeline.md`.
- Skill loading, the LLM runner, the model-call cache, and telemetry/artifact writing — `components/skills_llm_telemetry.md` (this component emits events through the `TelemetryRecorder` interface defined there).
- The eval harness and artifact replay — `components/evals.md`.
- Deciding which findings publish inline versus summary-only: Stage 10 composition owns `FinalFinding.publication` and `FinalFinding.fingerprint`; this component validates, sanitizes, deduplicates, and posts.

## Public Interface

### Module Entry Points

These functions are the seams the pipeline orchestrator calls, matching the main algorithm in `architecture.md`. `TelemetryRecorder` is defined in `components/skills_llm_telemetry.md`. Type placement note: `SearchResult` is defined in `components/context_and_tools.md` (`src/repo/`); `GitClient.grep` returns that same shape via a type-only import — an acceptable inverse dependency because it is type-only.

```ts
// src/git/git-client.ts
function createGitClient(repoRoot: string, opts?: { defaultRemote?: string }): GitClient

// src/git/review-input-resolver.ts
function resolveReviewCommandTarget(
  target: ReviewCommandTarget,
  config: CodegenieConfig,
  telemetry: TelemetryRecorder
): Promise<ResolvedReviewInput>

function resolveReviewInput(
  input: ReviewInput,
  config: CodegenieConfig,
  telemetry: TelemetryRecorder
): Promise<ResolvedReviewInput>
// Errors: not_git_worktree, invalid_args, gh_missing, gh_auth_failed, pr_not_found,
//         git_ref_missing, git_base_branch_unresolved, git_fetch_failed

// src/git/diff-parser.ts
function parseDiff(rawDiff: string, telemetry: TelemetryRecorder): Promise<UnifiedDiff>
// Errors: diff_parse_failed (fatal; empty input returns { files: [] } instead of failing)

function buildDiffAnchorIndex(diff: UnifiedDiff): DiffAnchorIndex
function validateDiffAnchor(anchor: DiffAnchor, index: DiffAnchorIndex): DiffAnchorValidation
// Pure functions; never throw for invalid anchors — they return a structured rejection.

// src/git/file-classifier.ts
function filterDiffFiles(
  resolved: ResolvedReviewInput,
  diff: UnifiedDiff,
  config: CodegenieConfig,
  telemetry: TelemetryRecorder
): Promise<{ kept: DiffFile[]; decisions: FileFilterDecision[] }>
// Stage 2: runs the skip-relevant detectors and applies keep/skip policy;
// memoizes detection results per file. Content-read failures degrade, never throw.

function classifyChangedFiles(
  resolved: ResolvedReviewInput,
  kept: DiffFile[],
  decisions: FileFilterDecision[],
  config: CodegenieConfig,
  telemetry: TelemetryRecorder
): Promise<FileFacts[]>
// Stage 3: enrichment facts for kept files only; reuses the filter's memoized
// detection results and never re-detects. Content-read failures degrade.

// src/github/github-client.ts
function createGitHubClient(repoRoot: string): GitHubClient

// src/github/publisher.ts
function maybePublishToGitHub(
  finalReview: ReviewResult,
  resolved: ResolvedReviewInput,
  config: CodegenieConfig,
  telemetry: TelemetryRecorder
): Promise<RunPostingRecord | undefined>
// No-op (returns undefined) when finalReview.postingPlan is absent; a posting plan
// present outside "github_pr" mode re-asserts invalid_args. When posting runs, the
// returned RunPostingRecord is what renderOutputs (which runs after publishing)
// renders the concise posting summary from.
// Errors: github_post_failed (fatal only because posting was explicitly requested)
```

`--post-github-comments` cannot be enabled from configuration, so the publisher keys off `finalReview.postingPlan`: Stage 10 includes a posting plan only when the flag was passed. A posting plan in any mode other than `github_pr` is an `invalid_args` defect (the CLI rejects it earlier; the publisher re-asserts `invalid_args`).

### GitClient

The seam is defined in `architecture.md` and is reproduced here annotated with behavior and error conditions, plus one addition this component owns: `lsFiles`, the tracked-file check. All methods run `git` in `repoRoot` through the subprocess layer described under Internal Design.

```ts
interface GitClient {
  // `git rev-parse --verify <ref>^{commit}` → full SHA.
  // Errors: git_ref_missing when the ref does not resolve; invalid_args for option-like
  // or check-ref-format-invalid refs (rejected before spawning).
  revParse(ref: string): Promise<string>

  // `git cat-file blob <ref>:<path>` → exact file content at the revision (no final-newline
  // stripping, no textconv/diff-driver influence). This is the plumbing implementation of the
  // architecture's `git show <ref>:<path>` revision-read mechanism.
  // Errors: git_ref_missing when ref or path is absent at that revision; invalid_args for
  // option-like ref/path values. Callers must gate binary files via FileFacts.isBinary.
  catFile(ref: string, path: string): Promise<string>

  // `git ls-tree -r --name-only <ref> [-- :(glob)<glob>]` → repo-relative paths.
  // Errors: git_ref_missing; invalid_args for option-like ref/glob.
  lsTree(ref: string, glob?: string): Promise<string[]>

  // `git ls-files -z -- <paths...>` → the subset of the given paths tracked in the
  // index (the tracked-file check). The cache component consumes it for the
  // repo-tracked-cache-dir refusal (components/skills_llm_telemetry.md).
  // Errors: invalid_args for option-like path values.
  lsFiles(paths: string[]): Promise<string[]>

  // `git grep -I -n --no-color -e <pattern> <ref> [-- :(glob)<glob>]`.
  // The pattern is POSIX ERE (`-E`), passed via `-e` so patterns starting with `-` are legal.
  // Results are truncated to opts.maxResults with the omitted count recorded for telemetry.
  // A no-match exit (code 1) returns []. Errors: git_ref_missing; invalid_args (ref/glob only).
  grep(ref: string, pattern: string, opts?: { glob?: string; maxResults?: number }): Promise<SearchResult[]>

  // `git merge-base <a> <b>` → SHA. Errors: git_ref_missing when either ref is unknown or
  // histories are unrelated/shallow-truncated (message names `git fetch --unshallow`).
  mergeBase(a: string, b: string): Promise<string>

  // `git log` over a range expression composed internally from validated SHAs
  // (`<a>..<b>` or `<sha>^!`), with the pinned NUL-delimited format. Returns newest-first.
  log(range: string): Promise<CommitInfo[]>

  // `git diff <base> <head> --` with the pinned flag set (see Fixed Diff Flags). Returns the
  // raw unified diff text. Errors: git_ref_missing; diff_parse_failed when output exceeds the
  // subprocess buffer cap (the error message reports the size).
  diff(base: string, head: string): Promise<string>

  // `git fetch <defaultRemote> <refspec>` where defaultRemote is the client's configured
  // remote (resolver-selected base remote, falling back to "origin"). The refspec is
  // validated: optional leading `+`, then `<src>:<dst>` or a bare ref/SHA, each part
  // check-ref-format-valid or full hex, never option-like. Errors: git_fetch_failed.
  fetch(refspec: string): Promise<void>

  // `git rev-parse --is-shallow-repository` → boolean.
  isShallow(): Promise<boolean>
}
```

The implementation also exposes internal helpers that are not part of the cross-component seam. They are consumed only inside `src/git/` and `src/github/`:

```ts
// Internal to this component; not visible to the pipeline or tools layer.
currentBranch(): Promise<string | undefined>          // git rev-parse --abbrev-ref HEAD; undefined when "HEAD" (detached)
isInsideWorktree(): Promise<boolean>                   // git rev-parse --is-inside-work-tree
repoRoot(): Promise<string>                            // git rev-parse --show-toplevel
commitExists(sha: string): Promise<boolean>            // git cat-file -e <sha>^{commit}
resolveBranch(name: string): Promise<{ sha: string; ref: string } | undefined>
                                                       // refs/heads/<name>, then refs/remotes/<remote>/<name>
remotes(): Promise<Array<{ name: string; url: string }>>
fetchFrom(remote: string, refspec: string, opts?: { deepen?: number }): Promise<void>
deleteRef(ref: string): Promise<void>                  // git update-ref -d <ref>
listRefs(prefix: string): Promise<string[]>            // git for-each-ref --format=%(refname) <prefix>
lsTreeEntry(ref: string, path: string): Promise<{ mode: string; type: string; oid: string } | undefined>
emptyTreeSha(): Promise<string>                        // git hash-object -t tree /dev/null, cached per run
checkIgnored(paths: string[]): Promise<Set<string>>    // git check-ignore --stdin -z
```

### GitHubClient

The seam is defined in `architecture.md` and reproduced unchanged. All methods invoke the `gh` CLI through the same subprocess layer. Every method may fail with `gh_missing` (binary not found) or `gh_auth_failed` (unauthenticated or insufficient permission), surfaced from a one-time preflight or from the underlying call.

```ts
interface GitHubClient {
  // `gh pr view <n> --json number,title,body,url,baseRefName,headRefName,baseRefOid,headRefOid`
  // plus `gh repo view --json owner,name` for owner/repo. When baseRefOid/headRefOid are absent
  // (older gh), falls back to `gh api repos/<owner>/<repo>/pulls/<n>` and reads base.sha/head.sha.
  // Caches the result per PR number for the run.
  // Errors: pr_not_found; gh_auth_failed; gh_missing.
  viewPr(number: number): Promise<PullRequestMetadata>

  // POST /repos/<owner>/<repo>/pulls/<n>/reviews via `gh api --input -` (JSON body on stdin)
  // with event "COMMENT" and commit_id set to the PR head SHA cached from viewPr.
  // Precondition: viewPr(number) must have been called this run (the publisher guarantees it);
  // violating it is an internal invalid_args error. HTTP 422 is surfaced as a recoverable
  // github_post_failed error carrying { httpStatus, responseBody } context (sanitized) so the
  // publisher can run 422 recovery. Other failures: github_post_failed.
  createReview(number: number, review: { body: string; event: "COMMENT"; comments: InlineCommentInput[] }): Promise<void>

  // GET /repos/<owner>/<repo>/pulls/<n>/comments with manual per_page=100 pagination.
  // Filters to comments authored by the authenticated `gh` login (viewerLogin, cached per run,
  // compared case-insensitively) and maps them to ExistingReviewThread records: isCodegenie is
  // true only when a fingerprint marker parses AND the author matches viewerLogin; line falls
  // back to original_line for outdated comments.
  listOwnComments(number: number): Promise<ExistingReviewThread[]>
}
```

`InlineCommentInput` carries `path`/`line`/`side`/`start_line`/`start_side`/`body` per `architecture.md`.

### Component-Owned Types

New types defined by this component, following the scope-prefix naming convention:

```ts
// Result of validating one DiffAnchor against the parsed diff.
type DiffAnchorValidation = {
  valid: boolean
  reason?:
    | "unknown_path"
    | "wrong_side_path"
    | "unknown_hunk"
    | "line_not_in_hunk"
    | "line_not_changed"
    | "side_mismatch"
    | "multiline_invalid"
}

// Read-only lookup structure over a UnifiedDiff; built once, shared by Stages 7/9/11.
type DiffAnchorIndex = {
  isChangedLine(path: string, line: number, side: "RIGHT" | "LEFT"): boolean
  hunkIdAt(path: string, line: number, side: "RIGHT" | "LEFT"): string | undefined
}

// One duplicate-detection decision per inline-publication finding.
type FindingDuplicateDecision = {
  findingId: string
  action: "post" | "skip_exact_fingerprint" | "skip_fuzzy_proximity"
  matchedCommentId?: string
  reason: string
}

// Whole-run posting outcome, serialized by the telemetry recorder into github-posting.json.
// This is also the pinned schema for the posting-mode `--format json` run summary:
// the publisher returns it, and renderOutputs — which runs after maybePublishToGitHub —
// renders the concise stdout summary (Markdown or JSON) from the returned record.
type RunPostingRecord = {
  attempted: boolean
  status: "posted" | "skipped_no_findings" | "skipped_all_duplicates" | "summary_only_fallback" | "failed"
  inlinePosted: number
  demotedToBody: number
  skippedDuplicates: number
  attempts: Array<{ httpStatus?: number; commentCount: number; outcome: "ok" | "rejected" | "error" }> // one entry per review-creation attempt
  error?: string
}
```

### Error Conditions Summary

All errors are `CodegenieError` values with codes from `architecture.md`. Mappings used by this component:

- `not_git_worktree`: any mode invoked outside a git worktree.
- `invalid_args`: option-like (`^-`) or check-ref-format-invalid argument values reaching `GitClient`/`GitHubClient`; detached HEAD or current-branch-equals-base in the bare default (the message asks for an explicit review target); posting plan outside `github_pr` mode.
- `gh_missing` / `gh_auth_failed`: `gh` preflight failures in `--pr` mode or when posting.
- `pr_not_found`: `gh pr view` reports no such PR.
- `git_ref_missing`: unresolvable refs/commits, unrelated histories, or a shallow clone that still cannot resolve the range after deepening (message names `git fetch --unshallow`).
- `git_base_branch_unresolved`: branch mode with no resolvable base after the full precedence chain.
- `git_fetch_failed`: PR head/base fetch failures.
- `diff_parse_failed`: structurally invalid non-empty diff input; oversized diff output.
- `github_post_failed`: posting failures; fatal only after the summary-only fallback also fails.

## Internal Design

### Subprocess Invocation Layer

A single private module (`src/git/subprocess.ts`) wraps `execa` for both `git` and `gh`. Every rule in the Trust Boundaries subprocess-hygiene contract is enforced here, at one chokepoint, so no caller can bypass it.

Invocation rules:

- Spawn with an argv array; never set `shell`. No string concatenation of commands.
- `cwd` is always `repoRoot`.
- Environment: inherit the process env plus `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_PAGER=cat`, `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `CLICOLOR=0`. Never inject credentials into the env; `gh` manages its own auth.
- `stripFinalNewline: false` for content-bearing reads (`catFile`, `diff`); default trimming elsewhere.
- Timeouts: 60s for local git operations, 300s for network operations (`git fetch`, all `gh` calls). Timeout failures map to the calling method's error code with a "timed out" message.
- Output buffer cap: 64 MiB. `diff` overflow maps to `diff_parse_failed` with the observed size; other overflows truncate with a telemetry note where the caller tolerates truncation (`grep`) or fail typed where it does not.

Argument validation, applied before spawning:

- `assertSafeRef(ref)`: accepted forms are a full 40/64-char hex SHA, or a refname valid under `git check-ref-format` rules (implemented locally: no leading `-`, no `..`, no control chars, no `~ ^ : ? * [ \`, no leading/trailing `/`, no `.lock` suffix, no `@{`). Internal callers may pass composed revision expressions (`<sha>^1`, `<sha>^{commit}`, `<a>..<b>`, `<sha>^!`, `<ref>:<path>`) only when every component part was individually validated first. Refs are harness-resolved only (model-facing source selectors expose `head`/`base`, never raw refs); harness-side ref values arriving via the tools layer are re-validated here defensively.
- `assertSafePath(path)` / `assertSafeGlob(glob)`: reject values matching `^-` and embedded NUL bytes. Repo-containment canonicalization for filesystem access is the tools-layer chokepoint's job, via the shared `assertContainedRepoPath` helper in `src/util/paths.ts` (canonicalize, must resolve inside `repoRoot`, reject absolute and `..` forms, do not follow symlinks out of the root); this component itself reads content only through git plumbing.
- Untrusted positional path/ref arguments are always preceded by `--` where the git subcommand supports it (`grep`, `ls-tree`, `log`, `diff`, `check-ignore`). For combined `<ref>:<path>` arguments (`cat-file`), validation of both parts guarantees the value cannot begin with `-`.
- Search patterns are passed via `-e <pattern>` (never positionally), so patterns beginning with `-` are legal without violating the option-injection rule.
- SHAs are preferred over ref names everywhere both exist; GitHub-supplied ref names (`baseRefName`, `headRefName`) are display-only and never become git arguments.

Error scrubbing: before any subprocess error is logged, attached to a `CodegenieError` context, or written to telemetry, the layer scrubs credential material: URL userinfo (`://[^@/\s]+@` → `://[redacted]@`), `Authorization:`/`token`-style header values, and anything matching the secret-scrubber patterns (see Comment Sanitization). Raw `gh` responses stored in error context pass through the same scrubber.

### GitClient Internals

#### Fixed Diff Flags

All modes produce the raw diff with one pinned invocation so hunk ids are stable across reruns and machines, and so user git config cannot change parse behavior:

```text
git -c core.quotepath=off -c diff.mnemonicPrefix=false \
  diff --no-color --no-ext-diff --no-textconv --unified=3 \
  --find-renames --find-copies --diff-algorithm=myers \
  --src-prefix=a/ --dst-prefix=b/ <base> <head> --
```

- `--find-renames --find-copies` populate the `renamed` and `copied` statuses in `DiffFile`.
- `--diff-algorithm=myers` pins the default algorithm explicitly (closest to GitHub's rendering; residual edit-script differences are absorbed by 422 recovery at posting time).
- `--unified=3` matches GitHub's context width.
- `-c core.quotepath=off` keeps non-ASCII path bytes literal; paths containing quotes/control characters still arrive C-quoted and the parser unquotes them.

#### Commit Metadata Format

`log` uses record/unit separators so titles and multi-line bodies parse unambiguously:

```text
git log --no-show-signature --date=iso-strict \
  --format=%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1e <range> --
```

Records split on `\x1e`, fields on `\x1f`, mapped to `CommitInfo { sha, title, body, authorName, authoredAt }`. The resolver composes ranges internally: `<base>..<head>` for ranges, `<sha>^!` for a single commit (also correct for root commits). No count cap is applied; planner dossier compaction owns commit-list budgeting (`components/review_pipeline.md`).

### Review Input Resolver

The resolver is the Stage 1 entry point. Common preconditions for every mode:

1. Verify `git rev-parse --is-inside-work-tree` succeeds; otherwise fail `not_git_worktree`.
2. Resolve `repoRoot` via `git rev-parse --show-toplevel`.
3. Resolve all user- or GitHub-supplied names to full SHAs once, up front; every later git operation uses SHAs (`prefer SHAs over ref names`).

The resolver must never checkout, reset, stash, or otherwise mutate the working tree, index, or current branch in any mode.

All resolver telemetry events use stage `1` (`input_resolved`, `pr_refs_fetched`, `base_resolved`, `shallow_deepened`, ...), with `gh`/`git` preflight failures reported at stage `0`.

#### Bare Command Default

With no target arguments, the CLI passes `{ mode: "branch", branchName: <current branch> }` semantics through the resolver:

- `currentBranch()` returning `undefined` (detached HEAD) fails with `invalid_args`: "HEAD is detached; pass an explicit review target (`--pr`, `--branch`, or a commit)."
- After base resolution (below), if the current branch name equals the resolved base branch's short name, fail with `invalid_args`: "current branch <x> is the base branch; pass an explicit review target."
- Otherwise behavior is identical to `--branch <current-branch>`, including merge-base semantics.

An empty resulting diff (branch fully merged) is not an error: the resolver returns `rawDiff: ""` and the orchestrator's zero-work path short-circuits (`components/review_pipeline.md`).

#### Branch Mode And Base Resolution

For a single positional CLI target (`codegenie review <target>`), the command resolver first tries branch resolution. If `<target>` resolves as a local or remote branch, it uses this branch-mode flow. If it does not resolve as a branch, the resolver falls back to single-commit mode. `--base` is accepted with the shorthand only when the target resolves as a branch; otherwise the resolver fails clearly and asks for `<base>...<head>` when the user intended explicit head/base review. The single-ref shape is CLI/resolver-only; later stages see either `branch` or `commit_range`.

1. Resolve the review branch: `refs/heads/<name>` first, then `refs/remotes/<remote>/<name>` (remote order: `origin` first, remaining remotes sorted by name). Unresolvable → `git_ref_missing`.
2. Resolve the base branch in precedence order, stopping at the first level that yields a resolvable branch:
   1. CLI `--base <name>`.
   2. `codegenie.toml` `git.baseBranch`.
   3. An existing `master` branch (local or remote, same lookup order as step 1).
   4. An existing `main` branch (local or remote).
   Each candidate name uses the same local-then-remote lookup. An explicitly passed or configured base that does not resolve fails immediately with `git_base_branch_unresolved` naming the candidate; exhausting the chain fails with `git_base_branch_unresolved` asking the user to pass `--base` or configure `git.baseBranch`.
3. `mergeBase = mergeBase(baseSha, branchHeadSha)` (merge-base semantics so the diff matches PR-style changes).
4. `rawDiff = diff(mergeBase, branchHeadSha)` with the fixed flags.
5. `commits = log(mergeBase..branchHeadSha)`.
6. `ResolvedReviewInput`: `baseRef` and `headRef` carry the resolved SHAs (display names go to telemetry only), `headSha = branchHeadSha`, `mergeBase` set, `pr` undefined.

#### Commit And Commit-Range Mode

- Single commit `<c>`: resolve to `sha`. Base is the first parent `sha^1`; for a root commit (no parent, detected by `rev-parse sha^1` failing), base is the empty tree sentinel from `emptyTreeSha()` (`git hash-object -t tree /dev/null`, correct for both SHA-1 and SHA-256 repositories). For a merge commit, first-parent diffing reviews the merge's effect on its main line. `commits = log(<sha>^!)`.
- Two commits `<start> <end>`: resolve both; `rawDiff = diff(startSha, endSha)` — a direct endpoint diff, not merge-base, per `architecture.md`. `commits = log(startSha..endSha)`.
- `ResolvedReviewInput`: `startCommit`/`endCommit` set; `baseRef` = the diff base (parent, empty tree, or start), `headRef`/`headSha` = the reviewed end commit so base/head tool reads work uniformly. `mergeBase` is set to that same effective base — the first parent for single-commit review, the empty-tree sentinel for a root commit, the start commit for ranges — per `architecture.md`'s rule that the resolver populates `mergeBase` in every mode so later stages never re-derive it.

Boundary cases (inventoried, then classified — see File Classification):

- Root commit: the empty-tree diff marks every file `added`; nothing special downstream.
- Submodule pointer bumps: the parser sets `DiffFile.isSubmodule` (Subproject-commit content pattern / `160000` mode headers); filtered at Stage 2 with reason "submodule pointer change".
- Symlink entries: the parser sets `DiffFile.isSymlink` from `120000` mode headers; when headers are absent, the classifier backfills the field via `lsTreeEntry(ref, path).mode === "120000"` at head (or base for deletions). Inventoried but not content-reviewed — classified `skip` with reason "symlink change".

#### Diff-File Mode (Deferred)

The `--diff <path>` loose-diff input mode and its resolver flow are deferred to Future Considerations — see architecture.md.

#### PR Mode

1. Preflight `gh`: locate the binary (`gh_missing`) and check `gh auth status` (`gh_auth_failed`). Resolve `viewerLogin` once (`gh api user`, `.login`) and cache for the run.
2. `viewPr(n)`: collect title, body, url, `baseRefName`/`headRefName` (display-only), and `baseRefOid`/`headRefOid`. The reviewed revisions are exactly these OIDs so the reviewed diff matches GitHub's PR diff; the merge base is computed between them and the diff uses the fixed flag set. REST fallback when the JSON fields are unavailable. `owner`/`repo` come from `gh repo view --json owner,name`.
3. List codegenie's own prior review comments (`listOwnComments(n)`) for rerun duplicate avoidance, consumed by the publisher's duplicate detection. Human review threads are never fetched in v1; existing-PR-thread planner hints are deferred to Future Considerations — see architecture.md.
4. Locality check: `commitExists(baseRefOid)` and `commitExists(headRefOid)`.
5. Fetch what is missing (see PR Ref Fetching), failing `git_fetch_failed` with the attempted refspec when fetch fails.
6. `mergeBase = mergeBase(baseRefOid, headRefOid)`; `rawDiff = diff(mergeBase, headRefOid)`; `commits = log(mergeBase..headRefOid)`.
7. `ResolvedReviewInput`: `baseRef = baseRefOid`, `headRef = headSha = headRefOid`, `pr` populated.

#### PR Ref Fetching And Lifecycle

Base remote selection: parse `remotes()`, normalize each URL (https/ssh/`git@` forms reduced to `host/owner/repo`, trailing `.git` stripped), and pick the remote matching the PR's `owner`/`repo`; fall back to `origin`, then the first remote. No remotes at all → `git_fetch_failed` ("no git remote available to fetch PR commits").

Fetch plan when commits are missing locally:

- Head: `fetchFrom(baseRemote, "+refs/pull/<n>/head:refs/codegenie/pr/<n>/head")`. `refs/pull/<n>/head` lives on the base repository's remote, so this covers fork PRs without adding the fork as a remote. After fetching, verify `commitExists(headRefOid)`; if the PR branch advanced between `viewPr` and the fetch, re-run `viewPr` once and re-anchor to the fresh OIDs (single retry, then `git_fetch_failed`).
- Base: first attempt `fetchFrom(baseRemote, "+<baseRefOid>:refs/codegenie/pr/<n>/base")` (GitHub permits reachable-SHA fetches); on rejection, fetch the base branch (`+refs/heads/<baseRefName>:refs/codegenie/pr/<n>/base`) and verify `commitExists(baseRefOid)`.

Ref lifecycle:

- All codegenie-created refs live under `refs/codegenie/pr/<n>/*` and are force-updated (`+` refspec prefix) on each run.
- At run start for PR `<n>`, stale `refs/codegenie/pr/<n>/*` from crashed runs are deleted before fetching.
- At run end, the run's refs are deleted best-effort; failures log a warning only.
- Ref deletion is guarded by the advisory lock file under `.codegenie/` (run lifecycle, `architecture.md`) so concurrent runs against the same PR do not delete each other's refs mid-run.
- Non-PR modes never create refs.

#### Shallow And Partial Clones

- Detection: `isShallow()` (`git rev-parse --is-shallow-repository`).
- When shallow and any required resolution fails (ref resolution, `mergeBase`, `log`), attempt a bounded deepen against the relevant remote: `fetchFrom(remote, <ref>, { deepen: 100 })`, re-check, then one more attempt with `deepen: 1000`. If the range still cannot be resolved, fail `git_ref_missing` with a message naming the fix: "repository is shallow; run `git fetch --unshallow` (or fetch more history) and retry".
- Partial (promisor/filtered) clones need no special handling: git lazily fetches missing blobs during `cat-file`/`diff`; the only observable effect is latency, noted in telemetry when operations are slow.

### Prior codegenie Comment Listing

`listOwnComments` is the only PR-comment read in v1. Fetching human review threads (`fetchReviewThreads` via `gh api graphql` over `pullRequest.reviewThreads`, with cursor pagination, the 100-thread cap, and `omittedThreadCount` disclosure) is deferred to Future Considerations — see architecture.md.

Behavior (REST `GET /repos/<owner>/<repo>/pulls/<n>/comments`, manual `per_page=100` pagination):

- Filter to comments authored by the authenticated `gh` login (`viewerLogin`, cached per run, compared case-insensitively); other users' comments are never collected.
- Mapping to `ExistingReviewThread`:
  - `id` = comment id; `path`/`side` = the comment's anchor fields; `line` = `line`, falling back to `original_line` for outdated comments; `author` = the comment author login.
  - `isCodegenie` = fingerprint marker parses from the comment body AND `author` equals `viewerLogin`. Markers in other users' comments never set `isCodegenie` and never suppress.
  - `fingerprint` = the parsed marker fingerprint when `isCodegenie`.
  - Thread resolution state and comment-body summarization are not handled in v1: duplicate detection consumes only the author-verified marker fingerprint and the anchor fields, and nothing model-facing consumes comment bodies. (Resolution state belongs to the deferred human-thread fetching — see architecture.md Future Considerations.)

Marker grammar (shared with duplicate detection):

```text
<!-- codegenie:fingerprint=<64-hex>;run=<run-id> -->
regex: /<!--\s*codegenie:fingerprint=([0-9a-f]{64});run=([A-Za-z0-9._-]+)\s*-->/
```

### Diff Parser

#### Input Grammar

The parser is a line-oriented state machine over the raw diff text. V1 accepts git-header unified diffs only: sections starting `diff --git a/<old> b/<new>`, followed by extended headers (`old mode`, `new mode`, `deleted file mode`, `new file mode`, `copy from/to`, `rename from/to`, `similarity index`, `index`), then optional `---`/`+++` lines and hunks. All v1 modes produce exactly this form via the fixed diff flags.

Plain unified diffs without git headers (`---`/`+++`-only file sections) and format-patch/mail-wrapped inputs strict-fail with `diff_parse_failed`; the lenient grammars for those forms return with the deferred diff-file input mode (see architecture.md Future Considerations).

Empty or whitespace-only input returns `{ files: [] }` (the zero-work path handles it). Any structural violation in non-empty input — a hunk header that does not parse, a hunk body line with an illegal leading character, line counts disagreeing with the header — fails the whole parse with `diff_parse_failed` and the offending input line number; the parser never silently drops malformed files.

Per-line handling inside hunks: leading `' '` → `context`, `'+'` → `add`, `'-'` → `delete`. `\ No newline at end of file` markers are consumed and not represented as `DiffLine`s (they carry no line-number or anchor semantics). C-quoted paths (`"a/path \"x\".go"`) are unquoted, including octal escapes.

#### File Status And Path Semantics

Status detection, in precedence order: `new file mode` → `added`; `deleted file mode` → `deleted`; `rename from/to` → `renamed`; `copy from/to` → `copied`; otherwise `modified`. Additionally:

- `isBinary` when the body is `Binary files ... differ` or `GIT binary patch`; such files carry zero hunks.
- `modeOnly` when extended headers contain `old mode`/`new mode` and no hunks follow.
- `isSymlink` when an extended header carries mode `120000` on either side (`old mode`, `new mode`, `new file mode`, `deleted file mode`, or the `index` line's mode).
- `isSubmodule` when an extended header carries gitlink mode `160000`, or every hunk line matches `^[-+]Subproject commit [0-9a-f]{40,64}$`.

Path semantics follow `architecture.md` exactly: deleted files carry the old path in `DiffFile.path`; renames and copies carry the new path in `path` and the source in `oldPath`; `rename from`/`copy from` headers are preferred over `a/`-prefix parsing because they are unambiguous for paths containing spaces. `language` is the provisional extension-based hint only; `FileFacts.language` is authoritative.

#### Line Number Mapping

Hunk headers `@@ -<oldStart>[,<oldLines>] +<newStart>[,<newLines>] @@[ <header>]` parse with omitted counts defaulting to 1 and zero-length sides (`-0,0`) supported. Two counters start at `oldStart`/`newStart`:

- `context`: assign both `oldLineNumber` and `newLineNumber`, increment both.
- `delete`: assign `oldLineNumber` only, increment old.
- `add`: assign `newLineNumber` only, increment new.

After each hunk the parser asserts consumed counts equal the header counts (else `diff_parse_failed`). These absolute numbers are the source of truth for packet line numbers, changed-line detection, and GitHub anchors; no later stage recomputes them.

#### Hunk Ids

The architecture formula `sha256(path + oldStart + newStart + normalizedHunkHeader + changedLineNumbers)` is pinned to this canonical byte serialization (UTF-8, `\x00` separators):

```text
hunkId = sha256Hex(
  path                       // the same path the DiffFile carries
  + "\x00" + String(oldStart)
  + "\x00" + String(newStart)
  + "\x00" + normalizedHunkHeader
  + "\x00" + changedLineNumbers
)

normalizedHunkHeader = header text after the closing "@@" delimiter,
                       trimmed, internal whitespace runs collapsed to single spaces
                       ("" when absent)
changedLineNumbers   = "add:" + comma-joined newLineNumbers of add lines
                       + ";del:" + comma-joined oldLineNumbers of delete lines
                       (each in file order; empty lists allowed)
```

Ids are stable across reruns of the same diff and intentionally change when the hunk's position or changed-line set shifts. Packet ids (`sha256(path + sorted hunkIds + kind)`) are computed by the packet builder in Stage 6 (`components/review_pipeline.md`).

#### Anchor Index

`buildDiffAnchorIndex` walks the parsed diff once and builds per-path, per-side maps from changed lines to their hunk:

- RIGHT map: `newLineNumber → hunkId` for every `add` line, keyed by the new path (`DiffFile.path`).
- LEFT map: `oldLineNumber → hunkId` for every `delete` line, keyed by the old path (`oldPath` for renames/copies, `path` for deletions and in-place modifications).

Context lines are deliberately absent from the index: inline publication is changed-lines-only by product rule. Legacy GitHub diff positions are not computed anywhere — anchors are line/side only, per `architecture.md`.

### File Classification And Filtering

Implementation order follows `architecture.md` and matches the stage numbering: parse → Stage 2 detect/filter (the skip-relevant detectors plus keep/skip policy, recording decisions with detection provenance) → Stage 3 classification (enrichment facts for kept files, reusing the memoized detection results).

#### Shared Detector Library

`src/git/detectors.ts` is the single deterministic detector library; the Stage 2 filter consumes it first (the skip-relevant detectors) and Stage 3 classification reuses the memoized results for kept files, both recording identical `FactProvenance`. Every detector returns `{ value, provenance: FactProvenance }`. No detector calls the LLM, and the library ships no business/domain risk keywords.

Content source rule: detectors that read file content read it at the reviewed revisions through `GitClient.catFile` — head for added/modified/renamed files, base for deleted files — never the checked-out worktree. Content reads are bounded to the first 64 lines or 8 KiB, whichever is smaller; read failures degrade the fact to its path-based result with a `low`-confidence provenance note rather than failing the run.

- Generated detector:
  - Marker scan of the bounded head/base content for: `^// Code generated .* DO NOT EDIT\.$` (Go convention), `@generated`, `DO NOT EDIT`, `Autogenerated`, `automatically generated` (case-insensitive for the latter three). Provenance source `generated_detector`, confidence `high`.
  - Filename patterns: `*.pb.go`, `*_pb2.py`, `*.pb.ts`, `*.gen.go`, `*.generated.*`, `*.min.js`, `*.min.css`, `*.snap`. Provenance source `filename`, confidence `medium`.
- Vendor detector: any path segment in `vendor/`, `node_modules/`, `third_party/`, `bower_components/`, `.yarn/`, `Pods/`. Provenance source `path`, confidence `high`.
- Lockfile detector: exact basenames `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `Cargo.lock`, `go.sum`, `composer.lock`, `Gemfile.lock`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `flake.lock`, `gradle.lockfile`, `packages.lock.json`. Provenance source `filename`, confidence `high`.
- Binary detector: `DiffFile.isBinary` from diff metadata only. Provenance source `diff`, confidence `high`.
- Ignored detector: `checkIgnored` (`git check-ignore`) against the trusted local checkout; hits are rare since tracked files in git-produced diffs are normally not ignored. Provenance source `git`.
- Package-root detector: nearest ancestor directory (walking from the file's directory up to the repo root) containing one of `go.mod`, `package.json`, `Cargo.toml`, `pyproject.toml`, `setup.py`, `setup.cfg`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `composer.json`, `Gemfile`, `mix.exs`. The ancestor scan runs in memory against a single cached `lsTree(headRef)` listing. Provenance source `path`.
- Test-status detector, from established conventions only: Go `*_test.go`; TS/JS `*.test.*`, `*.spec.*`, `__tests__/` segment; Python `test_*.py`, `*_test.py`, `tests/` segment; Rust `*_test.rs` or a `tests/` segment; Solidity `*.t.sol` or a `test/` segment; generic `test/` or `tests/` path segment. Match → `"test"`; no match with a known language → `"source"`; unknown language or binary → `"unknown"`. Rust source containing inline `#[cfg(test)]` remains source because inline discovery is deferred.
- Language detector: extension map (representative: `.go`→`go`; `.ts/.mts/.cts/.tsx`→`typescript`; `.js/.jsx/.mjs/.cjs`→`javascript`; `.rs`→`rust`; `.sol`→`solidity`; `.md`→`markdown`; plus one entry each for `.py`, `.rb`, `.java`, `.kt`, `.swift`, `.c/.h`, `.cpp`, `.cs`, `.sql`, `.sh`, `.yaml/.yml`, `.json`, `.toml`) and known basenames (`Dockerfile`, `Makefile`, `go.mod`, `go.sum`). Fallback `"unknown"`. Provenance source `extension` or `filename`.
- Submodule detector: consumes the parser-populated `DiffFile.isSubmodule` (content pattern / `160000` mode headers). Provenance source `diff`.
- Symlink detector: consumes the parser-populated `DiffFile.isSymlink`; when mode headers were absent, backfills the field via `lsTreeEntry` mode `120000` at head (base for deletions). Provenance source `diff` (parser-populated) or `git` (ls-tree backfill).

#### Stage 2 Filter Pass

`filterDiffFiles` runs before classification. It executes the skip-relevant detectors and applies keep/skip policy per changed file. The decision uses first-match precedence in this canonical order — this doc owns the canonical order; `components/review_pipeline.md` points here:

1. binary (diff metadata or detector) → skip.
2. lockfile → skip.
3. generated → skip.
4. vendored → skip.
5. ignored path / configured `processingMode = "skip"` rule / submodule pointer change / symlink entry → skip.
6. mode-only (v1 cannot review mode-only changes usefully) → skip.
7. keep.

Each decision carries the decisive reason and the detection provenance of the matching rule.

It returns the kept `DiffFile[]` and exactly one `FileFilterDecision` per changed file (`action: "keep" | "skip"`, the decisive reason, and the detection provenance), memoizing detection results per file for `classifyChangedFiles` to reuse — nothing detects twice. Decisions flow to the planner dossier as counts/paths and into `coverage.json` (orchestrator-owned). Filtered files produce no packets, no candidate findings, and no further classification or parsing work; they remain visible to the planner as review-scope facts.

#### FileFacts Assembly

`classifyChangedFiles` produces one `FileFacts` per kept `DiffFile` (deleted reviewable files included — they are review inventory, not noise):

1. Copy the filter's memoized detection results (generated/vendor/lockfile/binary) with their provenance; run the enrichment detectors (language, package root, test status).
2. `changedLines` = count of `add` + `delete` lines; `hunkCount` = hunk count.
3. Apply configured path rules (below): labels, `reviewPriority`, `processingMode` overrides.
4. Derive `processingMode` (first match wins; skip decisions already happened in the Stage 2 filter, so kept-file facts never carry `skip`):
   - configured `processingMode` from path rules, when set (`skip` rules were consumed by the filter).
   - `whole-file` for added files with total new lines ≤ 100 (small-added-file rule; packet size caps still apply in Stage 6).
   - `per-hunk` otherwise.
5. `reviewPriority` defaults to `"normal"` unless configured.
6. Every processing-mode decision and configured label appends a human-readable entry to `reasons` and a `FactProvenance` record.

Deleted-file rule: deleted reviewable source/test/config/migration/docs files keep their ordinary processing mode (review of removed behavior happens old-side); deleted generated/vendor/lock/binary files match ordinary skip rules. When deleted-file content cannot be read at base, facts degrade: `degraded = { reason: "base content unavailable for deleted file" }` rather than pretending normal classification.

Policy-file change signal: when the diff touches `codegenie.toml` or `.codegenie/skills/**`, the classifier attaches the label `policy-change` with config-source provenance. Policy itself always loads from the trusted local checkout (Trust Boundaries; loading is the config component's job) — this label is how the modification is surfaced to the planner as a risk signal and noted in the report.

#### Configured Path Rules

`classification.pathRules` patterns are matched with `picomatch`-style globs (`**` crosses directories; matching is against the repo-relative path of `DiffFile.path`, plus `oldPath` for renames so rules catch files moving out of a configured area). Evaluation is ordered:

- All matching rules apply.
- Scalar fields (`processingMode`, `reviewPriority`): last matching rule wins.
- `labels`: union across matching rules, de-duplicated, original order preserved.
- Each applied rule appends provenance `{ fact, source: "config", confidence: "high", reason: rule.reason }`.

Configured labels are user-provided facts, never codegenie-inferred risk truth.

#### Diff-File Worktree Validation (Deferred)

The diff-file mode's hunk-context staleness validation — classification invoking the tools-layer `validateHunkContextAgainstWorktree` primitive and acting as the single writer of `FileFacts.degraded` for that validation — is deferred with the diff-file input mode (see architecture.md Future Considerations). `FileFacts.degraded` itself stays in v1 for deleted-file degradation (above), and degraded facts still flow into packets and the coverage summary (`components/review_pipeline.md`).

### GitHub Anchor Validation

`validateDiffAnchor` is the single deterministic implementation used by Stage 7 packet-output validation, Stage 9 pre-verification gates (both invoked from `components/review_pipeline.md`), and Stage 11 pre-posting checks. Rules, evaluated against the `DiffAnchorIndex`:

1. `anchor.path` must be the side-appropriate path: RIGHT anchors use the new path; LEFT anchors use the old path (`oldPath` for renames/copies; `path` for deleted files, where old and new naming coincide). Violation → `wrong_side_path` (or `unknown_path` when the path appears on neither side).
2. `anchor.line` must be a changed line on `anchor.side`: an `add` line for RIGHT, a `delete` line for LEFT. Context lines fail with `line_not_changed` — inline publication is changed-lines-only; deleted-file and deletion-hunk findings anchor LEFT on removed lines.
3. `anchor.hunkId` must equal the hunk owning that line (`unknown_hunk` / `line_not_in_hunk`).
4. Multi-line anchors: `startLine` must be strictly less than `line` (publisher collapses `startLine === line` to a single-line anchor before validation), `startSide` defaults to `side`, and both endpoints must be changed lines within the same hunk. Violation → `multiline_invalid`.

A finding that fails validation is never posted inline; the publisher demotes it to the review body (below) and earlier stages convert it to a summary-only candidate.

### Duplicate Detection

`src/github/duplicate-detector.ts` prevents reposting findings from previous codegenie runs.

Fingerprint: this component owns the canonical implementation of the architecture's formula, called by Stage 10 when setting `FinalFinding.fingerprint` and by this detector:

```text
norm(x)     = lowercase, trim, collapse whitespace runs to single spaces
fingerprint = sha256Hex(
  norm(path)
  + "\x00" + norm(enclosingSymbolOrHunkIdentity)   // enclosing symbol name when available, else hunkId
  + "\x00" + norm(category)
  + "\x00" + norm(lensId)                          // producedBy.lensId
)
```

Model-authored wording (title, failure mode, evidence) is excluded so fingerprints are stable across runs; the enclosing-symbol preference keeps them stable across diff shifts when symbol facts exist.

Detection flow, run by the publisher before posting:

1. `listOwnComments(n)` → prior comments authored by the authenticated identity. A fingerprint marker counts as codegenie-authored only when the comment author matches `viewerLogin`; markers in other users' comments are ignored for suppression.
2. Exact pass: a finding whose fingerprint equals any prior codegenie fingerprint → `skip_exact_fingerprint`.
3. Fuzzy pass: a finding whose side-appropriate path matches a prior codegenie-authored comment's path and whose anchor line is within ±5 lines of that comment's line (falling back to `original_line` for outdated comments) → `skip_fuzzy_proximity`. Per `architecture.md`, the fuzzy rule is path + proximity over codegenie-authored comments only; category is not part of it — it is hashed inside the fingerprint and not recoverable from posted markers.
4. Everything else → `post`.

Skipped findings are not demoted to the body (skip means "already said"); each decision is recorded as a `FindingDuplicateDecision` in telemetry and `github-posting.json`. v1 never updates or deletes stale comments: when a safe update is not possible, prefer posting no duplicate over mutating existing comments. (The github-action adapter's status comment is a distinct, explicitly-mutable comment class carved out from this rule — see GitHub Action Adapter below; finding comments remain immutable.) Duplicate suppression covers inline comments only; review bodies are per-run artifacts and are not fingerprint-tracked in v1.

### GitHub Publishing

#### Posting Flow

`maybePublishToGitHub` executes Stage 11 when `finalReview.postingPlan` is present:

1. Re-assert preconditions: mode `github_pr`, `gh` preflight, `viewPr` metadata cached (so `createReview` has the head SHA for `commit_id`).
2. Select inline candidates: findings referenced by `postingPlan.inline` with `publication: "inline"`. Defense-in-depth re-checks (each demotion recorded in telemetry): confidence must be ≥ `review.minInlineConfidence` (low-confidence findings are never posted), and the anchor must pass `validateDiffAnchor` against the parsed diff. Failures demote the finding's content into the review body rather than dropping it silently — deleted-file findings about removed behavior are the canonical case.
3. Run duplicate detection; drop skips.
4. If no inline comments and no body findings remain: post nothing unless `github.summaryWhenNoFindings` is true (then post a body-only review); record `skipped_no_findings` / `skipped_all_duplicates`.
5. Build the review body: `postingPlan.reviewBody` (summary, total finding count, broad/system findings) + partial-coverage disclosure from `finalReview.coverage` when applicable + demoted findings rendered with their file/line references.
6. Sanitize every inline body and the review body (below), then append the marker to each inline comment body:

```text
\n\n<!-- codegenie:fingerprint=<fingerprint>;run=<run-id> -->
```

   The marker is appended after sanitization so HTML-comment stripping cannot remove it, and the stdout renderer hides markers from normal Markdown output where possible (`src/output/`, one-line reference).
7. `createReview(n, { body, event: "COMMENT", comments })` — exactly one review per run; codegenie never approves or requests changes in v1. `commit_id` is the PR head SHA.
8. Write the `RunPostingRecord` through telemetry (`github-posting.json`) and return it. The publisher writes nothing to stdout itself: `renderOutputs` runs after `maybePublishToGitHub` and renders the concise posting summary — Markdown counts/status, or the record itself as the pinned `--format json` run-summary schema — from the returned record.

#### Comment Sanitization

Deterministic, in code, post-composition; applied to every inline comment body and the review body, in this order:

1. Strip HTML comments: remove all `<!--[\s\S]*?-->` from model-authored text (prevents forged markers and hidden content).
2. Neutralize `@`-mentions: replace `(^|[^\w`])@([A-Za-z0-9][A-Za-z0-9-]*)` with the mention wrapped in backticks (`` `@name` ``), preventing notification spam from attacker-influenced content; over-neutralization inside prose is acceptable.
3. Scrub secrets from evidence snippets and bodies. Pinned pattern set, each match replaced with `[redacted:<rule>]`:
   - Private key blocks: `-----BEGIN [A-Z ]*PRIVATE KEY-----` through the matching `END` line.
   - GitHub tokens: `gh[pousr]_[A-Za-z0-9]{36,}`, `github_pat_[A-Za-z0-9_]{22,}`.
   - AWS access keys: `AKIA[0-9A-Z]{16}`.
   - Slack tokens: `xox[baprs]-[A-Za-z0-9-]{10,}`.
   - JWTs: `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`.
   - Generic assignments: `(?i)(api[_-]?key|secret|token|passw(or)?d|authorization)\s*[:=]\s*['"]?\S{8,}` (value portion redacted).
   The same scrubber function is exported for the telemetry recorder to apply before persisting final findings (`components/skills_llm_telemetry.md`), and is reused by the subprocess layer's error scrubbing.
4. Cap body lengths against GitHub's 65536-character maximum: inline comment bodies cap at 10000 characters, the review body at 60000, truncating at the nearest paragraph boundary with a `"… (truncated)"` note before the marker is appended.

#### 422 Recovery

GitHub returns 422 when any inline comment is invalid for its diff; the review-creation call is atomic, so a 422 means nothing was posted. Recovery ladder, bounded by 3 review-creation attempts:

1. Attempt 1: the full comment set. On 422, parse the error payload; when it identifies failing comments (by index or path), drop exactly those to the review body and go to the next attempt.
2. When the payload does not identify the failure, drop the locally-suspect classes in order of rejection likelihood — deleted-file anchors, LEFT-side anchors, multi-line anchors — re-attempting after each drop, within the 3-attempt budget. Deleted-file anchors are first because removed-file comments are the most likely class to be rejected by GitHub while still carrying useful review content in the body.
3. Final fallback: post a summary-only review — no inline comments, all findings rendered in the body (`summary_only_fallback`).
4. Only if even the summary-only review fails does publishing fail the run: `github_post_failed`, fatal because `--post-github-comments` was explicitly requested.

Every attempt, demotion, and the final status is recorded in `RunPostingRecord` and stage-11 telemetry events (`github_review_posted`, `github_422_recovery`, `github_posting_failed`).

### GitHub Action Adapter (Plan 97)

`src/github-action/` is a self-contained adapter around the review path — the GitHub Actions trigger surface (`codegenie github-action`), authoritative preflight/event gating, and the status comment. It composes public seams only (synthesized `review --pr` argv, run-start/telemetry observers, the returned report); nothing in this component or the pipeline imports from it. Its bounded shared seams are the CLI dispatch, viewer-identity fallback, provider API-key env-name lookup, and run-attachment observer. Functional behavior (lanes, trigger phrase, authorization) is specified in `functional_spec.md` GitHub Action Mode.

The **status comment** is one issue comment per PR carrying the `<!-- codegenie:status-comment -->` marker: created (or reclaimed from a prior run) before the review starts, edited in place at stage boundaries (throttled, default minimum 10s between edits; after 3 consecutive edit failures the run continues headless), and terminally edited into the sanitized markdown report — capped to GitHub's 65,536-character comment limit with a truncation disclosure — or a short failure state. It is the explicitly-mutable exception to the never-mutate rule above. Reclaim requires the marker and an exact case-insensitive author match against identity resolved as `bot-login` → `/user` → `github-actions[bot]`; there is no `[bot]`-suffix fallback, so another app's marker is never adopted. Progress coalescing never polls an unresolved PATCH, and terminal states are absorbing. Bodies pass the comment sanitizer first, marker appended after, same ordering as finding markers. Lifecycle body-size fields measure UTF-8 bytes over the complete attempted payload including that marker, consistently before and after capping. The step-summary copy is sanitized as another GitHub-rendered surface; the downloadable report retains canonical secret-scrubbed Markdown.

**Viewer identity:** Actions installation tokens have no `/user` context, so `gh api user` fails there. The adapter resolves its identity in strict order — explicit `bot-login` action input (custom GitHub Apps) → `/user` lookup (PATs) → `github-actions[bot]` — and that exact login (case-insensitive) gates status-comment reclaim; suffix heuristics are forbidden so another app's marker comment is never adopted. Only the known installation-token `/user` limitation falls back; unrelated auth/infrastructure errors surface. The resolved login is injected via `CODEGENIE_GITHUB_LOGIN`, which `loadViewerLogin` uses only when `gh api user` fails; the author read back from a just-created status comment overrides the resolved login as ground truth. Duplicate detection is otherwise unchanged. The adapter's terminal comment carries the full `renderMarkdownReview` report (stdout in posting mode is the posting summary and goes to the CI log). Telemetry stays off by default; bounded decision/lifecycle records always reach the CI log, and `github-action.json` is persisted best-effort only when an attached telemetry run directory exists.

## Dependencies

This component depends on:

- `execa` for all `git` and `gh` subprocess invocation (no shell).
- External CLIs: `git` (all modes); `gh` (only `--pr` mode and posting; absence elsewhere is not an error).
- `node:crypto` (sha256 via `src/util/hashing.ts`) for hunk ids and fingerprints.
- `picomatch` for `classification.pathRules` globs, per `architecture.md`'s dependency choices.
- `src/util/paths.ts` (`assertContainedRepoPath`) shared with the tools-layer containment chokepoint, and `src/util/errors.ts` (`CodegenieError`).
- `CodegenieConfig` from the config loader and `TelemetryRecorder`/`Logger` from `components/skills_llm_telemetry.md`.
- `components/context_and_tools.md`: type-only `SearchResult` (returned by `GitClient.grep`).

Depended on by:

- `components/context_and_tools.md`: `RepositoryTools` uses `GitClient` (`catFile`, `lsTree`, `grep`, `revParse`) as its git plumbing backend for revision reads and `git grep` search.
- `components/review_pipeline.md`: calls `resolveReviewInput`, `parseDiff`, `filterDiffFiles`, `classifyChangedFiles`, `buildDiffAnchorIndex`/`validateDiffAnchor` (Stage 7 output validation and Stage 9 pre-gates), the fingerprint function (Stage 10), and `maybePublishToGitHub` (Stage 11, whose returned `RunPostingRecord` feeds `renderOutputs`).
- `components/skills_llm_telemetry.md`: reuses the secret scrubber before persisting final findings, and consumes `GitClient.lsFiles` for the cache's repo-tracked-cache-dir refusal.
- `components/evals.md`: consumes this component's artifacts (`coverage.json` inputs, `github-posting.json`) through normal run artifacts; no direct API dependency.

This component never calls the LLM, never mutates the repository or working tree (its only writes are git refs under `refs/codegenie/pr/<n>/*` and GitHub reviews when explicitly requested), and treats all reviewed content as data per Trust Boundaries.

## Test Plan

Vitest, per the architecture testing strategy: unit tests with fixtures for pure logic; integration tests against temporary git repositories; `gh` covered by a recording fake of the subprocess layer asserting exact argv and stdin payloads.

### Subprocess Layer

- `subprocess.no-shell-invocation` — every spawn uses an argv array with `shell` unset; asserted via the execa fake.
- `subprocess.rejects-option-like-ref` — `revParse("--upload-pack=x")` and `revParse("-rf")` throw `invalid_args` without spawning.
- `subprocess.rejects-option-like-path-and-glob` — `catFile(ref, "--evil")`, `lsTree(ref, "-x")`, `grep` glob `"-x"` all throw `invalid_args`.
- `subprocess.ref-format-rules` — refs with `..`, `~`, `^`, `:`, leading `/`, `.lock` suffix, `@{` are rejected; full hex SHAs and normal refnames pass.
- `subprocess.separator-before-pathspecs` — recorded argv for `grep`/`lsTree`/`log`/`diff` contains `--` before path/glob arguments.
- `subprocess.grep-pattern-via-dash-e` — pattern `"-foo"` is searchable (passed after `-e`), not rejected.
- `subprocess.credential-scrubbing` — stderr containing `https://x:ghp_abc@github.com` surfaces in error context as `https://[redacted]@github.com`; token patterns in `gh` error bodies are scrubbed.
- `subprocess.env-hygiene` — spawned env contains `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `GH_PROMPT_DISABLED=1`.

### GitClient

- `git-client.rev-parse-missing-ref` — unknown ref → `git_ref_missing`.
- `git-client.cat-file-content-fidelity` — file without trailing newline round-trips byte-exact (no final-newline stripping, no textconv).
- `git-client.diff-pinned-flags` — argv equals the pinned flag set; with repo config `diff.algorithm=patience`, `diff.noprefix=true`, `core.quotepath=on` set, output is unchanged.
- `git-client.merge-base-unrelated-histories` — two orphan branches → `git_ref_missing` with an explanatory message.
- `git-client.log-record-parsing` — multi-line bodies and titles containing `..` parse correctly via the `\x1e`/`\x1f` format.
- `git-client.fetch-default-remote-and-refspec-validation` — `fetch` targets the configured default remote; refspec `"--mirror"` is rejected.
- `git-client.ls-files-tracked-subset` — `lsFiles` returns only the tracked subset of the given paths; option-like path values are rejected with `invalid_args`.
- `git-client.empty-tree-sha-sha256-repo` — `emptyTreeSha()` returns the correct sentinel in a `sha256` object-format repo.

### Review Input Resolver (Temp-Repo Integration)

- `resolver.not-a-worktree` — running in a non-repo directory → `not_git_worktree`.
- `resolver.bare-default-equals-branch-mode` — bare invocation on a feature branch produces the same `ResolvedReviewInput` as explicit `--branch <current>`.
- `resolver.bare-default-detached-head` — detached HEAD → `invalid_args` asking for an explicit target.
- `resolver.bare-default-on-base-branch` — current branch `main` resolving as base → `invalid_args` asking for an explicit target.
- `resolver.base-precedence-order` — CLI `--base` beats config; config beats existing `master`; `master` beats `main` (four sub-cases).
- `resolver.base-remote-only` — base exists only as `origin/main` → resolves; SHAs pinned.
- `resolver.base-unresolvable` — no `--base`, no config, no master/main → `git_base_branch_unresolved`.
- `resolver.branch-merge-base-semantics` — base advanced after branch point: diff is `mergeBase..head`, excluding base-only changes.
- `resolver.branch-fully-merged-empty-diff` — merged branch yields `rawDiff: ""` without error (zero-work path downstream).
- `resolver.shas-pinned` — `baseRef`/`headRef`/`headSha` are full SHAs even when names were given.
- `resolver.commit-single-first-parent` — single commit diffs `sha^1..sha`; merge commit diffs against first parent only.
- `resolver.commit-root-empty-tree` — root commit reviews all files as `added` via the empty-tree base.
- `resolver.commit-range-endpoint-diff` — two commits produce a direct `start..end` diff (not merge-base) and `log(start..end)` commit metadata.
- `resolver.no-worktree-mutation` — HEAD, index, and `git status` are byte-identical before/after resolution in every mode.
- `resolver.shallow-deepen-then-resolve` — shallow clone fixture: deepen attempts (100 then 1000) are issued and resolution succeeds once history suffices.
- `resolver.shallow-unresolvable-names-unshallow` — still-unresolvable range → `git_ref_missing` whose message contains `git fetch --unshallow`.

### PR Mode (gh Fake + Temp Repos)

- `pr.view-field-mapping` — `gh pr view` JSON maps to `PullRequestMetadata`; `baseRefName`/`headRefName` never appear in any git argv (display-only).
- `pr.view-rest-fallback` — missing `baseRefOid`/`headRefOid` triggers the `gh api repos/.../pulls/<n>` fallback using `base.sha`/`head.sha`.
- `pr.not-found`, `pr.gh-missing`, `pr.gh-unauthenticated` — typed errors `pr_not_found`, `gh_missing`, `gh_auth_failed`.
- `pr.fetch-head-into-codegenie-ref` — missing head fetches `+refs/pull/<n>/head:refs/codegenie/pr/<n>/head` from the base remote (fork-PR case: head repo never added as a remote).
- `pr.base-sha-fetch-with-branch-fallback` — direct OID fetch attempted first; on rejection the base branch is fetched and `baseRefOid` verified present.
- `pr.base-remote-selection` — with `origin` pointing elsewhere and `upstream` matching owner/repo, fetches target `upstream`.
- `pr.head-moved-retry-once` — head OID missing after fetch → one `viewPr` re-anchor retry, then `git_fetch_failed`.
- `pr.refs-lifecycle` — stale `refs/codegenie/pr/<n>/*` deleted at start; refs force-updated; deleted at run end; simulated crash leaves refs that the next run cleans.
- `pr.merge-base-anchored-diff` — diff computed `merge-base(baseRefOid, headRefOid)..headRefOid`, matching GitHub's PR diff revisions.

### Prior-Comment Listing

- `comments.pagination` — multiple REST pages walked via `per_page=100` until exhausted; only viewer-authored comments are collected.
- `comments.codegenie-author-detection` — marker + author == viewer → `isCodegenie: true` with parsed fingerprint; marker with different author → `isCodegenie: false`, no fingerprint suppression.
- `comments.outdated-line-fallback` — outdated comment with null `line` uses `original_line`.

### Diff Parser

- `parser.empty-input` — `""` → `{ files: [] }`; whitespace-only likewise.
- `parser.garbage-input-fails` — non-empty non-diff text → `diff_parse_failed` with line context.
- `parser.line-number-mapping` — golden fixture asserting `oldLineNumber`/`newLineNumber` for every context/add/delete line across multiple hunks.
- `parser.header-count-mismatch-fails` — hunk body shorter than header counts → `diff_parse_failed`.
- `parser.status-detection` — added (`/dev/null` old), deleted, renamed (`path`=new, `oldPath`=old), copied, modified, each from fixtures.
- `parser.deleted-file-old-path-and-numbers` — deletion-only file carries the old path and old-side numbers (review inventory, not dropped).
- `parser.binary-and-mode-only` — `Binary files differ` and `GIT binary patch` → `isBinary` with zero hunks; mode-change-only section → `modeOnly`.
- `parser.symlink-and-submodule-fields` — `120000` mode headers set `isSymlink`; a gitlink section (`160000` mode / `Subproject commit` lines) sets `isSubmodule`.
- `parser.quoted-path-unescaping` — `"a/sp ace \"q\".go"` and octal-escaped UTF-8 paths unquote correctly.
- `parser.no-newline-marker` — `\ No newline at end of file` consumed; surrounding line numbering unaffected.
- `parser.format-patch-input-fails` — format-patch/mail-wrapped input (headers before `diff --git`, trailing signature) → `diff_parse_failed` (lenient grammar deferred with the diff-file input mode).
- `parser.plain-unified-fails` — headerless `---`/`+++`-only diff → `diff_parse_failed`.
- `parser.hunk-id-golden-vector` — pinned input → pinned sha256, locking the canonical serialization.
- `parser.hunk-id-stability-and-sensitivity` — same diff reparsed → identical ids; shifting a hunk by one line → different id.

### Anchor Index And Validation

- `anchor.right-add-valid` / `anchor.left-delete-valid` — changed-line anchors on the correct side validate, including LEFT anchors in deleted files.
- `anchor.context-line-rejected` — context-line anchor → `line_not_changed`.
- `anchor.wrong-side-path-rejected` — rename fixture: LEFT anchor using the new path → `wrong_side_path`; LEFT with `oldPath` validates.
- `anchor.unknown-path-and-hunk` — unknown path → `unknown_path`; stale hunkId → `unknown_hunk`.
- `anchor.multiline-rules` — `startLine >= line` rejected; cross-hunk range rejected; valid same-hunk range accepted; `startLine === line` collapsed by the publisher before validation.

### Classification And Filtering

- `classify.language-and-filenames` — extension map and known basenames, `"unknown"` fallback.
- `detect.generated-marker-head-read` — marker present at head but not in the worktree → `isGenerated: true` (proves revision reads, provenance `generated_detector`).
- `detect.generated-deleted-base-read` — deleted generated file detected from base content.
- `detect.vendor-lockfile-binary` — detector lists honored with correct provenance sources.
- `classify.package-root-nearest` — nested `package.json` under a `go.mod` repo resolves the nearest marker from the head tree listing.
- `classify.test-conventions` — `_test.go`, `*.spec.ts`, `__tests__/`, `test_*.py`, `*_test.rs`, `tests/*.rs`, and `*.t.sol` → `"test"`; ordinary Rust source (including inline tests) and other non-test source with known language → `"source"`; unknown language → `"unknown"`.
- `classify.small-added-whole-file` — added file with ≤ 100 lines → `whole-file`; 101 lines → `per-hunk`.
- `classify.path-rules-precedence` — overlapping rules: last-match scalar wins, labels union, per-rule provenance recorded.
- `classify.policy-change-label` — diff touching `codegenie.toml` / `.codegenie/skills/x.md` → label `policy-change`.
- `filter.submodule-and-symlink-skip` — gitlink bump (parser-set `isSubmodule`) → skip "submodule pointer change"; symlink (parser-set `isSymlink`, with `lsTreeEntry` mode-120000 backfill when headers are absent) → skip "symlink change".
- `filter.mode-only-skip` — `modeOnly` file → skip with reason.
- `filter.kept-files-skip-nothing` — kept-file `FileFacts` never carry `processingMode: "skip"`; configured skip rules are consumed by the filter.
- `detect.content-read-failure-degrades` — `catFile` failure degrades the generated fact to path-based with `low` confidence, run continues.
- `classify.deleted-file-base-unreadable-degrades` — deleted file whose base content cannot be read → `FileFacts.degraded` with the documented reason.
- `filter.decisions-cardinality` — exactly one `FileFilterDecision` per changed file; kept + skipped partitions the inventory.
- `filter.deleted-source-kept-deleted-lockfile-skipped` — deleted `.go` file kept; deleted `yarn.lock` skipped by ordinary rules.

### Duplicate Detection

- `dup.fingerprint-golden-vector` — pinned inputs → pinned sha256.
- `dup.fingerprint-normalization` — case and whitespace differences in path/symbol/category/lens normalize to one fingerprint.
- `dup.fingerprint-wording-independent` — different titles/failure modes/evidence, same identity → same fingerprint.
- `dup.symbol-preferred-over-hunk` — with symbol facts, fingerprint survives a hunk shift; without, it changes (motivating the fuzzy pass).
- `dup.exact-skip` — matching prior fingerprint → `skip_exact_fingerprint`.
- `dup.fuzzy-five-line-boundary` — prior codegenie comment at line 100: finding at 105 skips, at 106 posts.
- `dup.foreign-marker-not-suppressing` — marker authored by another login does not suppress.
- `dup.decisions-recorded` — every inline finding yields one recorded `FindingDuplicateDecision`.

### Publisher

- `publish.noop-without-posting-plan` — no `postingPlan` → no `gh` calls; posting plan outside `github_pr` → `invalid_args`.
- `publish.single-comment-review-shape` — one POST: `event: "COMMENT"`, `commit_id` = PR head SHA, comment fields `path`/`line`/`side`/`start_line`/`start_side`/`body`; body sent via stdin.
- `publish.marker-appended-after-sanitization` — stripped HTML comments cannot forge or destroy the genuine trailing marker.
- `publish.sanitize-mentions` — `@user` becomes `` `@user` `` in posted bodies.
- `publish.sanitize-secrets` — fixture bodies with a GitHub token, AWS key, private key block, and JWT post fully redacted.
- `publish.body-caps` — oversized inline body truncates at 10000 chars with the truncation note before the marker; review body caps at 60000.
- `publish.confidence-floor` — low-confidence finding never posts inline regardless of posting plan (defense-in-depth demotion recorded).
- `publish.invalid-anchor-demoted` — anchor failing re-validation moves the finding text into the review body, not dropped.
- `publish.duplicates-skipped-not-demoted` — duplicate findings appear in neither comments nor body.
- `publish.no-findings-respects-config` — nothing posts when empty unless `summaryWhenNoFindings: true`.
- `publish.422-identified-drop-retry` — 422 payload naming comment index → that comment demoted, retry succeeds, ≤ 3 review attempts.
- `publish.422-suspect-classes` — unidentifiable 422 drops LEFT/deleted-file/multi-line anchors in order and recovers within the 3-attempt budget.
- `publish.422-summary-only-fallback` — persistent 422 → summary-only review containing all findings.
- `publish.summary-only-failure-fatal` — summary-only failure → `github_post_failed`, nonzero exit.
- `publish.partial-coverage-disclosed` — `coverage.partial` run includes the disclosure in the review body.
- `publish.posting-record` — `RunPostingRecord` captures review-creation attempts, demotions, duplicate skips, and final status; the publisher returns the same record it persists to `github-posting.json`.
