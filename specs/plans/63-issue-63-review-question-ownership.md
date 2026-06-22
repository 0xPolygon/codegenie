# Issue 63: Review Question Ownership and Risk-Area Coverage

Status: COMPLETE
Planned from: trails-api eval runs `0c4d5213/logs/25` and `49f4645b/logs/9`, 2026-06-17
Recommended priority: high, because run 9 showed that a material planner risk can be identified but never become an owned review obligation

## Problem

Run 25 showed that review questions improve recall, but they also add repeated Stage 7 work:

- 5 planner review questions were emitted.
- 25 packets had attached questions.
- 28 question attachments were created.
- Stage 7 answered 27 questions.
- Stage 8 later built duplicate tasks for the same unresolved root question.

This helped the eval pass, but it also made Stage 7 heavier. Many packets partially re-litigated the same cross-cutting question, especially for helper-equivalence and refactor-preservation concerns.

The current model is:

```text
question attaches to many relevant packets -> every packet may answer it
```

The simpler model should be:

```text
question has one primary packet owner -> supporting packets answer only their local slice
```

This preserves review-question recall while reducing repeated evidence essays, duplicated follow-up hints, and duplicate Stage 8 tasks.

Run `49f4645b/logs/9` showed a more important ownership gap:

- Stage 5 identified `Quote output amount scaling (ToAmount/ToAmountMin/USD)` as a risk area.
- The synthesized review questions covered collateral scaling and aliasing instead.
- The `process_quote.go` packet had no attached review question even though the missed finding was about the downstream quoted output contract.
- Stage 7 noticed exact-output truncation but answered the narrower collateral question as no issue, so no candidate reached verification.

This means ownership cannot start only after questions exist. Before assigning primary/supporting packet roles, the pipeline should confirm that material planner risk areas are represented by at least one owned review obligation, or explicitly record why they were omitted.

## Goal

Make review-question handling more effective and less repetitive by assigning ownership.

Desired behavior:

- Material planner risk areas are either represented by an attached review question / packet obligation, covered by another equivalent question, or recorded as omitted with a reason.
- Each review question should have at most one primary packet owner when a clear owner exists.
- Supporting packets may still receive the question, but their instruction should be scoped to their local contribution.
- Stage 7 should expect the primary packet to produce the full answer, candidate finding, or precise unresolved predicate.
- Supporting packets should provide local evidence only, not repeat the whole cross-system analysis.
- Stage 8 should use ownership metadata to merge partial answers and avoid duplicate follow-up tasks.

This should simplify Stage 7 without reducing recall.

## Non-Goals

- Do not remove review questions.
- Do not introduce a fixed risk taxonomy or question kind enum.
- Do not hard-code repo, language, file, symbol, or domain names.
- Do not force every risk area into a question when it is vague, duplicate, docs-only, or already represented.
- Do not attach every question to fewer packets blindly; if no primary owner is clear, keep the existing bounded attachment behavior.
- Do not require Stage 8 for every question.
- Do not weaken verifier standards.
- Do not suppress candidate findings from supporting packets if they independently see a concrete changed-line defect.

## Design

### 0. Represent Material Risk Areas Before Ownership

Before assigning primary packet owners, evaluate each planner risk area against the normalized review questions and packet set.

For each material risk area, record one disposition:

```ts
type RiskAreaDisposition =
  | "represented_by_question"
  | "represented_by_packet_obligation"
  | "covered_by_existing_question"
  | "omitted_duplicate"
  | "omitted_vague"
  | "omitted_no_relevant_packet"
```

This is workflow accounting, not a risk taxonomy. It should use the planner's own free-form text and deterministic overlap with changed files/symbols. It must not classify the risk into closed kinds.

Representation rules:

- If a risk area has file/symbol overlap with a review question, mark it represented.
- If a risk area is materially distinct from existing questions and maps to one or more normal/deep packets, synthesize or keep a packet obligation for it within the existing question cap.
- If a risk area is broad, duplicate, docs-only without executable packets, or cannot attach to a relevant packet, omit it with a reason.
- Prefer preserving risks that mention concrete changed relationships, contracts, downstream outputs/consumers, validation, tests, security, reliability, or architecture in the planner's natural language.

Artifacts should show which risk areas were represented and which were omitted. This directly prevents run-9-style evaporation where the planner saw the right concern but the question system preserved only adjacent concerns.

### 1. Add Question Attachment Roles

Extend packet-attached review questions with a simple operational role:

```ts
type PacketReviewQuestion = ReviewQuestion & {
  relevanceReason: string
  role?: "primary" | "supporting"
}
```

This is not a risk taxonomy. It is only ownership metadata for workflow coordination.

If changing the type is too invasive, use equivalent metadata in the packet/debug artifact while keeping the review prompt text explicit.

### 2. Select a Primary Packet Deterministically

During Stage 6 question attachment, score candidate packets for each question.

Signals, in priority order:

- changed file overlap with the question files,
- changed symbol overlap with the question symbols,
- packet contains the changed hunk most directly tied to the question,
- packet coverage is `deep`,
- packet has relevant context hints/static signals,
- packet is not already overloaded with too many primary questions.

Assign one primary owner when the top packet is clearly better than alternatives.

If no clear owner exists:

- do not force ownership,
- attach as supporting or leave the existing behavior unchanged,
- record why ownership was not assigned.

Keep caps:

- max 1-2 primary questions per packet by default,
- existing per-packet question cap still applies,
- do not increase packet count or create new review packets.

If a material risk area maps strongly to a packet but no question could be attached because of caps, record that as an omitted obligation with a reason. Do not silently drop it.

### 3. Prompt Stage 7 Differently For Primary vs Supporting Questions

Primary question instruction:

- answer the full question if possible,
- emit a candidate if the answer reveals a concrete defect,
- if unresolved, preserve the exact missing predicate for Stage 8/verifier.

Supporting question instruction:

- answer only the local slice visible in this packet,
- do not repeat a full cross-system proof,
- cite local evidence,
- mark partial when local evidence is insufficient,
- still emit a candidate if this packet independently shows a concrete changed-line defect.

This should reduce long no-finding answers while keeping useful local evidence.

### 4. Use Ownership In Stage 8

Stage 8 should prefer:

- one task per primary unresolved question,
- supporting answers grouped under that primary task,
- no task when the primary answer produced a verified candidate or a clear no-issue answer and supporting packets do not conflict.

This complements Issue 61. Issue 61 dedupes tasks after construction; this plan reduces duplicate task construction at the source.

### 5. Artifacts And Telemetry

Add lightweight telemetry:

- `review_question_ownership_assigned`
- `review_question_ownership_unassigned`

Useful fields:

- question ID,
- primary packet ID,
- supporting packet count,
- reason,
- scoring summary or selected signals.

Update `review-questions.json` to include:

- risk area dispositions,
- represented/omitted material risk area counts,
- primary packet,
- supporting packets,
- ownership reason,
- Stage 7 primary answer,
- supporting answers,
- Stage 8 task linkage if any.

## Implementation Steps

1. Audit current review-question attachment and risk-area synthesis.
   - Locate the Stage 6 attachment helper.
   - Locate the Stage 5/60 helper that synthesizes review questions from risk areas.
   - Identify available packet signals: file overlap, symbol overlap, coverage, static signals, context hints, packet size.
   - Confirm how attachments are rendered into packets and `review-questions.json`.

2. Add material risk-area representation accounting.
   - Compare planner risk areas to normalized review questions and packet coverage.
   - Record represented and omitted material risk areas.
   - Synthesize or retain only bounded, concrete obligations; do not introduce fixed categories.

3. Add ownership scoring.
   - Keep it deterministic and local to Stage 6.
   - Do not call an LLM.
   - Prefer obvious ownership only; leave ambiguous cases unowned.

4. Extend packet rendering and prompt guidance.
   - Clearly label primary vs supporting questions.
   - Keep wording short.
   - Do not add long explanatory text to every packet.

5. Update Stage 7 answer normalization if needed.
   - Preserve role metadata with answers or through question lookup.
   - Ensure unknown question IDs are still dropped.
   - Do not require supporting packets to provide full evidence traces for the whole question.

6. Update Stage 8 task builder.
   - Group supporting answers under their primary question.
   - Avoid building duplicate tasks for the same primary question.
   - Continue to run narrow tasks only when unresolved/conflicting evidence remains.

7. Add tests.
   - A material risk area with no equivalent question but clear packet overlap becomes represented by a bounded obligation.
   - A material risk area that is already covered by another question is marked covered, not duplicated.
   - A vague or unattached risk area is omitted with a reason in artifacts.
   - A question with one obvious matching packet gets a primary owner.
   - A question with several weakly related packets remains unowned/supporting.
   - Supporting packets are rendered with local-slice instructions.
   - Stage 8 builds one task for one unresolved primary question with multiple supporting answers.
   - Candidate findings from supporting packets are still preserved.

## Likely Files

- `src/pipeline/packet-builder.ts`
- `src/pipeline/review-questions.ts` or equivalent helper if already extracted
- `src/pipeline/lens-runner.ts`
- `src/pipeline/system-reviewer.ts`
- `src/types.ts`
- `src/telemetry/run-artifacts.ts`
- `tests/pipeline-phase5.test.ts`
- `tests/pipeline-phase8.test.ts`

## Acceptance Criteria

- Run-25-style review questions have at most one primary owner when ownership is clear.
- Run-9-style material risk areas do not silently disappear; artifacts show represented or omitted status.
- Stage 7 still answers material review questions, but supporting packets produce shorter local-slice answers.
- Stage 8 receives fewer duplicate question tasks.
- Candidate count and eval expectations do not regress.
- No closed risk taxonomy or repo-specific logic is introduced.

## Validation

Run focused tests:

```text
pnpm exec vitest run tests/pipeline-phase5.test.ts tests/pipeline-phase8.test.ts
```

Then run:

```text
pnpm test
pnpm run build
```

On the next eval, compare against run 25:

- review-question attachments,
- answered question count,
- Stage 8 task count,
- Stage 7 output tokens,
- schema-invalid count,
- candidate/final finding counts,
- expectation pass/fail.

Expected direction:

- fewer planner risk areas with no lifecycle disposition,
- fewer repeated answers,
- fewer duplicate Stage 8 tasks,
- no recall loss.

## Stop Conditions

Stop and reassess if:

- primary ownership causes relevant packets to ignore real local defects,
- ambiguous ownership is forced and hides evidence,
- Stage 8 loses necessary supporting context,
- implementation grows into a scheduler refactor,
- ownership scoring starts to resemble a fixed risk taxonomy.
