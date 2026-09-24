# Issue 115: Lossless Submit Recovery, Planning Fidelity, and Faithful Composition

Status: IMPLEMENTED (measuring) — code and regression checks complete; controlled eval pending, 2026-09-22
Planned from: trails-api `49f4645b` eval run 79, comparison with runs 66–68 and 77, and source inspection on 2026-09-22
Planned at: branch `upgrade`, HEAD `091668febede`, plus the current unstaged reliability, composition, provenance, and OpenRouter override changes
Recommended priority: fix confirmed information loss before treating the latest passing eval as evidence of reliable review quality.

## Objective

Recover malformed structured submissions without discarding substantive review information, preserve planning decisions during shape repair, and publish concise findings without losing distinct evidence or conclusions. Keep strict final-argument provenance, whole-result schema validation, bounded repair, and honest failure reporting.

This plan does not promise that every model response can be recovered. An explicit unresolved failure is preferable to a schema-valid result manufactured by deleting unresolved work.

## Execution instructions and dependencies

- Read the current code and this plan before implementation. The baseline includes uncommitted changes; do not reconstruct it from HEAD alone or overwrite unrelated work.
- Build on the shared recovery seam from Plan 95 and the final-argument provenance/continuation contracts from Plans 112 and 114. Preserve Plan 114's prohibition on consuming rejected partial arguments: trusted conversation is the retry input, not a salvaged prefix.
- Coordinate with Plans 100 (planner coverage), 106 (verifier revisions), and 110 (publication-aware notes). Do not introduce a second recovery scheduler or a second source of coverage truth.
- Implement phases in order. Record validation and deviations here, and update the index status as work progresses.
- Keep all changes unstaged unless the user subsequently requests otherwise. Authoring this plan does not itself authorize implementation or a paid eval.

## Evidence and current behavior

Private artifacts are under `codegenie-private-evals/trails-api/49f4645b/logs/<run>/`. Copy minimal, sanitized regression fixtures into this repository when implementing; tests must not require that external checkout or absolute paths.

### A. Confirmed loss in Stage 7 cleanup

Run 79 call `mc-000012` returned `reviewStatus: no_findings`, three follow-up hints, and two uncertainties. Two hints lacked `suggestedLenses`. The final fallback in `stage7SubmitRepairDecisionFromParts` replaced both nonempty arrays with empty arrays and recorded successful cleanup. Replaying that recorded object through the current function reproduces the loss. The retained `noFindingReason` still says the predicates are recorded as hints.

One discarded hint concerns missing truncation-test coverage. Runs 67 and 68 published a separate testing finding in this area. This does not establish that the dropped hint would have become a finding; it establishes that recovery erased a review opportunity.

### B. Planner repair lost the original plan

Run 79 `mc-000001` contained ten coverage entries, including deep coverage, lenses, focus notes, and related context. It was rejected for four unsupported fields inside `diffUnderstanding`: `reviewedHunks`, `totalHunks`, `isPartial`, and `reason`.

Repair `mc-000002` returned only `declaredIntent` and `inferredBehavior` at the root, with no coverage. The harness correctly rejected it, then used the deterministic all-normal plan. All hunks were subsequently marked reviewed, so the completeness assertion passed despite `degradedPlanning: true`.

### C. Schema validity is not recovery fidelity

Run 79 had 12 schema-invalid calls, eight model repair calls (five successful, three unsuccessful), and one deterministic recovery. Two packet workers recovered through full-worker retries after failed repairs. Errors included unsupported nested fields, incorrectly nested verifier fields, an empty optional `noFindingReason`, and malformed/incomplete final arguments. Error classification sometimes mislabeled extra properties as missing required fields.

The verifier repair moved `verification` and `whyThisMatters` out of `findingUpdates.evidence`. Shape repair and subsequent full validation worked there; retain this capability without reopening verification judgments.

### D. Repetition came primarily from the harness

Word counts below use whitespace-separated final-body words, not tokens:

| Run | Correctness body | Separate testing body |
| --- | ---: | ---: |
| 66 | 412 | — |
| 67 | 665 | 245 |
| 68 | 473 | 185 |
| 79 | 3,085 | — |

Run 79's model-composed body was 624 words. The harness appended the merged members' canonical sections because paraphrases did not match exact strings, growing the result to 26,403 characters. Five versions of the same rounding defect were merged; impact, fix, and test sections appeared six times. A member's low-severity rationale was appended beneath the final medium-severity finding.

These reports are comparison evidence, not ground-truth proof of every claim. Distinct testing defects must not be merged away merely because they relate to the same production code.

### E. Speed improved, but the comparison has confounders

Run 79 passed in 8m23s with 10/10 hunks reviewed, zero timeouts, and one inline finding after eight candidates yielded five accepted findings and three rejections. Composition took 20 seconds. Run 77 took 42m19s and left seven hunks unreviewed. Routing and tool-selection behavior changed, and run 79's fallback changed review depth. Do not attribute the entire improvement to routing or call the runs quality-equivalent.

## Required invariants

1. **Provenance first:** incomplete, ambiguous, or otherwise untrusted final arguments never become accepted submissions. Never derive a result from a partial JSON prefix.
2. **Validity and preservation:** an accepted repaired submission passes full schema and stage-semantic validation and the applicable preservation checks. Schema validity alone is insufficient.
3. **No silent deletion:** substantive findings, hints, uncertainties, evidence, and coverage cannot disappear merely to satisfy a schema. A schema-only repair cannot turn unresolved work into a clean result.
4. **Protected decisions:** shape repair does not independently change severity, confidence, verdict, review depth, or disposition. Such changes belong to their original decision-making stage.
5. **Bounded recovery:** use the existing one-model-repair allowance and deadlines. No unbounded retries, parser permissiveness, or automatic timeout increases.
6. **Honest completion:** record coverage, planning quality, recovery fidelity, and publication disposition separately. Unknown preservation is not reported as proven lossless recovery.
7. **Faithful rendering:** preserve distinct verified issues and material caveats. Preserve full verified inputs in artifacts without necessarily repeating every paraphrase in the public comment.

## Design decisions clarified by pre-implementation review

### Preservation is a checked contract, not a prompt promise

For complete, provenance-valid JSON, snapshot the original object before any cleanup. Assign harness-local identities to array members using their original paths/indices; do not ask the model to invent IDs. The default repair interface remains a full resubmission under the existing submit schema. Compare the proposed result with the snapshot before accepting it:

- Existing schema-valid content outside the validation-error paths must remain unchanged. This includes every independent hint and uncertainty, even if another member is malformed.
- Additions/corrections are allowed only at diagnosed invalid or missing fields, with stage-specific constraints. Known field relocation must preserve its value and must not overwrite a conflicting destination value. Removing an unsupported substantive field without accounting for its content is rejection.
- For protected decision fields with invalid values, do not guess a severity, confidence, verdict, or review depth to make validation pass. Use only a documented unambiguous normalization; otherwise return the decision to its owning stage through existing bounded restart policy or fail honestly.
- Array order is fixed for the initial implementation so matching is deterministic. Semantic paraphrases and array merges are composition/verification work, not schema repair.
- Validate the entire reconstructed/resubmitted object and stage semantics after the comparison. Correct JSON containing fabricated generic no-finding reasons, deleted items, or a smaller plan is not recovery.

Do not use fuzzy similarity or another model judge to certify lossless repair. On incomplete/untrusted argument streams there is no permissible object snapshot: retain only trusted prior conversation, apply the existing retry, and report a re-execution rather than claiming measured content preservation.

A new field-edit tool is **not required for this plan's initial implementation**. Add it only if full-resubmission preservation tests demonstrate a specific remaining problem; document that evidence here first. Avoid a parallel schema family and scheduler merely to fix the known deletion bug.

### Worker restart does not erase known obligations

For provenance-valid submissions that fail domain validation, carry a bounded inventory of existing findings/hints/uncertainties across the existing worker restart. A later successful worker must retain those items or explicitly resolve them in its investigation; success alone must not reset the inventory. These drafts are advisory inputs, never publishable findings or authoritative coverage. If identity/disposition cannot be established within the existing budgets, record unresolved obligations and fail the strict preservation gate. Do not create this inventory from rejected partial argument bytes.

### Planning fallback remains a distinct outcome

Separate (a) repairing the existing complete plan from (b) constructing a new fallback plan. Only a validated repaired plan can preserve the original planner's decisions as accepted decisions. Fallback derives its minimum coverage from trusted configuration, file classification, and existing deterministic risk rules; it must not invent a new heuristic risk scorer or globally escalate every file to deep review. Carry only safe advisory context from complete drafts. Keep fallback visibly degraded and fail an enabled strict planning-quality gate regardless of eventual hunk coverage. This does not promise that a fallback is quality-equivalent to a successful model plan.

### Composition has both structural and semantic limits

Use harness-assigned references to immutable verified source components (finding ID plus field/item identity). The model may propose issue grouping and narrative/component text, but the harness resolves references and renders actual evidence from the verified inputs. Unknown IDs, omitted required source dispositions, invented evidence references, and conflicting final metadata fail validation. IDs establish attribution, not proof that a paraphrase preserves meaning.

In deterministic fallback, deduplicate only exact or mechanically equivalent source components. If two paraphrases cannot safely be consolidated, retain separate attributed components or separate findings; do not silently merge them with token similarity. A longer honest fallback is acceptable. Distinct caveats and unresolved disagreements remain visible. The goal is to remove the unconditional narrative-plus-every-member duplication, not enforce a universal word limit or guarantee semantic compression without judgment.

### Eval contracts and delivery gates

Use opt-in `expect.planningQuality: "non-degraded"` and `expect.recoveryFidelity: "preserved"` assertions, with explicit pass/fail/unknown evidence. An enabled assertion with missing legacy evidence cannot pass; report that the artifact lacks the required evidence. Unresolved known obligations or destructive cleanup fail recovery fidelity; no recovery needed is a valid vacuous pass only with complete telemetry. A rejected destructive attempt followed by a fully accounted-for recovery is not permanent failure. These gates do not require every candidate to be published or every initial call to succeed.

Implement the minimal preservation accounting and regression assertions alongside Phase 1; Phase 4 integrates them into public eval configuration and summaries. Distinguish `IMPLEMENTED (measuring)` after code/tests from `COMPLETE` after the controlled eval gate. Paid eval results are not a prerequisite for landing the reproduced loss fix.

## Phase 1 — Stop lossy cleanup and add preservation checks

Primary targets: `src/llm/stage7-submit-repair.ts`, the shared recovery seam in `src/llm/pi-runner.ts` / `llm-runner.ts`, and focused regression tests.

- [x] Add a regression from `mc-000012` showing that three hints and two uncertainties cannot be replaced by empty arrays and accepted.
- [x] Remove the no-findings salvage path that clears substantive arrays. Audit sibling cleanup paths for the same behavior, including wrong-type arrays, missing values, unknown nonempty fields, and reason truncation.
- [x] Permit only explicitly documented, mechanically safe normalizations. Empty optional fields may be omitted when semantically irrelevant; missing substantive content must be repaired or reported unresolved. Do not invent routing/lens choices as a schema fix unless the schema explicitly makes them harness-owned metadata.
- [x] Retain provenance-valid, schema-invalid input for bounded repair. Preserve all original items and their identities/order during shape-only repair; compare protected content before accepting the result. Do not confuse provenance-valid JSON with a valid domain object.
- [x] On failure, preserve trusted investigation context and follow existing bounded worker retry/terminal policy. Never publish the invalid draft as a finding. If its obligations remain unresolved, expose that fact in completion accounting.
- [x] Log counts and exact changed paths for recovery, including removed/defaulted fields and unresolved items. Respect existing redaction rules; do not log rejected raw argument fragments.

Acceptance: the run-79 fixture either produces a fully valid submission retaining all five items or fails honestly. No cleanup can erase an independent valid uncertainty because a different hint is malformed.

## Phase 2 — Target repairs and preserve planner quality

Primary targets: `src/pipeline/planner.ts`, `src/llm/schema-diagnostics.ts`, `src/llm/stage7-submit-repair.ts`, `src/pipeline/verifier.ts`, schemas, and prompt builder.

- [x] Represent validation failures as structured paths and violation kinds; derive classifications from validator errors rather than searching the entire payload text for words such as “missing.”
- [x] Give repairs concise exact errors, the relevant schema structure, and complete provenance-valid material needed for correction. Include an explicit full-plan root example for planner repair.
- [x] Only if the evidence gate above justifies a field-edit response, constrain it as follows: edits target named validation paths, cannot replace entire protected arrays, and cannot use arbitrary code or generic unrestricted JSON Patch. Validate edits, apply them to the original object, then revalidate the entire reconstructed submission. Reuse the existing repair allowance.
- [x] Treat that edit protocol as an implementation decision with a focused prototype: choose it over full resubmission only if it demonstrably prevents coverage/item loss without making the provider schema substantially harder. In either design, the preservation acceptance checks are mandatory.
- [x] Protect planner hunk identities, coverage levels, lenses, focus notes, and related context. Missing coverage or reduced depth in a shape-only repair is rejection, not permission to normalize to defaults.
- [x] Unsupported properties containing meaningful content require explicit relocation or unresolved handling. Do not implement general “strip all unknown keys,” even when it would make this fixture validate. Harness-owned duplicate counters may be handled only under a narrow documented rule.
- [x] Preserve the complete trusted pre-response conversation for untrusted/incomplete output retries. Do not truncate valid findings out of replacement repair prompts to fit an arbitrary character cap; use targeted context or report a bounded context failure.
- [x] Keep a last-resort deterministic plan, but make its baseline risk-aware and visibly degraded. Never label unvalidated planner fragments as accepted coverage decisions. If used as advisory context, they must not authorize skips or lower established coverage requirements.

Acceptance: the original ten-entry plan survives a successful shape repair with its review depth and focus information intact. A repair containing only intent prose is rejected. An unrecoverable plan remains visibly degraded and cannot pass the new strict planning-quality gate.

## Phase 3 — Compose distinct information once

Primary targets: `src/pipeline/composer.ts`, composition schema/prompt, publication artifacts, and renderer tests.

- [x] Replace the exact-substring-plus-append-all safeguard. Do not solve length by truncating the final body or dropping merged members without accounting.
- [x] Define an issue-level composition representation with source finding IDs and separate trigger/impact, evidence references, caveats, fix, and test components. Keep full verified inputs in artifacts and record how each contributes to a published issue.
- [x] Consolidate exact evidence duplicates by source identity and content; render line references as references, not fenced Go snippets containing only `591-602`. Preserve different decisive source branches and materially different examples.
- [x] Allow wording consolidation for the same defect. Keep different triggers, consequences, unresolved predicates, fixes, or independently actionable testing defects distinct or explicitly represented in the merged result.
- [x] Do not claim that referenced IDs prove semantic preservation. Validate reference completeness structurally, review the run-79 fixture semantically, and preserve unresolved disagreements explicitly. Avoid a new unbounded LLM judging loop.
- [x] Render accepted severity/confidence once. Preserve material uncertainty without appending obsolete or conflicting member-level judgments as if all were the final conclusion.
- [x] For invalid composition, use a deterministic grouped rendering with explicit disposition and unique supporting details, not a representative-only summary that loses other members or concatenation of all member prose.
- [x] Bump affected schema/prompt/cache versions and update the prompt rationale ledger. Maintain compatibility for historical eval artifact loading.

Acceptance: the run-79 issue retains its rounding trigger, bound, evidence chain, zero-amount rejection caveat, caller/contract uncertainty, and fix/test guidance without six restatements. Distinct testing findings like those in runs 67/68 remain independently represented when verified. Word count is a diagnostic, not a hard loss-inducing cap.

## Phase 4 — Make loss and degradation visible to evals

Primary targets: `src/evals/eval-runner.ts`, `eval-artifacts.ts`, `eval-scoring.ts`, shared types/config validation, telemetry aggregation, and docs.

- [x] Add an opt-in strict planning-quality assertion that fails when fallback/degraded planning occurs. Keep existing completeness semantics and historical replay behavior explicit rather than silently reinterpreting old passes.
- [x] Add recovery-fidelity accounting: preserved items, rejected destructive repair, unresolved obligations, and known content loss. Missing data in old artifacts is unknown, not zero loss.
- [x] Separate schema-valid recovery, deterministic correction, model repair, worker restart, and planner fallback in summaries. Link initial failures to their terminal disposition so repeated attempts are not confused with unresolved final failures.
- [x] Add fixtures for planner coverage loss, hint/uncertainty loss, unsupported nested fields, incomplete arguments, and distinct-versus-duplicate composition. Assert outcome behavior rather than merely matching implementation strings.
- [x] Add run-79 report comparisons to regression review: publication coverage and unique content matter alongside length, elapsed time, and expected-bug matching.

Acceptance: a synthetic replay of run 79's destructive cleanup fails the preservation check even when its required bug is found elsewhere. The same run's degraded plan fails an explicitly enabled strict planning gate. Legitimate rejection or merging has a recorded disposition and is not automatically classified as loss.

## Verification and rollout

1. Implement Phase 1 first and run the recovery/provenance tests; do not wait for the composition redesign to close the known loss bug.
2. Validate Phase 2 with complete-plan preservation, targeted repair, and terminal-failure fixtures. Confirm no added unbounded retries or acceptance of partial arguments.
3. Compare old and new rendering of the run-79 verified inputs and sanitized examples from runs 66–68. Review unique evidence, uncertainty, severity consistency, and independent findings, not just word count.
4. Run relevant tests, then `pnpm test`, `pnpm exec tsc -p tsconfig.build.json --noEmit`, and `pnpm run typecheck`. The current baseline has 24 known test-fixture type errors; report and compare them, and do not count that full check as passing until fixed. Require no new errors from this work.
5. Once separately authorized, repeat the trails-api eval with the same pinned provider, configured reasoning, concurrency, budgets, and cache policy. Enable strict planning-quality and preservation checks. Keep the model's planned/reconciled depth visible in comparisons.
6. Use more than one successful run before declaring reliability. Record first-submit validity, repair outcomes, worker restarts, planning quality, coverage, unique findings, composition fidelity, time, and reported/unknown cost. A faster degraded plan is not evidence of equal-quality acceleration.

## Non-goals

- No reasoning remapping to `xhigh`, provider-routing changes, lower validation standards, or broader tool-choice changes.
- No additional model-repair loops or longer deadlines to mask shape failures.
- No accepting valid-looking subsets of incomplete submissions.
- No requirement to publish every candidate: verified rejection and justified deduplication remain valid outcomes.
- No blanket guarantee that a short report or a schema-valid result preserves every semantic claim.
- No silent edits to the external eval YAML, paid eval execution, commits, or staging as part of authoring this plan.

## Completion checklist

- [x] Confirmed hint/uncertainty deletion is fixed with a regression.
- [x] Successful planner repairs preserve coverage and review-driving context.
- [x] Failed repair/fallback is distinguishable from lossless recovery in artifacts and strict eval scoring.
- [x] Incomplete final arguments remain unusable; existing provenance guarantees hold.
- [x] Composition preserves distinct issues and unique evidence without repeating all member sections.
- [x] Regression suite and production typecheck pass; full typecheck baseline is reported accurately.
- [ ] Controlled eval results are recorded with planning quality and remaining limitations before claiming improved reliability.

## Implementation reconciliation — 2026-09-22

Implemented Phases 1–4 and reviewed the recovery/cache/worker, planner, composition, and eval boundaries. Changes remain unstaged. No external eval configuration was edited and no paid eval was started.

- Shared preservation checks run before model-call caching and before accepting deterministic or model repair. Snapshots use fixed array indices, preserve valid fields and decisions, reject arbitrary substantive deletion, and allow exact verifier relocation without overwriting conflicts. Complete JSON wrappers can be unwrapped; truncated/partial argument streams remain ineligible. Structured issue paths cannot be inferred from words inside evidence.
- Recovery inventory is scoped to stage, worker, packet/candidate, and original prompt. Worker restarts retain advisory complete drafts; independent ensemble workers do not inherit each other's obligations. The inventory is bounded to 128 unresolved drafts and 200,000 characters per draft. Exceeding that bound leaves an unresolved event and fails honestly. Resolution events record method, restart status, and original item counts. Unknown protected decisions are not guessed; unresolved drafts can therefore still fail strict fidelity after retries.
- No field-edit tool was added: checked full resubmission recovers the five-item regression within the existing repair allowance. The conditional field-edit prototype items are closed as not needed for this implementation.
- Planner cleanup removes only the documented duplicate bookkeeping and relocates explanatory `reason` verbatim. Coverage, depth, lenses, and focus remain protected. Fallback uses classified high/critical priority for deep coverage and remains explicitly degraded; other files retain normal coverage.
- Composition uses structured references and immutable evidence/verification, with an artifact containing sources, proposals, and dispositions. Legacy or invalid attribution uses one conservative deterministic body instead of narrative plus appended member sections. Evidence is not truncated; exact duplicate snippets share a block while retaining distinct explanations. Impact/fix/test paraphrases remain model judgments; IDs do not prove semantic equivalence. Distinct source assessments may remain verbose rather than being silently reconciled.
- `submit_composition` schema version is 3; prompt versions are p5.7/p7.12/p9.13/p10.5 and shared runner/cache message version is v4. Existing historical artifact loading remains supported. Strict eval assertions are opt-in; absent/incomplete historical fidelity evidence is unknown, never a vacuous pass.

Validation:

- `pnpm test`: 50 files / 952 tests passed, including workflow validation, loss/relocation/protected-decision fixtures, worker restart and cache rejection, planner fallback priority, composition attribution/evidence/caveats, and strict eval evidence completeness.
- `pnpm exec tsc -p tsconfig.build.json --noEmit`: passed.
- `pnpm run typecheck`: still reports the same 24 baseline test-fixture errors (Pi `JsonObject` typing and the existing incomplete fake adapter); no new errors. This check is not reported as passing.
- `git diff --check`: passed.
- Offline run-79 artifact rendering: five accepted members, 45 source components; conservative source-accounted rendering was 2,442 words versus the previous 3,085. Every verification string, evidence string, and distinct evidence explanation remained present. Sanitized repository fixtures cover the rounding bound, zero rejection, caller uncertainty, and independently actionable testing content from the comparison reports. This was deterministic artifact inspection, not a fresh model eval or proof of semantic compression.

The remaining delivery gate is a separately authorized controlled repeat with both strict assertions enabled, followed by more than one successful run before claiming improved reliability or performance.
