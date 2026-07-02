# Issue 85: Finalize Grace for Per-Pass Worker Timeouts

Status: PENDING
Planned from: eval evidence `0c4d5213/logs/43` (stage 7: 4 of 5 timed-out calls were `finalize`-kind; the packets covering both missed expectations died at or during finalize — `46897188` after 287s of completed investigation with its finalize killed 9s in, `13dc0c5e` at 260s+38s, `fd0793c6` at 299s) and `0c4d5213/logs/45` (stage 9: verifier worker `w9-007` for `a81d5adf-f1` invested 385s across three completed calls, then had its finalize killed 94s in at ≈479s against the 480s cap — the run's only loss; every other expectation and budget check passed), 2026-07-02
Planned at: commit `00617d79` (branch `next`)
Recommended priority: high, immediately after Issue 80 in the queue. Two of the last three material eval losses on this case were caused by exactly this mechanism. Small, deterministic, stage-agnostic.

## Problem

`worker-runner.ts` enforces `review.perPassTimeoutMs` with a single hard timer per task (`runTaskOnce`, `worker-runner.ts:138`): when it fires, the `AbortController` cancels whatever call is in flight, and the pass's entire investment is discarded. The timer is phase-blind. A worker that has **finished investigating** — all tool evidence gathered, all continuation rounds done — and is mid-way through its submit-producing finalize call is killed identically to one stuck in an investigation loop.

Under normal provider latency (~10-14s/call p50) the cap never binds and the flaw is invisible. Under degraded latency (July 1: 66-83s/call p50, no rate-limit errors, single-attempt slow serving), passes legitimately need most of the budget for investigation and the finalize call lands exactly on the boundary:

- Run 43 (old 300s cap): stage-7 packets covering both missed expectations were killed at the boundary, three of them during or immediately before finalize. Loss labels: `missed-before-candidate-generation / packet-review-failed`.
- Run 44/45 (480s cap after the 2026-07-01 bump): the bump saved several packets (`fba381a9` at 319s and `13669bd8` at 384s completed and produced findings) — but run 45's stage-9 verifier for `a81d5adf-f1` needed ~540s and was killed 94 seconds into its finalize. One aborted verdict flipped an otherwise fully-passing run to fail.

Killing at finalize has the worst possible economics: 100% of the pass's token spend is already sunk, and the remaining cost to convert it into a usable artifact is one bounded call. Raising `perPassTimeoutMs` again just moves the boundary; the boundary itself is the defect.

A secondary observability defect rides along: a timed-out verification is recorded with `verificationStatus: "incomplete"` but `verdict: "reject"` and `errorCode: "llm_call_failed"` (also used for `budget_limited` incompletes). The run-45 scorer output literally prints `verdict=reject reason=verification incomplete: timed_out` — a timeout masquerading as a refutation.

## Goal

A pass that has completed its investigation is never killed mid-finalize by the per-pass timer alone; it either finishes its submit within a bounded grace or is cut off having genuinely exceeded soft + grace. Run-level budgets remain the ultimate bound and are unchanged. Timed-out and budget-limited verifications stop reporting as rejects.

## Design

Replace the single hard timer with a **soft/hard deadline pair** — the same shape the run-level budget already uses (soft stop + reserved tail), applied per worker:

1. **Soft deadline = `perPassTimeoutMs` (unchanged semantics for investigation).** When it fires:
   - If the in-flight call is an **investigation call** (`initial` / `tool-continuation`): let it complete, but the runner loop dispatches **no further investigation calls** — the pass goes directly to its finalize path (stage 7 already has a finalize-missing-submit mechanism; the verifier equivalently proceeds to verdict submission with evidence in hand).
   - If the in-flight call is a **finalize / submit-producing call**: let it run.
2. **Hard deadline = soft + `graceMs`.** `graceMs = min(240_000, max(120_000, ceil(perPassTimeoutMs * 0.25)))` — an implementation constant (no new config key; tune only if telemetry demands it). At the hard deadline the worker aborts exactly as today (`timed_out`). Run-45's worker (finalize killed at +94s of a needed ~+150s) completes comfortably inside a 120s grace.
3. **Phase awareness.** The task's `run()` callback and `worker-runner` need a narrow contract: the runner exposes per-task deadline state (`softDeadlineAt`, `hardDeadlineAt`, `softExpired()`), and the pi-runner loop (a) consults `softExpired()` before dispatching each call — if true, only a finalize-kind call may be dispatched; (b) tags the in-flight call kind so the soft-deadline handler can decide "let finalize run" vs "let this be the last investigation call". No new AbortController topology: one timer rescheduled from soft to hard.
4. **Root-signal aborts are untouched.** Run-level budget stops, hard run timeout (2× `timeoutMs`), and `cancelAll` continue to abort immediately (`cancelled`, not `timed_out`); grace applies only to the per-pass timer. The reserved-tail interplay is acceptable by construction: grace extends a worker by ≤4 minutes while the run-level reserve (10% of `timeoutMs`; 6 minutes at the current 60-minute eval budget) still bounds the tail.
5. **Truthful outcome labeling** (small, riding along because it is timeout-adjacent):
   - Timed-out and budget-limited verifications record `verdict: null` (absent), never `"reject"`; `errorCode` distinguishes `worker_timed_out` / `budget_limited` / `llm_call_failed`.
   - The eval scorer's nearest-instance line renders `outcome=incomplete (worker timed out)` rather than `verdict=reject`.
6. **Telemetry.** Events: `worker_soft_deadline { workerId, stage, inFlightKind, elapsedMs }`, `finalize_grace_used { workerId, stage, graceMsUsed, outcome }`. Counters in the budget summary's context-pressure block: `softDeadlineHits`, `graceCompletions`, `graceExhausted`. A grace that fires should be visible in eval triage without reading `model-calls.jsonl`.

**Explicitly not chosen:** salvaging the aborted finalize's partial output (fragile, duplicates the submit-repair ladder — fable §2.3 argues against growing it); making `graceMs` configurable (knob without evidence); latency-adaptive `perPassTimeoutMs` scaling (bigger design, belongs with the latency-projection work if the harness shows grace alone is insufficient).

## Non-Goals

- Changing run-level budget/reserved-tail semantics or `--max-time`.
- Latency-adaptive concurrency or packet shedding (separate, larger design).
- Retrying timed-out passes (the run-level budget economics of a retry are worse than a grace).
- The Issue-80 failure ladder (complementary: 80 handles terminal *errors*, 85 handles the *timer*).

## In-Scope Files

- `src/pipeline/worker-runner.ts` — soft/hard timer pair, deadline state exposed to tasks, outcome labeling.
- `src/llm/pi-runner.ts` — call-kind tagging for the deadline handler; soft-expired check before dispatching investigation calls; proceed-to-finalize on soft expiry.
- `src/pipeline/lens-runner.ts` / `src/pipeline/verifier.ts` — thread the deadline contract into packet and verifier tasks (both stages benefit; run 43 was stage 7, run 45 was stage 9).
- `src/pipeline/verifier.ts` + `src/evals/eval-scoring.ts` — incomplete-verdict labeling fix (Design 5).
- `src/telemetry/*` — events/counters.
- Tests: worker-runner unit tests (fake clock), pipeline fixtures with a fake runner.

## Implementation Steps

1. Worker-runner: soft/hard timer pair with `softExpired()` state; hard abort preserves today's `timed_out` outcome; unit tests with fake timers (soft fires mid-investigation → task sees `softExpired`; soft fires mid-finalize → no abort until hard; root abort during grace → `cancelled`).
2. Pi-runner: tag in-flight call kind; on `softExpired()`, dispatch only finalize; existing finalize-missing-submit path used for stage 7, verdict submission for stage 9.
3. Outcome labeling: `worker_timed_out` / `budget_limited` error codes; `verdict` absent on incompletes; scorer rendering.
4. Telemetry events + budget-summary counters.
5. Fixtures reproducing the two observed shapes: (a) run-43's `46897188` — investigation complete at 287s/300s, finalize needs 60s → completes under grace, candidate produced; (b) run-45's `w9-007` — three calls totaling 385s, finalize needs 150s → verdict recorded, expectation matched. Negative: a pass still investigating at hard deadline → `timed_out` exactly as today.

## Validation

- Unit + pipeline suites green; the two replay-shaped fixtures pass.
- One trails-api eval run on a normal-latency day: zero `worker_soft_deadline` events expected (grace machinery inert when latency is healthy).
- After Issue 79 lands: slow-day repeat runs report `graceCompletions > 0` with the previously-lost expectations converting; `lost-at-verification / verification-incomplete` and `packet-review-failed` timeout losses drop to zero for passes whose investigation completed.
- Worst-case wall-clock: confirm max per-worker time = `perPassTimeoutMs + graceMs` and that run-level reserve still closes stages on schedule (no regression in `dispatchBlocks` behavior on a budget-squeezed fixture).

## Done Criteria

- No pass whose investigation completed is killed mid-finalize by the per-pass timer within soft+grace.
- Timeout/budget incompletes are labeled truthfully end-to-end (telemetry, verification artifact, scorer output).
- Grace usage is observable and near-zero on healthy-latency runs.

## Stop Conditions

- If grace pushes slow-day runs into the run-level reserved tail materially more often (dispatch blocks appearing earlier than before at equal latency), cap `graceMs` at 120s flat before reconsidering the design.
- If passes start *relying* on grace on healthy days (nonzero `softDeadlineHits` at normal latency), the soft budget is mis-sized for the workload — fix `perPassTimeoutMs`, do not widen grace.
