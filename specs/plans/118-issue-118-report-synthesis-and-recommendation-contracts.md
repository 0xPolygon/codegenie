# Issue 118: Report Synthesis and Recommendation Contracts

Status: PENDING — reviewed; awaiting run-94 comparison before implementation, 2026-09-23 (America/Toronto)
Depends on: Plan 117; existing structured proof assessments, source accounting and bounded repair
Baseline: run 93, DeepSeek 4.1 Flash/max, runtime db1ea55 with the unstaged Plan-117 implementation

## Objective

Produce one readable conclusion per actionable defect, with recommendations that preserve the relevant behavioral requirement. Keep original evidence and uncertainty available without turning the primary report into an accumulation of worker observations.

Use the existing verifier and composer. This is a targeted follow-up, not another investigation stage, semantic-proof engine, report-generation pipeline, or repair scheduler.

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

## Design decisions

| Concern | Chosen approach | Boundary |
| --- | --- | --- |
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
- Keep strict live schemas, semantic validation, cache validation, bounded repair, fidelity reporting and fallback disclosure.
- Keep provider routing, composition reasoning, investigation reasoning, repair effort, concurrency, deadlines and retry counts unchanged for the initial measurement.

## Phase 1: Give the current conclusion one author

Targets: `src/pipeline/composition-content.ts`, `src/skills/prompt-builder.ts`, existing composition schema/validation only where needed.

- [ ] Reuse the current impact/verification/fix/test sections. Do not introduce a second model-written uncertainty list, an additional synthesis pass or a claim graph.
- [ ] In the verification section, instruct the composer to combine equivalent secondary uncertainties by meaning, identify the consequence of each remaining uncertainty, and distinguish established facts from open questions. Link to the already supplied verification/proof sources using existing source references.
- [ ] Require proof sources containing unresolved assumptions, and the affected sources of unresolved reconciliations, to be attributed to the visible verification section rather than only `retainedSourceRefs`. A valid evidence-backed supersession may discharge a non-essential source; essential conditions remain protected. Use the existing source inventory and reconciliation records, with no new payload shape. This enforces inclusion in the synthesis task, not semantic fidelity of the resulting prose.
- [ ] Stop unconditionally appending every non-essential proof assumption and every unresolved reconciliation rationale to the primary body. Their originals remain in provenance. Explain material unresolved disagreements in the verification section once, rather than in both that section and a renderer-generated list.
- [ ] Retain a narrow deterministic safety block for unresolved proof status and essential assumptions. Preserve exact wording with safe exact deduplication only. An unexpected unresolved essential condition is not permission to publish an unconditional defect; retain existing verification gates and honest legacy/fallback disclosure.
- [ ] Do not automatically print a severity-vote summary merely because historic severity values differ. Preserve the values as provenance. If uncertainty still changes the appropriate severity, the composed verification must explain the reason rather than list votes.
- [ ] Keep existing reconciliation support requirements. Corrected observations remain attributable, and source order or majority does not establish truth. Rendering an unresolved reconciliation only in provenance does not discharge the composer's obligation to state its material consequence visibly.
- [ ] Use the same ownership rule for normal and summary-only findings. Summary-only is a placement decision, not a second class of issue that should bypass consolidation.
- [ ] Keep fallback conservative: label synthesis unavailable, retain the representative conclusion and original records, and keep unresolved conditions visible. A fallback may be longer than successful synthesis; do not invent a consolidated truth or silently hide secondary material uncertainty to meet a length target.

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

- [ ] Keep the whole assessment and `contractCheck` optional. Absence means unverified, including historical assessments that predate this contract. Preserve the finding and do not ask the model to fill optional fields solely to upgrade the label.
- [ ] Normalize a submitted `supported` assessment to unverified unless the suggestion text matches, the contract check is established, the requirement is nonempty after trimming, and the assessment contains at least one evidence record with nonblank path, source location/excerpt and relevance explanation. Evidence can identify a source excerpt without numeric line ranges; do not require one particular location syntax. Retain the submitted assessment in existing raw artifacts and record why its effective status changed.
- [ ] Treat missing/unresolved checks and blank support content as lack of support, handled locally. Malformed supplied field types remain subject to ordinary strict schema validation; do not create a separate repair loop for optional support metadata.
- [ ] Continue withholding incompatible suggestions from endorsed fix/test sections. A missing contract check does not upgrade an incompatible proposal to a recommendation.
- [ ] Instruct the verifier to distinguish implementation consistency from preserving the intended contract. Absence of a contradictory lookup is not evidence of compatibility; a truncated decisive read or acknowledged unresolved acceptance condition cannot support an established check.
- [ ] Assess all alternatives within the exact suggestion text. If one branch is unsupported/incompatible, revise the suggestion to supported alternatives or qualify the whole proposal. Do not let one good branch authorize the entire alternative list.
- [ ] Preserve the effective assessment through verdicts, revised candidates, grouping, composition input, fallback and artifacts. Never pick a favorable status from another candidate or differently worded suggestion.
- [ ] For identical suggestion text within one final group, an explicit supported/incompatible assessment conflict must not be bypassed by citing only the favorable source. Qualify or withhold that proposal and retain both assessments. A missing/unverified assessment alone does not veto another complete supported assessment. Use exact proposal identity for this conservative rule; do not build semantic similarity matching for differently worded remedies. Recompute effective qualification after grouping and on fallback/cache replay.
- [ ] Composer prose may summarize supported proposals, but must preserve their conditions and contract. Conflicting support records do not cancel each other by vote. Retain uncertainty if supplied evidence does not resolve the disagreement.

Keep the contract check, rationale and evidence together through structured repair and normalization. Bind support to the final suggestion text as in Plan 117; do not transplant metadata from another assessment or invent a missing check from rationale text.

This gate checks whether the model supplied an explicit, consistent support basis. It cannot determine whether a source actually establishes the stated requirement. Do not add keyword detection in rationale, a requirement for a particular path, or another LLM judge and call it proof.

### Fix and regression-test assessment

Use the existing rationale to explain the reasoning; no new test-execution stage or mandatory test-plan payload is needed.

- [ ] For a fix, establish both that the failure is addressed and that the relevant observable requirement is preserved. State unresolved tradeoffs instead of endorsing them.
- [ ] For a test, check that its proposed input/setup reaches the claimed behavior rather than an earlier validation failure. A rejection case is useful when testing rejection, but is not interchangeable with a successful-operation boundary case.
- [ ] Check that the expected outcome enforces the stated contract, would distinguish the original defect, and would reject the tempting wrong fix. Agreement between two implementation outputs alone may be insufficient.
- [ ] Scope the test assessment independently from the fix. A supported fix does not make a weak test supported; a useful defect-detection test need not choose one implementation strategy.
- [ ] When a real contract permits more than one outcome, describe the accepted behavior without inventing one product policy. If the policy cannot be established, leave the recommendation unverified while retaining the established defect.

**Acceptance:** schema/normalization tests cover missing, unresolved, blank and stale support; a supported/incompatible conflict on identical text; and independent fix/test status. Cross-domain report fixtures cover a recommendation that merely weakens a guarantee, an authorization test that asserts local consistency but misses a denied principal, a supported alternative, and a proposed input rejected before the intended branch. Missing checks never fail a valid defect or cause repair. Invalid/stale support never becomes unconditional endorsement. Scripted assessment fixtures test propagation and presentation, not whether a live verifier makes the right judgment. Include a small executable counterexample or manually reviewed example showing that a weak assertion admits the wrong fix while the full behavioral requirement rejects it; reserve claims about model judgment for live measurement.

## Phase 3: Obtain decisive context within the existing budget

Targets: verifier prompt and existing repository-tool guidance/recovery handling; inspect `src/llm/tool-definitions.ts` and the existing budget wrapper before making changes.

- [ ] Preserve defect-first budget priority. Recommendation assessment uses already available evidence or a focused remaining lookup; it must not displace the decisive defect check, require tools for every suggestion, or extend the investigation after its budget is exhausted. If the defect is established but recommendation support cannot be completed, submit the verdict with unverified suggestions. Align this with the existing verifier stop/closeout instructions.
- [ ] Tell the verifier to identify the governing requirement early when evaluating a recommendation, alongside the decisive defect check, rather than after repeated local rereads exhaust the budget.
- [ ] Prefer path-scoped searches and a small range centered on a known hit or branch. Do not always request a large fixed window preceding the relevant line. Follow references only far enough to establish the requirement at issue.
- [ ] Use existing truncation/recovery information. If a decisive guard was not delivered, request a focused range around it if budget remains; otherwise record the check as unresolved. Do not infer a missing branch from a partial read.
- [ ] Add a narrow regression for a known contract hit later in a large range whose prefix is truncated. Establish that the existing metadata exposes incomplete delivery. If it already does, change guidance/tests only; add tool metadata only if a concrete missing signal is reproduced.
- [ ] Do not reserve a new budget per suggestion, transparently fetch omitted content, grant an automatic extension or force a separate caller lookup when the necessary contract is already present.

**Acceptance:** incomplete source delivery is distinguishable from complete evidence; the model has clear focused-read guidance, and lack of evidence produces unverified support. Tests do not claim to prove that every model will choose the better read.

## Phase 4: Consolidate by independent action, not presentation location

Targets: composer prompt, composition projection and integration tests; retain current deterministic grouping thresholds initially.

- [ ] Explicitly describe the supplied groups as starting clusters, not mandatory final report boundaries. The composer can combine candidates across groups using existing `findingIds` and complete source accounting.
- [ ] Before writing, compare the trigger, mechanism, violated requirement and corrective action. Helper/caller observations of one causal defect should become one finding with multiple evidence locations. Different line numbers, severity ratings or inline/summary-only placement do not establish distinct issues.
- [ ] Keep findings separate when there is a distinct trigger/contract or independently actionable correction. A shared helper or file alone does not justify merging.
- [ ] Keep a testing finding separate only when it describes an independent actionable testing defect, not merely the regression test needed for the same production bug. Preserve concrete test-boundary evidence when merging.
- [ ] Add integration fixtures for cross-group merge accounting, valid anchor selection from merged members, a same-helper/different-contract pair that stays separate, and an independent testing issue. Inspect `expandedFindingIds` and publication handling so presentation boundaries do not silently block valid merges.
- [ ] Do not lower fuzzy-match thresholds, auto-merge based on vocabulary, require an extra pairwise model call, or add a mandatory rationale field to every grouping. If later evals still duplicate issues, capture that evidence before expanding the mechanism.

**Acceptance:** the harness permits the correct consolidation without losing evidence or finding identity, and negative fixtures preserve independently actionable issues. Live duplicate quality remains a report-review criterion, not something reference validation can prove.

## Phase 5: Preserve evidence without repeating its serialization

Targets: composition input projection, provenance renderer, presentation metrics and offline preview.

- [ ] Use one canonical copy of proof and suggestion-assessment data in the composer input. Remove duplicate serialization in metadata when the same complete data is already present in the source inventory. Keep source IDs stable where possible and audit any changed inventory semantics.
- [ ] Render each original suggestion once, followed by its effective status, rationale, contract basis and evidence. Do not print the same suggestion again inside a raw JSON assessment block in the human-facing provenance. Preserve the full original assessment structure in artifacts.
- [ ] Render structured proof evidence/assumptions readably instead of dumping JSON in addition to the same prose. Preserve every original record and its attribution; deduplicate only exact equivalents. Keep renderer-owned HTML boundaries and code-fence safety.
- [ ] Prefer a small set of decisive whole evidence components in the main view. Keep the current maximum of three; it is a maximum, not a target. No substring extraction protocol or silent excerpt truncation.
- [ ] Retain narrative/primary/provenance counts and add uncertainty/evidence contributions where useful to explain renderer growth. Measure from structured rendering pieces; do not rely on regex removal of nested details.
- [ ] Record optional support downgrades and reasons separately from schema failure, verification incompleteness and composition fallback. A supported-label downgrade is not a failed defect verification.

**Acceptance:** all source components and material original assessment content remain accessible, while repeated formatting/serialization no longer expands each suggestion unnecessarily. The primary report's size can be traced to authored prose, uncertainty and evidence separately.

## Implementation order and verification

- [ ] Preserve the Plan-117 checkpoint recorded before run 94; create no further commit or private-eval mutation as part of implementing this plan without a subsequent request.
- [ ] Capture sanitized baseline fixtures and record the before/after preview before implementing changes.
- [ ] Implement Phase 1 first, then the assessment/read-guidance changes, consolidation guidance and provenance cleanup. Keep each change independently reviewable.
- [ ] Bump live schema/prompt/cache behavior versions where contracts or behavior change. Test real provider-safe schema validation, retained-draft repair, cache revalidation and historical assessment fallback.
- [ ] Run focused tests, `pnpm test`, `pnpm run check`, `pnpm run build` and `git diff --check`.
- [ ] Review the offline preview as a reader: one diagnosis, observable consequence, decisive proof, qualified recommendation/test and only the material current uncertainty. Expand provenance to confirm no original evidence or attribution disappeared.
- [ ] Use fixtures from at least two unrelated domains. Keep repository paths, model names, numeric examples and the run-93 bug out of production rules.

## Measurement and completion

Implementation does not require paid model calls. Prepare replayable inputs using the existing offline fixture entry point and runner; subsequent live evals are separate measurements. Do not change reasoning at the same time and then attribute the difference to this plan.

- [ ] Compare initial full evals against run 93 with the same model/routing/reasoning settings, inspecting recommendations and tests manually as well as eval score.
- [ ] Measure coverage, recovery/fallback, extra repair burden, cost and latency alongside primary/provenance size, duplicated actionable issues and actual caller-contract evidence.
- [ ] Prefer multiple samples and a second model when authorized. One successful schema submission or shorter report does not prove semantic quality.
- [ ] Document any remaining unsupported endorsements or duplicate findings rather than treating a passing expected-issue check as report-quality success.

Code completion requires passing tests/checks, intact source accounting, conservative support handling, no new mandatory model calls, and reviewed cross-domain previews. Live quality measurement may remain pending explicitly. The desired measured outcome is a more useful primary report with genuinely supported or honestly qualified recommendations—not merely fewer words or more populated assessment fields.

## Review notes

Reviewed against the current source inventory/validation, suggestion normalization, rendering and grouping behavior before implementation. The scope remains targeted, with these clarifications:

- Sources with unresolved assumptions must participate in the visible verification synthesis; keeping their originals only in provenance is insufficient. This is a structural inclusion check, not proof that the prose preserves every material condition.
- The optional contract check has only status and requirement. Existing assessment evidence/relevance fields carry the support; positional indexes were removed to avoid unnecessary repair/reference maintenance.
- Explicit conflict on identical suggestions cannot be hidden by selecting a favorable source. Missing assessment is not treated as contradictory evidence.
- Defect proof retains budget priority; optional remedy checks cannot become another mandatory investigation.
- Scripted regression fixtures establish harness behavior. Executable/manual counterexamples and later live review establish different kinds of evidence and must be reported separately.

No implementation or paid eval is part of this review. The design is reviewed, but the owner requested GLM run 94 on the Plan-117 checkpoint first. Review that result and adjust this plan before implementation; live semantic quality remains an explicit measurement gate.

## Deliberate limits

Composition still performs semantic synthesis, and verification still judges source meaning. An explicit contract check can also be wrong; it improves the task and exposes its basis rather than providing an infallible validator. Essential-condition gates remain deterministic, while faithful paraphrase, grouping and sufficiency of evidence require model judgment and report review.

Do not solve this by accepting partial schemas, treating all secondary uncertainty as irrelevant, discarding conflicting evidence, hard-coding the observed remedy, or indefinitely adding repair attempts. If the targeted changes do not improve repeat measurements, revisit the demonstrated failure with new evidence.
