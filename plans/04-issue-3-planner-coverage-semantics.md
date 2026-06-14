# Issue 3: Planner Coverage Semantics

Status: COMPLETE

## Problem

The planner produced targeted coverage decisions for 20 of 131 hunks, which is reasonable for a large PR. Stage 6 then treated missing planner coverage as a warning for every other hunk, producing massive `planner_missing_coverage` noise in telemetry and the final report.

This makes the planner look broken even when it did the right thing: identify risk hotspots and let deterministic defaults handle the rest.

## Plan

1. Redefine planner coverage as overrides:
   - Planner coverage entries are priority/risk overrides for selected hunks.
   - Missing coverage means "use deterministic default," not a warning.
   - Rename internal reason from `planner_missing_coverage` to `default_coverage` where a reason is needed.

2. Update Stage 6 packet builder:
   - Stop emitting warn events for every hunk absent from planner coverage.
   - Apply deterministic defaults:
     - configured labels and priority
     - language lens
     - core review lens for source hunks
     - tests lens only for test files or risk/test signals
     - normal/light/deep based on planner overrides and deterministic facts.

3. Update coverage artifact semantics:
   - `coverage.reason` should explain meaningful quality limitations, not normal defaulting.
   - Add `coverage.source: "planner" | "deterministic_default" | "config"`.
   - Keep planner override reasons where present.

4. Update final report:
   - Do not list `planner_missing_coverage` lines.
   - For partial reviews, list only actionable causes:
     - budget stopped
     - packet failed
     - tool/provider failure
     - severe context degradation on reviewed hunks
     - verification incomplete.

5. Update docs/specs:
   - Stage 5 planner is not required to output one coverage record per hunk.
   - Stage 6 owns exhaustive hunk scheduling and default coverage.

## Tests

- Planner returns coverage for one hunk in a many-hunk diff; Stage 6 emits no warnings for missing entries.
- Coverage records distinguish planner override from deterministic default.
- Final Markdown excludes `planner_missing_coverage`.
- Existing large-PR tests assert low-noise coverage summaries.

## Acceptance Criteria

- A large PR can have sparse planner coverage without noisy warnings.
- Final coverage reports true review limitations, not normal planner defaulting.
- Planner remains responsible for risk direction, not exhaustive scheduling.
