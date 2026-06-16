# Plans

This directory tracks implementation plans for confirmed improvements. Status values are `PENDING`, `BACKLOG`, `COMPLETE`, `IN PROGRESS`, and `BLOCKED`.

| Plan | Status | Topic |
| --- | --- | --- |
| 01 | COMPLETE | Issue 8: Debug Artifacts |
| 02 | COMPLETE | Issue 7: Token Telemetry |
| 03 | COMPLETE | Issue 2: Packet Context Degradation |
| 04 | COMPLETE | Issue 3: Planner Coverage Semantics |
| 05 | COMPLETE | Issue 4: Stage 7 Cost |
| 06 | COMPLETE | Issue 1: Budget And Partial Runs |
| 07 | COMPLETE | Issue 5: Verification Degradation |
| 08 | COMPLETE | Issue 6: Final Composition |
| 09 | COMPLETE | Issue 9: Human Attention Noise |
| 10 | COMPLETE | Issue 10: Final Body Metadata Duplication |
| 11 | COMPLETE | Issue 11: Stage 6 Inverted Range Reads |
| 12 | COMPLETE | Issue 12: Lossy Conversion Recall |
| 13 | COMPLETE | Issue 13: Planner and Anchor Hygiene |
| 14 | COMPLETE | Issue 14: Deleted Symbol Lookup and Targeted Tool Budget |
| 15 | COMPLETE | Issue 15: Telemetry Cache Terminology |
| 16 | COMPLETE | Issue 16: Eval Matching for Merged Findings |
| 17 | COMPLETE | Issue 17: Planner Submit Plan Schema Discipline |
| 18 | COMPLETE | Issue 18: Stage 6 Read Range Guard |
| 19 | COMPLETE | Issue 19: Follow-Up Hint Deduplication |
| 20 | COMPLETE | Issue 20: Pre-Verification Candidate Clustering |
| 21 | COMPLETE | Issue 21: Targeted Cross-System Review |
| 22 | COMPLETE | Issue 22: Cache Telemetry Clarity |
| 23 | COMPLETE | Issue 23: Evidence-Aware Verification Recall |
| 24 | COMPLETE | Issue 24: Uncertainty Promotion and Verifier Policy Discipline |
| 25 | COMPLETE | Issue 25: Repository Source Recovery and Tool Budget Diagnostics |
| 26 | COMPLETE | Issue 26: Budget Completion, Overrun Telemetry, and Budget Multiplier |
| 27 | COMPLETE | Issue 27: Eval LLM Concurrency Overrides |
| 28 | COMPLETE | Issue 28: Local Context Budget Pressure Reporting |
| 29 | COMPLETE | Issue 29: Adaptive Local Source Budget Extensions |
| 30 | COMPLETE | Issue 30: Post-Verification Human-Attention Reconciliation |
| 31 | COMPLETE | Issue 31: Intent-Aware Behavior-Change Framing |
| 32 | COMPLETE | Issue 32: Adaptive Stage 6 Symbol Context |
| 33 | COMPLETE | Issue 33: Stage 7 Compact Finalize for No-Finding Packet Reviews |
| 34 | COMPLETE | Issue 34: Run-Level Tool Result Memoization |
| 35 | COMPLETE | Issue 35: Telemetry and Cache Diagnostics |
| 36 | COMPLETE | Issue 36: Human-Attention and Uncertainty Hygiene |
| 37 | COMPLETE | Issue 37: Verifier Forced-Submit Schema Repair Hardening |
| 38 | COMPLETE | Issue 38: Eval and Runtime Concurrency Tuning |
| 39 | COMPLETE | Issue 39: Shared Prompt-Prefix Cache Spike |
| 40 | COMPLETE | Issue 40: Stage 7 Closeout Recall Regression |
| 41 | COMPLETE | Issue 41: Eval Scoring and Composition Provenance Under-Credit |
| 42 | COMPLETE | Issue 42: Stage 6 Adaptive Context Underdelivery |
| 43 | PENDING | Issue 43: Stage 7 Compact Removal and Generic Test-Rewrite Recall |

## Deferred (watching for evidence)

Observations from the trails-api run-6 review (Opus 4.8 + GPT-5.5) that we intentionally did **not** plan yet — promote to a plan only if a later eval run shows the pattern recurring:

- **Structured planner hints on every packet** — keep `surroundingContextHints` structured per packet for telemetry/debug, not only embedded in prompt text.
- **Broad risk-note propagation** — 45/73 packets carried risk notes from shared route/helper migration themes; consider risk-area shared context vs. re-litigating the same helper assumptions per packet.
