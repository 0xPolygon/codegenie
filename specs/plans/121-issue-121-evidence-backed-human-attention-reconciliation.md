# Issue 121: Evidence-Backed Recommendations and Report Reconciliation

Status: IMPLEMENTED — local validation complete; live comparison pending
Based on: trails-api runs 102–106, 2026-09-23
Depends on: existing human-attention provenance, verifier proof assessments, and composition source accounting

## Objective

Check recommendations against the evidenced caller requirement, make the summary agree with the composed conclusions, and stop asking questions that collected evidence has already answered without hiding remaining uncertainty. Refine the existing verification and composition prompts; add only the bounded human-attention reconciliation described below. Start reconciliation with verifier-generated unresolved concerns, whose candidate and proof-assumption identities are available. Do not broaden the existing fuzzy suppression of packet hints.

## Evidence and diagnosis

Run 102 passed with one consolidated finding, all 68 composition sources accounted for, and no composition repair or fallback. Its human-attention section nevertheless asked whether any head test uses differing token decimals. Another verifier explicitly found the new cross-decimal exact-output test; the primary report also acknowledged cross-decimal tests. Whether affected production routes exist and what the external contract does remained separate questions.

The current `composer.ts` builds packet attention groups and applies existing resolution/publication filters. It then appends each verifier's `unresolvedConcern`, deduplicating only identical question text. These appended concerns are not the structured input to the existing composition call and do not undergo cross-candidate evidence reconciliation. `human-attention.ts` already records grouping, omission and suppression provenance; reuse it instead of creating another reporting pipeline.

This is not proof that every question about the same file is answered. A repository test does not establish deployment, and tests added by the same change establish intent rather than external contract correctness. Run 102's three unresolved rejects must not be reclassified as confirmed findings.

Plan 113 deferred a different shortcut: treating an ambiguous direct-reject verdict as proof that a loosely related packet hint is resolved. This plan does not implement that shortcut or change its backlog status. It requires exact concern identity and explicit supporting evidence, never rejection status or text similarity as a deletion rule.

### Findings from runs 103–106

| Run | Configuration | Result and relevant evidence |
| --- | --- | --- |
| 103 | DeepSeek max; composition max | Passed in 26m29s, but two 300-second composition timeouts led to fallback. Prominent advice lowered the requested output despite stronger alternatives in retained sources. |
| 104 | GLM max; composition max | Failed completeness in 44m09s after one verifier exhausted its worker deadline. Composition also timed out twice and fell back. Three findings substantially repeated one production defect; the advice contradicted retained caller evidence. |
| 105 | Opus high | Passed in 9m12s; composition succeeded in 55s. Verification marked a test supported even though its bound allowed lowering the requested output. A testing finding also endorsed that weaker contract. Composition telemetry recorded no active reasoning mechanism, so its latency is not an equivalent high-reasoning comparison. |
| 106 | DeepSeek max; composition high | Passed in 15m14s; composition succeeded in 131s. The main finding used caller evidence to preserve the request and proposed suitable bounds. The summary still called that requirement contested, and attention questions and broad test-coverage claims exceeded the remaining uncertainty or inspected scope. |

The recommendation defect is not confined to fallback or one model. In run 105, the verifier supplied an unsupported rounding tolerance and claimed its assertion rejected weakening, although the assertion still accepted the specific weaker remedy. A generic counterexample such as returning zero or denying everyone does not establish that a test rejects a smaller contract violation. Calling advice test-only does not establish its correctness either.

These runs used the larger evidence budgets. Tool-budget refusals were 11, 2, 0 and 9 respectively, compared with 28 in run 102. Refusals are distinct from truncated successful results; fewer refusals do not establish that the required caller evidence was delivered. GLM's two refusals do not explain its long reasoning calls, and Opus's zero refusals did not prevent the recommendation error.

Run 106 supports continuing the composition step-down experiment, not a causal claim about quality. Plans and candidates differed, and 106 deliberately skipped a documentation hunk. All four runs preceded the latest fallback recommendation rule below.

## Related work already implemented

- At `budgetBoost = 1`, deep investigation now allows 48,000 tool-result characters (previously 32,000); verification allows 32,000 (previously 16,000). Existing depth/multiplier scaling applies. Calls, rounds, extensions and deadlines are unchanged.
- Verifier prompt `p9.20` now asks whether a suggested test would pass a concrete workaround that weakens the original requirement. The existing assessment rationale explains the counterexample; the verifier can revise the test or leave it unverified. No assessment fields or calls were added.
- Local regressions cover independent fix/test support, revised-test propagation, historical proposal retention and valid alternative implementations. Scripted judgments test harness behavior, not the live model's semantic accuracy.
- The latest deterministic fallback rule withholds a fix or test when multiple distinct supported proposals compete in a group, retaining their evidence and explaining the unresolved advice. Exact duplicates can still publish together. Structured output follows the same publication decision. This prevents arbitrary selection, not a single wrongly supported recommendation; runs 103–106 do not evaluate this change.

These changes precede this plan's implementation. Do not attribute their effects to this follow-up. Keep composition step-down enabled for the planned comparisons; its implementation and reasoning policy are not changed here.

## Proposed implementation

### A. Refine existing recommendation verification

Replace the existing generic counterexample guidance with a precise check in the current assessment task, rather than append another checklist:

- Establish the original requirement from caller input and authoritative evidence. Do not invent a tolerance, exception or weaker guarantee to justify a proposal. Unknown requirements leave the affected advice unverified.
- Evaluate the proposed assertion against the specific symptom-hiding remedy using the triggering input. Explain in the existing rationale what the remedy would return and whether the actual assertion accepts it. Rejecting an extreme workaround is insufficient if the assertion still permits the smaller violation under review.
- Apply the same contract check to all recommendation locations, including suggested fixes that consist of adding tests and advice in testing findings. Test-only changes can encode a weaker requirement or exclude valid implementations.
- Preserve the existing check that the test fails for the reported defect and accepts requirement-preserving alternatives. Revise through the existing finding updates when justified; otherwise retain the proposal as unverified with its evidence.

Use existing assessment fields, evidence budgets and calls. Do not add a semantic checker based on arithmetic or keywords, mandatory investigation, assessment fields or repair attempts. Bump the verifier prompt/cache version as appropriate.

### B. Make the summary consistent with composed conclusions

Refine the existing composition prompt to summarize the conclusions it presents in the findings, including their evidence-backed limitations. When caller evidence resolves an earlier disagreement, present the resolved conclusion in the summary and retain the earlier disagreement in provenance. If the evidence does not resolve it, preserve the uncertainty in both places. Do not assume that newer text or a supported label settles a conflict.

Keep recommendation support checks for summary advice. Do not broaden a test-existence or absence claim beyond the inspected revision, configuration and test scope. A concise summary should state each distinct conclusion once instead of repeating each source's formulation.

Use the existing summary field and composition call; add no summary-resolution schema, judge, second pass or semantic string-matching rejection. This is a prompt and regression-fixture improvement, not a claim that local validation can prove arbitrary prose consistent. On deterministic fallback, retain the existing source-based presentation and disagreement notices rather than manufacture a reconciled conclusion.

### C. Reconcile human-attention concerns conservatively

#### 1. Give verifier concerns exact identities before composition

Collect concerns before building the composition request. Derive stable IDs from candidate identity and proof-assumption index; preserve the original question, scope, essential flag, verdict and packet provenance. Where a rendered concern joins multiple assumptions, keep their original components addressable separately. Unstructured or ambiguously associated concerns remain visible through the existing path.

Keep ordinary packet-note suppression and publication fallback behavior intact. Do not infer identity from shared files, symbols, similar prose or verdict order. A concern from incomplete verification remains ineligible for removal.

#### 2. Supply a bounded evidence inventory to the existing composer

Reuse evidence already collected for this review, including relevant observations from rejected candidates. Include source identity, repository revision, file/location, retained excerpt or source-backed observation, and the associated verdict/uncertainty. A rejected candidate can contain useful observations without its proposed defect being true.

Reference existing composition sources where possible. For evidence outside published groups, use a separate attention-only inventory with stable IDs; do not add rejected findings to composition groups or allow these IDs to satisfy finding source-accounting requirements. Shared paths/symbols may shortlist evidence but cannot establish resolution.

Bound the projection using the existing attention-note selection cap and a named small character cap, initially 16,000 additional characters. Admit complete concern/evidence records; never turn a truncated observation into conclusive evidence. If the needed record does not fit, omit it from reconciliation and retain the concern. Record omissions. Keep the full originals in artifacts.

#### 3. Request optional, auditable resolutions in the same call

Add an optional attention-resolution list to the existing composition submission. Each entry identifies one supplied concern, disposition (`resolved` or `narrowed`), supporting evidence IDs and rationale. A narrowed entry also supplies the remaining question. Omission means unchanged.

The prompt must distinguish the exact predicate and its conditions: source revision, branch/configuration, tested behavior versus production exposure, and local code versus external behavior. Resolve only if the supplied evidence answers the whole addressed question. For a compound question, narrow it only when the rationale identifies the answered portion and preserves every unanswered condition. Disagreement that the evidence does not resolve remains explicit uncertainty; chronology, majority and shared vocabulary are not evidence.

Use the existing call, reasoning policy, deadline and bounded schema recovery. Do not introduce a judge, new investigation, another repair loop, or required resolutions for every concern. When composition is skipped, fails, or falls back, retain the original concerns.

#### 4. Apply conservative structural validation and retain provenance

Validate exact concern IDs, supporting-reference membership in the supplied inventory, nonempty rationale and remaining question for narrowing. Reject duplicate/conflicting resolutions, self-support and references to omitted evidence. Keep original scope metadata immutable; whether the evidence substantively covers that scope remains a model judgment, not a string-matching check. An invalid semantic reference leaves that concern unchanged and records the rejected proposal; it must not invalidate otherwise valid finding composition or trigger extra repair. Malformed schema fields still follow existing strict schema handling.

Reference validation establishes attribution, not semantic truth. No keyword or arithmetic policy can prove that arbitrary evidence answers a question. The existing composer makes that bounded semantic judgment, which must be evaluated with adversarial fixtures and live report review.

Apply accepted resolutions once, before final note selection; remove the later unconditional append that would restore resolved concerns. Narrowed questions inherit original provenance. Preserve original and remaining text, supporting IDs, rationale and disposition in the existing human-attention artifact, with bounded count/ID telemetry. Update its schema version and composition prompt/schema/cache versions as needed.

Section C changes the human-attention presentation only. Its resolutions must never change verifier verdicts, finding proof assessments, essential-assumption guards, review completeness or recovery fidelity. Resolved notes cannot resurrect rejected findings, delete their evidence, or imply that the run's coverage was more complete.

## Acceptance and review

- Recommendation fixtures cover an assertion that rejects an extreme workaround but accepts a smaller requirement violation, an invented tolerance, and test-only advice that weakens the contract. Include numeric and nonnumeric cases; production prompts must not encode this eval's filenames, amounts or rounding policy.
- Supported revisions propagate through normal composition and fallback, while unsupported proposals remain retained without being promoted as actionable advice. Valid alternative fixes remain acceptable; no new verifier fields or calls are required.
- A summary fixture pairs an earlier uncertain source with an evidence-backed composed conclusion: the summary reflects that conclusion, the old disagreement remains in provenance, and independent unresolved conditions remain visible. A conflicting-evidence fixture must retain uncertainty. Prompt assertions and scripted outputs test harness behavior, not live semantic accuracy.
- Test-coverage wording is limited to inspected scope; missing or truncated evidence cannot establish repository-wide absence.
- A source-backed observation in another candidate can resolve an exact test-existence question, including when that candidate was rejected. Its rejection alone cannot resolve anything.
- A combined test/deployment question loses only the answered test-existence part; production/external behavior remains visible. Retain original text and evidence in artifacts.
- Same-file different predicate, different configuration or revision, unrelated test, same-change intent evidence, truncated reads and contradictory evidence do not justify full resolution.
- Unknown IDs, missing references, self-support, duplicate proposals, omitted evidence and incomplete-verification concerns remain visible. Structural rejection does not discard valid composed findings.
- Multiple assumptions from one candidate remain separately accounted for. Resolving one cannot erase siblings, merged packet notes, or publication-fallback questions.
- Preserve current concerns when no resolution is proposed, when loading cached legacy output, or when composition fails, has no findings or uses deterministic fallback. No extra model call is made solely to reconcile notes.
- Normal output, debug artifacts and report rendering agree; resolved concerns are not appended again. Source counts, verdicts and fidelity are unchanged.
- Use sanitized examples from at least two domains, including a nonnumeric case. Distinguish scripted model decisions from semantic quality measurements.

Likely files: `src/pipeline/composer.ts`, `src/pipeline/human-attention.ts`, `src/skills/prompt-builder.ts`, composition schemas/types and the existing verifier, recommendation-publication, human-attention and composition tests. Reuse existing artifact and normalization utilities. Run relevant tests, the full suite, type/workflow checks and build, then review generated prompts and rendered artifacts before considering the plan implemented.

## Evaluation sequence and measurement

1. Implement and review sections A–C, then complete the local checks above. Exercise the already-implemented fallback rule with sanitized retained-source fixtures representing runs 103/104: competing advice is withheld, evidence remains accounted for, and rendered and structured outputs agree.
2. Freeze the code snapshot and eval inputs. The next user-started run should use DeepSeek max with composition step-down, comparing primarily against run 106. Check the actual effective reasoning and routing in telemetry.
3. If that result is sound, run GLM and Opus against the same code and eval inputs, with step-down enabled and each model's configured review reasoning recorded. If a failure warrants a code change, establish a new snapshot and label comparisons accordingly. Do not launch paid evals automatically.

Review each final report for requirement-preserving remedies, tests that reject the specific weakening while accepting valid alternatives, agreement between summary and findings, and attention questions that remain genuinely unanswered. Inspect underlying verifier rationales and composition sources to locate where an error entered the report. Count distinct issues and repeated prose rather than treating more findings or more supported labels as better quality. Record primary-report length separately from expandable provenance.

Record model/routing/configured and effective reasoning, prompt version, actual per-worker budgets, code snapshot, coverage and candidate counts. Compare stage duration, calls, prompt size, repair outcomes, composition/fallback behavior, and known versus missing cost. Successful regeneration does not prove preservation of unreadable original content; report recovery fidelity separately from completion.

Continue measuring budget refusal reasons, relevant caller evidence delivered, truncated results and remaining reserved/extension capacity against runs 102–106. Leave source-extension eligibility and budgets unchanged. Reconsider discovery policy only if needed caller searches still fail despite remaining source-read capacity.

This sequence evaluates the combined follow-up; it does not isolate which prompt, reconciliation or fallback change caused a difference. Run 106 is a historical reference, not a controlled ablation. Step-down effects across models also depend on the actual supported reasoning levels and mechanisms.

## Implementation record

- Verifier prompt `p9.21` replaces the generic counterexample guidance with evaluation of the specific weaker remedy against the actual assertion and evidenced caller requirement, including test advice inside suggested fixes. Existing assessments and finding updates carry the result; no verifier schema fields or calls were added.
- Composition prompt `p10.11` instructs summary consistency, scope-limited coverage claims and conservative attention reconciliation. The existing summary field and finding reconciliations retain original disagreement. There is no new semantic judge or summary repair loop.
- `attention-reconciliation.ts` derives exact candidate/assumption IDs only when the original concern matches the host's joined essential assumptions or a single unambiguous assumption. Incomplete and unstructured concerns stay unchanged. Compound components remain separately addressable.
- The existing composition request receives at most five concern groups under a 16,000-character inventory cap. Complete evidence records include retained excerpts/observations, verdict and proof uncertainty; published source IDs are reused where applicable. Other evidence uses attention-only IDs. Review revision is context, not an invented per-excerpt revision. Omitted records and explicitly budget-truncated evidence cannot support a resolution.
- Composition schema version 7 adds optional `attentionResolutions`. Valid schema with bad references, self-support, duplicate/conflicting proposals or incomplete narrowing keeps the concern unchanged without failing finding composition or asking for repair. Malformed schema types still use normal strict recovery.
- Resolutions apply only after successful attributed composition with published findings. Fallback, degraded/legacy composition and no-finding output preserve original concerns. They do not alter verdicts, essential proof guards, completeness, recovery fidelity, packet-note matching or finding source accounting.
- Human-attention artifact version 3 retains full originals, supplied/omitted evidence, decisions and remaining questions. A serialized snapshot prevents shared provenance objects being redacted as circular data. Bounded count/ID telemetry records reconciliation outcomes; rendered, posting and structured notes use the same result.
- Regression coverage includes numeric and nonnumeric recommendation counterexamples, test-only advice, supported revision propagation, invalid/omitted evidence, compound narrowing, full resolution, incomplete verification, fallback and legacy handling, summary disagreement, and immutable provenance. Scripted semantic decisions are explicitly distinguished from live model quality.

Validation: full suite, type/workflow checks and build passed. No paid eval was launched. The next measurement remains DeepSeek max with composition step-down against run 106, followed by GLM and Opus on the same snapshot if the result is sound.

## Out of scope

New verifier fields, cross-verifier re-adjudication, fuzzy note deletion, changes to ordinary packet-note matching, model-specific rules, additional judge or investigation calls, more retries, relaxed validation, further budget increases and composition reasoning-policy changes. The work listed under related work predates this implementation and must not be counted again.
