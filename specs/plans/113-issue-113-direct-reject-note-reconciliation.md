# Issue 113: Measure Direct-Reject Note Contradictions Before Adding Suppression

Status: BACKLOG (measurement gate not met)
Planned from: trails-api eval `0c4d5213`, runs 72-73, 2026-08-05
Planned at: commit `803bf6f` (branch `llm-repair`)
Recommended disposition: ship 0.5.5 without this change. Reopen design only
after the evidence gate below is met.

> **Executor instructions**: This is a measurement and decision plan, not
> authorization to change human-attention suppression. Read the entire plan
> and evaluate the entry gate first. If it is not met, record any newly
> inspected evidence, leave production code unchanged, and STOP. If it is met,
> write or amend a separate implementation plan that satisfies every trust
> boundary below; do not implement the discarded fuzzy direct-reject design.
>
> **Drift check (run before re-evaluating the design)**:
> `git diff --stat 803bf6f..HEAD -- src/pipeline/human-attention.ts src/pipeline/lens-runner.ts src/pipeline/verifier.ts src/llm/schemas.ts tests/human-attention-adjudication.test.ts tests/verifier.test.ts specs/project/components/review_pipeline.md specs/plans/README.md`
> Re-read the live code if any path changed. STOP and retire or replace this
> plan if Stage 7 now retains exact candidate-to-hint provenance, verifier
> verdict semantics changed, or another plan already owns this gap.

## Execution metadata

- **Current priority**: BACKLOG; no implementation work authorized
- **Priority if the evidence gate fires**: P2
- **Effort**: S for evidence review; implementation intentionally unestimated
  until a safe data contract is selected
- **Risk**: HIGH for a premature fix because the behavior removes user-visible
  questions and the current signals cannot distinguish all unresolved rejects
- **Depends on**:
  `specs/plans/75-issue-75-human-attention-output-discipline.md` Step 1 and
  `specs/plans/110-issue-110-publication-aware-note-adjudication.md`
- **Category**: measurement / output correctness / noise reduction
- **Planned at**: commit `803bf6f`, 2026-08-05

## Why this matters

Run 72 exposed one real output contradiction. Stage 7 emitted both a direct
candidate and a singleton same-packet question asking whether
`TokenCharge`/`AmountOut` could be zero. Stage 9 proved those values strictly
positive on every valid path and rejected the candidate with high
false-positive risk. Because the verdict also said
`requiredEvidencePresent: false`, the normal verification-resolution index did
not consume it, and the stale question reached the rendered review.

Run 73 is the adjacent negative control. A fresh model call emitted the same
candidate and sibling note from the same packet and reached the same substantive
rejection, but this time returned `requiredEvidencePresent: true`. The existing
`stage9_verified_predicate` path suppressed the note correctly. The common path
therefore works; the observed miss is intermittent.

Removing a stale question is useful, but removing a genuinely unresolved
question is worse. The initially proposed shortcut—treating any complete
`reject + falsePositiveRisk: high + requiredEvidencePresent: false` as
conclusive—does not satisfy that trust boundary.

## Why the original implementation design is unsafe

The following are verified current-state constraints. A future plan must not
reason around them:

1. **The verdict tuple is ambiguous.**
   `buildVerifierSchemaRepairPrompt()` explicitly instructs the model that when
   verification cannot be completed it should reject with
   `requiredEvidencePresent=false` and `falsePositiveRisk=high`. The same tuple
   can therefore mean either “the predicate was disproved” or “decisive
   evidence was unavailable.” `verificationIncomplete` does not disambiguate
   this reliably: it is a runner-normalized state, not a model-authored
   machine-readable claim-resolution field.
2. **Packet membership is not exact sibling provenance.**
   `poolEnsemblePassResults()` unions findings, hints, and uncertainties from
   multiple Stage-7 passes into one `PacketReviewResult`. Candidates retain an
   `ensemblePass`; hints currently do not. Finding and note membership in the
   same pooled packet cannot prove they originated in the same model response.
3. **The normal semantic matcher is not an ownership relation.**
   `attentionGroupResolvedByVerification()` intentionally uses permissive
   file/symbol/term overlap for evidence-backed resolution. Reusing those
   thresholds for a new subtractive path can match a different predicate in
   the same file or call chain.
4. **Per-group uniqueness is insufficient.** One candidate can be the sole
   fuzzy match for two singleton groups. Checking “exactly one candidate per
   group” alone could suppress both notes; safe association requires
   bidirectional one-to-one identity or explicit provenance.

Consequently, verifier prose parsing, packet equality, or existing fuzzy
thresholds are not acceptable substitutes for a trustworthy relation.

## Standing trust invariant

> A direct Stage-7 note remains visible unless Codegenie has both (a)
> machine-readable proof that verification resolved/refuted its predicate
> rather than failing to obtain evidence and (b) an exact, unambiguous
> candidate-to-note relation. When either fact is unavailable, keep the note.

This preserves the existing asymmetry: mild stale-note noise is preferable to
silently deleting an unresolved review question.

## Evidence ledger

Keep this table current when a suspected recurrence is reviewed. Do not add a
row from aggregate counts alone; inspect the candidate, verdict, raw/grouped
note, suppression record, and rendered output.

| Evidence | Real model execution | Predicate outcome | `requiredEvidencePresent` | Note outcome | Classification |
| --- | --- | --- | --- | --- | --- |
| `0c4d5213` run 72, candidate `8aef05e7-f1` | yes, no-cache | verifier directly refuted the zero-amount predicate from available source | false | singleton note rendered | confirmed stale contradiction; positive incident 1 |
| `0c4d5213` run 73, candidate `8aef05e7-f1` | yes, no-cache | same predicate directly refuted | true | suppressed by existing `stage9_verified_predicate` path | negative control; not an incident |

For every new row, record separately whether:

- the candidate was direct Stage 7 or promoted;
- the packet had one pass or pooled multiple passes;
- verification completed or was runner-incomplete;
- the verifier refuted the predicate from inspected evidence, declared it
  unconfirmed/unavailable, or was ambiguous;
- the note group was singleton or merged;
- the note reached the composer prompt and/or final output; and
- an existing evidence-backed, promoted-provenance, finding-coverage, or
  publication-fallback path should already have handled it.

## Measurement entry gate

Do not authorize an implementation plan until either gate A or gate B is met:

- **Gate A — repeated eval evidence**: at least three confirmed stale
  contradictions from distinct real no-cache model executions, spanning at
  least two distinct predicates or owner cases.
- **Gate B — production evidence**: at least one retained, user-visible
  production incident plus one independent confirmed recurrence in an eval or
  production run.

Run 72 counts as one Gate-A incident. Run 73 does not count. Synthetic fixtures,
cache replays, identical copied artifacts, and rejects whose reason says the
decisive helper/evidence was unavailable do not count.

Existing artifacts are sufficient for the current gate. Do not add production
instrumentation solely to measure this issue unless a suspected incident
cannot be classified from `verification.json`, `human-attention-notes.json`,
packet results, and the rendered review. If artifacts are insufficient, write
a small observability-only plan first; do not combine instrumentation and
suppression.

If neither gate fires, leave this plan in BACKLOG. The absence of recurrence is
a valid result and should retire the proposed mechanism rather than invite
weaker thresholds.

## Measurement procedure

### Step 1: Identify a suspected contradiction

Start from a rendered human-attention note, then trace backward through:

1. `human-attention-notes.json` for the raw note, group membership, packet id,
   output/suppression disposition, and match facts;
2. `verification.json` for candidates from the same bounded scope;
3. the Stage-7 packet result for direct/promoted origin and `passesRun`; and
4. the verifier reason and repository evidence needed to classify the
   predicate as refuted, unresolved, or ambiguous.

Do not infer an incident merely because a high-risk reject and a same-file note
coexist.

### Step 2: Apply the incident test

Count the case only when all of these hold:

- a real direct candidate was rejected by completed verification;
- the verifier's inspected evidence actually refutes the candidate predicate;
- a singleton note states that same predicate;
- the note survives into the composer or rendered output;
- the failure is attributable to the current resolution contract rather than
  invalid paths, grouping, publication fallback, or verification skipping; and
- a human reviewer agrees the output is self-contradictory.

Classify evidence-unavailable, multi-member, multi-predicate, or cross-pass
cases separately. They are not authorization to suppress.

### Step 3: Record the decision

Append the evidence row and state whether Gate A or B is met. If not met, STOP
without source changes. If met, create a separate implementation plan using
the design requirements below and link it from this file and the plans index.

## Requirements for any future implementation plan

The evidence gate authorizes design work, not the discarded implementation.
A replacement plan must provide all of the following:

1. **Machine-readable predicate disposition.** Introduce or derive a bounded
   structured state that distinguishes at least `refuted` from `unresolved`.
   An unavailable helper, missing decisive evidence, incomplete verification,
   or ambiguous result must be `unresolved`. Do not parse verifier prose to
   manufacture this state.
2. **Exact origin or explicit association.** Preserve enough Stage-7
   generation/pass provenance to prove which candidate and note are related.
   Same pooled `packetId` is insufficient. Prefer an explicit local relation;
   if exact provenance is unavailable, keep the note and STOP.
3. **Bidirectional uniqueness.** The note must map to exactly one qualifying
   candidate, and that candidate must map to exactly one eligible note. One
   candidate matching two notes, or two candidates matching one note, keeps
   every ambiguous note.
4. **Candidate-only identity.** The verifier may return both a structured
   disposition and a prose reason, but the prose must neither be parsed into
   that disposition nor create candidate-to-note identity. No new text
   threshold, embedding, LLM adjudication call, language-specific rule, or
   run-id rule may be introduced without separately measured evidence.
5. **Narrow output scope.** Only singleton, valid-scope direct notes may be
   eligible. Existing promoted-note exact provenance, evidence-backed normal
   resolution, final-finding coverage, Issue-110 publication fallback, note
   caps, and wording remain unchanged.
6. **Auditable removal.** Artifacts and bounded telemetry must identify the
   suppression source, structured predicate disposition, exact association,
   and uniqueness facts without storing unbounded verifier/note prose.

The replacement plan must include adversarial tests proving that all of these
remain visible:

- `reject + requiredEvidencePresent:false + falsePositiveRisk:high` where the
  decisive helper or evidence could not be inspected;
- one candidate associated with two singleton notes;
- two candidates associated with one singleton note;
- same packet/file/symbol but a different predicate;
- candidate and note pooled from different ensemble passes;
- a merged/multi-member group;
- incomplete verification and medium/low-risk rejects; and
- missing/invalid origin or file scope.

It must also include a truly direct, provenance-free run-73-shaped control:
`requiredEvidencePresent:true` continues through
`stage9_verified_predicate`, suppresses through the existing path, and emits no
new direct-adjudication source.

## Scope

**In scope while the gate is closed**:

- Inspect retained eval/production artifacts.
- Update only the evidence ledger, status, and disposition in this plan and
  `specs/plans/README.md`.

**Out of scope while the gate is closed**:

- Any production source, schema, prompt, matcher, telemetry, or test change.
- Parsing verdict prose.
- Reinterpreting `requiredEvidencePresent`, `falsePositiveRisk`, or
  `verificationIncomplete` without a new explicit contract.
- Reusing normal fuzzy similarity as a direct-note deletion rule.
- Holding the 0.5.5 release.

## Done criteria for this measurement plan

- [ ] Every candidate incident is recorded with inspected artifacts and a
      refuted/unresolved/ambiguous classification.
- [ ] Run 72 remains the first positive incident and run 73 remains a negative
      control unless new primary artifacts prove otherwise.
- [ ] Gate A or Gate B is evaluated explicitly.
- [ ] If the gate is not met, no production or test files are changed.
- [ ] If the gate is met, a separate implementation plan satisfies every
      future-design requirement and adversarial test above before coding begins.

## STOP conditions

Stop and leave behavior unchanged if:

- neither measurement gate is met;
- the only proposed discriminator is the current verdict tuple or reason text;
- exact candidate-to-note/pass association cannot be represented;
- a solution relies on same-packet fuzzy similarity alone;
- a solution can suppress an evidence-unavailable or ambiguous predicate;
- a solution changes existing promoted, evidence-backed, finding-coverage, or
  publication-fallback behavior; or
- the issue disappears after a schema/provenance change elsewhere.

## Maintenance notes

This plan intentionally records a real but low-impact inconsistency without
turning one stochastic event into production suppression. Its success outcome
may be deletion: if the issue does not recur, mark it closed/not planned.

If Stage 7 later gains exact candidate-to-hint provenance or Stage 9 gains a
machine-readable refuted/unresolved distinction for another justified reason,
re-evaluate 113 against those contracts. Reuse them only if they eliminate the
ambiguity described here; do not preserve a separate semantic bridge merely
because this plan once proposed one.
