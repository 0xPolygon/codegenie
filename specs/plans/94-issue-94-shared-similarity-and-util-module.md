# Issue 94: One Shared Similarity/Util Module (Kill the Divergent Copies)

Status: PENDING (simplification backlog; second — mechanical, but divergences must be dispositioned, not silently unified)
Planned from: fable review §6 item 8 (`specs/reviews/1-fable-review.md`); duplicate census re-verified at commit `762339d`, 2026-07-04
Planned at: commit `762339d` (branch `next`)
Recommended priority: after plan 93. Mechanical consolidation, but two of the copies encode *behavioral* divergences that plans in this session leaned on — unification is a disposition exercise, not a find/replace.

## Problem

Re-verified census at current HEAD (worse than the review's count):

| Helper | Copies | Notes |
|---|---|---|
| `isTestPath` | **5** | at least two divergent regexes (e.g. composer's vs coverage-escalation's `_test.` handling) |
| `stableJson` | 4 | |
| `escapeRegExp` | 4 | |
| `tokenJaccard`/`normalizedTerms` | 4 | human-attention + composer families |
| `followUpHintKey` | 3 | one copy is dead (unused-var lint in lens-runner since plan 84) |

~300-400 lines of duplication, and the real hazard is silent divergence: a fix to one `isTestPath` doesn't propagate, and two subsystems can disagree about whether the same file is a test. Plan 87's deletion of the verifier's fuzzy helpers already removed one family; this finishes the job.

## Design

1. **New `src/util/text-similarity.ts`** (tokenJaccard, normalizedTerms, normalize/normalizeCode where shared) and **`src/util/path-roles.ts`** (`isTestPath`, `isDocsPath`) — or fold into existing util files if a natural home exists; no new concepts, only relocation.
2. **Disposition each divergence explicitly before unifying.** For every helper with non-identical copies: diff the copies, decide the canonical semantics, and record in this plan which call sites change behavior. `isTestPath` is the sensitive one — coverage-escalation (E2 telemetry), composer path-role ranking, and file-classifier semantics must be compared; if two genuinely need different semantics, give them two *named* exports (`isTestPath`, `isTestPathStrict`) rather than one lying name.
3. **Delete the dead `followUpHintKey`** copy outright (the lens-runner one flagged unused since plan 84).
4. **Convention note in the module docblock:** new similarity/path helpers land here first; copies in stage files are a review flag.

## Telemetry/eval grounding

The E1 escalator and E2 candidate telemetry (plan 92) both consume test-path classification; the attention instrument records per-packet coverage sources. If unification changes any call site's classification, the attention records and `coverage_escalated` events on the next owner run make the drift visible immediately — check them in validation rather than assuming the unification was semantics-free.

## Validation (harness)

- Full unit suite; any intentionally-changed call-site semantics get their own pinning test.
- One owner eval run: `coverage_escalated` count, attention `coverageSource` distribution, and human-attention suppression counts comparable to the runs 51-54 baseline.

## Done Criteria

- Single implementation per helper (or explicitly-named variants); zero copies in stage files; dead copy gone; divergence dispositions recorded in this plan's status block.

## Stop Conditions

- If a divergence turns out to be load-bearing in a way that can't be captured by a named variant (behavior change on the harness), keep that call site's local copy with a comment linking here — never ship a silent semantics change to hit a line-count target.
