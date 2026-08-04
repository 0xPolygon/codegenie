# Issue 104: Delegate Mode — Run the Harness Without a Provider API Key

Status: PENDING
Planned from: owner request 2026-07-26, following a primary-source study of `alibaba/open-code-review` (§Study below), whose `ocr delegate` is the same idea in a much weaker form.
Planned at: commit `702be66` (branch `master`)
Recommended priority: highest-leverage distribution surface after Plan 97. It is the only feature that removes the "buy tokens before you can find out whether this is good" barrier, and it is the cheapest way to make the harness thesis legible: a delegated run and a local run must produce the same review, which proves the harness — not the model wrapper — is the product.

## Problem

Running codegenie requires a configured provider and a funded API key. Every developer who already pays for a Claude Max, ChatGPT Pro, or Cursor subscription is paying for frontier inference they cannot point at codegenie, and they must spend money before they can evaluate whether the review is worth it. The result is that the population who could try codegenie today is much smaller than the population who would benefit from it, and the barrier sits before the moment of value rather than after.

There is a second, subtler problem. codegenie's central claim is that the harness — coverage accounting, packet construction, independent verification, cross-packet composition — is what produces review quality, not the prompt and not the model. That claim is currently unfalsifiable from the outside: a skeptic sees a CLI that calls an LLM. If the same harness can drive *someone else's* agent and still produce the same guarantees, the claim becomes demonstrable rather than asserted.

## Goal

1. `codegenie delegate` runs every deterministic stage locally and hands each LLM stage's work to a host coding agent (Claude Code, Codex, Cursor, opencode) that executes it with its own subscription. No provider credential is required at any point.
2. A delegated run is subject to the identical typed contracts as a local run: the same submit schemas validate the host agent's output, the same verifier and composer stages consume it, the same coverage ledger and telemetry artifacts are written. Delegation changes *who runs inference*, never *what the harness guarantees*.
3. The protocol batches per stage, not per call, so a host agent that can fan out its own subagents (Claude Code's Task tool, Codex's parallelism) reviews twelve packets concurrently instead of serially. Round-trips are bounded by the number of LLM stages (4, occasionally 5), not by the number of packets and candidates (frequently 40+).
4. A delegated run and a local run over the same revision, given the same model responses, produce a byte-identical `ReviewResult` after identity normalization. This is the done-criterion that makes claim (2) real.

## Study: `alibaba/open-code-review` (what we learned)

Primary sources: the repository at `/home/peter/Dev/other/open-code-review`, read at the 25c3661 tip — `internal/agent/agent.go`, `internal/llmloop/`, `internal/delegate/`, `internal/config/rules/`, `README.md`, `ROADMAP.md`, `ASSURANCE_CASE.md`.

OCR ships `ocr delegate preview` / `ocr delegate rule <files>` today, with a fuller "subscription-friendly review" mode on the H2 2026 roadmap. What it actually delegates is thin:

- `internal/delegate/rulegroup.go` resolves each changed file to a single rule document (first-match glob over `system_rules.json` → one of 25 `.md` files), then groups files whose resolved rule text is identical.
- `internal/delegate/format.go` renders those groups as a markdown section.
- The host agent receives: review scope, exclusions, matched rule text, background context, and the diffs. It then performs the entire review — planning, reviewing, locating, filtering — inside its own agent loop with its own prompt discipline.

The strengths worth copying: the framing (the tool owns scope resolution and rule matching; the agent owns inference), the packaging (a `SKILL.md` per host agent plus plugins for Claude Code, Codex, Cursor, and opencode), and the honesty that this removes the API-key requirement entirely rather than partially.

The weakness is decisive, and it is where our version wins. Once OCR hands off, **every guarantee is gone.** There is no schema on what comes back, no independent verification of the agent's findings, no line-resolution pass, no review filter, no coverage accounting — those all live inside the Go binary's own LLM path, which delegate mode bypasses. `ocr delegate` is a well-organized prompt. It is strictly less capable than `ocr review`, and the docs are candid that it exists for cost reasons.

codegenie is positioned to do the opposite, because of an accident of existing design: our LLM stages already communicate through `LlmStructuredRequest` (prompt, schema, tools, tool budget, stage, telemetry context) and return schema-validated payloads. That type *is* a delegation envelope. A delegated codegenie run can be exactly as constrained as a local one, and a delegated stage-7 result still flows through stage 9 verification and stage 10 composition. Our delegate mode should be *not weaker* than our normal mode — that is the differentiating property, and the plan is only worth building if it holds.

### What we copy

- The core framing: deterministic work stays in the tool, inference moves to the host agent's subscription.
- Skill/plugin packaging per host agent, with one portable variant for skill-compatible agents.
- Explicit documentation that this is the no-API-key path, and that it trades away properties we will name precisely (§6).

### What we deliberately do better

1. **Schemas survive delegation.** The host agent's output is validated against `SubmitPlanSchema`, `SubmittedFindingSchema`, `SubmitVerificationVerdictSchema`, and `SubmitCompositionSchema` — the same TypeBox schemas the local runner enforces. Malformed output is rejected with the same diagnostics, not accepted as prose.
2. **Verification survives delegation.** A delegated stage 7 still feeds stage 9, where each candidate is re-examined in a fresh context that never saw the reviewer's reasoning. In OCR's delegate mode there is no verification at all.
3. **Composition survives delegation.** Cross-packet dedup, ranking, capping, and phrasing still run. OCR has no composer in either mode.
4. **Coverage accounting survives delegation.** Every hunk still gets a decision or a disclosed skip; a host agent that quietly skips a packet shows up as an unsatisfied request, not as silence.
5. **Batched rounds, not a single blob.** The host agent gets N independent packet tasks it can fan out across its own subagents. OCR hands over one undifferentiated task.
6. **Byte-identical equivalence is a test, not a promise** (§Validation).

## Design

### 1. The delegate runner is a third `LlmRunner`

`LlmRunner` is a one-method interface (`src/llm/llm-runner.ts:114`) with two implementations today: `createPiRunner` and `createFakeRunner`. Delegate mode adds a third.

```
createDelegateRunner({ sessionDir, mode })
  runStructured(request):
    key = buildModelCallCacheKey({ ...canonical request fields })
    if a response file exists for key:
       parse → validate against request.schema → return it
    else:
       record the pending request (prompt, schema, tools, toolBudget,
                                   stage, telemetryContext) under key
       throw DelegatePendingSignal(key)
```

The key insight is that `buildModelCallCacheKey` (`src/llm/model-call-cache.ts:128`) already produces a deterministic identity for a model call, and the model-call cache already proves that replaying stored responses into the pipeline reconstructs a run faithfully. Delegate mode is that mechanism with a different fill policy: instead of *calling the model on a miss*, it *records the miss and stops*.

Consequently the pipeline is not restructured. Each `codegenie delegate` invocation re-runs stages 1–6 deterministically (cheap, no inference), replays every response already on disk, and advances until it hits requests it cannot satisfy. Those become the next batch.

### 2. `DelegatePendingSignal` is a control path, not an error

Stage 7 dispatches packets concurrently through `worker-runner.ts`, and the pipeline has deliberate degrade-and-disclose behavior for failed packets (Plan 80): a failed packet marks its hunks in the coverage ledger and the run continues as partial. If pending requests surfaced as ordinary worker errors, a first delegate invocation would produce a review claiming every hunk failed. That is exactly wrong.

`DelegatePendingSignal` is therefore a distinct sentinel class, checked **before** `isRecoverableWorkerError` / `isRunFatalLlmError` in every place those are consulted. When the runner is in delegate-collect mode:

- a pending signal does not mark coverage, does not record a stage failure, and does not consume budget;
- the worker runner continues dispatching so the *whole* stage's requests get collected in one pass;
- at end of stage, if any request was pending, the run terminates with status `awaiting_delegation` and produces no report.

This is the plan's only genuinely invasive seam and it is enumerated in §In-Scope Files as such. Three call sites (`review-runner`, `worker-runner`, and the shared submit/salvage path in `pipeline-utils`) need the precedence check; nothing else in the pipeline learns that delegation exists.

### 3. The session protocol

State lives under `.codegenie/delegate/<sessionId>/` (gitignored via the existing `provisionCodegenieGitignore` seam):

```
session.json          resolved input, base/head SHAs, config hash, codegenie version, stage cursor
requests/<key>.json   pending task: stage, prompt, schema, tools, toolBudget, telemetry context
responses/<key>.json  host agent's submitted payload
transcript.jsonl      append-only record of every request/response pair, for audit and replay
```

Three commands:

```bash
codegenie delegate start [target]     # resolve input, run stages 1-6, emit batch 1 (the plan task)
codegenie delegate status             # what stage, how many requests pending, what is blocking
codegenie delegate submit             # validate responses/, advance, emit the next batch or the report
```

`start` and `submit` both print, to stdout, a machine-readable batch descriptor: the stage name, one entry per pending request with its key, its prompt file path, its schema file path, and the exact response path to write. A host agent needs no bespoke integration — reading files and writing files is enough.

Batch boundaries follow the LLM stages: plan (1 request) → review (one per packet) → verify (one per candidate) → compose (1 request). Stage 8 follow-up adds a fifth batch on the runs where it triggers. Four to five round-trips regardless of changeset size.

A `--auto` flag on `submit` is deliberately **not** provided: codegenie never invokes the host agent. The host agent drives codegenie. This keeps the trust direction one-way and keeps codegenie free of agent-specific process management.

### 4. Prompt fidelity

The prompt written into `requests/<key>.json` is the same string a local run would send — built by the same `PromptBuilder`, carrying the same projected skill guidance, the same packet context text, the same untrusted-content fencing (`fenceUntrusted`). No delegate-specific prompt variant exists, because a delegate-specific prompt would silently invalidate the equivalence property in §Goal 4 and would drift from the local path over time.

The one addition is an envelope the host agent reads and the model does not: instructions for where to write the response and which schema validates it. It is emitted as a sibling field in the request JSON, never concatenated into `prompt`.

### 5. Tools

Local stage-7 reviewers get repository tools (`read_symbol`, `find_definition`, …) with a per-packet `toolBudget` and repo-root containment enforced in `path-guard.ts`. A host agent has its own file tools, which are strictly more capable and entirely outside our control.

The request therefore carries the tool definitions and the budget as *declared intent*: the SKILL instructs the agent to answer using only read operations within the repository root, and to respect the stated budget as a effort ceiling. We cannot enforce either. This is stated plainly in §6 and in the SKILL, not papered over. What we *can* enforce is unchanged: the returned payload must validate, its anchor must survive `validateAnchorForDiff`, and its evidence must survive stage 9.

### 6. What delegation costs — stated precisely

Local mode's trust model (architecture.md, Trust Boundaries) rests on a property delegate mode cannot preserve: the model that reads attacker-controlled diff content holds only read-only, repo-root-contained tools, and posting is deterministic harness code downstream. Under delegation, the model that reads that diff content is the user's coding agent, which typically holds write and execute tools.

Consequences, all mandatory:

- **Delegate mode refuses `--post-github-comments`.** Not a warning — a hard error at argument parse. Posting from a delegated review is out of scope for this plan and any future plan must justify it independently.
- **Delegate mode is unsupported in CI.** `codegenie delegate` exits with a diagnostic when it detects `CI=true` unless `--allow-ci` is passed, and the Action never invokes it.
- **Artifacts are marked.** `session.json`, every telemetry artifact, and the rendered report carry `delegated: true` plus the host-agent identifier if supplied. A delegated review must never be mistaken for a locally-run one in eval data or in a PR thread.
- **The SKILL leads with the risk.** Reviewing untrusted code with a write-capable agent is a real hazard; the skill text says so and instructs read-only operation, in the first section, not a footnote.

### 7. Packaging

- `.codegenie/skills/` is for review guidance and is not the right home. Delegate integration ships as `delegate/` assets in the published npm package: one `SKILL.md` for skill-compatible agents, and thin Claude Code / Codex / Cursor wrappers that install it.
- A `codegenie delegate install <agent>` subcommand writes the wrapper into the host agent's expected location, mirroring how OCR's plugins install.
- The skill teaches exactly the loop in §3 and nothing about review technique — review technique already lives in the prompts codegenie emits.

## Non-Goals

- **Posting delegated results to GitHub**, in any form, for the reasons in §6.
- **Delegating deterministic stages.** Stages 1–4, 6, and 11 stay local. Handing packet construction to an agent would discard the thing that makes packets trustworthy.
- **A hosted or brokered variant** (codegenie calling the user's subscription through some proxy). Out of scope and probably a ToS problem.
- **Interactive conversation with the host agent.** The protocol is file-based batches; no streaming, no negotiation, no mid-stage questions.
- **Making delegate mode the default.** It is an explicit subcommand. `codegenie review` continues to require a provider.
- **Per-agent prompt tuning.** One prompt, all hosts. If a host reliably fails to satisfy a schema, that is a finding to record, not a fork to maintain.
- **Resume/session machinery for local runs.** Delegate sessions are inherently resumable; generalizing that to `codegenie review` is a separate plan (and a good one — see the OCR study).

## In-Scope Files

- `src/delegate/` (new, the bulk of the feature): `delegate-runner.ts` (the `LlmRunner`), `session.ts` (session dir, cursor, transcript), `batch.ts` (request/response serialization and the batch descriptor), `delegate-command.ts` (`start` / `status` / `submit` / `install`), `pending-signal.ts`.
- `src/cli/main.ts` — subcommand dispatch line only.
- **Approved shared seams (three, and only three):**
  1. `src/pipeline/worker-runner.ts` — `DelegatePendingSignal` precedence ahead of the recoverable-error path, and continue-collecting behavior in delegate-collect mode.
  2. `src/pipeline/pipeline-utils.ts` — same precedence check in the shared submit/salvage layer.
  3. `src/pipeline/review-runner.ts` — runner selection (a delegate runner alongside `shouldUseFakeRunner`), and the `awaiting_delegation` terminal status that suppresses report rendering.
  Any further shared-module touch requires an explicit amendment to this plan.
- `src/llm/model-call-cache.ts` — no behavior change; `buildModelCallCacheKey` is imported as-is. If delegation needs a key-shape change, that is an amendment, because it would invalidate existing cache entries.
- `src/telemetry/run-artifacts.ts` — the `delegated` marker and the delegate session dir in the gitignore provisioning list.
- `delegate/` (new, published assets): `SKILL.md` plus per-agent wrappers.
- `specs/project/functional_spec.md`, `specs/project/architecture.md`, `specs/project/components/review_pipeline.md` — the delegate execution mode, the protocol, and the §6 trust-model carve-out. The carve-out is the important one: architecture.md currently states a property that delegate mode does not hold, and must say so explicitly rather than being left ambiguous.
- Tests: runner-level unit tests (hit/miss/validate/reject), the pending-signal precedence contract, session state machine across invocations, the equivalence test in §Validation, and a CI-refusal test.

## Implementation Steps

1. `pending-signal.ts` + the three seam checks, with a test proving that outside delegate mode the error-handling paths are byte-identical (no behavior change to local runs).
2. `delegate-runner.ts` over an in-memory response store; unit-test hit, miss, schema-valid, schema-invalid, and key stability against `buildModelCallCacheKey`.
3. `session.ts` + `batch.ts`: on-disk layout, cursor advance, transcript append, resume across process boundaries.
4. `delegate-command.ts`: `start` / `status` / `submit`, batch descriptor rendering, `--allow-ci` gate, hard refusal of posting flags.
5. The equivalence test (§Validation) — this is the gate. Do not proceed to packaging until it passes.
6. `SKILL.md` + `install` wrappers for Claude Code, Codex, Cursor, and one portable variant; dogfood by delegating a real codegenie PR review to Claude Code.
7. Spec updates, including the architecture.md trust carve-out.
8. README section positioned as the no-API-key path, with the §6 limitations stated in the same section rather than buried.

## Validation

- **Equivalence (the gate).** A fixture eval case runs twice: once locally with the fake runner, once in delegate mode where the "host agent" is a test harness that replays the fake runner's responses into `responses/`. The two `ReviewResult` objects must be identical after normalizing run ids, timestamps, and session paths. A diff here means a guarantee did not survive delegation, and the feature is not shippable.
- **Pending-signal precedence.** A packet that raises a genuine recoverable error inside a delegate session is still recorded as a coverage failure; a pending request is not. Both assertions in one test, because conflating them is the likely regression.
- **Schema rejection.** A malformed response file produces the same diagnostic class as a malformed local submit, and `submit` refuses to advance the cursor.
- **Resume.** Killing the process between batches and resuming loses nothing; a response file written for a request the harness no longer issues (e.g. config changed between invocations) is detected via the session config hash and reported, not silently used.
- **Refusals.** `--post-github-comments` in delegate mode fails at parse. `CI=true` without `--allow-ci` exits with a diagnostic.
- **Dogfood.** Delegate a real PR review on this repo to Claude Code end to end, and to one non-Claude host, recording round-trip count, wall-clock, and any schema failures. A host that cannot satisfy the schemas reliably is a documented compatibility result, not a reason to loosen the schemas.

## Done Criteria

- `codegenie delegate start` → agent works → `codegenie delegate submit` (×3–4) → full markdown report, with no provider credential configured anywhere in the environment.
- The equivalence test passes: delegated and local runs produce identical `ReviewResult` given identical model responses.
- Verification, composition, coverage accounting, and telemetry artifacts are all present and correct in a delegated run — demonstrably, in the dogfood artifacts, not just in principle.
- Local `codegenie review` behavior is byte-identical when delegate mode is unused; the three approved seams are the only shared-code changes.
- Posting is unreachable from delegate mode, and the trust carve-out is written into architecture.md.

## Stop Conditions

- **If the equivalence test cannot be made to pass**, stop and reconsider the whole approach before writing packaging. A delegate mode that produces a *different* review than a local run is worse than no delegate mode, because it makes the harness claim false rather than unproven.
- **If host agents cannot reliably satisfy the submit schemas** (say, below ~90% first-attempt validity on stage 7), do not weaken the schemas. Add a bounded local repair pass to the protocol, or document the host as unsupported.
- **If the pending-signal seam starts spreading** beyond the three approved call sites, stop: that means the pipeline's error handling is not actually centralized, and the right fix is Plan 95's shared submit/salvage layer first, delegate mode second.
- **If round-trips exceed five in practice** because stage 8 or an adaptive second pass fires often, revisit the batch boundaries before shipping — a ten-round protocol is not usable by a human-in-the-loop agent.
- **If anyone proposes enabling posting or CI use** to make the feature more attractive, that is a separate plan with its own threat model, not an amendment to this one.
