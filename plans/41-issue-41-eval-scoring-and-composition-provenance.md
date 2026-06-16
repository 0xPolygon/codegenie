# Issue 41: Eval Scoring and Composition Provenance Under-Credit

Status: COMPLETE
Planned from: trails-api eval run 8 review, 2026-06-16

## Problem

Eval run 8 scored `1/5`, but the score under-credits the actual review output:

- `routing-explicit-preference-fallback` was published in the final review, but the eval reported `lost-at-composition`.
- `zero-native-price-fee-calculator` was published in the final review, but the eval reported `partial-match` because the title regex was word-order-sensitive.
- `amountfromusd-zero-decimal-token` was surfaced as an uncertainty and promoted, but the verifier rejected it because reachability of a legitimately priced zero-decimal origin token was not proven.
- `erc20-balanceof-test-coverage` was the one clear product miss: reviewed by the test lens with no candidate.

The main scoring bug is that final composition can merge candidates and lose fields that are still semantically true for the merged result. In run 8, two routing candidates were kept:

- `fd0793c6-f1`: v1 call site, category `correctness`
- `13dc0c5e-f1`: v1_5 call site, category `logic_bug`

The composer merged `fd0793c6-f1` into `13dc0c5e-f1`. The final finding correctly discussed both v1 and v1_5 behavior, but the eval matcher only checked the survivor's primary category/title/path, so the merged `correctness` candidate was treated as lost.

This creates bad feedback loops: we might tune the review pipeline for an issue that was already found and published.

## Goals

- Make eval scoring reflect what the final review actually communicates.
- Preserve merged candidate provenance through composition.
- Avoid making evals overly permissive by default.
- Allow run artifacts to be re-scored without making another LLM call.
- Keep scoring generic across projects and languages.

## Non-Goals

- Do not mark speculative verifier-rejected issues as passed.
- Do not make every category interchangeable.
- Do not hide real composition drops.
- Do not hard-code trails-api expectation ids, file paths, or titles.
- Do not weaken production review quality to satisfy eval matching.

## Plan

1. Preserve composition provenance for merged findings.
   - Ensure every final finding records all merged candidate ids.
   - Preserve merged candidates' categories, severities, paths, anchors, title text, and expectation-relevant keywords in structured metadata.
   - Keep the final finding's primary category and primary anchor as the composer selected them.
   - Add a provenance field such as:
     - `mergedCandidateIds`
     - `mergedCategories`
     - `mergedPaths`
     - `mergedTitles`
     - `mergedAnchors`
   - The final body may remain concise; this is mostly for telemetry/eval and review auditability.

2. Update eval scoring to match through merged provenance.
   - When matching a `should_find` expectation against final findings, check:
     - the final finding's primary fields
     - merged candidate metadata
     - final body text when title-only matching is too brittle
   - If a candidate was verified-keep and merged into a published final finding that communicates the same root cause, score it as found.
   - Keep the loss label distinct when something was truly suppressed or omitted:
     - `lost-at-composition` only when no published merged finding covers it
     - `merged-and-published` should be a pass, not a loss

3. Add conservative category compatibility.
   - Treat closely related correctness categories as compatible by default:
     - `logic_bug` <-> `correctness`
     - `correctness` <-> `logic_bug`
   - Consider `security` compatible only with `correctness` when the expectation explicitly permits broad matching or the final finding's body clearly states a correctness failure mode. Do not make security broadly interchangeable by default.
   - Leave `testing`, `performance`, `architecture`, and `maintainability` strict unless an eval opts into compatibility.
   - Implement this as a small deterministic compatibility table, not fuzzy LLM scoring.

4. Make title matching less brittle without making it vague.
   - Continue supporting `titlePattern`, but evaluate it against:
     - final title
     - merged candidate titles
     - first paragraph / concise body summary
   - Add a token-order-insensitive fallback only when the pattern is simple enough to safely tokenize.
   - Prefer improving eval YAML patterns when an expectation is too narrow.
   - Record why a match succeeded, for example `title`, `mergedTitle`, `body`, or `tokenFallback`.

5. Distinguish required findings from surfaced-but-unverified concerns.
   - Keep default `should_find` semantics strict: a required issue should be a verified final finding.
   - Add optional expectation fields only if needed:
     - `acceptHumanAttention: true`
     - `acceptVerifierRejectedIfSurfaced: false` by default
   - For the `AmountFromUSD` zero-decimal case, do not globally relax scoring. Decide in the eval YAML whether the expected behavior is:
     - must be a final finding with proven reachability
     - may be a human-attention note
     - should be removed/softened because reachability is unproven

6. Improve loss labels and diagnostics.
   - If a final finding almost matches only due to category alias, report `category-compatible`.
   - If a title pattern misses but body/merged title matches, report `matched-via-body` or `matched-via-merged-title`.
   - If a candidate is verifier-rejected, include the verifier reason and `requiredEvidencePresent`.
   - If a candidate is merged, show the published final finding id/fingerprint and title.

7. Add artifact replay / re-score workflow.
   - Ensure `eval --from-artifacts` or equivalent can re-score run 8 after scorer changes without re-running model calls.
   - If the command already exists, document the exact workflow in README or eval docs.
   - Add a regression fixture based on reduced run-8 artifacts:
     - one merged routing finding that should pass through merged provenance
     - one native-price finding whose body/title should satisfy the expectation
     - one verifier-rejected `AmountFromUSD` uncertainty that should not pass unless configured to accept surfaced notes

8. Update tests.
   - Final finding matches expectation through `mergedCandidateIds`.
   - `logic_bug` satisfies a `correctness` expectation through category compatibility.
   - Body/title fallback credits a correct finding when word order differs.
   - A finding on the matching file/category but a different root cause is NOT credited via body/merged/token fallback (guards the leniency against false credit).
   - A verifier-rejected uncertainty does not satisfy strict `should_find`.
   - A human-attention note satisfies an expectation only when explicitly configured.
   - Loss diagnostics clearly distinguish `merged-and-published` from true `lost-at-composition`.

## Likely Files

- `src/evals/eval-scoring.ts`
- `src/evals/eval-runner.ts`
- `src/pipeline/composer.ts` (final selection and merge live here; there is no separate `final-selection.ts`)
- `src/types.ts`
- `tests/eval-scoring*.test.ts`
- `README.md` or eval docs

## Validation

- Run eval scoring unit tests.
- Re-score trails-api run 8 from artifacts without model calls.
- Confirm routing and zero-native-price expectations are credited.
- Confirm `AmountFromUSD` remains strict unless the eval YAML explicitly accepts human-attention surfacing.
- Confirm final output remains unchanged or only gains provenance metadata; no review wording should be warped for the scorer.
- Expected outcome: this plan credits routing and zero-native-price (-> 2/4 should_find) but does NOT flip run 8 to pass on its own. `amountfromusd` stays verifier-rejected, and `minFindings` stays 3 < 4 (a published-finding count, unaffected by matching). A real pass also needs Issue 42 (amountfromusd candidate quality) and Issue 43 (erc20) to publish genuine findings.
