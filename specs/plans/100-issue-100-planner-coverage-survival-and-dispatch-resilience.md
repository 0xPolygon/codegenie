# Issue 100: Short Hunk IDs — Planner Coverage Survival and Dispatch Resilience

Status: COMPLETE
Related: Plan 92 (`92-issue-92-planner-coverage-calibration-and-adaptive-second-pass.md`) — calibrates what the planner asks for; this plan makes what it asks for survive delivery.
Planned from: two production runs against `0xsequence/trails-api` PR 846 (90 files, 213 hunks), 2026-07-24
Planned at: commit `6691360` (branch `next`)
Recommended priority: before the next tagged/npm release. On large PRs the current behavior silently discards the entire planner output, then spends the whole runtime budget on alphabetically-early trivia; the motivating run reported "No credible findings" for a money-path PR whose core files were never reviewed.

## Evidence

Runs `.codegenie/runs/20260724-135818-740d73f2` and `.codegenie/runs/20260724-150405-fe1548ae` (same commit, same PR) reproduced the failure deterministically. The planner produced an accurate risk map and submitted coverage entries (15 and 5 respectively, `deep` on migrations and the fee/protocol core) — but with file paths in `hunkId`. All entries were dropped with warn-level `planner_unknown_hunk` events; `review-plan.json` ended `coverage: []`; final coverage was `deep: 0`; dispatch degraded to diff order (path-alphabetical among tied packets); the 30-minute budget expired with ~70/109 packets undispatched, including every core file. 0 findings, ~$14.85 per run. In the second run a high-confidence `logic_bug` candidate additionally died `budget_limited` before verification.

## Problem

Every hunk always has an ID: a 64-char sha256 over **hunk coordinates** (final path, old/new start, header, added/deleted line numbers — not content), produced by `hunkId(...)` in `src/git/diff-parser.ts` when `finishHunk` pushes the hunk and re-derived in `finishFile` once rename/path resolution fixes the final path (`diff-parser.ts:343` area). The failure is in the model's view of these IDs:

1. The planner-dossier did not fit the prompt budget. `compactPlannerDossier` (`src/pipeline/planner.ts:784`) collapsed per-hunk detail (`collapseHunkDetail`/`collapseFileDetail`, `planner.ts:1062`) into directory rollups — flat pools of bare hashes with no path association. The run's prompt shipped ~10KB of full hashes the model could not act on, while the prompt contract (`src/skills/prompt-builder.ts:219`) still promised "Compact hunks still have stable hunk IDs."
2. With no usable ID for its target files, the model spelled its intent with paths. The plan schema constrains `hunkId` only as `string(1..200)`, so this passed schema validation.
3. `validatePlan` (`src/pipeline/planner.ts:1294`) drops unknown-ID entries with a per-entry warn and continues; a fully discarded plan proceeds as an empty plan with no error, no fallback, and no trace in the final report — total plan loss surfaced only as per-entry warn-level noise in the log stream.
4. `createWorkerRunner.schedule` (`src/pipeline/worker-runner.ts:68`) orders by priority → coverage → input index; with a flattened plan everything ties and input (diff/alphabetical) order dispatches trivia ahead of the risk core.

The root cause is that full-length hashes are too expensive to keep path-associated in a compacted prompt, so compaction throws the association away. Fix the ID form and the association becomes cheap enough to make unconditional.

## Design

### 1. Short hunk IDs via two-pass allocation

Short-ID assignment happens **after the complete diff is parsed**, because collision groups are only knowable over the whole `UnifiedDiff` and hunk digests depend on final (post-rename) paths:

- Pass 1 (existing parse): compute the full coordinate-derived digest per hunk on final paths, exactly as today.
- Pass 2 (new, one allocator over the finished `UnifiedDiff`): assign each hunk the shortest unique prefix of its full digest across the entire diff, stepping 8 → 12 → 16 → … → 64 hex chars for any colliding group. Two hunks with **identical full digests** indicate a parser defect: fail the parse with a hard error rather than disambiguate.

The short form becomes `hunk.id` — the one hunk identifier used everywhere downstream: dossier, planner plan, packets, tool payloads, telemetry, prompts, publisher anchors, and derived IDs (packet IDs at `packet-builder.ts:396` re-derive naturally from the sorted short IDs; candidate IDs likewise).

The full digest is kept as a required `hunkHash` field on the operational `DiffHunk`. Because later stages retain the parsed diff in memory, the field remains available there; the projection contract is what stays narrow. `hunkHash` is serialized only in the stage-2 `diff.json` artifact for forensics and cross-run correlation and is deliberately omitted from dossiers, packets, prompts, telemetry events, and later artifacts. This changes the in-memory `DiffHunk` shape (and fixtures that construct it), but the persisted-schema change is confined to `diff.json`; every downstream projection continues to carry one opaque hunk identifier, `id`, whose value got shorter.

Entropy note: 8 hex chars = 32 bits; the probability any two hunks in a run collide at 8 chars is ~5×10⁻⁶ at 213 hunks and ~1% at 10,000 — and correctness never depends on it, because allocation is deterministic over a closed set. Short IDs are stable within a parsed diff; `hunkHash` remains the full-fidelity correlation key when replaying that same diff.

### 2. Normative compaction representation: the dossier `hunkIndex`

Add one mandatory dossier field:

```ts
hunkIndex: Array<{
  path: string;
  oldPath?: string;
  language: string;
  hunkIds: string[];
}>
```

built once at dossier construction and **immutable through every compaction and chunking level**: `dropHunkExcerpts`, `reduceStaticSignals`, `collapseHunkDetail`, `collapseFileDetail` may degrade or remove anything else, but never touch `hunkIndex`; each planner chunk carries the `hunkIndex` slice for its files. Directory rollups stop carrying bare ID pools (now redundant).

`hunkIndex` is both the prompt's ID listing and validation's source of truth: the rendered dossier presents every changed file with its hunk IDs and includes `oldPath` for renames. `validatePlan` derives `knownHunks` and `hunkLanguageById` from the entries, and derives `knownFiles` from both `path` and `oldPath` for `relatedFiles` normalization — preserving the current rename behavior without introducing path-fallback coverage. What validation accepts as a hunk ID is therefore definitionally what the prompt displayed, and no compaction path can reintroduce the divergence. Update the `prompt-builder.ts:219` contract sentence to state the invariant plainly: every changed file always lists its hunk IDs.

Update `plannerDossierProjectionStats` with the representation: remove the now-obsolete directory-rollup hunk count and report indexed/unique hunks from `hunkIndex`. Detailed `file.hunks` may repeat IDs for richer context, but must not inflate the count. Update the `planner_prompt_projection` telemetry payload and tests to use the new field and prove it remains stable across compaction levels.

### 3. Planner-loss observability with a real execution path

Telemetry events alone do not reach the report; `ReviewRunStats` (`src/types.ts:931`) carries only model/elapsed/git and `renderRunStatLines` (`src/output/markdown-renderer.ts:72`) prints only those. Add one normative count shape:

```ts
type PlannerCoverageStats = {
  submittedEntries: number;
  acceptedEntries: number;
  acceptedUniqueHunks: number;
  rejectedUnknownHunk: number;
};
```

`validatePlan` returns `{ plan, stats }` plus the accepted hunk-ID set used internally for aggregation; `runPlannerCall` preserves that result. `runChunkedPlanner` sums entry/rejection counts across calls and unions their accepted model-submitted ID sets; `acceptedUniqueHunks` is the size of that union after chunk-plan merging. `PlannerRunResult` carries the aggregate counts to `review-runner.ts`, which copies them into `ReviewRunStats.plannerCoverage`. A known submitted entry increments `acceptedEntries` even if duplicate coverage is merged later, so `submittedEntries === acceptedEntries + rejectedUnknownHunk`. Deterministic fallback coverage is not model-submitted: fallback plans and calls with no submitted coverage contribute zeroes and an empty ID set, and do not manufacture a loss event. Do not add a generic `rejectedOther` bucket until a concrete rejection path exists.

Keep per-entry warn `planner_unknown_hunk`. Each validation emits `planner_coverage_lost` at **warn** level when some submitted entries were rejected and at **error** level when all were; chunked calls include their chunk root in the event context. Partial loss is material — losing 14 of 15 risk overrides must be visible, not only total loss. `markdown-renderer.ts` renders the aggregate Stats line (for example, `Planner coverage: submitted 15, accepted 1 entry / 1 unique hunk, rejected 14 unknown hunks`) whenever `rejectedUnknownHunk > 0`.

### 4. Stage-7-only dispatch rank

`WorkerRunner` is shared by stages 7, 8, and 9, so the scheduler change must not reorder verification or other stages. Add `dispatchRank: [number, number]` to `ReviewPacket` and optional `dispatchRank?: number[]` to `WorkerTask`. `packet-builder.ts` computes the packet rank; both initial and adaptive stage-7 task-construction paths in `lens-runner.ts` copy it onto the task. Stages 8 and 9 do not set it. `schedule` sorts by priority → coverage → lexicographic `dispatchRank` (tasks without one keep today's behavior) → existing input index.

`dispatchRank = [fileClassRank, -packetChangedLines]`, with a **mutually exclusive first-match classification** (a snapshot under `tests/` is a snapshot, not a test):

1. snapshot/fixture (`__snapshots__`, `fixture`, or `fixtures` path segment, or `.snap.` in the basename) → rank 3
2. docs/config (extension in a fixed set: `.md`, `.yml`/`.yaml`, `.toml`, `.conf`, `.sample`, `.txt`, dotfiles, `Makefile`) → rank 2
3. test source (`FileFacts.testStatus === "test"`) → rank 1
4. product source (default) → rank 0

`packetChangedLines` is the count of added/deleted diff lines across the source `DiffHunk`s grouped into that packet, computed before packet rendering/truncation. It is not the file-wide `FileFacts.changedLines` and is not derived from a truncated `PacketHunk`; no new analysis or model calls are needed. The scheduler's existing input index remains the final deterministic tie-break, so the rank does not duplicate a packet index.

Testing must prove the wiring, not just the sort: alongside a scheduler unit test, an end-to-end budget-stop test runs the pipeline over a mixed fixture with a budget that stops mid-stage-7 and asserts the dispatched set favored product source over snapshots/docs — guarding against the failure mode where packet construction never populates the rank and a scheduler-only test still passes.

## Deferred follow-ups (explicitly out of scope)

Two mitigations from earlier drafts are moved to future plans, with corrections recorded so the follow-up starts from accurate premises:

- **Finalize cost.** Forced-submit finalize calls already run with thinking disabled (`anthropicForcedSubmitCall`, `src/llm/pi-runner.ts:895`); "reduce reasoning effort" is a no-op. The $4.94 (33% of run cost) comes from replaying large conversations into 26 full no-finding finalize calls. A real fix is compact finalization, earlier forced submission, or conversation reduction — a separately measured design with its own recall gate.
- **Context budgets.** Raising `MAX_PATCH_CHARS` / stage-7 tool budgets with PR size would increase per-packet spend and can worsen the exact dispatch exhaustion this plan repairs; and of the motivating run's 52 truncations, 25 were stage-6 symbol-source truncations that patch/tool caps do not address. Any budget scaling needs its own plan with dispatch-coverage impact measured.

## Non-Goals

- No file-level coverage entry form in the plan schema, and no path-fallback acceptance in `validatePlan`. Hunk-level IDs are the contract; with delivery fixed, alternate spellings would only re-open ambiguity.
- No change to coverage calibration semantics (Plan 92 scope), lens inventory, provider selection, or verification lanes; stages 8/9 dispatch order unchanged.
- No compaction losslessness beyond the `hunkIndex` invariant.

## In-Scope Files

- `src/git/diff-parser.ts` — two-pass short-ID allocation, duplicate-digest hard error, `hunkHash` on the parsed hunk type.
- `src/types.ts` — hunk type `hunkHash`; rename-aware dossier `hunkIndex`; shared `PlannerCoverageStats`; `ReviewRunStats.plannerCoverage`; `ReviewPacket.dispatchRank`.
- `src/pipeline/planner.ts` — `hunkIndex` construction + compaction invariant; validation sourced from `hunkIndex`; `PlannerRunResult` aggregation; loss counts and events.
- `src/skills/prompt-builder.ts` — ID-listing render from `hunkIndex`; contract sentence; projection-stats/telemetry update.
- `src/pipeline/review-runner.ts`, `src/output/markdown-renderer.ts` — stats population and rendering.
- `src/pipeline/packet-builder.ts`, `src/pipeline/lens-runner.ts`, `src/pipeline/worker-runner.ts` — packet-rank computation, both stage-7 task-construction paths, `WorkerTask.dispatchRank`, and scheduling.
- `specs/plans/README.md` — Plan 100 index row.
- `specs/project/` normative docs (`architecture.md` / `functional_spec.md` / affected `components/`) — hunk identity, dossier shape, stats surface.
- `evals/fixtures/` — additive only; see below.

## Eval fixtures

Historical recorded logs are evidence and are preserved as-is; do not rewrite recorded IDs. Add new post-change fixture runs alongside the old ones, and migrate golden-comparison fixtures (where the fixture's purpose is expected-output matching, not recorded history) by regeneration in a dedicated commit.

Production artifact readers and eval scoring keep exact ID equality for joins within one run; they must accept opaque IDs without assuming a fixed length. Add a replay regression proving historical 64-character-ID artifacts still load and score. Cross-version semantic parity uses a **test-only** normalizer that establishes and checks a bijection between corresponding hunk IDs and propagates it through packet/candidate references, preserving cardinality and referential consistency before comparing coverage, packet composition, and verdicts. Do not weaken production scoring or simply strip ID-valued fields.

## Implementation Steps

1. Two-pass short-ID allocator + `hunkHash` with unit tests: determinism, collision-group extension (synthetic colliding prefixes), duplicate-full-digest hard error, stability across repeated parses, rename/path-resolution ordering.
2. Typecheck-driven sweep of carrier modules (expected: no logic changes; the ID is opaque); historical-artifact replay; new fixture runs added; test-only bijective-ID semantic parity confirmed.
3. Rename-aware `hunkIndex` construction, compaction/chunking invariant, validation re-sourcing, and projection-stat update, with a render test at every compaction level: each changed file's entry lists its hunk IDs and old path when present; rollups carry no bare pools; indexed-hunk telemetry does not double-count detailed entries.
4. Prompt contract sentence; replay a Run-A-shaped dossier (90 files, forced compaction) and assert the prompt exposes usable IDs for every file and a submission targeting those paths with their displayed IDs validates with zero loss.
5. `PlannerCoverageStats` through single and chunked planner calls, events (warn partial / error total), `ReviewRunStats.plannerCoverage`, renderer line — with duplicate-entry, fallback, chunk aggregation, and rendered-loss tests.
6. Stage-7 `dispatchRank`: compute on `ReviewPacket`, copy through both initial and adaptive `lens-runner.ts` tasks, classification precedence table + unit test, and end-to-end budget-stop wiring test as specified above.
7. Update `specs/plans/README.md` and the affected `specs/project/` normative docs.
8. `pnpm run check`, `pnpm test`, `pnpm build`.

## Acceptance Criteria (split by commit group)

Short-ID + compaction commits:
- A 90-file/213-hunk dossier compacted to budget still presents every changed file with its hunk IDs, and a planner submission using those IDs validates with zero loss.
- Historical 64-character-ID artifacts still load and score with exact same-run joins, and the test-only bijective-ID comparison shows no coverage, packet-composition, or verdict changes.
- Any partial or total planner-coverage loss is visible in the final report's Stats block, and total loss emits an error-level event.

Dispatch commit:
- Ordering changes are confined to equal priority+coverage tiers in stage 7; stages 8/9 dispatch order is byte-identical on fixtures.
- Under a mid-stage-7 budget stop, no snapshot/fixture or docs/config packet is dispatched while a changed product-source packet of the same tier waits.

## Stop Conditions

- If any consumer depends on 64-char ID length (parser or storage-key assumption), fix the consumer; if the consumer is external, feed it `hunkHash` rather than widening the short ID.
- If the test-only normalized eval comparison surfaces behavioral diffs beyond ID values, stop and investigate before landing — that indicates a hidden content-addressing dependency, exactly the class of bug this plan must not introduce.
- If the `hunkIndex` render pushes small-PR planner prompts over budget (it should shrink them — short IDs replace full-hash pools), re-measure before landing rather than adding a new compaction level.
