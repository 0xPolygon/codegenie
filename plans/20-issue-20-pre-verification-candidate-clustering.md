# Issue 20: Pre-Verification Candidate Clustering

Status: PENDING
Planned at: a47a23b, 2026-06-14

## Problem

Stage 9 spent extra calls verifying multiple candidates that described the same root issue from different packet anchors. The latest run had more verification calls than the prior run while final output quality was similar. Duplicate candidates should be clustered before LLM verification so the verifier receives a richer root-cause packet once instead of repeating the same work.

## Plan

1. Add deterministic pre-verification clustering for candidate findings.
2. Use conservative cluster keys:
   - normalized title or failure mode
   - category
   - primary path or related root files
   - overlapping changed symbols or related evidence
3. Avoid unsafe merges:
   - do not cluster candidates with conflicting categories unless their failure modes strongly match
   - do not cluster unrelated files solely because titles are similar
   - keep high/critical candidates separate when ambiguity is high
4. Send one representative candidate plus sibling evidence to the verifier.
5. If the verifier keeps the issue, propagate source candidate ids into the final candidate for composition and eval matching.
6. Record cluster size and skipped duplicates in telemetry.

## Likely Files

- `src/pipeline/verifier.ts`
- `src/pipeline/lens-runner.ts`
- `src/pipeline/types.ts`
- `src/telemetry/telemetry-recorder.ts`
- `tests/pipeline-phase9.test.ts`
- `tests/pipeline-phase10.test.ts`

## Tests

- Unit test: duplicate routing candidates cluster into one verification request.
- Unit test: similar titles with different failure modes do not cluster.
- Unit test: verifier keep result preserves source candidate ids and sibling paths.
- Telemetry test: cluster counts are recorded with `stage: 9`.

## Acceptance Criteria

- Stage 9 model calls drop for duplicated candidate sets without losing final findings.
- Final findings retain enough source evidence for eval matching and debugging.
- Verification remains conservative and does not hide materially different bugs.
