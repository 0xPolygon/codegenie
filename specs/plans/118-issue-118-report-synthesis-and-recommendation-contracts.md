# Issue 118: Report Synthesis and Recommendation Contracts

Status: IMPLEMENTED — reviewed and tested; live quality measurement pending, 2026-09-23 (America/Toronto)
Depends on: Plan 117; existing structured proof assessments, source accounting and bounded repair
Baseline: Plan-117 checkpoint 6fd21ef; run 93 DeepSeek 4.1 Flash/max on its pre-commit working tree, and run 94 GLM 5.3 Flash/max on the clean checkpoint

## Objective

Produce one readable conclusion per actionable defect, with recommendations that preserve the relevant behavioral requirement. Keep original evidence and uncertainty available without turning the primary report into an accumulation of worker observations.

Use the existing verifier and composer. First fix the demonstrated verdict-repair defect and strengthen evidence/revision consistency, then improve synthesis and presentation. This is a targeted follow-up, not another investigation stage, semantic-proof engine, report-generation pipeline, or repair scheduler.

## Evidence and diagnosis

Run 93 passed: 10/10 hunks reviewed, nine candidates, eight verified, two published findings, 12m25s, 86 model calls and $0.3942. All five packet-review JSON failures recovered on their first low-reasoning repair in 8–17 seconds. Verification and composition required no repair, timeout or fallback. Composition succeeded in 106 seconds at high reasoning. All 79 source components were accounted for, with recovery fidelity recorded as preserved.

Plan 117 improved the final recommendation: it endorsed rounding upward or rejecting an unrepresentable request and explicitly declined to endorse lowering the promised output. It also rendered synthesized verification instead of substituting an original worker paragraph. These improvements should remain.

Four gaps remain:

1. **The renderer repeats secondary uncertainty.** `composePresentation` appends all proof assumptions, distinct only by exact text, plus severity disagreement and unresolved reconciliation prose. The main finding has 19 open-condition bullets, many expressing the same uncertainty. Its 661 model-written narrative words become 1,441 primary words. The two findings total 1,972 primary words and 7,581 provenance words; the whole Markdown report is 10,072 words. Full provenance is useful, but a verbose primary report is not necessary to retain it.
2. **A support label can overstate what was checked.** Some verifiers marked suggestions supported after checking only local consistency. One endorsed a reduced output while admitting deeper caller acceptance was only partially checked. `suggestionAssessment` currently requires matching suggestion text and some evidence, without an explicit basis for the behavioral requirement.
3. **The proposed test does not preserve the full requirement.** The report asserts that the promised minimum is deliverable but does not also require that it satisfy the original request. A wrong fix that lowers the promise can pass. One proposed input reaches an existing zero-value rejection rather than the claimed successful-quote failure. The general problem is testing internal agreement instead of the intended observable behavior, and failing to establish that the example reaches the intended branch.
4. **One defect survives as two findings.** The helper-level and caller-level reports describe the same floor conversion, output mismatch and collateral consequence. The composer kept the helper finding separate and summary-only despite a valid anchor. This is a semantic consolidation gap, not an anchor failure.

The caller lookup also explains part of the missing evidence: a verifier requested lines 480–620 of a discovered caller with only a 2,000-character delivery allowance. The result stopped before the decisive requirement check around lines 552–562. This supports more focused reads and honest unknown assessments, not larger global budgets.

Compared with run 92, run 93 was about 21 seconds faster and $0.0245 more expensive. Its composition prompt grew from 59,363 to 128,830 characters. Different candidate content contributes to these differences; do not attribute all growth to one change. Opus 67 still traced the downstream requirement more convincingly. These runs are observational evidence, not a controlled model comparison.

### Run 94: recovery and verification correctness take priority

Run 94 finished in 31m27s with 100 model calls and $0.4298 recorded cost. The expected bug was found, but completeness failed: 12 candidates produced nine verified, two rejected and one incomplete verification. The final report contains five findings (four inline, one summary-only). Recorded cost excludes unknown usage for the two cancelled composition calls; do not present it as complete provider billing.

**A valid repair was made invalid by retained-draft merging.** Candidate `39bb849f-u2-bbf7f438` correctly rejected a broad test-absence premise after finding existing tests. Its original `mc-000090` response also contained `findingUpdates: { confidence: "low" }`, which conflicts with `verdict: "reject"`. Repair 1 (`mc-000095`) returned a complete rejection without that field. Offline reproduction confirmed that this response passes schema and verifier-revision validation on its own, but `mergeRepairDraft` restores the old field and recreates the semantic error. Repairs 2/3 did not resolve it. Subsequent diagnostics lost the specific reason and supplied generic `invalid_tool_arguments` with an empty field-issues list. All three repairs together took about 16 seconds: another attempt or a larger timeout would not fix the underlying representation conflict.

**Composition never produced a submission.** Calls `mc-000099` and `mc-000100` each hit the approximately 180-second deadline at high reasoning. They streamed roughly 55,554 and 45,333 reasoning characters respectively, with zero tool-argument characters. Both received the same 117,943-character prompt. The report is deterministic fallback after six minutes of active reasoning, not a completed GLM synthesis and not a six-minute wait for the first provider response. This does not establish that input size alone caused the timeouts.

**The report exposes separate semantic problems.** Its first high-confidence finding claims no cross-decimal tests exist even though the reviewed source contains them. The verifier admitted its search was truncated, but called the unsearched remainder a secondary concern; the existence of such a test actually determines whether the finding is true. Another candidate was narrowed to a missing remainder case, but its unchanged impact paragraph still asserts that the broader path is untested. Three findings substantially overlap on the scaling/minimum-output defect. Unverified remedy labels were applied honestly, but cannot compensate for an incorrect defect or inconsistent finding text.

**Fallback also invents a disagreement signal.** It compares the verification paragraph and serialized proof assessment as distinct verification texts, so even a single-candidate group receives “Original verification assessments differ.” Different representations do not establish disagreement. The fallback report contains 2,310 primary finding words and 6,863 provenance words, with 9,772 words in the complete Markdown.

These findings add a correctness prerequisite (Phase 0) and explicit failed-composition/fallback cases. They do not justify loosening schemas, dropping evidence, increasing repair counts, or changing reasoning before measuring the targeted fixes.

## Design decisions

| Concern | Chosen approach | Boundary |
| --- | --- | --- |
| Reject verdict with irrelevant revision fields | Narrow verdict-aware canonicalization before validation; preserve raw submissions | No arbitrary deletion protocol, verdict rewriting or whole-payload replacement |
| False absence claims and stale revisions | Establish the decisive search scope and review the assembled finding | No extra adjudication model, keyword-based truth rules or mandatory full rewrites |
| Composition timeout and fallback | Remove duplicate input serialization; test current deadlines and conservative fallback | No longer deadlines, additional attempts or unsupported claim of improved completion |
| Repeated caveats | The existing verification section synthesizes secondary uncertainty; renderer protects essential unresolved conditions | No new uncertainty graph, summarization call, or similarity-based deletion |
| Unsupported recommendations | Extend the existing optional assessment with a small explicit contract check | Structural validation checks supplied support, not the truth of model reasoning |
| Weak regression tests | Assess reachability and expected behavior against that same requirement | No mathematical/domain-specific rules in the harness |
| Duplicate findings | Explicit cross-group consolidation instructions within the current composer | No lower similarity thresholds or automatic helper/caller merging |
| Lost decisive source context | Focus existing source reads around known hits and use existing recovery metadata | No new budget pool, timeout increase, or mandatory extra call |
| Excess evidence text | One canonical input representation and a readable provenance view | Complete original records remain in artifacts; no source truncation for brevity |

Do not add model/provider exceptions, repository paths, trade-type names, numeric examples, or eval identifiers to production decision logic. Domain examples belong only in sanitized regression fixtures. Contract here means any relevant behavioral requirement: API acceptance, authorization, ordering, persistence, units, resource ownership, protocol behavior or other source-backed invariant. It need not live in a separate caller file.

## Invariants

- Every verified candidate and source component remains accounted for; distinct independently actionable defects remain separate.
- A valid defect survives an unknown or incompatible remedy. Optional missing assessment data does not create a repair obligation.
- Essential unresolved assumptions cannot be silently collapsed, superseded by the composer, or turned into established proof.
- Secondary uncertainty affecting impact, severity or remedy remains visible in the current verification conclusion; it is not simply discarded because `essential` is false.
- Original source records, assessments and reconciliation attribution remain available, with exact text preserved in artifacts and accessible provenance.
- Recommendation support remains bound to the exact final suggestion after compact/full revision expansion; fix and test support are independent.
- Keep strict live schemas, semantic validation, cache validation, bounded repair, fidelity reporting and fallback disclosure. Explicit removal of revision-only fields on a trusted reject is recorded as a stage-specific canonicalization, not as an unchanged/preserved payload.
- A search must establish the scope needed for its negative claim. Missing decisive evidence cannot become secondary merely because a tool budget was exhausted.
- The effective finding after revisions is the publication unit: its title, impact, verification and suggestions must describe the same remaining claim.
- Keep provider routing, composition reasoning, investigation reasoning, repair effort, concurrency, deadlines and retry counts unchanged for the initial measurement.

## Phase 0: Fix verdict recovery and verification consistency first

Targets: `src/llm/verifier-revision.ts`, `src/pipeline/verifier.ts`, `src/llm/pi-runner.ts`, existing stage-normalization/recovery hooks, verifier prompts and focused tests.

### A. Canonicalize revision-only fields on explicit rejection

The preferred fix is local and verdict-aware. An explicit rejection does not publish a revised finding; its proposed revision fields have no effective target. Preserve that information in raw artifacts instead of asking the model to repair a field that the harness can safely classify as inapplicable.

- [x] Define one narrow canonicalization rule for a trusted, explicitly submitted `verdict: "reject"`: remove `findingUpdates`, `finalFinding` and `revisedAnchor` from the effective verdict. Audit the existing handling of all three fields so compact, legacy and placement revisions have consistent rejection semantics. Preserve verdict, reason, proof, uncertainty, suggestion assessments and all other applicable information.
- [x] Apply the same rule before final schema/semantic acceptance for original submits, assembled field repairs and cache replay, and again at any non-validating adapter boundary where necessary. Do not normalize only the final application path while leaving the runner's acceptance gate unable to finish. Prefer an existing stage-specific hook; any required hook must default to identity for other stages and be tested for consistent use.
- [x] Determine applicability from the trusted effective verdict after assembling any repair, never from a sparse patch alone or from an inferred/default verdict. Retaining an explicitly submitted rejection across an ordinary field update is allowed. A patch that explicitly changes the verdict must be validated under the resulting branch, including all keep/revise requirements. Use the same canonical effective object for semantic validation, preservation accounting and the returned result; retain the raw draft separately so cleanup cannot be silently undone by merging or mistaken for unexplained loss.
- [x] Keep/revise submissions retain their current revision requirements and conflict checks. Never change a verdict to accommodate a payload, infer rejection from prose, accept untrusted partial JSON, or strip arbitrary missing/invalid evidence.
- [x] Keep omission-as-retention for ordinary repair fields and arrays. Do not solve this by treating every full-looking response as replacement, by interpreting arbitrary nulls as deletions, or by adding a general JSON Patch/delete protocol.
- [x] Record the precise removed fields and normalization reason in telemetry/artifacts. Preserve the original input and distinguish semantic canonicalization from shape-only cleanup and from unsupported recovery loss. Re-run strict schema and stage semantics against the effective verdict before resolving the obligation.
- [x] Preserve the specific semantic error message through patch validation, retry scheduling and subsequent prompts. If a problem is semantic rather than a missing schema field, an empty field-issues list must not erase the actionable explanation.
- [x] Add an end-to-end runner regression reproducing a rejection with revision data and the formerly valid-but-remerged repair. Also test nested evidence preservation, partial updates with omitted versus changed verdicts, keep/revise conflicts, malformed/untrusted submits, exact cleanup telemetry and cache revalidation. A repair must not pass an intermediate patch gate and then fail solely because a later gate uses the unnormalized draft. Do not replace this with a unit test that merely repeats the cleanup implementation.

**Acceptance:** the rejected candidate completes with its explicit rejection, without unnecessary repair or a false incomplete-verification status. The original revision content remains auditable. Other stages retain their existing no-loss merge behavior. No additional model attempt is introduced.

### B. Require adequate evidence for absence claims

- [x] Clarify verifier guidance: claims such as no test, no validation, no guard, or no caller require a sufficiently complete and appropriate search of the relevant scope. A truncated result, narrow excerpt or zero-hit wording search alone does not establish categorical absence.
- [x] If unexplored scope could refute the finding itself, classify that uncertainty as essential. Use available focused reads to settle it, narrow the claim to a supported scope, or reject it as unresolved under the existing proof contract. Do not downgrade an essential gap to secondary uncertainty to keep the finding publishable.
- [x] Keep proportionality: no exhaustive whole-repository search is mandated when a bounded relevant scope or authoritative evidence settles the claim. Budget pressure does not authorize inventing unseen content or reopening unrelated code.
- [x] Add fixtures with an existing counterexample beyond a truncated prefix, a genuinely absent check in a complete relevant scope, and a positively established defect with only secondary reach uncertainty. Include an unrelated domain such as authorization guards, not only tests or numeric scaling.

### C. Review the assembled finding after a semantic revision

- [x] Instruct the verifier that narrowing or refuting part of a candidate requires revisiting dependent title, failure mode, impact, verification and suggestions. Send compact updates for every affected field, leaving independent evidence intact; a verdict reason saying a claim was removed does not remove it from another field.
- [x] Expand compact revisions and normalize support before applying existing gates and producing artifacts. Keep one effective candidate for publication, assessment binding and audit so these paths cannot read different versions of the finding.
- [x] Have composition check supplied finding text for internal contradiction before presenting it as a coherent conclusion. Resolve only from the supplied evidence; it must not become a new investigation. When evidence cannot resolve a material conflict, state it rather than choosing the favorable paragraph.
- [x] Keep fallback honest: it cannot repair arbitrary semantic contradictions mechanically or infer truth from string similarity. Retain evidence and explicitly indicate unavailable synthesis. Fixing verifier input quality is necessary; fallback disclosure alone does not make a false positive acceptable.
- [x] Test a narrowed claim whose dependent impact also needs revision, and a revision that legitimately changes only one independent field. Do not require all prose fields to be resubmitted on every revision or add a mandatory model-based consistency check.

**Acceptance for B/C:** scripted fixtures verify full effective-payload propagation and unresolved-proof handling; manually reviewed counterexamples verify the intended claim boundaries. Semantic absence and consistency remain model judgments, not something a schema test can prove. Later live evals must check for false positives even when the expected-issue check passes.

## Phase 1: Give the current conclusion one author

Targets: `src/pipeline/composition-content.ts`, `src/skills/prompt-builder.ts`, existing composition schema/validation only where needed.

- [x] Reuse the current impact/verification/fix/test sections. Do not introduce a second model-written uncertainty list, an additional synthesis pass or a claim graph.
- [x] In the verification section, instruct the composer to combine equivalent secondary uncertainties by meaning, identify the consequence of each remaining uncertainty, and distinguish established facts from open questions. Link to the already supplied verification/proof sources using existing source references.
- [x] Require proof sources containing unresolved assumptions, and the affected sources of unresolved reconciliations, to be attributed to the visible verification section rather than only `retainedSourceRefs`. A valid evidence-backed supersession may discharge a non-essential source; essential conditions remain protected. Use the existing source inventory and reconciliation records, with no new payload shape. This enforces inclusion in the synthesis task, not semantic fidelity of the resulting prose.
- [x] Stop unconditionally appending every non-essential proof assumption and every unresolved reconciliation rationale to the primary body. Their originals remain in provenance. Explain material unresolved disagreements in the verification section once, rather than in both that section and a renderer-generated list.
- [x] Retain a narrow deterministic safety block for unresolved proof status and essential assumptions. Preserve exact wording with safe exact deduplication only. An unexpected unresolved essential condition is not permission to publish an unconditional defect; retain existing verification gates and honest legacy/fallback disclosure.
- [x] Do not automatically print a severity-vote summary merely because historic severity values differ. Preserve the values as provenance. If uncertainty still changes the appropriate severity, the composed verification must explain the reason rather than list votes.
- [x] Keep existing reconciliation support requirements. Corrected observations remain attributable, and source order or majority does not establish truth. Rendering an unresolved reconciliation only in provenance does not discharge the composer's obligation to state its material consequence visibly.
- [x] Use the same ownership rule for normal and summary-only findings. Summary-only is a placement decision, not a second class of issue that should bypass consolidation.
- [x] Do not manufacture a disagreement from different representations of one assessment. Comparing a verification paragraph with its serialized proof object is not a conflict test. Use a neutral “synthesis unavailable” disclosure for fallback, retain genuinely distinct assessments as provenance, and render explicit unresolved conditions; do not claim either agreement or disagreement from unequal prose alone. Test a single finding with consistent proof/verification plus a genuine multi-source conflict.
- [x] Keep fallback conservative: label synthesis unavailable, retain the representative conclusion and original records, and keep unresolved conditions visible. A fallback may be longer than successful synthesis; do not invent a consolidated truth or silently hide secondary material uncertainty to meet a length target.
- [x] Exercise the new visible-verification attribution rule through `renderRetainedComposition`, which shares validation with model composition. Construct fallback verification from the representative text plus explicitly attributed unresolved conditions when necessary, without implying that they were synthesized or reconciled. Move each included source reference out of retained-only accounting rather than counting it twice. Do not bypass source validation or attach references to prose that does not represent them merely to make fallback pass. Cover multiple proof sources and unresolved secondary conditions in both normal and summary-only fallback fixtures.

The soft target remains roughly 150–300 narrative words for an ordinary finding, with room for genuinely distinct conditions. There is no hard truncation, length-only repair, or automatic rejection for exceeding that target. Rendering should not multiply prose simply because more workers found the same problem.

**Acceptance:** a fixture with repeated non-essential questions produces one supplied synthesized caveat in the main view, retains all original questions in provenance, and does not weaken the essential-assumption safeguard. Distinct material conditions remain visible. Structural reference coverage is not described as proof that the synthesis is faithful.

## Phase 2: Make recommendation support explicit and conservative

Targets: `src/types.ts`, `src/llm/schemas.ts`, `src/pipeline/suggestion-assessment.ts`, `src/pipeline/verifier.ts`, verifier/composer prompts and projections.

Extend `SuggestionAssessment` with one optional object:

```ts
contractCheck?: {
  status: "established" | "unresolved";
  requirement: string;
};
```

Use the assessment's existing evidence records as the basis for this check; their `whyRelevant` text explains how the inspected source establishes the requirement and bears on the suggestion. Do not add positional evidence indexes, a second evidence array or evidence-role taxonomy. The assessment remains one self-contained record, so repair need not maintain references between mutable array positions. `requirement` states the observable behavior that must survive the change. Evidence can be a caller, documented API, specification, existing contract test, implementation guard or other authoritative source appropriate to the issue. Same-file evidence is allowed; a file being outside the changed module does not make it authoritative automatically.

- [x] Keep the whole assessment and `contractCheck` optional. Absence means unverified, including historical assessments that predate this contract. Preserve the finding and do not ask the model to fill optional fields solely to upgrade the label.
- [x] Normalize a submitted `supported` assessment to unverified unless the suggestion text matches, the contract check is established, the requirement is nonempty after trimming, and the assessment contains at least one evidence record with nonblank path, source location/excerpt and relevance explanation. Evidence can identify a source excerpt without numeric line ranges; do not require one particular location syntax. Retain the submitted assessment in existing raw artifacts and record why its effective status changed.
- [x] Treat missing/unresolved checks and blank support content as lack of support, handled locally. Malformed supplied field types remain subject to ordinary strict schema validation; do not create a separate repair loop for optional support metadata.
- [x] Continue withholding incompatible suggestions from endorsed fix/test sections. A missing contract check does not upgrade an incompatible proposal to a recommendation.
- [x] Instruct the verifier to distinguish implementation consistency from preserving the intended contract. Absence of a contradictory lookup is not evidence of compatibility; a truncated decisive read or acknowledged unresolved acceptance condition cannot support an established check.
- [x] Assess all alternatives within the exact suggestion text. If one branch is unsupported/incompatible, revise the suggestion to supported alternatives or qualify the whole proposal. Do not let one good branch authorize the entire alternative list.
- [x] Preserve the effective assessment through verdicts, revised candidates, grouping, composition input, fallback and artifacts. Never pick a favorable status from another candidate or differently worded suggestion.
- [x] For identical suggestion text within one final group, an explicit supported/incompatible assessment conflict must not be bypassed by citing only the favorable source. Qualify or withhold that proposal and retain both assessments. A missing/unverified assessment alone does not veto another complete supported assessment. Use exact proposal identity for this conservative rule; do not build semantic similarity matching for differently worded remedies. Recompute effective qualification after grouping and on fallback/cache replay.
- [x] Preserve the incompatible assessment and its existing exclusion from recommendation sections when qualifying such a conflict. Qualification may mark the formerly supported proposal as disputed/unverified; it must not relabel the incompatible source as eligible or require a new status enum. Include the conflict in visible verification when it affects the proposed remedy, with both original assessments available in provenance.
- [x] Composer prose may summarize supported proposals, but must preserve their conditions and contract. Conflicting support records do not cancel each other by vote. Retain uncertainty if supplied evidence does not resolve the disagreement.

Keep the contract check, rationale and evidence together through structured repair and normalization. Bind support to the final suggestion text as in Plan 117; do not transplant metadata from another assessment or invent a missing check from rationale text.

This gate checks whether the model supplied an explicit, consistent support basis. It cannot determine whether a source actually establishes the stated requirement. Do not add keyword detection in rationale, a requirement for a particular path, or another LLM judge and call it proof.

### Fix and regression-test assessment

Use the existing rationale to explain the reasoning; no new test-execution stage or mandatory test-plan payload is needed.

- [x] For a fix, establish both that the failure is addressed and that the relevant observable requirement is preserved. State unresolved tradeoffs instead of endorsing them.
- [x] For a test, check that its proposed input/setup reaches the claimed behavior rather than an earlier validation failure. A rejection case is useful when testing rejection, but is not interchangeable with a successful-operation boundary case.
- [x] Check that the expected outcome enforces the stated contract, would distinguish the original defect, and would reject the tempting wrong fix. Agreement between two implementation outputs alone may be insufficient.
- [x] Scope the test assessment independently from the fix. A supported fix does not make a weak test supported; a useful defect-detection test need not choose one implementation strategy.
- [x] When a real contract permits more than one outcome, describe the accepted behavior without inventing one product policy. If the policy cannot be established, leave the recommendation unverified while retaining the established defect.

**Acceptance:** schema/normalization tests cover missing, unresolved, blank and stale support; a supported/incompatible conflict on identical text; and independent fix/test status. Cross-domain report fixtures cover a recommendation that merely weakens a guarantee, an authorization test that asserts local consistency but misses a denied principal, a supported alternative, and a proposed input rejected before the intended branch. Missing checks never fail a valid defect or cause repair. Invalid/stale support never becomes unconditional endorsement. Scripted assessment fixtures test propagation and presentation, not whether a live verifier makes the right judgment. Include a small executable counterexample or manually reviewed example showing that a weak assertion admits the wrong fix while the full behavioral requirement rejects it; reserve claims about model judgment for live measurement.

## Phase 3: Obtain decisive context within the existing budget

Targets: verifier prompt and existing repository-tool guidance/recovery handling; inspect `src/llm/tool-definitions.ts` and the existing budget wrapper before making changes.

- [x] Preserve defect-first budget priority. Recommendation assessment uses already available evidence or a focused remaining lookup; it must not displace the decisive defect check, require tools for every suggestion, or extend the investigation after its budget is exhausted. If the defect is established but recommendation support cannot be completed, submit the verdict with unverified suggestions. Align this with the existing verifier stop/closeout instructions.
- [x] Tell the verifier to identify the governing requirement early when evaluating a recommendation, alongside the decisive defect check, rather than after repeated local rereads exhaust the budget.
- [x] Prefer path-scoped searches and a small range centered on a known hit or branch. Do not always request a large fixed window preceding the relevant line. Follow references only far enough to establish the requirement at issue.
- [x] Use existing truncation/recovery information. If a decisive guard was not delivered, request a focused range around it if budget remains; otherwise record the check as unresolved. Do not infer a missing branch from a partial read.
- [x] Add a narrow regression for a known contract hit later in a large range whose prefix is truncated. Establish that the existing metadata exposes incomplete delivery. If it already does, change guidance/tests only; add tool metadata only if a concrete missing signal is reproduced.
- [x] Do not reserve a new budget per suggestion, transparently fetch omitted content, grant an automatic extension or force a separate caller lookup when the necessary contract is already present.

**Acceptance:** incomplete source delivery is distinguishable from complete evidence; the model has clear focused-read guidance, and lack of evidence produces unverified support. Tests do not claim to prove that every model will choose the better read.

## Phase 4: Consolidate by independent action, not presentation location

Targets: composer prompt, composition projection and integration tests; retain current deterministic grouping thresholds initially.

- [x] Explicitly describe the supplied groups as starting clusters, not mandatory final report boundaries. The composer can combine candidates across groups using existing `findingIds` and complete source accounting.
- [x] Before writing, compare the trigger, mechanism, violated requirement and corrective action. Helper/caller observations of one causal defect should become one finding with multiple evidence locations. Different line numbers, severity ratings or inline/summary-only placement do not establish distinct issues.
- [x] Keep findings separate when there is a distinct trigger/contract or independently actionable correction. A shared helper or file alone does not justify merging.
- [x] Keep a testing finding separate only when it describes an independent actionable testing defect, not merely the regression test needed for the same production bug. Preserve concrete test-boundary evidence when merging.
- [x] Add integration fixtures for cross-group merge accounting, valid anchor selection from merged members, a same-helper/different-contract pair that stays separate, and an independent testing issue. Inspect `expandedFindingIds` and publication handling so presentation boundaries do not silently block valid merges.
- [x] Do not lower fuzzy-match thresholds, auto-merge based on vocabulary, require an extra pairwise model call, or add a mandatory rationale field to every grouping. If later evals still duplicate issues, capture that evidence before expanding the mechanism.

**Acceptance:** the harness permits the correct consolidation without losing evidence or finding identity, and negative fixtures preserve independently actionable issues. Live duplicate quality remains a report-review criterion, not something reference validation can prove.

## Phase 5: Preserve evidence without repeating its serialization

Targets: composition input projection, provenance renderer, presentation metrics and offline preview.

- [x] Use one canonical copy of proof and suggestion-assessment data in the composer input. Remove duplicate serialization in metadata when the same complete data is already present in the source inventory. Keep source IDs stable where possible and audit any changed inventory semantics.
- [x] Render each original suggestion once, followed by its effective status, rationale, contract basis and evidence. Do not print the same suggestion again inside a raw JSON assessment block in the human-facing provenance. Preserve the full original assessment structure in artifacts.
- [x] Render structured proof evidence/assumptions readably instead of dumping JSON in addition to the same prose. Preserve every original record and its attribution; deduplicate only exact equivalents. Keep renderer-owned HTML boundaries and code-fence safety.
- [x] Prefer a small set of decisive whole evidence components in the main view. Keep the current maximum of three; it is a maximum, not a target. No substring extraction protocol or silent excerpt truncation.
- [x] Retain narrative/primary/provenance counts and add uncertainty/evidence contributions where useful to explain renderer growth. Measure from structured rendering pieces; do not rely on regex removal of nested details.
- [x] Record optional support downgrades and reasons separately from schema failure, verification incompleteness and composition fallback. A supported-label downgrade is not a failed defect verification.

**Acceptance:** all source components and material original assessment content remain accessible, while repeated formatting/serialization no longer expands each suggestion unnecessarily. The primary report's size can be traced to authored prose, uncertainty and evidence separately.

### Composition completion and failure-path measurement

- [x] Retain the existing 180-second attempt deadline, current total composition deadline and one retry. Test both attempts timing out while streaming reasoning without tool arguments, and assert bounded cancellation followed by explicit fallback with full source accounting.
- [x] Reduce duplicated input representation before changing the reasoning policy or scheduler. Do not truncate distinct evidence, add another compression model call, or invent a global shorter budget solely to force submission. Make the existing prompt clear that this is synthesis of verified inputs, not an invitation to reinvestigate them.
- [ ] Live measurement: compare prompt size, time to first content, reasoning/tool-argument progress, completion latency and fallback rate on fixed saved inputs. Offline fixtures now verify single-copy projection and report-size changes; the live comparison remains pending. A smaller prompt is a measurable implementation result; a causal claim about better model completion needs repeated live evidence.
- [x] Report unknown usage for cancelled calls honestly. Preserve known usage and cost, and distinguish the recorded subtotal from complete provider billing when final usage is absent; never infer zero charge from missing usage. Reuse existing telemetry fields where sufficient.
- [x] Evaluate normal composition and deterministic fallback separately. A fallback report cannot establish the model's synthesis quality or validate the new synthesis prompts.

## Implementation order and verification

- [x] Preserve the Plan-117 checkpoint recorded before run 94; create no further commit or private-eval mutation as part of implementing this plan without a subsequent request.
- [x] Capture sanitized baseline fixtures and record the before/after preview before implementing changes.
- [x] Implement Phase 0A first with a failing runner regression, then Phase 0B/C. Follow with the existing presentation, assessment, focused-read, consolidation and provenance changes. Keep recovery correctness and report-quality changes independently reviewable; exercise composition failure paths before declaring completion.
- [x] Bump live schema/prompt/cache behavior versions where contracts or behavior change. Test real provider-safe schema validation, retained-draft repair, cache revalidation and historical assessment fallback.
- [x] Run focused tests, `pnpm test`, `pnpm run check`, `pnpm run build` and `git diff --check`.
- [x] Review the offline preview as a reader: one diagnosis, observable consequence, decisive proof, qualified recommendation/test and only the material current uncertainty. Expand provenance to confirm no original evidence or attribution disappeared.
- [x] Use fixtures from at least two unrelated domains. Keep repository paths, model names, numeric examples and the run-93 bug out of production rules.

## Measurement and completion

Implementation does not require paid model calls. Prepare replayable inputs using the existing offline fixture entry point and runner; subsequent live evals are separate measurements. Do not change reasoning at the same time and then attribute the difference to this plan.

- [ ] Compare initial full evals against the same-model baselines: DeepSeek run 93 and GLM run 94, with unchanged routing/reasoning settings. Inspect recommendations, tests, false positives and contradictions manually as well as eval score. Treat GLM run 94 as a fallback/completion baseline, not a successful synthesis sample.
- [ ] Measure coverage, recovery/fallback, extra repair burden, cost and latency alongside primary/provenance size, duplicated actionable issues and actual caller-contract evidence.
- [ ] Prefer multiple samples and a second model when authorized. One successful schema submission or shorter report does not prove semantic quality.
- [ ] Document any remaining unsupported endorsements or duplicate findings rather than treating a passing expected-issue check as report-quality success.

Code completion requires passing tests/checks, a reproduced-and-fixed reject/repair acceptance path, actionable repair diagnostics, consistent effective-candidate propagation, intact source accounting, conservative support handling, bounded honest composition fallback, no new mandatory model calls, and reviewed cross-domain previews. Live quality measurement may remain pending explicitly. The desired measured outcome is a more useful primary report with genuinely supported or honestly qualified recommendations—not merely fewer words or more populated assessment fields.

## Review notes

Reviewed against the current source inventory/validation, suggestion normalization, rendering and grouping behavior before implementation. The scope remains targeted, with these clarifications:

- Sources with unresolved assumptions must participate in the visible verification synthesis; keeping their originals only in provenance is insufficient. This is a structural inclusion check, not proof that the prose preserves every material condition.
- The optional contract check has only status and requirement. Existing assessment evidence/relevance fields carry the support; positional indexes were removed to avoid unnecessary repair/reference maintenance.
- Explicit conflict on identical suggestions cannot be hidden by selecting a favorable source. Missing assessment is not treated as contradictory evidence.
- Defect proof retains budget priority; optional remedy checks cannot become another mandatory investigation.
- Scripted regression fixtures establish harness behavior. Executable/manual counterexamples and later live review establish different kinds of evidence and must be reported separately.
- Final review clarified that reject cleanup uses the assembled, trusted verdict consistently across acceptance and preservation gates; sparse repair patches cannot select the branch implicitly. It also requires fallback to satisfy the same source-accounting and visible-condition rules without fabricating synthesis, and preserves incompatible-source exclusion when recommendation assessments conflict.

Run 94 has now been reviewed. This revision adds Phase 0 for verdict-aware canonicalization, preserved semantic diagnostics, adequate evidence for absence claims and consistency after compact revisions. It also covers false fallback-disagreement labels, two actively streaming composition timeouts, and unknown cancellation cost. The previous run-93 presentation and recommendation work remains in scope after those correctness fixes.

Implementation is complete. Live semantic quality remains an explicit measurement gate; no paid evaluation, commit, staging, push or private-eval mutation was performed.

### Implementation record

- Added a pure stage-specific submit normalization hook, with identity behavior elsewhere. Trusted explicit reject submissions discard only revision fields before acceptance; merged repairs, cache validation and adapter application use the same rule. Raw inputs and exact removed fields are recorded separately from shape cleanup. Kept omission-as-retention, strict effective-payload validation, and existing bounded repair. Semantic failure details survive subsequent field-repair prompts.
- Strengthened verifier guidance for negative evidence, affected fields after narrowing a claim, contract-preserving fixes/tests, and focused reads. Existing truncation metadata was sufficient; no tool protocol or budget change was needed. Added optional `contractCheck` and local qualification for incomplete support; incompatible proposals remain withheld. Exact-text supported/incompatible conflicts cannot be evaded by selecting a favorable source.
- Composition now owns secondary uncertainty, with required visible source attribution and an essential-condition safeguard. Fallback renders explicit unsynthesized conditions without manufacturing disagreement. Proof is serialized once in prompt input; readable provenance retains source attribution, historic severity/confidence, original assessment status when downgraded, and evidence without repeating suggestion text inside JSON.
- Added cross-domain fixtures, actual runner/cache repair regressions, semantic-diagnostic continuation, effective-revision propagation, cross-cluster composition with valid anchor selection, wrong-fix counterexamples and actively streaming composition-deadline coverage. Existing cost aggregation already distinguishes unknown-cost calls from the recorded subtotal.
- Bumped verifier/composer schema and prompt versions and the runner message version to invalidate affected cached behavior. Reasoning, routing, deadlines, retry counts and grouping thresholds are unchanged.
- Reviewed identical-input offline previews: minimum-output fixture primary/provenance words changed from 105/400 to 93/326, with 18/18 sources; authorization fixture from 82/254 to 72/215, with 8/8 sources. See `tests/fixtures/composition/README.md` for method and limits. These are deterministic presentation measurements, not live model-quality results.
- Validation: `pnpm test`, `pnpm run check`, `pnpm run build`, and `git diff --check` passed. Live comparisons, false-positive review and repeated completion measurements remain unchecked above.

## Deliberate limits

Composition still performs semantic synthesis, and verification still judges source meaning. An explicit contract check can also be wrong; it improves the task and exposes its basis rather than providing an infallible validator. Essential-condition gates remain deterministic, while faithful paraphrase, grouping and sufficiency of evidence require model judgment and report review.

Do not solve this by accepting partial schemas, treating all secondary uncertainty as irrelevant, discarding conflicting evidence, hard-coding the observed remedy, or indefinitely adding repair attempts. If the targeted changes do not improve repeat measurements, revisit the demonstrated failure with new evidence.
