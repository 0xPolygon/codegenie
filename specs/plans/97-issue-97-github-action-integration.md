# Issue 97: GitHub Action Integration — Comment-Triggered PR Review with a Live Status Comment

Status: IMPLEMENTED (2026-07-22) — dogfood pending (step 7: enable both lanes on this repo against a real PR)
Implementation notes: `src/github-action/` (entrypoint, event-gate, status-comment, issue-comments, render, marker) + `action.yml` + `examples/workflows/`; shared-code touches are the CLI dispatch, guarded viewer-login fallback, provider API-key env-name export, and the review command's run-attachment observer. No new review flags — inline posting rides `--post-github-comments` in the synthesized argv. Trigger lanes, authoritative preflight/live permission gate, fork skip, throttled status-comment edits, terminal report with 65,536-char cap + step-summary/artifact fallbacks, and optional module-owned `github-action.json` telemetry all landed per Design; the focused suite now includes workflow, adapter, identity, and coalescer contract coverage.
Amendment (2026-07-22, owner request): single `model` input as `provider/model[:reasoning]` (reasoning defaults `high`) replacing separate provider/model/reasoning inputs, plus a provider-generic `LLM_API_KEY` routed to the named provider's env var. The routing needs the provider→env-var map, so a THIRD harness touch is authorized: `getPiApiKeyEnvVarName` export in `src/provider/pi-ai-models.ts` (~8 lines; duplicating the map in the module would drift). Native provider env vars keep working and take precedence.
Amendment 2 (2026-07-22, from an owner-run cross-model review, gpt-5.6-codex): five fixes applied — (1) the terminal comment/step-summary/artifact now carry the FULL report via `renderMarkdownReview` returned from `defaultRunReview` (`reportMarkdown`); with inline posting on, stdout is the short posting summary and now passes through to the CI log only — fallback copies land BEFORE the terminal PATCH; (2) an initial coarse job-level YAML gate was added, but this proved non-authoritative and is superseded by Amendment 3; (3) status-comment reclaim requires an exact case-insensitive author match against a resolved identity (`bot-login` input → `/user` lookup → `github-actions[bot]`), replacing the spoofable `[bot]`-suffix rule; the create read-back still cross-checks the injected duplicate-detection identity; (4) `pull_request`-lane checkouts pin the trusted BASE revision (config/skills cannot be rewritten by the PR under review; the head is fetched by `--pr` as data) — this retires the "reviewed by the codegenie it contains" dogfood property in favor of the spec's trust model; (5) trailing-edge coalescing (throttled updates flush when the interval elapses instead of dropping) + nonfatal edit failures logged to the CI log. Release-order note: publish npm before pushing the matching action tag. Rejected from the same review: forcing telemetry on for Actions (stays off by default; `github-action.json` is written only when telemetry is enabled and a run dir exists) and committing `dist/` for SHA-pinned execution (future consideration).
Amendment 3 (2026-07-22, deep-review fixes): the coarse YAML gate from Amendment 2 was not authoritative and is superseded. Every template now has a non-cancellable preflight job that invokes the same TypeScript trigger matcher and live permission check as the Action; only its `should-run`/`pr-number` outputs admit the downstream job that owns concurrency. The adapter also sanitizes the step-summary surface, makes terminal states absorbing, avoids polling during slow PATCHes, captures telemetry run attachment for failed lifecycles, and emits the bounded lifecycle record to the CI log even when telemetry persistence is off. Telemetry remains disabled by default.
Planned from: owner request 2026-07-22 (run codegenie from GitHub: on PR open/update and/or on a "codegenie review" PR comment; post a "Reviewing ..." status comment that live-updates through stages and finishes as the markdown report). Informed by a primary-source study of `anthropics/claude-code-action` (§Study below).
Planned at: commit `eb020da` (branch `next`)
Recommended priority: first outward-facing distribution surface. Independent of the measurement campaign — zero model-facing or pipeline behavior change; new trigger + publisher surface only, so it cannot muddy an A/B.

## Problem

codegenie can already review a GitHub PR (`codegenie review --pr <n>`) and post a sanitized inline review (`--post-github-comments`), but only when a human runs the CLI locally with `gh` authenticated. There is no way to run codegenie *from* GitHub: no Action, no comment trigger, no on-PR-open automation, and no in-PR signal that a review is underway. Teams that want codegenie on every PR have no supported path, and the review's 10-50 minute runtime makes "silent until done" unacceptable UX in a PR thread.

## Goal

1. A reusable GitHub Action so a consuming repo enables codegenie with a few lines of workflow YAML plus provider credentials in secrets.
2. Two trigger lanes: automatic (`pull_request` opened/synchronize/ready_for_review) and explicit command (`issue_comment` matching a trigger phrase, default `codegenie review`), both gated by author association and the live permission check.
3. A single sticky status comment: posted immediately ("Reviewing ..."), edited in place with a deterministic stage checklist as the run progresses, and finished by editing it into the final markdown report (or a capped summary + links when the report exceeds comment limits).
4. Reruns on new pushes stay clean: the same status comment is reclaimed, and the existing fingerprint-based duplicate suppression keeps inline findings from re-spamming.

## Study: claude-code-action (what we learned)

Primary sources: the action repo (`docs/security.md`, `docs/setup.md`, `docs/configuration.md`, migration guide), code.claude.com/docs/en/github-actions, the code-review plugin, and the issue tracker. Key facts:

- **Triggers:** `issue_comment`, `pull_request_review_comment`, `pull_request`, `issues`, `workflow_dispatch`. Default trigger phrase `@claude` (exact substring, configurable via `trigger_phrase`). v1.0 (Aug 2025) removed the explicit `mode:` input — mode is auto-detected (`prompt` provided on a non-comment event → automation mode; otherwise mention-triggered interactive mode).
- **Tracking comment:** with `track_progress: true`, it posts an "in progress" comment with a checklist, edits it in place as work proceeds, and on completion replaces it with a final summary ("Claude finished @user's task in Xm Ys", checklist, output, branch/run links).
- **Review posting:** the code-review flavor posts inline diff comments through a built-in GitHub MCP server (`mcp__github_inline_comment__create_inline_comment`) — i.e., *the model holds the posting tools* and decides when to call them; a confidence threshold (default 80) filters findings.
- **Auth:** official Claude GitHub App (Contents/Issues/PRs read-write) installed via `/install-github-app`, or a custom GitHub App with `actions/create-github-app-token`; model credentials via `ANTHROPIC_API_KEY`/OAuth token secrets or OIDC federation to Bedrock/Vertex. Minimum workflow permissions: `contents: write, pull-requests: write, issues: write` (+ `id-token: write` for OIDC).
- **Security gates:** trigger requires write access by default; non-write users and bots need explicit allowlists (`allowed_non_write_users`, `allowed_bots`; `'*'` documented as high-risk). Docs steer users to `pull_request` (not `pull_request_target`) so fork code never runs with secrets. Untrusted GitHub content is scrubbed (HTML comments, invisible Unicode) and subprocess environments get best-effort secret scrubbing — explicitly documented as not foolproof. A June 2026 Microsoft advisory showed pre-2.1.128 versions leaking runner secrets via `/proc` when processing untrusted content.
- **Architecture:** composite action, Bun runtime, phases: prepare (auth, permission validation, trigger check, initial comment) → install CLI → execute → cleanup (final comment, step summary, credential revocation). A separate minimal `base-action` layer exists for reuse.
- **Known friction (their issue tracker):** `use_sticky_comment` silently ignored in agent mode (#1108, #960 — a mode-matrix bug class); `pull_request`-triggered runs can't reliably post general PR comments, only inline ones (#1071); users ask to keep the progress comment instead of a separate final summary (#1016); shallow clones break history-dependent work (docs recommend `fetch-depth: 0`); no built-in spend limiter beyond `--max-turns`.

### What we copy

- Trigger-phrase design: exact substring match, configurable, never interpreted as instructions.
- Write-access gate by default with an explicit, documented allowlist escape hatch; `pull_request` over `pull_request_target`; fork-PR stance (secrets never reach fork-controlled code; the comment lane, which runs in base-repo context, is the supported path for reviewing fork PRs).
- Sticky comment lifecycle (immediate post → in-place edits → terminal state) and run/branch links in it.
- Composite-action packaging with a thin wrapper; job-level `timeout-minutes`; documented minimal `permissions:` block; `fetch-depth: 0` in templates.
- Custom-GitHub-App option for bot branding/enterprise policy, via `actions/create-github-app-token`.
- Cost transparency in docs (Actions minutes + provider tokens).

### What we deliberately do better

1. **The model never holds posting tools.** In claude-code-action, posting is a model-invoked MCP tool, so prompt-injected review content can in principle steer posting. In codegenie, posting is deterministic harness code downstream of the pipeline; reviewed content is data end-to-end (architecture.md Trust Boundaries). This is our strongest structural advantage — the plan must not erode it (no "let the model draft the comment update" shortcuts).
2. **No mode matrix.** codegenie's action does exactly one thing — review a PR — so there is no tag/agent mode detection and no `#1108`-class "input silently ignored in the other mode" bugs. Every input works in both trigger lanes or is rejected loudly at startup.
3. **Deterministic progress checklist.** Their checklist is model-managed. Ours renders mechanically from the existing `stage_started`/`stage_completed` telemetry and canonical `STAGE_LABELS` — it cannot lie, stall, or skip stages, and costs zero tokens.
4. **The report lands in the status comment** (what their #1016 users ask for): one comment from "Reviewing ..." to final report; no tracking-comment→summary-comment swap.
5. **Rerun hygiene built in.** Fingerprint-marker duplicate suppression already prevents re-posting the same inline findings on synchronize; claude-code-action has no equivalent for review findings.
6. **Honest partials.** Budget stops and coverage disclosure (`completed_partial`, reviewed/skipped hunk counts) render into the final comment — a degraded run says so instead of looking complete.
7. **Bounded spend by construction** — `maxBudgetTokens` / `--max-time` are real budget machinery, not a turn cap.

## Design

### 1. Isolation: one adapter module, near-zero harness diff

The GitHub Action surface is an *adapter around* the harness, not part of it. All new code lives in a single self-contained module:

```
src/github-action/
  entrypoint.ts       # the `codegenie github-action` subcommand body: env/payload → decision → orchestrate
  event-gate.ts       # pure decision functions: event × trigger phrase × association → run | skip(reason)
  status-comment.ts   # sticky-comment state machine (claim/create → throttled edits → terminal states)
  issue-comments.ts   # issue-comment CRUD over the existing `runGh` primitive (the shared client is PR-review-scoped; comment CRUD stays here)
  render.ts           # checklist + terminal-body templates (imports STAGE_LABELS from src/review-stages.ts)
  marker.ts           # status-comment marker (sibling of, not a change to, the findings marker)
```

The module drives the review exclusively through seams that already exist: it synthesizes a review invocation (`review --pr <n> [--post-github-comments] ...` argv → `parseReviewCommand`/`executeReviewCommand`), subscribes to `stage_started`/`stage_completed` via the existing `onTelemetryEvent` hook for progress, and renders the terminal report itself via `renderMarkdownReview(result.review)` — NOT from the stdout capture: with inline posting enabled, stdout carries the short posting summary, which the adapter passes through to the CI log only (Amendment 2, fix 1). Nothing inside `src/pipeline/`, `src/github/publisher.ts`, or `src/output/` changes; the review path cannot tell whether an Action invoked it.

Approved touches to existing code:
1. `src/cli/main.ts` — dispatch the `github-action` subcommand to `src/github-action/entrypoint.ts`.
2. `src/github/github-client.ts` — a guarded viewer-identity fallback (§4): accept an injected login when `gh api user` fails. No other client changes; no new client methods.
3. `src/provider/pi-ai-models.ts` — export the provider→API-key-env lookup used by the single `model` / `llm-api-key` Action surface.
4. `src/cli/review-command.ts` — forward the existing run-start attachment so adapter lifecycle telemetry can be written after review failures.

GitHub-event logic stays in TypeScript (testable), not in YAML/bash — consistent with "the harness owns the workflow" (architecture.md:18). The `codegenie github-action` subcommand (implemented entirely in the module):

- Reads standard Actions env: `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH` (payload JSON), `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, plus `GH_TOKEN`.
- Decides run/skip: event type supported? trigger phrase matched (for `issue_comment`)? author association allowed? PR resolvable? Skips exit `0` with a one-line reason on stdout (the §7 skip record) — a non-matching comment must not fail the check.
- Resolves the PR number from the payload (`pull_request.number`, or the `issue_comment` issue number after verifying the issue *is* a PR).
- Invokes the existing review path via synthesized argv (`mode: "github_pr"` falls out of `--pr`), inline posting per input, CI-lane progress (spinner already self-disables under `CI`, review-progress.ts:80), while the module itself runs the status comment off the telemetry-event stream.

The composite action (`action.yml` in this repo, consumed as `0xPolygon/codegenie@<tag>`) only: sets up Node, installs the pinned codegenie version matching the action tag, and runs `codegenie github-action`. Consumers provide checkout (`fetch-depth: 0`) before it.

Trigger matching rule: trimmed comment body must equal the trigger phrase or start with `<phrase>` followed by whitespace/EOL. Trailing text is ignored in v1 — never parsed into flags (comment text is attacker-influenced; review knobs come only from workflow inputs). Comment-driven options are a Future Consideration with an allowlisted grammar if ever wanted.

### 2. Authorization gate

- Default allowed author associations: `OWNER`, `MEMBER`, `COLLABORATOR` — checked from the event payload, then re-verified live via `gh api repos/{owner}/{repo}/collaborators/{login}/permission` (payload fields are attacker-visible history; the live check is authoritative). Requires write permission or better.
- Action inputs `allowed-associations` and `allowed-users` widen this explicitly; docs flag the risk plainly (copying their `allowed_non_write_users` posture). Bot comments are ignored unless allowlisted.
- `pull_request` lane on fork PRs: secrets are absent by GitHub's design → provider auth fails. Detect this precondition (no provider credentials + fork head repo) and skip with a clear reason *before* any model spend; never fall back to `pull_request_target`. Fork PRs get reviewed via the comment lane (base-repo context, write-gated).

### 3. Sticky status comment

Module-internal (`status-comment.ts` + `issue-comments.ts` over `runGh`; the shared `src/github/` client is untouched):

- **Claim:** find the newest own comment on the PR carrying the status marker (an HTML-comment marker à la the existing finding markers). Ownership requires an exact case-insensitive author match against the resolved identity (§4) — no suffix heuristics, so a marker pasted by any user *or another app* is never adopted (Amendment 2, fix 3). Found → reclaim and overwrite (a rerun or a dangling "Reviewing ..." from a cancelled job gets superseded naturally); absent → create. One status comment per PR, ever.
- **Progress rendering:** deterministic template — header line (`**codegenie** is reviewing this PR ...`), stage checklist from `STAGE_LABELS` (☑ done / ▸ current / ☐ pending) driven by `stage_started`/`stage_completed` events through the existing `onTelemetryEvent` seam, footer with the Actions run link. Zero model involvement.
- **Throttle:** stage boundaries, coalesced with a minimum edit interval (default 10s) and a trailing-edge flush — a throttled update is deferred, not dropped, so the fast deterministic stages (1-4, all inside the first window) still render before the long planning stage instead of leaving the checklist stale (Amendment 2, fix 5). ≤ ~13 PATCH calls per run. A failed progress edit logs to the CI log + counts in stats and never fails the review; edits stop after N consecutive failures (default 3) and the run continues headless.
- **Terminal edit (always attempted, even on failure paths):**
  - Success → the comment becomes the sanitized full markdown report (`renderMarkdownReview`, which already carries the coverage/partial disclosure — the module adds nothing to it). If the body exceeds the issue-comment cap (65,536 chars), truncate at a section boundary with a disclosure line + link to the run. The `GITHUB_STEP_SUMMARY` and `CODEGENIE_REPORT_PATH` fallback copies are written BEFORE the terminal PATCH, so the report survives a failed edit (Amendment 2, fix 1).
  - Review failure → short failure state with error class + run link; process still exits nonzero per existing exit-code semantics.
  - The terminal edit failing IS a posting failure → `github_post_failed`, nonzero (the report still reaches logs/step summary).
- **Sanitization ordering:** body passes `sanitizeGitHubCommentBody` (mentions neutralized — the report can't ping people; HTML comments stripped; secrets scrubbed), *then* the status marker is appended — same order the finding-marker path uses, so the marker survives its own sanitizer.
- **Spec carve-out:** repository_and_github.md's "v1 never updates or deletes comments" rule stays for *finding* comments; the status comment is defined as a distinct, explicitly-mutable comment class with exactly-one-per-PR semantics. Inline findings remain immutable and duplicate-suppressed.

### 4. Identity under installation tokens

`listOwnComments` and marker verification key off `viewerLogin` from `gh api user` — which fails for Actions installation tokens (`GITHUB_TOKEN` is an app token; `/user` has no user context). Resolution lives in the module, in strict order (Amendment 2, fix 3): explicit `bot-login` action input (custom GitHub Apps, e.g. `my-app[bot]`) → `/user` lookup (PATs) → `github-actions[bot]` (the `GITHUB_TOKEN` default). That resolved login gates status-comment reclaim (exact case-insensitive match) and is injected into the run as `CODEGENIE_GITHUB_LOGIN` for duplicate detection — with one refinement: the author read back from a comment we just *created* is ground truth and wins over the resolved login, self-correcting a custom app whose workflow omitted `bot-login` (its reclaim degrades to create-per-run until the input is set; duplicate detection stays correct). The shared client's only change is the guarded fallback seam from §1: use the injected login when `gh api user` fails; `gh api user` remains the fast path when it succeeds.

### 5. Posting enablement stays CLI/workflow-side

No new flags on `codegenie review` — the status comment is enabled solely by running the `codegenie github-action` entrypoint, which only workflow YAML (repo-admin-controlled) invokes; inline posting rides the existing CLI-only `--post-github-comments` flag in the synthesized invocation. The Trust Boundaries rule is unchanged and now has an even smaller surface: repo config and PR content cannot enable posting because the review command itself gained no posting surface at all. `codegenie github-action` maps action inputs → the synthesized argv. Action inputs (v1): `trigger-phrase`, `on-pull-request` (bool, default true), `allowed-associations`, `allowed-users`, `post-inline-comments` (bool, default true), `depth`, `lenses`, `model` (`provider/model[:reasoning]`), `llm-api-key`, `max-time`, `budget-boost`, `github-token`, `bot-login`, and the workflow-orchestration input `preflight-only`. Provider-native credentials remain supported and take precedence over `llm-api-key`.

### 6. Concurrency, cancellation, and trusted checkout

Template workflows run an authoritative **preflight job** with no concurrency group. It invokes `codegenie github-action --preflight-only true`, using the same workflow-level trigger/authorization values as the review step, and returns `should-run` plus the resolved `pr-number` only after the TypeScript gate and live write-permission check pass. The downstream review job is gated on that output and alone owns `concurrency` (`codegenie-review-pr-<n>`, `cancel-in-progress: true`). Unauthorized comments, near-prefix phrases, draft/fork events, and read/triage collaborators therefore never enter the cancellable group; custom phrases, associations, and `allowed-users` retain the same semantics in both jobs. A force-push that passes preflight still cancels the stale run; the replacement reclaims the sticky comment.

Checkout pins the trusted BASE revision on the `pull_request` lane (`ref: github.event.pull_request.base.sha`); `issue_comment` workflows already run from the default branch by GitHub semantics (Amendment 2, fix 4). codegenie's config and skills therefore always load from trusted code, per the Trust Boundaries rule, while `--pr` review fetches the head as untrusted data. Same-repo write-access collaborators could edit workflows on their branch anyway, so this is defense-in-depth, not the primary gate.

### 7. Telemetry

- Telemetry stays off by default, including in Actions. Every gate decision is emitted as a bounded `github-action: decision` CI-log record. Once a review starts, its terminal `github-action: lifecycle` log record includes event/lane/PR/actor/association, allowlist/live-permission outcome, success or failure outcome, optional error code, run URL, and status-comment counters. `finalBodyBytesBeforeCap` and `finalBodyBytes` are exact UTF-8 byte counts of the full attempted terminal payload, including the status marker, before and after capping respectively; failure bodies use the same payload for both values.
- The same lifecycle object is written best-effort as `github-action.json` only when telemetry is enabled and the review attached a non-empty run directory. It covers success, review failure, and terminal-post failure; skip/preflight-only decisions have no review run directory and therefore remain log-only.
- Existing `github-posting.json` and recorder-owned artifacts unchanged.

## Non-Goals

- `--fail-on <severity>` CI thresholds — the functional spec keeps findings-exit-0 for v1; an Action makes the demand real, so note it as the follow-up plan, but do not bundle it here.
- Conversational follow-ups (replying to the bot, re-running with different options via comment text) and human review-thread reading — the deferred human-thread work stays deferred.
- codegenie writing code, commits, or fix suggestions as commits — review only, so commit signing and branch push machinery are out of scope entirely.
- OIDC federation for model-provider credentials (their Bedrock/Vertex lane) — provider auth stays secrets-based env vars in v1; record as a Future Consideration.
- Bundling `dist/` into the action so a SHA-pinned `uses:` also pins the executable (today it installs the npm version pinned at the tag) — real supply-chain consideration, wrong cost to pay via committed build output; revisit with release-artifact tooling.
- Marketplace listing polish, `/install-github-app`-style one-click setup, GitLab/Gitea.

## In-Scope Files

- `src/github-action/` (new, the whole feature): `entrypoint.ts`, `event-gate.ts`, `status-comment.ts`, `issue-comments.ts`, `render.ts`, `marker.ts` — per the §1 layout. Imports from the harness: `parseReviewCommand`/`executeReviewCommand`, `renderMarkdownReview`, `runGh`, `STAGE_LABELS`, the sanitizer/scrubber, `getPiApiKeyEnvVarName`, `CodegenieError`. Nothing in the harness imports from this module.
- `src/cli/main.ts` — subcommand dispatch line only.
- `src/github/github-client.ts` — guarded viewer-identity fallback seam only (§4). No new methods; comment CRUD lives in the module's `issue-comments.ts`.
- `src/cli/review-command.ts` — forward the run-start attachment observer only; `src/github/publisher.ts`, `src/github/duplicate-detector.ts`, `src/config/schema.ts`, everything under `src/pipeline/`, and output renderers remain unchanged.
- `action.yml` (new, repo root) + `examples/workflows/` (two templates: PR-open lane, comment lane) + README section. `scripts/check-workflows.sh`, package scripts, and Make targets make `actionlint` part of normal automated validation.
- `specs/project/components/repository_and_github.md`, `functional_spec.md`, `project_overview.md` — status-comment carve-out, action mode, trigger authorization, comment-text-is-data trust rule.
- Tests: trigger/gate decision tables over fixture payloads; status-comment lifecycle against the fake gh client (create → N throttled edits → final; error → terminal state; rerun → reclaim; edit-failure → headless continue); marker-survives-sanitizer; identity read-back fallback; cap/truncation boundary.

## Implementation Steps

1. Module scaffold: `issue-comments.ts` over the fake `runGh`; `event-gate.ts` pure decision functions with fixture payloads. Zero existing-code changes yet.
2. `status-comment.ts` + `render.ts` + `marker.ts`: lifecycle, throttle, terminal states, driven purely by injected telemetry events; unit-test the full state machine.
3. `entrypoint.ts` + the `main.ts` dispatch line: claim comment → identity read-back → synthesize review argv → run with `onTelemetryEvent` subscription → terminal edit (inline posting happens inside the run, so ordering falls out naturally); add the github-client fallback seam (§4) here, with a test proving existing lanes are byte-identical without the injection.
4. Terminal-body handling: cap/truncation at a section boundary + `GITHUB_STEP_SUMMARY` write + run-artifact upload in the action wrapper.
5. `action.yml` + example workflows + docs (permissions block, secrets, `fetch-depth: 0`, concurrency group, fork-PR guidance, cost note).
6. Spec updates (carve-out + action mode + trust-rule extension).
7. Dogfood: enable both lanes on this repo; run against a real PR (e.g., the next plan's PR) before advertising anywhere.

## Validation

- Unit: decision tables (event × trigger phrase × association × fork/secret presence → run/skip+reason); status-comment state machine incl. throttle coalescing, edit-failure headless mode, reclaim-on-rerun, 65,536-char cap behavior.
- Integration (fake gh): full action run produces create → stage edits → final-report edit with marker, sanitized body, disclosure lines; failed review produces failure terminal state and nonzero exit; non-matching comment exits 0 posting nothing; attempted report and failure terminal bodies retain honest pre/post-cap size telemetry even when their PATCH fails.
- Workflow: `pnpm run check:workflows` runs `actionlint` across dogfood and example workflows; `pnpm test` invokes the same check before Vitest.
- Dogfood on this repo: one comment-triggered and one PR-open-triggered live run; confirm single sticky comment across a synchronize rerun, no duplicate inline findings (fingerprint suppression observed in `github-posting.json`), and GitHub API edit count matches telemetry.

## Done Criteria

- A consuming repo enables codegenie with the documented workflow + secrets; both lanes work; the status comment goes "Reviewing ..." → live stage checklist → final markdown report; reruns reclaim the comment and don't duplicate findings.
- No new path lets repo config, PR content, or comment text enable posting, widen tools, or reach the model as instructions.
- Existing local CLI behavior byte-identical when the subcommand is unused.
- Isolation holds: shared changes are confined to the four approved seams listed in §1; all orchestration/state-machine code sits under `src/github-action/`, `action.yml`, and `examples/`; no harness module imports from `src/github-action/`.

## Stop Conditions

- If in-place comment editing trips GitHub secondary rate limits / abuse detection during dogfooding, drop to three edit points (claim, midpoint, terminal) before building any queueing machinery.
- If `gh` proves unreliable under installation tokens in runners (auth-status preflight, api quirks), stop and make a deliberate client decision (direct REST with the token for the Actions lane) rather than patching around `gh` piecemeal.
- If the association live re-check adds meaningful latency or permission friction for legitimate users, reconsider payload-only checking as a documented tradeoff — do not silently widen the default allowlist.
- Any further shared-module touch beyond the four approved seams requires another explicit plan amendment; orchestration remains adapter-owned.
