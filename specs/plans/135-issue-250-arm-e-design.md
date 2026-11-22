# Arm E: Stage 7 subtraction and packet-first presentation (#250)

Design for a developer. Branch from the frozen baseline `d2fc655`. All line references are at that commit; `src/skills/prompt-builder.ts` is unchanged since v0.9.1.

## Decision

Build arm E as one switch that changes what the Stage 7 reviewer is shown and told, with the default behaviour byte-identical when the switch is off. Eight items, each with a trace mark. Two PRs, both behind the same switch.

Scope is #250's: P1 to P6 and H8. Two things are deliberately outside it:
- **P7 to P9, H11, H12** (promotion, Stage 9, Stage 10) are #277. Putting them in E would mix Stage 9 and 10 changes into the A against B contrast.
- **H6** (Stage 5 prompt) cannot be measured by the registered run, which reuses one planner capture from arm A for every arm. Building it into E would ship an unmeasured planner change. It is listed at the end as a separate follow-up.

## The switch and the trace marks

- **Config:** `review.stage7Prompt: "current" | "packet-first"`, default `"current"`. Add it to the review object in `src/config/schema.ts` (near `:43-60`, default near `:205-215`) and to the key list in `src/config/config-loader.ts`. It is not a repository-safe key.
- **Reaching the code:** pass it to `createPromptBuilder` (`src/pipeline/review-runner.ts:811`) as an option, and read `opts.config.review.stage7Prompt` in `buildReviewPackets` (`src/pipeline/packet-builder.ts:149`, config already passed to `buildPacket` at `:199`).
- **Template version:** `PROMPT_TEMPLATE_VERSIONS[7]` stays `"p7.16"`. An E prompt reports `templateVersion: "p7.e1"`.
- **Marks:** `BuiltPrompt` gains `marks?: string[]`. `runPacket` (`src/pipeline/lens-runner.ts:467-490`) passes them as a new optional `promptMarks` on the request (`LlmStructuredRequest`, `src/llm/llm-runner.ts:118`). The runner writes them next to `promptTemplateVersion` in the debug request artifact (`src/llm/pi-runner.ts:3171`).
- **A mark is present only if its item changed this prompt.** For example `E5` appears only when planner text was actually withheld from this packet. The marks: `E1.packet-text`, `E2.claims-last`, `E3.discovery-standard`, `E4.finish-condition`, `E5.planner-text-withheld`, `E6.one-question-channel`, `E7.close-nudges`, `E8.positions`.

## Prompt order under E

Today: frame, 22 rule paragraphs, skills, pr-summary, declared intent, the packet as one JSON object, closeout. Under E:

1. Frame (one sentence) and the injection instruction (`:729`), then one line: "The changed code comes first. The review rules follow it."
2. `changed-code` (untrusted block): the diff.
3. `surrounding-code` (untrusted block): context source.
4. `related-changes` and `tests` (untrusted blocks), each omitted when empty.
5. The review rules, then `Skill guidance:`.
6. `author-claims` (untrusted block).
7. `harness-notes` (untrusted block), omitted when empty.
8. The closeout (`:313-314`), unchanged.

The runner still appends the budget notice after the prompt.

## The items

### E1. The packet as text, diff first (P1)

Replace `fenceUntrusted(renderPacket(packet), "review-packet")` (`:281`, `renderPacket` at `:739-768`) with text blocks built from the same packet. What happens to each field:

| Packet field | Under E |
| --- | --- |
| `path`, `oldPath`, `fileStatus`, `language`, `id` | One header line in `changed-code`: `File <path> (<status>, <language>), packet <first 12 chars of id>`; `renamed from <oldPath>` when present. |
| `hunks[].contentWithLineNumbers` | Printed as is under a hunk header. It is already a two-column numbered diff (`renderLines`, `packet-builder.ts:1520`). |
| `hunks[].hunkId`, `oldStart`, `oldLines`, `newStart`, `newLines`, `header` | The hunk header: `hunk <id> base A-B head C-D`, and `in <header>` when `header` is set. |
| `hunks[].lines`, `changedNewLineNumbers`, `changedOldLineNumbers` | Not rendered. They repeat the diff. |
| `hunks[].staticSignals`, `omittedSignalCount` | After the hunk, one line each: `signal <ruleId> at line N: <explanation>`; then `N more signals omitted`. |
| `hunks[].truncated`, `omittedLineCount` | Already stated by the window markers inside `contentWithLineNumbers`; see E8 for their wording. |
| `hunks[].plannerFallbackReason` | Not rendered (planner-derived; see E5). |
| `symbolFacts` | Only the enclosing symbol, in the hunk header: `in <enclosingSymbol> (lines A-B)`. The rest repeats `contextText`. |
| `contextText` | The body of `surrounding-code`. |
| `packetSymbols` | One line at the end of `surrounding-code`: `Symbols touched: name (A-B), …`. |
| `relatedChangedContext` | `related-changes`: per entry a line `<path> hunk <hunkId>, <symbol> lines A-B, <relationshipSource>/<relationshipStrength>`, then `reason` (omitted for `planner_hint`, see E5), then `patchExcerpt`, then `sourceSnippet`. |
| `testCoverageDelta`, `relevantTests` | `tests`: the delta's `summary`, its non-empty lists one per line, then `Likely tests: path:name (A-B)`. |
| `intentSignals` | In `author-claims` (E2). |
| `attentionNotes`, `surroundingContextHints`, `contextQuality`, `contextDegradationReasons`, `degraded` | In `harness-notes` (E5). |
| `coverage`, `reviewProfile`, `reviewPriority`, `lenses`, `labels`, `kind`, `isDeletedContent`, `fileContext` | Not rendered. They are routing labels; what the reviewer needs from them is in the rules. |

Error case: a packet with no hunks renders `changed-code` with the header line and "no changed lines in this packet", never an empty block.

### E2. Author claims last, labelled (P2)

- `pr-summary` and `declared-intent` (`:279-280`) and the packet's `intentSignals` move into one block, `author-claims`, placed after the rules.
- First line inside the block: "What the author says this change does. Each statement is a claim to check against the code above, not a fact."
- `intentSignals` renders as its `summary` and one line per signal.

### E3. The discovery standard, not the verifier's (P3, H8)

Rule text changes for Stage 7 only. Stage 9 keeps everything it has.

| Where | Today | Under E |
| --- | --- | --- |
| `reviewerFrame`, `:724-726` | "…senior code reviewer performing packet review. Report only real, actionable issues with concrete evidence." | First sentence only. |
| `:286` | "Review the packet for real defects only. Use repository tools when needed to verify nearby code, definitions, or tests. Return no findings when there is no concrete failure mode." | "Review the changed code for defects. Use repository tools when needed to verify nearby code, definitions, or tests." |
| `:287`, `:288` | Documentation and test-coverage guidance (shared constants, `:82-84`) | Removed from Stage 7. |
| `STAGE_SECTION_MAP[7]`, `:252` | `checks`, `falsePositives`, `examples` | `checks`, `examples`. Give `projectSkills` the section list as a parameter; do not mutate the map. |
| `:293` | "Keep Stage 7 output compact: … noFindingReason is not a mini review report. Do not put detailed proof or broad exploration notes into noFindingReason." | "Keep noFindingReason to one or two sentences." |
| `:299`, `:300` | The two lossy-conversion paragraphs | Removed. The core skill's check covers the family. |
| `:301` | Ends "If task, PR, or spec context explicitly requires the new behavior and caller impact is covered, do not report it as a bug." | That last sentence removed; the rest kept. |

Unchanged: `:289`, `:291`, `:292`, `:296`, `:298`, `:302`, `:303`.

### E4. One finish condition (P4)

Remove the three profile sentences (`:305-309`) and `depthCloseGuidance` (`:605-613`, called at `:310`). Replace both with one paragraph, chosen by whether the packet has repository tools (`packet.reviewProfile === "simple" || packet.toolBudget.maxToolCalls <= 0`, the test at `lens-runner.ts:463`):

- **With tools:** "You are finished when every removed line and every added line in the changed code is accounted for: you know what it guaranteed or now does, and either nothing depends on the difference or you have raised a finding or a followUpHint about it. Settling your first suspicion is not the finish."
- **Without tools:** the same paragraph, followed by "This packet has no repository tools; decide from the text above."

This is an instruction about reasoning. Its effect shows only in outcomes; nothing in the submission records whether it was followed.

### E5. Planner prose withheld from the reviewer (P6)

The planner's coverage, lenses and mechanical context hints keep working. Its free-text reasons no longer reach the Stage 7 prompt. `packet.attentionNotes` itself must not change, because it also drives the tests-lens choice, tool enablement and the investigate profile.

- **Notes.** In `buildPacket`, after `mergeAttentionNotes` (`packet-builder.ts:327`), store `attentionNoteSelection.keptRelationshipNotes.map(n => n.note)` on the packet as a new optional field `relationshipAttentionNotes?: string[]`. E renders only these.
- **Tool-lookup hints.** `surroundingContextHints` render as their mechanical fields only: `look up <kind> <symbol or lines> in <path>`. No `reason`.
- **Hint context blocks.** Under E, omit the `Reason: …` line in `renderHintContextBlock` (`:2754-2768`) and in the recovered-definition block of `resolvePacketContextHint`. The code stays.
- **Related context.** Omit `reason` on entries whose `relationshipSource` is `"planner_hint"`.
- **Degradation reasons.** An entry that begins "planner packet_context hint(s) unresolved" renders as "N planner context hint(s) could not be resolved".
- **Rule `:295`** becomes: "Harness notes list mechanical relationships between changed symbols and lookups that could not be attached. They are not findings or proof."
- **`harness-notes` block:** `relationshipAttentionNotes`, the lookup lines, `contextQuality` when it is not `"full"`, and the degradation reasons.

### E6. One channel for open questions (P5)

- Every rule that names two channels names one. In `:290`, `:292`, `:294` and `:297`, "followUpHint/uncertainty", "followUpHints or uncertainties" and "followUpHint or uncertainty" become "followUpHint" or "followUpHints".
- `:294` first sentence becomes: "Any unresolved predicate that could change whether a defect exists must be emitted as a followUpHint with file or symbol scope." Its second sentence ("Do not emit broad reminders…") is removed; the third is kept.
- `STAGE7_NO_FINDINGS_SUBMIT_INSTRUCTION` (`lens-runner.ts:819`): under E, "…include pointer-rich followUpHints."
- The schema is unchanged. `uncertainties` stays a required array and the shape guidance (`:314`) still says to send `[]`.

**Open decision for the operator.** The first sentence of `:294` is the rule #250 asks for (P5). It is the kind of text arm B of plan 132 tested: questions rose from 47 to 123, Stage 9 cost about 30% more, and no new cause was raised. Two options:
- **Keep it** (as drafted here, per the ticket). Watch question volume and Stage 9 cost in the read-out.
- **Drop it**, so that E is subtraction and presentation only. Then `:294` keeps its current first sentence with the single-channel wording, and the rest of E6 stands.

Until the operator decides, the rule stays in the checklist and in this design. Record the decision here when it is made.

### E7. Close nudges neutralised, hard limits unchanged (P4)

Three texts push the reviewer to submit before the hard limit. Under E:

| Where | Today | Under E |
| --- | --- | --- |
| `lens-runner.ts:488`, `buildPostToolCloseNudge` (`:822-838`) | After 1, 2 or 3 rounds: "Only continue if the next repository tool call resolves one named predicate… Otherwise call submit_review now…" | Not passed. No post-tool nudge. |
| `pi-runner.ts:2432` | "The local investigation target has been reached. Finish with the evidence collected where possible; use bounded continuation only for concrete unresolved questions, then submit." | "The local investigation target has been reached. Continue only while a removed or added line is still unaccounted for; then submit." |
| `prompt-builder.ts:304`, second half | "Local budgets are targets: aim to finish within them, and use bounded continuation only to resolve concrete remaining questions. Global limits and local ceilings still apply." | "Local budgets are targets, not stop signals: when one is reached, continue only while changed lines remain unaccounted for. Hard limits still apply." |

- The runner text is selected by a new optional request field, `finalization.softTargetNotice?: string`, set by `runPacket` under E. Without it the runner prints today's sentence, so Stage 9 and the default are unchanged.
- Not changed: the remaining-budget line (`:2431`), the hard limits, and the forced finalise at exhaustion (`pi-runner.ts:989-999`, `:1114-1120`).

### E8. Positions in the packet (the standing rule)

The diff rows already carry both line numbers. The rest of the packet's source does not. Under E, at packet build time:

- **File lengths.** New optional packet field `fileLines?: { base?: number; head?: number }`, counted once per file as `DiffBlockRenderer.describeFile` does (`src/repo/diff-blocks.ts`). Rendered in the `changed-code` header: `<path>@base: N lines | <path>@head: M lines`, with `base absent` or `head absent` for added and deleted files.
- **Window markers.** `renderWindow` (`:1498-1509`) writes "[... N lines omitted above ...]". Under E the marker states what was omitted: `[... omitted above: base A-B / head C-D ...]`, from the first and last omitted line.
- **Context source is numbered.** Each of these produces unnumbered source today. Under E each gets a header from `renderSourceBlockHeader` and lines from `numberSourceLine` (`src/llm/repository-tool-guidance.ts`), starting at the line the read started at:

| Site | Start line comes from |
| --- | --- |
| `renderFullSymbolContext`, `:2173` | `fact.symbolRange[0]` |
| `readChangedLineExcerpts`, `:2268` | `normalized.startLine` (the "Excerpt path:A-B" line becomes the header) |
| `renderWholeFileBlock`, `:1591` | 1 |
| `renderHintContextBlock`, `:2754`, line-range hints | `normalized.startLine` |
| `renderHintContextBlock`, symbol hints | `result.symbol.lineRange[0]` |
| `relatedContextForTarget`, `:1054`, `sourceSnippet` | `result.symbol.lineRange[0]` |

- **File length for symbol reads.** `readSymbol` does not report it. Add `totalLines` to its meta where it already has the file content (`src/repo/repository-index.ts`, `readSymbolAtSource`), as `read_range` and `find_definition` do.
- **Budgets are measured on the raw source, then the lines are numbered.** Apply the existing caps (`MAX_CONTEXT_CHARS`, `MAX_SYMBOL_EXCERPT_CHARS`, `MAX_HINT_CONTEXT_CHARS`, `MAX_RELATED_CONTEXT_SNIPPET_CHARS`) to the unnumbered text, so arm B shows the same source lines as arm A. The rendered text is then longer than the cap by the numbering.
- **Cuts land on whole lines.** `truncateTail` (`:1597`) and `truncateToBudget` (`:2221`) slice mid-line. Under E, for these source blocks, cut at the last whole line and end with `[... cut after line L of N; continue with read_range startLine=L+1 ...]`.
- **A block is never numbered from a guess.** If a start line is unknown (a symbol read with no `symbol.lineRange`), leave the block unnumbered and say so in its header: `<path>@head, line numbers unavailable`.

## Build order

Two PRs behind the one switch. Arm B needs both.

1. **PR 1, prompt and projection.** The switch, the marks, E1 to E7. It reads existing packet fields, except for the one new field in E5 (`relationshipAttentionNotes`).
2. **PR 2, packet positions.** E8, plus the two build-time parts of E5 (the `Reason:` lines). It changes packet text only when the switch is on.

With the switch off, both PRs must leave prompts and packets byte-identical.

## Tests

- **Switch off:** the existing Stage 7 prompt snapshot tests pass unchanged (`tests/pipeline-phase5.test.ts`, `tests/shared-utils.test.ts`, the language tests), and a stored packet serialises byte-identically.
- **Order (E1, E2):** in an E prompt the index of `changed-code` is below the index of the first rule, and `author-claims` is after the last rule.
- **No duplicate diff (E1):** the E prompt does not contain `"lines": [` or `"contentWithLineNumbers"`; each hunk's `contentWithLineNumbers` appears exactly once.
- **Removed text (E3):** an E prompt contains none of: "Report only real, actionable issues", "real defects only", "A missing test for a new branch alone is not a finding", "For documentation findings", "### False Positives", "Validate raw external", "do not report it as a bug".
- **Finish condition (E4):** exactly one paragraph containing "every removed line and every added line"; none of the three profile sentences.
- **Planner prose (E5):** build a packet from a plan whose reasons and focus notes are unique marker strings; none appears in the E prompt. The packet's `attentionNotes`, `reviewProfile` and `toolBudget` equal the switch-off values.
- **One channel (E6):** the rules of an E prompt do not contain "uncertaint" outside the shape guidance.
- **Nudges (E7):** under E the request has no `buildPostToolNudge`; a fake run that reaches the soft target receives the new sentence; with the switch off it receives today's.
- **Positions (E8):** for a fixture from each public repository, every source line in `surrounding-code` and `related-changes` starts with the number the pinned file gives it; a block cut at a tight cap ends on a whole line with the resume marker; a packet for an added file says `base absent`.
- **Marks:** each mark is present when its item applied and absent otherwise (a packet with no planner prose has no `E5` mark).

## Zero-cost check before any run

Render the stored arm A packets of the 51 planner captures both ways and report:
- every diff row present in both, byte for byte;
- no planner reason or focus note from the stored plan appears in any E prompt (string containment over all packets);
- every numbered source line matches the pinned tree;
- prompt characters, A against E, as a distribution, split into rules, skills and packet;
- how many source blocks are cut under E that were whole under A (should be zero, since the caps apply to the raw source).

## Risks

- **Anchors.** Findings must still name a path, a side, a line and a hunk. The hunk header carries the id and both intervals and every row carries both numbers, so the information is there in a new shape. Stage 7 repair rate is the kill metric (arm A: 4 of 505 packets).
- **More investigation.** With the nudges gone, reviewers will use more of the hard budget. Expect more tool turns, cost and time, and more character-budget refusals. Report all four.
- **More questions.** E6's rule raises question volume, as it did in arm B, and with it Stage 9 cost.
- **A longer prompt in places.** Numbering adds roughly 8% to 15% to context source. Dropping the duplicated `lines[]` removes about 23% of the packet, so the prompt should still shrink. The zero-cost check gives the real figure.
- **The whole bundle is one arm.** A gain or a loss cannot be attributed to an item without an ablation. The marks say which items applied to each prompt, which is what an ablation would need.

## Verification gaps

- E4 and the rewritten `:304` are reasoning instructions. Reasoning is visible in about half of stored calls, so compliance cannot be audited from traces.
- I did not check the adaptive second pass (`cacheDraw: "stage7-adaptive-2"`) beyond confirming it uses the same prompt builder.
- The exact line numbers in `packet-builder.ts` are at `d2fc655`; #287 and #288 landed just before it, so confirm them on the branch.

## Not in E: Stage 5 (H6)

Two changes were proposed for the planner prompt: stop leading with declared intent (`:265`), and stop listing the same eight lenses twice (`:270-271`). The registered run reuses arm A's planner capture for every arm, so neither would be exercised by it, and changing the planner would invalidate that shared capture. Keep both out of the E branch. Decide them after the run, with their own planner comparison; the duplicate list is the cheap one.
