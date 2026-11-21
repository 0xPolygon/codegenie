---
created: 2026-11-21T00:57:12Z
author: lead-dev-2
source: "0xPolygon/codegenie#114 (owner-authorized adjudication of the private eval archive, aggregates only); deletion in PR #121"
status: verified
---

# Stage 8 adjudication and removal

Stage 8 (targeted system review) was deleted in #114. This note records why, with aggregates only.

## What Stage 8 did

Stage 8 ran after Stage 7 packet review. It grouped medium- and high-confidence follow-up hints by a normalized key: question, files and symbols. A group became a task only when two or more different packets raised the same key. At most three tasks ran per review, each with a small read-only tool budget. A task could return candidate findings, which went to Stage 9 verification, or "resolved hints". A resolved hint removed matching follow-up hints from the human-attention notes, but only on an exact key match. A resolution did not have to cite evidence.

## Archive evidence

- About 204 recorded review starts reached Stage 8. It built tasks in 10 of them and made model calls in 9. All of those runs were on 2026-06-18, on version 0.1.0, across two eval cases of one private repository.
- Stage 8 produced 0 candidate findings. Its only effect was 17 resolved hints.
- It has not fired in any recorded run since 2026-06-18.

## Adjudication of the 17 resolutions

Each resolution was checked read-only against the source at the reviewed revision and against the report that run published.

| Verdict | Count |
| --- | --- |
| Correct and supported by what the task inspected | 11 |
| Correct conclusion, but closed the whole question while admitting parts were not inspected (usually an exhausted tool budget) | 4 |
| Incorrect: closed a question about the case's material bug mechanism as "no defect" | 2 |

- The two incorrect resolutions belong to the smaller case. All four of its Stage 8 runs published no findings and missed that bug. Whether Stage 8 contributed to the miss cannot be established.
- Suppression did not take effect for 10 of the 17. Those questions still appeared verbatim in the published report, because suppression required an exact key match.
- Of the 7 that were actually suppressed:
  - 4 were correct but low-value checks;
  - 1 was correct;
  - 2 over-reached.
- Neither incorrect resolution was actually suppressed.

The stop condition from synthesis recommendation 10 was not met. That condition was "the adjudication shows its resolutions were correct and useful": 2 were wrong, 4 over-reached, 10 had no effect, and there were no candidates.

## Why the trigger became unreachable

Independent packet reviewers rarely word the same question identically, with the same files and symbols. Most of the June firings came from planner review questions, which were copied verbatim into several packets' hints. That mechanism no longer exists, so the exact-key trigger had nothing left to match.

## Decision

A control case was proposed: a synthetic fixture shaped like the historical trigger, at about $4 on one model, with an optional forced Stage 8 step. On 2026-11-21 the owner judged the adjudication conclusive and approved deleting Stage 8 without the control run.

## Repeated hints after removal

Follow-up hints raised by several packets are now handled exactly like isolated hints. They are recorded in telemetry, and medium- and high-confidence hints appear as "needs human attention" notes. Nothing suppresses them any more. Stage ids 9 to 11 are unchanged.

## Limits of the evidence

- All 17 resolutions come from one day, one early version (0.1.0) and two cases of one repository. Later prompts or models might have behaved differently.
- No control case was run, so this does not show that a better-triggered cross-file stage would add nothing.
- The miss in the smaller case cannot be attributed to Stage 8.
- If evals later attribute misses to unexamined cross-file questions, the deferred broad cross-file review in the architecture spec is the place to start, not the deleted repeated-hint rule.
