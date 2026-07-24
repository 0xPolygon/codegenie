# Issue 101: Exact Skill Provenance and Evidence-Gated Bundled-Skill Revision

Status: PENDING
Related: Plan 95 (prompt/skill WHY ledger), Plan 98 (Rust/Python/Solidity/JavaScript language support and owner matrices), Plan 99 (language-support correctness follow-up), and the open PUNCHLIST eval-diversity guard.
Planned from: owner review of the bundled skills and Stage-7/Stage-9 prompt artifacts, 2026-07-24
Planned at: commit `8bd6d7e` (branch `next`)
Recommended priority: fix provenance before running or trusting any bundled-skill comparison; then land only the language-content changes that pass the semantic gates in this plan.

## Outcome

Stage 9 must verify a candidate with the exact skill set that actually contributed guidance when the candidate was generated, not merely the skill set currently attached to the packet's first lens. Every current candidate-producing path must write that latest provenance format; `lensId` is attribution only and there is no lens-based compatibility fallback. With that measurement foundation fixed, revise the bundled language skills around one common evidence rubric, remove cargo-cult `# Examples` sections, correct objectively stale or mismatched examples, and gate every inventory addition/removal on semantic positive/negative eval evidence.

This plan deliberately does **not** deduplicate JavaScript guidance into TypeScript or vice versa. A JavaScript hunk projects `lang/javascript`; a TypeScript/TSX hunk projects `lang/typescript`. Similar guidance in those two independent prompts has no runtime prompt cost and is preferable to a shared skill that makes either language less self-contained. The overlap worth measuring is overlap among skills that coexist in one prompt, especially a language skill plus `core/code-review` and `core/tests`.

## Evidence

### Stage 7 and Stage 9 currently disagree about which skills produced a candidate

- `runPacket` in `src/pipeline/lens-runner.ts` builds one Stage-7 prompt from every language-compatible skill attached to every `packet.lenses` entry. `projectSkills` then deduplicates those skills by id and may truncate or omit them under the projection caps.
- `mapSubmittedFinding` preserves `packet.lenses[0]` as `producedBy.lensId`, but stamps only the language-compatible skills currently attached to that one primary lens into `producedBy.skillIds`. It therefore does not describe the composite Stage-7 prompt.
- `verifyCandidate` in `src/pipeline/verifier.ts` ignores `candidate.producedBy.skillIds` and reloads `skillsForLens(candidate.producedBy.lensId)`. A language-primary packet can consequently receive language guidance plus both core skills in Stage 7, then only the language skill's false-positive/safe-pattern guidance in Stage 9.
- Stage 8 has the same shape: `runSystemReviewTask` projects all `suggestedLenses`, while `stampSystemFinding` records the first lens and an empty `skillIds` list.
- The normative interface in `specs/project/components/skills_llm_telemetry.md` already says `skillsById(ids)` resolves `producedBy.skillIds` and that verifier skills come from that list. A later schema paragraph instead says Stage 7 stamps the primary lens's skill ids. The implementation and spec are internally contradictory.

This is a measurement blocker, not merely an attribution nicety. A language-skill edit can appear to improve or regress final findings because Stage 9 received a different set of false-positive rules, not because the edited skill changed Stage-7 recall or precision.

### `# Examples` is optional machinery that several bundled files treat as a required ritual

- The loader recognizes five headings but requires only that at least one of `Checks`, `False Positives`, `Safe Patterns`, or `Examples` be non-empty. It does not require an Examples section.
- Stage 7 includes Examples when a skill has them; Stage 9 does not. Retaining the optional projection surface is useful for repo-local and future skills with genuinely distinct worked cases.
- JavaScript, Python, Rust, and Solidity already put an unsafe example and distinct safe counterexample inside every numbered check. Their final Examples sections only say, in effect, "use the checks above." They add no decision information.
- The language owner tests and old normative template require all four guidance headings, which is why the redundant sections exist. That test requirement is stronger than the loader or review design and should be corrected.
- Go and TypeScript still use the older split form: broad check bullets plus a separate small Examples section. Once their retained checks carry inline owner matrices, the separate sections become redundant there too.
- The two core skills are different. Their Examples sections contain concise, distinct scenarios that instantiate broad cross-language checks. They should remain unless a measured comparison shows they are harmful.

Rule for bundled skills after this plan: use an inline unsafe/safe pair for a narrowly owned check **or** a separate Examples section for distinct worked cases; do not encode the same point both ways. `# Examples` remains a supported optional heading, not a mandatory heading and not a forbidden one.

### Current evals do not justify broad language-inventory tuning

- `evals/fixtures/README.md` explicitly states that the fake runner proves transport and anchoring only. A `CODEGENIE_FAKE_FINDING` fixture cannot show that a language check improves model recall or precision.
- JavaScript and Rust have recorded real-model owner smokes with buildable positive failures and marker-free controls. Those are useful regression anchors but are synthetic and do not close the PUNCHLIST second-language, second-real-repository guard.
- TypeScript's WHY-ledger entry says the whole skill is live but never eval-validated. Python and Solidity have owner-matrix structure and evidence rationale, but their public cases remain structural/fake transport cases rather than semantic skill comparisons.
- Go has strong production evidence for validation-before-lossy-conversion and historical model bands. That evidence should be preserved during a format rewrite; it does not justify silently adding unrelated Go checks.

### Stage-specific projections expose two existing content defects

- Stage 9 projects only `False Positives` and `Safe Patterns`. Several bundled sections are compressed cross-references to Checks that the verifier cannot see: Python says risky syntax needs "the matching concrete failure," Rust uses similar language, and core guidance refers to "this guard" without projecting the check that defines it. Correct provenance alone does not make those fragments independently understandable.
- Solidity already exceeds the Stage-8 per-skill cap. At the planning commit, `projectSkills([lang/solidity], 8)` delivers 3,955 characters and reports 223 truncated characters; Stage 7 delivers 3,957 with no truncation, and Stage 9 delivers 493 with no truncation. Existing Plan-98 owner tests assert untruncated Stage-7/9 projections but do not build or inspect Stage 8. This is a live silent-projection defect that the content revision must remove before Stage-8 results can be treated as fully guided.

## Design

### 1. Make projected skill ids the source of truth

Keep the meanings separate:

- `producedBy.lensId` is the primary-lens attribution key. It remains the packet/task's first lens for artifact continuity, grouping, and human explanation.
- `producedBy.skillIds` is the ordered, deduplicated list of skills that actually contributed non-omitted guidance to the producing prompt.

Derive the list from `BuiltPrompt.projection.perSkill`, not by querying the registry a second time. A skill id is recorded when its projection entry has `omitted: false` and contributes characters. A per-skill-truncated projection still counts because some of that skill reached the model; a total-cap-omitted skill does not. Preserve projection order and unique ids.

Apply that rule to every producing output:

1. Stage 7 builds the composite prompt and extracts its projected skill ids once per pass. Pass that immutable list into every direct finding stamped from that model result.
2. Add required, pipeline-stamped `projectedSkillIds: string[]` to each normalized Stage-7 follow-up hint and `StructuredUncertainty`. These fields are excluded from the model submit schema just like finding producer fields; the pipeline stamps them from the actual pass prompt after validating the model-authored content.
3. Ensemble/adaptive pooling keeps provenance on the specific surviving finding, hint, or uncertainty. Direct findings already retain their own `producedBy.skillIds`; question deduplication retains the chosen hint/uncertainty object and its `projectedSkillIds`. Do not require cross-pass lists to match, union them, or place one ambiguous skill list on the merged `PacketReviewResult`.
4. Uncertainty-promotion candidates inherit the selected source hint/uncertainty's `projectedSkillIds`. They are pipeline-created candidates from a predicate authored under that exact Stage-7 pass prompt, so they must not manufacture empty provenance or re-derive current lens membership.
5. Stage 8 extracts the targeted system-review prompt's projected ids and stamps them into each direct system finding. Current Stage-8 resolved hints do not become candidates, so they need no candidate-skill carrier.

Stage 9 resolves guidance with this algorithm:

```ts
const recordedIds = candidate.producedBy.skillIds
const originSkills = lensRegistry.skillsById(recordedIds)
const skills = skillsCompatibleWithLanguage(originSkills, candidateLanguage)
```

Strictness and safety rules:

- `FindingProducer.skillIds` remains required. Every current producer and fixture is migrated; a runtime-missing field is malformed provenance, not an invitation to infer from `lensId`.
- Stage-7 follow-up hints and structured uncertainties likewise require pipeline-stamped `projectedSkillIds`; model-authored payloads never choose or claim those ids.
- The recorded list is authoritative even when empty. Empty means no skill contributed to the producing prompt, so Stage 9 projects no skill guidance.
- Unknown/stale ids are dropped, as `skillsById` promises. Do not replace them through current primary-lens membership when some or all ids are unknown.
- Reapply the candidate/packet language filter at Stage 9 as defense in depth. Exact provenance must not bypass language isolation.
- `producedBy.lensId` remains available for attribution, artifact explanation, and grouping, but Stage 9 never calls `skillsForLens(candidate.producedBy.lensId)`.
- Emit one structured provenance event per verifier call (or add the equivalent fields to existing call telemetry) with requested ids, resolved ids, and dropped ids. Do not put repository content or model reasoning into this event.
- Keep `FindingProducer.skillIds` as the persisted carrier. No new model-authored schema field and no chain-of-thought provenance are introduced.
- Preserve historical logs as immutable evidence. Current `--from-artifacts` behavior re-scores saved candidates/finals and does not rerun Stage 9, so it needs no live fallback. If re-verifying historical candidates becomes a supported feature, design an explicit versioned migration that records its approximation; do not hide that migration inside the verifier.
- Render the Stage-9 skill-guidance block conditionally. When `projection.text` is empty, omit the entire `Skill false-positive guidance:` part rather than sending a label with no content:

```ts
const skillGuidance = projection.text.length > 0
  ? `Skill false-positive guidance:\n${projection.text}`
  : ""
```

Pin the following behavior in tests:

- A TypeScript packet whose primary lens is `lang/typescript` and whose composite Stage-7 prompt projects `lang/typescript`, `core/code-review`, and `core/tests` stamps all three ids; Stage 9 projects the applicable false-positive/safe-pattern sections for all three and excludes JavaScript.
- A skill shared by two selected lenses is projected and recorded once, in first-projection order.
- A total-cap-omitted skill is absent from `skillIds`; a per-skill-truncated but non-empty skill is present.
- A Stage-8 task with multiple suggested lenses stamps its actual projected set and Stage 9 replays it.
- Non-empty provenance does not gain a skill later added to the primary lens, proving registry drift cannot broaden verification.
- Unknown ids are reported and dropped without fallback; language-incompatible recorded skills are filtered.
- Empty provenance produces a verifier prompt with no skill sections, no `## Skill:` header, and no `Skill false-positive guidance:` label, regardless of `lensId`; runtime-missing provenance is rejected by the relevant validation/test boundary.
- Hints and uncertainties from different ensemble/adaptive passes retain their individual projected ids through pooling/deduplication, and each promoted candidate inherits only its selected source item's list.
- Synthetic fixtures that need verifier guidance name the intended ids explicitly instead of relying on `lensId`; unrelated fixture candidates may intentionally use an empty list.
- Candidate, hint, and uncertainty artifact serialization/replay preserves their non-empty ordered skill-id lists byte-for-byte.

Corrected provenance selection alters dynamic Stage-9 prompt bytes for affected candidates, so it establishes a new measurement regime even without a registry-hash change. The cache already keys on request/prompt content; do not bump `p7`/`p8`/`p9` solely for corrected input selection. Conditionally omitting the empty Stage-9 guidance block **does** change provider-facing prompt construction, so bump `p9` when that behavior lands. If the same empty-block cleanup is generalized to Stages 7 or 8, bump `p7` or `p8` respectively.

### 2. Standardize the language-skill content contract

Every retained numbered language check should own five independently reviewable fields:

1. **Failure:** the observable runtime, state, liveness, asset, authority, or contract failure.
2. **Materiality:** the required reachability/producer-to-consumer evidence and an impact-based severity rule.
3. **Unsafe:** one compact example that actually demonstrates the failure predicate.
4. **Safe:** a distinct counterexample that preserves the same relevant contract, API shape, or computation.
5. **Mitigation:** the general repair rule, separate from merely copying the safe example.

Additional standing rules:

- Syntax is evidence, not a finding. Require a reachable consequence and name the affected observer or contract.
- Safe examples must solve the stated failure without silently changing the public API, return contract, units, computation, or threat model.
- `False Positives` and `Safe Patterns` must each be understandable when projected without Checks or Examples, because Stage 9 receives only those two sections. Name the relevant failure predicate or safe invariant directly; do not use dangling references such as "the checks above," "the stated materiality rule," "this guard," or "the matching concrete failure."
- Version- or configuration-sensitive checks must name the applicable version/configuration and be supportable from repository evidence.
- Keep each language skill self-contained. Do not create a shared ECMAScript skill merely to remove JavaScript/TypeScript textual similarity.
- Do not remove a language check merely because a core skill discusses the same broad topic. Measure whether same-prompt repetition changes recall, verifier precision, or cost.
- Preserve the 4,000-character per-skill and 12,000-character total caps. Every bundled skill must be individually untruncated at every stage where it projects, and canonical default composite prompts must remain untruncated at Stages 7, 8, and 9. Arbitrary planner/model-selected many-lens combinations may still exercise the intentional total-cap degradation path; test that path as disclosed truncation rather than pretending every possible combination fits.
- Owner tests must inspect the actual Stage-9 projection for standalone meaning. A small dangling-reference heuristic may guard known phrases, but it is a regression tripwire rather than proof of semantic self-containment; retain explicit per-skill content assertions and owner review.
- Update `BUNDLED_SKILL_WHY_LEDGER` for every materially changed, added, merged, or removed surface. Replace TypeScript's whole-skill placeholder with evidence-bearing entries only after its semantic baseline exists.
- Do not churn frontmatter `categories`. They are loaded and stored but currently have no review-behavior consumer; category taxonomy work is separate scope.

### 3. Language-by-language disposition

The initial candidate revision may correct facts, remove redundant prose, and put retained checks into the owner format. Check inventory changes remain conditional on Section 4's semantic gate.

| Skill | Initial revision | Measurement-gated follow-up |
| --- | --- | --- |
| `core/code-review` | Preserve the current checks, false-positive rules, safe patterns, and distinct Examples. In particular, retain the evidence-backed caller-visible transformed-guarantee check and its dust/severity guards. Audit whether core False Positives or Safe Patterns contradict or obscure language-specific guidance now co-projected at Stage 9; change core content only when a concrete conflict is demonstrated. | Add, merge, or remove core checks only with a cross-language semantic case showing a recall/precision effect. Do not owner-matrix-expand every broad core bullet by default. |
| `core/tests` | Preserve the current boundary-versus-helper replacement check and its distinct Examples. This content has production eval lineage and should not be reformatted for visual uniformity. | Revisit only if the existing Go/DeFi band or a new semantic boundary-coverage case moves. |
| `lang/go` | Rewrite the existing nine checks into the five-field owner matrix without broadening the inventory. Preserve the proven validation-before-lossy-conversion check and its ordering. Embed examples beside their owning checks, then remove the separate Examples section. Require concrete ownership/lifetime/conflicting-access evidence for goroutine, context, channel, slice, and mutex reports. | Add/remove/merge only after a dedicated semantic control. Do not add version-blind loop-variable capture advice: Go 1.22 changed `for`-loop variable semantics, so any future check must inspect the module language version and exact loop form. Run the existing lossy-conversion production case across the rewrite. |
| `lang/javascript` | Keep the eight-check owner matrix and JavaScript-only identity. Replace the module-interop unsafe example: `require("esm-only")` is not inherently a failure on current Node runtimes that can synchronously load eligible ESM. Require a concrete shipped Node/bundler mode, export-map/default-vs-namespace shape, or top-level-await incompatibility. Remove the tautological Examples section. | Use the accepted floating-promise owner smoke as a regression anchor. Change inventory only for a new JavaScript semantic pair; TypeScript similarity is not a reason to merge or trim it. |
| `lang/typescript` | After baseline measurement, rewrite retained checks into the five-field owner matrix and remove the separate Examples section. Give distinct ownership to promise completion, erased runtime proof (`any`/assertions), unjustified absence assertions/indexed lookup, closed-union exhaustiveness, multi-promise failure/cleanup behavior, coercion/truthiness, shared mutation, and unvalidated external boundaries. Explicitly exclude intentional contained detachment, post-validator narrow assertions, and intentionally open string sets. | The current floating-promise/async-error pair and cast/runtime-validation pair may be redundant **within the same prompt**; merge only if an isolated semantic comparison preserves recall and improves precision/cost. Candidate additions under the same dedicated semantic-pair gate: lost receiver (`this` extraction), leaked lifecycle work (listeners/timers/subscriptions), and unsafe dynamic property/prototype handling. These are TypeScript runtime hazards, not reasons to co-project or merge `lang/javascript`; lifecycle and dynamic-property candidates must also prove value beyond core guidance already present in the same prompt. Consider `noUncheckedIndexedAccess` or `exactOptionalPropertyTypes` guidance only with a config-aware case that proves value. |
| `lang/python` | Keep the initial eight-check inventory, remove the tautological Examples section, and repair mismatched examples: use `None` allocation for mutable defaults without changing list-return API; rename the `None` check to unchecked optional dereference or show a real non-optional contract violation; make exact-unit safe/unsafe examples perform the same computation; scope TOCTOU claims to what one descriptor proves and name `dir_fd`/no-follow needs when identity/containment matters; state that `shell=False` prevents shell parsing but does not by itself validate target-specific option/argument grammar. | Add/remove only after the Python semantic pair and a check-specific control. Do not add generic style/type-hint guidance. |
| `lang/rust` | Keep the seven-check owner matrix and its inventory. Remove the tautological Examples section; correct only a demonstrably inaccurate unsafe/safe pair. Preserve compiler-rejected-code and invariant-proven false-positive exclusions. | Integer overflow is a plausible future check because profiles differ in panic/wrapping behavior, but add it only with a profile-aware semantic pair. Re-run the accepted panic-path owner smoke after projection/provenance changes. |
| `lang/solidity` | Keep the initial nine-check inventory for the first comparison, remove the tautological Examples section, and correct objective mismatches. Oracle safety must validate positive answer, nonzero/not-future `updatedAt`, feed-specific freshness, and units/decimals; do not rely on deprecated `answeredInRound`. Apply L2 sequencer checks only where the deployment/feed requires them. Narrow low-level-call safety: `require(ok)` propagates call failure but does not prove code existed, a required return value was true, or the intended effect occurred. Narrow the typed-reverting-call false-positive rule to calls whose actual contract guarantees reversion/validated return semantics. Replace the oversized homemade delegatecall "safe" example with a smaller, qualified storage-layout/authorized-target invariant rather than presenting shared inheritance as universally safe. The candidate must eliminate the live Stage-8 truncation and target at most 3,800 rendered Stage-8 characters (at least 200 characters of per-skill headroom). Prefer smaller, readable predicate examples over minified full-contract programs. | Evaluate initialization/reinitialization takeover, arbitrary call/delegatecall authority, signature replay/domain/nonces, gas-unbounded state iteration, and upgrade-storage compatibility as candidate additions. Evaluate required-event omission and repeated-full-`msg.value` as possible lower-yield removals. No inventory rebalance lands without a dedicated Foundry positive/control pair and A/B evidence. |

Objective reference baseline for implementers:

- Node.js CommonJS/ESM loading: <https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require>
- TypeScript compatibility/config behavior: <https://www.typescriptlang.org/docs/handbook/type-compatibility> and the official `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` option references.
- Go 1.22 loop semantics: <https://go.dev/doc/go1.22#language>
- Chainlink `latestRoundData`: <https://docs.chain.link/data-feeds/api-reference#latestrounddata>
- Solidity security considerations: <https://docs.soliditylang.org/en/latest/security-considerations.html>
- OpenZeppelin upgradeable-contract guidance: <https://docs.openzeppelin.com/upgrades-plugins/writing-upgradeable>

Use these primary sources to correct facts, but do not turn their full checklists into bundled-skill inventory without eval evidence.

### 4. Add semantic positive/negative skill evals

Create a dedicated suite separate from `evals/fixtures`; the existing public fixture suite remains the fast fake transport/language-routing gate. The new suite contains no `CODEGENIE_FAKE_FINDING`, prompt-like comments, or model-trigger markers.

Each semantic case is a small buildable repository with one base and one feature revision and must satisfy all of the following before any paid/model run:

- The base builds and its focused regression test passes.
- The feature builds.
- The feature's positive regression test fails for the exact review predicate named in `should_find`; the failure is reproducible with one documented command and pinned toolchain version.
- A nearby marker-free negative control uses similar syntax but preserves the invariant; its focused test passes and `should_not_find` targets its path/symbol.
- The diff is small enough that the relevant product code and test fit in full packet context without truncation. Assert the canonical language, enclosing symbol, relevant-test link, selected lenses, and projected skill ids.
- Expectations describe the failure mode, not wording from the skill. A semantically correct finding may use different language.
- The review runs in non-posting eval mode. Paid/provider runs require explicit owner authorization and record model, provider, reasoning, depth, cache setting, registry hash, template versions, commit range, cost, time, candidate outcome, verifier outcome, and final outcome.

Minimum foundation cases:

| Language | Positive feature regression | Negative control |
| --- | --- | --- |
| TypeScript | Replace runtime validation of parsed configuration with an `as Config` assertion; malformed input reaches a typed consumer and the existing focused test fails. | A similar assertion occurs only after a trustworthy validator and the validated value flows forward; invalid input still fails at the boundary as intended. |
| Python | Introduce a mutated list default whose state leaks into a later call; a two-call test fails. | A mutable-looking/default pattern is immutable or never mutated, or per-call `None` allocation preserves the list-return contract; the analogous test passes. |
| Solidity | Remove required freshness validation from a price-feed consumer; a mock stale round is accepted and the Foundry test that expects rejection fails. | A consumer checks positive answer, nonzero/not-future timestamp, feed-specific staleness, and declared units without the deprecated `answeredInRound` condition; its fresh/stale tests pass. |

These three synthetic semantic cases improve skill calibration but do **not** close the open second-language, second-real-repository PUNCHLIST item. Keep that guard open until at least one real external TypeScript or Python repository case is recorded.

For every proposed inventory addition/removal, add a check-specific positive/control pair before changing the file. A generic language foundation case cannot justify an unrelated new check.

### 5. Compare old and revised skills under one controlled protocol

Use three local refs/worktrees; do not publish intermediate skill experiments:

1. **Foundation ref:** provenance fix plus semantic fixtures, with current bundled-skill content.
2. **One-skill candidate refs:** foundation ref plus only the candidate language file, its WHY-ledger entry, and content-gate expectations. This isolates each language decision.
3. **Integration ref:** foundation ref plus every accepted revision, squashed into the intended final skill-content unit.

Run with cache disabled for behavioral comparisons. Pin code, fixture refs, model/provider, reasoning, review depth, budgets, lens set, and concurrency. Skill text legitimately changes the Stage-5 summary and registry hash, so compare the complete pipeline and classify every expected issue at candidate generation, verifier keep/reject, and final composition rather than looking only at final F1.

For the small TypeScript/Python/Solidity semantic cases, pre-register at least three uncached draws per arm on one owner-approved primary model. Three draws are an initial screen, not statistical proof: any split/non-unanimous outcome is ambiguous and must trigger a pre-registered extension (for example, three additional draws per arm) or a confirmatory model/provider arm rather than choosing the preferred prose by intuition. Re-run the existing JavaScript and Rust owner smokes once after provenance and once on the integrated content ref. Re-run the Go lossy-conversion production case against the Go candidate; if full production runs are cost-prohibitive, obtain owner agreement on a smaller semantic reproduction before accepting the rewrite.

Record, per expectation and draw:

- positive candidate generated or missed;
- verifier kept, revised, rejected, gated, or incomplete;
- final expectation matched or lost at composition;
- negative-control candidate generated, verifier disposition, and any final false positive;
- prompt skill ids, omitted/truncated sections, prompt/token/tool cost, schema friction, completeness, and runtime.

Decision rules:

- **Objective factual correction:** may proceed without proving a recall lift, but must preserve buildable safe/unsafe semantics, language isolation, full projection, and show no repeated regression in the relevant semantic/owner smoke.
- **Format-only owner-matrix rewrite:** lands only when positive final recall is non-inferior, final negative-control precision is non-inferior, and it does not create a repeated Stage-7 negative candidate/cost regression.
- **Add a check:** requires improved positive candidate/final recall on its dedicated case, no final negative-control finding, no repeated verifier-rejected negative churn, and a new evidence-bearing WHY-ledger entry.
- **Remove or merge a check:** requires no positive recall loss across its dedicated cases and either less negative churn/cost or clear same-prompt redundancy. Cross-language JavaScript/TypeScript similarity does not qualify.
- **Ambiguous result:** keep the current inventory and record the proposal as unproven. Do not tune to a single favorable draw.

### 6. Treat cache/provenance boundaries explicitly

Land in this order:

1. Provenance implementation, compatibility tests, telemetry, and normative correction. This is the mandatory pre-measurement boundary.
2. Semantic fixtures and their deterministic build/failure proofs, without bundled-skill content edits.
3. Current-skill baseline runs at that foundation ref.
4. Isolated local candidate comparisons.
5. One reviewed integration commit containing only accepted bundled-skill/WHY-ledger/content-gate changes plus synchronized docs.

The final content commit changes skill `contentSha`, `LensRegistry.registryHash()`, Stage-5 summaries where Checks text changes, and downstream prompt bytes. Prefer one externally visible integration boundary after isolated local experiments. If languages are intentionally landed separately, record each external commit as a distinct non-comparable registry/cache regime. A branch push, merge, tag, npm publication, and GitHub release remain separate events and must not be conflated.

## Non-Goals

- No bundled-skill edits or provenance implementation in this planning change.
- No shared ECMAScript skill and no JavaScript/TypeScript prompt co-projection.
- No parser, tree-sitter adapter, language detection, or likely-test expansion.
- No category/frontmatter taxonomy cleanup.
- No automatic execution of reviewed-repository commands by the review product; semantic fixture build commands are trusted test/owner-validation steps, not new model tools.
- No claim that synthetic semantic fixtures satisfy the outstanding real-repository eval-diversity guard.
- No broad import of external security checklists and no language inventory changes justified only by documentation authority.

## In-Scope Files

- `src/pipeline/lens-runner.ts` — stamp Stage-7 projected skill ids.
- `src/pipeline/system-reviewer.ts` — stamp Stage-8 projected skill ids.
- `src/pipeline/verifier.ts` — strict recorded-id resolution, language filtering, and provenance diagnostics; `lensId` is never a skill-selection input.
- `src/skills/prompt-builder.ts` — shared projected-id helper if needed; conditional omission of the empty Stage-9 skill-guidance block with a `p9` bump; revised bundled-skill WHY ledger. Other provider-facing prompt wording is unchanged unless an eval proves a need.
- `src/types.ts` — required pipeline-stamped `projectedSkillIds` on Stage-7 follow-up hints and `StructuredUncertainty`; `FindingProducer` keeps required `skillIds` as the candidate carrier. Do not add one provenance list to the pooled `PacketReviewResult`.
- `bundled-skills/core/*.md` — audit/pinning only; no planned content rewrite.
- `bundled-skills/lang/{go,javascript,typescript,python,rust,solidity}.md` — accepted content revisions described above.
- `tests/verifier.test.ts`, Stage-7/Stage-8 pipeline tests, bundled-skill owner tests, shared projection/ledger tests, and artifact replay tests.
- A new semantic skill eval suite and fixture repositories under `evals/`, plus focused deterministic fixture-validation tests/scripts. Keep `evals/fixtures` as the fake transport suite.
- `specs/project/architecture.md`, `functional_spec.md`, `project_overview.md`, `components/skills_llm_telemetry.md`, `components/review_pipeline.md`, and `components/evals.md`; regenerate affected `specs/project/html/` files.
- `specs/plans/PUNCHLIST.md` — link Plan 101 while retaining the real-repository diversity item as open.
- `specs/plans/README.md` — Plan 101 index row.

## Implementation Steps

1. Add a projection-derived skill-id helper and unit tests for order, deduplication, truncation, omission, and empty projections.
2. Thread the exact per-pass projected ids through Stage-7 finding stamping and pipeline-stamped hint/uncertainty fields, preserve the selected item's fields through ensemble/adaptive pooling and question deduplication, inherit them in uncertainty promotion, and stamp Stage-8 direct findings. Add a test with intentionally different per-pass skill lists so pooling cannot regress to equality, union, or packet-level approximation.
3. Change Stage-9 resolution to unconditional `skillsById(candidate.producedBy.skillIds)` followed by language filtering. Conditionally omit the complete empty skill-guidance block and bump `p9`. Add empty-list/header-absence, missing-field rejection, unknown-id, registry-drift, Stage-8, item-level promotion, and artifact-replay tests plus provenance telemetry. Prove `lensId` cannot influence verifier guidance.
4. Reconcile the normative provenance contract. Run the focused tests, `pnpm run check`, `pnpm test`, and `pnpm build`; mark the resulting commit as the skill-measurement foundation.
5. Add the TypeScript, Python, and Solidity buildable semantic cases with positive failing regressions and safe marker-free controls. Prove base-pass, feature-build, exact feature-fail, negative-pass, packet context, test links, lens isolation, and untruncated projections. Document/pin `node`/TypeScript, Python, and Foundry versions.
6. Run and record the current-skill baseline on the foundation ref before editing any skill content.
7. Prepare isolated candidate revisions: objective JavaScript/Python/Solidity corrections and redundant-Examples removal; TypeScript and Go owner-matrix rewrites; Rust Examples removal; standalone Stage-9 False Positives/Safe Patterns; Stage-8 projection-budget repairs; and the core conflict audit with no default content churn. Update the WHY ledger and owner tests with each candidate. These are candidate-arm edits: do not apply them to the foundation ref before the current-skill baseline is recorded.
8. Run the controlled per-language A/B protocol. Revert unproven additions/removals/merges; retain the current inventory when evidence is ambiguous.
9. Assemble accepted language changes into the final content integration ref, verify all canonical default Stage-7/8/9 combinations remain language-correct and untruncated, and rerun owner smokes/regression cases.
10. Update the normative skill template so Examples is explicitly optional and distinct, while the Stage-7 projection map continues to include it when present. Synchronize all affected docs and generated HTML.
11. Record registry hashes, commit ranges, model arms, draw counts, outcomes, cost, and the first external visibility event in the plan/PUNCHLIST measurement log.
12. Final gate: `pnpm run check`, `pnpm test`, `pnpm build`, semantic fixture commands, and affected packed-package/installed-consumer tests.

## Acceptance Criteria

### Provenance foundation

- Every new Stage-7 and Stage-8 candidate with skill guidance records exactly the ordered, deduplicated, non-omitted skills in its producing prompt.
- Every Stage-7 hint and uncertainty records the exact producing pass's `projectedSkillIds`; ensemble/adaptive pooling preserves the selected item's list without requiring equality or creating a union, and promoted candidates inherit that list exactly.
- Stage 9 resolves only `skillIds`, drops unknown and language-incompatible entries, and never consults primary-lens membership.
- Empty `skillIds` yields no Stage-9 skill guidance and omits the complete `Skill false-positive guidance:` block; missing provenance is treated as malformed rather than inferred. The `p9` template version is bumped for this provider-facing construction change.
- A language-primary composite packet proves that core false-positive/safe-pattern guidance survives into Stage 9.
- Telemetry makes requested, resolved, and dropped ids inspectable without repository content.

### Skill content

- JavaScript, Python, Rust, and Solidity no longer contain meta-only Examples sections; Go and TypeScript remove theirs when inline owner matrices land. Core Examples remain because they are distinct scenarios.
- Every retained Go/TypeScript and existing owner-matrix language check satisfies Failure / Materiality / Unsafe / Safe / Mitigation independently.
- Every bundled False Positives and Safe Patterns projection is independently understandable at Stage 9, with no dangling dependency on omitted Checks/Examples; owner tests inspect the rendered Stage-9 text and guard known cross-reference phrases.
- JavaScript's module example and Solidity's oracle guidance match current official runtime/API behavior; Python safe examples preserve the contract they claim to make safe.
- JavaScript and TypeScript remain separate, mutually exclusive language projections.
- Every bundled skill is individually untruncated at Stages 7, 8, and 9 wherever it projects; canonical default composite prompts are untruncated and stay under the total cap at all three stages. Intentional arbitrary many-lens degradation remains telemetry-visible and separately tested.
- Solidity's accepted candidate has no Stage-8 truncation and renders at no more than 3,800 Stage-8 characters without sacrificing readable, semantically equivalent unsafe/safe examples.

### Semantic gate

- TypeScript, Python, and Solidity each have a marker-free, buildable base/feature semantic case with a reproducible positive failure and passing safe control.
- Current-skill baselines were captured only after the provenance fix.
- Every landed inventory addition/removal/merge has its own semantic positive/control evidence and satisfies the pre-registered decision rule; unproven proposals remain out of the bundled files.
- The integrated skill revision is non-inferior on positive final recall and negative final precision, with no repeated negative-candidate/cost regression.
- JavaScript/Rust owner smokes and the Go lossy-conversion regression remain green after integration.
- The PUNCHLIST real-repository diversity guard remains open unless a genuinely external second-language repository case is separately recorded.

## Stop Conditions

- If Stage-7/8 stamping cannot be derived from the actual `BuiltPrompt.projection`, stop rather than approximate it with registry membership; approximate provenance would preserve the measurement flaw.
- If any Stage-9 path selects skills through `producedBy.lensId`, stop: that silently broadens or changes the authoritative record and makes verification dependent on current registry contents.
- If any current candidate producer, hint/uncertainty normalizer, promotion path, or test fixture relies on missing provenance as a compatibility signal, migrate it to the required format rather than adding an exception.
- If ensemble/adaptive pooling requires projected-skill equality, unions lists, or replaces item-level provenance with a pooled packet-level approximation, stop and preserve the selected producing item's list instead.
- If the provenance foundation changes final behavior beyond the newly restored originating guidance, inspect prompt artifacts and classify the change before collecting skill baselines.
- If a semantic fixture's base does not pass, feature does not build, positive failure is not exact/reproducible, or negative control does not pass, do not run or cite the model eval.
- If any standalone-section rewrite is applied before the current-skill foundation baseline is captured, the comparison is invalid; restore or recapture the baseline before evaluating candidate content.
- If a proposed check inventory change has only fake-runner, structural, documentation, or single-draw support, keep the current inventory.
- If a safe example changes the API/units/computation/threat model rather than preserving the invariant, correct the example before comparison.
- If a bundled skill is truncated at any applicable Stage 7/8/9 projection, or a canonical default composite exceeds the total cap, shorten/split its prose before landing; do not raise global caps as part of this plan. Do not satisfy the cap by making examples unreadably minified or by deleting an unevaluated check.
- If paid real-model runs are not owner-authorized, complete deterministic fixtures and structural gates, record the measurement step as pending, and do not land measurement-gated inventory changes.
