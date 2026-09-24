# Issue 117: Concise Reports and Contract-Aware Fix Verification

Status: IMPLEMENTED (measuring) — Phases 1–4 complete; live reasoning comparison deferred, 2026-09-22 (America/Toronto)
Evidence: trails-api 49f4645b eval run 91; comparison with Opus run 67 and DeepSeek run 83
Baseline: branch upgrade, commit db1ea55; run 92 started on this baseline with DeepSeek 4.1 Flash/max
Depends on: Plans 115/116, retained-draft recovery, structured verifier proof assessment, and composition source accounting

## Objective

Publish one supported, actionable conclusion per issue, with concise primary prose and complete expandable provenance. Verify that recommended remedies and regression tests preserve the relevant caller-visible contract. Preserve strict schemas, original evidence, attribution, uncertainty, bounded recovery, and honest failure reporting.

Finding the expected bug and producing valid JSON are necessary but insufficient: the report must explain the established impact, recommend a compatible remedy, and distinguish current conclusions from superseded investigative claims.

This plan separates investigation/verification quality, composition quality, and renderer behavior. Increasing reasoning effort alone cannot repair a renderer that ignores the composed text or establish a caller contract absent from the verified inputs.

## Execution and scope

- [x] Read the current code and this plan before implementation; preserve unrelated work.
- [x] Implement Phases 1–4 in order and update this plan with decisions and validation. Run-92 measurement is observational and does not block coding; Phase 5 is a separately authorized experiment, not a prerequisite for completing the implementation.
- [x] Keep implementation unstaged unless subsequently requested otherwise.
- [x] Preserve run 92 as a pre-change comparison; do not edit its configuration, stop it, or change its artifacts.
- [x] Use minimal sanitized fixtures in repository tests; do not depend on private eval checkouts or absolute local paths.
- [x] Do not run paid model experiments solely because they appear in this plan. Prepare reproducible inputs first; live experiments require user authorization.
- [x] Update schema, prompt and cache behavior versions for changed live contracts. Preserve explicit compatibility for historical artifacts.

Not in scope: relaxing validation, heuristic removal of substantive evidence, another repair scheduler, globally increasing timeouts, silently upgrading provider reasoning, or automatically treating every testing finding as a duplicate production defect.

## Evidence and conclusions

### Run 91 completed successfully, but reporting quality remains uneven

| Run | Model / investigation effort | Time | Cost | Model calls | Final findings |
| --- | --- | --- | --- | --- | --- |
| 67 | Opus 5 / high | 11m51s | $10.7066 | 120 | 2 |
| 83 | DeepSeek 4.1 Flash / max | 10m53s | $0.3613 | 96 | 2 |
| 91 | GLM 5.3 Flash / max | 25m34s | $0.4373 | 101 | 2 |

All three reported the EXACT_OUTPUT truncation/minimum-delivery issue and the missing non-divisible test cases. Run 91 reviewed all 10 hunks, assessed 12 candidates with zero incomplete verifications, and composed 11 verified candidates into two inline findings without fallback. One second field repair supplied severity without restarting a worker. Recovery fidelity remains unknown because unreadable originals needed regeneration.

Run 91 took 8m6s in packet review, 13m41s in verification, and 2m26s in composition. Its composition call, mc-000101, used high reasoning: one supported level below max. It consumed 13,271 reasoning tokens and completed in 145,856 ms. This does not establish that high reasoning caused the quality problems; max could also exceed the existing 180-second attempt deadline.

These are observational comparisons across different code revisions. Run 67 also had a larger budget boost. Eval success establishes the configured expected-issue/completeness/budget checks, not correctness of every explanation or remedy.

### A. The renderer discards useful synthesized verification

In src/pipeline/composition-content.ts, renderCompositionSections validates source accounting, but replaces a verification section's composed text with its first original source and appends the remaining originals verbatim in details.

Run 91's raw composition correctly reconciled an earlier claim that cross-decimal tests were absent: those tests exist, but use divisible amounts. The rendered report still retained the earlier broader assertion among the verification contributions.

Conclusion: preserve the original investigation as provenance, but display a reconciled current conclusion. Original evidence must remain available; an earlier source's position must not automatically become the authoritative summary.

### B. Prompt/schema responsibilities encourage unnecessary prose

The composer must account for every source component, generate sections, and also write required legacy finalBody text. Formatting instructions still primarily address finalBody although sections drive the current rendered report.

Run 91 generated two impact sections per finding, repeated implementation details, and exposed candidate IDs and source-accounting counts in its summary. Raw Markdown word counts were approximately 3,710 for GLM, 2,431 for DeepSeek, and 1,329 for Opus. These include expanded provenance: measure visible narrative separately rather than penalizing retained evidence.

Conclusion: account for every source without requiring every source's prose to appear in the main report. Give the model one clear live writing contract.

### C. Fix quality depends on caller-contract verification

GLM and DeepSeek proposed reducing the published output to match the floored transfer, with tests asserting that reduced output. At the reviewed commit, lib/intentmachine/v1/quote_intent.go explicitly rejects provider ToAmountMin below the requested EXACT_OUTPUT amount and uses the requested amount for a tokenMinBalance destination precondition.

Opus traced that downstream requirement and preferred ceiling conversion. GLM left downstream enforcement uncertain and preserved alternative fixes without resolving their compatibility. Merely making the quote internally consistent can still fail the caller's contract.

Conclusion: verify proposed remedies and tests during verification, using existing source tools and budgets. Composition must not invent a contract or promote an unverified remedy into an unconditional recommendation. Finding validity and remedy validity are separate judgments.

### D. Source accounting is not semantic proof

Existing validation checks IDs, kind, membership and complete coverage. It does not prove that a paraphrase faithfully represents cited content. Nor does preserving every original paragraph resolve contradictions.

Conclusion: retain structural checks, add explicit reconciliation and remedy assessment where useful, and test the resulting report's substantive conclusions. Do not claim a reference validator proves semantic equivalence.

## Required invariants

1. Complete original verified inputs, code evidence, and provenance remain available in artifacts and expandable presentation. No truncation or string-similarity deletion to meet a word target.
2. Every merged finding and source component is accounted for. Distinct actionable issues remain separate.
3. The visible conclusion must retain material conditions and unresolved essential uncertainty. A missing prerequisite cannot disappear into collapsed details.
4. Superseded claims remain attributable historical material, not unlabeled competing current conclusions. An unresolved disagreement stays visible when it changes the diagnosis, severity or remedy.
5. An established defect can survive an unsupported proposed fix. Rejecting or withholding a remedy must not incorrectly mark defect verification incomplete.
6. Keep strict schema, semantic, cache and recovery validation. Retain three repair calls sharing 180 seconds, lowest-supported repair reasoning, cancellation, and existing worker retry limits.
7. Keep current composition reasoning by default until a controlled comparison supports a change.
8. Fallbacks remain explicit and measurable; concise presentation must not conceal degraded synthesis or unresolved work.

## Phase 1: Capture baselines and regression evidence

- [x] Capture sanitized run-91 composition inputs/output demonstrating the renderer ignoring its reconciled verification paragraph.
- [x] Add fixtures for duplicate issue contributions, corrected test-coverage claims, conflicting severity/conditions, and distinct production/testing findings.
- [x] Add a small caller-contract fixture where lowering an advertised output fixes internal consistency but violates a required minimum.
- [x] Record run 92 after completion: findings, downstream proof, fixes/tests, repetition, composition validity, cost/time and recovery. Do not assume it passes or shares GLM's failure modes.
- [x] Measure model-written narrative, rendered primary prose and expanded provenance separately. Avoid regex-only stripping of nested details; use structured rendering data or a Markdown/HTML-aware method.

Acceptance: tests reproduce both the stale-verification presentation and the remedy/contract mismatch without private files or live model calls.

## Phase 2: One composition contract and a concise renderer

Primary targets: src/llm/schemas.ts, src/skills/prompt-builder.ts, src/pipeline/composer.ts, src/pipeline/composition-content.ts.

- [x] Define one live structured representation for reader-facing conclusions. At most one section per narrative kind; combine diagnosis/impact coherently rather than duplicating the Impact label.
- [x] Remove redundant finalBody generation from the new live contract if sections are authoritative. Keep a deliberate legacy reader/fallback path for historical payloads, rather than requiring the model to author two report versions.
- [x] Update formatting instructions to target rendered sections. Keep the summary to a few sentences, without candidate IDs, member counts, source-reference bookkeeping or investigation chronology.
- [x] Give soft word targets, initially roughly 150–300 narrative words per ordinary finding, with room for genuinely distinct conditions. No hard truncation, and no length-only repair loop.
- [x] Render the composed verification conclusion rather than replacing it with the first original paragraph.
- [x] Keep material uncertainty visible. Use a small, explicit reconciliation record only for corrected/conflicting conclusions: affected source references, supporting references, disposition (superseded or unresolved), and rationale. References may point to multiple already-accounted components without counting as duplicate component consumption. Do not introduce a second full claim graph.
- [x] Validate reconciliation reference membership and nonempty rationale, but do not equate those checks with proof. Composition cannot upgrade a verifier's unresolved essential assumption to established proof. If supplied evidence does not resolve a material conflict, show that conflict in the primary conclusion and retain its original wording/provenance.
- [x] A supersession needs supporting source references and a reason. Do not select truth merely by timestamp, source order, majority vote or higher severity. Unsupported conflict resolution must remain qualified.
- [x] Separate complete source accounting from prominence. Permit a small selected set of decisive evidence references in the main report, while all other accounted references remain in expandable provenance.
- [x] Continue rendering code evidence from immutable source records. Preserve raw strings; deduplicate only safe exact equivalents. Initially select whole existing evidence components for prominent display; defer a new substring/excerpt extraction protocol. Do not treat source text as trusted HTML: model/source details tags must not be able to break the renderer-owned provenance boundaries.
- [x] Label provenance as original assessments that may overlap or have been superseded, and link it to the current conclusion. Keep IDs and accounting in artifacts rather than introductory prose.
- [x] Apply the same presentation boundaries to deterministic fallback: one readable representative view, material disagreement visible, all source material retained, and an explicit degraded-synthesis label.
- [x] Validate membership, kind, uniqueness and full accounting before acceptance/cache writes. In particular, main-evidence selection must not be mistaken for permission to omit the other evidence from accounting.

Acceptance: the fixture presents the corrected coverage conclusion once, retains the old claim only as labeled provenance, keeps distinct findings separate, and preserves all source records.

## Phase 3: Contract-aware verification of fixes and tests

Primary targets: verifier prompt/schema, src/pipeline/verifier.ts, compact finding updates, composition input projection.

- [x] Instruct verification to distinguish proof of the defect from proof that a proposed remedy is compatible with the caller-visible invariant.
- [x] When endorsing a fix, inspect the relevant caller/spec and resulting invariant using existing tools and budget. Scope this to the proposed behavior change; do not add a mandatory separate model call for every candidate.
- [x] For a regression test, check that its input reaches the problematic boundary and its expected result expresses the intended contract, rather than asserting the existing incorrect behavior.
- [x] Define separate optional assessments for the final suggestedFix and suggestedTest: supported, incompatible, or unverified, with rationale and source-backed evidence locations. Missing assessment means unverified, never supported; absent suggestions require no assessment. Missing optional assessment alone must not trigger repair or fail an otherwise valid finding.
- [x] Bind each assessment to the exact post-expansion suggestion it evaluates. Apply compact/full finding revisions first, then associate assessment with final text; later changes must invalidate or re-evaluate stale support. A supported fix does not automatically make its test supported, or vice versa.
- [x] Carry assessments explicitly through verifier verdicts, verified findings, grouping, composition projections, fallback rendering and artifacts. Do not infer support from prose or take the most favorable assessment across differently worded suggestions.
- [x] Propagate assessments into composition and deterministic fallback. Preserve incompatible suggestions in provenance but exclude them from endorsed remedies. Qualify unverified alternatives or withhold them. The renderer must consistently label unverified recommendations; a composer cannot upgrade them merely by citing their source IDs.
- [x] Source references permit supported suggestions to be summarized, not new remedy semantics to be invented. If composition introduces a substantively different proposal, it is not covered by the original assessment. Document that structural validation cannot fully establish paraphrase equivalence; use conservative prompts, explicit qualification and regression/manual review rather than claiming an infallible semantic gate.
- [x] If multiple supported options remain, explain the meaningful tradeoff. If insufficient evidence distinguishes them, state that limitation rather than choosing with unjustified confidence.
- [x] Preserve verified findings even when the remedy is unknown. Do not conflate an unavailable caller lookup with a failed defect investigation when the defect itself is already established.
- [x] Keep source material untrusted and prohibit fix assessment from authorizing repository mutation.

Acceptance: for the minimum-output fixture, the report cannot unconditionally recommend lowering the guaranteed output below the required amount. It retains the established defect and recommends only a supported remedy or an explicit unresolved choice.

## Phase 4: Validation, telemetry and measurement

- [x] Add focused unit/integration tests for source accounting, section uniqueness, source-backed evidence selection, rendered reconciliation, preserved material uncertainty, compact updates, cache replay and legacy artifacts.
- [x] Test that a source ID alone cannot authorize deleting contradictory evidence or promoting an unverified remedy.
- [x] Test fallback rendering and multiple Markdown details blocks without losing or accidentally exposing provenance through malformed nesting.
- [x] Record main narrative length, provenance size, source-accounting coverage, composition mode, and remedy assessment outcomes. Keep these distinct from semantic correctness.
- [x] Run pnpm test, pnpm run check, pnpm run build and git diff --check.
- [x] Review the generated fixture report as a human would: one diagnosis, clear impact, supported recommendation/test, key proof, visible limitations and accessible full evidence.

## Phase 5: Controlled composition reasoning experiment

- [ ] Reuse the existing runner/eval infrastructure with a small offline-input script or fixture entry point; avoid building a general experiment framework. Reuse the same saved verified inputs, source inventory and prompts at the current one-tier-lower effort versus configured effort. Disable response-cache reuse across experimental conditions and record prompt/schema/runtime/model/routing provenance.
- [ ] First evaluate presentation/verification changes at unchanged reasoning. Then vary reasoning alone; do not simultaneously change prompts and attribute the result to effort.
- [ ] For each condition, assess conclusion accuracy, resolved versus unresolved contradictions, contract-compatible remedies/tests, source fidelity, repetition, visible length, latency, cost, repair count and deadline/fallback behavior.
- [ ] Preserve the existing attempt/overall deadlines. A higher-effort output that routinely misses them is not automatically an improvement.
- [ ] Use more than one generation when feasible and authorized; report variability rather than treating one sample as proof.
- [ ] Replaying composition cannot establish investigation improvements or recover absent caller evidence. Use a later full eval, separately, to assess Phase 3.
- [ ] Change the default reasoning policy only if the measured benefit justifies cost and latency. Otherwise retain the current tier reduction.

## Completion criteria

- [x] Required source material and attribution remain intact, with material caveats visible.
- [x] The reader receives one reconciled conclusion per issue rather than an accumulation of worker prose.
- [x] Fix/test recommendations carry appropriate contract support or qualification.
- [x] Report summaries contain no internal accounting chatter; repeated source details are retained as provenance.
- [x] Strict validation, bounded repair, cache behavior and honest fallback/fidelity reporting remain intact.
- [x] Tests and checks pass; available baseline comparisons and remaining limitations are documented. Outstanding run-92 analysis or an unauthorized/deferred live experiment is recorded separately and does not hold Phases 1–4 open.
- [x] Any reasoning-policy decision is supported by a controlled experiment, or explicitly deferred without blocking the reporting improvements.

## Implementation notes and deviations

Review completed against the run-91 raw composition and current renderer/verifier contracts. Refined the plan before implementation:

- Omitted optional remedy assessments default to unverified and do not create schema-repair obligations.
- Assessments bind to the final revised suggestion and remain separate for fix versus test.
- Reconciliation supports attribution, not automatic proof or authority to erase essential uncertainty.
- Assessment handling covers deterministic fallback and legacy inputs, not only successful LLM composition.
- Prominent evidence initially selects whole source components; no new excerpt protocol or general experiment framework.
- Run 92 and the later paid reasoning comparison do not block implementation.

Implemented Phases 1–4. No private-eval mutations or paid experiments performed.

### Implementation and validation

- Live composition now authors sections only (at most one per kind); legacy `finalBody` artifacts retain an explicit source-based fallback. Exact accounting includes retained-only sources, while primary evidence selection is independently bounded to three existing components.
- Composed verification is rendered directly. Original records remain in expandable provenance, with source IDs, reconciliation labels and optional remedy assessments. Structured unresolved assumptions and severity disagreement remain visible. Reconciliation validates attribution, not semantic equivalence.
- Separate optional fix/test assessments bind to the exact expanded suggestion. Missing, stale or unsupported-without-evidence assessments become unverified locally; they do not start repairs or invalidate the defect. Incompatible suggestions cannot supply endorsed fix/test sections. Both successful and fallback reports use these rules.
- Verifier and composer prompts, schema versions and runner cache behavior version were updated. Existing repair counts, shared deadlines, provider routing and reasoning policy are unchanged.
- Both composed and fallback presentation metrics are recorded in telemetry and `composition-sources.json`: narrative/primary/provenance words, full source coverage, primary evidence count and suggestion statuses. Source-based fallback remains explicitly labeled.
- Added sanitized fixtures and regressions for the stale coverage claim, incompatible lower-output remedy, independently unverified test, compact revision binding, differing severity, distinct issue identities, evidence accounting, essential uncertainty, legacy schema reading and malformed Markdown/HTML boundaries. Existing real-Pi integration and cache tests pass under the updated contracts.
- `pnpm test`: **1,079 tests across 53 files passed**. `pnpm run check`, `pnpm run build` and `git diff --check` passed. Reviewed the deterministic preview generated by `pnpm exec tsx scripts/preview-composition.ts`; all 18 fixture source components remain accounted for. This is a handcrafted fixture, not a model quality measurement.
- Offline fixture/preview entry point is available at `tests/fixtures/composition/contract-review.ts` and `scripts/preview-composition.ts`; comparison procedure is documented alongside the fixture. The paid runner experiment in Phase 5 remains deferred, including an executable two-condition model harness. No default reasoning change is justified yet.

### Run 92 pre-change baseline

Run 92 finished on `db1ea55` before these changes: **pass**, complete review, two inline findings, 12m46s, 88 model calls, $0.369733. Composition took 1m34s; verification took 4m03s. Recovery fidelity was preserved, composition non-degraded. The metrics report three repair attempts and no terminal schema-recovery failure.

Its findings were the EXACT_OUTPUT truncation defect and a separate denomination-contract confirmation concern; the boundary-test gap was incorporated into the defect rather than published as the second finding. The latter confirmation concern explicitly says it is not automatically a bug, which limits the meaning of the report's “verified issues” label.

The bug explanation includes a correct non-divisible numeric example and recommends ceiling conversion first, but still offers lowering the published minimum and leaves downstream requirements unresolved. It improves on run 91's test that pins reduced output, yet does not match run 67's explicit downstream `tokenMinBalance` contract proof. It resembles run 83 in this remaining remedy uncertainty. Raw report length is 2,432 words (83: 2,431; 91: 3,710; 67: 1,329), including provenance; run 92's visible impact paragraph is still long. These are observations across different revisions, not controlled model comparisons.

### Remaining limits and deliberate deferrals

- The harness checks structured support status and source attribution; it cannot prove that a model's caller-contract assessment or paraphrase is semantically correct. Full evals must assess whether models use the new instructions effectively.
- Material uncertainty supplied as structured proof assumptions is carried into the primary view deterministically. Detecting contradictions or omitted caveats expressed only in arbitrary prose still depends on model reconciliation and review; no heuristic semantic deletion was introduced.
- The live reasoning comparison and subsequent full eval are separate measurements. Use identical saved inputs and prompts for the effort comparison; composition replay cannot create caller evidence that investigation never gathered.
- Changes were initially left unstaged as requested. The owner subsequently requested a commit checkpoint before GLM run 94; Plan 118 remains unimplemented pending that comparison.
