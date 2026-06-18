# Issue 60: Preserve Planner Concerns As Review Obligations

Status: PENDING
Planned from: trails-api eval runs `49f4645b/logs/8` and `0c4d5213/logs/24`, 2026-06-17
Recommended priority: high, because Stage 5 concerns must survive into review without reducing Stage 7 direct-candidate recall

## Problem

Eval run `49f4645b/logs/8` completed successfully from an infrastructure perspective, but returned no findings for a diff that previous runs sometimes caught.

The failure was not a verifier problem and not a provider/schema failure:

- Stage 5 identified concrete risk areas about changed value relationships, downstream quote outputs, validation, and tests.
- Stage 5 emitted zero `reviewQuestions`.
- Stage 6 attached zero questions to packets.
- Stage 7 invented two `answeredQuestions` IDs that were not attached to the packet, so the normalizer correctly dropped them as `unknown_question_id`.
- Stage 8 skipped because it only saw no repeated follow-up hints.
- Stage 9 rejected the weak promoted uncertainties correctly.

The core issue is that "planner found a concrete concern" does not yet reliably become "reviewers must answer this concern or explain why it is not an issue."

Plan 56 added review questions and answer tracking, but it still relies on the planner voluntarily emitting questions. Run 8 shows that this is too brittle: a high-quality risk area can still disappear before Stage 7 and Stage 8 have a chance to use it.

A later larger eval, `0c4d5213/logs/24`, showed the opposite side of the same problem. Review questions were emitted and attached successfully, but Stage 7 direct-candidate generation weakened:

- run 23 had 14 direct Stage 7 candidates and passed the eval,
- run 24 had 9 direct Stage 7 candidates, 35 answered review questions, and 14 partial question answers before aborting,
- some packets that produced direct candidates in run 23 became `no_findings` plus follow-up hints in run 24,
- Stage 8 built 3 useful cross-packet tasks but crashed before running because telemetry rejected `system-review-tasks.json`.

This means review questions are mechanically useful, but they must not become a softer alternative to candidate findings. If answering a review obligation reveals a concrete changed-code failure mode, Stage 7 should emit a candidate and let Stage 9 verify it. Stage 8 is a backstop for unresolved cross-packet evidence, not a replacement for Stage 7 recall.

## Goal

Make concrete planner concerns durable across the review pipeline.

The desired behavior is:

- If Stage 5 emits material risk areas, the pipeline should preserve the most important ones as answerable review obligations.
- Stage 6 should attach those obligations to relevant packets.
- Stage 7 should answer only attached obligations, with evidence, or produce a candidate finding / partial answer.
- Stage 7 should not convert concrete defects into follow-up-only output merely because the defect was discovered while answering a question.
- Stage 8 should be able to run a narrow follow-up for unresolved material obligations even when no repeated follow-up hint exists.
- Stage 9 should remain strict and decide only from evidence.

This must stay generic. The implementation should not encode a risk taxonomy, target repo, target language, or eval-specific symbols.

## Non-Goals

- Do not add a closed `riskKind`, `riskThreadKind`, or domain enum.
- Do not hard-code Hyperlane, quotes, decimals, amount scaling, collateral, `ToAmountMin`, or any trails-api names.
- Do not force every risk area to become a question.
- Do not attach every question to every packet.
- Do not publish unresolved questions by default.
- Do not loosen verifier thresholds.
- Do not make Stage 8 a broad whole-PR review.
- Do not make Stage 8 compensate for avoidable Stage 7 recall loss.
- Do not treat a synthesized question as evidence of a bug.
- Do not roll back Plan 56, 57, 58, or 59.

## Design

Use the planner's own free-form risk areas as the source of review obligations when the model fails to emit explicit `reviewQuestions`.

This is intentionally not a taxonomy. A synthesized question should be a natural-language reformulation of a risk area's `area`, `reason`, and `files`, plus nearby coverage/hint context when available.

Example generic transformation:

```text
Risk area:
  area: Downstream output consistency
  reason: The changed helper now transforms a value before passing it to a public response and validation path.
  files: ["src/example.ts"]

Question:
  Does the changed value relationship described by "Downstream output consistency" still hold across the modified files, and can the packet trace the relevant inputs, transformations, and downstream outputs/validation?
```

The exact text should be derived from planner artifacts, not from hard-coded domain words.

## Stage 5: Planner Obligation Fallback

After normal planner schema validation and `validatePlan` normalization:

1. Keep any planner-authored `reviewQuestions` that survive normalization.
2. If the plan has zero review questions, synthesize a small number from material risk areas.
3. If the plan has some review questions, optionally synthesize only for high-value risk areas that are clearly unrepresented.

Start conservatively:

- synthesize only when there are risk areas and at least two changed hunks or multiple material coverage decisions;
- synthesize at most 2 questions by default, with a hard cap of 3;
- prefer risk areas whose files intersect deep/normal coverage decisions;
- prefer risk areas whose reason names a relationship, downstream effect, contract, validation, tests, security, reliability, or architecture concern in natural language;
- do not synthesize from vague risk areas such as "general review" or "check this file";
- do not synthesize for docs-only or all-skip plans unless the docs are already being treated as executable intent context.

The fallback should produce ordinary `ReviewQuestion` objects:

```ts
type ReviewQuestion = {
  id: string
  question: string
  whyItMatters: string
  files: string[]
  symbols: string[]
  evidenceHint?: string
}
```

Recommended wording pattern:

```text
Does the changed code preserve the relationship or contract described by "{riskArea.area}" across the relevant files? Trace the changed input/state, transformation/check, and downstream output/consumer before answering.
```

Use the risk area's own `reason` as `whyItMatters`, trimmed and normalized. Use the risk area's `files`, filtered to changed files. Infer symbols only from overlapping coverage decisions and surrounding context hints; leave `symbols` empty if there is no reliable symbol.

Emit telemetry:

- `planner_review_questions_synthesized`
- `planner_review_question_synthesis_skipped`

Useful fields:

- risk area count,
- existing question count,
- synthesized count,
- source risk area names,
- skipped reasons,
- max question cap.

## Stage 6: Packet Attachment

Use the existing `attachReviewQuestions` path, but make sure synthesized questions attach when they only have file overlap and no symbol.

Keep this bounded:

- attach at most the existing per-packet cap;
- prefer exact file and symbol overlap;
- do not attach PR-level questions to unrelated packets;
- preserve `relevanceReason` so debug artifacts explain why the packet had to answer the question.

If a synthesized question cannot attach to any packet, emit telemetry and keep it in `review-questions.json` as unattached. Do not force attachment.

## Stage 7: Answer Discipline

Strengthen packet-review behavior without changing the verifier threshold:

- If a packet includes `reviewQuestions`, answer those exact question IDs only.
- If a packet includes no `reviewQuestions`, omit `answeredQuestions`.
- Never invent question IDs.
- A no-issue answer must include evidence and an evidence trace.
- A partial answer must preserve the concrete hypothesis, not a generic "verify behavior" placeholder.
- If a concrete defect is found while answering a question, emit a candidate finding and link `reviewQuestionIds`.

The existing normalizer already drops unknown question IDs. Keep that behavior and add/keep telemetry so evals can see when the model ignored the contract.

Do not make the prompt more conservative. Stage 7 should still generate liberally when it sees a concrete failure mode; Stage 9 remains the strict filter.

Add an explicit candidate-vs-follow-up rule:

- If the packet has changed-code evidence, an anchorable changed line, and a concrete failure mode, emit a candidate finding even when confidence is medium or the issue came from a review question.
- Use a follow-up only when one of the decisive predicates is outside the packet and cannot be inspected within the packet's bounded tool budget.
- If the answer says "behavior changed from X to Y" or "the old code accepted/skipped/fell back but the new code errors/rejects/miscomputes", that is candidate-shaped by default.
- If the answer only says "could this happen?" without a reachable path or changed-line evidence, keep it as partial/follow-up.
- If the packet lacks enough context but the claim is concrete, preserve the exact predicate in `followUpHints.reason`; do not downgrade to a generic "verify behavior" question.

Run 24 exposed why this matters. A packet that had previously produced a direct `AmountFromUSD` zero-decimal finding instead emitted `no_findings` plus a medium follow-up with the same concrete behavior delta. That should become a candidate finding and let Stage 9 decide. Review questions should increase recall by forcing evidence traces, not lower recall by giving the model a polite escape hatch.

Add deterministic cleanup for long no-finding submissions:

- `noFindingReason` over the schema limit should be truncated deterministically before accepting or retrying the payload.
- The schema-repair path should not fail a packet only because the no-finding explanation exceeded 1000 characters.
- Emit telemetry such as `stage7_no_finding_reason_truncated`.

Run 24 had one packet fail after repair because `noFindingReason` was too long. This was not a substantive review failure; it was avoidable schema friction.

## Stage 8: Narrow Question Follow-Up

Extend Stage 8 task construction so review-question lifecycle can trigger a focused task even without repeated follow-up hints.

Create a question-driven system review task only when:

- a review question is attached to one or more packets;
- Stage 7 produced a partial answer, conflicting answers, or no substantive answer for a material question;
- no direct candidate finding already covers the question;
- the question has concrete files or symbols;
- the task can be bounded to a small set of packets/files.

Keep the cap small:

- at most 1 question-driven task initially;
- at most 2 after evidence shows this is useful;
- reuse normal/deep tool budgets, do not introduce a new broad pass.

The task should include:

- original review question,
- why it matters,
- attached packet IDs,
- packet summaries and answers,
- relevant files/symbols,
- representative snippets already available,
- repository tools for focused confirmation.

Stage 8 output remains unchanged:

- candidate findings,
- resolved hints / answered-no-issue records,
- no broad summary comments unless final composition decides they matter.

Keep Stage 8 narrow and observable.

The current Stage 8 concept is valid: group repeated medium/high follow-up hints or unresolved review-question answers, then run at most a few focused system-review workers. In run 24 it built sensible tasks around cross-packet USD validation, generic lock helper correctness, and deleted/renamed test coverage. That is not bloat.

However, Stage 8 must not be required for every material issue. The desired flow is:

- Stage 7 emits direct candidates when local evidence is enough.
- Stage 8 only resolves cross-packet questions that Stage 7 could not prove locally.
- Stage 9 verifies all candidates strictly.

Also fix the telemetry artifact bug before relying on Stage 8:

- allow `system-review-tasks.json`,
- allow `system-review-results.json`,
- add a regression test that Stage 8 can write both artifacts when tasks exist.

## Stage 9: Verification

Keep verification strict.

For question-derived findings, include the original question and any packet answers in the verification prompt/context. The verifier should still require:

- changed-line anchor where publishing inline,
- concrete failure mode,
- evidence from changed code plus related code where necessary,
- low false-positive risk,
- clear impact.

Do not keep a finding merely because a planner question existed.

## Stage 10: Artifacts and Reporting

`review-questions.json` should make the lifecycle visible:

- planner-authored questions,
- synthesized questions,
- skipped synthesis reasons,
- packet attachments,
- Stage 7 answers,
- Stage 8 tasks and results,
- final dispositions.

The final markdown should not gain a noisy question section by default. Findings remain findings-first. If no findings are published, the report can remain concise.

## Implementation Steps

1. Add a small planner helper that synthesizes review questions from normalized risk areas and coverage.
   - Keep it local to `src/pipeline/planner.ts` unless it becomes too large.
   - Run it after `normalizeReviewQuestions`.
   - Reuse `normalizeReviewQuestions` or equivalent validation on synthesized questions.

2. Add telemetry for question synthesis.
   - Emit both positive and skipped events.
   - Avoid logging large full-plan payloads.

3. Ensure packet attachment works well for file-only synthesized questions.
   - Prefer existing attachment logic.
   - Adjust only if file-only questions fail to attach to obvious packets.

4. Harden Stage 7 prompt wording.
   - Explain that `answeredQuestions` must reference attached IDs only.
   - Explain that packets with no attached questions should omit the field.
   - Explain that review-question answers with concrete changed-code failure modes should become candidate findings, not follow-up-only output.
   - Keep the existing unknown-ID drop behavior.

5. Add deterministic Stage 7 submission cleanup.
   - Truncate overlong `noFindingReason` before schema repair when the rest of the payload is valid.
   - Preserve high-signal text by keeping the front of the reason and adding a clear truncation suffix.
   - Emit telemetry for truncation.

6. Add question-driven Stage 8 task construction.
   - Reuse `SystemReviewTask`.
   - Merge with repeated-hint tasks by ranking and cap.
   - Do not create broad PR-level tasks.
   - Prefer Stage 8 tasks for partial/conflicting answers, not for candidate-shaped findings that Stage 7 should emit directly.

7. Fix Stage 8 artifact allow-listing.
   - Add `system-review-tasks.json` and `system-review-results.json` to known run artifacts.
   - Keep artifact writes strict; do not disable artifact path validation.

8. Extend artifacts.
   - Include synthesized/skipped counts in `review-questions.json`.
   - Include question-driven Stage 8 task counts.
   - Include Stage 7 candidate-vs-follow-up metrics for review-question obligations:
     - attached question answered as candidate,
     - answered no issue,
     - partial,
     - follow-up-only despite candidate-shaped predicate.

9. Add tests.
   - Planner synthesizes questions when risk areas are material and planner emitted none.
   - Planner does not synthesize for no-risk / trivial plans.
   - Synthesis does not use fixed taxonomy fields.
   - File-only synthesized questions attach to relevant packets.
   - Stage 7 drops unknown IDs and records telemetry.
   - Stage 7 accepts attached question answers with evidence trace.
   - Stage 7 truncates overlong no-finding reasons deterministically.
   - Stage 7 preserves concrete behavior-delta predicates as candidate findings or high-signal partials; it does not collapse them into generic follow-ups.
   - Stage 8 builds one focused task from a partial attached question.
   - Stage 8 does not build a task for vague/unattached questions or questions already covered by findings.
   - Stage 8 writes `system-review-tasks.json` and `system-review-results.json` without tripping artifact validation.

## Likely Files

- `src/pipeline/planner.ts`
- `src/pipeline/packet-builder.ts`
- `src/pipeline/lens-runner.ts`
- `src/pipeline/system-reviewer.ts`
- `src/pipeline/review-runner.ts`
- `src/skills/prompt-builder.ts`
- `src/telemetry/run-artifacts.ts`
- `src/types.ts` only if lifecycle/source metadata needs a small type addition
- `tests/pipeline-phase5.test.ts`
- `tests/pipeline-phase6.test.ts`
- `tests/pipeline-phase8.test.ts`
- telemetry/run-artifact tests, if they already exist

## Acceptance Criteria

- A plan with material risk areas and no planner-authored questions produces 1-3 synthesized `ReviewQuestion`s.
- Synthesized questions are natural-language obligations derived from risk-area text, not fixed categories.
- Synthesized questions attach to relevant packets when file/symbol overlap exists.
- Stage 7 no longer emits useful-looking answers to invented question IDs in normal operation.
- Stage 7 does not reduce direct-candidate recall by turning candidate-shaped behavior deltas into follow-up-only output.
- Stage 7 deterministically recovers overlong no-finding reasons without failing the packet.
- Partial answers to attached questions can trigger one bounded Stage 8 follow-up.
- Stage 8 can write its task/result artifacts when tasks exist.
- Stage 9 remains strict; verifier keep/reject behavior is not relaxed.
- `review-questions.json` clearly explains emitted, synthesized, attached, answered, partial, Stage 8, and final counts.
- Full build and tests pass.

## Validation

Run focused tests:

```text
pnpm exec vitest run tests/pipeline-phase5.test.ts tests/pipeline-phase6.test.ts tests/pipeline-phase8.test.ts
```

Then run:

```text
pnpm run build
pnpm test
git diff --check
```

Then rerun the small eval:

```text
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/49f4645b --no-cache
```

Expected next-run signals:

- Stage 5 emits or synthesizes at least one review question when risk areas are present.
- Stage 6 attaches at least one question to the relevant packets.
- Stage 7 answers attached question IDs only.
- Stage 7 direct-candidate count does not collapse relative to comparable runs merely because review questions were attached.
- Stage 8 either runs one focused question follow-up or records a clear skip reason.
- Stage 8 no longer aborts on `system-review-tasks.json`.
- Misses, if any, are no longer caused by planner concerns disappearing before packet review.

Also rerun the larger eval that exposed the Stage 8 artifact issue:

```text
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/0c4d5213 --no-cache
```

Expected signals for that run:

- Stage 8 starts and completes when tasks are built.
- `system-review-tasks.json` and `system-review-results.json` are present.
- Stage 7 packet failures from overlong `noFindingReason` are gone.
- Candidate-shaped findings such as local behavior deltas are not consistently demoted into follow-up-only records.

## Stop Conditions

Stop and reassess if:

- synthesized questions attach to most packets in a PR,
- Stage 8 starts running for most reviews,
- question synthesis produces vague "review this carefully" prompts,
- false positives increase because questions are treated as evidence,
- direct Stage 7 candidate generation drops materially while follow-up-only output rises,
- Stage 7 starts depending on Stage 8 to recover ordinary packet-local defects,
- verifier strictness is weakened to compensate for weak question-derived candidates,
- telemetry shows most synthesized questions are never attached or always answered as not applicable,
- the implementation starts depending on target repo names, target language names, or a fixed risk taxonomy.
