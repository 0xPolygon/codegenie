# Issue 56: Open Review Questions and Answer Tracking

Status: PENDING
Planned from: trails-api eval runs `49f4645b/logs/2` and `49f4645b/logs/3`, 2026-06-17
Recommended priority: high, because repeated runs missed a cross-packet correctness concern before candidate generation

## Problem

Recent runs for the `49f4645b` trails-api eval repeatedly missed a real cross-packet issue:

- Stage 7 noticed truncation/rounding concerns,
- Stage 7 did not reliably connect those concerns to the downstream public quote/minimum-output behavior,
- Stage 8 built no follow-up tasks,
- Stage 9 only saw weak low-confidence candidates framed as collateral or generic truncation concerns,
- verification correctly rejected those weak candidates,
- the final review had no findings.

This was not caused by missing lenses. Runs 2 and 3 used explicit `core/code-review`, `core/tests`, and `lang/go` lenses and still missed.

The deeper issue is that the planner can identify concrete concerns, but the pipeline does not preserve them as review obligations that must be answered. A concern can be partially noticed by several packet reviewers, then disappear because no single packet produces a strong direct finding.

## Goal

Carry concrete planner questions through the review pipeline until they are answered, converted into a candidate finding, or explicitly left unresolved for a focused follow-up.

The desired behavior is:

- Stage 5 emits free-form review questions, not typed risk categories.
- Stage 6 attaches relevant questions to review packets.
- Stage 7 answers attached questions or explains why they do not apply.
- Stage 8 runs a small follow-up when related packets partially answer a question but no finding survives.
- Stage 9 remains strict and verifies only concrete candidate findings.

This should improve recall for cross-file and cross-symbol concerns without adding repo-specific rules or weakening the verifier.

## Non-Goals

- Do not introduce a fixed `riskKind` / `riskThreadKind` enum.
- Do not hard-code Hyperlane, routes, quotes, decimals, `ToAmountMin`, or any target-repo names.
- Do not make every planner question a finding.
- Do not publish vague unresolved questions by default.
- Do not loosen verification standards.
- Do not add broad whole-PR rereviews.
- Do not make Stage 8 run for every PR.
- Do not route planner questions through `FindingCategory`, `PromotionClass`, or keyword risk buckets before deciding whether the question still needs an answer.

## Design

Add planner-authored open review questions as plain, free-form review obligations.

Example shape:

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

The important property is that `question` and `whyItMatters` are natural language. They should not be forced into a closed taxonomy.

Treat categories as output/reporting metadata only. A planner question should not become more or less important because it fails to match a built-in risk bucket such as correctness, testing, security, or maintainability. The implementation may use operational lifecycle labels such as answered, partial, unresolved, or candidate generated, but those labels must describe disposition rather than risk type.

Implement this in two slices:

1. Planner questions, packet attachment, and Stage 7 answer tracking.
2. Focused Stage 8 follow-up only after artifacts show questions are being preserved but still need cross-packet resolution.

The first slice should be independently useful: a packet reviewer should have to answer the planner's concrete question even when no Stage 8 task runs.

For the `49f4645b` eval, a good question would have been generic:

```text
Does the new amount transformation preserve the relationship between the amount requested, the amount transferred, and the amount reported to callers?
```

That is not Hyperlane-specific. The same structure applies to many code review cases:

- transformed values and public outputs,
- validation and downstream consumers,
- permission checks and protected operations,
- state changes and lifecycle callbacks,
- serialized data and API contracts,
- database migrations and application assumptions,
- tests and behavior they claim to cover.

## Stage Guidance

### Stage 5: Planner

Extend the planner output with `reviewQuestions`.

Planner instructions:

- Write only concrete questions that matter for correctness, security, reliability, tests, or architecture.
- Prefer questions about relationships across changed code, not generic "check this carefully" prompts.
- Each question should include the files/symbols that are likely needed to answer it.
- Do not classify the question into a fixed category.
- Do not create many questions. Default target should be 0-5 questions per PR.
- Large PRs may have more, but questions should remain bounded and high-value.

Good question:

```text
Does the transformed value used by the downstream output/validation path still match the externally visible contract?
```

Bad question:

```text
Review this file for bugs.
```

### Stage 6: Packet Builder

Attach relevant `ReviewQuestion`s to packets.

Use simple relevance signals:

- file overlap,
- changed symbol overlap,
- symbol mentions in changed hunks,
- nearby caller/callee hints from existing symbol facts,
- planner-listed files/symbols,
- same package or same coalesced review area when already available.

Keep this bounded:

- attach at most a small number of questions per packet, for example 1-3,
- prefer exact file/symbol overlap,
- avoid attaching every PR-level question to every packet.

Add a packet field such as:

```ts
type PacketReviewQuestion = ReviewQuestion & {
  relevanceReason: string
}
```

### Stage 7: Packet Review

Update packet-review instructions:

- Treat attached review questions as obligations to resolve.
- If a question reveals a concrete defect, emit a candidate finding.
- If the packet answers the question and no defect exists, include a concise answer in `noFindingReason` or a structured `answeredQuestions` field.
- If the packet only partially answers the question, emit an uncertainty/follow-up that preserves the exact question framing.

Require the answer to **show its work, not assert a verdict.** For a relationship/contract question, the reviewer must produce a concrete evidence trace before concluding: values should trace requested -> transformed -> reported/validated, permission questions should trace actor -> check -> protected operation, lifecycle questions should trace state/event -> side effect -> cleanup, and test questions should trace old coverage -> new coverage -> still-live behavior boundary. A glib "yes, the contract holds" is hard to produce when it is false once the reviewer must write the trace. Put the trace in `AnsweredReviewQuestion.evidence`; an `answered_no_issue` outcome without a trace should be treated as a non-answer.

Add structured output if needed:

```ts
type AnsweredReviewQuestion = {
  questionId: string
  answer: string
  confidence: "high" | "medium" | "low"
  outcome: "answered_no_issue" | "candidate_finding" | "partial" | "not_applicable"
  evidence: Array<{ path: string; lines?: string; whyRelevant: string }>
}
```

The answer schema may use small outcome labels, but the question itself remains free-form. These labels are operational state, not risk taxonomy.

### Stage 8: Focused Follow-Up

Use unanswered or partially answered questions to decide whether Stage 8 should run.

Stage 8 is the second implementation slice. Do not make the first implementation depend on broad Stage 8 machinery. First validate that planner questions are emitted, attached, answered, and preserved in artifacts; then add focused follow-up for questions that remain partial across multiple relevant packets.

Expect this slice to be useful for issues where the evidence path spans multiple packets: producer/helper behavior -> caller use -> downstream consumer or public contract. The motivating `49f4645b` case has that shape, but the implementation must stay generic and must not encode any target-repo names or symbols. Issue 57 improves the caller-context hop; Slice 1 keeps the question alive and well-traced; Slice 2 lets a focused follow-up read producer + caller + consumer together when no single packet has enough context. Treat "slice 1 alone closes the eval gap" as a hypothesis to test in steps 1-6, not the plan of record.

Build a follow-up only when:

- the question is attached to more than one relevant packet,
- Stage 7 produced partial or conflicting answers,
- no direct candidate finding already covers the question,
- the question points to concrete files/symbols and can be answered with a small packet.

Stage 8 input should be a focused bundle:

- original review question,
- relevant packet summaries,
- selected snippets from the producer/caller/consumer files,
- any Stage 7 partial answers,
- tool access with normal/deep budget depending on review depth.

Stage 8 should produce either:

- a candidate finding,
- an `answered_no_issue` record,
- or an unresolved human-attention note only if it is concrete and important.

Do not run Stage 8 for vague questions.

Stage 8 triggering should consume the review-question lifecycle directly. It should not depend on `uncertainty-promotion.ts` classifying the question as `local_behavior_delta`, `test_boundary`, `security_boundary`, or any similar fixed promotion lane. Uncertainty promotion may still handle legacy packet hints, but review questions should keep their original wording and evidence trail through follow-up.

### Stage 9: Verification

Keep verification strict.

Verifier receives candidate findings as before. If a candidate came from a review question, include:

- the original question,
- packet answers,
- Stage 8 follow-up answer if any.

The verifier should not keep a finding because a question exists. It should keep only when evidence proves a real issue.

Do not add verifier exceptions based on review-question type. If a question-derived candidate uses a normal finding category, that category should help presentation and routing only; the verifier decision should rest on evidence, anchor validity, concrete failure mode, and false-positive risk.

### Stage 10: Composition and Artifacts

Record question lifecycle in artifacts:

- planner questions,
- packet attachments,
- packet answers,
- Stage 8 follow-up tasks,
- candidates generated from questions,
- final disposition.

Keep the final markdown findings-first. Do not add a noisy "questions" section by default.

For debug/eval, add concise metrics:

- review questions emitted,
- attached to packets,
- answered in Stage 7,
- promoted to Stage 8,
- converted to candidates,
- verified findings,
- unresolved/suppressed.

## Likely Files

- `src/pipeline/planner.ts`
- `src/pipeline/packet-builder.ts`
- `src/pipeline/lens-runner.ts`
- `src/pipeline/system-review.ts` or Stage 8 equivalent
- `src/pipeline/uncertainty-promotion.ts` only to prevent review questions from being bottlenecked by the existing promotion taxonomy
- `src/pipeline/verifier.ts`
- `src/pipeline/composer.ts`
- `src/telemetry/run-artifacts.ts`
- `src/types.ts`
- `tests/*planner*.test.ts`
- `tests/*packet*.test.ts`
- `tests/*system*.test.ts`
- `tests/*review*.test.ts`

## Implementation Order

1. Add `ReviewQuestion` and `AnsweredReviewQuestion` types/schemas and planner prompt instructions.
2. Seed review questions from the planner's existing free-form `riskAreas` reasoning where possible, so concerns already discovered by Stage 5 do not evaporate. This is a prompt-level instruction, not a mechanical copy: `riskAreas` (`src/types.ts:672`) carries `{ area, reason, files[], suggestedLenses[] }` — it has `files[]` but no `symbols[]`, and `area` is a short label, not a question. So instruct the planner to emit a `reviewQuestion` for each material risk area, reformulating the label into an answerable question, carrying `files` across, and inferring `symbols` from the hunk symbol-facts and `coverage[].surroundingContextHints` it already produces. (Grounding note: in the `49f4645b` runs the planner already emitted the relevant risk area — "Quote amount denomination split (TransferAmount vs DestinationAmount)" — on every run; the concern was discovered and then lost, which is exactly what seeding prevents.)
3. Attach questions to packets deterministically and boundedly.
4. Update Stage 7 instructions and schema handling so packet reviewers answer attached questions, convert them to candidates, or mark them partial/not applicable.
5. Write question lifecycle artifacts and metrics.
6. Rerun evals and inspect whether the right questions survive even when no final finding is produced.
7. Add Stage 8 follow-up only if partial/conflicting question answers remain a real recall gap after steps 1-6.

## Acceptance Criteria

- Planner can emit free-form review questions without a fixed risk taxonomy.
- Relevant questions are attached to packets deterministically and boundedly.
- Packet review output records whether attached questions were answered, partially answered, or converted to findings.
- First implementation can preserve and answer review questions without Stage 8.
- When implemented, Stage 8 runs for concrete unresolved multi-packet questions and stays idle for vague or already-answered questions.
- Verification remains strict and does not publish speculative questions.
- Artifacts make it clear when a question was dropped, answered, promoted, or converted into a finding.
- Question disposition is not gated by `FindingCategory`, `PromotionClass`, or regex risk-profile classification.
- No target-repo names or domain-specific keyword rules are introduced.

## Validation

Add focused tests:

- Planner output with review questions parses and validates.
- Packet builder attaches a question by file/symbol overlap.
- Packet builder does not attach unrelated questions to every packet.
- Stage 7 no-finding output can answer an attached question.
- Stage 7 partial answers are preserved in artifacts before any Stage 8 follow-up work is added.
- If Stage 8 follow-up is implemented, Stage 7 partial answer can trigger a Stage 8 follow-up.
- A concrete open question with no matching built-in category can still remain tracked and trigger Stage 8 when evidence is partial/conflicting.
- A review question is not converted into a promoted finding merely because it matches a category keyword.
- Stage 8 does not run for vague or single-packet questions.
- Question-derived candidates still require normal verification.

Run:

```text
pnpm exec vitest run tests/*planner*.test.ts tests/*packet*.test.ts tests/*system*.test.ts tests/*review*.test.ts
pnpm test
pnpm run build
```

Then rerun the eval several times:

```text
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/49f4645b --no-cache
```

Expected trend:

- Stage 7 or Stage 8 should preserve the concrete transformed-value vs downstream-contract question.
- If there is no final finding, artifacts should show exactly where and why the question was answered or rejected.

Because packet review is stochastic, judge this by **pass-rate across repeated runs, not a single run**. Use 3-5 runs for a quick signal, and N>=10 only when cost is acceptable and release-level confidence is needed. A single improved run is indistinguishable from luck. Residual single-call variance is out of scope for this issue; it is a separate lever (e.g. multi-sampling deep packets) to consider after 56/57 land.

## Stop Conditions

Stop and reassess if:

- planner emits many vague questions,
- packets become overloaded with question context,
- Stage 8 starts running on most PRs,
- verifier precision drops,
- final reports include unresolved questions as noise,
- implementation starts adding domain-specific keyword rules.
