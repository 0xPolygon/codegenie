# Issue 119: Requirement-Preserving Recommendation Verification

Status: IMPLEMENTED — local validation and review complete; post-change live comparison pending, 2026-09-23 (America/Toronto)
Depends on: Plans 117–118; current composition reference cleanup and focused repair implementation
Measurement baseline: runs 95–97; Opus 67 and DeepSeek 93 are qualitative comparisons, not controlled benchmarks

## Objective

Keep defect verification, fix verification, and regression-test verification distinct. Publish supported advice that preserves the relevant observable requirement; retain uncertain or incompatible proposals for audit without presenting them as recommendations in the main report.

A real defect must survive an absent, incorrect, or unverified remedy. Composition should organize verified conclusions, not perform a second investigation into whether a fix is safe.

## Evidence and limits

### Run 95

The eval passed in 24m56s with 99 model calls and $0.4417 recorded cost. Eleven candidates produced nine accepted/revised findings and two rejections. Two verification submissions needed three repair calls in total, all eventually successful. Verification nevertheless accepted a false claim that cross-decimal EXACT_INPUT tests were absent. Composition returned a structured submission at high reasoning, but attribution errors survived three repairs, causing fallback and five published findings. Three findings repeated the rounding defect; the missing-test claim was false and the postmortem claim was weak.

The reference cleanup implemented after this run passes the original composition submission after removing seven redundant misplaced references while preserving all 92 source components. That fixes bookkeeping, not the truth of findings or the compatibility of recommendations.

### Run 96

The eval passed in 26m25s with 88 calls and complete 10/10-hunk coverage. Packet review needed five successful first-attempt repairs: three missing-field updates and two regenerated unreadable submissions. The latter do not establish preservation of the unreadable drafts; recovery fidelity was reported as unknown.

Verification completed all ten candidates without schema repairs: five accepted/revised, five rejected, none incomplete. It correctly rejected the broad missing-cross-decimal-tests claim after reading the existing tests. Several claims depending on unestablished external contract semantics were also withheld as findings. This is a meaningful improvement in defect verification, not a reason to replace it.

Two max-reasoning composition attempts each exhausted the old 180-second limit. Both streamed reasoning (approximately 61k and 64k characters), but neither emitted report arguments. Fallback published two overlapping accounts of the same rounding defect with different severities. The new attribution cleanup and focused repairs were not exercised. Recorded cost of $0.3562 excludes unknown usage for both cancelled calls; do not claim a measured cost saving.

The final report demonstrates the recommendation gap:

- One verifier identified a caller check requiring the published minimum to meet the original request, but the retained fix still offered lowering that minimum. Local agreement between two values is insufficient if both can now violate the original requirement.
- Another verifier described a compound fix and its proposed test as supported based on local accounting and divisible-input tests. The harness correctly made the assessments unverified because the behavioral requirement had not been established. The prominent report nevertheless displayed those proposals under unverified labels.
- Proposed regression tests checked that delivery meets the published promise without consistently also checking that the promise meets the original request. Such a test can pass after an incorrect fix that weakens the promise.
- All ten underlying suggestion sources ended up unverified. The fallback retained them honestly but still exposed them as prominent advice. Honesty of labeling does not make the advice actionable.

Run 96's report had approximately 2,178 words outside expandable details versus 4,174 in run 95 (whole reports: 6,136 versus 10,996). Fewer accepted candidates explain much of the reduction; neither run had successful composition. Opus run 67 traced the caller requirement and explicitly explained why lowering the promise was unsuitable. These are observational comparisons with different code, inputs to stages, and budgets, not controlled model benchmarks.

### Run 97: successful composition exposes the remaining recommendation gap

Run 97 passed in 20m23s with 91 calls, complete coverage, and $0.3942 recorded cost with no unknown call costs. The runtime identifies dirty commit `6fd21eff456a`; that identifier alone is not a complete snapshot of its uncommitted code. The run was started after the composition deadline update. Verification finished all nine candidates (five accepted/revised, four rejected), needing three repair calls across two submissions. Packet review needed six repair calls across three submissions. All recovery obligations resolved, but some repairs changed existing evidence/intent fields and a verdict, so recovery fidelity is unknown rather than exact preservation.

Composition at max succeeded on its first attempt in 135 seconds, with no cleanup, repair, timeout, or fallback. It merged five accepted candidates into one finding and accounted for all 54 source components. It generated approximately 105,500 reasoning characters, yet finished within even the former 180-second limit. This is evidence that max can complete, not that the longer deadline caused success or that more reasoning consistently improves judgment.

The final finding is 811 primary words. The whole report outside expandable provenance is 1,361 words, versus 2,178 in run 96, 4,174 in run 95, 2,421 in DeepSeek 93, and 1,329 in Opus 67. Run 97 correctly consolidated duplicates, distinguished zero-value rejection from the remaining rounding bug, and reconciled earlier uncertainty about existing tests. Preserve these gains. Opus still explained the caller's requirement and downstream consequences more convincingly; DeepSeek 93's main recommendation also preserved the original request through rounding upward or rejection. Neither older report is an unquestioned oracle: some proposed test inputs miss the intended branch.

Three findings directly change this plan:

1. **The existing assessment representation was not used.** Successful raw verifier submissions omitted `suggestionAssessments`; the final source inventory contains seven effectively unverified suggestions and no established recommendation contract check. This run does not demonstrate that the existing schema is too weak to express support. Adding more fields would increase output burden without addressing the omission or missing investigation. Reuse the current shape in this iteration.
2. **Unsupported advice escaped into the summary.** Although fix/test sections were labeled unverified, the opening summary recommended lowering the promise or rejecting unaligned requests. The policy must cover every reader-facing surface, including summary, impact, and verification prose—not only the labeled recommendation sections.
3. **The suggested test excludes a valid remedy.** The fix paragraph offers ceiling conversion, but the test requires the published minimum to equal the rounded-trip delivery (or the route to reject). With ceiling conversion, delivery may correctly exceed the original requested minimum. The test must enforce the original observable requirement without adding an unnecessary equality. In the sanitized numeric fixture, the governing relation is `deliverable >= promised minimum >= original request`; this formula is fixture content, never production policy.

A separate evidence-flow issue was also observed: a rejected candidate's verifier read `registry/routes_hwr_usdc.go` and established configured 6↔18-decimal pairs, but that evidence was absent from the composer's accepted-finding source inventory. The final report still asked whether such routes were configured. Repository configuration does not by itself prove production use or non-divisible requests. Four human-attention entries also overlap on reachability/router semantics. Record this as a follow-up; do not reintroduce rejected findings or widen plan 119 into cross-candidate evidence sharing.

Artifacts used for review: `logs/97/info.json`, `telemetry/model-calls.jsonl`, `telemetry/events.jsonl`, raw `debug/llm-calls/*.response.json`, `stages/09-verification/verification.json`, `stages/10-composition/composition-sources.json`, and `telemetry/final-review.md`, under the trails-api `49f4645b` private eval. Keep private artifacts out of repository fixtures; use sanitized behavioral examples.

## Scope and invariants

- Use the existing Stage 9 verifier, its tools/budgets, and Stage 10 composer. No extra model stage, mandatory caller lookup, larger budget, retry-count increase, or model-specific policy.
- Preserve strict schema and semantic validation, exact suggestion-text identity, source accounting, and the current repair/cancellation contracts.
- Missing optional assessment data means unverified advice, not an incomplete defect or a repair obligation merely to obtain an endorsement.
- An explicit supported label with insufficient support is downgraded to unverified, with an auditable reason. Malformed supplied schema values still use ordinary validation/repair.
- No regex splitting of prose alternatives, keyword-based compatibility judgments, inferred mathematical truths, repository paths, model names, or eval identifiers in production decisions.
- Evidence can establish a requirement in the same function/file, a caller, tests, documentation, or another authoritative source. A separate caller file is not universally required. Conflicting or unread evidence is not resolved by claiming that no contradiction was found.
- All original proposal text, assessments, and evidence remain available in artifacts. Proposals omitted from the main recommendation remain available in expandable provenance. Do not silently delete incompatible alternatives to obtain a supported label.
- Machine validation can establish structural support and attribution, not the truth of the model's behavioral reasoning. Human review of fixtures and live reports remains necessary.

## Proposed design

### 1. Make the verifier's three judgments explicit

Update the existing verifier instructions and examples to perform, within its current investigation:

1. Establish or refute the defect's trigger, mechanism, and violated requirement.
2. For each proposed remedy, determine whether it fixes the defect while preserving the applicable caller/API requirement and material boundary behavior.
3. For the proposed test, establish that setup reaches the relevant behavior and that the expected result tests the requirement, rather than merely matching the suggested implementation.

When evidence permits, identify the governing requirement alongside defect proof and reuse the same focused source reads. Prefer reading the decisive caller/check around a known location over another broad, truncated search. Defect proof has priority; exhausted budget leaves advice unverified and does not force another call.

For a regression test, the verifier should explain in the existing assessment rationale what fails before the fix, what must hold afterward, and why a plausible wrong fix that merely weakens the requirement would not pass. Also check the other direction: the assertion must accept a requirement-preserving implementation even when it differs from the candidate's proposed algorithm. Do not assert equality, exact ordering, exact timing, or an implementation detail unless the requirement establishes it. Check numeric examples and boundary inputs against the actual branch and existing guards; a divisible input does not test remainder handling, and a request rejected by an existing guard does not demonstrate a successful-quote defect. Do not require a counterexample when the evidence does not support one or invent execution results; source inspection is not a claim that the test was run.

### 2. Bind support to the requirement and exact final proposal

Reuse the existing optional assessment shape in this iteration:

- `suggestionText` exactly identifies the final proposal being assessed.
- `status` distinguishes supported, incompatible, and unverified.
- `contractCheck.status` and `contractCheck.requirement` identify whether the governing observable requirement was established.
- Existing `evidence` entries and their `whyRelevant` explain which inspected source establishes that requirement and which source connects it to the proposed change.
- Existing `rationale` explains why the exact proposal preserves the requirement, or identifies the contradiction/missing proof. For a test, it explains reachability, the expected before/after behavior, and why the assertions neither weaken nor unnecessarily strengthen the requirement.

Do not add a second evidence array, preservation field, mandatory assessment object, or per-alternative schema. The existing support gate already requires an established nonempty requirement, complete source evidence, and exact text identity. Keep it, improve schema descriptions/instructions as needed, and test stale/absent/conflicting support. Do not claim that a structurally complete assessment proves that the evidence establishes the requirement. A bare local-code citation cannot become a caller-contract proof merely because its fields are nonempty.

Make recommendation assessment an explicit final verification decision when the assembled finding contains suggestions and sufficient evidence has already been inspected. Use supported/unverified/incompatible as appropriate; do not silently imply that a defect verdict endorses its remedy. Omission still means unverified and remains schema-valid. If the governing requirement cannot be established within the current budget, say so or omit the optional assessment—do not fabricate support, force another call, or move that investigation to composition.

Run 97 supports trying clearer use of these existing fields plus a stricter presentation policy before expanding the schema. Reconsider representation only if a subsequent trace shows that a correct assessment cannot be expressed or attributed with this shape, rather than merely showing another omitted assessment.

Keep the existing two final suggestion slots (`suggestedFix`, `suggestedTest`). Do not add a remedy-array schema in this iteration. Instruct the verifier to assess alternatives separately, then return one concrete supported direction when established, or retain the compound proposal as unverified if its branches cannot all be supported. A supported alternative does not endorse its siblings. A known incompatible branch prevents endorsing the entire compound string. The harness must not split natural language on “or” or try to infer how many alternatives exist.

If the verifier revises a suggestion to one supported alternative, bind the assessment to that exact new text and preserve the original proposal separately as historical provenance. A changed suggestion or contradictory assessment cannot inherit an older supported label.

### 3. Publish supported advice prominently; retain the rest in provenance

Apply the same policy to successful composition and deterministic fallback, in Markdown and structured report output:

- Make the opening summary diagnosis-focused: describe the defect, scope, and material uncertainty, with no proposed remedies or test instructions. Keep recommendations in their dedicated supported sections. The same restriction prevents impact/verification prose from being used to bypass recommendation status.
- Fix/test sections may cite only effectively supported suggestion sources. Unknown, stale, incompatible, or conflicting support does not authorize prominent advice.
- Unverified and incompatible suggestion sources remain accounted for in `retainedSourceRefs` and expandable provenance, with their original assessment and evidence.
- If advice exists but none is supported for a category, render one short factual note, such as “Remediation remains unverified; original proposals are retained below.” Do not restate the proposal in that note or repeat it once per candidate.
- A finding with no suggested fix/test needs no placeholder or invented remedy.
- A valid defect remains published when no supported advice is available.
- The composer cannot turn unverified sources into endorsed advice, borrow support from a different proposal, or endorse a compound remedy because one member has supporting evidence.

Validate eligibility at the source-reference boundary and render unsupported-advice notes deterministically; do not silently accept invalid attribution. Summary and free-prose restrictions are prompt and review requirements: the harness cannot prove arbitrary prose contains no advice from source IDs alone. Add representative fixture/live checks for leakage, and report that limitation honestly. Do not introduce regex advice detection, another LLM call, a new summary schema, or automatic deletion of model sentences in this iteration.

For supported fix/test prose, instructions must also prohibit strengthening the assessed proposal or synthesizing an unassessed combination. Exact assessed source text remains in provenance. Source attribution establishes ownership, not semantic equivalence between original and composed wording.

Source accounting remains complete. Do not simply filter unsupported suggestions out of the composer input: it needs their dispositions and provenance. Reuse the existing source model and effective assessment checks. Constrained attribution-repair schemas must reflect the same eligibility rule as semantic validation; do not offer unverified IDs as valid fix/test-section replacements.

Trace the original candidate through verifier revision to the composer before editing this path. If the renderer currently sees only final suggestion text, carry the original suggestion and its assessment as a historical, provenance-only source, linked to the same candidate. Add at most one original source per revised suggestion field; unchanged text must not be duplicated. Keep raw intermediate repair submissions in existing debug artifacts rather than expanding every repair draft into the user report. Historical text must never inherit the revised proposal's support or become a new finding.

This is a provenance-only addition to existing composition inputs, not permission to return a second competing finding representation. Update source inventories, schemas, renderer, and accounting together.

### 4. Keep diagnostics and measurement honest

Use existing assessment events and composition artifacts to record:

- Raw versus effective support, including existing structural downgrades for absent/unestablished contract checks, missing evidence, or stale text. Preserve the model's rationale about requirement compatibility without claiming a deterministic semantic verdict.
- Published supported advice versus proposals retained only in provenance.
- Stale assessments after suggestion revisions and conflicting assessments for exact matching proposals.

Add fields/counts to existing records only where needed to observe these outcomes. Do not create another audit subsystem, claim that a supported label is a proof certificate, or conflate unverified advice with incomplete verification.

Report omitted optional support separately from malformed verdicts. Measure whether the change adds repair traffic, verification latency, or oversized prompts. Keep full evidence in artifacts and avoid serializing the same proposal repeatedly in the main report.

## Implementation work

1. Use the completed run-97 review below as the baseline. Reuse the existing assessment schema; inspect revision/provenance plumbing before changing it.
2. Add sanitized behavioral fixtures before changing prompts: one exact-output/API-request case and at least one unrelated case such as authorization or persistence. Express expected judgments explicitly.
3. Update verifier instructions and relevant schema descriptions, preserving the existing assessment shape and support gate. Cover explicit final assessment, governing requirement evidence, each alternative, and fix/test consistency. Update prompt/schema versions and cache identities only where the changed request or contract requires it.
4. Carry original revised proposal provenance where needed; ensure current versus historical assessments cannot be confused.
5. Update composer instructions (including diagnosis-only summary and no advice in impact/verification), source eligibility validation, focused attribution-repair allowed IDs, and both rendering paths to use the same supported-only prominent-advice rule.
6. Add the focused tests below, review the patch, then run `pnpm test`, `pnpm run check`, `pnpm run build`, and `git diff --check`.
7. Run a subsequent live eval with model/routing/reasoning/deadline settings held fixed relative to run 97. Compare artifacts, not only pass/fail. Do not rewrite private eval expectations during implementation.

Likely code locations:

- `src/types.ts`, `src/llm/schemas.ts`, `src/llm/verifier-revision.ts`
- `src/skills/prompt-builder.ts`
- `src/pipeline/verifier.ts`, `src/pipeline/suggestion-assessment.ts`
- `src/pipeline/composer.ts`, `src/pipeline/composition-content.ts`, `src/pipeline/composition-repair.ts`
- Existing verifier, report-synthesis, composition-contract, composition-repair, and runner tests; sanitized composition fixtures

## Regression and acceptance cases

- A valid defect plus no advice/assessment remains a valid finding without a new repair call.
- Supported advice using the existing shape, a same-file established requirement, complete source evidence, and a rationale explaining preservation stays supported; do not require a separate caller file or newly invented fields.
- Missing optional contract checks or structurally incomplete support produce unverified advice without changing the finding verdict. Separately, semantic fixtures require local-consistency-only reasoning to be treated as insufficient support; do not pretend a structural validator can establish that judgment.
- A fix that makes two internal values agree by weakening the original API requirement is assessed incompatible in the fixture; another actually requirement-preserving fix remains eligible.
- A compound proposal with mixed support is not endorsed wholesale. Selecting a supported replacement preserves the original compound proposal and its disposition in provenance.
- A test that merely matches the wrong fix does not get endorsed; a test asserting the original observable requirement and reaching the relevant branch can be supported.
- The paired fixture also checks overconstraint: an assertion must accept the supported ceiling/overdelivery remedy and reject lowering the original promise. Add an unrelated example (e.g., ordering or authorization) so this is not a numeric special case.
- Verify proposed sample inputs: divisible versus non-divisible and existing-guard versus affected-branch cases. Do not treat an older model's report as the fixture oracle.
- Exact text changes invalidate stale support. Conflicting support for identical proposal text cannot be bypassed by selecting the favorable candidate during composition.
- Unsupported fix/test source IDs are rejected in prominent sections, but accepted in provenance accounting. The focused repair tool offers only eligible replacement IDs.
- Successful synthesis and fallback both keep valid findings, supported advice, original proposals, and all evidence. Both avoid prominently repeating unverified alternatives.
- With all suggestions unverified (the run-97 case), fix/test sections contain no proposed remedies; provenance retains all proposals and assessments, with concise deterministic status notes. The summary instructions require diagnosis-only prose.
- With mixed support, only supported proposals may appear in recommendation sections. An unsupported source remains in provenance even when another proposal is supported.
- Prompt/fixture review explicitly covers unsupported advice leaking into summary, impact, or verification prose and composed wording that strengthens a source. State that these checks are not a universal semantic proof of future model outputs.
- Findings without suggestions do not gain invented proposals. Findings without supported suggestions receive at most one concise per-category note.
- A missing optional support field does not turn an otherwise valid verdict into a partial review. A malformed supplied field still fails validation normally.
- Malformed/unknown source references and incomplete merged submissions remain rejected; existing source-cleanup and bounded-repair tests continue to pass.

Tests of support normalization verify structural policy, not semantic truth. Prompt tests verify the stated task; sanitized fixture judgments and human review of live reports assess whether models perform it well. Avoid claiming improvement solely because the renderer hides unsupported advice.

## Completed run-97 review and implementation gate

- [x] Recorded available runtime identifiers, model/reasoning/routing, and the composition deadline change; dirty commit metadata alone cannot reconstruct an exact uncommitted snapshot.
- [x] Reviewed verification verdicts and repairs. Nine candidates completed; five kept/revised, four rejected; no incomplete verdicts. Local context pressure included 31 tool-budget rejections, so optional recommendation work must not expand investigation budgets.
- [x] Inspected raw successful verdict submissions as well as effective assessments: recommendation assessments were omitted; seven final suggestions were conservatively unverified. No new support fields are justified by this omission alone.
- [x] Checked the final remedy/test pair against the original request and a valid ceiling alternative; found both weakened-requirement and overly restrictive assertion problems.
- [x] Confirmed composition succeeded without cleanup/repair/fallback and retained 54/54 sources. No claim that the new timeout or attribution cleanup caused this result.
- [x] Compared reports 95, 96, 93, and 67. Preserve run 97's single-finding consolidation and concise synthesis; improve requirement-grounded advice.
- [x] Confirmed complete known cost for run 97 and incomplete cancelled-call costs for run 96.
- [x] Chose the existing assessment shape, diagnosis-only summaries, supported-only recommendation sections, and minimal original-proposal provenance plumbing.
- [x] Implemented after the user requested this revised plan. Existing assessment schema and budgets retained.

After implementation, compare a fixed-configuration live run against run 97 for supported recommendation correctness, fix/test compatibility, unsupported-advice leakage, evidence retention, repair rate, verification latency, and prompt size. A shorter report because uncertain advice moved into provenance is a presentation improvement, not proof that recommendation reasoning improved. Report those outcomes separately.

## Implementation and validation

- Updated Stage 9 instructions and assessment descriptions without adding model-authored fields; prompt versions are `p9.18` and `p10.9`.
- Shared source eligibility now gates successful composition, fallback, structured recommendation fields and constrained repair. Conflict checks cover all supplied candidates, even when composition separates them into groups.
- Host-owned `originalSuggestions` retains at most one original assessment/text per revised field. Historical sources remain provenance-only and cannot inherit a replacement's support.
- Existing telemetry now distinguishes supplied/effective assessments and published/provenance-only suggestion source IDs.
- Review caught a necessary repair detail: reference swaps cannot correct unsupported advice prose, and generic array merging cannot remove a section. The existing composition repair hook therefore permits a bounded replacement of advice sections plus retained references, locks diagnosis sections, and validates schema and complete source accounting atomically. It adds no call or retry allowance. The repair tool description permits the schema-authorized values (including advice sections), rather than incorrectly describing every repair as reference-only. A runner regression covers an incomplete repair followed by a valid one without resurrecting removed sections.
- Recommendation publication occurs after defect-selection gates, so withholding advice cannot accidentally suppress an otherwise publishable finding.
- Sanitized numeric and authorization fixtures cover requirement weakening, over-restrictive tests, source retention, historical/stale/conflicting support and summary instructions. These are explicit behavioral oracles and scripted harness tests, not evidence of model judgment.
- Validation: 1,124 tests across 56 files passed, `pnpm run check`, `pnpm run build`, fixture rendering, and `git diff --check`. Live comparison remains pending. Run 98 was started with DeepSeek max on pre-plan-119 code and is an additional baseline, not a validation of this implementation.

## Deferred work

General false-absence detection, cross-candidate evidence sharing, automatic semantic deduplication, severity reconciliation, human-attention grouping, and a new verification/adjudication stage are not part of this plan. Run 97 supplies a concrete follow-up case: useful registry evidence existed only in a rejected candidate's verification record, while the final report repeated a resolved configuration question and overlapping external-semantics questions. Preserve that evidence in artifacts for a later bounded evidence-flow/attention design; do not resurrect rejected findings, infer live production use from repository configuration, or suppress uncertainty by textual similarity. Current composition reasoning, deadlines, retries, and local reference cleanup remain unchanged by plan 119.
