# Issue 55: Treat Documentation Hunks as Intent Context

Status: PENDING
Planned from: trails-api eval run 49f4645b/logs/1, 2026-06-17
Recommended priority: small reporting/context correctness improvement after the current eval stabilization work

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

Make codeninja handle changed documentation as review context instead of simple skipped work.

The desired output shape is:

```text
Reviewed 9/9 code hunks.
Used 1 documentation hunk as intent context.
Coverage levels: deep 8, normal 1, context-only 1.
```

For documentation/spec mismatches, codeninja should still be able to publish a real finding, usually anchored to the changed code line that fails to implement the documented intent, or summary-only if no changed code anchor is appropriate.

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

This is not a core review-quality failure, but it is a product and telemetry clarity gap.

## Design

Add a third hunk disposition beside normal review and skip:

```ts
type HunkDisposition =
  | "review"
  | "context_only"
  | "skip"
```

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
- unrelated docs with no meaningful behavioral claims,
- documentation explicitly ignored by config.

This can be implemented without changing the main Stage 7/9 loop.

## Stage Guidance

### Stage 2/3: Classification

Classify documentation-like files separately from skipped files.

Add deterministic facts such as:

- `fileRole: "documentation" | "spec" | "postmortem" | ...`
- `reviewDisposition: "context_only"` for docs that should feed intent,
- `reviewDispositionReason`.

Keep this conservative and generic. Path and extension are enough for the first version:

- `*.md`, `*.mdx`, `docs/**`, `specs/**`, `architecture/**`, `adr/**`, `postmortems/**`, `rfcs/**`.

Do not use keyword risk classification to invent domain-specific risk.

### Stage 5: Planner

Include changed documentation/spec/postmortem excerpts in the planner dossier as intent context.

The planner should use them to answer:

- What does the PR claim to fix or preserve?
- Does the PR title/body understate a behavior change?
- Which changed code hunks should receive this context?
- Are there code-vs-doc/spec consistency risks?

Planner output should be able to refer to doc context in risk areas, for example:

```text
The postmortem describes a cross-decimal collateral mismatch; review Hyperlane GetQuote/processQuote against that described failure mode.
```

### Stage 6: Packet Builder

Attach relevant doc/spec excerpts to nearby code packets as intent context.

Keep this bounded and simple:

- same directory or subsystem path is a strong match,
- shared changed file prefix is a strong match,
- shared changed symbols or exact path mentions are a strong match,
- do not attach every doc to every packet.

Represent this explicitly, for example:

```ts
type ReviewPacketIntentContext = {
  source: "changed_doc" | "spec" | "postmortem" | "pr_body" | "commit_message"
  path?: string
  title?: string
  excerpt: string
  whyRelevant: string
}
```

The excerpt should be small. Prefer headings, nearby changed lines, and lines mentioning changed symbols/files. Avoid dumping full documents unless they are tiny.

### Stage 7: Packet Review

Update packet-review instructions:

- If intent context is attached, check whether the changed code matches that documented intent.
- Treat code-vs-doc/spec mismatch as a correctness/design issue when it changes behavior or misleads maintainers.
- Do not comment on wording/style unless it hides a real risk.
- Prefer anchoring findings to changed code lines that violate the documented intent.
- Use summary-only findings if the mismatch is real but cannot be anchored to a changed line.

Do not make context-only docs independent comments unless the changed doc itself is dangerously wrong or misleading.

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

Separate coverage accounting:

- reviewed code hunks,
- context-only hunks,
- intentionally skipped hunks,
- failed/incomplete hunks.

Avoid saying `Incomplete work` for context-only docs.

Suggested report wording:

```text
Reviewed 9/9 code hunks.
Used 1 documentation hunk as intent context.
Coverage levels: deep 8, normal 1, context-only 1.
```

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
- `src/pipeline/file-classifier.ts`
- `src/pipeline/planner-dossier.ts`
- `src/pipeline/packet-builder.ts`
- `src/pipeline/lens-runner.ts`
- `src/pipeline/verifier.ts`
- `src/pipeline/composer.ts`
- `src/telemetry/run-artifacts.ts`
- `src/evals/eval-scoring.ts`
- `tests/*classification*`
- `tests/*planner*`
- `tests/*packet*`
- `tests/*coverage*`
- `tests/*composer*`

## Plan

1. Add a hunk/file disposition model.
   - Distinguish `review`, `context_only`, and `skip`.
   - Preserve current generated/lockfile skip behavior.
   - Classify docs/specs/postmortems as context-only when they are changed alongside executable code.

2. Feed context-only docs into planner input.
   - Include bounded excerpts and metadata.
   - Include path, doc role, changed lines/headings, and why it may matter.
   - Keep planner prompt size bounded.

3. Attach relevant doc context to packets.
   - Match by path/subsystem first.
   - Match by explicit mentions second.
   - Cap excerpts per packet and total chars.
   - Store attached context in packet artifacts for debugging.

4. Update Stage 7 prompt text.
   - Instruct reviewers to check code against attached intent/spec context.
   - Keep the correctness-first/no-style-nit posture.
   - Make clear that docs are evidence, not automatic findings.

5. Update verification guidance.
   - Keep findings only with concrete code evidence.
   - Reject pure wording disagreements.
   - Preserve high precision.

6. Update coverage artifacts and final report.
   - Add context-only counts.
   - Remove `Incomplete work: skipped N` for context-only docs.
   - Keep true incomplete/failure reporting unchanged.

7. Add tests.
   - Markdown-only hunk plus code hunk becomes context-only, not incomplete.
   - Context-only doc excerpt attaches to same-subsystem code packet.
   - A doc/code contradiction can become a candidate when anchored to changed code.
   - Pure unrelated docs do not force Stage 7 packets.
   - Lock/generated files still skip as before.

8. Validate on the Hyperlane eval.
   - The postmortem hunk should appear as context-only.
   - Coverage should report complete executable review.
   - The final finding should still be found.
   - No new doc-style comments should appear.

## Acceptance Criteria

- Changed documentation/spec/postmortem hunks can be represented as context-only.
- Context-only hunks are not reported as incomplete work.
- Relevant doc/spec/postmortem excerpts can be attached to code packets.
- Stage 7 reviewers are prompted to compare changed code against attached intent context.
- Stage 9 verifier keeps only evidence-backed doc/code mismatch findings.
- The final report clearly distinguishes reviewed code, context-only docs, intentional skips, and actual incomplete work.
- Existing lockfile/generated-file skip behavior is unchanged.

## Validation

Run focused tests:

```text
pnpm exec vitest run tests/*classification*.test.ts tests/*planner*.test.ts tests/*packet*.test.ts tests/*coverage*.test.ts tests/*composer*.test.ts
```

Then run:

```text
pnpm test
pnpm run build
```

On the next eval, inspect:

- `coverage.json`,
- packet artifacts for attached intent context,
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
