# Issue 102: Same-File Packet Packing

Status: PENDING
Related: Plan 100 (dispatch rank — decides *which* packets run first; this plan reduces *how many* packets there are). Plans 40/44 (recall calibration — the quality baseline this change must not regress). Plan 79 (recall-variance harness — the gate).
Planned from: production run `.codegenie/runs/20260724-184952-dca8d870` against `0xsequence/trails-api` PR 846 (88 files, 217 hunks, `--max-time 60`, concurrency 4), 2026-07-24
Planned at: commit `e0450ed` (branch `next`)
Recommended priority: after Plan 100 ships and has one clean production run to serve as the packing baseline.

## Evidence

The motivating run produced 96 packets carrying 142 reviewable hunks — average 1.48 hunks per packet, with 73 of 96 packets (76%) single-hunk. Per-packet spend is nearly flat in hunk count, because every packet pays the same fixed freight — skill/lens instructions (12K-char cap), PR summary, file and related context, ~3 model calls, a forced finalize — regardless of how much diff it reviews:

| Packet size | n  | avg calls | avg input tokens | avg call-seconds | per hunk           |
| ----------- | -- | --------- | ---------------- | ---------------- | ------------------ |
| 1 hunk      | 41 | 3.1       | 92K              | 229s             | 92K tok / 229s     |
| 2 hunks     | 8  | 3.0       | 67K              | 206s             | 33K / 103s         |
| 3 hunks     | 3  | 2.7       | 78K              | 158s             | 26K / 53s          |
| 4–5 hunks   | 5  | 3.0       | 109K             | 228s             | ~24K / ~50s        |

Reviewing a hunk alone costs 3–4× more than reviewing it with siblings. Packet count — not hunk volume — drives both the run's $25 cost and its ~90-minute stage-7 queue (which a 60-minute budget covered only 59% of). The comparison is observational (single-hunk packets skew toward heavier files), but the flat initial-prompt sizes across packet sizes (47–79K chars) make the fixed-overhead conclusion robust.

There is no dilution signal at current sizes: larger packets used the same or fewer calls, and the run's one accepted finding — the `acceptRoute` user-fee-cap bypass — came from the 5-hunk `routing_solver.go` packet.

## Problem

`canJoinGroup` (`src/pipeline/packet-builder.ts:1205`) joins consecutive same-file hunks only when they share an enclosing symbol or are nearby. Hunks in different functions of the same file therefore become separate packets, each paying full freight. In the motivating run this predicate — not the caps (`MAX_HUNKS_PER_PACKET = 5`, `MAX_PATCH_CHARS = 12_000`, neither of which was binding) — produced 39 of the 73 single-hunk packets: `handle_execute.go` split 3 hunks into 3 packets, `tests/scenarios/scenarios.go` 3 into 3, `lib/quotes/fees.go`, `rpc/admin.go`, `proto/hashing_test.go` 2 into 2 each, and so on. The remaining 34 singles are singleton files, out of scope here (see Non-Goals).

## Design

Pack same-file hunks up to the existing caps; keep symbol coherence as an ordering preference instead of a join requirement.

- Within a file, order hunks so that same-symbol and nearby groups stay adjacent (the current `canJoinGroup` affinity becomes the sort), then fill packets greedily under the unchanged `MAX_HUNKS_PER_PACKET` and `MAX_PATCH_CHARS` limits. Related hunks still land in the same packet; unrelated same-file hunks now share one instead of paying freight twice.
- Nothing else changes shape: packets remain per-file, per-hunk anchors and coverage levels are already per-hunk, and a packed packet's coverage/priority is the max over its hunks (the current merge rule). Deep-coverage tool budgets apply per packet exactly as today.
- Expected effect on the motivating run: ~39 same-file singles collapse into ~16–18 packets → roughly 20 fewer packets, ~60 fewer model calls, ~$4–5 and ~19 minutes of stage-7 wall time saved at concurrency 4. Combined with Plan 100's dispatch rank and the concurrency-6 default (`e0450ed`), a full deep review of a 90-file PR fits inside one 60-minute run.

## Quality gate (the constraint that decides whether this ships)

The one real risk is recall: reviewer attention spread across more hunks per call. Current recall tuning (Plans 40/44) was calibrated on today's packet shapes, so this change ships dark until measured:

- Land behind a config flag (`review.packSameFileHunks`, default off).
- Run the Plan 79 recall-variance harness on the eval suite with the flag on vs off. Ship-enabled only if recall is within the harness's established variance band while cost/wall-time improve.
- The motivating-run PR is the production A/B: one flag-on run must review at least the same hunk set in less wall time with no drop in accepted findings.

## Non-Goals

- No cross-file batching of singleton-file hunks (34 of the 73 singles). Packets are per-file throughout context building, anchoring, and publishing; batching across files is a separate design with its own plan if the same-file win proves out.
- No cap raises: `MAX_HUNKS_PER_PACKET` and `MAX_PATCH_CHARS` are unchanged and remain the safety rails.
- No reduction of the per-packet fixed prompt itself (skill text, related context) — orthogonal work.

## In-Scope Files

- `src/pipeline/packet-builder.ts` — hunk ordering by affinity; greedy fill under caps; the config flag.
- `src/config/schema.ts` — `review.packSameFileHunks` (default false; flip to true only after the gate passes).
- Tests alongside: grouping unit tests (affinity ordering, cap enforcement, mixed-coverage merge) and a packet-count regression test on a synthetic multi-function file.
- Eval configuration for the flag-on/flag-off comparison runs.

## Implementation Steps

1. Refactor grouping: affinity sort + greedy fill behind the flag; flag off is byte-identical to today (prove with a fixture-diff test).
2. Unit tests: unrelated same-file hunks pack under caps; same-symbol hunks stay adjacent; a 6-hunk file splits 5+1; packed packet takes max coverage/priority of members; per-hunk anchors unchanged.
3. Run the Plan 79 harness flag-on vs flag-off; record recall, cost, and wall time in the plan's reconciliation note.
4. One flag-on production run of the motivating PR; compare packets, reviewed hunks, findings, wall time against run `dca8d870`.
5. If the gate passes, flip the default to true; if not, leave dark and record why.
6. `pnpm run check`, `pnpm test`, `pnpm build`; update `specs/plans/README.md` and the affected `specs/project/` docs.

## Acceptance Criteria

- Flag off: packet output byte-identical to current behavior.
- Flag on, motivating-run shape: ≥30% fewer packets on the same diff, with every hunk still assigned to exactly one packet and all caps respected.
- Eval recall within the Plan 79 variance band; no accepted-finding regression on the production A/B.
- Wall time and cost strictly improve on the production A/B.

## Stop Conditions

- Recall falls outside the variance band on evals, or the production A/B loses a previously-accepted finding: keep the flag off, record the measurement, and stop — do not trade recall for cost.
- If packed packets' calls-per-packet rises enough to erase the packet-count saving (>15% wall-time regression per reviewed hunk), stop and re-measure with a lower pack limit for deep-coverage packets before any further rollout.
