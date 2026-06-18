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
| 43 | COMPLETE | Issue 43: Stage 7 Compact Removal and Generic Test-Rewrite Recall |
| 44 | COMPLETE | Issue 44: Stage 7 Recall Recalibration (Generate Liberally, Verify Strictly) |
| 45 | COMPLETE | Issue 45: Provider Overload Retry and Composer Fallback |
| 46 | COMPLETE | Issue 46: Codeninja Runtime Provenance in Eval and Telemetry |
| 47 | COMPLETE | Issue 47: Run 10 Verification, Composition, and Submit Robustness |
| 48 | COMPLETE | Issue 48: Prioritize Local Behavior-Delta Uncertainty Promotions |
| 49 | COMPLETE | Issue 49: Stage 5 Planner Dossier Efficiency |
| 50 | COMPLETE | Issue 50: Narrow `find_likely_tests` Tool Surface |
| 51 | COMPLETE | Issue 51: Stage 10 Composer Schema Repair and Salvage |
| 52 | COMPLETE | Issue 52: Stage 7 Candidate Schema Repair Cost |
| 53 | COMPLETE | Issue 53: Human-Attention Note Deduplication |
| 54 | COMPLETE | Issue 54: Recovered Schema Telemetry |
| 55 | PENDING | Issue 55: Treat Documentation Hunks as Intent Context |
| 56 | COMPLETE | Issue 56: Open Review Questions and Answer Tracking |
| 57 | COMPLETE | Issue 57: Resolve Call-Site Context Hints To Callers |
| 58 | COMPLETE | Issue 58: Planner Context Hint Contract |
| 59 | COMPLETE | Issue 59: Stage 5 Planner Schema Repair Salvage |
| 60 | COMPLETE | Issue 60: Preserve Planner Concerns As Review Obligations |
| 61 | COMPLETE | Issue 61: Stage 8 Task Deduplication and Question-Finding Title Hygiene |
| 62 | COMPLETE | Issue 62: Stage 7 Schema Friction Reduction |
| 63 | PENDING | Issue 63: Review Question Ownership and Risk-Area Coverage |

## Current Queue

Recommended implementation order for remaining work:

- **Issue 63** — preserve material planner risk areas as owned review obligations before assigning primary/supporting packet roles; this directly addresses the run-9 miss where the right risk area evaporated.
- **Issue 55** — treat docs/specs/postmortems as bounded intent context for code packets instead of standalone Stage 7 review packets; this prevents stale doc-only human-attention notes and fixes coverage wording.

## Deferred / Watch List

Promote these only if later evals show recurring evidence:

- **Broad risk-note propagation** — if many packets repeatedly re-litigate the same cross-cutting helper or migration assumptions, consider a bounded shared context mechanism. Avoid fixed risk categories.
