# Plan: read repository skills and `codegenie.toml` from the review's base revision (issue #113)

Status: IMPLEMENTED on the issue branch. The operator approved the five decisions in section 9 on 2026-11-20.
Branch: `peter/113-policy-from-base-revision`.
Line numbers are master `8a4c5bd`; the files cited are unchanged at `b8258f5`.

## 1. Decision

After input resolution, read the repository's review policy (`codegenie.toml` and `.codegenie/skills/**/*.md`) once, through git, from the tip of the base the review is measured against (`ResolvedReviewInput.baseRef`). Nothing in the working tree or in the reviewed commits selects or changes that policy. The three open cases resolve as follows:

1. **Base branch named by repository config.** The reviewed branch can no longer name its own base. Base selection uses `--base`, then the user's own config, then `master` or `main`; the repository's `git.baseBranch` is honoured only as read from that default branch. If the reviewed branch's own file names a different base, the run stops before any model call and asks the user to confirm with `--base`.
2. **No base tree.** A root commit has an empty base, so the repository policy is empty: bundled skills, user config, user extra skills. There is no fallback to the reviewed commit or the working tree. A base tree that cannot be read fails the run.
3. **`extraSkillPaths`.** They stay what they are: user-level filesystem paths, already refused when they come from repository config. The only addition is a warning when one resolves inside the repository, because that content is working-tree content.

## 2. What the code does today

- The CLI loads config, including the working tree's `codegenie.toml`, while parsing arguments, before the run starts and before the base is known (`src/cli/review-command.ts:156-169`, `src/config/config-loader.ts:121-128`).
- Repository skills are read from `<repoRoot>/.codegenie/skills` on disk (`src/skills/skill-loader.ts:53,68`), at two call sites (`src/pipeline/review-runner.ts:785-790` and `815-820`).
- An existing test asserts the hole: an uncommitted skill file in the working tree is loaded and appears in the report (`tests/pipeline-phase5.test.ts:10380-10400`).
- Every mode reviews committed revisions and sets `baseRef`: the pull request's base commit (`src/git/review-input-resolver.ts:154`), the base branch tip (`:404`), the parent or the empty tree for a single commit (`:466,478`), the range start (`:509`), the named base (`:562`).
- In branch mode without `--base`, the base comes from `config.git.baseBranch` (`review-input-resolver.ts:424-425`), which today includes the working tree's `codegenie.toml` (`config-loader.ts:392-394`).
- Repository config may set only a safe subset of keys (`config-loader.ts:87,359-430`). Three of them are consumed before the base is known: `git.baseBranch`, `telemetry.enabled` (`review-runner.ts:442-448`), and `review.maxTime` and `review.budgetBoost` (budget ledger and hard timeout, `review-runner.ts:477-483`, `1492-1498`).
- `lenses.extraSkillPaths` in repository config is already ignored with a warning (`config-loader.ts:404-406`). User paths are resolved against the process working directory (`skill-loader.ts:121`).
- The Action always runs `review --pr` (`src/github-action/entrypoint.ts:218-221`). Its policy is safe today only because the example workflow checks out the base commit (`examples/workflows/codegenie-review.yml:45`).
- Evals apply the checkout's `codegenie.toml` themselves (`src/evals/eval-runner.ts:479,557`).
- "Policy file" is defined twice (`src/git/file-classifier.ts:358-360`, `src/pipeline/planner.ts:1694-1696`). The change is detected and labelled, but nothing is rendered in the report.

## 3. Design

### 3.1 Which revision

The policy revision is `resolved.baseRef`: the base tip, not the merge base.

- The merge base is chosen by the author of the branch. Forking from an old commit would select an old policy, for example one from before a security skill was added. The base tip cannot be chosen that way.
- It is what the Action's workflow checks out today, so the Action's behaviour does not change.
- For a single commit the two are the same commit (the parent); for a range, the range start.

This differs from source reads, which use the merge base (`src/repo/source-resolver.ts:144-149`). That is correct for source, which must match the diff, and wrong for policy.

In the modes where the caller names the base (`--base X --head Y`, a commit, a range), the policy comes from the base the caller named. The guarantee is that the reviewed commits and the working tree never supply policy, not that the caller cannot pick a base.

### 3.2 Reading the policy

New module `src/repo/repository-policy.ts` (interfaces in section 4). `readBaseRevisionPolicy(resolved, git)`:

1. `baseRef` undefined, or equal to `git.emptyTreeSha()`: return `{ origin: "none", skillFiles: [] }`.
2. Config: `git.lsTreeEntry(baseRef, "codegenie.toml")`. Undefined means the file is absent. An entry that is not a regular file (type other than `blob`, or mode `120000`) is a `config_error`. Otherwise read it with `git.catFile`.
3. Skills: `git.lsTree(baseRef)`, keep paths that start with `.codegenie/skills/` and end with `.md`, sort, read each with `git.catFile`. Do not pass a glob to `lsTree`: `git ls-tree` rejects the `:(glob)` form that parameter builds (checked on git 2.56). `SourceResolver.listFiles` filters a full listing the same way (`source-resolver.ts:61-66`).
4. Any git failure other than "path absent" propagates. `lsTreeEntry` returns undefined for an absent path and throws `git_ref_missing` for an unreadable tree, so the two are distinguishable.

A symlink under the skills directory comes back as its link text and fails skill parsing as "missing YAML frontmatter"; it is never followed.

The same module exports `isRepositoryPolicyPath`, which replaces the two duplicate predicates, so the paths that are read and the paths that are detected as policy changes have one definition.

### 3.3 Config in two phases

The repository layer cannot be applied before the base is known, and it must stay below environment and CLI overrides. So:

- `loadConfig` stops reading `codegenie.toml` from disk. It accepts the file's text instead (`repoConfig?: { text, label }`) and applies it at the same place in the order as today. The merge logic stays in one function.
- The CLI calls `loadConfig` without the repository layer to get the config the run starts with, and hands `runReview` a closure, `finalizeConfig`, that calls `loadConfig` again with the same options plus the repository text.
- `runReview` starts the run with the first config, resolves the input, reads the policy, calls `finalizeConfig`, and adopts the result for every later stage.

Keys consumed before adoption:

| Key | Handling |
|---|---|
| `review.maxTime`, `review.budgetBoost` | Adopted. `RunContext.adoptConfig` rebuilds the budget ledger with the original start time and re-arms the hard timeout with the time remaining. Stage 1 makes no model calls, so the fresh ledger loses nothing. |
| `review.depth`, `lenses.*` in run metadata | `adoptConfig` updates the run metadata so `run.json` records the effective values. |
| `telemetry.enabled` | No longer settable from repository config; warned and ignored like the other telemetry keys. The run's telemetry already exists when the base is known. Default is off, so only repositories that turn it on for everyone are affected. |
| `git.baseBranch` | Section 3.5. |

Callers that pass no `finalizeConfig` (evals, tests) keep the config they passed.

### 3.4 Skills

`loadSkills` takes the repository skill files as data (`repoSkillFiles`) and no longer discovers `<repoRoot>/.codegenie/skills` on disk. Bundled and extra skills are read from disk as before; order and the "earlier id wins" rule are unchanged. Repository skills carry their repository-relative path as `filePath`.

### 3.5 Case 1: the base branch is named by repository config

When the run starts, the config has no repository layer, so `config.git.baseBranch` holds only the user's own setting. `resolveBaseBranch` (`review-input-resolver.ts:415-439`) becomes:

1. `--base`: use it.
2. User config `git.baseBranch`: use it.
3. Otherwise take the first of `master`, `main` that resolves, as today. Read `codegenie.toml` at that branch's tip. If it sets `git.baseBranch` to another branch, that branch is the base (it must resolve, else `git_base_branch_unresolved`). This is followed once; the second branch's own setting is not followed further.
4. Only when step 3 chose the base: read `codegenie.toml` at the reviewed branch's tip. If it sets `git.baseBranch` to a branch other than the chosen base, throw `git_base_branch_unresolved`: `the reviewed branch's codegenie.toml sets git.baseBranch = "X", but a branch cannot choose its own base (resolved base: "Y"). Pass --base X to confirm, or set git.baseBranch in your user config.` A reviewed-branch file that does not parse is ignored here.
5. Neither `master` nor `main` resolves: the existing error, reworded to say that the repository's file cannot name the base and, when the reviewed branch names one, to suggest `--base <that name>`.

Step 4 exists because step 3 alone would silently review a branch against `master` in a repository whose integration branch is named only in the branch's file. That would be a large, paid, wrong diff; an error naming the flag is cheaper.

Pull request, `--head`/`--base` and commit modes do not use `git.baseBranch` and are unaffected.

For branch-mode evals with a working-tree policy, explicit and configured bases still win, and the `master`/`main` fallback skips both committed config reads.

### 3.6 Case 2: no base tree

- Root commit (`review-input-resolver.ts:466`): policy origin `none`. No repository config, no repository skills.
- Base exists but has no policy files (the change that introduces them, and every review until it merges): same result through the normal path.
- Base tree unreadable (missing object in a shallow clone after deepening failed): the run fails with `git_ref_missing` in stage 1. It does not fall back.
- Unrelated histories already fail at merge-base; nothing changes.

In the first two situations the report says so (section 3.9).

### 3.7 Case 3: `extraSkillPaths`

- Source: user config only. The repository key stays ignored with its existing warning, now read from the base revision.
- Reads: filesystem, resolved as today. Not subject to the base-revision rule (owner decision).
- Addition: when a resolved extra path lies inside the repository root, emit a warning log line and a `extra_skill_path_in_repository` telemetry event saying it is read from the working tree, not the base revision. It is still loaded. `isContainedIn` already exists (`skill-loader.ts:134-142`).

### 3.8 Evals

Evals review historical commits. In the 2026-11-20 campaign, 2 of 3 cases review a single commit whose parent has no `codegenie.toml`, while the checkout has one. Under the base-revision rule those cases would silently lose their repository config and stop being comparable with earlier runs.

So evals keep the checkout's policy, explicitly: `eval-runner` reads it with `readWorkingTreePolicy(repoRoot)`, applies the config layer itself as it does today, and passes the policy to `runReview` through `overrides.repositoryPolicy`. This is the only caller of the working-tree reader. It is not reachable from the CLI or the Action.

If an eval checkout names no base and the case supplies no explicit base, branch resolution uses the existing `master`/`main` fallback without the committed-policy redirect or advisory check.

### 3.9 Report line

When the diff adds, changes, deletes or renames a policy file, add one coverage reason next to `discloseSkillLoadFailures` (`review-runner.ts:1195-1209`):

`review policy files changed in this diff (<up to 5 paths>, +N more): this review used the policy from base <short sha>, so the changes did not apply`

With origin `none`: `... this review has no base revision and used default policy ...`. Coverage reasons are rendered and do not change the review's health status. This also delivers the report note the spec has promised.

## 4. Interfaces

```ts
// src/repo/repository-policy.ts (new)
export function isRepositoryPolicyPath(filePath: string): boolean;

export type RepositoryPolicyFile = { path: string; content: string }; // repository-relative path
export type RepositorySkillFile = RepositoryPolicyFile | { path: string; readError: string }; // readError only for eval disk reads

export type RepositoryPolicy = {
  origin: "base-revision" | "working-tree" | "none";
  revision?: string;                    // commit read from; only for "base-revision"
  config?: RepositoryPolicyFile;        // codegenie.toml; absent when the file is absent
  skillFiles: RepositorySkillFile[];    // .codegenie/skills/**/*.md, sorted by path
};

export async function readRepoConfigAt(git: InternalGitClient, revision: string): Promise<RepositoryPolicyFile | undefined>;
export async function readBaseRevisionPolicy(resolved: ResolvedReviewInput, git: InternalGitClient): Promise<RepositoryPolicy>;
export function readWorkingTreePolicy(repoRoot: string): RepositoryPolicy; // evals only
```

```ts
// src/config/config-loader.ts
export type RepoConfigText = { text: string; label: string }; // label names the source in error messages
export type LoadConfigOptions = {
  homeOverride?: string;
  env?: NodeJS.ProcessEnv;
  cli?: CliConfigOverrides;
  repoConfig?: RepoConfigText;          // replaces repoRoot and loadRepoConfig
};
export function parseRepoConfigText(repoConfig: RepoConfigText): RawCodegenieConfig; // TOML, credential-key check, schema
export function applyRepoConfigLayer(baseConfig: CodegenieConfig, repoConfig: RepoConfigText | undefined): { config: CodegenieConfig; warnings: ConfigWarning[] };
// filterRepoConfig: telemetry.enabled joins the ignored keys.
```

```ts
// src/skills/skill-loader.ts
export async function loadSkills(opts: {
  repoRoot: string;                        // only for the in-repository check on extra paths
  repoSkillFiles: RepositorySkillFile[];   // required; no disk discovery for repository skills
  extraSkillPaths: Array<string | ExtraSkillPathSpec>;
  logger: Logger;
  telemetry: TelemetryRecorder;
}): Promise<SkillLoadResult>;
// parseSkillFile(filePath, ...) splits into parseSkillText(raw, filePath, source, logger) plus a disk-reading wrapper.
```

```ts
// src/pipeline/review-runner.ts
type RunReviewOverrides = {
  // ...existing
  finalizeConfig?: (repoConfig: RepoConfigText | undefined) => { config: CodegenieConfig; warnings: ConfigWarning[] };
  repositoryPolicy?: RepositoryPolicy;   // supplied by evals and tests; otherwise read from the base revision
};
type RunContext = {
  // ...existing; budget becomes a getter
  adoptConfig(config: CodegenieConfig): void;
};
// BudgetLedger constructor gains an optional startedAt.
// RunTelemetry gains updateReviewMetadata(patch) for depth, budgetBoost and lenses.
// New stage 1 event: repository_policy_loaded { origin, revision, config: boolean, skillFiles: number }.
```

```ts
// src/types.ts
export type ParsedReviewCommand = {
  // ...existing; config, warnings and configSources now describe the config without the repository layer
  finalizeConfig: (repoConfig: RepoConfigText | undefined) => { config: CodegenieConfig; warnings: ConfigWarning[]; sources: Record<string, ConfigSource> };
};
```

Callers to update: `loadConfig` in `src/cli/review-command.ts:159-169`, `src/evals/eval-command.ts:34-39`, `src/provider/provider-services.ts:930-937`; `loadSkills` in `review-runner.ts:785,815`; `applyRepoConfigLayer` in `eval-runner.ts:479,557`; the two predicates in `file-classifier.ts:358` and `planner.ts:1694`. Tests: 22 `loadConfig` calls in `tests/config-loader.test.ts`, about 22 `loadSkills` calls in 9 files.

## 5. Error cases

| Situation | Result |
|---|---|
| `codegenie.toml` absent at base | No repository layer |
| `codegenie.toml` at base does not parse, fails the schema, or has a credential-like key | `config_error` in stage 1, as today but inside the run. The label names the base commit |
| `codegenie.toml` at base is a symlink or not a file | `config_error` |
| Skill file at base invalid | Existing skill-load failure, disclosed in the report |
| Base is the empty tree or undefined | Origin `none`, default policy |
| Base tree unreadable | `git_ref_missing`, run fails in stage 1 |
| Default branch's file names a base that does not resolve | `git_base_branch_unresolved` |
| Reviewed branch's file names a different base than the one chosen | `git_base_branch_unresolved` with the `--base` hint |
| Extra skill path inside the repository | Loaded, with a warning and a telemetry event |

## 6. Rejected alternatives

- **Policy from the merge base.** Lets the branch author pick an older policy by choosing the fork point, and would change the Action's behaviour.
- **Find the base before the run starts, then load config once.** Pull request mode needs a GitHub call and a fetch to know the base, and that work emits telemetry and registers cleanup that belong to the run. Doing it twice, or before the run exists, costs more than adopting the config after stage 1.
- **Apply the repository layer onto the finished config by consulting the recorded sources.** A second merge implementation that can drift from `loadConfig`.
- **Keep reading `git.baseBranch` from the working tree.** No migration cost, but the reviewed branch would keep choosing the commit its diff and its policy are measured against, which is the hole this ticket closes.
- **Drop repository-level `git.baseBranch`.** Simplest, but repositories with a separate integration branch would be reviewed against `master` without warning.
- **Fall back to the reviewed commit's policy when there is no base.** Reopens the hole for a root commit or an orphan branch.
- **Refuse extra skill paths inside the repository.** Narrower than the owner's decision that these paths stay outside the rule; a warning states the fact without breaking anyone.
- **Evals read policy from the case's base.** Changes the config of historical cases and breaks comparison with earlier runs.

## 7. Steps and proving tests

All steps are one pull request; steps 2 to 4 change signatures together.

1. **`src/repo/repository-policy.ts`, and replace the two predicates with `isRepositoryPolicyPath`.**
   New `tests/repository-policy.test.ts` with `initRepo`, `writeRepoFile`, `commitAll` (`tests/helpers/git.ts`): reads the file and nested skills at a commit; ignores non-`.md` files; uncommitted edits and later commits are not visible; empty tree gives origin `none`; absent files give no config and no skills; a symlinked `codegenie.toml` is a `config_error`; an unknown revision rejects with `git_ref_missing`. Existing classifier and planner policy tests pass unchanged.
2. **`config-loader.ts`: text-based repository layer, `telemetry.enabled` ignored.**
   `tests/config-loader.test.ts`: repository text sits above user config and below environment and CLI; a `codegenie.toml` on disk is not read; a credential-like key fails with the label in the message; `telemetry.enabled` produces the ignored-key warning.
3. **`skill-loader.ts`: `repoSkillFiles`, in-repository warning.**
   `tests/phase4-skills-provider.test.ts`: supplied files load with source `repo` and a relative path; a skill file on disk under `<repoRoot>/.codegenie/skills` is not loaded; duplicate id against a bundled skill loses; an extra path inside the repository loads and emits the event; one outside does not.
4. **`review-runner.ts`, `review-command.ts`, `eval-runner.ts`: read the policy after resolution, adopt the config, pass skills.**
   `tests/pipeline-phase5.test.ts`, fake runner:
   - Rewrite the test at 10380: the uncommitted bad skill no longer appears in the report. Add its mirror: the bad skill committed on the base and deleted on the branch does appear. These two prove the acceptance criterion without inspecting prompts.
   - Base file sets `review.depth = "deep"` and `review.maxTime`; the branch deletes the file; `run.json` records depth `deep` and the budget summary shows the base's time limit. The reverse (branch adds them) leaves defaults.
   - CLI `--max-time` still wins over the base file.
   - Pull request mode with an injected GitHub client and the working tree checked out at the pull request head: the base policy is used.
   - Root commit that adds both policy files: `repository_policy_loaded` has origin `none`; defaults apply.
   `tests/review-command.test.ts` and `review-command-phase2.test.ts`: parsing no longer applies the repository file; `parsed.finalizeConfig` reports source `repo-config`; the ignored-key warning is emitted as a `config_warning` event after stage 1.
   `tests/evals.test.ts:2201` passes unchanged; add one assertion that the checkout's skill files reach the review.
5. **`review-input-resolver.ts`: base selection.**
   `tests/review-input-resolver.test.ts`: `master`'s file names `develop`, so the base is `develop`; `develop`'s file naming a third branch is not followed; the reviewed branch names another base and `master` does not, so the run rejects and the message contains `--base`; with `--base` or user config there is no rejection; `master`'s file names a missing branch, so the run rejects; a reviewed-branch file that does not parse is ignored.
6. **Report line.** `tests/pipeline-phase5.test.ts`: a branch that edits a skill and `codegenie.toml` produces the line with both paths and the base short sha; a branch that touches neither does not.
7. **Docs and specs.** `README.md:108,215` and the comment at `examples/workflows/codegenie-review.yml:7`: policy comes from the base commit whatever is checked out; editing a skill in a branch does not affect that branch's review; `git.baseBranch` rules; `telemetry.enabled` is user-level. Add plan 126 to the table in `specs/plans/README.md`. Specs now stale: `specs/project/functional_spec.md:67,1013`, `specs/project/architecture.md:1915`, `specs/project/components/skills_llm_telemetry.md:78`, `specs/project/components/repository_and_github.md:558`.
8. **Verify.** `pnpm check`, `pnpm test`, `pnpm build`. Smoke with `node dist/cli/main.js review` and a scratch `CODEGENIE_HOME` on a throwaway repository with the fake provider: a branch that adds a skill and a config file is reviewed with neither. No paid calls.

## 8. Risks and verification gaps

- **A broken `codegenie.toml` on the base fails every review, including the review of the change that fixes it.** Today a broken working-tree file fails the same way. Kept, because silently dropping a repository's path rules is worse; the fix merges without a codegenie review.
- **A skill or config edit cannot be tried on its own branch.** Accepted by the owner. The report line makes it visible. Evals remain the way to test a policy change.
- **Repositories with neither `master` nor `main`** need `--base` or user config for local branch reviews. Reading the remote's default branch would remove that; it is new behaviour and left out.
- **`adoptConfig` replaces the ledger.** Safe only while stage 1 records no usage; the developer should assert that in `adoptConfig`.
- **Not verified:** whether any user relies on repository-level `telemetry.enabled`; how many repositories name a base branch other than `master`/`main` only in a branch's file; shallow-clone behaviour beyond the existing resolver tests.
- **Out of scope, found on the way:** `GitClient.lsTree(ref, glob)` builds a pathspec `git ls-tree` rejects (`src/git/git-client.ts:107-116`); it has no caller that passes a glob. The `repo-config` branch of `ExtraSkillPathSpec` has no production caller (`skill-loader.ts:38,122`).

## 9. Decisions

Approved by the operator on 2026-11-20.

1. Policy comes from the base tip (`baseRef`), not the merge base.
2. Base selection follows 3.5. This changes behaviour for local branch reviews in repositories that name their base only in the branch's own file, or that have neither `master` nor `main`: both get an error that names `--base`. The pull request description must call this out.
3. `telemetry.enabled` is no longer settable from repository config. The pull request description must call this out.
4. Evals keep the checkout's policy through an override that only the eval runner uses, so the #112 baseline is unaffected.
5. A base `codegenie.toml` that does not parse fails the review.
