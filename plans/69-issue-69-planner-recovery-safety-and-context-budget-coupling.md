# Issue 69: Planner Recovery Safety and Context-Budget Coupling

Status: PENDING
Planned from: trails-api eval `49f4645b/logs/14` compared with `49f4645b/logs/1` and `49f4645b/logs/13`, 2026-06-19
Recommended priority: high, because run 14 showed two related failure modes: context-rich packets did not receive enough local review capacity, and a degraded Stage 5 recovery path silently collapsed production coverage to normal.

Implementation priority:

1. Budget-couple packets that receive strong related changed context.
2. Dedupe related changed context before prompt assembly.
3. Add sparse recovered-plan detection and bounded safety coverage as a recovery net.
4. Keep misplaced root planner fields as diagnostics unless relocation is trivial.

## Problem

Run 14 failed for a different reason than the earlier runs.

Issues 67 and 68 both showed useful progress:

- Stage 6 built a hunk relationship graph and attached the important related changed context: `GetQuote`, `scaleAmount`, and `processQuote` were connected.
- Stage 9 promotion classified the surviving follow-up as `correctness`, not `testing`.
- Refactor-like intent was treated as context, not as proof against the finding.

But Stage 5 degraded:

```text
submit_plan #1: {}
submit_plan repair: diffUnderstanding + one docs coverage entry + root-level focusNotes
deterministic recovery: strips invalid root focusNotes and accepts the sparse plan
coverage result: deep 0, normal 9, light 1
```

That made all production hunks fall back to deterministic `normal` coverage. Runs 1 and 13 both had `deep 8`; run 14 had `deep 0`.

This is not a valid planner decision. It is a damaged planner recovery path being treated as a normal lightweight plan.

The damage propagated:

```text
Stage 5 accepts sparse recovered plan
  -> Stage 6 attaches correct related context, but code packets stay normal coverage
  -> context-rich packets have more to inspect without deeper budget
  -> Stage 7 sees truncation but under-frames it as a low-confidence follow-up
  -> Stage 9 verifies the incomplete transferAmount-only claim and rejects it as dust
  -> Stage 10 has no finding
```

Run 14 also showed one Stage 6 efficiency issue: related changed context can be duplicated by symbol. For example, `GetQuote` and `processQuote` were attached multiple times to the same packet through different target hunks. This wastes packet context and can dilute reviewer attention.

There is also a symptom-vs-cause distinction:

- This plan should make degraded planner output safe.
- It should not hide the fact that Stage 5 produced an empty submit and then misplaced fields during repair.
- Telemetry must make empty submits, schema repairs, stripped root keys, sparse recovered plans, and safety coverage visible so we can decide later whether the Stage 5 prompt/schema contract itself should be simplified.

## Goal

Make planner recovery safe, and make Stage 6 context attachment increase useful review capacity instead of just adding more text.

The desired behavior:

```text
If Stage 5 succeeds normally:
  - omitted reviewable hunks still default to normal coverage
  - planner coverage decisions remain advisory scheduling, not proof obligations

If Stage 5 uses schema repair or deterministic recovery:
  - suspiciously sparse coverage is treated as degraded planning
  - omitted source-code hunks are not assumed intentionally normal
  - deterministic safety coverage restores enough deep/investigate review for behavior-bearing code

If Stage 6 attaches strong related changed context:
  - the packet receives enough local budget to inspect that context
  - duplicate related symbol bodies are collapsed before prompt assembly
```

The fix should preserve the current architecture:

- Stage 5 remains a lightweight scout.
- Stage 6 remains deterministic packet construction.
- Stage 7 remains the main issue-finding stage.
- Stage 9 remains strict verification.

## Non-Goals

- Do not reintroduce planner review questions.
- Do not reintroduce obligations or risk-area accounting.
- Do not add a fixed risk taxonomy.
- Do not encode trails-api, Hyperlane, decimals, tokens, exact-output, or any target-repo concept.
- Do not make Stage 5 multi-pass by default.
- Do not loosen verifier standards.
- Do not force all PRs to deep review.
- Do not use docs/postmortems alone to force code findings.

## Design

### 1. Context-Rich Packet Budget Coupling

This is the first implementation slice and the broadest win. It helps clean planner runs and recovered planner runs.

When Stage 6 attaches strong related changed context, the packet has more evidence to inspect. The local budget should reflect that.

Define strong related changed context structurally:

- the related context is source-code context, not docs-only or test-only context;
- the related context comes from another changed hunk;
- the related symbol/body is different from the packet's primary symbol body;
- the relationship is based on a direct changed-symbol relationship, such as a symbol mention/call-site style edge, or an explicit related-symbol planner hint that resolves to a changed code symbol;
- nearby-hunk adjacency alone is not enough to count as strong.

Add a generic budget/profile nudge:

```text
if relatedChangedContext contains strong code-symbol context:
  reviewProfile is at least investigate
  tool budget uses investigate-level limits even if nominal coverage is normal
```

If the packet is already deep, do not change it. If the packet is light or skipped, do not promote it unless existing skip rules already allow review.

Telemetry should record:

- `related_context_budget_nudged`
- number of packets nudged
- ratio of packets nudged
- source relationship kinds that caused the nudge

This should be bounded. Do not make every relationship edge deep. The goal is to avoid the run-14 failure mode where Stage 6 gave the reviewer the right related code, but Stage 7 lacked enough budget to inspect and synthesize it.

### 2. Related Changed Context Dedupe

Before attaching `relatedChangedContext` to a packet, dedupe by semantic identity:

```text
path + symbol + lineRange + source side
```

When multiple relationship edges point to the same symbol body:

- keep one source snippet;
- merge target hunk IDs into metadata if useful;
- keep the strongest edge reason, or concatenate short distinct reasons up to the existing cap;
- preserve patch excerpts only when they add distinct changed lines.

This reduces packet size and attention dilution without removing useful context. It also makes the budget nudge in section 1 more effective because reviewers spend less of the restored budget rereading duplicate symbol bodies.

### 3. Sparse Recovered Planner Guard

Planner output should carry recovery metadata through normalization:

```ts
type PlannerRecoveryState = {
  usedSchemaRepair: boolean
  usedDeterministicRecovery: boolean
  strippedRootKeys: string[]
  recoveredSubmitWasSparse: boolean
  degraded: boolean
  reason?: string
}
```

Exact type names can differ. The important requirement is that `runPlanner` and downstream packet construction know whether the plan came from a clean submit or from a recovered/degraded submit.

This should extend the existing degraded-planning state. Do not create a second parallel concept that downstream stages need to interpret separately.

Treat a recovered plan as suspiciously sparse when these structural conditions are true:

- the planner used schema repair or deterministic recovery;
- the diff has multiple reviewable source-code hunks;
- the recovered plan has no explicit coverage entries for source-code hunks, or covers only a small fraction of reviewable source-code hunks.

Use deterministic hunk/file facts, language, file role, changed symbols, and whether the recovered plan was repaired. Do not inspect planner prose or use domain keywords to decide this.

The v1 threshold should be conservative and simple:

```text
reviewable source hunks >= 3
and explicit source-code coverage entries == 0
```

Optionally add the ratio rule only if tests show it is needed:

```text
reviewable source hunks >= 5
and explicit source-code coverage entries / reviewable source hunks < 0.25
```

When this guard trips:

- emit telemetry `planner_recovered_sparse_plan`;
- mark planning as degraded for coverage reporting;
- apply deterministic safety coverage to reviewable source-code hunks.

### 4. Misplaced Root Planner Fields

If repaired planner output contains root-level fields intended for coverage decisions, such as:

- `focusNotes`
- `relatedSymbols`
- `relatedFiles`
- `surroundingContextHints`

do not silently strip them and proceed as if the plan is clean.

Keep v1 simple:

- record the misplaced root keys in planner recovery diagnostics;
- keep them out of packet prompts unless there is exactly one unambiguous coverage target;
- if there is no unambiguous target, treat the repaired plan as suspect for sparse-plan detection.

Do not build a complex relocation system in this plan. The recall driver in run 14 was sparse coverage, not the lost root `focusNotes` content.

### 5. Deterministic Safety Coverage

When planner recovery is degraded, Stage 6 should not let all omitted source-code hunks fall back to ordinary `normal`.

Apply deterministic safety coverage using existing facts:

- docs, markdown, generated files, lockfiles, and skipped files remain light/skip according to existing rules;
- test-only packets can remain normal unless they are the only changed executable surface;
- source-code hunks with changed symbols become at least `deep` for small/medium PRs;
- for larger PRs, choose bounded deep coverage for central code packets and normal/investigate for the rest.

The v1 rule can be intentionally simple:

```text
If degraded planner recovery and reviewable source-code hunk count <= 20:
  set source-code packets with changed symbols to deep
  keep tests normal
  keep docs light
```

For larger diffs, avoid exploding cost:

```text
If degraded planner recovery and reviewable source-code hunk count > 20:
  set source-code hunks in files with exported/public symbols, high review priority, or many changed hunks to deep up to a cap
  set remaining source-code hunks to normal with investigate profile when related context exists
```

Use existing `reviewPriority`, file facts, changed symbols, static signals, and packet grouping. Do not add a domain taxonomy.

Telemetry should make the fallback obvious:

- `planner_degraded_safety_coverage_applied`
- number of hunks upgraded
- number of packets upgraded
- reason
- recovered coverage entry count
- reviewable source hunk count
- empty-submit and schema-repair frequency for Stage 5

The final report should continue to say review completeness is complete if all hunks were reviewed. The planner degradation is a debug/telemetry signal, not necessarily a user-facing partial-review state.

### 6. Stage 7 Prompt Guardrail

Keep this small. Do not add a domain-specific invariant list.

Add a generic instruction near the existing related-context guidance:

```text
When relatedChangedContext is attached, inspect it as part of the changed behavior path. If a local helper looks correct by itself, check whether the attached caller/callee/output context changes the observable contract before concluding no findings.
```

This reinforces the architecture without creating a new taxonomy.

## Implementation Steps

1. Implement context-rich packet budget coupling.
   - Detect strong related changed context structurally.
   - Ensure affected normal packets get investigate-level budget/profile.
   - Emit budget-nudge telemetry with counts and ratio.
   - Add tests for context-rich normal packets receiving the nudge without promoting unrelated nearby/test/doc context.

2. Dedupe related changed context.
   - Dedupe before packet assembly.
   - Add tests where multiple hunk edges point to the same symbol body and only one related context entry is attached.

3. Inspect planner recovery code.
   - Find where schema repair results are recovered.
   - Find where invalid root keys are stripped.
   - Add recovery metadata for repaired/recovered planner output using the existing degraded-planning mechanism where possible.

4. Add sparse-plan detection.
   - Count reviewable source-code hunks from the planner dossier or filtered diff.
   - Count explicit source-code coverage decisions after repair/recovery.
   - Emit telemetry when a recovered plan is suspiciously sparse.

5. Handle misplaced root planner fields as diagnostics.
   - Record misplaced root `focusNotes`, `relatedSymbols`, `relatedFiles`, and optionally `surroundingContextHints`.
   - Relocate only if there is exactly one unambiguous coverage target.
   - Otherwise preserve diagnostics and trigger degraded planning when sparse.
   - Add tests for no-unsafe-global propagation.

6. Implement deterministic safety coverage.
   - Apply only when planner recovery is degraded.
   - Use existing file facts and changed symbols.
   - Keep docs/test/default behavior bounded.
   - Add tests where a multi-hunk source diff with recovered sparse plan gets source-code hunks upgraded.

7. Update Stage 7 prompt text minimally.
   - Reinforce related context inspection.
   - Do not add domain examples or fixed risk categories.
   - Bump the Stage 7 prompt version.

8. Update telemetry/docs.
   - Record sparse-plan fallback metrics in run artifacts.
   - Mention planner degraded safety coverage in functional spec/architecture if behavior is externally relevant.

## Validation

Unit tests:

```bash
pnpm exec vitest run tests/pipeline-phase5.test.ts tests/pipeline-phase6.test.ts tests/verifier.test.ts
pnpm test
```

Static checks:

```bash
pnpm run typecheck
pnpm run build
git diff --check
```

Eval validation:

```bash
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/49f4645b --no-cache
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/0c4d5213 --no-cache
```

Suggested sequencing for eval validation:

1. After implementing sections 1 and 2, run `49f4645b` at least once to see whether budget coupling and dedupe are sufficient.
2. After implementing sections 3-5, run `49f4645b` again and confirm any sparse planner recovery is visible in telemetry.
3. If Stage 5 empty-submit or sparse-recovery frequency is non-trivial across repeated runs, open a separate follow-up to simplify the Stage 5 prompt/schema contract instead of only relying on safety coverage.

Expected diagnostic improvements for `49f4645b`:

- Normal packets with strong related changed context should receive investigate-level budget.
- `hunk-relationships.json` should show fewer duplicate attached contexts for the same symbol body.
- Stage 5 should not produce `deep 0` after planner schema repair on this multi-hunk source-code diff once the safety net triggers.
- If planner repair is sparse, telemetry should show `planner_recovered_sparse_plan` and `planner_degraded_safety_coverage_applied`.
- Code packets with related changed context should retain enough budget to inspect related symbols.
- Stage 7 should either produce a direct candidate or a pointer-rich follow-up containing both sides of a cross-symbol claim when the evidence is present.

Success does not require forcing a specific finding. It requires that degraded planner recovery no longer silently downgrates behavior-bearing code to cheap review, and that related context is both compact and inspectable.

## Stop Conditions

Do not proceed if the implementation:

- makes every repaired planner plan deep by default;
- introduces fixed domain/risk categories;
- reintroduces planner questions or obligations;
- increases large-PR cost without a cap;
- suppresses legitimate planner omissions in clean, non-repaired plans;
- loosens Stage 9 verification to keep incomplete claims.
