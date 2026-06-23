# Issue 65: End-to-End Obligation Proof For Review Questions

Status: COMPLETE
Planned from: trails-api eval `49f4645b/logs/11` compared with `49f4645b/logs/1` and `49f4645b/logs/10`, 2026-06-18
Recommended priority: high, because Stage 5 identified the right concern but Stage 7 and Stage 8 closed it with a too-local proof

## Problem

Eval `49f4645b/logs/1` found a credible finding:

```text
EXACT_OUTPUT transfer amount truncates down, under-delivering vs the quoted ToAmountMin
```

The successful proof was not just local helper correctness. It traced an obligation across multiple steps:

```text
requested value -> transformed value -> downstream deliverable/output -> advertised minimum/consumer
```

Eval `49f4645b/logs/11` reviewed the same range and produced no candidates. This was not caused by missing context, schema failure, verifier rejection, or tool failure:

- Stage 5 identified the relevant amount-scaling and quote-output risks.
- Stage 6 attached review questions to the relevant packets.
- Stage 7 saw `EXACT_OUTPUT`, `scaleAmount`, `DestinationAmount`, and `ToAmountMin`.
- Stage 7 produced no candidate findings and no material concerns.
- Stage 8 resolved the questions as no issue.
- Stage 9 never ran because there were no candidates.

The failure was semantic: Stage 7 and Stage 8 proved narrower local properties than the planner concern required.

Examples from run 11:

- The scale question was answered by proving conversion arguments were oriented correctly.
- The quote-fields question was answered by proving `ToAmount`, `ToAmountMin`, and USD all use the same destination value.
- Neither answer proved the actual end-to-end obligation: whether the transformed transfer amount can deliver at least the advertised downstream minimum after any lossy transform.

So the current system can preserve a planner concern as a review question, but still close it with a local consistency answer. That is too lossy for transformed-value bugs, state-machine bugs, lifecycle bugs, auth boundary bugs, cache invalidation bugs, and similar cross-step correctness issues.

## Goal

Make material review questions require an end-to-end proof when the question asks about a relationship across changed input/state, transformation/check, and downstream output/consumer.

Desired behavior:

- Stage 5 review questions should be allowed to carry a free-form `obligation` describing what must be proven.
- Stage 7 should answer the obligation, not just a local slice of it.
- Stage 7 should emit a candidate finding or material concern when it finds a concrete broken obligation.
- Stage 7 should mark an answer `partial` when it can only prove local consistency.
- Stage 8 should use the same obligation text when resolving follow-up tasks.
- Stage 8 should not mark a material question resolved unless its resolution proves the obligation end to end.
- Stage 9 remains strict and verifies only concrete candidate findings.

This must stay generic. The fix should not encode domain words, a risk taxonomy, target repositories, target languages, or eval-specific symbols.

## Non-Goals

- Do not hard-code Hyperlane, trails-api, Go, decimals, quotes, `ToAmountMin`, `EXACT_OUTPUT`, or token terminology.
- Do not add a closed enum such as `riskKind`, `obligationKind`, or `questionKind`.
- Do not force every review question through Stage 8.
- Do not require every local helper question to have an end-to-end proof.
- Do not loosen verifier confidence or evidence standards.
- Do not publish unresolved questions as findings.
- Do not add a broad whole-PR review pass.
- Do not rely on brittle keyword matching to decide correctness.

## Design

### 0. Fit With Current Review-Question Code

This plan should refine the existing review-question flow, not create a parallel system.

Current code already has:

- `ReviewQuestion.evidenceHint`, which tells the reviewer where or how to look.
- Stage 7 prompt guidance for generic traces such as requested -> transformed -> reported/validated.
- `noIssueAnswerCoversQuestionScope` in `lens-runner`, which downgrades too-local no-issue answers for broad questions.
- Stage 8 question follow-up grouping and `answerCoversQuestionScope`.

The new `obligation` field has a different role from `evidenceHint`:

- `evidenceHint` is retrieval/process guidance: what context or evidence may help answer.
- `obligation` is the assertion that must be proven or falsified before the question can be closed.

Implementation should extend those existing helpers and prompts. Do not add another independent question-follow-up subsystem.

### 1. Add A Free-Form Obligation To Review Questions

Extend review-question data with an optional free-form obligation field:

```ts
type ReviewQuestion = {
  id: string;
  question: string;
  whyItMatters: string;
  files: string[];
  symbols: string[];
  obligation?: string;
}
```

This is intentionally text, not taxonomy.

The planner should use `obligation` only when a concern requires proving a relationship across more than one step. Good obligations are short and concrete:

```text
Trace changed input/state -> transform/check -> downstream output/consumer and verify the downstream value still satisfies the contract.
```

For ordinary local questions, omit `obligation`.

### 2. Seed Obligations From Existing Planner Risk Areas

Update the Stage 5 prompt and fallback question synthesis so material risk areas become questions with obligations when the risk area already describes a cross-step concern.

Keep this simple:

- Use the planner's own `area`, `reason`, `files`, and `symbols`.
- Ask the planner to write `obligation` in plain English when a question spans changed input/state, transformation/check, and downstream output/consumer.
- If the planner omits `obligation`, do not invent domain-specific semantics.
- For synthesized questions from risk areas, use a generic obligation template only when the risk area's own files/symbols/reason show that more than one changed value, state, operation, or downstream use must be compared.

The goal is not perfect classification. The goal is to preserve the planner's concrete concern in a form Stage 7 and Stage 8 can answer.

### 3. Show The Obligation In Stage 7 Packets

Update packet prompt rendering so each attached review question includes:

- the question,
- why it matters,
- files/symbols,
- ownership role/status,
- `obligation` when present.

Stage 7 instructions should say:

- If a question has an `obligation`, answer that obligation directly.
- A valid no-issue answer must trace the required relationship end to end.
- A local consistency proof is not enough for a cross-step obligation.
- If the obligation appears broken, emit a candidate finding.
- If the obligation cannot be fully proven within the packet/tool budget, mark it `partial` and preserve the exact unresolved predicate.
- Do not hide a concrete broken obligation inside `noFindingReason`.

This is prompt discipline plus structured handoff, not a new review taxonomy.

### 4. Add Obligation-Aware Answer Validation

Extend the existing Stage 7 answer normalization and `noIssueAnswerCoversQuestionScope` with a small deterministic guard.

For `answered_no_issue` answers:

- If the question has no `obligation`, keep existing validation.
- If the question has an `obligation`, require the answer to include an `evidenceTrace`.
- Require the evidence trace or evidence paths to reference the obligation's scope beyond the current hunk when the question spans multiple files/symbols/packets.
- If the answer only proves a local property, downgrade to `partial`, reduce `high` confidence to `medium`, and emit telemetry:

```text
review_question_answer_downgraded
reason: "answered_no_issue_without_obligation_proof"
```

This guard should be conservative. It should not decide the answer is wrong. It should only say: "this answer did not prove the obligation strongly enough to close the question."

Suggested generic checks:

- For multi-file questions, no-issue answers should cite evidence from at least two relevant files, or explicitly explain why one file fully owns the obligation.
- For multi-symbol questions, no-issue answers should mention more than one relevant symbol in answer/trace/evidence, or explain why one symbol fully owns the obligation.
- For questions with ambiguous ownership, no-issue answers should be partial unless the trace covers the attached packet set's cross-packet relationship.

Avoid domain-word heuristics.

### 5. Make Stage 8 Resolve Obligations, Not Just Questions

When Stage 8 builds a task from a review question, include the `obligation` prominently.

Stage 8 completion rules:

- If there is an obligation, the resolution must explicitly answer it.
- A response that proves only local consistency should return no findings but leave the question unresolved/partial, rather than closing it.
- If the obligation reveals a concrete changed-code failure mode, Stage 8 may emit a candidate finding for Stage 9.
- If Stage 8 cannot prove or disprove the obligation within bounds, preserve a human-attention note with the exact unresolved predicate.

Keep Stage 8 narrow:

- one task per question ID,
- bounded files/symbols/packet IDs,
- existing caps unchanged,
- no broad exploration.

### 6. Preserve Material Concern Promotion

Keep the existing material-concern promotion path from the recent implementation.

This plan should make it easier for Stage 7 to create material concerns when an obligation is suspicious but not fully candidate-ready. Promotion should still require:

- a concrete failure mode,
- changed-line anchor or relevant changed-code link,
- specific evidence,
- no linked direct candidate already covering the same issue.

Do not promote generic "verify this behavior" notes.

### 7. Telemetry And Artifacts

Add small telemetry so evals can show whether obligations are working:

- `reviewQuestionMetrics.obligations`
- `reviewQuestionMetrics.obligationsAnswered`
- `reviewQuestionMetrics.obligationsPartial`
- `reviewQuestionMetrics.obligationsWithCandidates`
- `reviewQuestionMetrics.obligationsDowngraded`

Emit events:

```text
review_question_obligation_attached
review_question_answer_downgraded reason=answered_no_issue_without_obligation_proof
system_review_obligation_resolved
system_review_obligation_unresolved
```

Artifacts should make it easy to inspect:

- which questions had obligations,
- which packet owned/answered them,
- whether Stage 8 resolved them,
- whether they produced candidates/material concerns.

## Implementation Steps

1. Add optional `obligation` to shared review-question types and schemas.
2. Update Stage 5 planner schema/prompt and risk-area fallback synthesis to support free-form obligations.
3. Update Stage 6 packet question attachment to preserve `obligation`.
4. Update Stage 7 prompt rendering and answer instructions.
5. Add obligation-aware no-issue answer validation in `lens-runner`, reusing `noIssueAnswerCoversQuestionScope`.
6. Update Stage 8 task construction, prompt, and `answerCoversQuestionScope` behavior to include and require proof of `obligation`.
7. Add metrics/events/artifact fields for obligation coverage.
8. Add focused tests for:
   - planner questions with obligations survive into packets,
   - local no-issue answer on multi-file/multi-symbol obligation downgrades to partial,
   - full-scope no-issue answer remains accepted,
   - Stage 8 task includes obligation text,
   - material concern/candidate paths remain untouched for concrete findings.
9. Run focused tests, typecheck, full tests, and build.

## Validation

Commands:

| Purpose | Command |
| --- | --- |
| Focused Stage 5/6 tests | `pnpm exec vitest run tests/pipeline-phase5.test.ts` |
| Focused Stage 7/8 tests | `pnpm exec vitest run tests/pipeline-phase8.test.ts tests/uncertainty-promotion.test.ts` |
| Typecheck | `pnpm run typecheck` |
| Full tests | `pnpm test` |
| Build | `pnpm run build` |

Eval validation:

- Re-run `49f4645b` several times, not once.
- Inspect whether the amount-scaling / quote-output concern becomes an obligation.
- Confirm Stage 7 either emits a candidate/material concern or leaves the obligation partial.
- Confirm Stage 8 does not close the obligation with a local consistency proof.
- Confirm Stage 9 still filters weak candidates.
- Confirm larger `0c4d5213` eval does not regress recall or produce new false positives.

## Stop Conditions

Stop and revise if:

- Stage 7 starts downgrading most ordinary local no-issue answers to partial.
- Stage 8 task count grows substantially on normal PRs.
- Final reports contain many unresolved obligation notes without candidates.
- The verifier starts seeing vague obligation-derived candidates.
- The implementation needs domain-specific keywords or a closed taxonomy to work.

## Expected Outcome

The pipeline should stop treating "local consistency appears fine" as enough to close a material cross-step planner concern.

For the motivating failure, a correct outcome would be one of:

- Stage 7 emits the exact-output under-delivery candidate directly,
- Stage 7 emits a material concern preserving the round-trip deliverability predicate,
- or Stage 8 keeps the question unresolved instead of incorrectly closing it as no issue.

The strict verifier remains the final gate. This plan improves recall by preserving the right obligation until it is actually proven or verified, not by lowering publication standards.
