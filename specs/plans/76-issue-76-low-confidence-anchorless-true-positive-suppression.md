# Issue 76: Low-Confidence Anchorless True-Positive Suppression at the Verification Pre-Gate

Status: PENDING
Planned from: trails-api eval `0c4d5213/logs/36` (fail) compared with `0c4d5213/logs/34` (pass) and the per-run candidate history for `a81d5adf-f1`, 2026-06-20
Planned at: commit `4f670b2` (branch `next`)
Revised: v5 — tightens the representative-anchor publication boundary, makes Tier 1 matching conservative on ambiguous snippets, and avoids over-scoping Stage 8 parity. v4 normalized the plan status/index, kept lane-cap handling telemetry-first, and tightened validation expectations. v3 corrected two facts after re-checking the code/artifacts (anchor text inference runs off the **packet**, which carries hunk line content; the evidence-resolution lane is **already severity-sorted**, not generation order). v2 introduced the phased A-then-B shape, the two-tier anchor, the provenance enum, and the gate-reason ordering fix.
Recommended priority: high. A real, repeatedly-confirmed regression finding is lost to a gate that conflates "the model did not emit a structured anchor" with "this finding is not about changed code". The eval has no protection against this flake today.

## Problem

Run 36 failed on exactly one required expectation, `amountfromusd-zero-decimal-token`. The candidate **was generated** — the same deterministic candidate `a81d5adf-f1` that has been found and kept across prior passing runs — but Stage 9 suppressed it **before any verification model call**:

```text
candidateId  a81d5adf-f1
gate         suppressed
gateReason   low_confidence_no_changed_line_anchor
gateFacts    { confidence: low, changedLine: false, anchor: null,
               hasChangedCode: true, hasFailureMode: true,
               failureModeConcrete: true, relatedEvidenceCount: 2,
               category: correctness, severity: low }
```

The finding is a genuine accidental regression (run 34's verifier produced a detailed `keep` verdict: old `protocol.DecimalsFactor(0)=1` succeeded; new `quotes.AmountFromUSD` hard-errors on a 0-decimal origin token). The harness *wants* to find it. It was lost to sampling variance, not to a code regression.

### Root cause

This candidate sits on the suppression boundary and Stage 7 re-samples it every run (eval uses `--no-cache`). Its history on the two model-emitted fields, restricted to runs where the candidate was actually generated and candidate artifacts exist (excludes run 24 — no candidate artifacts; run 35 — config error, no pipeline; run 14 — candidate not generated at all, a separate and rarer `missed-before-candidate-generation` loss):

```text
runs 10–13,15–23,28–34:  conf=medium  anchor=YES   PASS
run 25:                  conf=medium  anchor=NO    PASS  (medium bypasses the low-conf branch)
run 26:                  conf=LOW     anchor=YES   PASS  (low+anchor -> evidence_resolution lane)
run 27:                  conf=LOW     anchor=YES   PASS  (low+anchor -> evidence_resolution lane)
run 36:                  conf=LOW     anchor=NO    FAIL  <- first time BOTH draws went bad
```

The gate (`src/pipeline/verifier.ts`) only kills a finding when confidence is low **and** there is no changed-line anchor. Each draw alone is survivable:

- `minConfidence` defaults to `medium` (`src/config/schema.ts:193`), so a medium finding takes the `meets_confidence_threshold` standard lane regardless of anchor (run 25).
- A low-confidence finding *with* an anchor takes the `low_confidence_evidence_backed` evidence-resolution lane (runs 26, 27).

Run 36 is the first observed run where both unlucky draws coincided. Among the 24 valid candidate-bearing runs, low-confidence occurred 3 times and missing-anchor 2 times; the observed joint occurrence is 1/24, while the marginal-rate product is about 1%. Either way, it is rare enough that the eval passed for a long stretch and then failed without warning. The instability predates plans 69–73 (runs 25–27 already wobbled, before plan-69 landed) and the only functional code delta between run 34 and run 36 — `capSeverityForBehaviorChange` (commit `f62da93`) — is a verified no-op for an `accidental_regression`/`low` finding. **No plan caused this; the gate has always been able to drop this class of finding.**

### Why the gate is wrong here

`candidateGateFacts()` computes relevance to changed code two ways:

```ts
changedLine: candidate.changedLine === true && candidate.anchor !== undefined,  // flaky: model-emitted structured anchor
hasChangedCode: candidate.evidence.changedCode.trim().length > 0,               // robust: model quoted the changed code
```

`changedLine` is a **placement** signal (where to put the inline comment). `hasChangedCode` is the **relevance** signal (is this finding about the diff). The evidence-backed lane and the `low_confidence_no_changed_line_anchor` suppression currently gate *relevance* on the *placement* field. When Stage 7 quotes the changed code (`hasChangedCode: true`) but forgets to emit a structured anchor (`changedLine: false`), the gate misreads a placement gap as an off-diff finding and suppresses a relevant, evidence-backed candidate before verification — the system's actual false-positive backstop.

## Goal

Stop losing low-confidence, evidence-backed, on-diff true positives solely because Stage 7 did not emit a structured anchor, while keeping the gate's noise-suppression intent and the verifier as the false-positive backstop. Make the trails-api `0c4d5213` eval pass deterministically across repeated `--no-cache` runs — **without** introducing wrong-line inline comments or widening low-confidence noise more than necessary.

## Strategy: phase the fix

Two independent levers each make run 36 pass. They carry different risk, so they ship in order, not together:

- **Phase 1 (primary, low blast radius): recover the anchor.** A derivable anchor was thrown away; reconstruct it. This restores `changedLine: true`, so the finding qualifies through the *existing, unmodified* evidence lane. No admission-policy change.
- **Phase 2 (conditional hardening): stop gating relevance on placement.** Only if Phase 1 proves insufficient — or if real cases surface where no anchor can be reconstructed — relax the gate to read `hasChangedCode`, and guard the lane cap (telemetry first, ordering changes only if it bites) so the relaxed admission cannot crowd out high-value candidates.

This sequencing is deliberate: Phase 1 is a deterministic data-repair with a contained surface; Phase 2 changes verifier admission policy and must not regress `should_not_find` cases or the lane cap.

## Design

### Phase 1 — Two-tier anchor reconstruction with explicit provenance

The key correctness principle from review: **a gate anchor and a publication anchor are not the same thing.** Proving a finding is on-diff (to survive the gate) tolerates a coarse anchor; placing an inline comment does not. So reconstruction is two-tier:

**Tier 1 — precise, publishable.** `inferAnchorFromChangedCode(packet, changedCode)`:
- Operates on the **packet** hunk text. `PacketHunk` carries `lines: PacketLine[]` (each with `kind: "add" | "delete" | "context"`, `content`, `newLine`/`oldLine`) plus `contentWithLineNumbers` — verified present on the run-36 `a81d5adf` packet. `stampFinding` already receives the packet, so no extra plumbing; the full `UnifiedDiff` is not needed as the text source. Optionally re-validate the result against the diff via the existing `validateAnchorForDiff`.
- Normalizes whitespace and matches the model's `evidence.changedCode` against the hunk's changed lines (`kind: "add"` → RIGHT/`newLine`, `kind: "delete"` → LEFT/`oldLine`); on a multi-line quote, prefer a unique representative non-trivial line or unique contiguous normalized sequence. Ignore trivial lines (braces, commas, very short tokens). If the snippet matches multiple changed lines/hunks, treat it as ambiguous and fall back to Tier 2 instead of publishing a guessed line. Returns a `DiffAnchor` at the matched line + its `hunkId`.
- Exact byte-match will frequently fail (models reflow, truncate, or paraphrase quoted code), so normalization matters and failure is an expected path — that is precisely why Tier 2 exists.
- Result is safe to **persist** to `candidate-findings.json` and to publish inline.

**Tier 2 — coarse, gate-only.** `representativeAnchorFromPacket(packet)`:
- First RIGHT-side `changedNewLineNumbers[0]` of the first hunk; LEFT-side `changedOldLineNumbers[0]` fallback for pure-deletion packets; `undefined` if the packet has no changed lines.
- Proves on-diff-ness (passes `validateAnchorForPacket` / `validateAnchorForDiff` by construction) but may point at the wrong line. It may travel on the in-memory candidate that is scheduled for verification, because `preGateAnchor` returns a modified candidate, but consumers must treat `anchorSource: "backfill_packet_representative"` as **gate-only**. Never write it back to Stage 7 candidate artifacts as a precise model anchor, and never publish it as a confident inline location.

```ts
// src/pipeline/pipeline-utils.ts
export function inferAnchorFromChangedCode(
  packet: ReviewPacket,
  changedCode: string
): DiffAnchor | undefined { /* normalized match of changedCode against packet.hunks[].lines (add/delete) */ }

export function representativeAnchorFromPacket(packet: ReviewPacket): DiffAnchor | undefined {
  for (const hunk of packet.hunks) {
    const line = hunk.changedNewLineNumbers[0];
    if (line !== undefined) return { path: packet.path, line, side: "RIGHT", hunkId: hunk.hunkId };
  }
  for (const hunk of packet.hunks) {
    const line = hunk.changedOldLineNumbers[0];
    if (line !== undefined) return { path: packet.oldPath ?? packet.path, line, side: "LEFT", hunkId: hunk.hunkId };
  }
  return undefined;
}
```

**Provenance.** Add a separate top-level anchor provenance field on `CandidateFinding` (`src/types.ts`); do not overload the existing `provenance` field, which currently means uncertainty-promotion provenance. Replace any boolean flag with an explicit source enum, because a boolean goes ambiguous the moment there are two backfill paths:

```ts
anchorSource: "model" | "backfill_changed_code" | "backfill_packet_representative" | "verifier_revised";
```

And distinguish, in gate facts / telemetry, **`modelAnchorSubmitted`** (did Stage 7 provide an anchor at all), **`modelAnchorValid`** (did that submitted anchor normalize/validate), and **`validAnchorPresent`** (is there a valid anchor now, possibly reconstructed). After reconstruction a bare `anchorPresent` would be unreadable.

**Where each tier runs:**
- `stampFinding`: when `normalizeAnchor` yields `undefined` and `changedCode` is non-empty, try Tier 1 only. On success, persist anchor + `changedLine: true` + `anchorSource: "backfill_changed_code"`. On failure, leave the candidate anchorless (do **not** persist a representative anchor) — emit `anchor_inference_failed`.
- `stampSystemFinding`: do not make Stage 8 parity a blocker. System-review tasks do not currently carry a single source `ReviewPacket`; add Tier 1 only if implementation cleanly plumbs the relevant source packet(s) and the changed-code snippet maps unambiguously to one packet. Otherwise let Stage 8 continue to rely on submitted anchors plus diff validation.
- `preGateAnchor`: if still anchorless and `hasChangedCode`, apply Tier 2 for gating, set `anchorSource: "backfill_packet_representative"`, `changedLine: true`. Stage 10 / publication treats `backfill_packet_representative` as low-precision: prefer summary-only or defer to the plan-70 publication-anchor recovery rather than emitting a confident inline at a possibly-wrong line.

With Tier 2 in `preGateAnchor`, the run-36 candidate reaches the gate with `changedLine: true` and qualifies via the **existing** evidence lane — so Phase 1 alone closes the eval gap, no admission change required.

### Phase 2 (conditional) — Gate relevance on `hasChangedCode`, plus lane-cap observability

Trigger Phase 2 only if Phase 1 is insufficient (e.g. a real case where neither tier can reconstruct an anchor but the finding is genuinely on-diff and evidence-backed).

**2a. Relax the lane to the robust signal:**

```ts
function isEvidenceBackedLowConfidenceCandidate(facts: VerificationGateFacts): boolean {
  return facts.hasChangedCode &&            // was: facts.changedLine
    facts.hasFailureMode &&
    facts.failureModeConcrete &&
    facts.relatedEvidenceCount > 0 &&
    (facts.category === "logic_bug" || facts.category === "correctness" || facts.category === "security");
}
```

**2b. Correct the gate-reason ordering (required if 2a lands).** Today `lowConfidenceGateReason()` (`verifier.ts:899`) checks `!changedLine` (line 906) **before** `relatedEvidenceCount === 0` (909) and `!failureModeConcrete` (912). So a no-anchor candidate is labeled `low_confidence_no_changed_line_anchor` even when its real disqualifier is missing evidence or a weak failure mode — the label misattributes the cause. (`missing_evidence` from `gateCandidate` is a *different* check — `hasChangedCode` — and exits earlier; it is not the same as `relatedEvidenceCount === 0`.) Fix: reorder so the evidence and failure-mode reasons are evaluated before the anchor reason, and rename the anchor reason to make clear it is **placement-only** (e.g. `low_confidence_unanchored`), so telemetry stops implying "off-diff" when it means "no structured anchor".

**2c. Lane-cap exposure (telemetry-first; revisit ordering only if it bites).** Relaxing admission means more low-confidence candidates compete for the `EVIDENCE_RESOLUTION_LANE_MAX = 4` slots. The slice is **not** raw generation order: `orderVerifierRepresentatives` (`verifier.ts:926`) already sorts representatives `severityRank → changedLineRank → confidenceRank → id` before `scheduleVerifierRepresentatives` does `slice(0, max)` (preserving that order). The residual risk is narrower than "position ≥5 dropped": severity is the **primary** key, so under 2a a *low-severity* required finding like `a81d5adf` (severity=low) can lose its slot to higher-severity *speculative* low-confidence candidates when the lane overflows. Phase 1 helps here — restoring a (representative) anchor sets `changedLineRank = 0` (the #2 key), nudging the finding up, provided the backfill runs before ordering. **Do not change ordering pre-emptively.** Instead, add telemetry that flags when a *rescued* candidate lands in `evidenceResolutionLaneLimitedCandidateIds`; only then bias the ordering to protect evidence-backed correctness findings (or widen the cap). Do not raise the cap by default.

### Telemetry (both phases)

- Per-candidate gate-fact record carries `anchorSource`, `modelAnchorSubmitted`, `modelAnchorValid`, `validAnchorPresent`.
- Counters in Stage 7 / Stage 9 / run summaries: `anchorInferred` (Tier 1), `anchorRepresentative` (Tier 2), `anchorInferenceFailed`.
- Events: `anchor_inferred { candidateId, hunkId, line, side }`, `anchor_representative { candidateId, hunkId, line, side }`, `anchor_inference_failed { candidateId }`.
- If Phase 2 lands: emit the renamed placement-only reason and a distinct `low_confidence_evidence_backed_unanchored` when 2a admits a candidate that has no anchor even after reconstruction, so the rescue is greppable in eval triage.

## Non-Goals

- Changing Stage 7 model confidence calibration or forcing higher confidence. We make the *gate* robust to existing variance; we do not try to stop the model drawing `low`.
- Changing `review.minConfidence` (stays `medium`).
- Rewriting the Stage 7 submit schema to make `anchor` a hard-required field. Deterministic reconstruction is lower-risk than a schema change that can trigger schema-invalid retries.
- Raising `EVIDENCE_RESOLUTION_LANE_MAX`.
- Anything in plans 69–73; they are not implicated.

## In-Scope Files

- `src/pipeline/pipeline-utils.ts` — `inferAnchorFromChangedCode`, `representativeAnchorFromPacket`.
- `src/pipeline/lens-runner.ts` — Tier 1 inference in `stampFinding`.
- `src/pipeline/system-reviewer.ts` — optional Tier 1 parity only if source packet plumbing is straightforward and unambiguous.
- `src/pipeline/verifier.ts` — Tier 2 in `preGateAnchor` (run before `orderVerifierRepresentatives` so restored `changedLine` improves rank); (Phase 2) relax `isEvidenceBackedLowConfidenceCandidate`, reorder `lowConfidenceGateReason`, and adjust evidence-resolution lane ordering only if lane-cap telemetry shows crowding.
- `src/pipeline/composer.ts` / Stage 10 publication — treat `backfill_packet_representative` as low-precision.
- `src/types.ts` — `anchorSource` on `CandidateFinding`; `modelAnchorSubmitted` / `modelAnchorValid` / `validAnchorPresent` on the gate-fact record.
- `src/telemetry/*` — surface the new counters.
- Tests under the existing pipeline test suite.

## Out of Scope

- Eval harness changes (the run-35 "compare against last completed run, not the errored run" reporting nit is tracked separately).

## Implementation Steps

### Phase 1
1. Add `inferAnchorFromChangedCode(packet, changedCode)` (match against `packet.hunks[].lines`) and `representativeAnchorFromPacket(packet)` to `pipeline-utils.ts`.
2. `stampFinding`: on anchorless + non-empty `changedCode`, try Tier 1; persist with `anchorSource: "backfill_changed_code"` on success, else leave anchorless and emit `anchor_inference_failed`. Keep the `out_of_hunk_anchor` warning; stop emitting `candidate_anchor_summary_only` when Tier 1 succeeds.
3. `preGateAnchor`: on still-anchorless + `hasChangedCode`, apply Tier 2, set `anchorSource: "backfill_packet_representative"`, `changedLine: true`.
4. `applyVerdictAnchor` / verifier revisions: when the verifier supplies `revisedAnchor`, set `anchorSource: "verifier_revised"` so a representative gate anchor can be upgraded to a publishable verifier anchor.
5. Stage 10 publication: route `backfill_packet_representative` to low-precision handling (summary-only or plan-70 recovery).
6. Optional Stage 8 parity: only add Tier 1 to `stampSystemFinding` if the implementation can map the system finding to source packet text without guessing.
7. Provenance + telemetry: `anchorSource`, `modelAnchorSubmitted`, `modelAnchorValid`, `validAnchorPresent`, new counters/events.

### Phase 2 (only if Phase 1 validation shows it is needed)
8. Relax `isEvidenceBackedLowConfidenceCandidate` to `hasChangedCode` (2a).
9. Reorder `lowConfidenceGateReason`; rename the anchor reason to a placement-only label (2b).
10. Add telemetry/tests for rescued candidates that become lane-limited. Only change evidence-resolution lane ordering (or cap) if Phase 2 validation shows a rescued, evidence-backed candidate is crowded out in practice.

### Tests (per phase)
- Tier 1: normalized match against `packet.hunks[].lines` returns the correct line/hunk (`add`→RIGHT/`newLine`, `delete`→LEFT/`oldLine`); whitespace-only differences still match; repeated/ambiguous snippets and paraphrased quotes fail cleanly (→ Tier 2 path); result validates against `validateAnchorForDiff`.
- Tier 2: representative anchor validates against `validateAnchorForPacket` / `validateAnchorForDiff`; deletion-only packet → LEFT; no-changed-line packet → `undefined`.
- Regression fixture reproducing `a81d5adf-f1`'s run-36 facts → reaches verification via Phase 1 alone (changedLine restored), and (Phase 2) via the relaxed lane with anchor absent.
- Gate-reason ordering (Phase 2): a low-confidence, no-related-evidence, no-anchor candidate reports the evidence reason, not the placement reason.
- Lane-cap (Phase 2 only): with an evidence-resolution set of >4, a run-36-shaped low-severity finding either keeps a slot under the chosen ordering, or — if legitimately outranked — surfaces in `evidenceResolutionLaneLimitedCandidateIds` telemetry rather than vanishing silently.
- Negative: a low-confidence finding with empty `changedCode` is still suppressed (`missing_evidence`) — the gate is not blanket-disabled.
- Publication: a `backfill_packet_representative` finding does not emit a confident inline at the representative line; a verifier `revisedAnchor` upgrades the source to `verifier_revised` and is publishable.

## Validation

- `pnpm run build` + pipeline unit suite green.
- Re-run trails-api `0c4d5213` `--no-cache` **N≥10×** after Phase 1; require all pass with `amountfromusd-zero-decimal-token` matched in `final-findings` every run. Confirm the rescue path actually fired at least once (`anchor_inferred` or `anchor_representative` present on a run where Stage 7 omitted the anchor). **Only proceed to Phase 2 if any run still fails.**
- `should_not_find` `lifi-unpriced-fee-false-positive` stays unreported across all N runs (verifier remains the backstop) — re-verify after Phase 2 if landed.
- Budgets hold: `maxFindings ≤ 10`, `maxCostUSD ≤ 30`, `maxModelCalls ≤ 300`. Phase 1 may add verifier work only when it rescues a candidate that would otherwise have been pre-gate suppressed; it should not cause a broad verification-call increase. Phase 2 may add more low-confidence candidates to the evidence-resolution lane — confirm within budget if it lands.
- Inline placement spot-check: reconstructed anchors land on a sensible changed line; representative anchors are not published as confident inlines.
- Sanity-check one other eval case for no spike in reported low-confidence findings.

## Done Criteria

- trails-api `0c4d5213` passes ≥10/10 `--no-cache` runs (Phase 1 alone if sufficient).
- No new `should_not_find` violations and no inline comments on wrong lines.
- Rescue is observable in telemetry (`anchorSource` / counters) rather than silent.
- The gate still suppresses genuinely off-diff / no-evidence low-confidence findings (negative test green).

## Stop Conditions

- If Phase 1 alone achieves 10/10, **do not ship Phase 2** — keep the strict lane and avoid widening low-confidence admission.
- If Tier 1 inference proves unreliable (frequent wrong-line matches in placement spot-checks), tighten its normalization/matching or fall back to Tier 2 gate-only for those cases; never persist a low-confidence text match as a publication anchor.
- If Phase 2 raises false positives elsewhere (new `should_not_find` violations or `maxFindings` breaches), revert 2a and rely on Phase 1.

## Maintenance Notes

- After this lands, watch the candidate history for `a81d5adf-f1`: it should pass on every confidence/anchor draw, not just the lucky ones.
- The principle worth keeping: **relevance to the diff is `hasChangedCode`; the anchor is placement.** Any future gate that suppresses on relevance should read `hasChangedCode`; any code that publishes a location must trust only `model` / `backfill_changed_code` / `verifier_revised` anchors, never `backfill_packet_representative`.
