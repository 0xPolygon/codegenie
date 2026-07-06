# Issue 86: Provider Protocol Parity and Observability

Status: IN PROGRESS — steps 1-4 COMPLETE (2026-07-02); step 5 (cross-provider study) remains, after baseline + per-worker session keys (done).
Step 3 notes (2026-07-02): constraint verified current — forced tool_choice still conflicts with extended thinking on the Anthropic API (pi-ai 0.80.3 anthropic-messages requires thinking disabled for forced choice), so the "if yes" branch shipped: finalize/repair/no-tool calls (exactly the calls that request forcing) disable thinking per-call (`thinkingEnabled: false` — explicit, because adaptive-thinking models default to thinking on) and apply real forced submit tool choice. Investigation rounds keep thinking + auto. Escape hatch `llm.forceSubmitToolChoice` (default true, user-scope); the flag-off path keeps the downgrade and its `tool_choice_downgraded` warn. Cache-key honesty: forced-submit calls carry reasoning `forced-submit-no-thinking`. The A/B effect on schema validity/recall is measured by the owner's next eval runs against the Wave-2 baseline.
Implementation notes (steps 1-2, 4): per-call protocol recorded on every `model-calls.jsonl` record (`toolChoiceRequested/Effective/Downgraded`, `reasoningRequested/Mechanism/LevelEffective`) via `describeProviderProtocol` in `pi-runner`; once-per-run `provider_protocol` info event; first-occurrence `tool_choice_downgraded` warn; `toolChoiceDowngradedCalls` aggregated into `model-calls-summary.json`/`telemetry.json` and exposed as an eval metric; provider matrix documented in `skills_llm_telemetry.md`. `reasoningTokens` deferred — pi-ai usage does not expose thinking/reasoning token counts today (step-1 field dropped until it does).
Planned from: Fable review (`specs/reviews/1-fable-review.md` §5.2), pi-runner audit, and the 2-run gpt-5.5 vs 5-run opus relay comparison in `~/Dev/0xsequence/trails-api/.codegenie/runs/`, 2026-07-01
Recommended priority: high, sequenced with/after Issue 79. Issue 79 gives the recall-rate instrument; this issue makes cross-provider comparisons *valid* by recording and normalizing the protocol each provider actually runs. Without it, "opus vs gpt-5.5" compares two different protocols, not two models. Relationship to neighbors: Issue 80 (degrade-and-disclose) lowers the blast radius of any residual submit failure this plan's forcing change might surface; Issue 84 (Stage-7 ensemble) and any cross-provider "gigabrain" second-pass idea should be evaluated *after* this plan's step-5 study, so provider choice is informed by protocol-controlled data.

> Executor instructions: this plan is observability-first. Steps 1-2 (recording) land before step 3 (the one behavior change), and step 3 requires verifying the current Anthropic API constraint before changing anything. Do NOT fork prompts per provider in this plan. Do NOT change Stage 7 review posture, tool budgets, or verifier policy.
>
> Drift check: `git diff --stat HEAD -- src/llm/pi-runner.ts src/telemetry/run-artifacts.ts src/telemetry/telemetry-recorder.ts src/evals/eval-scoring.ts`

## Problem

codegenie's design intent is a normalized LLM interface: identical prompts, tools, schemas, and agent loop for every provider, with pi-ai handling provider dialects. In practice the pi-runner's per-API adaptation layer diverges at exactly the control points that decide review quality, and none of the divergence is recorded:

1. **Structured-output enforcement differs per provider.** The architecture's core strategy is "every structured stage call ends with a forced submit tool." `mapProviderToolChoice` (`src/llm/pi-runner.ts:1270-1295`) implements forcing for OpenAI (payload-injected `tool_choice`), Google (`"any"`), Mistral, and unknown APIs (`"required"`) — but on `anthropic-messages` it silently returns `"auto"`. On Anthropic (opus), submit compliance rests entirely on prompt text plus the repair ladder; on OpenAI (gpt-5.5), the API guarantees it. Presumed cause: Anthropic rejects forced `tool_choice` combined with extended thinking, which the runner always enables for Anthropic (`mapReasoningOptions`, `pi-runner.ts:1237-1257`). No telemetry, comment, or spec records this downgrade.
2. **Reasoning regimes differ in kind, not just label.** codegenie's `low|medium|high|xhigh` passes through pi-ai onto vendor-specific mechanisms: Anthropic adaptive-thinking effort or explicit thinking-token budgets (older models: fixed token tables, `xhigh` clamped); OpenAI `reasoning_effort` (opaque); Google 3 discrete levels (`xhigh`→`HIGH`); some z.ai/GLM models a **binary** thinking toggle where `low` and `xhigh` are identical (`pi-ai/dist/providers/openai-completions.js:444`). Same knob label, uncalibrated compute. Telemetry does not record the effective mechanism or the reasoning-token spend per call in a per-provider comparable way.
3. **All tuning is opus-calibrated.** All 67 runs in both private eval log dirs are claude-opus-4-8 (verified over 10,463 model-call records). Every prompt-posture, tool-budget, and repair heuristic across plans 01-79 was validated by watching opus. The only gpt-5.5 evidence (2 local runs) shows a distinctive failure shape: gpt-5.5 asked the exactly-right relay wrong-chain question but emitted it into the *hint/uncertainty lane* (ended as a human-attention note) instead of the candidate lane; it also published noisier findings (the duration-constant look-alike) and hit tool-budget exhaustion more often (212-278 Stage-7 calls vs opus ~180-207 on the same diff).

Net effect: we cannot say whether gpt-5.5 (or glm-5.2, or anything via openrouter) is worse at review, worse at *this harness's protocol*, or simply unmeasured. The goal is codegenie working optimally regardless of provider; the first step is making provider behavior visible and the protocol equal where it can be.

## Non-Goals

- No per-provider prompt forks in this plan. A single prompt clarification (candidate-lane preference for concrete changed-line predicates) may come later, as its own plan, only if the study in step 5 shows lane routing is the gap — and it must be validated on both models.
- No per-role model tiering (`llm.roleModels` stays deferred per the functional spec).
- No changes to Stage 7 review posture, uncertainty promotion, verifier policy, or tool budget *values*.
- No LLM-judge scoring; the study uses Issue 79's deterministic repeat harness.
- Do not gate CI or evals on cross-provider parity yet; this plan measures, it does not enforce.

## Current State

- `src/llm/pi-runner.ts:1270-1295` `mapProviderToolChoice`: forced choice → `"auto"` on `anthropic-messages`; payload injection for openai-responses family via `withToolChoicePayload` (`:1297-1311`).
- `src/llm/pi-runner.ts:1237-1257` `mapReasoningOptions`: `anthropic-messages` → `{thinkingEnabled: true, effort}` unconditionally whenever reasoning is set.
- Forced-choice calls route through `complete()` + `mapProviderOptions`; auto calls through `completeSimple()` (`pi-runner.ts:563-574`) — two pi-ai code paths.
- `LlmCallRecord` (`src/telemetry/telemetry-recorder.ts`) records usage/cost/finalize fields but not: requested vs effective tool choice, thinking/reasoning mechanism, or reasoning-token spend as a first-class comparable field.
- Stage-7 submit friction is already partially instrumented (plan 71/54: first-submit validity, schema recovery) — reusable here.
- Issue 79 (PENDING) adds `repeat` + per-expectation recall rates to the eval harness.

## Design

### 1. Record the effective protocol per model call (observability)

Extend `LlmCallRecord` and `model-calls.jsonl` with:

```text
toolChoiceRequested: "auto" | "forced:<toolName>"
toolChoiceEffective: "auto" | "forced:<toolName>" | "required" | "any"
toolChoiceDowngraded: boolean           # effective weaker than requested
reasoningRequested: "low" | "medium" | "high" | "xhigh"
reasoningMechanism: "adaptive-effort" | "thinking-budget" | "reasoning-effort" | "thinking-level" | "binary-toggle" | "none" | "unknown"
reasoningLevelEffective: string          # after clamps (e.g. xhigh->high)
reasoningTokens?: number                 # provider-reported thinking/reasoning tokens when available
```

Emit a once-per-run `provider_protocol` telemetry event summarizing the mapping for the resolved model (api family, tool-choice dialect, reasoning mechanism, any clamps), and a warn-level `tool_choice_downgraded` / `reasoning_level_clamped` event the first time each occurs. Aggregate per-provider counters into `model-calls-summary.json` (downgrade counts, finalize-retry counts, first-submit validity — join with the plan-71 metrics).

### 2. Expose protocol metrics to the eval harness

Surface in eval `info.json` metrics (and thus `eval-compare`): first-submit-validity rate per stage, finalize-missing-submit retries, schema-repair usage, tool-choice downgrade count, reasoning tokens per call (mean), tool-budget rejections. These are the covariates any cross-model comparison must hold visible. (This also implements the review's P2 punchlist item: a schema-friction regression gate becomes possible once these are `expect.*`-checkable.)

### 3. Close the Anthropic forcing gap (the one behavior change)

First verify the constraint against the current Anthropic API: does forced `tool_choice` still conflict with extended thinking?

- If yes: for **finalize/repair/no-tool calls only** (stages 5 and 10, and Stage 7/8/9 finalization steps), disable thinking on Anthropic and apply real forced tool choice. Investigation rounds keep thinking + auto choice. Rationale: finalize calls need protocol compliance, not deep reasoning — the reasoning happened in the investigation rounds; and stage 5/10 quality-with-thinking vs reliability-without is exactly what the A/B in step 5 can check.
- If no (API now supports both): force tool choice on Anthropic the same as other providers and delete the downgrade.
- Either way: the downgrade path, if any remains, must emit `tool_choice_downgraded` — never silent.

Guard with an escape hatch (`llm.forceSubmitToolChoice: boolean`, default true, user-scope config) so a regression can be neutralized without a release.

### 4. Document the provider matrix

Add a short spec section (skills_llm_telemetry component or architecture LLM Runner section) with the per-API-family table: tool-choice dialect, reasoning mechanism, clamps, code paths. This is the doc the next "why does provider X behave differently" question should land on.

### 5. Cross-provider study (uses Issue 79)

With the repeat harness landed, run the relay wrong-chain case (79's WC expectation) at `repeat: 10`, `cache: false`, identical config except the model:

- claude-opus-4-8, gpt-5.5, and at least one more provider (glm-5.2 or an openrouter-served model) if authenticated.
- Compare per model: `candidateRecallRate` vs `finalRecallRate` vs `noteRate`, plus the step-2 covariates.

Decision tree the study answers:
- candidate rate ≈ opus but final rate lower → loss is in-lane routing/promotion/verification → follow-up plan on lane guidance (prompt clarification tested on both models).
- candidate rate itself low → model detection gap at Stage 7 → per-model expectations should be set accordingly (or reasoning level raised for that provider).
- friction metrics dominate (submit retries, budget rejections) → protocol/budget tuning, not intelligence, is the gap.

Record results as a short findings note under `specs/reviews/` (or an addendum to this plan) — not as immediate pipeline changes.

## Likely Files

- `src/llm/pi-runner.ts` (tool-choice/reasoning mapping, record fields, downgrade events, finalize thinking toggle)
- `src/telemetry/telemetry-recorder.ts`, `src/telemetry/run-artifacts.ts` (record fields, summaries)
- `src/config/schema.ts`, `src/config/config-loader.ts` (`llm.forceSubmitToolChoice`, user-scope)
- `src/evals/eval-scoring.ts` / `eval-runner.ts` (metrics exposure)
- `specs/project/architecture.md` or `components/skills_llm_telemetry.md` (provider matrix doc)
- `tests/phase4-llm.test.ts` + pi-runner tests (mapping table, downgrade events, finalize forcing)

## Acceptance Criteria

- Every model-call record carries requested/effective tool choice and reasoning mechanism; downgrades and clamps are events, never silent.
- Per-provider protocol counters appear in `model-calls-summary.json` and eval metrics.
- On Anthropic, finalize/repair/no-tool calls run with genuinely forced submit tool choice (or the constraint is documented with the downgrade evented), behind `llm.forceSubmitToolChoice`.
- The provider matrix is documented in the specs.
- The repeat-10 cross-provider study on the relay case has been run and its per-model recall/friction table recorded.
- `pnpm run typecheck && pnpm test && pnpm run build` exit 0.

## Validation

- Unit tests over `mapProviderToolChoice`/`mapReasoningOptions` snapshot the per-API matrix so future pi-ai upgrades that change a dialect fail a test instead of drifting silently.
- One opus + one gpt-5.5 smoke review over a fixture confirming: records carry the new fields; Anthropic finalize calls show `toolChoiceEffective: forced:*`; no recall/precision change on the fixture suite.
- Then the step-5 study.

## Stop Conditions

- Stop if disabling thinking on Anthropic finalize calls measurably degrades stage 5/10 output quality on the fixture + repeat evals (fall back to documented-advisory mode with events, keep the observability).
- Stop if pi-ai cannot expose the effective protocol without forking its internals — in that case record `"unknown"` mechanisms rather than guessing, and upstream a pi-ai feature request.
- Stop if the plan starts growing per-provider prompt text; that is explicitly a separate, later plan.
