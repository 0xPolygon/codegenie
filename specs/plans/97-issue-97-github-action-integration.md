# Issue 97: GitHub Action Integration — Comment-Triggered PR Review with a Live Status Comment

Status: PENDING
Planned from: owner request 2026-07-22 (run codegenie from GitHub: on PR open/update and/or on a "codegenie review" PR comment; post a "Reviewing ..." status comment that live-updates through stages and finishes as the markdown report). Informed by a primary-source study of `anthropics/claude-code-action` (§Study below).
Planned at: commit `eb020da` (branch `next`)
Recommended priority: first outward-facing distribution surface. Independent of the measurement campaign — zero model-facing or pipeline behavior change; new trigger + publisher surface only, so it cannot muddy an A/B.

## Problem

codegenie can already review a GitHub PR (`codegenie review --pr <n>`) and post a sanitized inline review (`--post-github-comments`), but only when a human runs the CLI locally with `gh` authenticated. There is no way to run codegenie *from* GitHub: no Action, no comment trigger, no on-PR-open automation, and no in-PR signal that a review is underway. Teams that want codegenie on every PR have no supported path, and the review's 10-50 minute runtime makes "silent until done" unacceptable UX in a PR thread.

## Goal

1. A reusable GitHub Action so a consuming repo enables codegenie with a few lines of workflow YAML plus provider credentials in secrets.
2. Two trigger lanes: automatic (`pull_request` opened/synchronize) and explicit command (`issue_comment` matching a trigger phrase, default `codegenie review`), both gated by author association.
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

### 1. Entry point: `codegenie github-action` subcommand, thin composite action

All GitHub-event logic lives in the codegenie codebase (testable), not in YAML/bash — consistent with "the harness owns the workflow" (architecture.md:18). A new `codegenie github-action` subcommand:

- Reads standard Actions env: `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH` (payload JSON), `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, plus `GH_TOKEN`.
- Decides run/skip: event type supported? trigger phrase matched (for `issue_comment`)? author association allowed? PR resolvable? Skips exit `0` with a one-line reason on stdout and a `github_action_skipped` telemetry event — a non-matching comment must not fail the check.
- Resolves the PR number from the payload (`pull_request.number`, or the `issue_comment` issue number after verifying the issue *is* a PR).
- Invokes the existing review path (`executeReviewCommand` internals) with `mode: "github_pr"`, status-comment posting on, inline posting per input, and CI-lane progress (spinner already self-disables under `CI`, review-progress.ts:80).

The composite action (`action.yml` in this repo, consumed as `0xPolygon/codegenie@<tag>`) only: sets up Node, installs the pinned codegenie version matching the action tag, and runs `codegenie github-action`. Consumers provide checkout (`fetch-depth: 0`) before it.

Trigger matching rule: trimmed comment body must equal the trigger phrase or start with `<phrase>` followed by whitespace/EOL. Trailing text is ignored in v1 — never parsed into flags (comment text is attacker-influenced; review knobs come only from workflow inputs). Comment-driven options are a Future Consideration with an allowlisted grammar if ever wanted.

### 2. Authorization gate

- Default allowed author associations: `OWNER`, `MEMBER`, `COLLABORATOR` — checked from the event payload, then re-verified live via `gh api repos/{owner}/{repo}/collaborators/{login}/permission` (payload fields are attacker-visible history; the live check is authoritative). Requires write permission or better.
- Action inputs `allowed-associations` and `allowed-users` widen this explicitly; docs flag the risk plainly (copying their `allowed_non_write_users` posture). Bot comments are ignored unless allowlisted.
- `pull_request` lane on fork PRs: secrets are absent by GitHub's design → provider auth fails. Detect this precondition (no provider credentials + fork head repo) and skip with a clear reason *before* any model spend; never fall back to `pull_request_target`. Fork PRs get reviewed via the comment lane (base-repo context, write-gated).

### 3. Sticky status comment

New module `src/github/status-comment.ts` + two client methods (issue-comment create/update via `gh api`):

- **Claim:** find the newest own comment on the PR carrying the status marker (an HTML-comment marker à la the existing finding markers, parsed with the same author-verified rule: marker AND author == our login). Found → reclaim and overwrite (a rerun or a dangling "Reviewing ..." from a cancelled job gets superseded naturally); absent → create. One status comment per PR, ever.
- **Progress rendering:** deterministic template — header line (`**codegenie** is reviewing this PR ...`), stage checklist from `STAGE_LABELS` (☑ done / ▸ current / ☐ pending) driven by `stage_started`/`stage_completed` events through the existing `onTelemetryEvent` seam, footer with the Actions run link. Zero model involvement.
- **Throttle:** stage boundaries only, coalesced with a minimum edit interval (default 10s; latest state wins) — ≤ ~13 PATCH calls per run. A failed progress edit logs + counts in telemetry and never fails the review; edits stop after N consecutive failures (default 3) and the run continues headless.
- **Terminal edit (always attempted, even on failure paths):**
  - Success → the comment becomes the sanitized markdown report (same renderer as stdout), with coverage/partial disclosure appended per existing publisher rules. If the body exceeds the issue-comment cap (65,536 chars), truncate at a section boundary with a disclosure line + link to the run (the full report is also written to `GITHUB_STEP_SUMMARY` and uploaded as a run artifact by the action wrapper).
  - Review failure → short failure state with error class + run link; process still exits nonzero per existing exit-code semantics.
  - The terminal edit failing IS a posting failure → `github_post_failed`, nonzero (the report still reaches logs/step summary).
- **Sanitization ordering:** body passes `sanitizeGitHubCommentBody` (mentions neutralized — the report can't ping people; HTML comments stripped; secrets scrubbed), *then* the status marker is appended — same order the finding-marker path uses, so the marker survives its own sanitizer.
- **Spec carve-out:** repository_and_github.md's "v1 never updates or deletes comments" rule stays for *finding* comments; the status comment is defined as a distinct, explicitly-mutable comment class with exactly-one-per-PR semantics. Inline findings remain immutable and duplicate-suppressed.

### 4. Identity under installation tokens

`listOwnComments` and marker verification key off `viewerLogin` from `gh api user` — which fails for Actions installation tokens (`GITHUB_TOKEN` is an app token; `/user` has no user context). Fix inside the client: after creating (or claiming) the status comment, read back its author login and cache that as the viewer identity for the run (works for `github-actions[bot]`, custom app bots, and PATs alike, no config needed). `gh api user` remains the fast path when it succeeds.

### 5. Posting enablement stays CLI/workflow-side

`--github-status-comment` (requires `--pr`) joins `--post-github-comments` as CLI-only flags that repo config cannot set — the Trust Boundaries rule is unchanged: workflow YAML (repo-admin-controlled) enables posting; `codegenie.toml` and PR content cannot. `codegenie github-action` maps action inputs → these flags. Action inputs (v1): `trigger-phrase`, `on-pull-request` (bool, default true), `allowed-associations`, `allowed-users`, `post-inline-comments` (bool, default true), `depth`, `lenses`, `provider`, `model`, `reasoning`, `max-time`, `budget-boost`. Provider credentials via env from secrets, exactly as the CLI expects today.

### 6. Concurrency and cancellation

Template workflows set `concurrency: codegenie-review-pr-${{ github.event.pull_request.number || github.event.issue.number }}` with `cancel-in-progress: true` — a force-push mid-review cancels the stale run; the replacement run reclaims the sticky comment, so no dangling "Reviewing ..." persists past the next run. A cancelled-with-no-successor dangling comment is accepted v1 residue (the run link beside it shows "cancelled"); a `finally`-style terminal edit inside the action wrapper is a cheap later hardening.

### 7. Telemetry

- `github_action` record in run artifacts: event name, lane, trigger decision, association-check outcome, skip reason.
- `github_status_comment` events: created/claimed (comment id), edit count, throttled count, edit failures, terminal state, final body bytes (pre/post cap).
- Existing `github-posting.json` unchanged for the inline lane.

## Non-Goals

- `--fail-on <severity>` CI thresholds — the functional spec keeps findings-exit-0 for v1; an Action makes the demand real, so note it as the follow-up plan, but do not bundle it here.
- Conversational follow-ups (replying to the bot, re-running with different options via comment text) and human review-thread reading — the deferred human-thread work stays deferred.
- codegenie writing code, commits, or fix suggestions as commits — review only, so commit signing and branch push machinery are out of scope entirely.
- OIDC federation for model-provider credentials (their Bedrock/Vertex lane) — provider auth stays secrets-based env vars in v1; record as a Future Consideration.
- Marketplace listing polish, `/install-github-app`-style one-click setup, GitLab/Gitea.

## In-Scope Files

- `src/cli/main.ts`, `src/cli/review-command.ts` — `codegenie github-action` subcommand; `--github-status-comment` flag; event-payload parsing + trigger/authorization decision (pure functions over the payload JSON for testability).
- `src/github/github-client.ts` — `createIssueComment`, `updateIssueComment`, `getIssueComment` (author read-back); viewer-identity fallback (§4); permission-check call.
- `src/github/status-comment.ts` (new) — marker, claim/create, checklist rendering, throttle, terminal states.
- `src/github/publisher.ts` — final-report handoff to the status comment; ordering with the inline-review post (inline review first, then terminal status edit referencing it).
- `src/github/duplicate-detector.ts` — status-comment marker parse (or a sibling marker helper; findings markers untouched).
- `src/config/schema.ts` — nothing that enables posting; only cosmetic additions if needed (none expected v1).
- `action.yml` (new, repo root) + `examples/workflows/` (two templates: PR-open lane, comment lane) + README section.
- `specs/project/components/repository_and_github.md`, `functional_spec.md`, `project_overview.md` — status-comment carve-out, action mode, trigger authorization, comment-text-is-data trust rule.
- Tests: trigger/gate decision tables over fixture payloads; status-comment lifecycle against the fake gh client (create → N throttled edits → final; error → terminal state; rerun → reclaim; edit-failure → headless continue); marker-survives-sanitizer; identity read-back fallback; cap/truncation boundary.

## Implementation Steps

1. Client methods + identity read-back fallback (§4) against the fake `runGh` — no behavior change for existing lanes.
2. `status-comment.ts` lifecycle + throttle + terminal states, driven purely by injected telemetry events; unit-test the full state machine.
3. `codegenie github-action` subcommand: payload parsing, trigger match, association gate (payload + live re-check), skip semantics; wire to the review path with status comment + CI progress.
4. Publisher ordering: inline review post → terminal status edit; cap/truncation + step-summary/artifact fallbacks.
5. `action.yml` + example workflows + docs (permissions block, secrets, `fetch-depth: 0`, concurrency group, fork-PR guidance, cost note).
6. Spec updates (carve-out + action mode + trust-rule extension).
7. Dogfood: enable both lanes on this repo; run against a real PR (e.g., the next plan's PR) before advertising anywhere.

## Validation

- Unit: decision tables (event × trigger phrase × association × fork/secret presence → run/skip+reason); status-comment state machine incl. throttle coalescing, edit-failure headless mode, reclaim-on-rerun, 65,536-char cap behavior.
- Integration (fake gh): full action run produces create → stage edits → final-report edit with marker, sanitized body, disclosure lines; failed review produces failure terminal state and nonzero exit; non-matching comment exits 0 posting nothing.
- Dogfood on this repo: one comment-triggered and one PR-open-triggered live run; confirm single sticky comment across a synchronize rerun, no duplicate inline findings (fingerprint suppression observed in `github-posting.json`), and GitHub API edit count matches telemetry.

## Done Criteria

- A consuming repo enables codegenie with the documented workflow + secrets; both lanes work; the status comment goes "Reviewing ..." → live stage checklist → final markdown report; reruns reclaim the comment and don't duplicate findings.
- No new path lets repo config, PR content, or comment text enable posting, widen tools, or reach the model as instructions.
- Existing local CLI behavior byte-identical when the new flag/subcommand is unused.

## Stop Conditions

- If in-place comment editing trips GitHub secondary rate limits / abuse detection during dogfooding, drop to three edit points (claim, midpoint, terminal) before building any queueing machinery.
- If `gh` proves unreliable under installation tokens in runners (auth-status preflight, api quirks), stop and make a deliberate client decision (direct REST with the token for the Actions lane) rather than patching around `gh` piecemeal.
- If the association live re-check adds meaningful latency or permission friction for legitimate users, reconsider payload-only checking as a documented tradeoff — do not silently widen the default allowlist.
