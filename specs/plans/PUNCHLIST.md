# Punchlist

Execution-order ledger. Drains `specs/reviews/1-fable-review.md` (2026-07-01) plus subsequent eval evidence (`0c4d5213` runs 42-45, `49f4645b` runs 24-25) into ordered, dispositioned work. Plans own the detail; this file owns the order. The README table stays the per-plan status index.

Ordering principle: measurement campaigns (Plan 79 baselines, Plan 86 study) are expensive — before spending on them, (a) runs must not be destroyable or pollutable by infrastructure, and (b) the baselined system should already contain the uncontroversial deterministic fixes. Behavior-changing improvements land *after* the baseline, one at a time, measured. Hygiene lands whenever there is slack; it never jumps the queue.

Triage rule for spec↔code divergence (see memory: code is source of truth): each divergence is dispositioned as **code-bug** (fix code), **spec-stale** (fix or annotate docs, low priority), or **decision** (product call needed) — never an automatic "make code match spec".

## Wave 1 — robustness floor (small, deterministic, no review-posture changes)

- [x] **Plan 80** — degrade-and-disclose failure semantics (fable D1, bugs 1/7). Protects every future run, including baseline runs, from one submit failure destroying the review. (2026-07-02)
- [x] **Plan 85** — finalize grace for per-pass timeouts + truthful incomplete labeling. Removes the timeout losses that would inflate Plan-79 variance numbers. Coordinate its outcome-label names with 79's loss attribution. (2026-07-02)
- [x] **Plan 82 (mechanical half)** — no severity demotion on `behaviorChange: "unknown"`; `severityBeforeCap` threaded through suppression guarantees. Bug fix; belongs in the baseline system. Calibration half stays in Wave 4. (2026-07-02)
- [x] **Plan 86 (steps 1-2, 4)** — protocol observability (tool-choice/reasoning recording, eval metric exposure) + provider matrix doc. Zero behavior change; its friction covariates should exist in the baseline telemetry. Step 3 (forcing) deferred to Wave 3; step 5 (study) to Wave 3 end. (2026-07-02)
- [x] **Plan 89, phase A (eval-signal integrity)** — scorer crash on missing artifact (fable bug 13, run 24 evidence), `a...b` target validation (bug 14), coverage under-count + mislabeled safety-coverage source (bug 19), side-less/line-less static-signal binding (bug 17), skip-rules last-match (bug 5). All deterministic; all distort the measurement signal 79 will rely on. (2026-07-02 — Wave 1 complete)

File-conflict note: 80, 85, 82 all touch `verifier.ts`/`lens-runner.ts` — land as a short series in that order, not in parallel. Pre-79 validation is unit/fixture tests, not single eval runs.

## Wave 2 — the instrument, then the baseline

- [x] **Plan 83** — wording-independent fingerprints + compare integrity (fable D7, bug 3). Lands before/with 79: cross-run identity is the harness's regression assertion, and Plan 84 needs stable fingerprints for union-dedupe. (2026-07-02; note: first compare against a pre-83 run shows one-time fingerprint churn)
- [x] **Plan 79** — repeat/recall-rate harness + relay wrong-chain case. The measurement foundation; nothing recall-related gets judged without it after this point. (2026-07-02; relay case at `trails-api/relay-wc`, pinned to `dad51fda`)
- [x] **Plan 90** — token-denominated primary budget: `review.maxBudgetTokens` (renamed from never-set `maxTotalTokens`), default 5,850,000 (25% above largest observed full review). Time demoted to hang-guard in posture. Watch: raise when plan 84's ensemble adds tokens. (2026-07-02)
- [x] **Baseline runs (owner-run)** — COMPLETE (2026-07-02). `49f4645b` runs 29-30 (both pass: one direct-lane, one promotion-rescue) + `0c4d5213` runs 46-47 run simultaneously (46: **5/5 pass — first fully-green run of this case in recorded history, incl. first-ever zero-native match**; 47: 4/5, sole loss erc20 `reviewed-no-candidate`). All four runs `completed_full` with ZERO infrastructure losses (0 dispatch blocks, 0 grace/soft-deadline events, 0 verification incompletes, 1 schema_invalid recovered) — the only loss in the entire baseline is Stage-7 generation variance, exactly Plans 84/81's target. Findings note: `specs/reviews/2-baseline-wave2.md`. Caveat stands: 2 runs/case gives weak rates; Plan 84 validation needs `repeat: N`.
- [x] **Provider serialization follow-up — RESOLVED as provider-side congestion, now lifted (2026-07-03 ~03:15Z).** Probe ladder (temp script, deleted): 4-concurrent one-process tiny / heavy-unique / heavy-shared-prefix / 16k-reservation+thinking / **long-output (4×45s concurrent streams)** — all TTFB 1-2s, fully parallel, minutes after run 47's tail calls still queued at 125-182s. Conclusion: July 1-2 queueing was provider-side load-dependent scheduling (solo requests always fast; an org's 2nd..Nth concurrent heavy requests queued; aggregate scaled sub-linearly with demand — runs 46/47 got ~2 lanes at 8 in-flight). No client-side defect; nothing to fix in codegenie. Permanent watch: per-call `ttfbMs` telemetry; if the pattern returns, escalate to Anthropic with captured request-ids. Wall-clock should return to healthy (~12 min for the big case).
- [x] **maxBudgetTokens re-derivation (plan-90 watch item)** — triggered by run 46's new largest observed review (4,925,828 tokens, within 3.4% of the 6M default's soft-stop); raised to **7,000,000** (owner decision 2026-07-02): ~42% above largest observed, soft-stop 5.95M, headroom for plan 84's ensemble.

## Wave 3 — behavior changes, one at a time, measured against the baseline

- [x] **Plan 76** — anchor rescue at the verification pre-gate (v6). Phase 1 landed 2026-07-02 (`bf8100c`): two-tier reconstruction + anchorSource provenance; identity/publication never trust gate-only anchors. Phase 2 not shipped (stop condition). Eval validation (repeat runs) pending, owner-run.
- [x] **Plan 87** — exact-duplicate clustering landed 2026-07-02 (`41ee308`): fuzzy semantic clusterer deleted (~180 lines); verdicts shared only across exact copies (path+category+hunk/evidence+title+failureMode equality); reject propagation has a per-candidate trail; gate-only representative anchors never create identity. Repeat A/B measurement pending, owner-run.
- [x] **Plan 86 (step 3)** — landed 2026-07-02 (`932ee5a`): Anthropic finalize/repair/no-tool calls run thinking-off + genuinely forced submit; escape hatch `llm.forceSubmitToolChoice` (default true). A/B effect visible in the owner's next eval runs (first-submit validity, schema retries).
- [x] **Plan 91** — COMPLETE 2026-07-03: migration off `/compat` validated end-to-end. A/B gate = run `0c4d5213/50` (protocol posture field-identical to pre-migration); CLI smoke + debugTrace payload spot-check green. Auth Option A (codegenie-owned resolution, per-call apiKey). No compat imports remain; manifest `^0.80.3`.
- [x] **Plan 81 (output-quality slice)** — landed 2026-07-02: promoted candidates carry real predicate titles (no templates), NO fabricated anchors (plan-76 gate-only anchors take over; run-30's published-template-with-fake-anchor shape is structurally impossible), and hunk-scoped evidence. Admission gates unchanged (already implement the three-part rule; promotions are load-bearing per runs 24-30). Classifier/locality/reserve deletions + compensation-lane shrink remain measurement-gated on repeat data; category-from-lens deferred to a hint-schema change (documented in plan).
- [x] **Plan 84** — IMPLEMENTED 2026-07-02, shipped dark (`deepEnsemblePasses` default 1 = off). K independent deep-packet passes, union under plan-87 exact identity, pass-attributed ids/producers, `stage7_ensemble` telemetry. Measurement next: owner-run K=3 vs baseline on both cases (decision table in the plan governs defaults). Wave 3 code COMPLETE.
- [x] **Per-worker session IDs** — stage-scoped session IDs mapped to OpenAI's `prompt_cache_key`, concentrating all Stage-7/9 workers on one cache node above OpenAI's documented ~15 req/min per-key overflow threshold; per-worker IDs (`stage-7-<workerId>`) fix gpt-5.5 cache routing, are inert on direct Anthropic (safe pre-baseline), and avoid gateway affinity pinning. `sessionKeyGranularity: "worker"` recorded in provider_protocol. (2026-07-02)
- [ ] **Plan 86 (step 5) — cross-provider study (opus-4-8 vs gpt-5.5), protocol-controlled. Output: findings note, not code.** Scoped 2026-07-04. Per-worker session keys done (the gpt-5.5 cache-hotspotting handicap is fixed). Prior gpt-5.5 underperformance is now separable hypotheses, each with an instrument: schema friction (first-submit validity + schemaInvalid/repair metrics), tool-call style vs opus-calibrated budgets (toolBudgetRejections, per-packet call counts), forced-choice-with-reasoning API posture (provider_protocol per call; known asymmetry: anthropic runs forced calls thinking-off, openai reasoning-on — document, don't hide), tokenizer/cache-economics differences (token totals move for non-quality reasons), and scorer wording bias (titlePatterns tuned on opus phrasing — manually adjudicate first-run misses before trusting fails, run-49-style).
  - [ ] **Pre-study telemetry gate (code, small, eval-independent — land in the next quiet window):**
    1. Widen the `onResponse` capture: currently keeps only `anthropic-ratelimit-*`/`request-id` — add `x-ratelimit-*` and `x-request-id` so gpt-5.5 runs record rate posture and request ids (otherwise blind on exactly the July failure dimension).
    2. Record `reasoningTokens` per call: pi-ai 0.80.3 now exposes `usage.reasoning` (verified in run-50 debug artifacts) — the plan-86 deferral is obsolete; needed so gpt-5.5 reasoning spend vs opus thinking spend compare symmetrically.
    3. Verify OpenAI `cached_tokens` usage maps into the fields `providerPromptCacheReadTokens` reads — else the per-worker-key fix built FOR this study is unmeasurable on the model it was built for.
  - [ ] **Codex lane support (owner requirement, 2026-07-04): both `openai` (API key) and `openai-codex` (ChatGPT-plan OAuth) lanes, both on the Responses API.** Verified: pi registers `openai-codex` as a full provider (gpt-5.5 in its catalog, api `openai-codex-responses`) with OAuth in pi's registry, and codegenie's dialect switches already cover `openai-codex-responses` (tool choice, reasoningEffort, protocol fields). Remaining verifications (fold into the smoke phase): (a) `provider login openai-codex` OAuth flow end-to-end via existing CLI machinery; (b) session-key semantics on codex — `sessionId` there is transport/session identity (websocket/SSE headers + fallback tracking), NOT `prompt_cache_key`; per-worker keys are plausibly correct but must be verified live and documented as the third session regime in the provider matrix (`skills_llm_telemetry.md`); (c) rate-limit/request-id header family on the ChatGPT-plan lane — make the widened onResponse capture generic (any `*ratelimit*` header + `retry-after` + `request-id`/`x-request-id`) rather than provider-enumerated.
  - [ ] **Smoke runs (two):** one cheap gpt-5.5 run of `49f4645b` per lane — `openai` API key, then `openai-codex` OAuth — to catch auth/400s/schema/transport issues before real spend; adjudicate scoring fairness on the first (widen titlePatterns if same-substance findings miss on wording only).
  - [ ] **Study protocol (three arms):** opus-4-8 (anthropic key), gpt-5.5 (`openai` key), gpt-5.5 (`openai-codex` OAuth) — the third arm doubles as a serving-lane comparison (API tier vs subscription plan), directly mirroring the July anthropic OAuth-vs-key findings. Both cases, N≥2-3 per arm, identical configs except `llm.provider`/`llm.model` (keep K=2 + adaptiveSecondPass on — mechanism hit-rates per model are a study output); findings note reports recall WITH covariates alongside (first-submit validity, schema repairs, tool volume, cache reads, reasoningTokens, TTFB, cost) so any recall gap ships with its mechanistic explanation.

## Wave 4 — production-path fixes now, calibration when the data lands

Sequencing (2026-07-04): the measurement campaign (owner runs feeding the plan-92/84 decision tables) runs in parallel with code work. Code items below are ordered so nothing landed can muddy an A/B: production-path and hygiene fixes first (eval-independent), calibration items strictly after the rates exist. Current measurement tallies to watch: adaptive hit rate 1-for-4 post-fix (run 53, incl. one expectation rescue), ensemble pass-2 rescues in 3 of 4 ensemble runs, E1 escalation 2-for-2 on aim.

- [x] **Plan 92 (code)** — all three layers landed 2026-07-03 (attention instrument; E1 test-coverage-delta escalator always-on + E2 telemetry-only; adaptive second pass dark behind `review.adaptiveSecondPass`, capped). Measurement pending: owner runs with adaptive enabled in eval cases; per-mechanism attribution via coverageSource/adaptive events keeps combined-run A/Bs readable. Original planning entry: (2026-07-03 from runs 47/49/50: all three losses on normal/default-coverage packets while deep ensembles went [0,0] in 6/8 pass-runs; run 50's missed finding surfaced verbatim as a concrete follow-up hint from the missing packet). Three layers, landed separately: (1) attention-efficiency metrics — zero behavior change, can land immediately; (2) deterministic structural escalators (orphaned test-coverage delta; intent mismatch) — no domain heuristics; (3) adaptive second pass triggered by the pipeline's own near-miss signals, on plan-84 machinery, capped, dark by default. Subsumes the promotion lane's rationale — its success is what earns plan 81's gated deletions.

### Now (eval-independent; land while measurement accumulates)

- [x] **Plan 88** — publisher: reachable summary-only 422 fallback + partial-coverage disclosure in posting body (fable D6, bug 1). Landed 2026-07-04; summary-only fallback is reachable after three inline 422s, final summary rejection is the only fatal fallback path, partial-coverage disclosure uses shared coverage helpers, and deleted-file → LEFT → multiline suspect order is documented and test-pinned.
- [x] **Composition near-duplicate merge (watch → fix, from run 0c4d5213/53)** — two wording-variant routing findings from different ensemble passes published as separate inline findings; stage-9's exact rule correctly kept them separate for independent verification, but stage-10 root-cause grouping should have merged them. Landed 2026-07-04; deterministic Stage-10 grouping now merges evidence-linked cross-file helper/caller root causes transitively, with a guard test proving unrelated findings that merely cite the same helper path stay separate. Still watch: finding-set diversity vs pre-wave run 40 (two extras 53 lacked).
- [x] **Plan 89, phase B (hygiene)** — landed 2026-07-04. Tree-sitter cached trees dispose on eviction and raw-content cache keys hash; stage runtime endpoints are idempotent; crashed run dirs prune by mtime without `run.json`; existing `.codegenie/.gitignore` files are no longer mutated; Go value receivers render `(T).Method`; HTTP status mining is status-context anchored; extra submit calls emit `extra_submit_dropped`; stale PR-ref locks re-check before removal; packet symbol suffix matching requires a segment boundary; related-context omissions carry `hunkIds`; readRange clamps past EOF; eval run ids are minted independently from `telemetry`; README spec links fixed; `--from-artifacts` old-layout replay errors explicitly.

### Data-gated (do NOT start until the decision tables have rates)

- [x] **Plan 82 (calibration half)** — CLOSED 2026-07-04, no severity flapping observed (decision record). Original entry: **(was)** — only if Wave-2/3 data shows severity flapping on `severityAtLeast` expectations; consider scorer matching on `max(severity, severityBeforeCap)`.
- [x] **Plan 74** — COMPLETE 2026-07-04 (`91dd903`): bounded merged-confidence calibration at final composition; confidenceSelections in final-selection.json.
- [x] **Plan 75 (step 1)** — COMPLETE 2026-07-04: adjudicated-reject notes suppressed provenance-exactly; pinning tests landed same day.
- [ ] **Plan 55 (re-scoped)** — docs as intent context; drop the `ReviewDisposition`/`FileRole` machinery per fable §4.
- [ ] **Simplification series (fable §6 items 5-8) — PLANNED 2026-07-04, execute in risk order in quiet measurement windows:**
  1. **Plan 93** — COMPLETE 2026-07-04: dead ripgrep fast path and per-run ignored-file enumeration deleted; git-grep is the single search engine, with `engine: "git-grep"` retained in telemetry.
  2. **Plan 94** — COMPLETE 2026-07-04: shared util modules landed (`json`, `regex`, `path-roles`, `text-similarity`); `isTestPath` dialects are explicit named exports, compact vs pretty stable JSON stayed byte-compatible, the dead `lens-runner` follow-up key was deleted, and pinning tests cover the preserved divergences.
  3. **Plan 95** — IN PROGRESS 2026-07-04: rung-utilization census complete over `0c4d5213` runs 46-54 + `49f4645b` runs 29-33 (10 schema-invalid calls / 2,436 model calls; Stage-7 cleanup, composer salvage, planner/verifier repair all live). Prompt why ledger landed beside template versions; Stage-7 repair telemetry emitters collapsed to one recorder. Remaining: move Stage-7 cleanup fully behind `recoverInvalidSubmit` and A/B schema-friction flat.
  4. **Plan 96** — fixed Stage-6 symbol-context budget (delete the ~600-line adaptive tree). The one real behavior change; census-sized budget + truncation event; strongest A/B (both cases, ≥2 runs); coordinates with PLAN12 seed-context.

## Decision record (2026-07-04) — measurement rounds concluded

# Decision Record — 2026-07-04 (measurement rounds: runs 32-33, 51-54)

Convened on accumulated rates; no further runs requested by owner.

1. **Ensemble (plan 84): KEEP, opt-in, K=2 everywhere.** Rescue-bearing in most runs (matched candidates from e2 passes in 33/53/54); K=3's third draw unproven (one pass-3 winner, run 32) at 2x small-case cost — 49f4645b set to K=2 (`0197af7` in evals repo). Product default stays 1.
2. **Adaptive second pass (plan 92 L3): KEEP, eval-enabled, no product default.** Post-tightening: 2-for-8 scheduled passes, both hits expectation-critical (a81d5adf x2, fba381a9); 0-for-3 on 72a8ab63. Bounded by flat cap 4.
3. **Promotion lane (plan 81): DELETION OFF THE TABLE.** Head-to-head split: adaptive beat promotion on a81d5adf (run 53), promotion converted zero-native (72a8ab63-u1, run 51) where adaptive whiffed 3 straight. Lane retained in its post-output-quality form; classifier/locality/reserve deletion steps close as not-executed (evidence contradicts).
4. **E1 escalator: unconditional keeper** — 3-for-3 aim, ~zero cost, always-on.
5. **Plan 82 calibration half: CLOSED, no evidence** — severity flapping never materialized across the measurement rounds.
6. **Breadth question (run 40 comparison): resolved as variance, not mechanism cost** — zero-native's packet is reached and hint-noticed every run; conversion is borderline-judgment variance; run 54's 4-merged group verified as one root cause (merge correct).

Unlocked next: plans 74 and 75-step-1 (small calibration code items). Optional spend: plan 86 step 5 study.

## Decisions needed (not code work until decided)

- [ ] **D8 (eval scorer leniency stack)** — either re-spec matching to include the merged view and delete token-fallback/synonym layers, or revert to strict matching. Decide after Wave 2 baselines show how often leniency actually fires.
- [ ] **D10 (static signals)** — keep-and-document vs delete the two unspec'd rules (`lossy-conversion-before-validation`, `test-boundary-coverage-rewrite` + `test-coverage-delta.ts`); also fix `exported-api-change` unconditional base-side parses if kept.
- [x] **Uncertainty promotion end-state** — DECIDED 2026-07-04: retained (see decision record). Original entry: **(was)** — if Plan-79 repeats show even predicate-only promotions never convert, delete the subsystem (Plan 81 stop-condition governs). EVIDENCE ACCUMULATING: run 53 head-to-head — on the same packet/signal, the promotion was rejected while plan-92's adaptive real draw was kept and matched the expectation. If that pattern holds across the measurement rounds, adaptive replaces promotion and the deletion executes on plan 81's terms.
- [ ] **Planner recovery / safety-deep coverage end-state** — the ~350-line unspec'd subsystem (`planner.ts:295-633`: submit recovery, sparse-plan detection, safety-deep coverage upgrades; fable §2.2) has no simplification plan today. Decide keep-and-spec vs shrink after the Wave-2 baseline shows how often recovery and safety-deep actually fire. (Gap surfaced by codex planning audit, 2026-07-02.)
- [ ] **Intent-signals / behaviorChange capping end-state** — Plan 82 fixes the mechanical `unknown`-demotion bug only; whether the intent-signals + severity-capping subsystem (~250 lines + threading, fable §2.2/D4) shrinks, gets spec'd, or is deleted is decided on Plan-79/82 severity-flap data. (Gap surfaced by codex planning audit, 2026-07-02.)

## Spec-stale ledger (doc notes, no engineering priority — code is source of truth)

From fable §2.2/§2.4, dispositioned as documentation debt, batched into an eventual doc pass: staged artifact layout v2 + manifest; eval `tier`/`llm:`/`expect.*` extensions + fixture materialization; `source {kind:"auto"}` selector; budgetBoost + run-level budget machinery; `maxTimeMinutes` / `--max-time` (2026-07-01); submit-repair ladder design; provider prompt-cache session hints; tool-result cache; adaptive symbol-context budgeting (pending its Wave-4 fate); README spec-path typo; env-var surface note. Divergences where the *code* is wrong are in the waves above instead (D1→80, D3→87, D6→88, bugs→89).

## Drain map (fable §7 → disposition)

| Fable item | Disposition |
| --- | --- |
| P0: failure ladder (D1) | Plan 80, Wave 1 |
| P0: publisher 422 fallback (D6) | Plan 88, Wave 4 |
| P0: fingerprint stability (D7) | Plan 83, Wave 2 |
| P0: severity cap (D4) | Plan 82, Waves 1+4 |
| P0: skip-rules last-match (bug 5) | Plan 89 phase A, Wave 1 |
| P0: scorer crash + `a...b` (bugs 13/14) | Plan 89 phase A, Wave 1 |
| P1: promotion reduction (D2) | Plan 81, Wave 3 |
| P1: pre-clustering exact-only (D3) | Plan 87, Wave 3 |
| P1: human-attention admission (D5) | Plan 75 step 1, Wave 4 |
| P1: shared submit/salvage layer | Simplification backlog, Wave 4 |
| P1: fixed Stage-6 context budget | Simplification backlog, Wave 4 |
| P1: ripgrep fix-or-delete (D9) | Plan 93, complete Wave 4 |
| P1: shared similarity module | Plan 94, complete Wave 4 |
| P2: plan 79 / 76 / 74 / 55 / 75 | Waves 2 / 3 / 4 / 4 / 4 |
| P2: gpt-5.5 study + tool-choice instrumentation | Plan 86, Waves 1+3 |
| P2: Stage-7 ensemble | Plan 84, Wave 3 |
| P3: spec reconciliation | Spec-stale ledger (doc pass) |
| P3: bug sweep (9-20) | Plan 89 phases A/B |
| P3: README paths, eval runId, old-layout replay | 89 phase B; old-layout compare handled in Plan 83 |

New-evidence items with no fable ancestry: Plan 85 (Wave 1, from runs 43/45), `--max-time`/`maxTimeMinutes`/incomplete-review banner (landed 2026-07-01).
