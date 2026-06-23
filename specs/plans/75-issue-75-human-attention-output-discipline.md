# Issue 75: Human-Attention Output Discipline

Status: PENDING
Planned from: trails-api eval `0c4d5213/logs/34` compared with `0c4d5213/logs/33`, 2026-06-19
Planned at: commit `f62da93`
Recommended priority: medium. This is output-quality hardening after Issues 70-74; it should not change Stage 7 recall, verifier strictness, or final finding selection.

> Executor instructions: follow this plan step by step. Run each verification command before moving on. If any STOP condition occurs, stop and report rather than improvising.
>
> Drift check: `git diff --stat f62da93..HEAD -- src/pipeline/human-attention.ts src/pipeline/system-reviewer.ts src/pipeline/composer.ts tests/pipeline-phase5.test.ts src/types.ts`
> If any in-scope file changed since this plan was written, compare the "Current State" excerpts below against the live code before editing.

## Problem

Run 34 passed the eval, but it printed five `Needs Human Attention` notes. Run 33 printed none.

The difference was not that run 34 had no real findings. It found every required and optional expectation. The difference was that more unresolved notes survived Stage 10 filtering:

```text
Run 33:
  raw human-attention notes: 25
  grouped notes: 9
  suppressed by final findings: 8
  suppressed by Stage 9 verification: 1
  final Needs Human Attention notes: 0

Run 34:
  raw human-attention notes: 36
  grouped notes: 19
  suppressed by final findings: 12
  suppressed by Stage 9 verification: 1
  final Needs Human Attention notes: 5
  omitted by output cap: 1
```

The surviving notes fell into two classes:

1. A follow-up hint was promoted to Stage 9, Stage 9 rejected it as non-actionable, and the original note still surfaced. Example: the LiFi malformed-input note was rejected because stricter malformed-input parsing was documented hardening and the realistic zero/missing-price fallback was preserved.

2. A light call-site packet emitted a helper-equivalence question even though a separate deep helper packet had already reviewed the shared helper and resolved the same behavior-preservation predicate. Example: `workers/helpers.go` reviewed `workerLoop` deeply and concluded lifecycle semantics were preserved, but light `workers/relay_monitor.go` and `workers/hyperlane_monitor.go` packets had zero tool calls and emitted unresolved `workerLoop` notes.

`Needs Human Attention` should mean "this material predicate remained unresolved after the pipeline used the evidence it had." It should not be a dump of stale promoted rejects or questions already resolved by a stronger packet.

## Rationale

Do not reduce Stage 7 hint generation. Stage 7 should still be allowed to surface concrete unresolved risk. Do not loosen or bypass Stage 9 verification. The verifier did useful work in run 34.

The right fix is at the output reconciliation boundary:

```text
Stage 7 can ask.
Stage 8/9 or a stronger packet can resolve.
Stage 10 should only show what is still genuinely unresolved.
```

This plan avoids target-language rules, repo-specific symbol names, or fixed risk categories. It uses two generic signals already present in the architecture:

- exact provenance from an uncertainty-promoted candidate back to its source note;
- high-confidence no-finding reasoning from a non-simple packet that shares the same helper/callee symbol and semantic terms as a call-site note.

## Current State

Relevant files:

- `src/pipeline/human-attention.ts` builds raw notes, groups near-duplicates, suppresses groups covered by final findings, and suppresses groups resolved by Stage 9.
- `src/pipeline/composer.ts` calls human-attention selection before rendering the final review and writes `human-attention-notes.json`.
- `src/pipeline/system-reviewer.ts` builds Stage 8 tasks only from repeated follow-up hints.
- `tests/pipeline-phase5.test.ts` contains existing pipeline/composer/human-attention tests.
- `src/types.ts` contains `PacketReviewResult`, `ReviewPacket`, `VerificationVerdict`, and note/finding types.

Current `selectHumanAttentionForOutput()` only suppresses by final findings and verification resolutions:

```ts
// src/pipeline/human-attention.ts:219-230
export function selectHumanAttentionForOutput(
  groups: AttentionHintGroup[],
  findings: FinalFinding[],
  packetsById: Map<string, ReviewPacket>,
  verificationResolutions: VerificationResolution[],
  telemetry?: TelemetryRecorder
): HumanAttentionOutput {
  const availableAfterFindings = groups.filter((group) => !findings.some((finding) => attentionGroupCoveredByFinding(group, finding, packetsById)));
  const suppressedByFindingGroups = groups.filter((group) => !availableAfterFindings.includes(group));
  const suppressedByFindings = suppressedByFindingGroups.map(toAttentionNote);
  const verificationSuppression = suppressAttentionGroupsResolvedByVerification(availableAfterFindings, verificationResolutions);
  const selected = selectHumanAttentionGroups(verificationSuppression.available);
```

Current verification-resolution indexing drops verifier rejects unless `requiredEvidencePresent === true`:

```ts
// src/pipeline/human-attention.ts:307-320
export function buildVerificationResolutionIndex(
  verdicts: VerificationVerdict[],
  packetResults: PacketReviewResult[],
  verifiedFindings: CandidateFinding[],
  packetsById: Map<string, ReviewPacket>,
  coverage: RunCoverageStatus
): VerificationResolution[] {
  if (coverage.verificationSkipped === true || verdicts.length === 0) {
    return [];
  }
  const candidatesById = candidateFindingsById(packetResults, verifiedFindings, verdicts);
  return verdicts.flatMap((verdict): VerificationResolution[] => {
    if (!verdictResolvesPredicate(verdict)) {
      return [];
    }
```

Current predicate-resolution rule:

```ts
// src/pipeline/human-attention.ts:827-831
function verdictResolvesPredicate(verdict: VerificationVerdict): boolean {
  return verdict.verificationIncomplete !== true &&
    verdict.requiredEvidencePresent === true &&
    !/^verification disabled by config$/iu.test(verdict.reason.trim());
}
```

Current Stage 8 repeated-hint detection requires exact normalized question/files/symbols grouping and then requires more than one packet in the exact group:

```ts
// src/pipeline/system-reviewer.ts:348-390
function repeatedHintGroups(packetResults: PacketReviewResult[]): HintGroup[] {
  const groups = new Map<string, HintGroup>();
  for (const result of packetResults) {
    for (const hint of result.followUpHints) {
      const question = hint.question.trim();
      if (question.length === 0 || hint.confidence === "low") {
        continue;
      }
      const files = cleanStrings(hint.files);
      const symbols = cleanStrings(hint.symbols);
      const suggestedLenses = cleanStrings(hint.suggestedLenses);
      const key = followUpHintKey({ question, files, symbols });
      ...
    }
  }
  return [...groups.values()].filter((group) => group.packetIds.length > 1);
}
```

Run 34's `workerLoop` call-site packets were `light/simple`, so they had zero tool calls:

```text
workers/relay_monitor.go packet:
  coverage: light
  reviewProfile: simple
  toolBudget.maxToolCalls: 0
  output: follow-up hint asking whether workerLoop preserves wg.Wait/error semantics

workers/helpers.go packet:
  coverage: deep
  reviewProfile: investigate
  noFindingReason: workerLoop preserves ticker, ctx.Done, wg.Wait, and log-and-continue behavior
```

## Commands You Will Need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck | `pnpm run typecheck` | exit 0, no TypeScript errors |
| Tests | `pnpm test -- tests/pipeline-phase5.test.ts` | exit 0, new and existing tests pass |
| Full tests | `pnpm test` | exit 0 |
| Build | `pnpm run build` | exit 0 |

## Scope

In scope:

- `src/pipeline/human-attention.ts`
- `src/pipeline/composer.ts` only if the human-attention selector needs one more argument
- `src/pipeline/system-reviewer.ts` only if resolving grouped helper hints is simpler than Stage 10 suppression for a specific implementation detail
- `src/types.ts` only for small optional type fields needed by artifacts or resolved hints
- `tests/pipeline-phase5.test.ts`
- `plans/README.md`
- this plan file

Out of scope:

- Stage 7 prompt changes.
- Stage 9 verifier policy changes.
- Changing the maximum number of human-attention notes.
- Suppressing notes merely because they are annoying.
- Any target-language or repository-specific special case such as `workerLoop`, `NewBigIntFromNumberString`, LiFi, Sushi, Zerox, Go, or trails-api.
- Adding a taxonomy of concern kinds.

## Functional Spec

### 1. Suppress exact-source notes when Stage 9 adjudicates their promoted candidate as non-actionable

Extend the Stage 9 note-resolution model so a completed reject can resolve the exact source note even when `requiredEvidencePresent === false`.

Required behavior:

- If a candidate has `provenance.source === "uncertainty_promotion"` and Stage 9 returns:
  - `verdict: "reject"`;
  - `verificationIncomplete !== true`;
  - `falsePositiveRisk === "high"`;
  - and the note group matches the candidate provenance by source packet, source kind, question key, and files,
  then suppress that exact note group.
- This suppression must be provenance-only. Do not use fuzzy file/symbol/term similarity for this rejected-candidate mode.
- Do not suppress when:
  - `verificationIncomplete === true`;
  - `falsePositiveRisk` is not `"high"`;
  - the group does not match the promoted candidate provenance;
  - the reject came from an unrelated direct candidate with no note provenance.

Interaction to accept consciously: this makes a high-false-positive-risk reject final — it removes the human-attention breadcrumb for a predicate the verifier confidently judged a non-issue. That is the intended outcome (re-surfacing a confident reject is noise), and it is acceptable because Issue 73 raised verifier reasoning quality. The `falsePositiveRisk === "high"` gate is what keeps it safe: a reject that is merely uncertain (`medium`/`low` risk, or evidence-unavailable) still leaves the note visible.

Suggested implementation:

- Rename `VerificationResolution` internally to something more accurate such as `AttentionResolution`, or add a `source`/`mode` field:

```ts
type AttentionResolution = {
  source: "stage9_verified_predicate" | "stage9_adjudicated_reject";
  candidateId: string;
  verdict: VerificationVerdict["verdict"];
  reason: string;
  files: string[];
  symbols: string[];
  terms: Set<string>;
  questionKeys: Set<string>;
  provenance?: CandidateFindingProvenance;
};
```

- Keep the existing `requiredEvidencePresent === true` path for normal verified predicate resolution.
- Add the adjudicated-reject path only for exact promoted-note provenance.
- In `attentionGroupResolvedByVerification()`, if `source === "stage9_adjudicated_reject"`, return a match only through `attentionGroupMatchesProvenance()`. Do not fall through to fuzzy matching.

Telemetry/artifact:

- In `human-attention-notes.json`, include the suppression record under the existing `suppressedByVerification` list or a renamed equivalent. The record must show:
  - `candidateId`;
  - `verdict: "reject"`;
  - reason such as `adjudicated by stage 9 reject verdict for <candidateId>`;
  - `provenanceMatched: true`.
- Emit one Stage 10 telemetry event when this path suppresses at least one group:
  - `message: "human_attention_hints_suppressed_by_adjudicated_reject"`
  - `data.suppressed`.

### 2. (Conditional) Suppress call-site helper notes already resolved by a stronger no-finding packet

**Implement Step 1 first, then re-measure before doing this step.** Step 1 is provenance-exact and low-risk. Step 2 is a heuristic — it lets a strong no-finding packet "cover" a weaker packet's question — and it carries real over-suppression risk. After Step 1 ships, re-run the eval and inspect `human-attention-notes.json`. **Do Step 2 only if redundant helper/callee notes still survive.** If Step 1 clears the noise, skip Step 2 entirely; it is not required to close this issue.

If Step 2 is needed, add a bounded, generic suppression path for helper/callee equivalence notes.

Required behavior:

- Build a small index of conclusive no-finding packet reviews from `packetResults` and `packets`.
- A packet can resolve notes only when all of these are true:
  - `result.reviewStatus === "no_findings"`;
  - `result.status === "completed"`;
  - `result.findings.length === 0`;
  - `result.followUpHints.length === 0`;
  - `result.uncertainties.length === 0`;
  - `result.noFindingReason` is non-empty;
  - the associated `ReviewPacket.reviewProfile` is not `"simple"`;
  - the associated `ReviewPacket.coverage` is `"normal"` or `"deep"`.
- Extract resolution scope from the packet:
  - packet path and oldPath;
  - `packet.symbolFacts[].enclosingSymbol` (the symbols the packet actually reviewed in depth);
  - `result.noFindingReason`.
- Suppress a human-attention group only when **all** of these hold:
  - it shares at least one normalized symbol with one of the no-finding packet's **enclosing/primary** symbols (`symbolFacts[].enclosingSymbol`) — not merely a symbol the packet happened to mention;
  - that shared symbol also appears in `result.noFindingReason`, so the packet's stated **conclusion** demonstrably addressed that symbol's behavior;
  - it has strong semantic overlap with the no-finding reason.

Suggested overlap gate:

```text
shared enclosing/primary symbol required
AND the shared symbol appears in noFindingReason
AND (
  shared normalized terms >= 5
  OR token similarity >= 0.35
)
```

Keep the threshold conservative. The goal is to suppress the run 34 `workerLoop`-style case where the no-finding reason explicitly resolves `wg.Wait`, `ticker`, `ctx.Done`, and error logging. It must not suppress a call-site note just because both mention the same helper, and it must not let a packet that merely *mentioned* a symbol resolve a question about it — only a packet that *deeply reviewed and concluded on* that symbol may.

Telemetry/artifact:

- Add a suppression record in `human-attention-notes.json` with a distinct source, for example:

```json
"suppressedByPacketResolution": [
  {
    "groupKey": "...",
    "noteIds": ["..."],
    "packetId": "ce1d77...",
    "reason": "resolved by no-finding packet review",
    "match": {
      "sharedSymbols": ["workerloop"],
      "sharedTerms": 8,
      "similarity": 0.42
    }
  }
]
```

- Emit Stage 10 telemetry:
  - `message: "human_attention_hints_suppressed_by_packet_resolution"`;
  - include `suppressed`, `remainingGroups`, and capped examples.

### 3. Keep Stage 8 narrow; do not add a broad task fanout in this plan

Run 34 showed that Stage 8 did not group helper notes because exact keys included call-site-specific files. That is real, but the lowest-risk fix is Stage 10 reconciliation with already available packet evidence.

Do not add a new Stage 8 task source unless the implementation of Step 2 is impossible without it.

If you must touch Stage 8:

- group only repeated helper/callee notes that share a symbol and strong semantic overlap;
- keep `MAX_SYSTEM_REVIEW_TASKS` unchanged;
- ensure resolved Stage 8 tasks suppress all source hints in the group, not just the representative question;
- add tests proving unrelated same-symbol questions do not merge.

Prefer not to do this in v1.

### 4. Preserve genuine human-attention output

Do not suppress a note unless one of these is true:

- final findings cover it;
- Stage 9 verified or rejected its exact promoted candidate as high false-positive risk;
- a non-simple no-finding packet resolved the same symbol and same semantic predicate with strong overlap;
- Stage 8 explicitly resolved it.

This means some human-attention notes should still survive. For example:

- a single medium-confidence note about an external API's input format can remain if no candidate was verified/rejected and no packet resolved it;
- a verification-incomplete candidate can remain;
- a note can remain when the verifier says evidence was unavailable rather than high false-positive risk.

## Implementation Notes

Recommended code shape:

1. In `src/pipeline/human-attention.ts`, introduce a more general resolution type rather than stretching the meaning of `VerificationResolution`.
   - Keep the exported API stable if possible by adding a new helper and leaving the old name as a wrapper.
   - Avoid a large rename if it creates churn.

2. Build the packet no-finding resolution index in the same module because it uses the same token/symbol matching helpers as note suppression.

3. Update `selectHumanAttentionForOutput()` to apply suppression in this order:

```text
raw groups
  -> suppress groups covered by final findings
  -> suppress groups resolved/adjudicated by Stage 9
  -> suppress groups resolved by conclusive no-finding packet reviews
  -> select at most MAX_HUMAN_ATTENTION_NOTES
```

4. Update `humanAttentionArtifact()` to expose the new suppression category.

5. Update `composer.ts` only as needed to pass packet results into the selector if the selector cannot build packet resolutions from existing arguments.

Naming guidance:

- Prefer terms like `attention resolution`, `packet resolution`, or `adjudicated reject`.
- Avoid names like `workerLoopResolution` or `parserSuppression`.

## Test Plan

Add focused tests in `tests/pipeline-phase5.test.ts`. Use existing human-attention tests as the structural pattern.

Required tests:

1. Exact promoted reject suppresses its source note.
   - Build a packet result with one medium follow-up hint.
   - Build a promoted candidate with `provenance` pointing to that hint.
   - Build a Stage 9 reject verdict with `falsePositiveRisk: "high"`, `verificationIncomplete !== true`, and `requiredEvidencePresent: false`.
   - Assert final human-attention output has zero notes.
   - Assert artifact/suppression data records provenance matched.

2. Incomplete or non-high-risk reject does not suppress.
   - Repeat test 1 with `verificationIncomplete: true`, or with `falsePositiveRisk: "medium"`.
   - Assert the note remains.

Tests 3–6 below cover Step 2 (the conditional helper-resolution path). Implement them only if you implement Step 2.

3. Conclusive helper no-finding packet suppresses a matching call-site note.
   - Use neutral synthetic names, for example `sharedLoop`, `ServiceWorker.run`, `OtherWorker.run`.
   - Create an investigate/deep packet result whose **enclosing symbol** is `sharedLoop`, with `reviewStatus: "no_findings"` and a no-finding reason that explicitly **names `sharedLoop`** and says it preserves `wait`, `ticker`, `context cancel`, and `log-and-continue` behavior.
   - Create a light/simple call-site packet result with a follow-up hint asking whether `sharedLoop` preserves `wait`, `ticker`, `context cancel`, and error behavior.
   - Assert the note is suppressed by packet resolution.

4. Same symbol but different predicate does not suppress.
   - Use the same `sharedLoop` symbol.
   - Make the call-site note ask about a different predicate, such as argument ordering or metric naming.
   - Assert the note remains.

5. A packet that only *mentions* the symbol does not suppress.
   - The no-finding packet's enclosing symbol is something else (e.g. `Caller.run`), and `sharedLoop` appears only incidentally (not in `noFindingReason`).
   - Assert the call-site note about `sharedLoop` remains.

6. Simple packet no-finding does not suppress.
   - Same as test 3, but make the no-finding packet `reviewProfile: "simple"` or `coverage: "light"`.
   - Assert the note remains.

7. Findings unchanged regardless of attention suppression (always applies, not Step-2-only).
   - If there is an existing composer fixture pattern, add a regression-style unit test that ensures suppressing human-attention notes does not alter final finding count, severity, confidence, anchors, or publication.

Verification:

```bash
pnpm test -- tests/pipeline-phase5.test.ts
pnpm run typecheck
pnpm run build
```

Expected result: all commands exit 0.

Eval validation (the real proof — unit tests can't show it):

- Re-run `0c4d5213` and read `human-attention-notes.json`. The 5 run-34-style notes should drop to roughly 0–1.
- For each note that *remains*, confirm from the artifact that it is genuinely unresolved — not covered by a final finding, not a high-FP-risk Stage 9 reject of its own promoted candidate, and not resolved by a conclusive non-simple no-finding packet on the same symbol.
- Confirm `should_find` matches and final finding count/severity/confidence are unchanged versus run 34 (this plan must not move recall — only notes).

```bash
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/0c4d5213 --no-cache
```

## Done Criteria

- [ ] (Step 1) Run 34-style promoted rejects with exact source-note provenance are suppressed from final human-attention output when the verifier rejects them as high false-positive risk.
- [ ] (Step 1) Verification-incomplete or non-high-risk rejects still leave their source notes available.
- [ ] Eval `0c4d5213` shows the run-34 note noise dropping to ~0–1, with every remaining note explainable as genuinely unresolved, and findings unchanged.
- [ ] (Step 2, only if implemented) Run 34-style helper call-site notes are suppressed when a non-simple no-finding packet whose enclosing symbol matches, and whose `noFindingReason` names that symbol, resolved the same predicate.
- [ ] (Step 2, only if implemented) Same-symbol/different-predicate notes, and notes where the packet only *mentioned* the symbol, are not suppressed.
- [ ] `human-attention-notes.json` records why each new suppression happened.
- [ ] Stage 7 candidate generation, Stage 9 verification, final finding selection, and max human-attention cap are unchanged.
- [ ] `pnpm test -- tests/pipeline-phase5.test.ts` exits 0.
- [ ] `pnpm run typecheck` exits 0.
- [ ] `pnpm run build` exits 0.
- [ ] `plans/README.md` marks Issue 75 complete after implementation.

## STOP Conditions

Stop and report if:

- Suppressing run 34-style notes requires changing Stage 7 prompts or verifier policy.
- The implementation would suppress all `requiredEvidencePresent: false` rejects rather than exact promoted-note rejects only.
- The implementation needs repo-specific names such as `workerLoop`, LiFi, Sushi, Zerox, or Go.
- Packet no-finding suppression cannot be implemented without broad fuzzy matching that ignores symbols.
- Tests show a genuine unresolved medium-confidence note gets suppressed without final finding coverage, exact Stage 9 provenance, Stage 8 resolution, or packet no-finding resolution.

## Maintenance Notes

`Needs Human Attention` should stay rare. It is useful when it is short, concrete, and genuinely unresolved; it is harmful when it repeats verifier rejects or packet-local budget gaps.

Future changes to uncertainty promotion, Stage 8 grouping, or final composition should preserve this invariant:

```text
If the pipeline already adjudicated or resolved a note's predicate, do not ask the human to re-adjudicate it.
```

If later evals still produce noisy notes, inspect `human-attention-notes.json` first. The artifact should make each output note explainable as one of:

- not covered by final findings;
- not resolved by Stage 9;
- not resolved by Stage 8;
- not resolved by any conclusive packet no-finding review.

