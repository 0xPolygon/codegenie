# Issue 55: Treat Documentation Hunks as Intent Context

Status: PENDING
Planned from: trails-api eval runs `49f4645b/logs/1` and `49f4645b/logs/9`, 2026-06-17
Recommended priority: medium-high, because documentation packets are now creating noisy unresolved notes and should be converted into bounded intent context

## Problem

The final review report currently says:

```text
Reviewed 9/10 hunks.
Incomplete work: skipped 1.
Coverage levels: deep 8, normal 1, light 0, skip 1.
```

In run `49f4645b/logs/1`, the skipped hunk was:

```text
docs/postmortems/hyperlane-collateral-decimal-mismatch-2026-06-16.md
```

The planner skipped it because it was a pure documentation/postmortem hunk with no executable behavior.

That skip was not a pipeline failure, but the report makes it look like incomplete work. More importantly, documentation, postmortems, specs, ADRs, and task notes can be important review evidence. If changed docs claim a bug is fixed, but the code does not match that claim, that mismatch should be reviewed and may deserve a finding.

The current model needs a clearer distinction:

- executable/code hunks are review targets,
- documentation/spec hunks can be intent context,
- documentation/spec hunks can still produce findings when they contradict code or describe behavior the code does not implement,
- intentionally context-only docs should not be reported as incomplete work.

## Goal

Make codegenie handle changed documentation as review context instead of simple skipped work.

The desired output shape is:

```text
Reviewed 9/9 code hunks.
Used 1 documentation hunk as intent context.
Coverage levels: deep 8, normal 1, light 0, skip 0.
```

For documentation/spec mismatches, codegenie should still be able to publish a real finding, usually anchored to the changed code line that fails to implement the documented intent, or summary-only if no changed code anchor is appropriate.

## Non-Goals

- Do not review documentation for prose style, grammar, formatting, or wording nits.
- Do not create a new full LLM stage just for docs.
- Do not run all docs through Stage 7 as independent packets by default.
- Do not make Trails-specific or Hyperlane-specific rules.
- Do not turn every changed markdown file into a high-priority review item.
- Do not suppress docs entirely when they are relevant to changed executable code.

## Current Evidence

Run `49f4645b/logs/1` shows the issue clearly:

- The PR changed a Hyperlane postmortem plus Hyperlane code.
- The postmortem was skipped as an independent hunk.
- The final finding was exactly the kind of issue where postmortem/spec intent matters: the code may not fully satisfy the documented cross-decimal/exact-output behavior.
- The final report marked the documentation skip as `Incomplete work`, even though the review was complete for executable code.

Run `49f4645b/logs/9` shows the opposite failure mode:

- The same postmortem became a standalone light Stage 7 review packet.
- Code review questions were attached to that documentation packet even though the packet had no source tools and no executable code.
- The packet produced partial answers and human-attention notes saying the Go implementation was not visible from the doc packet.
- Stage 8 later resolved the related code question as no issue, but the final report still emitted a stale human-attention note from the documentation packet.

So this is no longer just coverage wording. Documentation/spec/postmortem changes should be useful intent context for code packets, not standalone Stage 7 work by default.

## Design

Add an explicit review disposition beside the existing file filtering and packet coverage concepts:

```ts
type ReviewDisposition =
  | "review_target"
  | "context_only"
  | "skip";

type FileRole =
  | "source"
  | "test"
  | "documentation"
  | "spec"
  | "postmortem"
  | "adr"
  | "unknown";
```

Do **not** add `context_only` to `CoverageLevel`. In the current code, `CoverageLevel` (`deep` / `normal` / `light` / `skip`) drives Stage 7 packet depth, review scheduling, and tool budgets. Context-only documentation should not become a Stage 7 packet coverage mode.

Instead:

- `review_target` hunks are eligible for Stage 7 packets and keep using `CoverageLevel`.
- `context_only` hunks are kept as bounded intent context and can be attached to review-target packets.
- `skip` remains for artifacts that should not affect review at all.

Use `context_only` for changed artifacts that are not direct code review targets but should inform code review:

- postmortems,
- architecture docs,
- functional specs,
- ADRs,
- migration notes,
- task/issue docs,
- generated release notes only if they describe changed behavior.

Use `skip` only for artifacts that should not affect review:

- lockfiles,
- vendored/generated files,
- binary-ish artifacts,
- documentation explicitly ignored by config.

For the first pass, do not try to semantically decide whether a doc is "unrelated" by keyword. A doc-like hunk can be context-only and simply attach to no packets if no safe relationship is found. That is still complete work, not a failed review.

This should not require a new LLM stage or a broad Stage 7/9 loop rewrite.

## Stage Guidance

### Stage 2/3: Classification

Classify documentation-like files separately from skipped files, while keeping hard skips for generated/lockfile/vendor/binary/configured-ignore behavior.

Add deterministic facts on `FileFacts` such as:

- `fileRole: "documentation" | "spec" | "postmortem" | ...`
- `reviewDisposition: "context_only"` for docs that should feed intent,
- `reviewDispositionReason`.

Keep this conservative and generic. Path and extension are enough for the first version:

- `*.md`, `*.mdx`, `docs/**`, `specs/**`, `architecture/**`, `adr/**`, `postmortems/**`, `rfcs/**`.

Do not use keyword risk classification to invent domain-specific risk.

Keep current `FileFilterDecision` behavior narrow:

- generated/lockfile/vendor/binary/configured skips still return `action: "skip"`;
- doc-like files normally remain in the kept diff so their hunks can be represented as context-only;
- docs explicitly ignored by config remain skipped.

### Stage 5: Planner

Include changed documentation/spec/postmortem excerpts in the planner dossier as intent context, but do not require the planner to emit normal `coverage` entries for those context-only hunk IDs.

Recommended shape:

```ts
type PlannerIntentContextEntry = {
  path: string;
  oldPath?: string;
  fileRole: FileRole;
  hunkIds: string[];
  changedNewLineNumbers: number[];
  changedOldLineNumbers: number[];
  excerpt: string;
  headings?: string[];
};
```

Add these to the dossier beside `files`, for example `intentContext`, while keeping `files` focused on review-target hunks. If keeping context-only hunks inside `files` is simpler, then `validatePlan()` must ignore/strip planner `coverage` entries for those hunk IDs and must not turn missing context-only coverage into degraded review work.

The planner should use them to answer:

- What does the PR claim to fix or preserve?
- Does the PR title/body understate a behavior change?
- Which changed code hunks should receive this context?
- Are there code-vs-doc/spec consistency risks?

Planner output should be able to refer to doc context in risk areas, for example:

```text
The postmortem describes a cross-decimal collateral mismatch; review Hyperlane GetQuote/processQuote against that described failure mode.
```

The planner prompt should state that context-only docs are evidence for routing/focus, not review targets. The planner should not create standalone coverage packets for them.

For docs-only diffs with no executable review targets, the deterministic/fallback plan should produce zero review-target packets and coverage should report a complete context-only run rather than partial review.

### Stage 6: Packet Builder

Attach relevant doc/spec excerpts to nearby code packets as intent context.

Keep this bounded and simple:

- same directory or subsystem path is a strong match,
- shared changed file prefix is a strong match,
- shared changed symbols or exact path mentions are a strong match,
- do not attach every doc to every packet.

Prefer reusing the existing `ReviewPacket.relatedChangedContext` side channel, because it is already rendered into Stage 7 prompts and already has `sourceKind: "docs"`.

Add or refine fields as needed, for example:

```ts
type RelatedChangedContext = {
  ...
  sourceKind?: "source" | "test" | "docs" | "unknown";
  relationshipSource?: "same_symbol" | "symbol_mention" | "planner_hint" | "intent_context";
  sourceSnippet?: string;
  patchExcerpt?: string;
}
```

The excerpt should be small. Prefer headings, nearby changed lines, and lines mentioning changed symbols/files. Avoid dumping full documents unless they are tiny.

Do not attach review questions directly to context-only documentation packets in normal operation. Instead, attach the documentation excerpt to the code packet that can answer the question.

Context-only hunks must not create `ReviewPacket`s by default. This removes the run-9 failure mode where a doc packet had no source tools and produced stale human-attention notes.

### Stage 7: Packet Review

Update packet-review instructions:

- If intent context is attached, check whether the changed code matches that documented intent.
- Treat code-vs-doc/spec mismatch as a correctness/design issue when it changes behavior or misleads maintainers.
- Do not comment on wording/style unless it hides a real risk.
- Prefer anchoring findings to changed code lines that violate the documented intent.
- Use summary-only findings if the mismatch is real but cannot be anchored to a changed line.

Do not make context-only docs independent comments unless the changed doc itself is dangerously wrong or misleading.

If a finding depends on documentation/spec context, Stage 7 should still provide changed-code evidence in `evidence.changedCode` whenever possible, and should put the doc/spec excerpt in related evidence or intent evidence rather than treating the doc excerpt as proof.

### Stage 9: Verification

Verifier should treat attached documentation/spec context as evidence, not proof.

It should keep findings only when:

- changed code contradicts a concrete documented claim,
- changed code fails to implement a documented/spec behavior,
- changed documentation claims a safety property that source inspection disproves,
- the mismatch has developer-impacting consequences.

It should reject:

- subjective prose disagreements,
- missing doc updates with no behavioral risk,
- speculative mismatch without source evidence.

### Stage 10: Coverage and Report

Separate review-target coverage from context-only accounting.

Recommended type changes:

```ts
type RunCoverageStatus = {
  totalHunks: number;          // all diff hunks, for artifact continuity
  reviewTargetHunks: number;   // hunks eligible for Stage 7 review packets
  reviewedHunks: number;       // reviewed review-target hunks
  contextOnlyHunks: number;
  skippedHunks: number;        // true skips only
  failedHunks: number;         // failed/incomplete review-target hunks only
  coverageByLevel: Record<CoverageLevel, number>; // review-target coverage only
  contextOnlyByRole?: Record<string, number>;
  ...
};
```

Also update `coverage.json` records so context-only hunks are explicit, for example:

```ts
status: "reviewed" | "context_only" | "skipped" | "review_failed" | "degraded"
```

Avoid saying `Incomplete work` for context-only docs.

Suggested report wording:

```text
Reviewed 9/9 code hunks.
Used 1 documentation hunk as intent context.
Coverage levels: deep 8, normal 1, light 0, skip 0.
```

The `context-only` count should be a separate line, not part of `coverageByLevel`, because `coverageByLevel` is tied to packet review depth.

Only show `Incomplete work` when there are actual failures:

- packet review failed,
- verification incomplete,
- budget stop,
- provider failure,
- required hunk not reviewed.

## Config Considerations

Add configuration only if needed after the first implementation.

Potential future config:

```toml
[review.docs]
intent_context = true
patterns = ["docs/**", "specs/**", "postmortems/**"]
```

For the first pass, prefer built-in conservative defaults plus existing ignore patterns.

## Likely Files

- `src/types.ts`
- `src/git/file-classifier.ts`
- `src/pipeline/planner.ts`
- `src/pipeline/packet-builder.ts`
- `src/pipeline/lens-runner.ts`
- `src/pipeline/verifier.ts`
- `src/pipeline/composer.ts`
- `src/pipeline/review-runner.ts`
- `src/skills/prompt-builder.ts`
- `src/util/coverage-summary.ts`
- `src/telemetry/run-artifacts.ts`
- `src/evals/eval-scoring.ts`
- `tests/file-classifier.test.ts`
- `tests/pipeline-phase5.test.ts`
- `tests/pipeline-phase6.test.ts`
- `tests/evals.test.ts`

## Plan

1. Add file role and review disposition metadata.
   - Add `fileRole`, `reviewDisposition`, and `reviewDispositionReason` to `FileFacts`.
   - Distinguish `review_target`, `context_only`, and `skip`.
   - Keep `CoverageLevel` unchanged; do not add `context_only` there.
   - Preserve current generated/lockfile skip behavior.
   - Classify docs/specs/postmortems as context-only unless explicitly skipped by config or an existing hard skip rule.

2. Split planner dossier review targets from intent context.
   - Include bounded excerpts and metadata.
   - Include path, doc role, changed lines/headings, and why it may matter.
   - Do not require normal planner `coverage` entries for context-only hunk IDs.
   - Make deterministic fallback plans cover only review-target hunks.
   - Keep planner prompt size bounded.

3. Attach relevant doc context to review-target packets.
   - Reuse `relatedChangedContext` with `sourceKind: "docs"` and `relationshipSource: "intent_context"` unless a new side-channel proves cleaner.
   - Match by path/subsystem first.
   - Match by explicit mentions second.
   - Cap excerpts per packet and total chars.
   - Store attached context in packet artifacts for debugging.
   - Do not build Stage 7 packets for context-only hunks by default.

4. Update Stage 7 prompt text.
   - Instruct reviewers to check code against attached intent/spec context.
   - Keep the correctness-first/no-style-nit posture.
   - Make clear that docs are evidence, not automatic findings.
   - Require code-backed evidence for doc/code mismatch findings where changed code is available.

5. Update verification guidance.
   - Keep findings only with concrete code evidence.
   - Reject pure wording disagreements.
   - Preserve high precision.

6. Update coverage artifacts and final report.
   - Add `reviewTargetHunks`, `contextOnlyHunks`, and optional role breakdowns.
   - Add a `context_only` coverage record status.
   - Render `Reviewed X/Y code hunks` using review-target counts.
   - Render context-only docs as a separate line.
   - Remove `Incomplete work: skipped N` for context-only docs.
   - Keep true incomplete/failure reporting unchanged.

7. Add tests.
   - Markdown-only hunk plus code hunk becomes context-only, not incomplete.
   - Context-only doc excerpt attaches to same-subsystem code packet.
   - A doc/code contradiction can become a candidate when anchored to changed code.
   - Pure unrelated docs do not force Stage 7 packets.
   - Docs-only PR produces zero review packets and complete context-only coverage, not partial review.
   - No human-attention notes can be produced from context-only docs because they are not normal packets.
   - Lock/generated files still skip as before.

8. Validate on the Hyperlane eval.
   - The postmortem hunk should appear as context-only.
   - Coverage should report complete executable review.
   - The final finding should still be found.
   - No new doc-style comments should appear.

## Acceptance Criteria

- Changed documentation/spec/postmortem hunks can be represented as context-only.
- Context-only docs do not become Stage 7 packets by default.
- Context-only hunks are not reported as incomplete work.
- Relevant doc/spec/postmortem excerpts can be attached to code packets.
- Stage 7 reviewers are prompted to compare changed code against attached intent context.
- Stage 9 verifier keeps only evidence-backed doc/code mismatch findings.
- The final report clearly distinguishes reviewed code, context-only docs, intentional skips, and actual incomplete work.
- Existing lockfile/generated-file skip behavior is unchanged.
- Docs-only diffs complete cleanly with zero review-target hunks and a context-only count.

## Validation

Run focused tests:

```text
pnpm exec vitest run tests/file-classifier.test.ts tests/pipeline-phase5.test.ts tests/pipeline-phase6.test.ts tests/evals.test.ts
```

Then run:

```text
pnpm test
pnpm run build
```

On the next eval, inspect:

- `coverage.json`,
- packet artifacts for attached docs context under `relatedChangedContext`,
- `final-review.md` coverage wording,
- Stage 7 candidate generation,
- Stage 9 verifier decisions.

## Stop Conditions

Stop and reassess if:

- documentation context causes broad speculative findings,
- planner prompt size grows substantially on doc-heavy PRs,
- context-only docs get attached to unrelated packets,
- style/prose nits start appearing by default,
- coverage reporting hides real failed or unreviewed code hunks,
- implementation requires a new LLM stage instead of small classification/context/reporting changes.
