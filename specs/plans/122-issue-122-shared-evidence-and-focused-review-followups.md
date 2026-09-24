# Issue 122: Shared Evidence and Focused Review Follow-ups

Status: CORE IMPLEMENTED — A, B, C1, and D implemented; C2 deferred experiment; live validation pending
Based on: trails-api runs 107–109, with run 67 as a historical report-quality reference
Depends on: plans 118–121, strict submit recovery, and existing adaptive-pass scheduling

## Objective

Use already-collected evidence consistently, make recommendations and their explanations agree with established requirements, disclose unsuccessful supplemental investigations, and give semantic repairs precise missing-field targets. Keep the existing architecture and budgets. Evaluate a focused adaptive prompt separately from the correctness changes.

## Observations and limits

- All three runs passed the current eval, found its required production issue, and avoided composition fallback. Passing does not establish recommendation correctness or the usefulness of extra findings.
- Run 107 had the most focused current report. It accepted both rounding upward and rejection as remedies, but its published test required a returned quote and covered only the first remedy. A remedy-specific test can be valid if explicitly scoped; it must not be represented as the universal acceptance criterion.
- Run 108 took 29m56s. Two adaptive stage-7 passes exhausted their ten-minute deadlines after successful first passes. First-pass coverage survived; the report did not disclose unsuccessful supplemental investigations. These were multi-call investigations, not ten minutes of silence from one call.
- The adaptive second passes used the same initial prompts as their first passes. Concrete follow-up hints can trigger scheduling, but their questions and the prior observations are not passed to the new worker. Deliberately independent planned ensembles are a different mechanism and should remain independent.
- Run 108 verification named missing severity and confidence decisions for a promoted investigation, but the structured repair-target list was empty. The first repair introduced conflicting revision representations; the next repair succeeded. More repair attempts or relaxed validation are not indicated.
- Run 109 supplied the strongest main test, preserving both the original request and deliverability while accepting rejection. Its prose nevertheless reversed the behavior of an inspected caller guard and confused independent equality assertions with an invariant relating two values. The latter mistake already existed in verifier assessment evidence; composition is not the sole source of the error.
- Run 109 also retained a question about test-helper behavior even though relevant recommendation-assessment observations were already in the composition input. Reconciliation only allowed citations from a smaller inventory that omitted those observations. This is a reference-eligibility gap, not a need for another evidence-gathering call.
- Additional documentation findings in 108/109 were weak in material impact: a nearby stale line citation and an incident explanation not enumerating every related implementation change. Do not blacklist documentation findings; require evidence of a consequential error rather than completeness preferences alone.
- Run 67 connected the arithmetic defect to a destination execution precondition more clearly and produced a shorter report. It also contained an exactly divisible proposed truncation-test value. It is a useful reference, not an infallible oracle. Provider, budget, and code differences prevent causal comparisons.

## A. Share existing evidence with attention reconciliation — implemented

The composition call already receives source components, including recommendation assessments. Reuse those components through compact reconciliation entries containing their existing source IDs. A sourceField identifies assessment evidence within a fix/test component. Keep full text only for observations absent from the main composition input, including evidence from rejected candidates.

- Admit assessment observations with their status, rationale, contract qualifications, and inspected evidence. A proposal or supported label by itself is not evidence. Unverified/incompatible advice may still contain useful inspected observations; do not turn that advice into an endorsed recommendation.
- Use the effective assessment actually supplied to composition, including cross-finding conflict qualifications. Keep full observations in the debug artifact while avoiding repeated text in the prompt inventory.
- Keep the 16,000-character inventory limit, exact concern identities, independent supporting references, and local rejection of invalid resolutions. Allocate evidence across questions using independent origin, question relevance, and file context; ranking is not proof. Do not resolve by lexical similarity or omit unanswered sibling assumptions.
- Exclude incomplete-verification and explicitly truncated evidence. References must resolve to actual supplied components. Attention-only evidence must not satisfy finding source-accounting requirements.
- Keep fallback, legacy, no-finding, and no-resolution behavior conservative. No additional model call, schema relaxation, or finding verdict change.

Implementation: `attention-reconciliation.ts`, composition prompt `p10.12`, and attention/pipeline regression tests. Published observations are referenced rather than copied; unpublished verifier assessment evidence remains inline. The cap still applies to references as well as inline evidence; this does not promise admission of every source in arbitrarily large reviews.

Tests exercise assessment-only evidence, qualified/unverified observations, unpublished verdict evidence, large already-supplied excerpts, omitted/truncated/incomplete evidence, preserved sibling concerns, unchanged provenance, and the existing single composition call through rendered and structured output. Scripted resolution decisions establish transport and validation, not model reasoning quality.

Initial A validation: full suite passed (1,216 tests across 57 files), including the composition integration test; type/workflow checks, build, and diff checks passed. A subsequent targeted regression also checks cross-finding conflict qualifications and self-support rejection. No paid eval was launched. The later correctness-phase implementation is recorded below.

## B. Align remedies, tests, and explanations — implemented

Refine existing verifier and composer instructions rather than adding another checklist, schema, or judge call.

1. Carry the observed caller requirement through the remedy and regression test. For a triggering input, evaluate the actual predicate against the broken behavior, a symptom-hiding weaker remedy, and the legitimate remedies being recommended. Distinguish a test specific to one remedy from a general acceptance test; do not demand one concrete implementation when rejection or another remedy is explicitly allowed.
2. Explain predicates according to their actual branch condition. Checking each of two different values against its own expected value does not establish an additional relationship between them. When inspected observations disagree, retain the conflict or correct the claim using evidence; neither a supported label nor repeated prose settles the issue.
3. Separate an observed quote/API invariant violation from an inferred execution consequence. Follow existing caller evidence when available, but do not add mandatory investigations. Preserve execution uncertainty when evidence is absent; small numerical magnitude alone does not settle the impact of a hard precondition failure.
4. Require a concrete consequence for a documentation defect. A missing detail or differing old comment alone does not establish a false operational instruction. Retain valid documentation findings when the evidence demonstrates misleading behavior or an established requirement being violated.

Regression coverage should use at least two domains and generic predicates, not trails-api names or exact report text. Test supported replacement propagation, unverified/conflicting advice withholding, legitimate alternatives, and original evidence retention. Prompt tests can check that the intended task is delivered, but deterministic tests cannot prove that future model prose is logically correct. Measure that in live reports.

Keep the verifier/composer boundary explicit: verification may revise and assess advice using inspected evidence; composition may select, scope, or withhold supplied assessed advice, but may not invent a corrected test or remedy. Preserve exact-proposal assessment and source-accounting rules. Replace overlapping prompt instructions instead of appending another independent checklist; retain the existing concise-report guidance rather than adding more required report sections.

Likely files: `prompt-builder.ts`, existing recommendation-publication and report-synthesis fixtures/tests. Change harness publication logic only if a reproducible mechanical defect is found; do not implement semantic decisions with keyword rules.

## C. Disclose adaptive outcomes; separately evaluate focused prompts

### C1. Honest outcome reporting — implemented

Carry adaptive scheduling and terminal outcomes from the existing worker results into review artifacts, metrics, and the rendered coverage/status explanation. Report completed and unsuccessful supplemental passes distinctly, with failure reasons from existing errors/events where available.

- Successful first-pass coverage stays available when an adaptive pass fails. Do not automatically convert a complete baseline review to partial or claim the extra investigation succeeded.
- Mandatory first-pass failures continue to affect completeness as today. Do not hide an unresolved required review behind the supplemental category.
- Record scheduled, completed, and unsuccessful counts once per pass, not once per interrupted model call. Cancellation, timeout, retry, and capped/not-scheduled cases must remain distinguishable; reuse existing outcome information instead of inferring it from elapsed time.
- A worker returning normally with an incomplete review is not a successful supplemental investigation. Retain both the terminal worker outcome and the returned review status. Count each scheduled pass in exactly one terminal category: completed review, incomplete review, failed/timed out/cancelled, or not dispatched; keep trigger-cap omissions outside the scheduled count and record retry attempts separately. Preserve existing fatal-error propagation.
- Keep report, JSON artifacts, and eval metrics consistent. Older artifacts lacking supplemental status mean unrecorded, not demonstrated success. Missing usage on cancelled calls remains unknown cost.

Use additive optional fields in existing review/coverage structures and artifacts, plus existing telemetry conventions. Derive aggregate counts and a concise coverage/status note from the same per-pass outcomes; do not add a second completeness classifier or insert execution details into the diagnosis summary. No new reporting subsystem or stricter eval gate is necessary for this change. Add worker-to-report regression coverage for successful baseline plus failed/incomplete adaptive pass, successful adaptive completion after a retry, not-dispatched work, and actual baseline failure.

### C2. Focused adaptive prompt experiment — deferred

After C1 and the correctness changes have a frozen baseline, modify only adaptive follow-ups to receive a bounded representation of the triggering unresolved questions, their source pointers, and relevant first-pass observations. Treat prior findings as untrusted hypotheses, not conclusions the next worker must confirm. Ask the worker to inspect and resolve the predicate or return an explicit unresolved result when evidence is unavailable.

Leave planned ensemble prompts independent. Keep current adaptive eligibility, cap, tools, deadlines, concurrency, and retry counts. Preserve first-pass findings and existing pooling/provenance regardless of second-pass output. For triggers without a concrete question, preserve independent review behavior rather than fabricate a task.

Limit the initial experiment to the existing concrete-hint trigger, using the same predicate that made its hints/uncertainties eligible. Bound the added context by characters and retain complete question/pointer records; if none fit, use the existing independent prompt and record that choice. Do not inject a full previous conversation. Use existing findings, followUpHints, uncertainties, reviewStatus, and noFindingReason for the response. Stage 7 has no resolvedHints field: do not request one, add a resolution schema, or automatically delete first-pass concerns based on a claimed resolution. Whether the question was answered is initially a trace/report review measurement. Treat focusing as a change from the deliberately independent second draw, with possible confirmation bias and reduced discovery breadth, not an established bug fix.

Implement this as a separate, identifiable change with prompt-version telemetry, so the user can compare a frozen baseline and experiment. Do not introduce a public tuning flag solely for one experiment. Tests should confirm adaptive context is bounded and actually supplied, planned ensembles remain unchanged, and absent/new findings do not delete the first pass. Measure useful resolved questions, distinct verified findings, elapsed time, and failures; faster but less thorough does not establish success.

Likely files: `lens-runner.ts`, `prompt-builder.ts`, existing packet/review types, coverage aggregation, renderers, eval scoring, and their tests. Keep C1 independently shippable from C2.

## D. Give semantic repairs explicit missing-field targets — implemented

Reuse the existing sparse-patch repair and full-validation path. When promoted-investigation completion requires explicit final decisions, emit machine-readable missing-field diagnostics from that validation rule. Do not parse English error messages to recover field names.

- Identify only the fields actually missing, such as findingUpdates.severity and findingUpdates.confidence. Respect the active finalFinding/findingUpdates representation and their existing replacement rules.
- Combine typed semantic diagnostics with ordinary schema diagnostics, and recompute them from the latest trusted merged draft after each rejected repair. Completed targets must disappear; remaining/new invalid fields must remain visible. If no revision object exists, target creation of a valid revision object rather than emitting child paths whose parent cannot be traversed. Do not select finalFinding paths while the retained revision is findingUpdates, or vice versa.
- Preserve the trusted draft, retained context, and completed fields. A sparse patch should fill the missing decisions without reproducing the finding or introducing a second conflicting representation.
- Required final decisions remain required even when their schema fields are optional for ordinary findings. Do not locally invent severity, confidence, evidence, or other decisions; the model must supply supported values, otherwise recovery remains honestly unresolved.
- Feed the diagnostics into repair prompts, permitted targets, and remainingPaths telemetry through the existing hook. Do not create a verifier-specific retry loop or globally restrict other legitimate semantic repairs to these fields.
- Precise targets guide the repair; they do not replace the existing acceptance of nested partial updates or full objects with a new missing-fields-only contract. Keep valid overlapping updates and explicit representation replacement under existing merge/preservation rules. Unknown semantic failures continue through existing recovery rather than receiving guessed field targets.
- Validate the assembled object against the complete schema and stage semantics. Keep current repair attempts, lowest supported repair reasoning, and shared 180-second repair budget.

Tests should begin with a schema-valid but semantically incomplete promoted verdict, verify the exact missing paths, accept a valid sparse completion while retaining existing fields, and reject invalid enums, conflicting revision representations, and still-missing decisions. Cover an absent revision object, partial progress across repairs, valid full-object/representation replacement, and both revision representations. Ordinary findings and already-complete promotions must not gain unnecessary repair requirements.

Likely files: `verifier-revision.ts`, `verifier.ts`, existing structured validation/repair interfaces, `field-repair.ts`/`pi-runner.ts` as needed, and verifier/runner tests. Reuse any existing typed semantic-diagnostic mechanism before adding a narrowly scoped one.

## Sequence, validation, and measurement

1. A is implemented and locally validated; keep its regression coverage. Live quality validation remains pending.
2. Implement D, B, and C1 as reviewable changes with appropriate regression coverage. Run the full suite, type/workflow checks, build, and diff checks. Review final prompt payloads and rendered artifacts, not just counters.
3. Freeze the code/config for user-started DeepSeek, GLM, and Opus comparisons with composition step-down retained. Record routing, effective reasoning mechanism, prompt versions, code snapshot, stage timing, calls, known/missing cost, schema recovery/fidelity, and supplemental outcomes.
4. Separately implement/evaluate C2 against that baseline. Do not attribute combined changes or different model plans solely to prompt focus or reasoning step-down. Do not launch paid evals automatically.

The correctness implementation phase (D, B, and C1) is complete. The next step is user-started baseline measurement. C2 remains a separately identified experiment after that measurement; it was not enabled as part of the correctness phase.

Manually compare caller-contract accuracy, remedy/test agreement, materiality of extra findings, answered versus genuinely unresolved attention questions, primary prose length separately from expandable evidence, and where errors entered (investigation, verification, or composition). Eval pass/fail remains a coverage signal, not a complete quality judgment.

## Correctness-phase implementation record

- D uses one promoted-completion rule for validation and typed missing-field diagnostics. The existing verifier repair hook recalculates targets from the cleaned retained draft on each attempt, including an absent revision parent. Generic field repair combines semantic and schema targets and retains partial/full updates and explicit alternative-representation replacement. Full schema and stage validation still determine acceptance. No runner retry loop, reasoning policy, or repair deadline changed.
- B updates verifier prompt `p9.22` and composer prompt `p10.13` in the existing calls. The guidance distinguishes actual guard behavior from prose claims, independent assertions from cross-value invariants, remedy-specific tests from universal acceptance tests, interface violations from inferred execution impact, and material documentation errors from missing-detail preferences. Composition can select/scope/withhold assessed advice but cannot invent a replacement. Scripted tests exercise preserved corrections, supported revisions, and documentation verdicts without claiming deterministic semantic detection.
- C1 retains adaptive terminal outcomes, attempts, trigger, returned review status, and available error codes. One aggregation function produces per-pass coverage artifacts and counts for telemetry/eval metrics. A completed worker with an incomplete review is counted as incomplete; a failed attempt whose retry cannot dispatch is counted as failed to complete, with the original terminal outcome retained. Capped work is outside scheduled counts. Legacy outcomes remain unrecorded, not successful. Baseline coverage and fatal-error propagation are unchanged.
- Both the complete Markdown report and compact GitHub review body use the same supplemental coverage disclosure. The diagnosis summary receives no new execution-status instructions. Adaptive prompts, eligibility, budgets, deadlines, and planned ensembles remain unchanged; C2 is not implemented.
- Regression coverage includes runner-level sparse repair progress and target telemetry, full/partial representations, missing parents, strict final validation, adaptive failures/incomplete returns/retry recovery/cancellation/non-dispatch/cap omissions, preserved baseline failures, matching rendered disclosures, and eval metric export.

Validation: 1,238 tests across 58 files passed, along with workflow checks, type checking, build, and diff checks. Review caught and corrected compact GitHub output omitting the supplemental disclosure. No paid eval was launched; live semantic-quality measurement remains pending.

Follow-up review corrected two additional inconsistencies: repair descriptions now identify stage-required fields instead of calling them optional in the final submission, and explicit cooperative timeout errors are counted as timed out even when the scheduler's terminal outcome is failed. The original worker outcome/error code remains in provenance; timeouts are never inferred from elapsed time. Regression coverage checks both repair schema descriptions and the worker-to-report cooperative timeout path, including unchanged baseline coverage and no extra retry.

Follow-up validation: 1,239 tests across 58 files passed; workflow/type checks, build, and diff checks passed.

## Run 110 follow-up

- Reconciliation now stores verdict/proof/assumption qualifications once per candidate in `evidenceContexts`, rather than repeating them on every excerpt. Exact duplicate observations from the same origin are omitted from the prompt inventory; full observations remain in the audit data.
- Evidence allocation takes turns across questions, prioritizing independent observations with matching question terms and file context. Existing source IDs, the 16,000-character cap, complete-record admission, truncation exclusions, and independent-reference validation remain intact. Ranking never resolves a concern itself.
- Composer instructions explicitly distinguish a fully unanswered question from a partially answered question: narrow the latter while preserving all remaining conditions. Packet-review and verifier instructions require documentation findings to identify an evidenced mistaken decision/action and consequence after considering surrounding examples and corrective instructions. Hypothetical future misunderstandings alone do not qualify; material documentation defects remain eligible.
- Prompt versions: `p7.14`, `p9.23`, `p10.14`. No additional calls, schemas, retries, or public settings. C2 remains deferred.
- Local reconstruction of run 110's retained candidates/verdicts admitted 15 evidence entries rather than 10 within the existing cap, including previously omitted proof and recommendation assessments. This verifies transport, not improved live semantic judgments.
- Validation: 1,243 tests across 58 files passed; workflow/type checks, build, and diff checks passed. Regression coverage includes constrained per-question allocation, shared qualifications, duplicate provenance, partial narrowing instructions, and both material and wording-only documentation verdicts.

## Runs 111–114 follow-up: diagnostics and composition bookkeeping

- Rejected final arguments now produce a separate debug artifact keyed by model call and content index, with tool identity, parse classification, capture length/hash, optional syntax offset, and at most 16,384 characters of redacted prefix/suffix samples. Redaction happens before sampling; capture buffers are still cleared. Samples never become trusted arguments or enter the repair conversation.
- An unreadable verifier submission now requests a new complete verdict grounded in retained investigation evidence, without claiming the absent verdict can be preserved. Readable submissions keep the preservation instruction. Generic unreadable-argument diagnostics also explain regeneration from retained evidence. Recovery-fidelity accounting and strict validation remain unchanged.
- Composition locally appends wholly omitted, known sources to `retainedSourceRefs` only under explicit, unique finding ownership. It does not infer section attribution, rewrite prose, hide misplaced references, or satisfy visible proof/primary evidence requirements through provenance alone. Added paths are recorded, and full schema/semantic validation remains mandatory.
- Composer instructions distinguish actual contrary evidence from absent verification. An unverified alternative does not veto an independently supported remedy; genuine contradictions still require evidence and prevent disputed advice from being published. No semantic keyword rules, schema relaxation, additional calls, or changed retry budgets were added. Prompt versions are `p9.24` and `p10.15`.
- Local replay reconstructed the verified inputs to saved composition calls 98 in run 111 and 85 in run 112. Adding 13 and 1 omitted source references respectively makes both original drafts pass full schema and semantic validation, retaining all 72 and 81 components without changing prose. This establishes the bookkeeping correction, not future model judgment quality.
- Validation: 1,255 tests across 58 files passed, including diagnostic redaction/stream forwarding, strict unreadable-argument handling, source-retention boundaries and no-repair integration, supported-versus-unverified proposals, and actual conflicting assessments. Workflow checks, typecheck, build and diff checks passed. C2 remains deferred; no paid eval was launched.

## Out of scope

Additional judge/model calls, more repair attempts, weaker schemas, global budget or timeout increases, model-specific report rules, automatic resolution from shared keywords, new recommendation-assessment fields, changes to composition reasoning policy, and rewriting plans 118–121. This plan records a focused follow-up; it does not claim that every semantic report error can be prevented deterministically.
