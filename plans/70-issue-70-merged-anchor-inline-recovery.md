# Issue 70: Merged-Anchor Inline Recovery

Status: PENDING
Planned from: trails-api eval `49f4645b/logs/15` compared with `49f4645b/logs/1`, `49f4645b/logs/13`, and `49f4645b/logs/14`, 2026-06-19
Recommended priority: medium-high, after Issue 71. This is valuable publication polish: run 15 recovered the right finding but published it summary-only even though a valid changed-line anchor existed in a merged candidate. It does not affect recall or verifier quality.

Architecture boundary: this is a Stage 10 publication fix only. It should change where an already verified merged finding is published, not whether candidates are generated, verified, merged, or kept.

## Problem

Run 15 produced the best version of the Hyperlane EXACT_OUTPUT finding:

```text
EXACT_OUTPUT transferAmount uses floor scale-down with no re-validation; can under-deliver or become 0
```

But the final report published it as summary-only:

```json
{
  "publication": "summary-only",
  "anchor": null,
  "changedLine": false,
  "mergedAnchors": [
    {
      "path": "lib/routes/hyperlane/hyperlane.go",
      "line": 213,
      "side": "RIGHT",
      "hunkId": "042c0fb..."
    }
  ]
}
```

The selected/richer finding came from the `scaleAmount` packet and had no valid inline anchor. The merged candidate came from the `GetQuote` packet and did have a valid changed-line anchor at the call site. The composer merged both into one final finding, but publication still looked only at the selected finding's own anchor.

This is a structural issue, not a one-off:

- Cross-packet synthesis is a core design goal.
- The best evidence and the best changed-line anchor may live in different packets.
- If final publication ignores merged anchors, high-quality cross-system findings degrade to summary-only even when GitHub can support an inline comment.

Run 1 published a similar finding inline. Run 15 found a stronger version, but weaker publication made it less actionable.

## Goal

When a final selected finding is unanchored but a merged finding has a valid changed-line anchor for the same root cause, publish inline using the best merged anchor.

Desired behavior:

```text
selected finding anchor valid:
  publish inline at selected anchor

selected finding anchor missing/invalid
  and mergedAnchors contains a valid changed-line anchor:
    publish inline at best merged anchor
    preserve merged provenance

no valid selected or merged anchor:
  publish summary-only
```

The fix should make cross-packet findings more publishable without inventing anchors.

## Non-Goals

- Do not infer anchors from free text.
- Do not anchor to unchanged lines.
- Do not anchor to deleted lines unless the existing GitHub anchoring model already supports that side and hunk.
- Do not use anchors from rejected or suppressed candidates.
- Do not force every summary-only finding inline.
- Do not change verifier strictness.
- Do not tune this for Hyperlane, decimals, Go, or this eval.

## Design

### 1. Introduce a Final Publication Anchor Helper

Add a small deterministic helper near final selection / composer output normalization:

```ts
type PublicationAnchorDecision = {
  anchor?: GitHubAnchor;
  source: "selected" | "merged" | "none";
  reason: string;
};
```

The helper receives:

- the selected final finding;
- the verified/kept findings that were merged into it;
- any `mergedAnchors` already attached to the final finding;
- the diff/hunk map used for existing anchor validation.

It returns the anchor used for publication.

### 2. Validate Merged Anchors With Existing Diff Rules

A merged anchor is usable only if:

- `path` is in the reviewed diff;
- `hunkId` belongs to that path;
- `side` and `line` are valid for the hunk;
- the line is a changed line, not arbitrary surrounding context;
- the source candidate was kept/revised into the final merged group.

Use existing anchor validation utilities if they exist. If they do not, factor the existing validation path instead of duplicating loosely similar logic.

### 3. Choose the Best Merged Anchor Deterministically

When multiple merged anchors are valid, choose by stable priority:

1. Anchor from the selected finding itself.
2. Anchor from a merged candidate on the same path as the final finding.
3. Anchor whose file role matches the finding category when that is obvious: testing findings prefer test-file anchors; correctness/security/performance/architecture findings prefer source-code anchors.
4. Anchor from a source-code file over docs files for non-documentation findings.
5. Anchor from a higher-severity or higher-confidence kept/revised candidate.
6. Lowest stable `(path, line, hunkId)` order.

Do not use LLM ranking for this. Publication anchoring should be deterministic.

### 4. Preserve Provenance

If the helper uses a merged anchor:

- set the final finding's publication anchor to that anchor;
- ensure the publication path/line used by markdown and GitHub posting comes from the selected publication anchor;
- keep `mergedAnchors` and `mergedCandidateIds`;
- keep original `path`, `mergedPaths`, and provenance fields available for diagnostics instead of erasing the cross-packet source;
- emit telemetry such as `merged_anchor_inline_recovered`;
- include the source in `final-selection.json`.

The final finding body should not pretend the selected packet owned that anchor. It can remain a cross-packet/system finding; only the publication target changes.

### 5. Publishing Semantics

If a merged anchor is chosen, the output should behave like any inline finding:

- Markdown report should list it under normal findings, not summary-only findings.
- GitHub posting should post it inline.
- `publication` should reflect inline publication.
- Eval metrics should count it as inline.

If no merged anchor validates, preserve current summary-only behavior.

## Implementation Steps

1. Locate the final publication decision point.
   - Likely areas: composer/final-selection normalization, markdown renderer, and GitHub posting path.
   - Identify where `publication: "summary-only"` is assigned.

2. Add `selectPublicationAnchor`.
   - Prefer selected finding anchor.
   - Fall back to valid merged anchors.
   - Return source/reason for telemetry.

3. Wire selected anchor into final findings.
   - Ensure `final-findings.json`, `final-selection.json`, markdown output, and GitHub posting all see the same publication anchor.

4. Add telemetry.
   - Count merged-anchor recoveries.
   - Record rejected merged anchors with reason at debug level.

5. Add tests.
   - Unanchored selected finding + valid merged anchor publishes inline.
   - Valid selected anchor still wins.
   - Invalid merged anchor preserves summary-only.
   - Rejected/suppressed candidate anchors are not used.
   - Testing final findings do not accidentally prefer unrelated source anchors.
   - Multiple valid merged anchors choose deterministically.

6. Run validation.
   - Targeted composer/output/GitHub anchor tests.
   - Full test suite and build.

## Validation

Use `49f4645b/logs/15` as the motivating artifact:

- Before: final finding is `summary-only` with `anchor: null` and `mergedAnchors[0]` at `hyperlane.go:213`.
- After: an equivalent final finding would publish inline at `hyperlane.go:213`.

Expected telemetry:

```text
merged_anchor_inline_recovered: 1
source: merged
path: lib/routes/hyperlane/hyperlane.go
line: 213
```

Success does not require changing candidate generation or verification. It only requires better publication of already-verified merged findings.

## Stop Conditions

Do not proceed if the implementation:

- anchors findings to lines that GitHub cannot accept;
- uses rejected candidate anchors;
- changes verifier or candidate-generation behavior;
- makes summary-only impossible for truly unanchorable findings;
- introduces LLM-dependent anchor selection.
