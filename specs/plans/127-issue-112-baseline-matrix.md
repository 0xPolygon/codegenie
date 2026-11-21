# #112 · First-round review baseline

**Status — first round complete.** The operator authorized the two remaining cases after the small-case checkpoint. All 54 reviews finished on the pinned build for $198.59 in recorded usage, including nominal Codex subscription usage. The comparisons were tied or too sparse under the pre-registered rule. Normal depth with adaptive off remains the default, and light depth is not promoted. The sections below preserve the original protocol and pre-run estimates. [First-round results](../../notes/research/20261121-043636-first-round-baseline-results.md)

## Cases and scorer

Use the pinned runner `8a4c5bd1574d4c841343fae94c3cabf9cdc31ff4`. The scorer prerequisite in synthesis recommendation 6 is satisfied by #87, commit `10251bd`. A failed review records an error and skips expectation scoring. Missing or unreadable candidate/final finding artifacts surface as errors. A positive match must satisfy all fields on a coherent source, including the pairing of path and range. Historical cross-source negative sentinels remain conservative. The eval suite passed all 88 tests. The relevant implementation is in `src/evals/eval-scoring.ts` and `src/evals/eval-artifacts.ts`, with regressions in `tests/evals.test.ts`. Review broad title matches and discordant negatives manually. An execution with missing output is an error in the denominator.

| Case | Frozen input and oracle |
| --- | --- |
| Small stored Go case | Freeze the recorded merge base and head. Retain the historical required expectation and budget labels. Remove the auxiliary model judge. |
| Larger stored Go case | Preserve the single-commit target and its parent. Retain required and optional positives, candidate-only expectation and false-positive sentinel separately. |
| New TypeScript case | Use public codegenie parent `a8b1d998cb10b65de26e05dbc001b7079df5ff42` and head `80df9e6c6869035cb0cf1c6b2dfba75debf3edd6`. A fatal composer rejection followed by a failure to write the final findings artifact loses an already verified finding. The producer registers the retained review after the write, and the review runner looks it up by the error it catches. Accept a causal finding anchored in either pipeline file. |

The TypeScript oracle ran the two relevant tests from public fix `edd3ec2734e6fa093eb480a9a0d4f0c41aad7855` in separate scratch trees. On the case head, a typed fatal composer error with successful writes still fails the review and preserves its verified finding. In the two-failure case the write error propagates and the retained finding list is empty. On the fixed revision both tests pass. The ordinary typed-error path supplies two safe behaviors for adjudication. A separate finding about primitive rejections can be genuine and needs independent adjudication. Keep the oracle and all expectation text out of the target working tree.

## Execution

The private campaign directory holds three clean detached target checkouts, an independently built pinned runner and 54 single-run YAML copies. Each slot has its own log directory. Both Go source manifests contained `review.deepEnsemblePasses`. All copies omit that key so #115's strict schema can read them. On the pinned runner its absence selects K=1. Omit lens overrides, remove the historical judge, and use the shipped composition reasoning step-down. The TypeScript target has two repository classification rules for docs/fixtures, neither of which matches the changed files.

| Hold constant | Setting |
| --- | --- |
| Model routes | `anthropic/claude-opus-5-5` and `openai-codex/gpt-6.2-sol`, configured reasoning `medium`. Report effective per-stage reasoning as emitted. |
| Review | Verification on, budget boost 1, six workers, six simultaneous model calls per review, 8,000,000-token budget, 30-minute review limit, shipped eight-minute per-pass limit, local model cache off. Retain provider cache accounting. |
| Arms | A = normal depth / adaptive second pass off (shipped reference), B = normal / on, C = light / off. |
| Pairing | Three repetitions per arm, case and model. Within each repetition, rotate ABC, BCA, CAB. Alternate which provider starts each pair. Pair by case, model and repetition. Each review is an independent draw. |

The phase launcher serializes reviews and locks the campaign. From the operator-supplied private campaign working directory, inspect the small phase with `python3 run.py --case small`. After approval, `python3 run.py --case small --run` dispatches exactly those 18 slots and exits. It calls the pinned CLI's `executeEvalCommand` entry point with `eval --eval-dir <slot> --no-cache`, an empty configuration home and the runtime's existing credential store. The offline build used the frozen lock and Pi 1.6.0. All 54 single-case suites passed `loadEvalSuite`; the TypeScript scorer matched example positive and negative findings at either allowed anchor.

1. At the small-case stop, reconcile 18 slot results with the two provider routes and their call ledgers. Report actual known cost, unknown-cost calls, elapsed time and incomplete/error counts by family and arm. Separate Codex subscription usage and its nominal equivalent. Wait for the operator's decision.
2. After the checkpoint is cleared, select `--case large --run` or `--case typescript --run` explicitly for each remaining phase. Keep the 30-minute limit in every arm. The larger historical comparison used 75 minutes, and a partial run at the shipped limit is a measurement outcome.
3. A scored failure is a completed observation. On an execution error, interrupted process or missing output, retain the slot and usage and reconcile before resuming. Count attempted/error/partial reviews separately. A replacement requires its own record and must never silently replace the original observation.

## Repriced estimate

The 2026-11-20 development campaign supplied 15 small and nine larger reviews across three builds. They used a different model, maximum reasoning, adaptive-on, fixed lenses and four workers. Repricing their **per-call** token splits at the pinned Pi catalog rates gives the following scenarios. They are neither observed prices for the proposed models nor bounds on future spend.

| Historical input | Opus USD/run, min / median / max | Sol USD/run, min / median / max | Historical elapsed min/run, min / median / max |
| --- | ---: | ---: | ---: |
| Small, 15 reviews | 3.96 / 5.13 / 6.33 | 1.98 / 2.56 / 3.16 | 7.84 / 9.96 / 16.14 |
| Larger, 9 reviews | 30.72 / 40.16 / 45.43 | 15.36 / 20.80 / 23.45 | 37.69 / 48.06 / 53.63 |
| New TypeScript | Unknown | Unknown | Unknown |

At nine slots per model and case, the small-case allowance implied by the medians is $46.17 Opus plus $23.04 Sol nominal. Sequential scheduling at the historical median would take about three hours. The larger case reprices to about $549 ($415–620). The two known cases total about $618 at the medians. The third case has no measured token distribution. Five of 646 small-case calls and eight of 4,854 larger-case calls lacked usage. The price estimate includes only recorded usage.

Per million tokens, in uncached input / output / cache read / short cache write order, the catalog used $4 / $20 / $0.20 / $5 for Opus and $2 / $10 / $0.10 / $2.50 for Sol. Sol's long-input tier above 272,000 combined input tokens uses $4 / $15 / $0.20 / $5 per million. Price each call in its own tier, count reasoning included in output once, and flag unknown cache-write retention. Compare nominal cost, recorded usage and any available actual charges separately. [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) · [OpenAI pricing](https://developers.openai.com/api/docs/pricing)

## Reporting and decision rule

Pair required findings by case/model/repetition across arms. Record machine match and independent adjudication, first loss stage, severity and whether the final report retained the finding. Adjudicate all arm-discordant claims and novel false positives against the frozen source and its controls. Keep optional, candidate-only and negative checks distinct. Preserve a reviewer-verifiable private worksheet and publish only aggregate outcomes.

For each arm and family report attempted/completed/partial/error denominators, verified material recall, adjudicated false positives, budget and timeout health, provider-cache usage and unknown-cost calls, plus median/range cost and elapsed time. For light depth also count planner coverage distribution, skipped eligible hunks, dispatched packets, escalated packets and candidates. Use the saved plan, packet records, stage events, candidates, verified/final findings and model-call ledger. Separate dollars for known-priced calls from incomplete usage. Compare A–B to isolate the adaptive setting and A–C to measure light depth with adaptive off.

This round prices the workload and surfaces discordances. Three repetitions do not decide a new default, authorize deletion or establish language-wide recall. Review the small-case ledger before projecting the remaining cost. Further repeats or a fourth case require a separate decision.
