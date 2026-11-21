---
created: 2026-11-19T20:44:03Z
author: lead-dev-2
source: "0xPolygon/codegenie#44, challenge round: response to @architect-2's challenge (20261119-202949-challenge-plan-history-and-competition.md) of 20261119-202300-plan-history.md and 20261119-202647-competitive-landscape.md; mechanism census of 334 stored runs (private evals read with owner approval, aggregates only); code at master f240376"
status: provisional
---

# Response: plan history and competitive research, amended after challenge

This note amends my [plan history](./20261119-202300-plan-history.md) and [competitive study](./20261119-202647-competitive-landscape.md) in response to [@architect-2's challenge](./20261119-202949-challenge-plan-history-and-competition.md). Where the two disagree, this note wins. It also adds the evidence the challenge asked for:
- a durable anchor for every plan row (appendix);
- an aggregate census of how often each mechanism actually fires, from 334 stored runs dated 2026-06-14 to 2026-11-19, 269 of them with a real model;
- the confirmed-bug list handed to @operator.

**Every challenge point is accepted.** I retract none of the history's main findings, and the census strengthens three of them.

## Accepted corrections

| Challenge point | My original claim | Amended claim |
| --- | --- | --- |
| `--preflight-only` is public | "unused, deletion candidate" | **Keep.** It is a declared Action input (`action.yml:58`), documented (README:168), routed by `entrypoint.ts:177–180` and tested (`tests/github-action.test.ts:752`). Removing it would be a public interface change. |
| Skill `categories` | "no consumer, delete" | **Keep the reader.** `skill-loader.ts:324` whitelists the key; dropping it would make existing skills log `skill_unknown_frontmatter_key`. Only unused downstream state could go, verified by loading an existing skill that carries the key. |
| `cacheHits`/`cacheMisses` aliases | "promised removal, delete" | **Keep the readers** (`eval-command.ts:181–182`, `eval-compare.ts:168–169`) for archived artifacts. The writer side may converge on one name, checked by exercising an archived result. |
| Hand-copied env-key table | "pi-ai 1.5.2 exports `getEnvApiKey`" | **Retracted.** The package root exports neither `getEnvApiKey` nor a synchronous `checkAuth` (checked: `typeof` is `undefined` on the root import). The table also places and clears Action keys. Reuse Pi's async `checkAuth` for preflight only (see workstream B). |
| Bare LIVE rows lacked durable anchors | anchors lived in scratch | **Fixed:** every one of the 125 rows has a file:line, commit or empty-rg anchor, re-verified on master (appendix). |
| "Unit-only after August" | stated for all of 111–125 | **Bounded** to the plans whose files record no live run. Plans 123 and 124 record real but uncontrolled reviews. The controlled eval suite has no run after 2026-09-25 (census). |
| "Zero rescues → delete the gate" | proposed kill criterion | **Withdrawn for precision gates.** A gate that blocks false or misplaced publications can show zero rescues by design. Judge it by counterfactual replay with and without the gate, adjudicating changed publications in both directions (harmful publishes and lost true positives). Rescue counts stay valid evidence **only for rescue lanes** (promotion, hatch, adaptive pass). |
| Adaptive pass on in evals, off in product | "eval recall overstates production recall" | **The sign of the bias is unmeasured.** Run the product default with the case overrides pinned to defaults as its own arm, and keep the earlier suite as a separate historical comparison. The census shows this arm has never been run on any version since 0.3.0 (below). |
| Bugbot dropped voting, so K=1 has outside support | competitive bottom line 4 | **Retracted as support.** Bugbot's 8-pass majority vote was a *precision filter* on findings. Codegenie's ensemble *unions* candidates before verification (`lens-runner.ts:380`). A vendor deleting a vote says nothing about deleting a union. The K=1 decision stands on codegenie's own counterfactuals only. |
| "Nobody's fast tier drops verification" | competitive bottom line 2 | **Narrowed.** Warden lets users disable its verification pass ([architecture](https://warden.sentry.dev/architecture/)). Anthropic publishes no verifier ablation by tier, and PR-Agent is single-shot. Keep verification in codegenie's first fast-lane arm because of codegenie's own evidence, not a vendor consensus. |
| Content-keyed incremental review overlaps #30 | fast-lane table | **Separated.** #30 is exact request replay: same head, same request, any working directory. Reuse across new heads keyed on path and body is a different design. An unchanged hunk can gain a caller elsewhere that invalidates an earlier safe judgment. Test the two separately: (a) exact replay across two working directories for one head; (b) a new head that changes a dependency outside an unchanged hunk. |
| Severity gate as a fast lane | listed as a fast-lane lever | **Reclassified.** A publication filter cuts comment volume, not planner, packet or verifier work. Report the calls and time saved separately from the drop in published findings. Cross-vendor percentages use different denominators and cannot rank settings for this harness. |

Corrected outcome tally, re-derived row by row with anchors: **LIVE 60 · LIVE-MOD 45 · REMOVED 7 · REVERTED 2 · SUPERSEDED 2 · NEVER BUILT 5 · SPLIT 3 (75, 101, 122) · ABSENT 1 (103) = 125.** Plans 75 and 122 move from LIVE to SPLIT: each has one part live and one part never built.

## New evidence: mechanism census (aggregates only)

**Method.**
- Corpus: every stored `run.json` with its `events.jsonl`, `model-calls.jsonl` and composition artifacts. That covers local review directories, the private eval logs (read-only, owner-approved) and the public fixture logs.
- Separated out: 65 fixture runs with a scripted model.
- Lower bounds: local run directories keep only the last 20 runs, and CI runs are not stored locally.
- Counting: events are counted by message at the code sites cited. A finding is attributed to a mechanism by its candidate-ID shape:
  - system review: `system-…-fN` (`system-reviewer.ts:250`);
  - promotion: `…-uN-<hash>` (`uncertainty-promotion.ts:445`);
  - adaptive pass: `…-a2fN` (`lens-runner.ts:928`).

| Question | Result (269 real-model runs unless stated) |
| --- | --- |
| Is the shipped default measured? | **No.** 0 eval runs on 0.7.0 or 0.8.0, and the last scored eval run was 2026-09-25. All 126 real-model eval runs after 2026-07-05 carry behaviour overrides; 114 of them have the adaptive pass on. Every one of 215 eval runs pins the lens set, while the product lets the planner choose. Runs at product defaults: 53 unscored local reviews, of which only 6 used Claude. |
| Stage 8 (cross-packet system review) | Skipped in 246 of 256 runs that reached it ("no repeated follow-up hints"). It ran in 10, all on 2026-06-18 on a pre-0.1.0 build: 46 model calls (0.15% of 29,813), **0 candidates, 0 final findings**. Its only output was 17 follow-up hints marked resolved. No model call since. |
| Promotion lane | 4,692 sources considered → 484 promoted → 98 kept by the verifier (20.4%) → **18 published on promotion evidence alone (3.7% of promoted)**, plus 45 published merged with a packet finding. 57 of 257 runs had at least one published finding involving a promotion. |
| Low-confidence hatch (plans 47/109) | 22 findings reached it: 13 published, 9 suppressed. The summary-only branch never fired. **It has not fired at all in the 55 runs on 0.6.1–0.8.0.** |
| Caps that bind | The promotion limit bound in **173 of 257 runs (67%)**, leaving 2,115 sources unrepresented; it is effectively the only binding cap. The adaptive cap bound in 32 of 118 adaptive-on runs. The verifier evidence lane, verifier budget and ensemble packet cap **never bound**. |
| Adaptive second pass | When on, it found 15 issues no other pass found. |
| Other rates | Schema repairs in 58% of runs (median 1). Composer fallback 5.9%. Test-coverage escalation 10.3%. Outcomes: 78.8% full, 15.6% partial, 5.6% failed (10 run-fatal failures, all on 0.6.1 or older). |

**What this changes in the history's recommendations.**
1. **Stage 8 becomes a deletion candidate.** In this corpus it has been dead for five months. Per the challenge, adjudicate its one output type first: were the 17 "resolved" hints true resolutions that kept noise out of the report? If so, decide whether that small effect justifies the stage.
2. **The promotion lane is a rescue lane, so rescue counts apply.** It contributed 18 sole-evidence publications from 484 admissions, at 366 verifier rejections of verifier work. Its limit binds in two thirds of runs, so the lane is saturated and low-yield at once. That is a measured cost/benefit question for the owner, not a deletion on my say-so.
3. **The hatch has been dormant since 0.6.1.** It is a rescue lane with no recent rescues. Check whether 0.6.1 changes made it unreachable, the earlier "dead hatch" mechanism, before treating dormancy as safety.
4. **Step 0 of any measurement is a scored baseline of the shipped default.** Without it, every lane and gate comparison is against a configuration users do not run.

## Confirmed code bugs from workstream D (survived the challenge round)

All of these were confirmed by reading code at master. None is disputed by @architect-2's challenge, which disputed deletions, not bugs. Severity and size are my estimates.

| # | Bug | Location | Failing state → wrong outcome | Evidence | Size |
| --- | --- | --- | --- | --- | --- |
| D1 | Adjudicated-reject suppression event nested in the wrong block | `src/pipeline/human-attention.ts:283–302` | A Stage-9 reject suppresses a note while no final finding suppresses any note → the `human_attention_hints_suppressed_by_adjudicated_reject` event is never emitted | Read independently in two batch audits and re-read by me; no test asserts the event | S |
| D2 | Recovery-inventory overflow is run-fatal outside Stage 7 | `src/llm/pi-runner.ts:312–314, 712–714` (`recoverable: false`); rethrown at `src/pipeline/planner.ts:257` and `src/pipeline/verifier.ts:371` (Stage 7 exempts schema-invalid at `lens-runner.ts:139`) | A planner or verifier submission over 200,000 serialized chars, or more than 128 open recovery obligations → the whole run fails instead of degrading that stage (plan 111's trust matrix) | `isRunFatalLlmError` = LLM failure and `recoverable !== true` (`pipeline-utils.ts:5–7`); not reproduced live | S–M |
| D3 | Field-repair rejection copies Pi's raw "Received arguments" payload into telemetry and the repair prompt | `src/llm/pi-runner.ts:678–684` | A field repair fails validation → `field_repair_rejected` event and `scheduleModelRepair` error carry the full rejected JSON. Other sites strip it: `pi-runner.ts:2212`, `schema-diagnostics.ts:40`, `stage7-submit-repair.ts:193` | Pi 1.5.2 message format at `dist/utils/validation.js:59`; the real adapter routes to it (`pi-runner.ts:1020`) | S |
| D4 | Verifier repair classifier ignores `findingUpdates` | `src/pipeline/verifier.ts:1110–1116` | A `revise` whose only payload is `findingUpdates` fails validation for another reason → classified `revise_without_revision_payload` → wrong repair instruction and an inflated `empty-revision` eval subreason | Read by a batch audit and by me; `findingUpdates` was added as a revise payload in 0.6.0 | S |
| D5 | Model-call cache fingerprint includes the absolute repository path and operational settings | `src/pipeline/review-runner.ts:844–869` | Same head and request run from another checkout or worktree, or with only `concurrency` / `maxConcurrentCalls` / timeouts changed → no replay. Eval fixtures run from per-run directories, so they never reuse | Code read by me. Plan 35 step 5 intended cross-run reuse. Candidate cause of **#30**, whose exact same-path case is not explained by this alone | S–M |
| D6 | Mislabelled planner telemetry | `src/pipeline/planner.ts:587–588` | Safety coverage upgrades N hunks → `upgradedPackets` reports N hunks | Read by me | S |
| D7 | README model example is stale | `README.md:28` | `provider use opus` → `claude-opus-5-5`, but the README says `claude-opus-5` | dist CLI run in workstream B's verification | S |

**Disputed or unconfirmed: need a repro before an issue.**
- **H1.** The composition primary-call allowance throws run-fatal (`pi-runner.ts:1283–1284` → `composer.ts:127–136,796–798`). The code path is confirmed, but whether a third primary composition call can occur is not.
- **H2.** `isCompositionTestPath` does not match `*_test.go` (`src/util/path-roles.ts:13–18`), while the other test-path dialects do. A test pins this (`tests/shared-utils.test.ts:52`), so it may be deliberate. **Decision needed.**
- **H3.** Repo-wide 40-hit symbol search is truncated before the changed-file filter (`packet-builder.ts:796–805`, `repo/search.ts:47–62`).
- **H4.** A recovered plan that is deliberately sparse is forced deep and gets a false "planner failed" banner (`planner.ts:334,367,558–566`).
- **H5.** `review-health.ts:52–59` may mark health failed for benign tool errors.
- **H6.** The promotion security regex matches `token` (`uncertainty-promotion.ts:758`).

## Appendix: per-plan outcome and durable anchor (master f240376)

| Plan | Outcome | Anchor |
|---|---|---|
| 1 | LIVE | `src/llm/pi-runner.ts:183` `MAX_DEBUG_ARTIFACT_CHARS` |
| 2 | LIVE | `src/telemetry/telemetry-recorder.ts:56` `billableInputTokens` |
| 3 | LIVE | `src/pipeline/packet-builder.ts:1681` `no_enclosing_symbol` |
| 4 | LIVE | `src/pipeline/packet-builder.ts:1320` `default_coverage` |
| 5 | LIVE-MOD | `src/types.ts:482` `ReviewProfile` |
| 6 | LIVE-MOD | `src/types.ts:1810` `RunOutcomeStatus` |
| 7 | LIVE | `src/pipeline/verifier.ts:51` `VERIFIER_EXPECTED_CALLS_PER_CANDIDATE` |
| 8 | LIVE | `src/pipeline/composer.ts:763` `groupFindings` |
| 9 | LIVE | `src/pipeline/human-attention.ts:23` `MAX_HUMAN_ATTENTION_NOTES` |
| 10 | LIVE | `src/pipeline/composer.ts:1844` `normalizeFinalBodyForRendering` |
| 11 | SUPERSEDED | `src/pipeline/packet-builder.ts:2585` stage6_read_range_skipped (plan 18) |
| 12 | LIVE | `src/repo/static-signals.ts:10` `GO_NARROWING_TYPES` |
| 13 | LIVE | `src/github/publisher.ts:105` `validateDiffAnchor` |
| 14 | LIVE | `src/types.ts:364` `baseOnly` |
| 15 | LIVE | `src/types.ts:1356` `localModelCallCache` |
| 16 | LIVE-MOD | `src/evals/eval-scoring.ts:1659` `sourceCandidatesForFinal` |
| 17 | LIVE | `src/llm/pi-runner.ts:2900` `planner_schema_repair_scheduled` |
| 18 | LIVE | `src/pipeline/packet-builder.ts:2606` `stage6_read_range_clamped` |
| 19 | LIVE-MOD | `src/pipeline/human-attention.ts:210` `human_attention_hints_grouped` |
| 20 | SUPERSEDED | `src/pipeline/verifier.ts:1816` exact_text rule (plan 87) |
| 21 | LIVE | `src/pipeline/system-reviewer.ts:34` `MAX_SYSTEM_REVIEW_TASKS` |
| 22 | LIVE | `src/cli/review-command.ts:104` --cache help text |
| 23 | LIVE-MOD | `src/pipeline/verifier.ts:53` `EVIDENCE_RESOLUTION_LANE_MAX` |
| 24 | LIVE-MOD | `src/pipeline/uncertainty-promotion.ts:16` `MAX_PROMOTIONS` |
| 25 | LIVE | `src/pipeline/verifier.ts:49` `reservedSourceResultChars` |
| 26 | LIVE-MOD | `src/config/schema.ts:56` `budgetBoost` |
| 27 | LIVE | `src/pipeline/review-runner.ts:457` maxConcurrentCalls override |
| 28 | LIVE | `src/util/context-pressure.ts:1` context-pressure summary |
| 29 | REMOVED | `8cbe1ce` sourceExtensionState deleted |
| 30 | LIVE | `src/pipeline/human-attention.ts:307` `human_attention_hints_suppressed_by_verification` |
| 31 | LIVE | `src/pipeline/intent-signals.ts:80` `IntentSignals` |
| 32 | LIVE-MOD | `src/pipeline/packet-builder.ts:1888` `computeSymbolContextBudget` |
| 33 | REMOVED | `547d2fb` compactFinalize deleted (plan 43) |
| 34 | LIVE | `src/llm/tool-result-cache.ts:33` `createToolResultCache` |
| 35 | LIVE | `src/pipeline/system-reviewer.ts:100` `system_review_skipped` |
| 36 | LIVE-MOD | `src/pipeline/human-attention.ts:50` `invalidPathCount` |
| 37 | LIVE-MOD | `src/pipeline/verifier.ts:869` replaceConversation: false |
| 38 | LIVE-MOD | `src/pipeline/review-runner.ts:549` `concurrency_mismatch` |
| 39 | LIVE-MOD | `src/llm/pi-runner.ts:1124` `provider_prompt_cache_strategy` |
| 40 | LIVE-MOD | `src/pipeline/uncertainty-promotion.ts:242` test-lane promotion guard |
| 41 | LIVE-MOD | `src/evals/eval-scoring.ts:1429` merged-candidate match view |
| 42 | LIVE | `src/pipeline/packet-builder.ts:1607` `SymbolContextBudgetMode` |
| 43 | LIVE | `src/repo/test-coverage-delta.ts:77` TestCoverageDelta builder |
| 44 | LIVE | `src/pipeline/uncertainty-promotion.ts:939` `isConcreteBehaviorDeltaSource` |
| 45 | LIVE-MOD | `src/pipeline/composer.ts:67` `deterministic_fallback` |
| 46 | LIVE | `src/util/runtime-provenance.ts:21` `resolveCodegenieRuntimeProvenance` |
| 47 | LIVE-MOD | `src/pipeline/composer.ts:1736` `publish_summary_only` |
| 48 | LIVE | `src/pipeline/uncertainty-promotion.ts:264` `local_behavior_delta_reserve` |
| 49 | LIVE | `src/pipeline/planner.ts:270` `emitPlannerProjectionTelemetry` |
| 50 | LIVE-MOD | `src/pipeline/lens-runner.ts:866` test-tool gate regex |
| 51 | LIVE-MOD | `src/pipeline/composer.ts:448` replaceConversation: false |
| 52 | LIVE | `src/llm/stage7-submit-repair.ts:192` `classifyStage7SchemaInvalid` |
| 53 | LIVE-MOD | `src/pipeline/human-attention.ts:648` `mergeNearDuplicateAttentionGroups` |
| 54 | LIVE | `src/types.ts:1369` `deterministicSchemaRecovered` |
| 55 | NEVER BUILT | `rg -n "ReviewDisposition\|reviewDisposition\|FileRole\|fileRole\|context_only\|contextOnlyHunks\|reviewTargetHunks\|intent_context\|intentContext" src` → no matches |
| 56 | REMOVED | `d322dda` reviewQuestions removed (plan 66) |
| 57 | LIVE | `src/pipeline/packet-builder.ts:2375` `resolveCallSiteContextHint` |
| 58 | LIVE | `src/pipeline/packet-builder.ts:2546` `callSiteHintWarning` |
| 59 | LIVE | `src/pipeline/planner.ts:73` `MISPLACED_PLANNER_ROOT_KEYS` |
| 60 | REMOVED | `d322dda` planner_review_questions_synthesized removed (plan 66) |
| 61 | LIVE-MOD | `src/pipeline/system-reviewer.ts:228` rawTasks (hint tasks only) |
| 62 | LIVE-MOD | `src/llm/stage7-submit-repair.ts:499` `stripStage7Markup` |
| 63 | REMOVED | `d322dda` assignReviewQuestionOwnership removed |
| 64 | REMOVED | `d322dda` questionFollowUpGroups removed |
| 65 | REMOVED | `d322dda` review_question_obligation_attached removed |
| 66 | LIVE-MOD | `src/pipeline/system-reviewer.ts:363` `repeatedHintGroups` |
| 67 | LIVE-MOD | `src/pipeline/packet-builder.ts:665` `buildHunkRelationshipGraph` |
| 68 | LIVE-MOD | `src/pipeline/human-attention.ts:868` `attentionGroupMatchesProvenance` |
| 69 | LIVE-MOD | `src/pipeline/planner.ts:568` `applyPlannerSafetyCoverage` |
| 70 | LIVE | `src/pipeline/composer.ts:1011` `selectPublicationAnchor` |
| 71 | LIVE | `src/pipeline/planner.ts:452` `recoverWrappedPlannerSubmit` |
| 72 | LIVE | `src/pipeline/packet-builder.ts:497` `mergeAttentionNotes` |
| 73 | LIVE | `src/pipeline/uncertainty-promotion.ts:19` `MAX_RELATED_CONTEXT_EVIDENCE` |
| 74 | LIVE-MOD | `src/pipeline/composer.ts:874` `selectMergedConfidence` |
| 75 | SPLIT | `src/pipeline/human-attention.ts:76` stage9_adjudicated_reject (step 1; step 2 never built) |
| 76 | LIVE-MOD | `src/pipeline/verifier.ts:1382` `isEvidenceBackedLowConfidenceCandidate` |
| 77 | REVERTED | `c89d8eb` "revert 77" |
| 78 | LIVE-MOD | `src/evals/eval-artifacts.ts:226` readOptionalArtifact (root fallback) |
| 79 | LIVE | `src/evals/eval-runner.ts:537` `runRepeatedLiveCase` |
| 80 | LIVE-MOD | `src/pipeline/pipeline-utils.ts:5` `isRunFatalLlmError` |
| 81 | LIVE-MOD | `src/pipeline/uncertainty-promotion.ts:456` `promotedTitle` |
| 82 | LIVE | `src/pipeline/severity-policy.ts:18` `applySeverityPolicy` |
| 83 | LIVE | `src/pipeline/composer.ts:1967` `fingerprintFinding` |
| 84 | LIVE-MOD | `src/pipeline/lens-runner.ts:215` `ensemblePassesForPacket` |
| 85 | LIVE-MOD | `src/util/budget.ts:9` `finalizeGraceMs` |
| 86 | LIVE-MOD | `src/llm/pi-runner.ts:2015` `describeProviderProtocol` |
| 87 | LIVE | `src/pipeline/verifier.ts:1851` `isExactDuplicateCandidate` |
| 88 | LIVE | `src/github/publisher.ts:249` `fallback_summary_only` |
| 89 | LIVE | `src/evals/eval-artifacts.ts:43` `missingArtifacts` |
| 90 | LIVE-MOD | `src/config/schema.ts:57` `maxBudgetTokens` |
| 91 | LIVE-MOD | `src/llm/pi-runner.ts:4289` `resolveProviderAuth` |
| 92 | LIVE-MOD | `src/pipeline/attention.ts:19` `buildAttentionRecords` |
| 93 | LIVE | `src/repo/search.ts:7` `SearchEngine` |
| 94 | LIVE | `src/util/path-roles.ts:43` `isDocsPath` |
| 95 | LIVE | `src/llm/stage7-submit-repair.ts:530` `stage7RecoverInvalidSubmit` |
| 96 | NEVER BUILT | `rg -n -F symbol_context_truncated src` → no matches |
| 97 | LIVE-MOD | `src/github-action/status-comment.ts:59` `DEFAULT_MIN_EDIT_INTERVAL_MS` |
| 98 | LIVE-MOD | `src/repo/tree-sitter/tree-sitter-service.ts:51` `GRAMMAR_WASM` |
| 99 | LIVE | `src/repo/tree-sitter/rust-adapter.ts:422` "impl target" sentinel |
| 100 | LIVE | `src/git/diff-parser.ts:432` `allocateShortHunkIds` |
| 101 | SPLIT | `src/pipeline/verifier.ts:589` `verifier_skill_provenance` |
| 102 | REVERTED | `rg -n "packSameFileHunks\|packedToolBudgetMode\|same_file_atoms_packed\|profileFloor" src scripts tests evals` → no matches (built and torn down off master; never merged) |
| 103 | ABSENT | `git ls-tree --name-only master specs/plans/ \| grep 103` → no matches (plan file never on master) |
| 104 | NEVER BUILT | `rg -n "DelegatePendingSignal\|awaiting_delegation\|createDelegateRunner" src action.yml package.json` → no matches |
| 105 | NEVER BUILT | `rg -n "BenchmarkFinding\|bench-command" src` → no matches |
| 106 | LIVE-MOD | `src/pipeline/verifier.ts:776` `verification_keep_payload_canonicalized` |
| 107 | LIVE | `src/pipeline/uncertainty-promotion.ts:346` `associateRelatedPromotionSignals` |
| 108 | LIVE | `src/pipeline/verifier.ts:664` `verification_severity_revision` |
| 109 | LIVE | `src/pipeline/composer.ts:1617` `LowConfidenceBehaviorDeltaOutcome` |
| 110 | LIVE | `src/pipeline/human-attention.ts:323` `human_attention_publication_fallback` |
| 111 | LIVE-MOD | `src/llm/schemas.ts:215` `VERIFIER_REASON_HARD_MAX_CHARS` |
| 112 | LIVE-MOD | `src/llm/final-tool-arguments.ts:214` `repairJson` |
| 113 | NEVER BUILT | `rg -n "predicateDisposition\|direct_reject\|directReject" src` → no matches |
| 114 | LIVE | `tests/phase4-llm.test.ts:3542` untrusted-submit append mode test |
| 115 | LIVE-MOD | `src/llm/submit-preservation.ts:165` `preservationViolations` |
| 116 | LIVE-MOD | `src/llm/submit-preservation.ts:44` `cleanupSubmitShape` |
| 117 | LIVE-MOD | `src/pipeline/composition-content.ts:206` `composePresentation` |
| 118 | LIVE | `src/pipeline/composition-content.ts:343` "Secondary assumption:" fallback |
| 119 | LIVE | `src/pipeline/composition-content.ts:65` `eligibleCompositionSource` |
| 120 | LIVE | `src/llm/verifier-revision.ts:7` `PROMOTED_COMPLETION_FIELDS` |
| 121 | LIVE-MOD | `src/pipeline/attention-reconciliation.ts:11` `MAX_ATTENTION_RECONCILIATION_CHARS` |
| 122 | SPLIT | `src/util/adaptive-review.ts:4` summarizeAdaptiveReviews (C2 never built) |
| 123 | LIVE | `src/util/review-health.ts:16` `deriveReviewHealth` |
| 124 | LIVE | `src/pipeline/composer.ts:1414` `crossFileRootCauseGroupsMatch` |
| 125 | LIVE | `src/github-action/models.ts:135` `selectModel` |
