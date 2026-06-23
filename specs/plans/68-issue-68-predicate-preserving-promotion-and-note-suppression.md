# Issue 68: Predicate-Preserving Promotion and Note Suppression

Status: COMPLETE
Planned from: trails-api eval `49f4645b/logs/13` review, 2026-06-18
Recommended priority: high after Issue 67, because Issue 67 fixes upstream context but run 13 also exposed downstream misrouting of a concrete concern

## Problem

Issue 67 fixes the Stage 5 to Stage 6 to Stage 7 context path. It does not address a separate downstream failure from run 13.

A useful Stage 7 follow-up hint contained a concrete runtime predicate: a changed value transformation could make downstream observable behavior violate a caller-visible contract. But because the hint was phrased as a test-coverage question, uncertainty promotion converted it into a testing candidate. Stage 9 then verified the wrong claim:

```text
real predicate: changed runtime value may violate an observable caller contract
promoted frame: changed tests may no longer cover the production path
verifier result: rejects coverage framing and dismisses the runtime concern
```

That is not a verifier-quality problem. The verifier stayed strict. The failure is that the handoff asked the verifier to adjudicate the wrong thing.

The current implementation has a concrete precedence bug in `src/pipeline/uncertainty-promotion.ts`:

```text
riskProfile(source)
  security predicate      -> security
  testScoped && testRisk  -> testing
  correctnessRisk         -> correctness
  testRisk                -> testing
```

For the run-13 case, the useful runtime predicate was already preserved in `source.reason`, but the source also touched a test file and the question used coverage wording. `testScoped && testRisk` therefore won before the runtime/correctness predicate could be considered. The minimal fix is to make a concrete production/runtime predicate win over test-scoping. True coverage-only hints should still promote as testing or remain human-attention-only.

Run 13 also showed two smaller downstream issues:

- `refactorLike` intent metadata was used as support for rejecting a behavior concern, even though behavior-bearing hunks were present.
- A rejected candidate could suppress a human-attention note with weak file-only overlap, hiding a stronger unresolved breadcrumb.

## Goal

Preserve the actual failure predicate from Stage 7 into Stage 9 and Stage 10:

```text
Stage 7 hint/uncertainty
  -> preserve concrete predicate and evidence
  -> promote under the predicate's failure mode, not the question phrasing
  -> verifier adjudicates the real runtime/design/testing claim
  -> rejected candidates suppress notes only on strong overlap
```

Keep the existing architecture: Stage 7 generates liberally, Stage 9 verifies strictly, Stage 10 composes conservatively.

Success means the verifier receives and adjudicates the real predicate. It does not mean the verifier must keep the candidate. If the verifier rejects because the predicate is unproven, contradicted, immaterial, or outside the diff, that is still valid. If later evals show that a tiny-but-real caller-visible contract violation should clear the reporting bar, that is a separate severity/materiality calibration, not part of this routing fix.

## Non-Goals

- Do not loosen verifier standards.
- Do not publish low-confidence findings broadly.
- Do not add a fixed risk taxonomy.
- Do not encode repo-specific or language-specific cases.
- Do not reintroduce planner questions or proof obligations.
- Do not make Stage 8 run from planner output.

## Design

### Predicate-Preserving Promotion

When promoting a Stage 7 uncertainty or follow-up hint into a verification candidate, classify and title the candidate from the concrete failure predicate, not from the leading wording of the question.

Examples of generic distinction:

- If the predicate is "changed runtime value may violate an observable contract", promote as correctness/logic/design depending on the existing category mapping.
- If the predicate is "the change removed direct coverage for a still-live production boundary", promote as testing.
- If the predicate is only "please check whether tests cover this", and no runtime/design predicate is present, keep it as testing or human-attention only.

This should be implemented with general prompt/schema guidance and deterministic field preservation, not by adding domain keywords.

Preferred promoted candidate fields:

```ts
type PromotedCandidateInput = {
  originalQuestion?: string;
  concretePredicate?: string;
  whyItMightFail?: string;
  evidenceSummary?: string;
  relevantFiles: string[];
  relevantSymbols: string[];
  sourceKind: "uncertainty" | "follow_up_hint";
};
```

Exact names can differ. The important contract is that the specific suspected failure mode survives the handoff.

Current code may not need new model-facing fields for the first fix because the predicate is already present in the source reason. New fields are acceptable only if they make the handoff clearer without expanding prompt size or adding a taxonomy. The first implementation should fix classification precedence even if no new fields are added.

### Promotion Precedence

Update `riskProfile` so test-scoping cannot mask a concrete runtime/design/correctness predicate.

Required behavior:

- Security still wins first when the predicate is security-sensitive.
- A concrete production/runtime/design/correctness predicate wins over `testScoped && testRisk`.
- `testScoped && testRisk` remains testing only when no concrete runtime/design/correctness predicate is present.
- Pure coverage/test questions remain testing or human-attention-only.

This should reuse the existing category enum and existing predicate helpers where possible. Do not add eval-specific words or a new risk taxonomy.

### Stage 9 Verification Framing

Verifier prompts should explicitly say:

```text
If a promoted candidate came from a question or hint, verify the concrete failure predicate, not just the wording of the original question.

Do not reject a runtime/design predicate solely because a related testing question was poorly framed. You may still reject when the predicate is unproven, contradicted by source, immaterial, or outside the diff.
```

This keeps verification strict while preventing wrong-frame rejections.

### Refactor Intent Is Neutral

`intentSignals.refactorLike` should be treated as review framing only. It may influence tone, for example "confirm intentional behavior change", but it must not be evidence against a correctness/security/design finding.

If behavior-bearing hunks exist, the verifier must adjudicate the code behavior directly.

This is a general principle, not a category list for review. The implementation can word it as:

```text
Commit title/body intent is context, not proof. Source behavior and changed diff evidence control the verdict.
```

### Human-Attention Note Suppression

Tighten Stage 10 note suppression so rejected candidates do not hide unrelated unresolved notes.

A rejected candidate may suppress a note only when overlap is strong:

- same file plus shared changed line or same enclosing symbol; or
- same concrete predicate/failure mode by high normalized text similarity; or
- explicit shared candidate/note provenance.

Do not suppress based on same file plus weak similarity alone.

If overlap is weak and the note remains unresolved, keep it eligible for human-attention output subject to the existing caps.

For promoted hints, provenance should be the strongest signal: if a human-attention note is the same source that became a promoted candidate, a verifier rejection may suppress that exact note through candidate/note provenance. It should not suppress unrelated notes through weak same-file overlap.

### Ownership With Issue 67

Issue 67 owns packet context: Stage 5 coverage fields, Stage 6 relationship graph, `attentionNotes`, and `relatedChangedContext`.

Issue 68 owns the downstream handoff: Stage 7 hint/uncertainty promotion, Stage 9 verifier framing, and Stage 10 human-attention suppression. If both plans touch Stage 7 prompt templates, bump the template version once after applying both sets of prompt changes so one change does not hide the other.

## Implementation Steps

1. Inspect current uncertainty/follow-up promotion code.
   - Identify where category/title/failure mode are derived.
   - Identify whether the original hint predicate/reason is preserved.

2. Preserve predicate fields through promotion.
   - Add or reuse fields for concrete predicate, why it might fail, and evidence summary.
   - Cap strings so Stage 9 prompts stay bounded.
   - Keep source provenance for debug artifacts.

3. Update promotion classification.
   - Fix the `riskProfile` precedence bug: do not let `testScoped && testRisk` short-circuit a concrete runtime/design/correctness predicate.
   - Prefer explicit concrete predicate/failure mode over question phrasing.
   - Keep testing classification for true coverage-only concerns.
   - Avoid keyword taxonomies; use existing category enums only as final output categories.

4. Update verifier prompt/rendering.
   - Instruct verifier to adjudicate the concrete predicate.
   - Treat refactor-like intent as neutral context, not rejection evidence.
   - Keep existing evidence and changed-line requirements.

5. Tighten Stage 10 note suppression.
   - Require stronger overlap for rejected candidates to suppress unresolved notes.
   - Treat explicit promoted-source provenance as strong overlap for the exact promoted note.
   - Do not let weak same-file overlap with a different rejected candidate suppress a note.
   - Add telemetry for suppression reason: strong-overlap, weak-overlap-kept, suppressed-by-published-finding, capped.

6. Update tests.
   - A hint phrased as a test question but carrying a runtime predicate promotes under the runtime predicate.
   - A true coverage-only hint remains testing.
   - `refactorLike` does not cause verifier rejection when code evidence supports a behavior concern.
   - A rejected candidate with only same-file weak overlap does not suppress an unrelated note.
   - Published findings still suppress duplicate human-attention notes.

7. Update docs if public terminology changes.
   - `specs/projects/codegenie/functional_spec.md`
   - `specs/projects/codegenie/architecture.md`
   - `specs/projects/codegenie/components/review_pipeline.md`

## Validation

Automated checks:

```sh
pnpm exec vitest run tests/pipeline-phase7.test.ts
pnpm exec vitest run tests/uncertainty-promotion.test.ts
pnpm exec vitest run tests/verifier.test.ts
pnpm exec vitest run tests/pipeline-phase5.test.ts
pnpm run typecheck
pnpm test
pnpm run build
```

Eval checks after Issue 67 and Issue 68 are implemented:

```sh
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/49f4645b --no-cache
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/0c4d5213 --no-cache
```

Expected diagnostic improvements:

- Promoted candidates preserve the actual predicate from Stage 7.
- Stage 9 rejection reasons address the runtime/design/testing predicate that was promoted.
- A test-scoped source with a concrete production/runtime predicate is no longer routed as testing solely because the source mentions tests or coverage.
- Refactor-like intent no longer appears as evidence against behavior-bearing code changes.
- Human-attention notes are not suppressed by weak file-only overlap with rejected candidates.
- The eval may still fail if the verifier judges the correctly routed predicate unproven or immaterial. That is an acceptable, legible outcome for this plan.

## Stop Conditions

Stop and reconsider if:

- Promotion starts converting vague notes into broad correctness claims.
- Verifier keep rate rises because weak candidates bypass evidence requirements.
- Human-attention output becomes noisy because duplicate suppression is too weak.
- The implementation adds domain-specific rules for one eval or one language.
- Stage 10 starts surfacing notes that duplicate published findings.
