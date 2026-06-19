# Issue 67: Planner Coverage Emphasis and Hunk Relationship Context

Status: COMPLETE
Planned from: trails-api eval `49f4645b/logs/13` compared with `49f4645b/logs/1`, 2026-06-18
Recommended priority: high, because Plan 66 cleaned up planner obligations but also exposed a dropped-signal contract between Stage 5 and Stage 6/7

## Problem

Plan 66 removed planner-authored review questions, answered questions, and obligation tracking. That was the right simplification: Stage 5 should not try to predict exact bugs, and downstream stages should not treat planner questions as proof obligations.

The follow-up eval `trails-api/49f4645b/logs/13` shows the next contract problem.

Stage 5 still noticed useful changed-code concerns in broad prose, including decimal-scaling and quote-field consistency. But that signal was not carried into Stage 7 because it did not land in the specific structured field Stage 6 consumes:

- `ReviewPlan.diffUnderstanding.inferredBehavior` contained useful scout prose.
- `ReviewPlan.reviewEmphasis` was empty.
- Stage 6 only attached matching `reviewEmphasis` entries to packets as `reviewEmphasisNotes`.
- The important packets therefore had `reviewEmphasisNotes: []`.

The expected finding was then lost in Stage 7 candidate generation. The changed helper packet reviewed `scaleAmount` locally and concluded the helper was correct and tested. It did not review the changed helper through the changed caller and downstream quote contract:

```text
requested destination amount
  -> scale-down origin transfer amount
  -> packed transfer calldata
  -> deliverable destination amount
  -> quoted ToAmountMin
```

Run `logs/1` found the issue because the older planner output produced packet `riskNotes` and a call-site hint to the caller. Run `logs/13` had a cleaner Stage 5-8 architecture, but the packet lacked that related changed context.

The issue is not that Stage 5 needs deeper reasoning. The issue is that review-driving planner output is split across fields, and Stage 6 does not build enough deterministic relationships between changed hunks/symbols for Stage 7 to reason about interactions.

Run 13 also exposed a downstream Stage 9 routing problem: a concrete correctness concern was promoted and verified under a testing frame because the hint was phrased as a test-coverage question. That is intentionally tracked separately in Issue 68. Issue 67 fixes the upstream context contract so Stage 7 has a better chance to produce direct, well-framed candidates; it does not loosen verification or rely on the verifier accepting weaker findings.

## Goal

Make Stage 5 and Stage 6 contracts explicit and lossless:

```text
Stage 5: lightweight scout
  - summarize declared/inferred PR intent for artifacts/debugging
  - choose hunk coverage, lenses, and concrete surrounding context hints
  - attach short hunk-scoped focus notes only through coverage decisions
  - do not emit standalone global review emphasis, questions, or obligations

Stage 6: deterministic packet construction
  - build packets from hunks and changed symbols
  - build a deterministic hunk/symbol relationship graph
  - coalesce only where safe and bounded
  - otherwise attach related changed-context snippets/summaries to packets
  - carry Stage 5 coverage reasons, focus notes, and context-hint reasons into packets

Stage 7: issue finding
  - review the changed packet plus attached related changed context
  - produce candidates, uncertainties, and follow-up hints
  - do not answer planner questions
```

The main principle: if Stage 5 wants later stages to spend attention somewhere, that instruction must be hunk-scoped in `coverage`, not hidden in global prose.

## Non-Goals

- Do not reintroduce planner review questions.
- Do not reintroduce proof obligations.
- Do not create a fixed risk taxonomy.
- Do not encode Hyperlane, trails-api, decimals, quotes, exact-output, token amounts, or any target-repo-specific concept.
- Do not make Stage 5 a multi-pass review by default.
- Do not make Stage 8 run from planner output.
- Do not build cross-file packets in v1.
- Do not loosen Stage 9 verification.
- Do not rely on fixed domain patterns such as rounding, denomination, guarantee, collateral, or token arithmetic. The implementation must remain structural and language/project neutral.

## Design Decisions

### Functional Spec Contract

The functional behavior should be described in user-facing/spec terms as:

```text
Stage 5 produces a lightweight review plan. The plan may explain the PR's likely intent and inferred behavior, but any planner output that should affect reviewer attention must be attached to a changed hunk through the hunk's coverage decision.

Stage 6 turns the plan and deterministic repository index into review packets. It preserves every changed hunk's coverage, attaches bounded hunk-scoped planner notes, and attaches bounded related changed context when the changed-symbol graph shows that another changed hunk/symbol is relevant.

Stage 7 reviews packets using the changed hunk plus its attached local and related context. It is responsible for finding issues. It does not answer planner questions and does not treat planner notes as findings.
```

Functional guarantees:

- Planner notes are advisory. They help Stage 7 spend attention, but they never prove a bug and never bypass verification.
- Coverage remains honest. Every changed hunk is reviewed, skipped, failed, or budget-stopped exactly once in the coverage ledger.
- Related context is bounded. codeninja should prefer showing the most relevant related changed symbol/hunk over broad file dumps.
- Cross-file relationships are context, not packet grouping, in v1. A packet may include related cross-file snippets, but its own changed hunks remain from one file.
- Stage 8 remains narrow. It should be triggered by concrete Stage 7 follow-up hints, not planner prose.

This keeps the product promise simple: codeninja reviews the affected system without dumping the whole repo or asking the planner to find bugs.

### Architecture Sketch

Implementation should be free to choose exact module boundaries, but the clean architecture is:

```text
Stage 5 planner
  -> ReviewPlan.coverage[hunkId].reason/focusNotes/relatedSymbols/relatedFiles/surroundingContextHints

Stage 6 packet builder
  -> planned hunk records
  -> lean HunkRelationshipGraph
  -> conservative packet grouping
  -> related changed context attachment
  -> ReviewPacket.attentionNotes + ReviewPacket.relatedChangedContext

Stage 7 prompt renderer
  -> changed hunk(s)
  -> deterministic contextText
  -> bounded attentionNotes
  -> bounded relatedChangedContext
```

Suggested ownership:

- `planner.ts` owns normalization of hunk-scoped planner output.
- `packet-builder.ts` owns packet identity, grouping, context caps, and coverage records.
- A small helper module may own hunk relationship construction if it keeps `packet-builder.ts` readable, for example `hunk-relationships.ts`.
- Repository/tree-sitter tools remain source-recovery infrastructure. They can power relationship evidence, but they should not become semantic truth.

Suggested artifacts and telemetry:

- Write a compact `hunk-relationships.json` artifact with graph nodes, edges, omitted-edge counts, and attached-context decisions.
- Emit Stage 6 telemetry for `relationship_graph_built`, `related_context_attached`, `related_context_omitted`, and `packet_attention_notes_attached`.
- Record why related context was omitted: cap exceeded, source unavailable, ambiguous symbol, no changed caller, or duplicate context already present.
- Avoid logging huge snippets in telemetry events; snippets live only in packet artifacts.

Implementation flexibility:

- Exact type names may differ. `attentionNotes`, `plannerNotes`, or another clear name is fine; avoid `riskNotes`.
- The graph can be an internal data structure first. It does not need to be a public API.
- Coalescing helper/caller hunks is optional. Attaching related changed context is the required behavior.
- If a deterministic relationship cannot be proven cheaply, prefer no edge over speculative edges.
- In v1, keep the graph lean. The necessary behavior is to attach changed caller/callee/sibling context among changed symbols when the relationship is mechanically supported. Broader edges can wait for evidence from later evals.

### No Default Multi-Pass Planner

Do not add a second Stage 5 LLM pass by default.

A multi-pass planner may appear attractive as a "double-check the thinking" mechanism, but it does not fix the failure seen in run 13. Stage 5 already noticed the broad issue; the signal was dropped by the schema/packet contract. A second planner call would add latency, cost, and another nondeterministic output without guaranteeing that Stage 6/7 receives better context.

Keep the existing large-PR chunking and schema repair paths. If later evals show planner output itself is the bottleneck after this contract is fixed, consider an optional diagnostic-only planner critique pass behind a config flag. That is out of scope for this issue.

### Remove Standalone `reviewEmphasis`

`ReviewPlan.reviewEmphasis` should be removed from the primary schema.

Review-driving guidance should live in `HunkCoverageDecision` because coverage decisions are already hunk-scoped, validated, and consumed by Stage 6.

Target shape:

```ts
type HunkCoverageDecision = {
  hunkId: string;
  path: string;
  coverage: CoverageLevel;
  lenses: string[];
  surroundingContextHints: SurroundingContextHint[];
  reason: string;
  focusNotes?: string[];
  relatedSymbols?: string[];
  relatedFiles?: string[];
};

type ReviewPlan = {
  diffUnderstanding: DiffUnderstanding;
  intentSignals?: IntentSignals;
  coverage: HunkCoverageDecision[];
  partialReview?: {
    isPartial: boolean;
    reason: string;
    reviewedHunks: number;
    totalHunks: number;
  };
};
```

Rules:

- `diffUnderstanding` remains useful for artifacts, debugging, final report framing, and prompt context when compactly projected.
- `diffUnderstanding` must not be the only carrier of review-driving attention.
- `coverage.reason` should explain why this hunk received non-default coverage or lenses.
- `focusNotes` are optional, short, hunk-scoped attention notes grounded in the dossier.
- `relatedSymbols` and `relatedFiles` are optional hints for Stage 6 context assembly. They are not proof obligations.
- Omitted hunks still receive deterministic `normal` default coverage in Stage 6.
- If an LLM response includes legacy `reviewEmphasis`, ignore it in new runs rather than treating it as hidden review guidance. Keeping the planner contract single-channel is more important than preserving a short-lived internal field.

### Stage 5 Prompt Contract

Update the planner prompt so it cannot put actionable review guidance in the wrong place.

Prompt requirements:

```text
You are Stage 5, the lightweight review scout.

Your job is not to find bugs. Your job is to schedule attention.

Return:
- diffUnderstanding for human/debug context
- coverage decisions for hunks that need non-default coverage, lenses, focus notes, or context hints
- partialReview only when the review cannot cover the full change set

Do not return review questions, proof obligations, global risk lists, or standalone review emphasis.

If you notice a changed-code interaction that deserves attention, attach it to the relevant hunk coverage decision as:
- reason
- focusNotes
- relatedSymbols / relatedFiles
- surroundingContextHints

If you cannot link an observation to a changed hunk, leave it in diffUnderstanding only. Later stages must not treat global prose as a review instruction.
```

This keeps Stage 5 realistic. It can say "this hunk deserves deep review and these related symbols/files are relevant"; it does not have to know the exact bug.

### Deterministic Hunk/Symbol Relationship Graph

Stage 6 should build a small deterministic relationship graph from existing Stage 4 repository index data and diff facts.

Nodes:

- changed hunks
- changed enclosing symbols
- changed files

V1 edges should be deterministic, evidence-backed, and intentionally narrow:

- same file and same enclosing symbol
- hunk changes a symbol that is mentioned/called by another changed symbol
- hunk changes a helper that is mentioned by changed callers
- planner `surroundingContextHints` or `relatedSymbols`/`relatedFiles` name a concrete relationship

Avoid domain categories. Edge reasons should describe concrete structure:

```ts
type HunkRelationshipEdge = {
  fromHunkId: string;
  toHunkId?: string;
  toPath?: string;
  toSymbol?: string;
  reason: string;
  source:
    | "same_symbol"
    | "symbol_mention"
    | "planner_hint";
};
```

The `source` values are provenance for debugging and deterministic behavior, not review taxonomy. They should not appear as reviewer-facing risk labels.

Relationship confidence should be mechanical, not semantic:

- strong: same enclosing symbol, explicit planner context hint to a changed symbol, or verified identifier mention inside an enclosing caller/callee symbol;
- medium: a related file is explicitly named by coverage metadata and resolves to a changed hunk or changed symbol;
- weak: raw text overlap only.

Only strong and selected medium edges should attach context automatically. Weak edges may be kept in graph telemetry for debugging but should not enter packet prompts by default.

Defer `nearby_hunk` and `test_reference` edges until later evals show that they are needed. They are plausible, but they are not necessary for the current failure mode and would widen the first implementation.

### Packet Grouping and Context

Do not broadly group hunks just because a relationship exists.

Packet grouping remains conservative:

- Default: one packet per hunk.
- Coalesce same-file hunks already inside the same enclosing symbol.
- Coalesce same-file nearby hunks when the combined patch/context fits strict caps.
- Optionally coalesce same-file helper/caller hunks only when:
  - the relationship edge is strong,
  - both hunks are already `deep` or `normal`,
  - combined prompt size remains under packet caps,
  - anchors remain unambiguous.
- Never create cross-file packets in v1.

When coalescing is not safe, attach related changed context instead:

```ts
type RelatedChangedContext = {
  path: string;
  hunkId?: string;
  symbol?: string;
  lineRange?: [number, number];
  reason: string;
  sourceSnippet?: string;
  patchExcerpt?: string;
};
```

Attach at most a small bounded number of related contexts per packet, prioritized by:

1. planner hints/context hints for this hunk,
2. caller/callee/sibling relationships among changed symbols,
3. same-symbol changed hunks.

This solves the run-13 failure mode without asking Stage 5 to know the final bug. The `scaleAmount` packet should not need a domain-specific prompt; it should receive the changed caller context that makes observable behavior reviewable.

Attachment must be bidirectional where the evidence supports it:

- a changed helper packet may receive changed caller context;
- a changed caller packet may receive changed helper context;
- related same-file changed symbols may receive each other's changed-hunk excerpts when they share a mechanically proven identifier relationship.

This avoids the one-sided failure where the helper sees callers but the caller still cannot see the changed helper or upstream derivation.

Track prompt-size effects explicitly. Adding related context must not silently crowd out the primary hunk, enclosing symbol, or changed-line context. If related context is omitted due to caps, record that in the packet artifact and Stage 6 telemetry.

### Packet Notes

Replace packet `reviewEmphasisNotes` with a clearer name such as `plannerNotes` or `attentionNotes`.

Packet notes should be assembled from:

- validated `coverage.reason`,
- `coverage.focusNotes`,
- relevant `surroundingContextHints.reason`,
- deterministic relationship edge reasons when a related context was attached.

Do not include broad `diffUnderstanding` prose directly unless it is already linked to the packet through coverage or a concrete relationship.

Caps:

- max 3 packet notes by default,
- each note capped to a short sentence,
- notes are advisory prompt context only.

### Stage 7 Prompt Contract

Stage 7 should stay general.

Do not add a list of bug categories such as rounding/conversion/validation/etc. Instead update the reviewer prompt to say:

```text
Review the changed packet and the related changed context attached by the harness. Consider the observable behavior of the changed symbols in their shown callers, callees, tests, and output paths. If the local change looks correct in isolation, still check whether the attached related context changes its effect before concluding no findings.
```

This is not a taxonomy. It is a general instruction to use the context Stage 6 provides.

## Implementation Steps

1. Update types and schemas.
   - Remove `ReviewPlan.reviewEmphasis` from the primary schema.
   - Add optional `focusNotes`, `relatedSymbols`, and `relatedFiles` to `HunkCoverageDecision`.
   - Add a packet field for bounded related changed context, or reuse an existing context carrier only if it is a clean fit.
   - Rename `reviewEmphasisNotes` to `plannerNotes` or `attentionNotes`.

2. Update Stage 5 prompt/schema normalization.
   - Remove standalone `reviewEmphasis` instructions.
   - Tell the planner to put review-driving attention in coverage decisions.
   - Normalize and cap `focusNotes`, `relatedSymbols`, and `relatedFiles`.
   - Ignore legacy `reviewEmphasis` if it appears in repaired model output; do not map it into packet prompts.

3. Build the Stage 6 relationship graph.
   - Use `RepositoryIndex.symbolFacts`, changed symbols, hunk metadata, `findSymbolMentions`, and planner hints.
   - Start with `same_symbol`, `symbol_mention`, and `planner_hint` edges only.
   - Walk changed-symbol relationships in both directions when attaching context.
   - Keep graph construction deterministic and capped.
   - Record graph summary telemetry: nodes, edges, attached contexts, omitted contexts.

4. Attach related changed context.
   - For each packet, use the graph to attach bounded related snippets or patch excerpts.
   - Prefer caller body snippets for changed helper symbols when the caller is also changed or strongly referenced by planner hints.
   - Keep context caps strict and disclose truncation through existing degraded-context telemetry.

5. Keep grouping conservative.
   - Only adjust same-file packet coalescing when relationship edges are strong and size caps allow it.
   - Do not introduce cross-file packets.
   - Ensure coverage accounting still reports every changed hunk exactly once.

6. Update Stage 7 prompt rendering.
   - Render packet notes and related changed context clearly.
   - Avoid category lists.
   - Tell the reviewer to use related context before submitting no findings.

7. Update docs.
   - `README.md`
   - `specs/projects/codeninja/functional_spec.md`
   - `specs/projects/codeninja/architecture.md`
   - `specs/projects/codeninja/components/review_pipeline.md`
   - `specs/projects/codeninja/components/context_and_tools.md` if the relationship graph lives near tool/index code.

8. Update tests.
   - Planner schema rejects or ignores standalone review emphasis in new outputs.
   - Coverage focus notes are attached to packets.
   - Legacy review emphasis is ignored by packet prompts.
   - Changed helper packet receives a changed caller context when a caller relationship exists.
   - Changed caller packet can receive changed helper context when a changed helper relationship exists.
   - Related context is capped and does not create cross-file packets.
   - Stage 7 prompt includes related changed context and packet notes.

## Validation

Automated checks:

```sh
pnpm exec vitest run tests/pipeline-phase5.test.ts
pnpm exec vitest run tests/pipeline-phase6.test.ts
pnpm exec vitest run tests/pipeline-phase7.test.ts
pnpm run typecheck
pnpm test
pnpm run build
```

Eval checks after implementation:

```sh
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/49f4645b --no-cache
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/0c4d5213 --no-cache
```

Expected diagnostic improvements:

- Packets no longer have empty attention notes when the planner gave relevant hunk-scoped coverage reasons.
- Changed helper packets include bounded related changed caller context when available.
- Stage 7 no-finding decisions for helper packets are based on helper plus related changed context, not helper-local context only.
- Stage 8 remains narrow and is not triggered by planner output alone.
- Stage 9 verifier standards remain unchanged.

Issue 67 alone is not expected to fix every run-13 miss. It should make the context path correct and observable. Issue 68 handles the separate downstream case where a concrete correctness predicate is promoted or suppressed under the wrong frame.

## Stop Conditions

Stop and reconsider if implementation causes any of these:

- Stage 5 starts emitting questions or proof obligations again.
- Packet notes become broad global prose rather than hunk-scoped context.
- The relationship graph becomes a semantic risk classifier.
- Cross-file packets are introduced.
- Packet prompt sizes grow materially without improving Stage 7 candidate quality.
- Verifier rejection rates spike because Stage 7 emits broad speculative candidates.
- Eval improvements only appear on one target repo while general unit fixtures show unclear behavior.
