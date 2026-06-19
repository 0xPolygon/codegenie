# Issue 68: Predicate-Preserving Promotion and Note Suppression

Status: PENDING
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

## Implementation Steps

1. Inspect current uncertainty/follow-up promotion code.
   - Identify where category/title/failure mode are derived.
   - Identify whether the original hint predicate/reason is preserved.

2. Preserve predicate fields through promotion.
   - Add or reuse fields for concrete predicate, why it might fail, and evidence summary.
   - Cap strings so Stage 9 prompts stay bounded.
   - Keep source provenance for debug artifacts.

3. Update promotion classification.
   - Prefer explicit concrete predicate/failure mode over question phrasing.
   - Keep testing classification for true coverage-only concerns.
   - Avoid keyword taxonomies; use existing category enums only as final output categories.

4. Update verifier prompt/rendering.
   - Instruct verifier to adjudicate the concrete predicate.
   - Treat refactor-like intent as neutral context, not rejection evidence.
   - Keep existing evidence and changed-line requirements.

5. Tighten Stage 10 note suppression.
   - Require stronger overlap for rejected candidates to suppress unresolved notes.
   - Add telemetry for suppression reason: strong-overlap, weak-overlap-kept, suppressed-by-published-finding, capped.

6. Update tests.
   - A hint phrased as a test question but carrying a runtime predicate promotes under the runtime predicate.
   - A true coverage-only hint remains testing.
   - `refactorLike` does not cause verifier rejection when code evidence supports a behavior concern.
   - A rejected candidate with only same-file weak overlap does not suppress an unrelated note.
   - Published findings still suppress duplicate human-attention notes.

7. Update docs if public terminology changes.
   - `specs/projects/codeninja/functional_spec.md`
   - `specs/projects/codeninja/architecture.md`
   - `specs/projects/codeninja/components/review_pipeline.md`

## Validation

Automated checks:

```sh
pnpm exec vitest run tests/pipeline-phase7.test.ts
pnpm exec vitest run tests/pipeline-phase9.test.ts
pnpm exec vitest run tests/pipeline-phase10.test.ts
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
- Refactor-like intent no longer appears as evidence against behavior-bearing code changes.
- Human-attention notes are not suppressed by weak file-only overlap with rejected candidates.

## Stop Conditions

Stop and reconsider if:

- Promotion starts converting vague notes into broad correctness claims.
- Verifier keep rate rises because weak candidates bypass evidence requirements.
- Human-attention output becomes noisy because duplicate suppression is too weak.
- The implementation adds domain-specific rules for one eval or one language.
- Stage 10 starts surfacing notes that duplicate published findings.
