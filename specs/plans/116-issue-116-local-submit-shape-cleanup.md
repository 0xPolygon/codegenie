# Issue 116: Local Submit Shape Cleanup

Status: IMPLEMENTED (measuring) — small follow-up to Plan 115, 2026-09-22
Evidence: trails-api `49f4645b` eval run 80
Depends on: Plans 112/114 final-argument provenance and Plan 115 preservation/accounting

## Objective

Remove safely extraneous keys and correct documented field aliases locally, before asking the model to repair a submission. If local cleanup produces a fully valid, content-preserving result, accept it without a repair call or worker restart.

When local cleanup is insufficient, give the existing repair call a focused list of missing or invalid fields and relevant unexpected keys. Ask for spelling/placement corrections instead of asking the model to reconsider the review. Known aliases are a convenience, not an attempt to enumerate every typo a model could produce.

This follows the user's agreement to distinguish extraneous metadata from substantive review information. It is not blanket deletion of every unknown property, truncation of text, or trimming arrays to schema limits.

## Confirmed failures

Run 80 found the expected bug but failed completeness: one test hunk was unreviewed and one verification was incomplete. Offline comparison and schema validation established:

| Original call → correction | Only change | Current outcome |
| --- | --- | --- |
| `mc-000022` → `mc-000028` | Remove `findings.0.evidence.maxItems: 10` | Valid correction rejected; worker retry repeated the same rejection; test hunk failed |
| `mc-000055` → `mc-000057` | Remove `findings.0.evidence.changedCodeSide: "new"` | Valid correction rejected; adaptive pass eventually failed |
| `mc-000076` → `mc-000082` | Rename `falsePositivesRisk: "low"` to `falsePositiveRisk: "low"` | Valid correction rejected; verification marked incomplete |

The last case needs a rename, not deletion: `falsePositiveRisk` is required. The `keep` verdict, risk value, reason, and other fields were identical. Plan 115's guard mistakenly treats disappearance of the misspelled key as lost substantive content.

Two other submissions contained empty `evidence.changedCodeNote` fields. These are candidates for local removal rather than model repair. Preserve the guard that rejected changed hint contents elsewhere in run 80.

## Implementation

- [x] Add one shared, pure cleanup operation over a copy of complete, provenance-valid arguments. Return the proposed arguments plus an audit of removed/renamed paths and named rules. Never mutate the raw response or inspect rejected partial argument fragments.
- [x] Traverse schema object properties, nested arrays, and tuples. Only remove keys that are disallowed at that exact schema location; preserve fields accepted through `additionalProperties`. For ambiguous schema branches, do not guess.
- [x] Start with narrow rules supported by the traces:
  - Remove empty unknown properties at nested object locations, including `evidence.changedCodeNote: ""`.
  - Remove documented leaked schema metadata such as numeric `evidence.maxItems`, with explicit path/type constraints. A property named `maxItems` elsewhere, or containing substantive text, is not automatically removable.
  - Remove `evidence.changedCodeSide: "new"` only when the containing finding's existing anchor independently agrees (`RIGHT`). Conflicting or unsupported values remain unresolved; do not infer a new anchor.
  - Rename the exact verifier alias `falsePositivesRisk` to `falsePositiveRisk`, preserving its value. If both exist with identical values, remove the redundant alias. If they conflict, or the value is invalid, do not choose or invent a risk decision. No fuzzy field-name matching.
- [x] Reuse these same rules in Plan 115's preservation comparison. Account explicitly for each authorized removal or rename so an original snapshot cannot demand that an invalid metadata key be reintroduced. Preserve every other field, item, ordering, and decision.
- [x] Run local cleanup before consuming the existing model-repair allowance, including on a repair response or worker restart. Revalidate the entire proposed object, stage semantics, and preservation before acceptance. A remaining substantive/structural failure can use existing bounded recovery; cleanup must not create another retry loop.
- [x] For remaining failures, build the focused repair request described below from structured validation diagnostics and the retained original arguments. Do not infer missing fields by searching prose for words such as "missing" or "required".
- [x] Keep unknown substantive fields unresolved unless an existing exact, conflict-free relocation accounts for their content. Do not drop findings, hints, uncertainties, evidence, coverage, or explanatory prose merely because they appear under an unsupported key.
- [x] Integrate before cache acceptance/write, preserving raw-response provenance. Reuse or reapply the audited cleanup on cached responses; never misrepresent transformed arguments as raw provider output. Bump the affected runner/cache behavior version.
- [x] Record deterministic cleanup separately from model repair: rule, paths, item counts, validation outcome, and linked obligation resolution. Emit success only after all checks pass; respect existing redaction. Purely local success must not increment model-repair or worker-retry counts.

Primary targets: `src/llm/submit-preservation.ts`, `src/llm/pi-runner.ts`, and the existing Stage 7/verifier recovery seams. Reuse the existing scheduler and fidelity accounting; do not introduce another recovery mechanism.

## Focused repair after local cleanup

The sequence is **safe local cleanup → full validation → one focused model repair if still needed → full validation and preservation checks**.

- [x] Name exact missing required paths, with their expected types/allowed values. Also list wrong types, invalid values, and other remaining schema or stage-semantic violations; a missing-fields-only prompt would leave those failures unexplained.
- [x] Show relevant unexpected paths and their original values as explicitly untrusted data. Ask the model to check spelling and placement against the exact schema keys. Possible spelling similarities are diagnostic suggestions only, never authorization for automatic fuzzy renaming.
- [x] Retain the complete original payload and the local-cleanup audit. Removing a field from the proposed output must not erase its value from repair context or preservation accounting. Keep substantive unknown content unresolved until it is accounted for, and retain full material needed for the existing whole-object resubmission; focus the instructions, not by truncating evidence or array members.
- [x] Ask for the entire corrected submission under the existing tool schema, changing only diagnosed structure. Preserve values, decisions, unaffected fields, and array order. Do not introduce a field-edit tool, rerun the investigation, or reset the repair allowance.
- [x] Accept a model-proposed typo correction only through an audited, constrained rename check: an unexpected source key maps to a previously missing schema-defined destination in the same object, the value is identical and valid for the destination, the correspondence is unambiguous and spelling-compatible under an explicit conservative rule, and no destination conflict or unrelated content change exists. Do not infer a rename solely from equal values such as two occurrences of `"low"`. Ambiguous moves remain unresolved. Exact documented relocations continue to use their existing rules.
- [x] Apply full schema, stage-semantic, and preservation validation afterward. A successful rename must resolve the original obligation rather than require the misspelled key to reappear. Log the accepted source/destination paths and rule; do not count a rejected destructive attempt as permanent failure if a later valid correction accounts for everything.

Example diagnostic for run 80 (normally handled locally once its exact alias is registered):

> Missing required field: `falsePositiveRisk` (allowed values: `low`, `medium`, `high`). Unexpected field: `falsePositivesRisk`, original value `"low"`. Check whether this is a spelling mistake. Correct the key without changing the risk assessment, verdict, explanation, or other fields. Return the whole corrected submission.

This is a structural correction request, not permission to invent a missing risk assessment. If the missing field has no identifiable original value, follow the existing bounded recovery policy and report unresolved failure when its requirements cannot be satisfied.

## Regression and acceptance checks

- [x] Add minimal sanitized fixtures for the three run-80 pairs and empty nested notes. Tests must not depend on the private eval checkout.
- [x] Through the real runner with scripted provider responses, each eligible local correction completes with **one provider call, zero model repairs, zero worker restarts**, strict full validation, and resolved preservation accounting.
- [x] Assert exact retention of verdict/risk, finding prose, evidence, hints, uncertainties, coverage, array order, and source response. Successful cached replay must satisfy the same checks.
- [x] Negative cases: conflicting aliases/sides, invalid alias values, unknown substantive notes, misleading metadata names/types, missing required content, ambiguous schema branches, and truncated/untrusted arguments. None may become a clean result through deletion or guessing.
- [x] Keep the Plan 115 five-item loss regression and changed-decision/changed-hint rejection tests passing. When local cleanup is insufficient, verify the existing single model-repair allowance remains intact.
- [x] Exercise unfamiliar typo and misplaced-field fixtures through the repair path. Assert precise missing/invalid-field diagnostics, retained unexpected values, unchanged unaffected content, and successful accounting for an eligible value-preserving rename without adding every typo to a local alias table.
- [x] Reject ambiguous rename candidates, equal-valued unrelated fields, conflicting destinations, changed decision values, and repairs that fix spelling while deleting independent hints or evidence. Assert that wrong-type/value errors are included alongside missing-field errors and that successful local cleanup still makes no repair call.
- [x] Run focused tests, `pnpm test`, production TypeScript checking, full typechecking, and `git diff --check`. The recorded Plan 115 baseline is 952 passing tests and 24 pre-existing full-typecheck fixture errors; require no new errors and report the full check honestly.

## Scope and delivery

Keep changes unstaged and preserve existing work. No changes to routing, reasoning effort, deadlines, composition, or external eval YAML. Authoring this plan does not implement it or start a paid eval.

After implementation, mark **IMPLEMENTED (measuring)**. A separately authorized controlled eval should check complete coverage, completed verification, preserved recovery fidelity, and fewer unnecessary repair calls. Run 80's failures justify these local corrections; they do not establish that all remaining model-output failures will disappear.

## Adjacent prompt improvement — implemented 2026-09-22

At the user's request, the shared submit-tool description now reminds the model to check exact key spelling and case, including nested keys; include required fields; and avoid extra keys or copied schema keywords such as `maxItems`. The instruction is defined once and supplied with every structured submit tool across Stages 5/7/8/9/10, including repair and finalization calls whose conversation may replace the initial prompt. The prompt rationale ledger records this shared instruction and the runner/cache message version is v5. Stage prompt template versions are unchanged because their message text is unchanged.

This is a preventive reminder, not a validation guarantee. The local-cleanup and focused-repair work above is now implemented. Runner/cache behavior advances to v6 for this follow-up.

## Implementation and review results — 2026-09-22

- Shared copy-only cleanup precedes schema and semantic validation on live and cached submissions; raw cached provider messages remain unchanged. Successful local edits have their own `submit_shape_correction_accepted` audit; remaining failures emit `submit_shape_correction_rejected`. Acceptance events follow preservation checks.
- Automatic renaming is restricted to the documented verifier alias. Model-selected spelling corrections require names of at least five characters, case-only differences or one insertion/deletion/substitution/adjacent transposition, unique correspondence in both directions, a previously missing required destination in the same object, and an identical schema-valid value. Full preservation still rejects unrelated changes.
- Focused repair diagnostics retain the local edit audit, missing/invalid paths with expected schema, and unexpected original values, fenced alongside the complete original payload. Existing semantic failure context and bounded repair scheduling remain in place.
- Regression fixtures cover the three run-80 corrections, empty evidence notes, raw cache replay, unfamiliar typo repair, conflicting/invalid aliases including null, conflicting sides, substantive unknown fields, metadata path/type constraints, nested tuples/open objects/ambiguous branches, invalid values, and ambiguous/equal-valued unrelated renames. Existing provenance, misplaced-field, changed-hint, and five-item loss tests remain passing.
- Review checked provenance before cleanup, preservation before cache acceptance, no mutation of originals, and success telemetry after all validations. `schemaValid` reflects acceptance after the audited local normalization; the stored provider response is still raw.
- Validation: **972 tests passed across 51 files**; production TypeScript check and `git diff --check` passed. Full typechecking retains the **24 existing test-fixture errors**, with no new errors. All changes remain unstaged. No paid eval was started.

Controlled eval results are still needed to measure repair-call reduction and completion; these deterministic regressions do not establish performance on every model output.

## Superseding user policy after run 81 — 2026-09-22

The user explicitly changed the policy: “yes.. if we are missing data, then yes, we need to ask for those missing fields.. but fields added we dont expect, we can just delete.. doesn't matter..” This section supersedes the earlier restrictions on substantive unknown values and model-selected spelling renames; the sections above remain historical implementation evidence.

- Delete all keys absent from an explicitly closed schema object's properties, regardless of value. Preserve schema-defined optional fields, array items/order, and open-object data; skip ambiguous schema branches rather than guess.
- Apply the exact valid verifier alias before stripping. A conflicting unexpected alias is discarded; an existing invalid canonical field remains invalid and needs repair.
- Full validation still rejects missing required fields and invalid schema-defined content. Use the existing focused bounded repair, preserving valid known data and including removed original values as diagnostic context for possible typos. Do not require arbitrary unknown values to be reconstructed or retain fuzzy rename obligations.
- Raw provider responses remain intact in cache/debug traces. Cleanup audits identify every removed path with `unknown_property`; missing/invalid diagnostics include the separate `removedUnexpectedFields` values. Runner/cache behavior advances from v7 to v8.
- Regression checks cover run 81's nonempty `evidence.changedCodeNote` completing locally with one provider call and raw-cache replay, substantive extras alongside missing required fields, failure when a repair still omits required data, conflicting alias removal, and protection of known fields/items/order.

Changes remain unstaged. Validation: 996 tests passed across 51 files; production build and diff checks passed; full typecheck retains 24 pre-existing fixture errors with no new errors. Independent review pending.
