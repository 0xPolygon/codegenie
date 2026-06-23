# Issue 24: Uncertainty Promotion and Verifier Policy Discipline

Status: COMPLETE
Planned from: trails-api eval run 4, 2026-06-15
Updated after plan 25 completion: 2026-06-15

## Problem

Eval run 4 improved recall over run 3, but the remaining losses show two quality gaps and one eval reporting issue:

- Stage 7 reviewed the right packet for the ERC20 balance coverage issue and even emitted the exact concern as an uncertainty, but did not promote it to a candidate finding.
- Stage 9 is still inconsistent on behavior changes inside refactors: same-PR tests are useful evidence, but should not automatically prove a semantic change is safe when the surrounding intent is consolidation/refactor.
- Eval output reports failed minimum finding budgets with confusing wording like `3 > 4`, when the failure is actually `3 < 4`.

Plan 25 already handled the core source-delivery failure behind the relay fee-price false positive: repository tools now distinguish lookup from delivery, expose source recovery hints, preserve verifier source budget, and emit precise budget diagnostics. This plan should not duplicate that implementation. It should only keep the policy rule that the verifier must fail closed if decisive source is still incomplete after recovery.

This should be fixed generically. Do not add trails-api-specific rules, expected finding names, or language-specific special cases.

## Plan

1. Promote high-value uncertainties into bounded verification candidates.
   - Add a small post-packet-review promotion step before verification scheduling.
   - Only consider uncertainties/follow-up hints that are attached to reviewed packets and name concrete files/symbols.
   - Promote when the uncertainty points at likely correctness/security/test-coverage risk, names changed code or changed tests, and names production code or deleted coverage that can be verified.
   - Keep the lane bounded, for example 2-4 promoted candidates per run or a small percentage of verification budget.
   - Generated promoted candidates must be marked with provenance such as `source: "uncertainty_promotion"` and lower initial confidence.
   - Do not publish promoted candidates without normal LLM verification.

2. Keep verifier source discipline as a policy gate, not another source-recovery implementation.
   - Reuse plan 25's `lookupStatus`, `deliveryStatus`, `recovery`, and tool-budget diagnostics.
   - If the verifier keeps a finding, its `verification` or reason should cite the exact branch that proves the failure mode.
   - If decisive helper/callee behavior is still truncated, budget-rejected, missing, or otherwise unavailable after recovery attempts, reject or mark `requiredEvidencePresent=false`.
   - Keep explicit false-positive guidance for removed-guard claims where the replacement helper may already enforce the same condition.
   - Do not add more broad tool budget increases here; budget/completeness controls belong in plan 26.

3. Refine behavior-change verification inside refactors.
   - Same-PR tests should be treated as evidence of intended behavior, but not sufficient by themselves to reject a finding.
   - If the PR or commit context indicates refactor, cleanup, consolidation, behavior-preserving, or similar, the verifier should compare base vs head behavior and keep/revise material semantic changes unless product intent explicitly justifies the change.
   - If same-PR tests clearly document a new behavior but product intent is ambiguous, prefer a revised finding framed as "behavior changed; confirm intent" over a hard rejection when caller impact is concrete.
   - If PR/spec text clearly states the product behavior change, reject accidental-regression framing.

4. Fix eval budget failure wording.
   - Change minimum budget failure output from misleading `actual > limit` wording to `actual < minimum`.
   - Keep maximum budget failures as `actual > maximum`.
   - Add tests so min/max budget formatting cannot regress.

5. Add telemetry and diagnostics for promoted uncertainties.
   - Count uncertainties considered, promoted, lane-limited, verified, kept, and rejected.
   - Include promoted-candidate provenance in `candidate-findings.json`, `verification.json`, and eval loss attribution.
   - Include why a hint was not promoted when practical: weak category, no changed file, no production impact, no concrete symbol, budget-limited.

6. Keep cost bounded.
   - Reuse existing packet context and tool traces when constructing promoted candidates.
   - Do not add another full packet review pass.
   - Promotion should create a small number of targeted verification candidates, not new broad exploration work.
   - The verifier may use normal plan-25 source-recovery tools, but promoted candidates should start with a concise evidence packet.

## Likely Files

- `src/pipeline/reviewer.ts`
- `src/pipeline/verifier.ts`
- `src/pipeline/composer.ts`
- `src/skills/prompt-builder.ts`
- `src/evals/eval-scoring.ts`
- `src/evals/eval-reporter.ts`
- `src/telemetry/run-artifacts.ts`
- `src/types.ts`
- `tests/verifier.test.ts`
- `tests/evals.test.ts`
- `tests/telemetry.test.ts`

## Acceptance Criteria

- A serious uncertainty about changed tests losing production-path coverage can become a bounded verification candidate.
- Promoted uncertainty candidates are never published unless LLM verification keeps them.
- Verifier keeps helper-dependent findings only after citing the decisive helper/callee branch.
- Verifier rejects or marks incomplete when decisive helper behavior remains unavailable after plan-25 recovery paths.
- Same-PR tests no longer cause automatic rejection of material base-vs-head behavior changes in refactor-like PRs.
- Eval min-budget failures print clear wording such as `minFindings: 3 < 4`.
- Telemetry explains uncertainty promotion decisions and budgets.
- The solution remains language-agnostic and repo-agnostic.
