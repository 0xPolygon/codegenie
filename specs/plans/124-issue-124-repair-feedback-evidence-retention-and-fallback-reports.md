# Issue 124: Repair Feedback, Evidence Retention, and Faithful Fallback Reports

Status: IMPLEMENTED — deterministic validation complete; matching live reviews pending
Based on: OMSX runs `20260925-000314-f71ac2b3` and `20260925-000322-502226bb`
Depends on: plans 118–123 and the current local soft/hard investigation budgets

## Objective

Make constrained repairs respond to their latest failure, deliver already-collected evidence to the questions it can answer, and produce an honest, consolidated report when composition fails. Implement these three phases in order. Reuse existing repair, evidence, grouping, and reporting mechanisms; no new model calls or mandatory finding assessments.

## Evidence and limits

Both runs predate the latest soft/hard budget change. Both used max investigation/verification, high composition, and low repairs through OpenRouter.

| Observation | DeepSeek 4.1 Flash | GLM 5.3 Flash |
| --- | --- | --- |
| Duration / calls | 11m6s / 76 | 27m39s / 61 |
| Recorded cost | $0.3129 | $0.2251; one timeout has unknown cost |
| Coverage | Partial; six stage-7 tool refusals | Complete; no tool refusals |
| Composition | Model synthesis after one repair | Timeout, invalid retry, three unsuccessful repairs, fallback |
| Final report | Two distinct validation-test gaps | Two entries describing the same validation-test gap |

Concrete failures:

1. **Repair feedback does not evolve.** GLM's composition retry (`mc-000058`) included an empty section `sourceRefs` list and attribution problems. The constrained schema required literal keys such as `composedFindings.0.retainedSourceRefs`. Repair 1 returned underscore keys and stringified arrays; repairs 2–3 returned a stringified nested `composedFindings` object. All three repair requests (`mc-000059`–`mc-000061`) contained identical messages. Cleanup discarded unsupported keys and validation reported an empty patch, but the next prompt did not explain the rejected representation or latest error.
2. **Relevant source is collected but omitted.** DeepSeek's final report asks whether `ListUsersRequest.Validate()` invokes the nested filter validator. Five source excerpts in the reconciliation evidence inventory contain the invocation; all five were omitted from its prompt. The selected inventory contained 14 of 66 entries. A complete `ListForUser` read (`tc-000130`) from the packet attempt that later failed was also absent from the final inventory after a worker restart.
3. **Fallback output remains misleading or repetitive.** GLM's three verified candidates describe the same missing `List` rejection test. Fallback merged two candidates but left a second finding anchored in the handler instead of the test file. The report says review completeness is complete and mentions composition failure only below the exclusion list and within finding bodies. Review coverage and report synthesis are different outcomes and should be presented explicitly.

GLM's first composition timeout occurred during active streaming, not a silent network wait. Its verification repairs succeeded in 6.4s and 15.4s. These observations support fixing feedback and handoff, not adding retries, increasing deadlines, or lowering reasoning again. Neither model is a ground-truth judge of finding severity or recommendation correctness.

Trace locations: `/home/peter/Dev/0xPolygon/omsx/.codegenie/runs/<run-id>/`, particularly `debug/llm-calls/`, `tool-calls.jsonl`, `stages/09-verification/verification.json`, `stages/10-composition/human-attention-notes.json`, and `final-review.md`. Historical artifacts remain unchanged. Portable regressions must use small synthetic fixtures rather than depend on these private paths.

## 1. Give constrained repairs actionable, current feedback

### Change

- Keep the existing constrained patch schema and permitted-target contract. Fix the shared repair scheduling path so custom prompt overrides and conversation replacement cannot discard the latest validation feedback.
- Capture bounded diagnostics from the rejected patch **before** unknown-key cleanup: supplied keys and value types, exact permitted target keys, and relevant schema/semantic errors. Show the mismatch explicitly, such as an unknown underscore key versus the required literal dotted key, or a string where an array is required. This is diagnostic guidance, not automatic alias mapping.
- Attach those diagnostics on every retry, alongside the current retained draft and outstanding targets. Preserve progress accepted by the existing merge contract; do not repeat an obsolete baseline after a valid partial update. Composition advice-section replacements remain atomic: do not retain rejected replacements through generic array-by-index merging, which could restore intentionally removed sections.
- Supply one small example of the active patch format when it can be derived safely from an actual permitted target and admissible values. For composition references, use existing eligible source IDs; never invent evidence or show an empty list when the target forbids it. Identify dotted keys as literal JSON property names. A one-target example demonstrates syntax, not necessarily a complete repair of every outstanding issue. If a safe example is unavailable, show the exact key/type requirements instead; do not build a general schema-to-example generator or invent a substantive answer.
- Bound and redact feedback, treating submitted text as untrusted data. Prefer key/type/error summaries to replaying the entire rejected payload. Optional targets remain optional.
- Keep complete assembled schema validation, reference ownership, suggestion eligibility, and content-preservation checks. Unknown fields may still be removed, but an empty or semantically invalid patch cannot count as success. Do not broadly accept guessed key aliases, reinterpret unsupported representations, or relax array/value requirements.
- Update the existing prompt/cache version where the changed request contract requires it. Keep three repair attempts and the shared 180-second repair allowance.

### Tests and acceptance

- Reproduce underscore keys, stringified values, and an unsupported nested envelope in a constrained patch. The next request must identify the actual mismatch, list permitted targets, and show a valid format example; a subsequent correct patch succeeds.
- Verify that a custom prompt with conversation replacement retains the latest failure feedback and that successive failures produce successive diagnostics.
- Cover valid partial progress followed by another repair, atomic rejection of invalid advice-section replacements, omitted optional targets, out-of-scope updates, nonexistent references, and still-missing required data.
- Confirm attempt/deadline limits, redaction, and strict final validation. Include a non-composition constrained-patch fixture so the shared fix is not coupled to OMSX or GLM.

Acceptance: retries provide new corrective information instead of issuing identical instructions after different errors. Deterministic tests establish the contract; improved live repair success remains a measurement.

Likely files: `src/llm/pi-runner.ts`, `src/llm/field-repair.ts`, `src/pipeline/composition-repair.ts`, and existing repair/runner tests.

## 2. Preserve source evidence and select it by question coverage

### Retain successful reads across worker attempts

- Deliver accumulated tool evidence on both successful and failed structured requests through the existing tool-result callback or a small extension of that interface. Deliver a snapshot once per request, including cancellation; preserve the original failure/cancellation and do not initiate more investigation during cleanup.
- Keep a bounded, task-scoped collection across retries of the same logical worker. Preserve successful source observations with tool-call, packet, attempt, path, revision, and delivery provenance. Reuse existing evidence bounds and deduplication; do not create an unbounded transcript store.
- Distinguish source observations from model conclusions. A failed attempt may contribute successfully read source, but its malformed findings, unvalidated explanations, or partial submissions cannot become accepted findings or evidence.
- Make retained reads available to downstream evidence selection even when the originating attempt failed. Keep failure status and unresolved tool diagnostics separate: a useful source read does not turn a failed required worker into completed coverage or automatically resolve another refused request.
- Do not inject previous conclusions into independent ensemble prompts or implement the deferred adaptive-prompt experiment. Keep collections isolated by run, logical task, and revision; do not merge different revisions as interchangeable evidence.

### Select evidence for individual concerns

- Refine the current bounded reconciliation selector rather than add another summarization/model pass. It already uses relevance ranking and a direct-source allocation; merely adding another global score or round-robin loop is insufficient.
- Allocate the first selection pass across admitted concerns using existing path, symbol, text, and evidence-origin signals, with deterministic tie-breaking. Prefer complete, directly relevant source excerpts for questions about implementation behavior, and retain observations/assessments where the question concerns a contract or prior verification. One selected item may serve several concerns. No new semantic classifier: ranking allocates context; it does not establish truth.
- Account for whether a concern already has relevant supplied context before assigning more space to it. Defer unrelated entries and repeated observations until the remaining concerns have had an opportunity to receive evidence.
- Have admission explicitly report whether evidence was added, covered by an already supplied excerpt, or rejected by the cap. Only supplied context counts toward question coverage; rejected entries must not consume source-allocation characters or block a smaller excerpt from the same path.
- Deduplicate identical or contained source within the same path and revision, retaining origin links in artifacts and a canonical reference in supplied context. Omitted IDs do not become eligible supporting references through deduplication. Prefer a compact complete excerpt over a larger overlapping read when it provides the same relevant source. Do not manufacture source, silently clip decisive branches, or conflate comments with executable statements.
- Preserve the existing 16,000-character inventory cap, concern admission policy, and complete-reference validation. Record which concerns receive relevant evidence references and which lose candidates to the size cap. These are selection diagnostics, not an automatic claim that a question was answered.
- Continue requiring explicit, eligible supporting references and a valid resolution decision. Narrow compound questions only where evidence answers a specific part; preserve unanswered parts and conflicting observations.

### Tests and acceptance

- Under a tight inventory cap, a short source excerpt containing a requested nested call survives competing verbose assessments and overlapping excerpts. Several independent questions receive useful context rather than one question consuming the inventory. Include a rejected large excerpt followed by an admissible smaller read from the same path, and stable selection under reordered equivalent inputs.
- A successful read followed by malformed submission survives a worker restart and reaches downstream selection. Also cover terminal failure, cancellation, duplicate callbacks, and multiple runs/revisions without cross-contamination or changed completion status.
- Negative controls: same symbol name in unrelated files, head/base disagreements, source-looking text inside comments, truncated or failed delivery, and a compound question only partly answered. None may silently resolve a concern.
- Verify every emitted supporting reference points to supplied context; reject omitted IDs even when their source was deduplicated. Full source provenance remains inspectable in artifacts.

Acceptance: the synthetic equivalents of the observed nested-validation and retry-retention cases supply the already-read source within existing caps. No additional repository/model calls are required. Live runs determine whether models use that source correctly.

Likely files: `src/pipeline/attention-reconciliation.ts`, `src/pipeline/source-evidence.ts`, `src/pipeline/lens-runner.ts`, `src/llm/pi-runner.ts`, the tool-result callback/types, and evidence/runner tests.

## 3. Consolidate faithful fallback reports and disclose synthesis failure

### Consolidation

- Reproduce the three-candidate/two-entry case against the existing grouping functions before changing them. Extend the existing grouping path; do not create a separate fallback clustering engine or another model call.
- Permit a cross-file group when candidates identify the same behavioral boundary and failure predicate with concrete shared implementation evidence, even when one anchor is in a test and another is in its implementation. Use existing normalized terms and evidence relationships; do not lower a global similarity threshold until different issues happen to merge.
- A shared helper, similar title, common file, or common category alone is insufficient. Preserve distinct endpoints, constraints, or causes where the evidence does not establish equivalence. Different suggested remedies alone do not establish different bugs; keep their qualifications when grouping the same defect. Avoid transitive merging that combines unrelated endpoints through a broad middle candidate. When uncertain, retain separate findings.
- Consolidation changes presentation, not acceptance: preserve every member ID, source component, uncertainty, and recommendation assessment. Use existing representative/severity policies; never upgrade an unverified suggestion because another member has supported advice. Keep explicit disagreement in provenance.
- Keep deterministic fallback source-based. Do not reuse invalid composer prose or unvalidated merge decisions. Publish supported current advice through the existing rules, with full provenance retained in expandable sections.

### Top-of-report disclosure

- Drive a concise, host-authored notice from the existing composition mode and failure reason: for example, “Report synthesis failed after repair attempts; verified findings are shown using source-based fallback.” Use the captured reason and stage without exposing raw payloads. Require an actual failed synthesis attempt; an intentional path that needs no model composition must not receive a failure notice.
- Show it before findings, including zero-findings and no-unresolved-questions cases. When a broader review-failure banner already exists, combine notices without hiding either cause or duplicating long warnings.
- Preserve accurate coverage: completed packet/verification work remains complete, while synthesis is explicitly degraded. Do not fabricate failed hunks or label intentional exclusions as errors. Keep this distinction consistent in Markdown, JSON, CLI rendering, and existing PR/report publication paths.
- Reuse existing composition metadata; add no independent health/status hierarchy and do not change exit-code policy in this plan. Never present a fallback report as an unqualified clean conclusion.

### Tests and acceptance

- Merge a synthetic test-file/handler pair proving the same missing rejection test, including a promoted uncertainty about that exact gap. Preserve all source IDs and suggestion qualifications.
- Keep separate two different endpoints with identical guard patterns, two different invariants in one function, and a misleading transitive evidence chain. Include unrelated domains/languages; no identifier or filename special cases. Exercise the shared grouping changes through both successful composition and fallback, including one defect with differing remedy assessments.
- Render timeout fallback, repair-exhaustion fallback, zero-findings fallback, combined partial-review/fallback, normal successful composition, and intentional no-composition paths. Assert the failure notice appears only when warranted and is prominent, reasons are bounded/redacted, coverage remains truthful, and JSON agrees with the rendered result.

Acceptance: one clearly equivalent behavioral issue yields one fallback finding without evidence loss. Distinct defects remain distinct. A reader can immediately distinguish completed review coverage from unsuccessful report synthesis.

Likely files: `src/pipeline/composer.ts`, existing composition-content/grouping helpers, `src/util/review-health.ts`, output renderers, and composition/report tests.

## Implementation and validation order

1. Implement phase 1 and review actual generated retry messages/schema examples.
2. Implement evidence retention, then phase 2 selection. Replay small synthetic equivalents of both evidence losses under the current cap.
3. Implement phase 3 grouping and reporting; inspect rendered reports, not just JSON snapshots.
4. Run focused tests and synthetics, then `pnpm test`, `pnpm run typecheck`, `pnpm run build`, and `git diff --check`. Review for evidence loss, accidental validation relaxation, cross-retry contamination, and false merges.
5. Let the user run matching DeepSeek/GLM reviews of the same repository revision with the current soft/hard budgets, routing, reasoning, composition step-down, and deadlines unchanged. Record build/config provenance. The two historical runs above used the old budgets and therefore cannot isolate this plan's causal effect; retain that distinction when comparing results.
6. Compare repair corrections and outcomes, evidence supplied per concern, answered versus genuinely unresolved questions, distinct findings, recommendation quality, composition mode, completeness, elapsed time, and cost (including unknown-cost calls). Repeat surprising results before attributing them to a model.

## Scope and review checklist

- Implementation and local validation only; no paid inference, historical-artifact rewrites, or public posting.
- Preserve the new 2× local hard ceilings. No additional budget multipliers, repair attempts, stage timeouts, or model/provider changes.
- No Plan 122 C2 adaptive investigation, blanket test-finding demotion, repository-specific heuristics, or general repair wire-format redesign in this iteration.
- Repair diagnostics must evolve; source observations must survive failed submissions without accepting their conclusions; relevant context must stay within bounds; grouping must retain distinct issues; fallback failure must be visible without falsifying coverage.


## Implementation and review results

- Repairs now append bounded, redacted diagnostics even with custom prompts and replacement conversations. Diagnostics describe the rejected keys/types and the next repair schema's permitted fields. Composition attribution supplies a small literal-key example. Atomic advice replacement and final validation remain unchanged.
- Successful tool observations are delivered on request settlement and retained per logical worker across retries, including failed ensemble/adaptive passes. Source provenance includes worker/attempt identity; failed submissions do not become findings. Existing refusal diagnostics remain separate from retained source.
- Reconciliation allocates complete source excerpts across questions, weights explicitly named files, and gives smaller useful excerpts an opportunity before large reads consume the inventory. Selection diagnostics record supplied references and size omissions; deduplicated omitted IDs remain ineligible unless their actual content is independently supplied through an existing published source reference.
- Grouping checks cross-file implementation references and diagnosis similarity, and requires compatibility across members to prevent transitive merges. Nearby anchors alone no longer merge distinct diagnoses. Synthesis failure is disclosed before findings in Markdown and posting output, with the same composition metadata available in JSON; coverage and exit policy are unchanged.
- Review caught and fixed two remaining handoff issues: ensemble pooling still filtered failed-pass reads, and an initially passing synthetic selector still missed the historical DeepSeek excerpt under the real inventory's pressure. Regression coverage now includes both cases.

Validation: `pnpm test` passed **1,523 tests across 67 files**, including workflow checks; `make evals` passed **36 synthetic tests**; typecheck, build, and `git diff --check` passed. Local replays made no model calls and did not change historical artifacts: GLM's three verified candidates form one fallback finding with all IDs retained; DeepSeek's supplied inventory now includes the omitted nested-validation excerpt at **15,893 / 16,000 characters**. These checks establish the mechanics, not live model repair success or recommendation quality. Matching new DeepSeek/GLM runs remain the next measurement.


### Follow-up implementation review

- Reused provider tool-call IDs could overwrite observations within a worker or collide in downstream references across retries. Retention now assigns IDs from worker, pass, attempt, and snapshot position, preserving the provider ID in provenance. Regression coverage includes repeated IDs, duplicate snapshot delivery, different revisions, and an unrelated refusal that must remain unresolved.
- Initial grouping treated a shared structural fingerprint as proof of duplicate diagnoses, bypassing the new grouping checks. Findings in the same hunk/lens now pass diagnosis compatibility checks before grouping. Separate final findings that collide structurally receive disambiguated publication fingerprints; ordinary fingerprints retain the existing identity policy. The same-hunk regression now uses the same lens and checks both finding count and distinct publication IDs.
- Re-ran the full suite, typecheck, build, and diff checks successfully. The local GLM replay still combines the three equivalent candidates into one finding. No model calls or historical-artifact edits were made during review.
