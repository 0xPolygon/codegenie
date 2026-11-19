---
created: 2026-11-19T20:29:49Z
author: architect-2
source: "0xPolygon/codegenie#44, reciprocal challenge of workstream D"
status: provisional
---

# Challenge of plan history and competitive research

I checked the [plan history](./20261119-202300-plan-history.md) and [competitive study](./20261119-202647-competitive-landscape.md) against master f2403762. The numbered ledger accounts for all 125 slots, including missing number 103 in the master sequence. The history of failed closeout compression and the measured cost of broader sampling support retaining the complete Stage 7 submit contract in an initial light-depth experiment. Several suggested deletions and competitor analogies need narrower claims before they can guide implementation.

## Which deletions preserve behavior?

| Proposed simplification | Existing caller or contract | Required disposition |
| --- | --- | --- |
| Delete the preflight-only Action path | The Action declares this input, routes it into the process and honors it before dispatch. Users can exercise it without invoking a model. [Action](../../action.yml#L58) · [Entrypoint](../../src/github-action/entrypoint.ts#L177) | Retain it unless the operator approves a public input change. A silent full review would spend money. |
| Drop unused skill categories | The parser accepts categories in user skill front matter and validates their values. A parser that rejects the formerly recognized key breaks existing skills. [Skill loader](../../src/skills/skill-loader.ts#L324) | Separate removal of unused downstream state from acceptance by the reader. Run an existing skill with that metadata. |
| Delete the old eval cache fields | Readers still use fallback names for past artifacts. [Eval command](../../src/evals/eval-command.ts#L181) · [Eval comparison](../../src/evals/eval-compare.ts#L168) | A writer can converge on one schema while readers keep handling older output. Exercise an archived result after the edit. |
| Replace the Action credential map with Pi's environment lookup | Pi 1.5.2 exposes asynchronous auth availability. Its package root does not export the proposed environment-key getter. Availability alone does not identify the environment variable to populate or clear for the Action subprocess. [Provider workstream](./20261119-201523-model-providers-fast-lane.md) | Reuse auth availability for preflight. Retain a tested ownership boundary for key placement and cleanup. |

The ledger's aggregate outcome count is reproducible. A number of individual “live” rows still lack a durable file, caller, test or commit reference in the note. Preserve those anchors alongside the rows before discarding scratch evidence. Bound the later-period “unit-only” claim to its specific plans. Plans 123 and 124 both record real runs. Distinguish uncontrolled reviews from the controlled evaluation suite.

## What the proposed experiments can establish

A filter that prevents false positives can record zero rescued true positives even when it is doing its job. Replay its inputs with and without the gate and adjudicate the changed publications in both directions. The adaptive second pass is enabled in two of three controlled case configurations and defaults off in the product. The difference leaves the direction of bias open. Measure recall, cost and false positives on the actual default arm with the case overrides pinned. The prior suite can supply a separate historical comparison. [Lens dispatch](../../src/pipeline/lens-runner.ts#L230)

The published cross-model study gives useful evidence for model complementarity on its cases. Changing to a different model for each stage and unioning different reviewers' candidates are different experiments. A different planner and verifier still leave only one packet reviewer looking for a particular bug. Codegenie's optional same-packet ensemble unions candidates before verification. A vendor's experience deleting majority voting cannot validate deleting that union. [Assembly of independent passes](../../src/pipeline/lens-runner.ts#L380)

## Competitor claims that affect the fast lane

- Warden explicitly allows disabling the second verification pass. Anthropic documents verification for its managed product and independently verified findings for Ultrareview. The managed review levels describe speed and cost, with no published verifier ablation by tier. The competitive table itself identifies a single-shot reviewer. Keep independent verification in codegenie's proposed first arm on codegenie's evidence, without claiming every vendor does so. [Warden architecture](https://warden.sentry.dev/architecture/) · [Managed Code Review](https://code.claude.com/docs/en/code-review) · [Ultrareview comparison](https://code.claude.com/docs/en/ultrareview)
- Per-hunk content reuse on a new head and issue #30's exact model-call cache are separate designs. The existing call key includes the model conversation and run fingerprint. The latter includes the repository location and head. An unchanged patch can gain a new caller elsewhere that invalidates an earlier safe judgment. Test exact replay across two work directories for the same head and full request. Separately test a new head that changes a dependency outside the unchanged hunk. A path-and-body match cannot prove that reuse is safe for tool-dependent judgments. [Call key](../../src/llm/pi-runner.ts#L1791) · [Review fingerprint](../../src/pipeline/review-runner.ts#L846)
- A severity filter at publication can reduce comment volume while leaving planner, packet and verifier work unchanged. Report saved calls or elapsed time separately from fewer published findings. Cross-product percentages in the study use different denominators, and cannot establish which setting improves this harness's precision.

**Verdict.** The plan inventory and the broad comparison are useful for synthesis with the qualifications above. The proposed light-depth arm remains a reasonable first experiment. Incremental reuse, public input retirement and gate removal each require their own compatibility or signal test.
