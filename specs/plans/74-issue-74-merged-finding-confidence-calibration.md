# Issue 74: Merged Finding Confidence Calibration

Status: PENDING
Planned from: trails-api eval `49f4645b/logs/21` compared with `49f4645b/logs/20`, 2026-06-19
Planned at: commit `81c6430`
Recommended priority: medium. This is output-quality polish after Issues 70-73; it should not change recall, verification strictness, or candidate generation.

## Problem

Run 21 correctly found and published the caller-visible guarantee issue, and it correctly avoided run 20's overstatement:

```text
Run 20 final:
  severity: high
  confidence: medium
  behaviorChange: intentional_needs_confirmation

Run 21 final:
  severity: medium
  confidence: low
  behaviorChange: intentional_needs_confirmation
```

The run 21 severity is healthier after the Issue 73 severity cap, but the final confidence is too low for the merged finding. The verified group contained a direct candidate with medium confidence:

```text
c121cfd3-f1:
  severity: low
  confidence: medium
  category: correctness
  behaviorChange: intentional_needs_confirmation
  source: direct Stage 7 finding

9c3e3101-u2-d264e18d:
  severity: medium
  confidence: low
  category: correctness
  behaviorChange: intentional_needs_confirmation
  source: promoted follow-up hint
```

Stage 10 selected the promoted candidate as the representative because `compareFindings()` ranks severity before confidence:

```ts
function compareFindings(
  a: Pick<CandidateFinding, "severity" | "confidence" | "id" | "anchor">,
  b: Pick<CandidateFinding, "severity" | "confidence" | "id" | "anchor">
): number {
  return severityRank(a.severity) - severityRank(b.severity) ||
    confidenceRank(a.confidence) - confidenceRank(b.confidence) ||
    anchorLineRank(a) - anchorLineRank(b) ||
    a.id.localeCompare(b.id);
}
```

Then `toFinalFinding()` spreads the representative candidate into the final finding:

```ts
const { anchor: _unvalidatedAnchor, ...findingWithoutAnchor } = finding;
...
const final: FinalFinding = {
  ...findingWithoutAnchor,
  title: normalizedTitle,
  ...
};
```

So the final merged report inherits the representative's `confidence: "low"` even though the merged duplicate group contains stronger confidence evidence. The system already records merged metadata such as `mergedCandidateIds`, `mergedCategories`, `mergedSeverities`, and `mergedAnchors`; it does not currently use merged candidates to calibrate final confidence.

This is a Stage 10 composition issue, not a Stage 7 or Stage 9 issue. The verifier supplied useful raw signals; the composer lost one of them while collapsing duplicates.

## Rationale

Do not change verifier policy to make low-confidence findings more publishable. Do not ask Stage 7 to rate confidence differently. Do not reorder representative selection globally, because severity-first representative selection is still useful when deciding which finding body/title anchors the final group.

The safe fix is narrower:

```text
Representative selection chooses the final body's base candidate.
Merged confidence calibration chooses the final confidence from compatible verified evidence in the same merge group.
```

This mirrors Issue 70's anchor recovery: the chosen representative can remain the richer or higher-severity candidate, while the final publication borrows a better merged signal when that signal is already verified and belongs to the same composer-approved group.

The key guardrail is to avoid confidence inflation. A stronger-confidence candidate should not make a broader finding look more certain merely because it is adjacent. The final confidence may be raised only when the stronger-confidence candidate is in the same verified merge group, is compatible with the representative, and the lift is bounded. In this pipeline, composer merge groups are intended to represent the same root cause; this plan relies on that existing root-cause grouping rather than introducing a new merge rule.

## Functional Spec

### 1. Add a deterministic merged-confidence helper

In `src/pipeline/composer.ts`, add a helper near `selectPublicationAnchor()` / `toFinalFinding()`:

```ts
function selectMergedConfidence(
  representative: CandidateFinding,
  mergedFindings: CandidateFinding[]
): {
  confidence: Confidence;
  sourceFindingId?: string;
  reason: "representative" | "same_severity" | "compatible_lower_severity";
} {
  ...
}
```

Exact naming can differ, but keep this behavior:

- Default to `representative.confidence`.
- Only consider candidates in `mergedFindings`; never inspect suppressed, rejected, or unverified candidates.
- Only consider candidates with the same `category` as the representative.
- If both candidates define `behaviorChange`, require it to match.
- Prefer stronger confidence by `confidenceRank()`.
- If a stronger-confidence candidate has the same severity as the representative, it may supply the final confidence.
- If a stronger-confidence candidate has lower severity than the representative, it may lift the final confidence by at most one confidence step and never above `medium`.
- Do not let a lower-severity candidate lift confidence when the severity gap is more than one step.
- Do not lower confidence. If the representative is already stronger, keep it.
- If several candidates qualify, choose deterministically: first by the strongest resulting confidence, then by source candidate id. The same input group must produce the same final confidence and source record every time.

For run 21, this means:

```text
representative: medium / low
merged direct candidate: low / medium
severity gap: one step
allowed lift: low -> medium
final: medium / medium
```

Counterexamples that must remain unchanged:

```text
representative: high / low
merged candidate: low / high
severity gap: two steps
final confidence stays low

representative: medium / low / correctness
merged candidate: medium / high / testing
category mismatch
final confidence stays low

representative: medium / medium
merged candidate: medium / low
weaker candidate
final confidence stays medium
```

### 2. Apply it only at final finding construction

Update `toFinalFinding()` so it uses the helper after `publicationAnchor` and metadata are computed:

```ts
const mergedConfidence = selectMergedConfidence(finding, mergedFindings);
const final: FinalFinding = {
  ...findingWithoutAnchor,
  confidence: mergedConfidence.confidence,
  ...
};
```

Do not mutate the original candidate objects. Do not change `strongest()`, `compareFindings()`, `pretrimComposerInput()`, `mergeProximityGroups()`, or `mergeRootCauseGroups()` as part of this plan.

This plan calibrates the final merged report only. It must not affect:

- candidate verification gates;
- composer grouping;
- severity ranking;
- max-findings trimming;
- low-confidence publishability rules before final construction.

### 3. Add final-selection observability

Add a small diagnostic record to `final-selection.json`, similar in spirit to `publicationAnchors`.

Suggested shape:

```json
"confidenceSelections": [
  {
    "findingId": "9c3e3101-u2-d264e18d",
    "confidence": "medium",
    "source": "merged",
    "sourceFindingId": "c121cfd3-f1",
    "reason": "compatible_lower_severity",
    "representativeConfidence": "low"
  }
]
```

Keep this diagnostic optional and compact. Only emit a record for final findings where the selected confidence differs from the representative confidence, or emit all records if that is simpler and consistent with nearby artifact code.

Also emit one Stage 10 telemetry event when a merged confidence lift occurs:

```text
message: "merged_confidence_recovered"
data: {
  findingId,
  sourceFindingId,
  fromConfidence,
  toConfidence,
  representativeSeverity,
  sourceSeverity,
  reason
}
```

Do not add telemetry for unchanged findings.

### 4. Preserve confidence thresholds intentionally

Be careful about the order relative to `applyCaps()`:

- The confidence lift should happen inside `toFinalFinding()`, before `applyCaps()`.
- This is intentional: if a final duplicate group has compatible verified medium-confidence evidence, it should not be suppressed or downgraded as though the whole group were low-confidence.
- The helper's guardrails are what prevent broad inflation.

Do not bypass `applyCaps()`. The final finding still must pass `minConfidence`, `minInlineConfidence`, severity caps, soft comment caps, and low-confidence behavior-delta rules.

## Implementation Notes

Relevant files:

- `src/pipeline/composer.ts` — final grouping, representative selection, final finding construction, final-selection artifact.
- `tests/pipeline-phase5.test.ts` — existing integration-style Stage 10 tests live here.
- `src/types.ts` — only touch this if adding a typed optional diagnostic structure requires it. Prefer local internal types in `composer.ts` if possible.

Existing nearby behavior to preserve:

- `strongest()` uses `compareFindings()` and should remain severity-first.
- `toFinalFinding()` already computes merged metadata:

```ts
const mergedCandidateIds = uniqueStrings(mergedFindings.map((item) => item.id));
const mergedAnchors = dedupeAnchors(mergedFindings.flatMap((item) => item.anchor === undefined ? [] : [item.anchor]));
const mergedCategories = uniqueStrings(mergedFindings.map((item) => item.category)) as Array<CandidateFinding["category"]>;
const mergedSeverities = uniqueStrings(mergedFindings.map((item) => item.severity)) as Array<CandidateFinding["severity"]>;
```

- Add `mergedConfidences?: Confidence[]` to `FinalFinding` and populate it the same way as `mergedSeverities`. This makes confidence recovery auditable on the final finding itself, not only in `final-selection.json` or telemetry.
- `publicationAnchors` in `final-selection.json` is a good model for a compact, auditable Stage 10 selection record.

## Test Plan

Add focused tests in `tests/pipeline-phase5.test.ts`.

Required tests:

1. **Run 21 shape: merged final keeps medium severity and recovers medium confidence**
   - Build two verified candidates:
     - representative candidate: `severity: "medium"`, `confidence: "low"`, `category: "correctness"`, `behaviorChange: "intentional_needs_confirmation"`, promoted-style id is fine.
     - merged direct candidate: `severity: "low"`, `confidence: "medium"`, same category and behaviorChange.
   - Make the composer group both IDs into one final finding.
   - Assert:
     - final severity is `medium`;
     - final confidence is `medium`;
     - `mergedCandidateIds` contains both;
     - `final-selection.json` contains the confidence selection diagnostic or telemetry contains `merged_confidence_recovered`.

2. **No high-confidence inflation across a large severity gap**
   - Representative: `severity: "high"`, `confidence: "low"`.
   - Merged candidate: `severity: "low"`, `confidence: "high"`.
   - Assert final confidence remains `low`.

3. **No confidence borrowing across category mismatch**
   - Representative: `category: "correctness"`, `severity: "medium"`, `confidence: "low"`.
   - Merged candidate: `category: "testing"`, `severity: "medium"`, `confidence: "high"`.
   - Assert final confidence remains `low`.

4. **Same-severity duplicate can borrow stronger confidence**
   - Representative: `severity: "medium"`, `confidence: "low"`.
   - Merged candidate: `severity: "medium"`, `confidence: "high"`.
   - Assert final confidence becomes `high`.

5. **Representative confidence is never lowered**
   - Representative: `severity: "medium"`, `confidence: "medium"`.
   - Merged candidate: `severity: "medium"`, `confidence: "low"`.
   - Assert final confidence remains `medium`.

6. **No compatible confidence lift means the finding remains suppressed as before**
   - Use a low-confidence final finding that would normally fail `minConfidence`.
   - Add a merged candidate that is either category-mismatched, behaviorChange-mismatched, or too far away in severity to qualify.
   - Assert the final finding is still suppressed for `confidence-threshold`.
   - This pins the `applyCaps()` ordering boundary: compatible verified evidence can rescue the run 21 shape, but unrelated or incompatible low-confidence groups must not become publishable.

Use existing Stage 10 tests as patterns, especially:

- `preserves merged candidate provenance on final findings`
- `publishes an unanchored composed finding inline using a valid merged anchor`
- `continues suppressing broad low-confidence findings even after verification`

## Verification

Run:

```sh
pnpm exec vitest tests/pipeline-phase5.test.ts
pnpm run typecheck
pnpm test
pnpm run build
```

Expected:

- all commands exit 0;
- new tests pass;
- no snapshot or artifact schemas outside Stage 10 final-selection diagnostics need unrelated updates.

## Done Criteria

- `toFinalFinding()` no longer blindly inherits representative confidence when a compatible merged candidate supplies stronger verified confidence.
- Final severity and representative selection remain unchanged.
- Confidence lifts are bounded and deterministic.
- `FinalFinding` records `mergedConfidences` in parallel with `mergedSeverities`.
- Confidence lifts are visible in Stage 10 telemetry or `final-selection.json`.
- The run 21 shape would produce `severity: medium`, `confidence: medium`, not `severity: medium`, `confidence: low`.
- No Stage 7, Stage 8, Stage 9, verifier, or uncertainty-promotion behavior changes.
- `plans/README.md` marks this plan complete after implementation.

## STOP Conditions

Stop and report back instead of improvising if:

- Fixing the issue appears to require changing verifier verdicts, candidate generation, or pre-verification gating.
- The implementation would make confidence stronger based on suppressed/rejected/unverified candidates.
- Existing tests show broad low-confidence findings now publish only because of this helper.
- You find that `FinalFinding.confidence` is intentionally documented as "representative confidence only" somewhere outside `composer.ts`; update the plan first.

## Maintenance Notes

This is the confidence counterpart to Issue 70's merged-anchor recovery. Both are Stage 10 publication-quality repairs: they reuse verified merged candidates without changing what the verifier keeps.

Future reviewers should watch for accidental inflation. A confidence lift is appropriate when duplicate verified candidates in the same root-cause merge group describe the same mechanism and one candidate has stronger confidence evidence. It is not appropriate for merely adjacent findings, different mechanisms, category-mismatched findings, behaviorChange-mismatched findings, or findings whose severity gap exceeds the helper's explicit limit.

If later evals show severity has the same problem in reverse, do not generalize this helper into broad "best-of-group" metadata selection. Severity is intentionally representative-first today and already records `mergedSeverities` for auditability.
