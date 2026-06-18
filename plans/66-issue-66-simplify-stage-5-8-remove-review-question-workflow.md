# Issue 66: Simplify Stage 5-8 By Removing Planner Review Questions

Status: PENDING
Planned from: trails-api eval `49f4645b/logs/12` compared with `49f4645b/logs/1`, 2026-06-18
Planned at: commit `605a38e`
Recommended priority: high, because the review-question workflow hid a real correctness finding by narrowing broad review emphasis into the wrong local proof

## Problem

codeninja's current Stage 5-8 design lets the planner emit `reviewQuestions`, `obligation`s, and `riskAreaDispositions`. Stage 6 attaches those questions to packets, Stage 7 answers them, and Stage 8 may resolve unresolved primary questions.

This has become too much control flow for the planner.

The concrete failure is eval `trails-api/49f4645b/logs/12`. The PR contains a real medium correctness issue:

```text
EXACT_OUTPUT cross-decimal quotes can advertise a ToAmountMin that the packed transfer amount cannot deliver after floor-truncating scale-down.
```

The successful run `logs/1` found it directly in Stage 7 and verified it. Run `logs/12` did not report it. The loss did not happen because the diff was skipped, tools failed, context was unavailable, verification rejected the finding, or composition dropped it. The finding was lost before candidate generation:

- Stage 5 produced a useful broad attention note: `Rounding/precision on scale-down conversions`.
- Stage 5 then emitted narrower local questions:
  - does `scaleAmount` multiply/divide in the right direction?
  - does `scaleAmount` avoid `big.Int` aliasing?
  - are `ToAmount`, `ToAmountMin`, and USD internally derived from the same destination value?
- Stage 7 answered those local questions as no issue.
- Stage 8 resolved the same weak questions as no issue.
- Stage 9 saw only two unrelated docs-packet candidates and correctly rejected both.

The actual issue was not "is scale direction correct?" or "are fields internally consistent?" The issue was the end-to-end changed behavior:

```text
requested destination amount -> floor-scaled origin transfer amount -> packed transfer calldata -> deliverable destination amount -> quoted ToAmountMin
```

Planner-authored questions are therefore a lossy abstraction. Stage 5 cannot realistically predict the exact bug. When it tries, it can compress the right broad concern into the wrong question, and downstream stages treat the bad question as coverage.

## Goal

Return Stage 5-8 to simple, purposeful stage boundaries:

```text
Stages 1-4: deterministic inventory
  - collect diff
  - filter files
  - classify basic file facts
  - extract changed symbols / hunk facts / repository index

Stage 5: lightweight LLM scout
  - read deterministic inventory
  - summarize likely PR intent
  - choose broad review emphasis
  - choose review order / coverage overrides
  - select lenses
  - note broad cross-file/system emphasis that later stages can use as context

Stage 6: deterministic packet construction
  - build packets from hunks/symbols
  - attach deterministic context
  - attach Stage 5 emphasis as optional metadata only

Stage 7: actual issue finding
  - run packet reviewers
  - produce candidate findings, uncertainties, and follow-up hints

Stage 8: optional cross-file issue finding
  - run only from repeated/high-signal Stage 7 hints or unresolved cross-packet evidence needs
  - not from planner-authored questions

Stage 9: verify candidates
Stage 10: compose
Stage 11: publish/render
```

The key principle: Stage 5 should schedule attention, not author proof obligations. Stage 7 and Stage 8 own bug discovery.

## Non-Goals

- Do not remove Stage 5.
- Do not remove Stage 8 entirely.
- Do not add a replacement taxonomy such as `riskKind`, `questionKind`, or domain-specific risk classes.
- Do not encode Hyperlane, trails-api, Go, decimals, quotes, `EXACT_OUTPUT`, `ToAmountMin`, token terminology, or any target-repo-specific pattern.
- Do not make Stage 5 a deeper review pass.
- Do not loosen Stage 9 verifier standards.
- Do not make Stage 8 a broad whole-repo review pass.
- Do not preserve `reviewQuestions` as hidden control flow under a new name.

## Current State

Relevant source files:

- `src/types.ts` defines `ReviewQuestion`, `PacketReviewQuestion`, `RiskAreaDisposition`, `AnsweredReviewQuestion`, `ReviewPlan.reviewQuestions`, and `ReviewPacket.reviewQuestions`.
- `src/llm/schemas.ts` exposes planner `reviewQuestions` and Stage 7 `answeredQuestions` in provider-facing schemas.
- `src/skills/prompt-builder.ts` instructs the planner to emit 0-5 review questions and instructs packet reviewers to answer attached questions.
- `src/pipeline/planner.ts` normalizes, synthesizes, dedupes, and records planner review questions and risk-area dispositions.
- `src/pipeline/packet-builder.ts` attaches planner review questions to packets and assigns primary/supporting ownership.
- `src/pipeline/lens-runner.ts` normalizes `answeredQuestions`, downgrades obligation answers, and turns partial question answers into follow-up hints.
- `src/pipeline/system-reviewer.ts` builds Stage 8 tasks from repeated follow-up hints and unresolved primary review questions.
- `src/pipeline/review-runner.ts` records review-question lifecycle artifacts and metrics.
- `README.md` and `specs/projects/codeninja/functional_spec.md` still describe planner questions as part of the main pipeline.

Representative current code facts:

```ts
// src/types.ts
export type ReviewQuestion = {
  id: string;
  question: string;
  whyItMatters: string;
  files: string[];
  symbols: string[];
  evidenceHint?: string;
  obligation?: string;
};

export type ReviewPlan = {
  diffUnderstanding: DiffUnderstanding;
  riskAreas: Array<{ area: string; reason: string; files: string[]; suggestedLenses: string[] }>;
  reviewQuestions?: ReviewQuestion[];
  riskAreaDispositions?: RiskAreaDisposition[];
  coverage: HunkCoverageDecision[];
};
```

This plan should rename/reframe `riskAreas` as `reviewEmphasis`. The current name overstates what Stage 5 can know. The planner can identify changed areas that deserve attention, but it should not claim that an area is a proven semantic risk or become control flow for downstream proof obligations.

```text
README.md currently says Stage 5 asks the planner for "open review questions" and Stage 6 attaches "planner review questions" to packets. That should change.
```

Test files with expected churn:

- `tests/pipeline-phase5.test.ts` has many review-question tests, including normalization, synthesis, attachment, ownership, answered questions, obligations, and lifecycle artifact assertions.
- `tests/pipeline-phase8.test.ts` has repeated-hint tests plus question/obligation Stage 8 tests.
- `tests/uncertainty-promotion.test.ts` and `tests/phase4-llm.test.ts` include `answeredQuestions` fixtures.

## Commands

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Focused Stage 5 tests | `pnpm exec vitest run tests/pipeline-phase5.test.ts` | exit 0 |
| Focused Stage 6 tests | `pnpm exec vitest run tests/pipeline-phase6.test.ts` | exit 0 |
| Focused Stage 7 tests | `pnpm exec vitest run tests/pipeline-phase7.test.ts tests/phase4-llm.test.ts` | exit 0 |
| Focused Stage 8 tests | `pnpm exec vitest run tests/pipeline-phase8.test.ts tests/uncertainty-promotion.test.ts` | exit 0 |
| Typecheck | `pnpm run typecheck` | exit 0, no TypeScript errors |
| Full tests | `pnpm test` | exit 0, all tests pass |
| Build | `pnpm run build` | exit 0 |

## Scope

In scope:

- `src/types.ts`
- `src/llm/schemas.ts`
- `src/skills/prompt-builder.ts`
- `src/pipeline/planner.ts`
- `src/pipeline/packet-builder.ts`
- `src/pipeline/lens-runner.ts`
- `src/pipeline/system-reviewer.ts`
- `src/pipeline/review-runner.ts`
- `src/pipeline/composer.ts` only if final human-attention plumbing still references removed question artifacts
- `src/pipeline/human-attention.ts` only if final human-attention plumbing still references removed question artifacts
- `tests/pipeline-phase5.test.ts`
- `tests/pipeline-phase6.test.ts`
- `tests/pipeline-phase7.test.ts`
- `tests/pipeline-phase8.test.ts`
- `tests/phase4-llm.test.ts`
- `tests/uncertainty-promotion.test.ts`
- `README.md`
- `specs/projects/codeninja/functional_spec.md`
- `specs/projects/codeninja/architecture.md` if it describes planner questions as control flow

Out of scope:

- Provider login/config commands.
- GitHub publishing behavior except text/docs that mention stages.
- Tree-sitter parsing, repository tools, or source recovery.
- Stage 9 verifier policy.
- Stage 10 semantic composition policy.
- Eval expectation YAML changes, unless a test fixture directly references removed question fields.

## Design

### Stage 5: Lightweight Scout

Keep Stage 5 as the first LLM decision point, but make it advisory and scheduling-focused.

Stage 5 should output:

```ts
type ReviewPlan = {
  diffUnderstanding: DiffUnderstanding;
  reviewEmphasis?: Array<{
    summary: string;
    basis: string[];
    files: string[];
    symbols?: string[];
    suggestedLenses: string[];
  }>;
  coverage: HunkCoverageDecision[];
  partialReview?: { ... };
};
```

Notes:

- `reviewEmphasis` is broad attention guidance, not a finding, proof obligation, or question to answer.
- `reviewEmphasis.basis` must list concrete facts from the deterministic inventory, commit/PR text, configured repo hints, changed symbols, or static signals.
- Each `basis` item should be observable from Stage 5 inputs. Do not include speculative bug claims such as "this may break exact-output behavior" unless that claim is directly stated in the PR/spec text.
- `coverage` remains the primary Stage 5 output that affects scheduling.
- Stage 5 must not schedule Stage 8 by itself. Stage 8 may see planner emphasis as context only after Stage 7 emits concrete follow-up hints.
- Do not require Stage 5 to identify exact bug predicates.
- Remove planner question synthesis from review emphasis.

Prompt shape:

```text
You are Stage 5, the lightweight review scout for codeninja.

Your job is not to review the code and not to find bugs. Your job is to read the deterministic PR inventory and produce a compact review plan that helps later stages spend attention well.

Inputs you will receive:
- PR title/body and commit messages, when available
- changed files and diff summary
- changed hunks with line ranges
- changed symbols and enclosing-symbol facts
- basic file facts, tests touched, generated/skipped files, and static signals
- optional repo config/spec context summaries

Return only the ReviewPlan schema.

Rules:
- Do not emit review questions.
- Do not emit proof obligations.
- Do not claim a bug exists.
- Do not use a fixed risk taxonomy.
- `reviewEmphasis` is optional. Use it only for changed areas that deserve extra reviewer attention because of concrete input facts.
- Each `reviewEmphasis.basis` entry must be a short observable fact from the inputs, not an inference that requires reviewing implementation correctness.
- Use `coverage` to choose light/normal/deep/skip for hunks based on changed-code centrality, public surface, test impact, configured critical paths, static signals, and PR size.
- If unsure, prefer assigning deeper coverage to central changed hunks rather than inventing a specific concern.

Good reviewEmphasis:
{
  "summary": "Amount conversion changes affect quote construction",
  "basis": [
    "The diff changes `scaleAmount` in `lib/.../amounts.go`.",
    "The changed symbol is referenced by quote construction code listed in the changed-symbol facts.",
    "The PR changes behavior code and does not add tests touching the changed symbol."
  ],
  "files": ["lib/.../amounts.go", "lib/.../quotes.go"],
  "symbols": ["scaleAmount", "GetQuote"],
  "suggestedLenses": ["core/logic-bugs", "core/tests"]
}

Bad reviewEmphasis:
{
  "summary": "Exact-output quotes may under-deliver",
  "basis": ["scaleAmount truncates during scale-down"],
  "files": ["lib/.../amounts.go"],
  "suggestedLenses": ["core/logic-bugs"]
}

The bad example is a review finding hypothesis. Stage 5 should not make that claim.
```

### Stage 6: Deterministic Packet Construction

Stage 6 should:

- build hunk/file packets deterministically,
- attach hunk content, line numbers, enclosing symbols, outlines, likely tests, and deterministic context,
- apply coverage/lens decisions,
- include broad Stage 5 `reviewEmphasis` as optional prompt context when relevant by file/symbol overlap.

Stage 6 should not:

- attach review questions,
- assign primary/supporting question ownership,
- emit question attachment metrics,
- create cross-file packets to satisfy planner questions.

If review emphasis is attached to a packet, render it as attention context:

```text
Planner emphasis:
- Amount normalization and cross-file data flow may deserve deeper inspection.
```

The reviewer must not be asked to answer them directly.

### Stage 7: Candidate Generation

Stage 7 should return:

- `findings`,
- `uncertainties`,
- `followUpHints`,
- `noFindingReason`,
- coverage/runtime metadata.

Stage 7 should not return `answeredQuestions`.

Packet prompt guidance should say:

- Use planner emphasis only as attention guidance.
- Find concrete changed-code issues.
- If a concern requires cross-file proof and cannot be resolved locally, emit a precise `followUpHint`.
- If a concern is concrete enough, emit a candidate finding and let Stage 9 verify it.
- Do not suppress a concrete changed-code concern just because a broad planner emphasis appears locally consistent.

This returns Codeninja to the intended architecture: generate liberally enough in Stage 7, verify strictly in Stage 9.

### Stage 8: Narrow Cross-File Follow-Up

Stage 8 should only run from Stage 7 output:

- repeated scoped follow-up hints,
- high-signal single follow-up hint when the hint carries concrete files/symbols and a changed-code failure predicate,
- unresolved cross-packet evidence needs carried in Stage 7 hints.

Stage 8 should not run because a planner review question was unanswered, partial, or unresolved.

Stage 8 tasks should contain:

```ts
type SystemReviewTask = {
  taskId: string;
  question: string;
  files: string[];
  symbols: string[];
  packetIds: string[];
  suggestedLenses: string[];
  triggeringHints: FollowUpHint[];
  plannerEmphasis?: string[];
};
```

The `question` here comes from packet reviewers, not from Stage 5. This keeps Stage 8 grounded in concerns raised during actual code review.

### Human Attention Notes

Keep final "Needs Human Attention" notes for unresolved Stage 7/8 follow-up hints that are medium/high confidence and concrete.

Remove human-attention notes derived from planner questions.

### Telemetry

Remove or replace review-question metrics:

- remove `review-questions.json`, or replace it with a simpler `follow-up-hints.json` if useful;
- remove `reviewQuestionAttachments`, `packetsWithReviewQuestions`, `reviewQuestionObligations`, and obligation metrics;
- keep Stage 8 artifacts: raw tasks, scheduled tasks, results, resolved hints;
- add simple planner emphasis metrics if needed:
  - number of review-emphasis notes,
  - number of coverage overrides,
  - number of packets carrying planner emphasis as context.

The run artifacts should make it clear:

- what Stage 5 suggested,
- which packets were reviewed at which coverage,
- what Stage 7 concerns or candidates were produced,
- why Stage 8 ran or skipped,
- what Stage 9 verified.

## Implementation Steps

### Step 1: Update shared types and schemas

Remove review-question control-flow types from `src/types.ts`:

- remove `ReviewQuestion`,
- remove `RiskAreaDisposition`,
- remove `PacketReviewQuestion`,
- remove `AnsweredReviewQuestion`,
- remove `ReviewPlan.reviewQuestions`,
- remove `ReviewPlan.riskAreaDispositions`,
- remove `ReviewPacket.reviewQuestions`,
- remove `PacketReviewResult.answeredQuestions`.

If a full deletion causes too much churn in one step, temporarily keep deprecated types only where necessary for fixture migration, but do not keep them in live pipeline interfaces.

Update `src/llm/schemas.ts`:

- remove planner `reviewQuestions`,
- remove Stage 7 `answeredQuestions`,
- remove question IDs from finding schemas if they only link to planner questions,
- keep `followUpHints`, `uncertainties`, and findings.

**Verify**: `pnpm run typecheck` should fail only in the expected pipeline/test files before later steps fix callers.

### Step 2: Simplify Stage 5 planner

Update `src/skills/prompt-builder.ts` planner instructions:

- remove instructions to emit `reviewQuestions`, `obligation`, and risk-area dispositions;
- tell the planner it is not a review pass;
- tell it to output intent, review emphasis, and coverage/lens overrides only;
- tell it to schedule deeper review rather than trying to prove bugs.

Update `src/pipeline/planner.ts`:

- remove review-question normalization;
- remove synthesized questions from planner emphasis;
- remove question caps/constants;
- remove `riskAreaDispositions`;
- replace `riskAreas` normalization with `reviewEmphasis` normalization, or keep `riskAreas` only as a deprecated input compatibility alias that is immediately mapped to `reviewEmphasis`;
- normalize `reviewEmphasis.basis` as short fact strings, dropping empty/speculative entries and capping the list so it remains scheduling context;
- keep coverage normalization.

**Verify**: `pnpm exec vitest run tests/pipeline-phase5.test.ts` should pass after obsolete review-question tests are removed or rewritten.

### Step 3: Simplify Stage 6 packet builder

Update `src/pipeline/packet-builder.ts`:

- remove `attachReviewQuestions`;
- remove `assignReviewQuestionOwnership`;
- remove question role/ownership telemetry;
- remove question attachment fields from packet artifacts;
- attach broad planner emphasis only as plain context if already supported, or add a minimal field such as `plannerEmphasis?: string[]`.

Do not add cross-file packet grouping in this plan.

**Verify**: `pnpm exec vitest run tests/pipeline-phase6.test.ts tests/pipeline-phase5.test.ts`

Expected result:

- packet construction still applies coverage/lenses correctly;
- no packet contains `reviewQuestions`;
- packets may contain broad planner emphasis if implemented.

### Step 4: Simplify Stage 7 packet review

Update `src/skills/prompt-builder.ts` Stage 7 instructions:

- remove "answer attached review questions";
- remove primary/supporting/ambiguous ownership text;
- emphasize candidate generation, uncertainty, and follow-up hints;
- tell reviewers to turn concrete concerns into findings or precise follow-up hints.

Update `src/pipeline/lens-runner.ts`:

- remove `answeredQuestions` normalization and truncation;
- remove obligation downgrade helpers;
- remove conversion from partial planner-question answers to follow-up hints;
- keep schema repair/truncation for remaining fields;
- keep `followUpHints` validation, ranking, caps, and uncertainty handling.

**Verify**: `pnpm exec vitest run tests/pipeline-phase7.test.ts tests/phase4-llm.test.ts tests/uncertainty-promotion.test.ts`

### Step 5: Re-scope Stage 8 to Stage 7 hints only

Update `src/pipeline/system-reviewer.ts`:

- remove task creation from unresolved primary planner questions;
- keep repeated scoped follow-up hint grouping;
- allow a conservative high-signal single-hint path only if it already exists or is simple to add without taxonomy;
- remove obligation resolution rules;
- remove question ownership attachment logic;
- keep bounded task caps, read-only tools, and candidate output.

Stage 8 skip reason should become:

```text
no repeated or high-signal scoped follow-up hints
```

**Verify**: `pnpm exec vitest run tests/pipeline-phase8.test.ts`

Expected result:

- repeated follow-up hints still schedule Stage 8;
- planner-question-only scenarios no longer schedule Stage 8;
- Stage 8 findings still flow to Stage 9.

### Step 6: Simplify run artifacts and final human attention

Update `src/pipeline/review-runner.ts`:

- remove `buildReviewQuestionLifecycle`;
- stop writing `review-questions.json`;
- remove review-question metrics from Stage 6 and final telemetry;
- if useful, write `follow-up-hints.json` summarizing raw, promoted, resolved, and output notes.

Update `src/pipeline/human-attention.ts` and `src/pipeline/composer.ts` only if needed:

- unresolved human-attention notes should come from Stage 7/8 follow-up hints, not planner questions;
- existing verified-finding suppression should continue.

**Verify**: `pnpm exec vitest run tests/pipeline-phase5.test.ts tests/pipeline-phase8.test.ts`

### Step 7: Update docs

Update:

- `README.md`
- `specs/projects/codeninja/functional_spec.md`
- `specs/projects/codeninja/architecture.md` if it mentions planner review questions

Docs should say:

- Stage 5 is a lightweight scout, not a review pass.
- Stage 5 outputs intent, review emphasis, and coverage/lens overrides.
- Stage 6 builds packets and may attach broad emphasis as context, not questions.
- Stage 7 is the candidate generation stage.
- Stage 8 is triggered by Stage 7 follow-up hints only.
- Stage 9 verifies.
- Stage 10 composes.
- Stage 11 publishes/renders.

Remove or rewrite text that says:

- planner emits open review questions,
- packets include planner questions,
- Stage 7 answers planner questions,
- Stage 8 resolves unresolved primary planner questions.

**Verify**: `rg -n "reviewQuestions|ReviewQuestion|obligation|riskAreaDispositions|answeredQuestions|planner review questions|primary planner" README.md specs src`

Expected result:

- no live docs/source references to removed planner-question control flow;
- any remaining "obligation" references are unrelated to review questions or explicitly documented as removed/deprecated.

### Step 8: Clean tests and fixtures

Remove or rewrite tests that only assert the old question workflow:

- review-question normalization,
- review-question synthesis,
- question attachment,
- primary/supporting ownership,
- obligation downgrades,
- Stage 8 unresolved planner-question tasks,
- review-question lifecycle artifact.

Keep and strengthen tests for the new boundaries:

- Stage 5 emits coverage/lens overrides without review questions.
- Stage 6 builds packets without review questions.
- Stage 7 can emit findings and follow-up hints without answered questions.
- Stage 8 schedules from repeated/high-signal Stage 7 hints.
- Final human attention is derived from unresolved Stage 7/8 hints.

**Verify**: `pnpm test`

### Step 9: Full validation

Run:

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

Expected:

- all commands exit 0;
- no `reviewQuestions`, `riskAreaDispositions`, or `answeredQuestions` remain in live pipeline contracts;
- Stage 8 still has focused hint-driven tests.

## Eval Validation

After implementation, run at least:

```bash
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/49f4645b --no-cache
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/0c4d5213 --no-cache
```

Expected qualitative result:

- `49f4645b` should no longer close the exact-output truncation concern by answering a weak planner question.
- If Stage 7 misses it, artifacts should show a true Stage 7 candidate-generation miss, not a planner-question/Stage 8 resolution miss.
- `0c4d5213` should preserve previous pass quality and should not lose verified findings because question plumbing was removed.

Do not tune to one eval run. If results vary, inspect the funnel:

```text
Stage 5 coverage/lenses -> Stage 6 packets -> Stage 7 candidates/hints -> Stage 8 hint tasks -> Stage 9 verification -> Stage 10 composition
```

## Done Criteria

- [ ] Stage 5 no longer emits or synthesizes planner review questions.
- [ ] Stage 6 no longer attaches planner questions or assigns question ownership.
- [ ] Stage 7 no longer accepts/returns `answeredQuestions`.
- [ ] Stage 8 no longer schedules work from unresolved planner questions.
- [ ] Human-attention notes come from unresolved Stage 7/8 follow-up hints, not planner questions.
- [ ] Docs describe Stage 5 as lightweight scout/scheduler and Stage 7/8 as issue-finding stages.
- [ ] `pnpm run typecheck` exits 0.
- [ ] `pnpm test` exits 0.
- [ ] `pnpm run build` exits 0.
- [ ] `plans/README.md` marks this plan complete when implemented.

## STOP Conditions

Stop and report back if:

- Removing `answeredQuestions` requires deleting `followUpHints` or uncertainty promotion entirely.
- Removing planner questions would also remove Stage 5 coverage/lens overrides.
- Stage 8 cannot be made hint-driven without a broad whole-repo pass.
- Tests reveal `reviewQuestions` are still required by public output or GitHub publishing.
- The implementation starts introducing a new fixed taxonomy to replace planner questions.

## Maintenance Notes

This plan intentionally supersedes the recent question/obligation hardening work in Issues 56, 60, 63, 64, and 65. Those plans were useful experiments, but evals showed the abstraction is too lossy. The simplified design should make future misses easier to diagnose: either Stage 7 found/proposed a concern, Stage 8 followed a concrete hint, or the finding was genuinely missed before candidate generation.

Reviewers should scrutinize the implementation for accidental hidden question semantics. Renaming `reviewQuestions` to another field without changing control flow is not a successful implementation.
