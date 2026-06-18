# Issue 64: Material Review Question Answer Quality and Ambiguous Ownership Follow-Up

Status: COMPLETE
Planned from: trails-api eval `49f4645b/logs/10` compared with `49f4645b/logs/1`, 2026-06-18
Recommended priority: high, because Stage 5 can identify a real cross-code concern, but Stage 7 can still close it with a too-local no-issue answer before Stage 8 verifies the full relationship
Planned at: commit `eb39be3`

## Problem

Eval `49f4645b/logs/1` found a credible issue:

- `EXACT_OUTPUT transfer amount truncates down, under-delivering vs the quoted ToAmountMin`
- anchored in `lib/routes/hyperlane/hyperlane.go`
- the core proof crossed a caller path, a helper transformation, and a downstream reported/validated amount.

Eval `49f4645b/logs/10` reviewed the same range and found nothing. This was not because the planner missed the concern:

- Stage 5 emitted a concrete question about whether the changed scaling behavior was still safe.
- Stage 6 attached that question to multiple packets, but ownership was ambiguous and no primary owner was assigned.
- Stage 7 answered `answered_no_issue` from local packet slices. The answers had evidence text, so the normalizer accepted them.
- Stage 8 did not run a follow-up because the question was not partial/unresolved and had no primary owner.
- Stage 9 never saw a correctness candidate.

The generic failure is:

```text
planner found a material cross-code concern
  -> Stage 6 could not clearly pick one owner
  -> Stage 7 answered no issue from local evidence
  -> Stage 8 treated the concern as closed
  -> no verifier candidate was generated
```

That is a lossy handoff. A material question that spans more than one packet should not be closed by a no-issue answer unless the answer proves the full relationship, not just one local slice.

## Goal

Make material review questions durable until they receive a full answer, a candidate finding, or a bounded Stage 8 follow-up.

Desired behavior:

- Ambiguous cross-packet review questions remain visible as obligations.
- Stage 7 can still answer `answered_no_issue`, but only when the answer covers the full scope of the question.
- A local no-issue answer for an ambiguous or multi-symbol question is downgraded to `partial`, preserving the exact predicate for Stage 8.
- Stage 8 runs a narrow follow-up when a material ambiguous question has only local no-issue answers and no linked finding.
- The verifier remains strict. This plan should increase candidate/follow-up recall, not lower publication standards.

## Non-Goals

- Do not introduce a fixed risk taxonomy, risk kind enum, or domain-specific classifier.
- Do not hard-code repo, language, file, symbol, or eval names.
- Do not weaken Stage 9 verifier thresholds.
- Do not make Stage 8 a broad whole-PR review.
- Do not force every planner risk area into Stage 8.
- Do not mark all no-issue answers as partial.
- Do not roll back Issues 56, 57, 58, 60, 61, 62, or 63.

## Current State

Relevant files:

- `src/pipeline/packet-builder.ts` - Stage 6 review-question attachment and ownership assignment.
- `src/pipeline/lens-runner.ts` - Stage 7 packet result normalization, including answered review questions.
- `src/pipeline/system-reviewer.ts` - Stage 8 targeted system-review task construction.
- `src/skills/prompt-builder.ts` - Stage 5 and Stage 7 prompt rules for review questions.
- `src/types.ts` - shared `PacketReviewQuestion` and `AnsweredReviewQuestion` types.
- `tests/pipeline-phase5.test.ts` - existing Stage 5/6/7 review-question tests.
- `tests/pipeline-phase8.test.ts` - existing Stage 8 question-follow-up tests.

Current Stage 6 ownership behavior leaves ambiguous questions unowned:

```ts
// src/pipeline/packet-builder.ts:454-479
const best = ranked[0];
const second = ranked[1];
const clear = best !== undefined && ownershipIsClear(best, second, attachments.length);
if (!clear || best === undefined) {
  unassigned += 1;
  const reason = attachments.length === 0
    ? "no_attached_packets"
    : best === undefined
      ? "all_candidate_packets_at_primary_limit"
      : "ambiguous_packet_match";
  telemetry.event({
    stage: 6,
    level: "info",
    message: "review_question_ownership_unassigned",
    data: {
      questionId,
      reason,
      attachments: attachments.length,
      scores: attachments.sort(compareOwnershipCandidates).map(ownershipScoreSummary)
    }
  });
  continue;
}
```

Current Stage 7 normalization downgrades no-issue answers only when evidence or trace is missing:

```ts
// src/pipeline/lens-runner.ts:498-512
if (outcome === "answered_no_issue" && (evidence.length === 0 || evidenceTrace === undefined || evidenceTrace.length === 0)) {
  outcome = "partial";
  confidence = confidence === "high" ? "medium" : confidence;
  telemetry.event({
    stage: 7,
    level: "warn",
    message: "review_question_answer_downgraded",
    packetId: packet.id,
    workerId,
    data: {
      questionId: attached.id,
      reason: "answered_no_issue_without_evidence_trace"
    }
  });
}
```

Current Stage 8 follow-up construction ignores unowned `answered_no_issue` answers:

```ts
// src/pipeline/system-reviewer.ts:437-445
for (const question of packet.reviewQuestions ?? []) {
  if (coveredQuestionIds.has(question.id) || globallyCoveredQuestionIds.has(question.id) || primaryByQuestion.has(question.id)) {
    continue;
  }
  const answer = answersByQuestion.get(question.id);
  const needsFollowUp = unresolvedQuestionIds.has(question.id) || answer?.outcome === "partial";
  if (!needsFollowUp || answer?.confidence === "low") {
    continue;
  }
```

The Stage 7 prompt already asks for a decisive trace, but the code only enforces that a trace exists:

```ts
// src/skills/prompt-builder.ts:150-152
"If the packet includes reviewQuestions, treat them as obligations and answer only those exact question IDs..."
"For each relevant question, either emit a candidate finding, record an answeredQuestions entry with concrete evidence, or mark it partial/not_applicable. Do not answer a question with a bare assertion: show the decisive trace in evidenceTrace..."
"Review questions must not become an escape hatch from candidate findings..."
```

## Scope

In scope:

- `src/types.ts`
- `src/pipeline/packet-builder.ts`
- `src/pipeline/lens-runner.ts`
- `src/pipeline/system-reviewer.ts`
- `src/skills/prompt-builder.ts`
- `tests/pipeline-phase5.test.ts`
- `tests/pipeline-phase8.test.ts`
- `plans/README.md`

Out of scope:

- Provider/model configuration.
- Eval expectation YAML changes.
- Verifier confidence thresholds.
- New review taxonomies or domain-specific keywords.
- Broad Stage 8 system review.
- Any trails-api source files.

## Commands

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Focused tests | `pnpm exec vitest run tests/pipeline-phase5.test.ts tests/pipeline-phase8.test.ts` | exit 0, all selected tests pass |
| Typecheck | `pnpm run typecheck` | exit 0, no TypeScript errors |
| Full tests | `pnpm test` | exit 0, all tests pass |
| Build | `pnpm run build` | exit 0 |

## Design

### 1. Preserve Ambiguous Ownership As Operational Metadata

Extend the existing packet-attached question metadata to distinguish clear ownership from ambiguous ownership.

Suggested shape:

```ts
type PacketReviewQuestion = ReviewQuestion & {
  relevanceReason: string;
  role?: "primary" | "supporting";
  ownershipReason?: string;
  ownershipStatus?: "primary" | "supporting" | "ambiguous" | "unassigned";
  ownershipCandidatePacketIds?: string[];
}
```

This is workflow metadata, not a risk taxonomy. It describes whether the pipeline has a clear owner for answering the question.

When `assignReviewQuestionOwnership` cannot choose a clear owner because of `ambiguous_packet_match`:

- mark attached copies as `ownershipStatus: "ambiguous"`;
- include the top candidate packet IDs;
- preserve the current telemetry event and scores;
- do not force a primary owner unless the existing scoring rules clearly support it.

When no packet attaches at all, keep `unassigned`.

When a primary is assigned, set `ownershipStatus` consistently with `role`.

### 2. Prefer Integration Packets When They Clearly Tie Multiple Symbols Together

Keep ownership deterministic and generic. Add a small tie-breaker only when a packet appears to integrate multiple symbols named by the question.

Generic signal:

- packet symbol facts match one question symbol; and
- changed hunk text or surrounding context mentions another question symbol; and
- the packet has normal/deep coverage.

This should help choose caller/integration packets over helper-only packets when the evidence is clear. It must not use domain words such as amount, quote, decimals, token, route, etc.

If the tie remains close after this signal, keep the question ambiguous rather than forcing ownership.

### 3. Downgrade Too-Local No-Issue Answers

Add a Stage 7 helper near `normalizeAnsweredQuestions` that checks no-issue answer adequacy.

Rules:

- Only inspect answers with `outcome === "answered_no_issue"`.
- If the question is `primary` and single-packet, keep the current behavior unless evidence/trace is missing.
- If the question is `supporting`, `ambiguous`, unowned, or attached to multiple packets/symbols, a no-issue answer must demonstrate that it covered the question's full scope.
- A full-scope answer should reference enough of the question's files/symbols/evidence trace to show the relationship was checked end-to-end.
- If the answer only covers the local packet slice, downgrade it to `partial`, reduce `high` confidence to `medium`, and emit telemetry:

```text
review_question_answer_downgraded
reason: "answered_no_issue_incomplete_question_scope"
```

Do not make this an LLM call. This should be conservative deterministic validation of the answer shape and available metadata.

Avoid brittle token matching. Use the question's own free-form `files`, `symbols`, attached role/status, packet path, and evidence paths. A reasonable initial rule is:

- for ambiguous/unowned questions with multiple attached packets, no-issue answers are partial unless evidence references at least two distinct attached packet paths or the trace text names the relevant cross-symbol relationship;
- for questions with multiple symbols, no-issue answers are partial unless the answer/trace/evidence mentions more than the current packet's primary symbol.

The exact helper should be small, tested, and biased toward sending only ambiguous material concerns to Stage 8. It should not create many follow-ups for ordinary local questions.

### 4. Trigger Narrow Stage 8 For Ambiguous Material Questions

Extend `questionFollowUpGroups` so Stage 8 can run when all of these are true:

- the question is attached to more than one packet, or at least one attachment has `ownershipStatus: "ambiguous"`;
- no candidate finding already links to the question;
- no primary owner produced a full candidate or strong no-issue answer;
- Stage 7 produced only partial answers, downgraded no-issue answers, unresolved markers, or local no-issue answers for the question;
- the task can be bounded to the attached packets/files/symbols.

Keep caps unchanged or stricter:

- do not increase total Stage 8 task caps;
- prefer one task per question ID;
- do not create duplicate tasks when Issue 61 deduplication would merge them later.

The Stage 8 prompt/task should receive:

- the original question text and why it matters;
- ownership status/reason;
- attached packet IDs;
- Stage 7 answers and evidence traces;
- files/symbols from the question plus attached packet symbol facts.

### 5. Prompt The Model To Mark Local Answers Partial

Adjust Stage 7 wording lightly.

Add a short instruction:

```text
For ambiguous or unowned review questions that span multiple files, symbols, or packets, answer no_issue only if you can trace the full relationship. If you only checked this packet's local slice, mark partial and preserve the exact predicate Stage 8 should verify.
```

Do not add domain examples. Do not add a long taxonomy of question types.

### 6. Telemetry And Artifacts

Add or preserve enough telemetry to diagnose this without rereading raw prompts:

- count ambiguous question attachments;
- count no-issue answers downgraded for incomplete scope;
- count Stage 8 tasks created from ambiguous material questions;
- include ownership status/reason and candidate packet IDs in `review-questions.json`.

Do not expand artifacts with full source snippets.

## Implementation Steps

### Step 1: Add Ownership Status Metadata

Update `PacketReviewQuestion` in `src/types.ts` with optional workflow fields for ownership status and candidate packet IDs.

Update `setPacketQuestionOwnership` in `src/pipeline/packet-builder.ts` so assigned primary/supporting questions set both `role` and `ownershipStatus`.

Add a small helper for ambiguous ownership, for example `setPacketQuestionAmbiguousOwnership`, used only when `reason === "ambiguous_packet_match"`.

Verify:

```bash
pnpm run typecheck
```

Expected: exit 0.

### Step 2: Record Ambiguous Attachments In Stage 6

In `assignReviewQuestionOwnership`, when ownership is ambiguous:

- compute the top 2-3 candidate packet IDs from the sorted scores;
- annotate each attached copy of that question with `ownershipStatus: "ambiguous"`, `ownershipReason: "ambiguous packet match"`, and candidate IDs;
- keep the existing `review_question_ownership_unassigned` telemetry event.

Add a focused test in `tests/pipeline-phase5.test.ts` near the existing ambiguous ownership test. The test should use generic files/symbols, such as `app.ts`, `worker.ts`, `transformValue`, and `renderResponse`.

Expected assertion:

- attached questions remain unowned by `role`;
- attached questions have `ownershipStatus: "ambiguous"`;
- telemetry still emits `review_question_ownership_unassigned`.

Verify:

```bash
pnpm exec vitest run tests/pipeline-phase5.test.ts
```

Expected: exit 0.

### Step 3: Add Generic Integration Tie-Breaker

In `reviewQuestionOwnershipCandidate`, add a small deterministic signal for packets that appear to connect multiple question symbols.

Implementation guidance:

- derive `matchedSymbols` from symbol overlap;
- derive `mentionedSymbols` from hunk text and context hint symbols;
- if the union includes at least two distinct question symbols and coverage is normal/deep, add a modest score bonus and a reason such as `integrates multiple question symbols`;
- keep the bonus lower than exact file/symbol overlap so it does not dominate obvious ownership.

Add tests:

- one test where an integration packet clearly wins over a helper-only packet;
- one test where two packets still tie and remain ambiguous.

Verify:

```bash
pnpm exec vitest run tests/pipeline-phase5.test.ts
```

Expected: exit 0.

### Step 4: Downgrade Incomplete No-Issue Answers

In `src/pipeline/lens-runner.ts`, add a helper used by `normalizeAnsweredQuestions` after the existing evidence/trace check.

Suggested helper name:

```ts
function noIssueAnswerCoversQuestionScope(
  answer: SubmittedAnsweredQuestion,
  attached: PacketReviewQuestion,
  packet: ReviewPacket,
  evidence: Array<{ path: string; lines?: string; whyRelevant: string }>,
  evidenceTrace: string | undefined
): boolean
```

Keep it simple:

- return true for primary single-packet questions unless current evidence/trace validation already failed;
- return false for ambiguous/unowned/supporting multi-attachment questions when evidence only references the current packet and the trace does not mention other question symbols/files;
- return true when evidence spans multiple relevant files or the trace clearly names multiple question symbols.

When false, downgrade to `partial`, reduce high confidence to medium, and emit `review_question_answer_downgraded` with reason `answered_no_issue_incomplete_question_scope`.

Add tests in `tests/pipeline-phase5.test.ts`:

- ambiguous multi-symbol no-issue with only local evidence is downgraded to partial;
- ambiguous multi-symbol no-issue with evidence spanning both relevant files/symbols remains no-issue;
- primary local no-issue behavior remains unchanged.

Verify:

```bash
pnpm exec vitest run tests/pipeline-phase5.test.ts
```

Expected: exit 0.

### Step 5: Add Ambiguous Question Stage 8 Follow-Up

In `src/pipeline/system-reviewer.ts`, extend `questionFollowUpGroups`.

Implementation guidance:

- build question-level attachment and answer summaries once;
- for each question with ambiguous/unowned multi-packet attachments and no globally covered finding, create one follow-up group if no answer provides a full-scope no-issue;
- include packets with attached answers plus relevant attachments, bounded by existing task caps;
- reuse existing `QuestionFollowUpGroup` shape rather than adding a new task type.

Add tests in `tests/pipeline-phase8.test.ts`:

- ambiguous question with local no-issue answers creates one Stage 8 task;
- ambiguous question with a linked finding creates no task;
- primary question with a strong no-issue answer still creates no task.

Verify:

```bash
pnpm exec vitest run tests/pipeline-phase8.test.ts
```

Expected: exit 0.

### Step 6: Update Prompt Text And Artifacts

Update Stage 7 wording in `src/skills/prompt-builder.ts` with the short ambiguous/unowned instruction from the design section.

Update review-question artifact projection in `src/pipeline/review-runner.ts` if needed so `review-questions.json` includes the new ownership status fields.

Verify:

```bash
pnpm run typecheck
```

Expected: exit 0.

### Step 7: Full Validation

Run:

```bash
pnpm exec vitest run tests/pipeline-phase5.test.ts tests/pipeline-phase8.test.ts
pnpm run typecheck
pnpm test
pnpm run build
```

Expected: all commands exit 0.

## Test Plan

Add regression tests with generic fixtures only. Do not use trails-api names.

Cases to cover:

- ambiguous ownership metadata is preserved when no clear primary owner exists;
- integration/caller packet can win ownership when it clearly links multiple question symbols;
- unresolved ties remain ambiguous rather than forced;
- Stage 7 downgrades local no-issue answers for ambiguous multi-packet questions;
- Stage 7 preserves full-scope no-issue answers;
- Stage 8 creates exactly one follow-up task for an ambiguous material question with only local/partial answers;
- Stage 8 skips when a linked candidate finding already covers the question.

## Done Criteria

- [ ] `PacketReviewQuestion` can represent ambiguous ownership without introducing a risk taxonomy.
- [ ] Stage 6 records ambiguous ownership in packet metadata and telemetry.
- [ ] Stage 7 downgrades too-local no-issue answers for ambiguous/multi-packet questions.
- [ ] Stage 8 creates bounded follow-up tasks for ambiguous material questions that are not covered by a finding or full-scope answer.
- [ ] Tests cover the new ownership, downgrade, and Stage 8 behavior.
- [ ] `pnpm exec vitest run tests/pipeline-phase5.test.ts tests/pipeline-phase8.test.ts` passes.
- [ ] `pnpm run typecheck` passes.
- [ ] `pnpm test` passes.
- [ ] `pnpm run build` passes.
- [ ] `plans/README.md` is updated.

## STOP Conditions

Stop and report instead of improvising if:

- Implementing this requires adding fixed review categories, risk kinds, or domain-specific keywords.
- Stage 8 task construction would become broad enough to inspect unrelated files.
- More than a small number of existing tests need rewritten expectations unrelated to review-question ownership or answer quality.
- The no-issue downgrade rule would downgrade most primary single-packet questions.
- The fix requires weakening verifier acceptance logic.

## Maintenance Notes

This plan intentionally keeps Stage 9 strict. The quality improvement comes from preserving material questions until a proper proof exists, not from publishing more weak findings.

Reviewers should scrutinize the deterministic scope check. It should be conservative enough to catch local-only no-issue answers for ambiguous questions, but not so broad that every multi-symbol question triggers Stage 8.

After implementation, rerun:

```bash
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/49f4645b --no-cache
```

Expected qualitative result: the material cross-code question should either produce a candidate finding or a Stage 8 task that explicitly answers the full relationship. Do not require a specific title or domain wording.
