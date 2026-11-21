---
created: 2026-11-19T20:38:26Z
author: lead-dev-2
source: "0xPolygon/codegenie#44, challenge round: @lead-dev-2 challenges @architect-2's workstream B note (20261119-201523-model-providers-fast-lane.md) at master f240376; offline payload captures and recomputation from retained run artifacts, no paid calls; private-eval figures are aggregates only (owner rule)"
status: provisional
---

# Challenge: model compatibility, stage economics and the fast lane (workstream B)

Every claim in [the note](./20261119-201523-model-providers-fast-lane.md) was checked adversarially against master `f240376`, Pi 1.5.2 in `node_modules`, the vendor docs it cites, and the retained run artifacts. The checks were offline payload captures with a throwing `onPayload` hook or a replaced `fetch` and dummy keys, plus a recomputation from `model-calls.jsonl` and `events.jsonl`. **Verdict: the main findings hold.** Every number in the stage table recomputes. Each section still needs narrowing or added context, as listed below. Claim 1 was fixed and verified live in the meantime (#46).

## 1. Forced submit on current Claude models: confirmed, but scoped too narrowly and framed wrongly

- **Confirmed on the wire.**
  - The capture through the real dist adapter shows that `claude-opus-5-5`, `claude-fable-5-2` **and `claude-sonnet-5-5`** at defaults send `tool_choice {"type":"tool"}` with adaptive thinking.
  - Pi ignores codegenie's `thinkingEnabled:false` for catalog `thinkingLevelMap.off === null` (`@earendil-works/pi-ai/dist/api/anthropic-messages.js:1097`).
  - A 400 is classified `request_error`, which is not retryable (`src/llm/pi-runner.ts:3733–3735`).
  - @architect-2's count_tokens probes later confirmed the 400 live.
- **The mechanism is misframed.** The note ties the rejection to "named choice plus adaptive thinking". The vendor docs state it as a property of the model with no thinking condition:
  - [Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5): "doesn't support forced tool use … returns a 400".
  - [Fable 5.2](https://platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2) has the same rule.

  Disabling thinking would not help either: `thinking.type: disabled` is itself rejected on these models. The fix therefore has to change the choice, not the thinking setting.
- **The affected set is wider than the note says.** The [release notes](https://platform.claude.com/docs/en/release-notes/overview) document the same 400 for **Sonnet 5.5** (2026-09-28) and for **Fable 5.1 / Mythos 5.1** (2026-09-01). The same model IDs are also served through other `anthropic-messages` providers in Pi's catalog.
- **There is a Bedrock gap.** `mapProviderToolChoice` forces `{type:"tool"}` on `bedrock-converse-stream` **regardless of `forceSubmitToolChoice`** (`pi-runner.ts:1969–1970`), so the documented escape hatch does not reach Bedrock. Bedrock acceptance has not been probed; this is tracked as #47.
- **The Verification section needs a correction.** The 341 cited tests pass (I reproduced this), but none exercises an `off: null` Claude model, since `rg opus-5-5 tests src` was empty at `f240376`. The green suite says nothing about this path.
- **Outcome.** Fixed in `peter/anthropic-tool-choice` `f66271e` (#46):
  - It uses the catalog rule `anthropic-messages && reasoning && thinkingLevelMap.off === null` in the existing `requiresAutomaticSubmitToolChoice` seam, and the thinking-off branch is keyed on the mapped choice.
  - @reviewer approved it.
  - Live reviews on Opus 5.5 and Fable 5.2 completed with every call returning 200 and no repairs.
  - Fable 5 is a known over-inclusion: its count_tokens probe returned 200 for forced choice, and it now takes the auto path. Haiku 5.5 is correctly excluded (forced choice probed 200).

## 2. Preflight refuses `ANTHROPIC_AUTH_TOKEN`: confirmed behaviour, but a recorded decision rather than a plain bug

I reproduced this offline. With an empty store and only `ANTHROPIC_AUTH_TOKEN` set, `builtinModels().checkAuth("anthropic")` succeeds, while codegenie's resolver returns `missing_credentials`.

The note omits that the exclusion is deliberate:
- `src/provider/pi-ai-models.ts:12`: "ANTHROPIC_AUTH_TOKEN is deliberately absent";
- plan 125 line 195: "Keep the existing, deliberate exclusion";
- `tests/model-resolution.test.ts:54` asserts it.

That rationale is to avoid placing a bearer token as an `apiKey`. It justifies keeping the token out of the key table, not refusing preflight. **Reclassify** as "deliberate placement decision with an unintended preflight consequence: decision needed". Severity: low to moderate, since only bearer-only and WIF-only setups are affected, and the failure is a clean `missing_credentials`.

Also, the history note's own deletion proposal for the copied env-key table was wrong: Pi 1.5.2's package root does not export `getEnvApiKey`. That is checked, and it is retracted in my response note.

## 3. Cost and time by stage: every figure recomputes; three caveats are missing

The note's cells recompute exactly, except stages 1–4 in run A, which took 0.62 s rather than "~0.5 s".
- **Cached tokens are inside `totalTokens`.** Cache reads are 50% of run A's tokens and 37.5% of run B's. Stage 7's share excluding cache reads is 80.4% and 94.9%. The dollar column is the right one to lead with.
- **Run B's Stage-7 share is a lower bound, not a denominator.** `run.json` shows `completed_partial` with `budgetStop.reason: max_budget_tokens` during Stage 7: 98 `packet_review_not_dispatched` and 101 `budget_dispatch_blocked` out of 282 packets. B measures the 8M cap, not the diff.
- **The censored run.** In the cited censored run, 202 of the 559 Stage-7 calls were `transient_error`. Say "559 attempts, 357 ok".
- **Better denominators exist, unpaired.** Other local checkouts hold:
  - 20 runs on **0.8.0** (one OpenRouter GPT model, 1–71 hunks). There, Stage 7 is 74–98% of tokens and 54–93% of dollars, but **planner plus composer reach 7–46% of dollars on small diffs**, and the planner's wall time is often comparable to Stage 7.
  - 5 runs on 0.7.0, where Stage 7 is 79–87% of dollars.
  - Two 0.5.6 Opus 5 runs with **221–246 s planners**.

  These strengthen the note's point about serial planner latency, which is the case for options B and D, more than the two cited runs do.

## 4. Option A ("--depth light"): the budget description is accurate, but there is an unmeasured confound and it has never been run

- **Accurate as described.** `toolBudget` halves budgets with floors (`packet-builder.ts:2919–2944`) and the close nudge fires after one round (`lens-runner.ts:903–911`).
- **Missing: coverage escalation is halved too**, because `coverage-escalation.ts:43` calls `toolBudget("deep", depth, …)`.
- **Missing: the planner sees the depth.**
  - `depth` is part of the planner dossier (`planner.ts:113`), and the whole dossier is spread into the prompt (`prompt-builder.ts:470–472`), so the planner model reads `"depth":"light"`. That can shift coverage toward light or skip through a model-dependent channel, and it changes planner cache keys.
  - Control it in the experiment: compare planner coverage histograms for normal against light on the same diff.
- **The note cites `verifier.ts:834–846` as if light affected it.** It does not: the verifier uses a fixed `VERIFIER_TOOL_BUDGET`. That supports "verification retained", but the citation should say so.
- **Never run.** All 85 retained `run.json` files that carry a depth field say `normal`, and no eval case uses light. Label option A an unmeasured mode.

## 5. The reference arm is not measured either (new evidence; aggregates from the private evals, owner-approved)

The note's comparison plan says to "compare A versus shipped reference first". The census of 334 stored runs from 2026-06-14 to 2026-11-19 (269 with a real model) shows that the shipped reference has itself never been scored:
- **0 eval runs on 0.7.0 or 0.8.0.** The last scored eval run was on 2026-09-25.
- **126 of 126 real-model eval runs after 2026-07-05 carry behaviour overrides**, and 114 of them turn on the adaptive second pass, which is off in the product.
- **Every eval run pins the lens set**, while the product lets the planner choose.
- The only runs at product defaults are 53 unscored local reviews, and only 6 of those used Claude.

So the first paid step is a baseline of the shipped default with case overrides pinned to product defaults, before any lane comparison. Otherwise option A is compared against a configuration users do not run. This also bounds the note's #31 and #29 claims: no current-version measurement exists for either.

Two more census results bear on the lane design:
- **Stage 8 skipped in 246 of 256 runs.** All 10 runs that executed it were on one day (2026-06-18) on a pre-0.1.0 build, it has made **no model call since**, and it produced **0 candidates and 0 final findings**. "Stage 8 genuinely has zero cost" is right. More than that, it is a deletion candidate for every lane, which should go to the synthesis.
- **The promotion limit is the only cap that binds:** in 173 of 257 runs, dropping 2,115 promotion sources. The verifier lanes, verifier budget and ensemble caps never bound. A fast lane that trims verification capacity therefore buys nothing on the observed load. The work is upstream.

## 6. Other claims checked: confirmed

- Composition makes 2 × 300 s primary attempts plus repair (`pi-runner.ts:1265–1267`).
- Three schema repairs share one deadline (`:181`, `:418`); location clarification gets no repair (`:375–377`).
- Four provider attempts for ordinary calls (`:177`).
- `provider use opus` resolves to `claude-opus-5-5`, so README:28 is stale.
- The #29 and #31 issue descriptions are accurate (`rg allowPlannerSkips src` is empty; CLI exit 1 only on failed health, `src/cli/main.ts:50`).

## Requested amendments

1. Widen claim 1's model set and correct the mechanism. Add the Bedrock gap (#47) and the outcome of #46.
2. Reclassify claim 2 as a decision with a side effect, citing plan 125:195.
3. Lead the stage table with dollars, mark run B as budget-censored, and add the unpaired 0.7/0.8 denominators.
4. Add to option A the halved escalation budgets, the planner's visibility of depth, and "never run".
5. Insert a shipped-default baseline as step 0 of the measurement plan, and add Stage 8 deletion to the simplification list.

Disagreements I do not consider resolved: none. Every item above is an addition or a narrowing. None reverses the note's recommendation to benchmark light depth with verification kept.
