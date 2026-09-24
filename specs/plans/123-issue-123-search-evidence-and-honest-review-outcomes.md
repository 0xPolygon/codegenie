# Issue 123: Reliable Search Evidence and Honest Review Outcomes

Status: DRAFT — reviewed; implementation pending
Based on: OMSX runs `20260924-150110-7e5144d6` and `20260924-151933-2809b013`, 2026-09-24
Depends on: existing repository tools, bounded budgets, strict verification/composition validation, and plans 118–122

## Objective

Prevent avoidable evidence loss, distinguish operational failure from an absence of confirmed findings, reconcile questions with evidence already collected, and make missing-test findings proportionate to demonstrated consequences. Implement in that order. Keep reasoning settings, budgets, deadlines, repair counts, and provider routing unchanged during measurement.

The governing reporting requirement is: a known harness or provider failure that materially prevents reliable completion must appear at the top of the report, with its available reason. It must never become an unqualified “no findings” or “everything looks good” result. Preserve useful findings from completed work below that notice.

## Evidence and limits

Both runs reviewed OMSX head `d42543c08c1a6f2e11f78469d8ff246aa263d709` against merge base `4280b3f633ac1fff83898d5a922c15ad8221ceb3`, with identical 50,511-character diffs. They were not a controlled model-only comparison: DeepSeek used a clean Codegenie build at `60ab24b474`, whereas Astra used a dirty build at the same commit. Composition used max for DeepSeek and low for Astra, stepped down from medium.

| Observation | DeepSeek 4.1 Flash / max | GPT-6 Astra / medium |
| --- | --- | --- |
| Completion | Complete; no global budget stop | Complete; no global budget stop |
| Elapsed | 10m12s | 1m59s |
| Calls / tokens | 70 / 1,516,926 | 41 / 522,729 |
| Recorded estimated cost | $0.2668 | $3.0319 |
| Schema repairs | Two, both recovered | None |
| Final findings | Two low-severity missing-test findings | None |
| Local refusals | Two in packet review | One in packet review; two in verification |
| Human-attention items | Three | One |

Neither run had a provider outage, model timeout, or composition fallback. These are recorded usage estimates, not independently verified account charges. Their degradation counters predate the unsupported-language accounting correction and are not comparable measures of lost evidence.

### Reproduced defects

1. **Inconsistent path-glob interpretation.** Astra's verifier searched `Statuses|func List` in `apps/api/{data,domain/users}/**`. File listing resolves this glob to 196 files; search returns zero matches because it passes the pattern directly to Git's different glob syntax. Separate directory searches return nine matches, including the downstream implementation. The corrective searches were then refused after eight tool calls, despite 25,810 of 32,000 result characters remaining. The verifier correctly withheld an unsupported conclusion but lacked evidence our tools should have supplied.
2. **Optional metadata removes all search results.** Both runs' automatic symbol searches returned no results after truncation. The enclosing Go `expectedPerms` variable carried its large initializer in a roughly 22,000-character symbol record. The search packer drops records until below its 16,000-character cap. A local experiment omitting the optional signature recovered four `expectedPerms` mentions and 27 `ListProjectAccess` mentions without raising the cap. Match contents and locations should take precedence over verbose surrounding metadata.
3. **Contradictory report outcomes.** Astra's report ends “Everything looks good” despite a retained essential verification question. Both reports call deliberate generated-file exclusions “Incomplete work.” DeepSeek's human-attention section asks whether `ProjectRole` resolves after verification explicitly confirmed its declaration and import.
4. **Different thresholds for testing findings.** DeepSeek promoted two missing invalid-request tests; Astra judged the same test suites meaningful and found no concrete defect in them. This does not prove the proposed tests are useless or every coverage finding false. It exposes the need to distinguish a consequential regression gap from a generic opportunity to add tests.

The failing combined-glob request and its full arguments are in Astra's `mc-000038.response.json`; refused corrections and an allowed exact-source extension are in `mc-000039.response.json` and tool records `tc-000100`–`tc-000102`. The unresolved verdict is in `stages/09-verification/verification.json`. DeepSeek's answered import question is in that run's verification artifact and still appears in `final-review.md`.

## Already completed; preserve these changes

The working branch now treats the generic text adapter as normal operation for every unsupported language/format, including unknown extensions and extensionless files. Configured syntax-adapter fallbacks still report degradation; text results retain truthful precision metadata. This applies to outlines, symbol reads, definitions, mentions, packet accounting, and high-risk context warnings. Empty mention results no longer claim syntax verification. Regression tests cover unsupported formats, mixed results, and a failed configured parser.

Do not reimplement that accounting or treat text mode as evidence loss. Actual truncation, missing files, tool refusals, and parser failures remain observable. Historical artifacts are immutable; do not silently rewrite old counters or verdicts.

## 1. Make repository glob semantics consistent

- Give model-facing `pathGlob` one contract across file listing, search, symbol mentions, and definition discovery. Reuse the existing containment rules and shared matcher; do not maintain unrelated interpretations for different tools.
- Explicitly support brace alternatives such as `apps/api/{data,domain/users}/**` through that shared matcher. This request should succeed, not merely receive a new unsupported-pattern error. Its query `Statuses|func List` is valid POSIX extended regular-expression alternation and must continue to work.
- Prefer resolving the glob against the selected revision's tracked paths using the existing matcher, then searching those literal paths through Git. Keep any native-pathspec fast path only where equivalence is established. Use argument arrays and literal pathspecs: file names containing Git pathspec metacharacters must not broaden the search.
- Preserve committed-revision reads, head/base selection, case sensitivity, regex versus fixed-string query behavior, and repository containment. Never traverse worktree symlinks or include untracked files to implement matching.
- Bound expanded paths/argument sizes, chunking as necessary. Maintain deterministic result ordering and one overall match/result allowance across chunks. Do not turn an unsearched remainder, rejected pattern, or limit into an authoritative zero-match result.
- For a pattern outside the supported contract, return an actionable tool error. An accepted pattern with no matching tracked paths is a legitimate empty result; an unsupported pattern is not.
- Validate both inputs against their documented dialects: `pathGlob` uses the shared glob contract; `query` uses the existing POSIX ERE contract (or literal matching for fixed-string tools). Surface malformed syntax and recognized unsupported dialect constructs as argument errors, including cases where the chosen scope contains no files. Preserve genuine Git/revision/backend failures as execution errors rather than calling them invalid patterns or swallowing them into `[]`. Do not validate ERE using JavaScript's different regex grammar.
- Error results must reach the model with `isError: true`, identify the offending argument and syntax issue, and give a bounded correction hint or supported example. Record the same distinction in telemetry. The model may correct the request through the existing bounded tool loop; a fully corrected input mistake is not an unrecovered harness/provider failure under section 3A.
- Do not infer unsupported syntax from zero matches or guess intent when a pattern is valid in the documented dialect. Literal metacharacters must remain representable. The guarantee covers invalid/unsupported constructs we can identify under that contract, not arbitrary future model intent.
- Include the effective path glob and requested result limit in concise tool telemetry. The full debug request already retained these arguments, but the compact records omitted them. Keep existing redaction and size limits.
- Clarify tool descriptions: `read_symbol` requires a path; discovery without a path uses `find_definition`; document supported `contextMode` values and glob semantics. Do not introduce a new argument-repair loop or increase the tool-call allowance.

Tests: brace alternatives, simple and recursive globs, literal metacharacters in tracked filenames, head/base differences, no matching files, unsupported/unsafe patterns, bounded expansion/chunking, and mixed source/schema directories. Cover query matching as well as filename matching. Confirm equivalent listing/search scope without requiring identical output formats. Use unrelated fixtures; the OMSX request is a read-only reproduction case, not a production special case.

Include a combined brace-glob plus `|`-query regression; malformed glob and regex inputs; a recognized unsupported regex construct; invalid syntax with an empty file scope; valid patterns matching zero files or zero lines; literal/fixed-string metacharacters; and a backend failure. Assert model-facing errors, correction guidance, and telemetry, not only thrown exceptions. None of the error cases may arrive as a successful empty-result payload.

Likely files: `src/repo/source-resolver.ts`, `src/repo/search.ts`, `src/git/git-client.ts`, `src/repo/path-guard.ts`, `src/llm/tool-definitions.ts`, tool argument telemetry, and repository/git/runner tests.

Acceptance: an accepted combined glob retrieves the same bounded matches as its component scopes, and cannot silently report no matches because another backend interprets its syntax differently.

## 2. Preserve useful matches within existing result budgets

- Build bounded search-result representations before serialization. Preserve path, line/column, and a bounded match excerpt; attach compact enclosing-symbol identity/location rather than an entire declaration initializer or body.
- Trim optional symbol signatures and surrounding context before discarding matches. An oversized first entry must not force all subsequent useful entries out. Preserve honest omission/truncation information when even minimal entries cannot fit.
- Deduplicate repeated optional enclosing-symbol context where useful, without collapsing distinct match locations. Do not change the canonical symbol/source data used elsewhere merely to shrink a search response.
- For symbol mentions, perform the existing identifier/comment/string classification before the final enriched-result packing, within existing discovery and syntax-inspection limits. Discarded non-mentions must not exhaust the delivery allowance before valid mentions are considered. Preserve text precision for unsupported formats and explicit limitation metadata when inspection/discovery itself was bounded.
- Apply the actual delivery allowance when packing search/mention results, including the verifier's per-result cap and remaining character budget. Avoid packing to one cap and then slicing serialized JSON mid-entry at a smaller cap. Reuse the existing tool execution/budget plumbing with a narrow delivery-limit parameter if needed; do not add a generic response-rewriting framework.
- Keep per-consumer packing outside the shared tool-result cache: cache the bounded canonical search result, then fit a copy to each caller's allowance. A small-budget caller must not poison a later larger-budget hit, and a cached larger response must not bypass a smaller caller's cap. Account for result metadata/truncation notices within the existing charged-text allowance; preserve the runner's untrusted-data fencing. If no complete minimal entry and notice fit, return the existing explicit budget refusal rather than silently returning `[]` or sliced JSON.
- Keep complete entries and explicit continuation guidance such as narrowing `pathGlob`, reducing context, or reading a known range. Distinguish no matches from matches withheld by limits. Do not infer code absence from a truncated or rejected result.
- Keep omission accounting honest: a discovery limit established with one extra match proves that more results exist, not their exact total. Distinguish withheld matches from shortened optional metadata; do not claim a complete result count or complete code excerpt after truncation. Preserve the matching portion of long lines with its actual location, and mark excerpts as excerpts rather than reconstructing source text.
- Preserve the existing source-reading reserve and exact-source extension restrictions. A broad lookup should not consume the whole packet allowance solely through duplicated optional metadata; bounds still apply when there are genuinely many relevant matches.

Tests: large Go composite literals, an unrelated long declaration in another supported language, repeated enclosing symbols, mixed supported/unsupported files, small final delivery caps, and a single unusually long path/line. Include cache hits and shared in-flight results delivered under different caps, both caller orderings, comments before real identifier mentions, and an allowance too small for one complete result. Check surviving locations, valid structured result text, bounded size, omission metadata, and follow-up reads. Do not assert that every truncated response must fit all matches.

Acceptance: the two reproduced automatic searches retain useful matches under unchanged caps; smaller delivery caps preserve complete entries and cannot masquerade as successful exhaustive searches.

## 3. Report failures, uncertainty, and answered questions honestly

### 3A. Failure and completion reporting

Use existing typed errors, stage outcomes, coverage/verification status, budget stops, and recovery records to derive report health once. Reuse it across renderers and entrypoints; do not infer failure by scanning model prose, counting all degraded results, or asking another model to classify run health. Add only the minimal structured diagnostics needed where existing outcomes lose an error's provenance.

Apply precedence consistently: unrecovered fundamental failure, then incomplete required work, then completed work with unresolved questions, then clean completion. Preserve the underlying finding count independently of this status: zero findings is a count, not proof of successful review. Derive unresolved-question status from retained structured concerns after reconciliation, not from the rendered text.

Determine health from all known required-work outcomes and unresolved concerns before presentation caps, including omitted attention items and skipped verification when candidates required it. A report-size cap must not hide the only limitation and thereby create a clean outcome. A successful optional adaptive pass does not repair a failed required pass, and an unsuccessful optional pass does not by itself invalidate a successfully completed baseline; retain its existing supplemental-work disclosure.

| Situation | Required visible outcome |
| --- | --- |
| Unrecovered harness/provider error prevents required review, validation, or trustworthy report assembly | **Review failed** notice immediately below the report title, before any model summary; no clean/no-findings verdict. Preserve completed findings with an explicit partial-results label. |
| Required work stopped by a budget/deadline, without a separate fundamental failure | **Review incomplete** notice with the limiting stage/reason and completed scope; no clean conclusion. |
| Work completed, but a material question remains unresolved | **Review completed with unresolved questions** notice before the summary. “No confirmed findings” may describe the count, but must not imply the unresolved behavior is safe. |
| An earlier error recovered and the required work subsequently passed full validation | Completed outcome; preserve recovery diagnostics. Do not turn every recovered schema repair or corrected tool argument into a failed review. |
| Normal unsupported-language text mode or deliberate configured exclusions | Normal capability/scope disclosure, not failure or incomplete-work accounting. |
| No confirmed findings, no unresolved questions, and no incomplete/failed required work | A scoped no-findings conclusion is permitted; avoid an absolute safety guarantee. |

- For errors, show affected stage/work item, stable error code/category, a bounded redacted underlying reason when available, and whether retry/recovery exhausted. Say that the cause was not captured if it is unknown; never guess billing, credentials, provider failure, or missing code from an empty result alone.
- A known tool/harness fault that leaves a required evidence question unresolved must not be hidden by a schema-valid `reject` verdict. Retain the operational diagnostic alongside the semantic verdict. A source limit with unresolved evidence is a limitation, not proof of a software defect or provider outage.
- Successful bounded truncation or an isolated refused request is not automatically fatal. Track whether required work remains unresolved; when recovery cannot be established, retain that limitation rather than claiming complete evidence.
- Classify a timeout by its cause and scope: a run/worker deadline that stops required work is incomplete work; an unrecovered provider or harness execution error is an operational failure. Keep successful, validated deterministic composition fallback visible as fallback, without automatically relabeling sound retained findings as a failed review. Failure to validate or faithfully assemble that fallback remains a failure. Use existing stage outcomes and recovery links; do not build a global semantic dependency tracker or infer recovery merely from a later schema-valid payload.
- On terminal exceptions before composition, write a minimal error report and bounded diagnostic artifact where output paths are available. Report creation must not require another LLM call. If diagnostic writing fails, preserve the original error and surface it on stderr/Action logs.
- Make CLI, saved Markdown/JSON, GitHub summaries/comments, and Action lifecycle agree. Unrecovered fundamental failures must retain/produce a nonzero failure outcome, including paths where workers currently return errors instead of throwing. Do not route a returned failed review through `finalizeSuccess`. Preserve successful partial findings/artifacts and existing exit conventions for nonfatal limitations; positive findings alone are not execution errors.
- Assemble/reuse the same host-derived outcome before creating the saved report and GitHub posting body. Patching only stdout after composition would leave a contradictory prebuilt PR summary or successful run artifact. Reuse existing publication authorization; this plan does not enable posting for failed runs where posting was not requested or permitted.
- Remove “Everything looks good” when there is retained uncertainty or incomplete work. Derive the trust notice and no-findings eligibility on the host. For failed, incomplete, or unresolved outcomes, use a factual host status/count summary; preserve substantive findings below it. Do not rely on a brittle English-phrase blacklist or another model call to detect contradictory reassurance in a generated summary.
- Separate **Excluded by configuration/planning** counts from **Incomplete/failed work**. Deliberately skipped generated files remain visible in coverage, without falsely implying failed execution. A planner/budget skip caused by inability to complete work must not be relabeled intentional to obtain a clean result.

Tests must exercise the complete report path, not just a renderer flag: all review workers failing while the pipeline returns; provider authentication/billing/network failure after retries; incomplete or deliberately skipped verification; global/local budget limits; a fully recovered failure; a fundamental failure with some verified findings retained; zero findings with essential uncertainty; and successful reviews containing only intentional exclusions. Include attention-cap omission, optional-pass failure with a successful baseline, and validated versus invalid deterministic fallback. Check top-of-report precedence, absence of contradictory clean wording, diagnostic redaction, saved artifacts, the prebuilt GitHub body, CLI outcome, and Action finalization. A pre-fix silent search bug cannot be detected retrospectively from `[]` alone; do not claim automatic detection of arbitrary undiscovered harness defects.

### 3B. Reconcile existing questions against explicit evidence

- Extend the existing bounded reconciliation path to eligible packet-origin attention questions, which the current verifier-assumption-only inventory does not cover. Reuse stable packet/hint/group provenance and existing composition; no extra mandatory model call.
- Remove the current `publishableCount > 0` eligibility dependency when composition completed and resolution proposals passed validation. Explicit evidence may answer a question even when every candidate was rejected. Reuse the already-scheduled composition call, including its zero-findings case; if composition is skipped or falls back, retain concerns without an extra call.
- Supply relevant verified observations, including explicit refutations. Resolve a question only with exact concern identity and supporting source references that establish the same predicate at the reviewed revision.
- Assign stable IDs to original packet hints/questions before display grouping, and reconcile those records before rebuilding grouped notes. Treat an indivisible free-text question as one concern; do not split prose heuristically. Partial grouping resolution retains untouched member questions and their provenance. Reuse the existing resolution fields with minimally generalized concern identities; update their schema/prompt/cache versions if their contract changes.
- Preserve unresolved portions of grouped questions. Confirmation that a type is imported does not automatically prove every consumer import, lack of duplicate definitions, or generated-code compatibility.
- A reject verdict alone, shared file, matching keyword, or approximate question similarity is never a resolution rule. Incomplete verification cannot supply conclusive evidence. Missing/invalid references, omitted inventory entries, or fallback composition retain the concern.
- Record resolved, narrowed, and retained decisions with supporting IDs for audit. Reconcile before deriving the final report-health notice so genuinely answered questions do not keep it in an unresolved state.

Tests: a rejected candidate whose explicit proof answers an exact packet question, including zero published findings; an unrelated question in the same file; grouped questions only partly answered; an indivisible question with only partial evidence; different revisions; incomplete verifier evidence; missing references; bounded inventory omission; and deterministic composition fallback. Include a non-schema example such as a test helper's assertion contract. A syntactically valid reference is necessary but does not itself prove semantic entailment: inspect resolution rationales in live comparisons, and do not describe this validation as an automatic proof of correctness.

Likely files: `src/pipeline/attention-reconciliation.ts`, `human-attention.ts`, `composer.ts`, `review-runner.ts`, existing worker/verifier outcomes and shared result types, `src/util/coverage-summary.ts`, output renderers, CLI/Action finalization, and corresponding tests. Reuse plans 121/122 mechanisms rather than replacing them.

Acceptance: fundamental errors are prominent even with zero findings; Astra-shaped uncertainty cannot end in a clean bill of health; answered concerns disappear only with explicit evidence; intentional exclusions do not contradict review completeness.

## 4. Calibrate consequential missing-test findings

- Refine the existing review and verification guidance, especially the tests lens. The absence of a test for a newly added branch alone is insufficient for an actionable finding.
- Revise the existing new-branch/negative-path bullets in `bundled-skills/core/tests.md` and align verification guidance with them; do not simply append competing instructions. Use the existing skill/prompt fingerprinting and version mechanisms so cached calls cannot reuse the previous instruction contract. No blanket severity/confidence demotion based on the `testing` category.
- Require an established material behavioral requirement, a concrete regression that would violate it, and evidence that the inspected relevant tests fail to protect that boundary. Do not demand an already-present production bug: tests that pass while violating a known important requirement remain actionable.
- Distinguish local evidence (“this suite has no malformed-input assertion”) from a repository-wide claim (“no test covers this behavior”). Inspect likely sister tests and transport/middleware validation where they bear on the claim; bounded or unsuccessful search cannot prove global absence.
- Explain why the gap matters here rather than merely citing a sibling testing convention or inventing a possible mutation. Optional extra coverage can be omitted; do not automatically move every withheld suggestion into human-attention noise.
- Establish material impact from repository/caller behavior or an explicit requirement, not only a commit title, a neighboring test style, or the model's claim that an error code is client-visible. Behavioral contracts may be evidenced by callers and boundary tests without written specifications. Preserve actionable coverage regressions where a valid guard could be removed without detection; no requirement to demonstrate an existing production failure or execute mutations during review.
- Keep existing recommendation checks: the proposed test must exercise a reachable boundary, accept valid remedies, and reject weakening the established requirement. Preserve uncertainty about uninspected contracts instead of manufacturing confidence.
- Use existing finding/proof/recommendation fields. No new mandatory assessment schema, repository-wide call sequence, blanket category suppression, or model-specific threshold.

Regression cases: routine uncovered validation with no established material consequence; an already-covered sibling/transport boundary; a tenant-isolation test with a vacuous assertion; a payment-limit test that accepts a violating result; and a justified missing rejection test for an established consequential contract. Cover both actionable findings and restraint, including unrelated languages and domains. Deterministic tests establish prompt/publication contracts; live comparisons assess model judgment.

Acceptance: absence-only recommendations are not presented as demonstrated production defects, while concrete, consequential testing failures remain reportable. Do not set “match Astra's zero findings” or “match DeepSeek's two findings” as the target.

## Execution and validation order

1. Implement section 1 and review the search scope/containment contract.
2. Implement section 2 under unchanged budgets; replay the local reproductions without inference calls.
3. Implement sections 3A and 3B. Review actual rendered failure/uncertainty reports and CLI/Action outcomes, including paths that never reach composition.
4. Implement section 4 as a small, separately identifiable prompt change with the normal prompt-version update. Keep its semantic measurement distinct from deterministic search/reporting fixes.
5. Run focused regression tests, then `pnpm test`, `pnpm run typecheck`, `pnpm run build`, and `git diff --check`. Review the final diff and verify that no provider, reasoning, budget, or repair settings changed as a side effect.
6. Freeze the build/config and let the user run matching DeepSeek and Astra reviews of the same revision, followed by broader model comparisons as useful. Record full code provenance, routing, effective reasoning, composition step-down, prompt versions, and budgets. Repeat surprising outcomes before attributing them to a model.
7. Compare retrieved evidence and unresolved predicates first, then accepted finding/recommendation quality, report consistency, completeness, repairs, calls, time, and estimated cost. Faster runs, lower degradation counters, and fewer findings are not success criteria by themselves.

## Scope boundaries

No blanket budget increase, added schema-repair attempts, relaxed validation, source guessing, generated-file exclusion from evidence lookup, or provider/model change. No Plan 122 C2 adaptive-prompt experiment in this baseline. No automatic reruns, public posting, or paid judge/model calls as part of writing/reviewing this plan. The already-implemented unsupported-format accounting is retained, not used to conceal evidence omissions.

## Plan review

- The two search defects have deterministic reproductions; recommendations do not rely on treating Astra as ground truth.
- Search changes preserve revision and containment guarantees, with explicit handling of expansion limits and empty results.
- Reporting distinguishes known failure, incomplete work, unresolved semantics, recovered errors, and intentional exclusions. It includes zero-findings and partial-results failure paths, not merely successful composition.
- Reconciliation requires predicate-specific evidence and cannot delete questions on rejection status or fuzzy similarity.
- Test-gap calibration has positive and negative controls; no OMSX-specific production branches or mandatory new fields.
- Each section is independently reviewable. Implementation remains pending until the user proceeds.
