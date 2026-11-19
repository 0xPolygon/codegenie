# Factory

## Project

codegenie is an AI code review harness: a TypeScript CLI (published to npm as `@0xsequence/codegenie`) and a GitHub Action (`action.yml`) that review pull-request-style diffs. A staged pipeline puts deterministic code in charge of coverage, anchoring, verification, dedup, budgets and telemetry, and LLM agents do the judgment work in each stage. It is built on the pi AI library and tree-sitter. Its users are engineers and teams who run it locally or in CI.

Stack: Node, TypeScript, pnpm, vitest. `pnpm check` runs typecheck and workflow lint, `pnpm test` runs the tests, and `pnpm build` builds `dist/`. Smoke-test the CLI with `node dist/cli/main.js` and a scratch `CODEGENIE_HOME`. Running it under tsx can fail in a sandbox. The code is the source of truth: when a spec disagrees with the code, report whether the spec is stale, the code has a bug, or a decision is needed.

## Tasks

Tasks and bugs are GitHub Issues on 0xPolygon/codegenie, managed with `todos`; the board is 0xPolygon/41, with columns Backlog, Todo, In progress and Done. Run from the checkout. Learn it once with `todos skill`; agent operations always pass `--json`.

Only a person moves an issue into Todo. That column means the operator may assign it without asking; it is not an assignment to a member. Assigned work moves to In progress, and integrated work moves to Done. New issues go to Backlog (`todos add ... --status Backlog`); only @pm reorders the Backlog.

@pm owns tracker writes, or the operator when there is no @pm. Members report discoveries to that owner, who records them in Backlog. Record owner, criteria, branch or commit, verdict and next step on the issue.

Check the board with `todos board --json`; pass `--project 0xPolygon/41` if it shows another. Check failures with `todos doctor --json`; reconcile an uncertain write before retrying. Never run `todos rm`; close instead, after confirmed integration. Link the PR and close only after its merge is confirmed.

## Specs

Specs follow the spec skill (spec-driven development). The project spec is in `specs/project/` (overview, functional spec, architecture, implementation plan). Per-issue plans are `specs/plans/<NN>-issue-<NN>-<slug>.md`, and review studies are in `specs/reviews/`. Learn the process from the `spec` skill. Check with `ls specs/project specs/plans`. Plans record intent at the time they were written: verify against the code before you rely on one.

## Workflow

1. The operator assigns tasks with acceptance criteria. Non-trivial changes get one design first, from an architect, written as a plan in `specs/plans/`; another architect or developer may challenge it. @pm records owner, criteria, branch or commit, verdict and next step on the issue.
2. Developers agree on shared interfaces before parallel work, implement, run `pnpm check` and `pnpm test`, then ask @reviewer for a review with the task, criteria and exact commit. They fix findings until approved. After three rounds on one task, the operator decides how to go on.
3. The operator reviews the result and integrates it through a pull request (see Pull requests).
4. Each developer works in its own worktree, one ticket per branch. Parallel tickets are fine when their files do not collide; the operator sequences the ones that do.

## Review

Reviews start in the fast lane. Deep lane: @reviewer runs codegenie at pull-request readiness on the committed head against its base.
Learn it with `codegenie review --help`; check it with `codegenie --help`.
Run `codegenie review --no-progress --base <base sha> --head <head sha>`.
Its report is input, not the verdict: verify findings, cover anything skipped, and name the lane and tool coverage in the verdict. A run can take up to 30 minutes. Never pass `--post-github-comments` or anything else that publishes.
In a shared checkout, review uncommitted work in the fast lane first; the operator commits before deep review. Do not make a developer commit just to satisfy the tool.

## Pull requests

Work reaches master only through a pull request on GitHub, repository 0xPolygon/codegenie. Ticket branches are `<user>/<ticket>`; the team merges only by squash merge. CI: GitHub Actions `CI` (check, test, build) and `codegenie review` (an automated review of the PR, whose verified findings count as open findings). The task record links its PR and closes only after a confirmed merge.
Run from the checkout. Learn the commands with `gh pr --help`; check access with `gh auth status`.

The team may push ticket branches and open or update pull requests.

- Push/open/update: `git push -u origin <branch>`; `gh pr create --base master --head <branch>`; later pushes update the PR.
- Wait for checks: `timeout 900 gh pr checks <branch> --watch --interval 60`. Fit the command limit to the harness; restart the watcher if it times out with checks pending.
- Read head/checks/mergeability: `gh pr view <branch> --json state,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup`; comments/reviews: `gh pr view <branch> --comments`.
- Review threads: `gh api graphql --paginate --slurp -F owner=0xPolygon -F repo=codegenie -F number=<pr> -f query='query($owner:String!,$repo:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid reviewThreads(first:100,after:$endCursor){nodes{id isResolved isOutdated path line comments(first:1){nodes{url}}} pageInfo{hasNextPage endCursor}}}}}'`. An unresolved thread has `isResolved` false; read its linked discussion.
- Merge, only with permission and a ready head: `gh pr merge <branch> --squash --match-head-commit <sha>`. Confirm with the state command; a queued merge is not yet merged. Never force-push.

## Notes

Enabled in `notes/`: `activity/` (the team's working notes), `research/` (findings the owner asked for), `discussions/` (records of meetings and their decisions). Follow the factory notes convention; search with rg. `notes/private/` holds each person's own notes, ignored by Git. That person's team may read and search it, under the private-folder rule of the notes convention.
