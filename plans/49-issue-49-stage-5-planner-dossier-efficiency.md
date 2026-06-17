# Issue 49: Stage 5 Planner Dossier Efficiency

Status: COMPLETE
Planned from: trails-api eval run 15 in-progress telemetry, 2026-06-17
Recommended priority: next efficiency cleanup after current eval completes and Stage 7/9 quality is checked

## Problem

Stage 5 is architecturally doing the right job: one serial PR scout/planning pass that reads a structured dossier and emits only review-plan exceptions. It gives the later parallel packet reviews a coherent staff-level sense of intent, risk, coverage, and lenses.

In run 15, however, the planner call is still a large serial cost:

```text
mc-000001 stage 5 planner initial
promptChars: 126,958
durationMs: 96,389
status: ok
```

The resulting plan was compact:

```text
45 files
131 hunks
11 coverage overrides
6 risk areas
3 selected lenses
```

That means the planner is already behaving correctly on output shape, but the input dossier likely contains more detail than Stage 5 needs to route review attention. The planner should not prove bugs. It should understand intent, identify risk areas, choose coverage/lenses, and leave proof to Stage 7 and Stage 9.

## Goal

Reduce Stage 5 planner prompt size and serial latency without changing the review architecture.

The intended design remains:

- one planner LLM call for ordinary PRs,
- same planner model/reasoning setting,
- deterministic fallback if planner fails,
- chunked planner only for existing prompt-budget overflow behavior,
- Stage 7 and Stage 9 remain responsible for detailed investigation and proof.

## Non-Goals

- Do not lower planner reasoning.
- Do not split normal planning into multiple sub-planners.
- Do not add a second planner pass.
- Do not move bug verification into Stage 5.
- Do not remove planner risk-area judgment or lens selection.
- Do not make Stage 5 emit coverage decisions for every hunk.
- Do not overfit compression to Trails, Go, fee calculation, routing, or any eval-specific paths.
- Do not discard data needed for accurate coverage/lens routing on large PRs.

## Current State

Stage 5 currently builds a `PlannerDossier`, projects it through `plannerDossierPromptProjection`, and sends it to the planner prompt:

```ts
renderDossier: (dossier) =>
  fenceUntrusted(stableJson(plannerDossierPromptProjection(dossier)), "planner-dossier")
```

The current projection mostly removes `runId`. That is simple and reliable, but it means the planner receives a rich structured inventory rather than a purpose-built routing summary.

Run 15 shows the pipeline shape is otherwise healthy:

- Stage 1-3 are near-instant.
- Stage 4 created `131` symbol facts and `23` static signals quickly.
- Stage 5 took about `96s`.
- Stage 6 used the plan and built `73` packets.
- The plan emitted only exception coverage, which is the desired behavior.

The opportunity is therefore input compaction, not planner redesign.

## Plan

1. Add a Stage 5-specific dossier projection.
   - Introduce a function such as `plannerRoutingProjection(dossier)` or replace `plannerDossierPromptProjection` with a more selective projection.
   - Keep the full `planner-dossier.json` artifact unchanged for debugging.
   - Only compact the provider-facing planner prompt input.
   - Preserve stable JSON ordering for cache/key stability.

2. Keep full detail for routing-critical data.
   - Preserve:
     - target/mode/depth,
     - commit titles and concise commit body intent snippets,
     - intent signals,
     - enabled lenses and short lens descriptions,
     - file paths, languages, test/generated status, and deterministic file facts,
     - changed-symbol summaries where available,
     - static signals,
     - hunk IDs, paths, changed line ranges, and concise changed-code summaries.
   - Preserve enough hunk identity that planner coverage decisions still map deterministically back to hunks.

3. Compress routine hunk detail.
   - For ordinary hunks with no static signals, no public-surface hints, no deleted code, no tests, and no high-risk file/config markers, send a compact row:
     - hunk ID,
     - path,
     - line range,
     - enclosing symbol name/signature if available,
     - short changed-line excerpt or summary.
   - Avoid sending large hunk text for routine hunks when Stage 7 will receive the real review packet later.
   - Keep this deterministic and metadata-driven.

4. Keep richer excerpts only for planner-relevant risk.
   - Richer hunk excerpts are appropriate when deterministic signals indicate planner routing could change:
     - static signals,
     - deleted guards/helpers,
     - tests rewritten or removed,
     - exported/public surface changes,
     - migrations/config/security/auth/database-related file facts from deterministic classification or project config,
     - high-risk paths configured in `codeninja.toml`,
     - large behavior-preserving refactors touching shared helpers.
   - This should not become a keyword-based risk classifier for review findings. It is only a prompt-size allocation policy.

5. Add planner prompt telemetry.
   - Record both raw dossier size and planner prompt projection size.
   - Record compaction counts:
     - files included,
     - hunks full-detail,
     - hunks compacted,
     - hunks omitted from rich detail,
     - static-signal hunks preserved,
     - projected prompt chars.
   - Emit this under Stage 5 telemetry so future evals can show whether the compaction helped.

6. Preserve planner output constraints.
   - Keep the prompt instruction that coverage entries are exceptions only.
   - Add one short instruction, if needed, that compact hunk rows are enough for routing and the planner should request deeper coverage rather than trying to prove the issue in Stage 5.
   - Do not expand `ReviewPlan`.

7. Add focused tests.
   - Add unit tests for the planner projection, not LLM behavior.
   - Test that:
     - all hunk IDs remain present or otherwise routeable,
     - routine hunk text is compacted,
     - risk/static-signal hunk excerpts are preserved,
     - full debug artifact shape is unchanged,
     - projection is deterministic.
   - Use generic fixture paths and languages; do not use Trails-specific names.

8. Validate against run telemetry.
   - On a comparable eval, expect:
     - Stage 5 prompt chars lower than run 15's `126,958`,
     - Stage 5 wall time lower or at least not worse,
     - coverage override count stays compact,
     - Stage 6 packet count and coverage do not regress,
     - required findings are not lost before candidate generation.

## Likely Files

- `src/pipeline/planner.ts`
- `src/skills/prompt-builder.ts`
- `src/types.ts` only if a projection telemetry type is needed
- `tests/*planner*` or a new focused planner-projection test file

## Commands

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Focused tests | `pnpm exec vitest run tests/*planner*.test.ts` | exits 0 if matching tests exist |
| Full tests | `pnpm test` | exits 0 |
| Typecheck | `pnpm run typecheck` | exits 0 |
| Build | `pnpm run build` | exits 0 |

## Acceptance Criteria

- Stage 5 planner prompt projection is materially smaller for large diffs.
- Planner still receives enough data to identify intent, risk areas, lens routing, and coverage exceptions.
- Planner still emits sparse coverage overrides, not one decision per hunk.
- Full planner debug artifacts remain available for analysis.
- The implementation is deterministic, cache-stable, and independent of a specific language or eval repo.
- Existing chunked-planner fallback remains intact for prompt-budget overflow.

## Stop Conditions

Stop and reassess if:

- reducing prompt size requires dropping hunk IDs or breaking coverage mapping,
- the planner starts missing obvious high-risk areas that were visible in deterministic signals,
- the implementation introduces multi-agent planning or another LLM pass,
- tests need repo-specific or language-specific fixture names to prove the behavior,
- Stage 7 or Stage 9 quality regresses because Stage 5 no longer routes deep coverage correctly.

## Maintenance Notes

This plan is about making the planner input match the planner's job. Stage 5 should route attention, not carry enough code to prove every bug. The clean boundary is:

- Stage 5 gets structured, compact, risk-aware routing data.
- Stage 6 builds syntax-aware review packets.
- Stage 7 investigates concrete changed-line failure modes with tools.
- Stage 9 verifies.

Keep that boundary intact.
