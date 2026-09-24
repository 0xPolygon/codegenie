# Issue 120: Verifier Completion and Faithful Fallback

Status: IMPLEMENTED — local validation and review complete; post-change live comparison pending, 2026-09-23 (America/Toronto)
Depends on: Plans 117–119; existing verifier revisions, proof assessments, source accounting and bounded recovery

## Objective

Publish completed findings and composition prose rather than placeholders, keep fallback reports readable without losing evidence, and distinguish successful output recovery from proven content preservation. Tighten verification and composition around the caller's established requirement instead of adding assessment fields or another judging stage.

Retain plan 119's supported-advice publication controls and historical proposal provenance. Run 100 demonstrates their value; run 99 exposes weaknesses they cannot solve on their own.

## Evidence and limits

All comparison runs below reviewed the expected rounding defect and passed their configured eval checks. Those checks do not establish recommendation correctness, absence of false positives, or successful semantic composition.

| Run | Configuration | Elapsed | Candidates / kept or revised | Composition | Published findings | Words outside expandable details |
| --- | --- | --- | --- | --- | --- | --- |
| 97 | GLM max, before 119 | 20m23s | 9 / 5 | First attempt, 135s | 1 | 1,361 |
| 98 | DeepSeek max, before 119 | 15m06s | 9 / 7 | First attempt, 258s | 1 | 1,409 |
| 99 | GLM max, after 119 | 29m21s | 12 / 10 | Two 300s timeouts; fallback | 5 | 3,492 |
| 100 | DeepSeek max, after 119 | 23m57s | 12 / 10 | 300s timeout, then success in 263s | 3 | 1,947 |
| 101 | Opus 5 high via OpenRouter, before 120 | 9m17s | 12 / 9 | 61s initial submission + 46s repair | 3 | 1,712 |

These are observational comparisons, not controlled attribution to plan 119. Both newer runs generated more candidates upstream. Run 100's successful composition was nearly as fast as run 98's; the failed first attempt accounts for five minutes of additional latency. Run 99's attempts streamed 102,278 and 85,068 reasoning characters without submission arguments; run 100's failed attempt streamed 280,103. These were active-generation timeouts, not eight-to-ten-minute silent network waits. Timeout artifacts retain progress statistics, not the reasoning text needed to diagnose a particular reasoning loop.

Run 99 recorded $0.3899 and run 100 $0.5076, excluding unknown usage for cancelled composition calls. Do not present these as complete billed costs.

### Run 99: concrete failures

- **Promoted investigation not completed in structured fields.** For `db6512fa-u2-5bcf0db1`, the verifier's reason described a revised testing/low/medium finding but the raw submission supplied only `revisedAnchor`. The provisional correctness/medium/low fields and conditional investigation text survived. The publication gate accepted them, and title normalization selected the renderer banner, “Source-based presentation; synthesis was unavailable.”
- **Conflicting prompt guidance.** The verifier instructs confirmed promoted predicates to update “only changed confidence, evidence, and verification fields,” although their title, failure mode, impact, category and severity can be provisional too. This restriction and body-derived title selection predate plan 119. The trace establishes omitted updates, not that this instruction alone caused them.
- **Fallback verbosity.** The main group retained six complete proof assessments prominently. Its verification section contains 1,264 words; its primary finding contains 1,465. Full proof narratives are also available in expandable provenance. The renderer currently selects every proof with assumptions and prints its entire evidence narrative.
- **Observation mistaken for defect proof.** The commit-description finding's failure mode explicitly says “Not an independent defect,” yet it is published. Another verifier narrowed a missing-test claim to selected early tests while leaving the package-wide title/impact intact and treating unread tests as secondary. A separate verifier read dedicated cross-decimal tests and rejected an equivalent absence claim.
- **Incorrect supported recommendation.** One verifier endorsed lowering the promised output; another left a differently worded proposal unverified because it could violate the original request. Both the text and status differ, so the existing exact-proposal supported/incompatible conflict check does not apply. All required structural support fields were present in the incorrect endorsement; accepting it was not a schema-validation bypass.
- **Positive retention result.** All 91 source components were accounted for. Eleven unverified advice sources stayed in provenance; two model-endorsed sources were prominent. Source accounting is not semantic proof.

### Run 100: improvements and remaining limits

- All 12 candidates completed verification; three repairs succeeded in 18.2s, 10.1s and 2.3s. Composition's retry passed validation without repair or attribution cleanup and accounted for all 98 sources.
- A verifier replaced a compound fix with a ceiling-conversion remedy preserving the requested output. Two historical proposal sources remained in provenance. Four supported advice sources were published; seventeen unverified sources were retained outside prominent recommendations.
- The main finding shrank from approximately 1,031 words in run 98 to 773. The whole report grew because two additional findings were published, not because the main explanation became longer.
- A fail-closed rejection of tiny positive amounts survived as a defect without establishing a requirement to quote those amounts successfully. The verifier treated uncertainty about intended rejection behavior as secondary, although it can determine whether a defect exists.
- The final test explanation claimed that `promise <= delivery` rejects lowering the promise, which is false. Later clauses restored the original-request check, improving the overall guidance but leaving an inconsistent explanation. The general requirement-preservation problem remains; no numeric formula belongs in production validation.
- Recovery fidelity was reported as `preserved` despite two invalid/partial final-argument submissions being regenerated. The scorer recognizes `recovery_unusable_submission` and `recovery_content_revised` but misses this other existing rejection path. Valid replacements do not prove preservation of unreadable drafts.

### Run 101 versus Opus run 67: completed execution, weaker report

- Run 101 completed all verification with 78 calls, $9.4839 recorded cost, no timeouts and all 85 source components accounted for. Run 67 took 11m51s and 120 calls ($10.7066), publishing two findings in 1,329 words. It used Anthropic directly and a 4× budget multiplier; 101 used OpenRouter and 1×. Verification fell from 7m26s to 3m49s and tool-budget rejections rose from one to eight. Reduced investigation is a plausible contributor, not proof that one harness change caused the quality difference. Both runs' forced-submit composition calls disabled thinking despite configured `high`; this plan does not change that protocol.
- **Incomplete caller requirement.** Run 101 endorsed lowering the promised output after establishing only that the promise must be deliverable. The final report also quoted the caller's requirement that the minimum satisfy the original request, but published the remedy with a caveat instead of withholding it. Run 67 explicitly rejected that alternative and recommended ceiling the transfer. Existing plan-119 guidance already addresses requirement preservation; consolidate and clarify it rather than append another checklist.
- **Unfinished composition passed validation.** Initial composition call `mc-000077` returned literal `placeholder` section text. Validation reported invalid reconciliation references and an omitted finding. Repair `mc-000078` fixed those issues and the main group's prose, but its sparse update left the testing finding's impact and verification placeholders intact. Valid references allowed the merged result to pass. The source explanation remained in provenance; primary prose was unfinished. This is distinct from provisional promoted findings and does not justify disabling sparse merging.
- **Conflicting judgments remain.** One verifier rejected a documentation arithmetic claim while another accepted a related version. The report published the accepted version. Sharing rejected evidence remains deferred; do not resolve semantic disagreements by vote or treat every related finding as an exact duplicate.

Private evidence: `logs/{67,97,98,99,100,101}/info.json`, `codegenie-review.out.md`, and `telemetry/{events.jsonl,model-calls.jsonl,debug/llm-calls,stages/09-verification,stages/10-composition}` under the trails-api `49f4645b` eval. Use sanitized fixtures in the repository, not copies of private source or reports. Dirty commit identifiers alone do not identify the exact running worktree.

## Already implemented before plan 120

These are prerequisites to measure, not new implementation tasks:

- Fixed budget-rejection messages remain visible outside the source-content character budget, explicitly distinguishing an unexecuted lookup from a successful zero-match search. Rejected calls still consume call allowance; source reserves remain available.
- `[review] compositionReasoningStepDown` defaults to false. Positive/negative review CLI flags override it. When enabled, composition and its retry use the next lower supported model level; verification stays configured and repairs stay lowest-supported. Call traces record the selected policy and level.

Neither run 99 nor run 100 includes these later changes; run 101 does. Preserve the existing 300-second composition attempts, one retry, 780-second outer composition allowance, shared 180-second repair budget, and overall cancellation semantics.

## Scope and design

### 1. Complete promoted findings before publication

Use host-owned `provenance.source === "uncertainty_promotion"` to identify synthetic investigation candidates. Do not infer this state from English prefixes, candidate IDs or repository paths.

For these candidates, a publishable verdict must explicitly supply the final issue title, failure mode, impact (`whyThisMatters`), verification conclusion, category, severity and confidence through existing `findingUpdates` or `finalFinding`. These fields originate as investigation placeholders or provisional classifications; explicit choices are necessary even when a value is retained. Existing evidence can be reused without reproduction. Anchors remain optional and use their existing validation path.

- Remove the prompt's restriction to confidence/evidence/verification updates. Explain that prose in `reason` is not a patch and that a promoted question must become a concrete issue statement.
- Validate explicit completion on the trusted model submission assembled across repair patches, before expansion merges in candidate defaults. A sparse repair may add only the missing fields; it must not resend decisions already supplied in the retained submission. Inherited candidate values do not count as explicit decisions. Validate the expanded finding afterward as today.
- Reuse one small completion check in the runner's semantic validation and the verifier's defensive normalization, before revision expansion in both paths. Preserve rejection canonicalization and existing handling of `keep` with supplied revisions. Direct adapters and cached responses must not bypass completion checks.
- Route missing completion fields through existing semantic validation and bounded repair, naming the exact missing fields. Accept compact updates; do not require a full finding, new model-authored fields, new attempts, or another investigation.
- A rejected or unresolved candidate needs no completed finding. Preserve its existing uncertainty handling. If required completion still fails after bounded recovery, report verification incomplete honestly and retain the investigation in artifacts; do not publish it or silently turn it into a clean rejection.
- Ordinary findings may still receive anchor-only revisions. Confirmed promoted findings can remain summary-only when placement is unavailable. Do not demand a recommendation or higher confidence to publish a proven defect.

The deterministic check establishes that the model supplied the required decisions, not that its prose is substantively correct. Do not parse `reason` to manufacture title, severity, category or other updates.

### 2. Render concise, faithful fallback reports

Keep source-based fallback; do not add another model call or silently remove findings because synthesis failed.

- Use the representative's structured issue explanation and current verification text for primary prose. Display outstanding proof status and conditions without appending every full proof-evidence narrative.
- Keep all distinct unresolved conditions visible, including essential conditions verbatim. Deduplicate exact repeated conditions only. Do not infer semantic equivalence or hide a material caveat to meet a word target.
- Preserve every original proof, candidate assessment, evidence component, proposal, status and source ID in expandable provenance. Continue full source accounting and supported-only advice eligibility.
- Project proof status and conditions into host-rendered verification text while retaining the existing proof source IDs and full provenance. Existing validation requires visible references for unresolved conditions, not verbatim reproduction of every proof narrative; retain that contract without new source kinds or weaker validation. Avoid exact repeated conditions across verification and the appended open-conditions section as well.
- Keep unresolved essential proof evidence visible where it is necessary to explain the uncertainty. Do not label contradictory originals as a reconciled conclusion; fallback has performed no semantic adjudication.
- Derive fallback titles from structured finding content, never renderer banners, section labels or generic process descriptions. Keep synthesis notices in the body. Scope this change to fallback title derivation; preserve successful composition's title behavior. For an ordinary or legacy finding without a usable factual alternative, retain its original title and the source-based notice rather than inventing a title, dropping the finding, or adding a renderer rejection gate. Completion of newly promoted findings belongs to the verifier rule above.

The run-99 six-proof fixture should produce a materially shorter primary report while preserving its source inventory and visible conditions. Do not truncate narrative by character count or force distinct issues together merely because they share a helper.

### 3. Clarify defect proof before confidence and advice

Revise and consolidate existing verifier guidance rather than adding another checklist or schema:

1. Establish the candidate's trigger, behavior and violated observable requirement. A new behavior, disagreement with a commit title, or a newly rejected input is not sufficient by itself.
2. Classify open questions before confidence calibration: if a plausible answer would eliminate the defect, the question is essential. Only uncertainty that cannot overturn the defect can be secondary.
3. For absence claims, narrowing to a selected subset does not establish an actionable gap if uninspected scope could already supply the required protection. Use a focused remaining lookup or retain the uncertainty; do not relabel it secondary after budget exhaustion.
4. Revise every dependent structured field when narrowing a claim. Keep recommendation assessment independent of defect proof. Ask whether a remedy removes the symptom by weakening the caller's original requirement; internal consistency alone is insufficient. Prioritize a relevant caller/contract check over repeated local confirmation, within the existing budget and using already supplied evidence when sufficient. If compatibility remains unresolved, leave the remedy unverified. Tests must preserve the original requirement as well as distinguish the defect, while accepting valid alternative fixes.

Keep the existing optional recommendation assessments and exact-text binding. Do not promote optional omissions into repair obligations. Preserve the principle that a valid defect can survive an unverified remedy.

Do not implement phrase matching for “not an independent defect,” arithmetic checks specific to this eval, fuzzy proposal conflict detection, or automatic truth judgments from prose. Sanitized fixtures should include an unrelated authorization or validation case, with paired examples of permitted rejection and rejection that violates an established contract. Prompt tests prove the instruction exists; only live review assesses model compliance.

### 4. Report recovery fidelity honestly

Reuse existing `final_arguments_rejected` telemetry to mark discarded, untrusted submissions as unproven fidelity. Cover its `invalid`, `partial`, `length_stopped`, `event_capture_missing` and `event_final_mismatch` states, not only the two states observed in run 100. Teach the scorer about the existing event path rather than inventing another audit stream or preservation protocol. Cover all affected structured stages and inspect cache/debug behavior.

- Successful regeneration can complete a review while fidelity remains `unknown`; a later successful response does not erase an earlier unproven recovery.
- Preserve scoring precedence: incomplete/legacy telemetry or an unfinished run yields `unknown`; with complete telemetry, open preservation obligations yield `unresolved`, then unproven recovery yields `unknown`, otherwise fidelity is `preserved`.
- Trusted missing-field repair with demonstrated preservation can remain `preserved`.
- Incomplete/legacy telemetry remains conservatively unknown. Do not claim preservation based solely on a successful replacement or a terminal run event.
- Do not execute or merge untrusted argument fragments to obtain a stronger fidelity label. Keep original artifacts and rejected-argument provenance rules intact.
- Replay scoring may correct a result when explicitly invoked; implementation must not rewrite historical run artifacts or the private eval expectations.

### 5. Require finished composition and consistent advice

Add a narrow completion check to existing composition semantic validation. Reject empty text and explicit scaffold-only section values, such as an entire section containing `placeholder`, using a small documented set of whole-value markers. Do not reject ordinary prose or quoted evidence merely mentioning a marker, impose word-count thresholds, or claim to detect arbitrary weak writing.

- Collect exact paths for all unfinished sections across groups, alongside other validation errors, so repair can address them together. Reuse bounded sparse repair and validate the entire merged composition afterward; fixing references or one group's prose cannot clear another group's unfinished sections. Preserve valid retained text and source inventories.
- Gate the specialized attribution/advice repair on completed prose. When unfinished sections coexist with reference errors, use the existing general sparse repair with all relevant diagnostics; do not enter a reference-only repair that forbids changing those sections, or lock unfinished impact/verification text during advice repair. Pure attribution repair retains its current narrow permissions. Run the same completion validation on direct, repaired and cached acceptance paths.
- If bounded recovery cannot produce a valid composition, use the existing source-based fallback and its honest mode accounting. Retain verified findings and evidence; never publish scaffolding, silently drop a finding, or add recovery attempts. This adds no new partial-fallback subsystem.
- Consolidate the existing composition instruction to check proposed advice against all supplied evidence relevant to its caller requirement. A source's `supported` label does not settle a contradiction elsewhere in the supplied evidence. If the conflict cannot be resolved, omit prominent advice, retain the proposal and assessments in provenance, and explain the unresolved compatibility in verification using existing sections/reconciliations. A caveat cannot authorize disputed advice. Do not invent a replacement fix or mutate verifier assessments.
- Keep reference rules explicit: fix/test sources stay in provenance when advice is withheld; they do not become verification-section or reconciliation targets. Reconciliation targets must remain verification sources, and supporting references must belong to the composed group's inventory. Explain uncertainty using valid existing verification references; do not borrow another group's IDs or merge independent findings merely to make a citation legal. Cross-group evidence transport remains deferred.

The completion check is deterministic; resolving semantic contradictions remains a model task in the existing composition call. Preserve current exact-proposal eligibility checks. No fuzzy conflict classifier, new schema fields, additional judge, or claim of guaranteed recommendation correctness is introduced.

## Implementation sequence and likely files

1. Add sanitized failing tests for promoted completion, unfinished composition surviving sparse repair, fallback title/proof rendering, and untrusted-final-argument fidelity accounting.
2. Implement the promoted-candidate completion rule in the verifier's existing validation/repair path and remove the contradictory instruction. Review direct, repaired and cached verdict acceptance together.
3. Add composition completion diagnostics and complete merged-output validation; update fallback rendering/title selection. Verify complete source accounting, visible uncertainty, supported advice and historical provenance, including exhausted repair.
4. Correct fidelity scoring using existing telemetry and add positive/negative replay cases.
5. Consolidate proof/absence, caller-requirement and composition-consistency guidance; update affected prompt/cache versions. Review full generated prompts for conflicting instructions and avoid net growth without a concrete reason.
6. Run local validation and review the complete change. Leave live quality claims pending measurement.

Likely files: `src/pipeline/verifier.ts`, `src/llm/verifier-revision.ts`, `src/skills/prompt-builder.ts`, `src/pipeline/composer.ts`, `src/pipeline/composition-content.ts`, `src/pipeline/composition-repair.ts`, `src/evals/eval-scoring.ts`, and their existing verifier, runner, composition, prompt and eval tests. Reuse the runner's existing general sparse repair; avoid a new repair mode or unrelated runner changes. No new public config is needed.

## Acceptance tests

- A promoted question plus `revisedAnchor` and a reason claiming revised severity/category cannot publish the provisional finding. Its bounded repair can supply only the missing existing fields without resending evidence or previously supplied decisions. Test completion before default expansion in both runner validation and defensive normalization, including cached acceptance.
- A fully completed promoted finding passes, including a summary-only finding; an ordinary anchor-only correction still passes. Rejected promoted candidates need no rewrite. Exhaustion is recorded honestly.
- A reason claiming an arithmetic or classification correction never mutates unsupplied fields. Test actual final structured values and rendered metadata, not just verdict prose.
- Fallback never uses its own notice as a title or drops a finding because no better title is available. Successful composition's title behavior remains unchanged. Multiple proof narratives remain intact in provenance; primary prose preserves distinct/essential conditions without repeating all evidence narratives or duplicating exact conditions across sections.
- Every source ID is accounted for before/after fallback rendering. Historical and unverified proposals remain in provenance; supported recommendations retain the existing eligibility checks.
- Multiple scaffold-only sections report all affected paths even when references or finding coverage also fail. A sparse repair fixing only one group stays invalid; repairing the remaining sections succeeds without reproducing untouched valid text. Ordinary prose mentioning a placeholder and concise completed sections remain valid. Exhausted recovery renders actual retained source content with fallback accounting, never scaffold prose or lost findings.
- A mixed reference/prose failure selects general sparse repair with permission to replace unfinished text; pure attribution repair still cannot change prose. Include direct and cached scaffold submissions. Withholding a supported-but-disputed recommendation must remain schema-valid without using fix/test IDs as verification references or introducing cross-group reconciliation support.
- Sanitized proof fixtures distinguish changed behavior from violated requirements, and absent protection from uninspected protection. Include at least one nonnumeric example and a valid alternative implementation.
- Add a nonnumeric caller-contract case where a remedy hides the symptom by weakening required behavior, and a test would pass after that weakening. Include supplied evidence contradicting an otherwise supported proposal: a simulated composer can withhold advice while retaining all proposal sources and an explicit unresolved explanation. Test existing publication/provenance mechanics and prompt instructions separately; these fixtures do not prove the live model will detect the contradiction.
- Each of the five untrusted final-argument states followed by successful regeneration yields unknown fidelity. Trusted missing-field preservation succeeds; with complete telemetry unresolved obligations take precedence over unproven recovery; missing event coverage and unfinished runs stay unknown even if some obligation events are present.
- Existing budget-status and composition-toggle tests remain green, including configured versus selected effort, repair effort, retry behavior and CLI/TOML precedence.

Validation: `pnpm test`, `pnpm run check`, `pnpm run build`, and `git diff --check`. Review rendered fixtures and the actual prompts in addition to automated assertions. Do not run new paid evals automatically as part of implementation.

## Live measurement

Record a reproducible code snapshot and effective model, routing, reasoning, budgets and toggle value. Both comparisons must use the same implementation; do not attribute changes from a different candidate set solely to one prompt edit.

- First measure plan 120 with the same model, routing, budgets and reasoning/toggle settings as its pre-change baseline. A later configured-versus-one-supported-level-lower composition experiment must use the same implementation and keep verification and repairs unchanged. Do not change the toggle in the first comparison and attribute the combined effect to this plan; the toggle is not evidence that a lower tier is already better.
- Report composition attempts, reasoning versus argument streaming, successful/fallback mode, known and unknown costs, prompt size, candidates, repairs and verification completeness.
- Evaluate recommendation correctness, false positives, duplicate causal findings, primary report length separately from provenance size, source retention, and fidelity accuracy. More findings and more supported labels are not automatic improvements.
- Specifically check that no provisional promoted fields or unfinished composition sections survive publication, renderer notices never become titles, and fallback preserves uncertainty without repeating every proof narrative. Assess whether fixes and tests preserve the original caller requirement and whether conflicting advice is withheld rather than merely qualified.
- Record actual reasoning mechanisms as well as selected levels. Opus forced-submit calls in runs 67/101 used no thinking; do not attribute their composition speed or quality to an effective `high` reasoning level, or compare them as equivalent to reasoning-enabled GLM/DeepSeek composition. Keep budgets and routing fixed for controlled follow-ups; no automatic return to the 4× multiplier is part of this plan.
- Keep plan 119's successful behavior: diagnosis-only summary, request-preserving supported advice, historical proposal retention and strict assembled-output validation.

Run 100 increased composition input from 99,397 to 148,379 characters; serialized advice assessments grew from approximately 11,825 to 36,640 characters. Measure this overhead before expanding input design. Duplicate proposal text and evidence are candidates for later lossless projection; no lossy truncation or extra summarization model is authorized by this plan.

## Deferred work

- Sharing refuting evidence from rejected candidates across verifiers/composition. Run 99 establishes a real need, but this requires a separate bounded evidence-flow design that cannot resurrect rejected findings or treat related-file overlap as contradiction proof.
- Semantic proposal equivalence, automatic root-cause deduplication, a new adjudication stage, broader caller enumeration, increased deadlines/budgets/repair counts, and model-specific exceptions.
- Broad composer-input redesign. Do not move uniquely material evidence out of the model's view merely to shorten a prompt; preserve the current canonical inventory until a measured lossless projection is designed.

Completion requires implementation, local validation and review. Live measurement should be reported separately; an eval pass alone does not establish improved report quality.

## Implementation and local validation

- Promoted completion is checked inside shared revision expansion, before candidate defaults are merged, covering runner validation and defensive normalization. Sparse repair retains earlier explicit decisions; cached incomplete verdicts are rejected.
- Composition rejects empty or whole-value `placeholder`/`TODO`/`TBD` sections with field paths. Mixed prose/reference failures use existing general sparse repair; full assembled validation, cache checks and bounded exhaustion remain enforced.
- Fallback keeps full proof narratives in provenance, renders distinct secondary conditions and proof statuses, and leaves essential conditions/unresolved evidence in the existing visible open-conditions section. Its title selection no longer consumes renderer prose.
- Existing final-argument rejection events now prevent an unsupported preserved-fidelity label. Existing completeness and open-obligation precedence is unchanged.
- Verifier and composition prompts were consolidated, including shared verifier submit guidance; template versions are now `p9.19` and `p10.10`. Caller-contract compatibility and contradictory advice remain model judgments, not new deterministic truth checks.
- Validation passed: `pnpm test` (1,160 tests, 56 files), `pnpm run check`, `pnpm run build`, and `git diff --check`. Review included rendered fallback fixtures, mixed sparse repair/exhaustion, cached acceptance, direct verifier bypass, and prompt consistency. No paid eval or historical artifact rewrite was performed.
