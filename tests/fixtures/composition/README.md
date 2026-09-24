# Plans 117–119 offline reporting fixtures

`contract-review.ts` contains a sanitized coverage correction and minimum-output
contract. `authorization-review.ts` provides an independent revocation example.
Assessments and composed sections are handcrafted fixture inputs, not claims that
an offline replay performed repository investigation or semantic verification.

Preview the contract report without provider calls:

```sh
pnpm exec tsx scripts/preview-composition.ts > /tmp/composition-preview.md
pnpm exec vitest run tests/composition-contract.test.ts tests/report-synthesis.test.ts tests/verifier.test.ts
```

The script also accepts a JSON bundle with `findings`, `sections`, `evidenceRefs`,
and `presentation`. Export either fixture function to JSON for a fixed-input
comparison. Metrics go to stderr: narrative, primary and provenance words,
verification words, renderer-added uncertainty words, evidence words and source
accounting. `uncertaintyWords` measures the deterministic safeguard only; authored
secondary caveats belong to `verificationWords` and `narrativeWords`.

The Plan-118 review rendered identical current fixture inputs through the
checkpoint's old renderer and the new renderer, using the same normalized
assessments for both. These measurements isolate presentation changes:

| Fixture | Primary words, before → after | Provenance words, before → after | Accounted sources |
| --- | --- | --- | --- |
| Minimum-output contract | 105 → 93 | 400 → 326 | 18/18 |
| Authorization/revocation | 82 → 72 | 254 → 215 | 8/8 |

The current conclusion includes the material secondary uncertainty once. The
provenance still contains the original questions, supersession reasons, candidate
severity/confidence, suggestion assessments, contract basis and evidence. It no
longer repeats suggestion text inside a JSON assessment. Raw structured records
remain in the regular artifacts. The tests also retain essential uncertainty,
qualify conflicting identical suggestions, and exercise unsynthesized fallback.

The executable wrong-fix examples in `report-synthesis.test.ts` show why matching
a quoted minimum to delivery is insufficient without meeting the original request,
and why matching an authorization result to a stale local boolean does not test
revocation. Verifier fixtures cover a counterexample past a truncated prefix,
bounded absence, and secondary reach uncertainty. Scripted verdicts prove harness
propagation and gates, not the model's ability to find or assess that evidence.
Existing tool delivery metadata already exposes truncation; no tool protocol or
budget change was necessary.

For live measurement, retain the same verified candidates, source inventory,
intent, coverage and follow-up notes. Use the production Stage-10 prompt, schema
and runner; keep model, routing, effort, deadlines and retry counts fixed across
implementation comparisons, and disable response-cache reuse. Save prompt size,
time to first content, reasoning/tool-argument progress, completion latency,
usage and fallback status. `unknownCostCalls` in the existing cost profile and
model summary means `totalCostUSD` is a recorded subtotal, not complete provider
billing. Cancelled calls with no final usage remain unknown.

Evaluate successful model composition separately from deterministic fallback.
Review false positives, coherent conclusions, independently actionable findings,
contract-preserving fixes and reachable regression tests manually. Smaller inputs,
shorter reports and valid references do not prove better semantic quality or
completion. Repeated authorized live samples against DeepSeek 93 and GLM 94 remain
pending; run 94 is a fallback/completion baseline, not successful GLM synthesis.

Plan 119 keeps the same assessment schema. The minimum-output fixture now retains
its independently unverified test in provenance rather than showing it as advice;
the supported fix stays visible. The authorization fixture retains both supported
recommendations. Behavioral examples also reject an unnecessary delivery equality
and an exact authorization status requirement when multiple denial transports
satisfy the stated policy. They distinguish non-divisible successful requests from
divisible inputs and inputs rejected by an existing guard.

`recommendation-publication.test.ts` covers unsupported/stale/historical advice,
conflicting assessments across separate groups, complete source accounting and
bounded advice-section repair. The runner test exercises a failed partial advice
repair followed by success: section removal must not resurrect an old array item.
Prompt checks cover diagnosis-only summary/impact/verification prose; these checks
cannot guarantee that a future model will follow those instructions. Review live
reports for advice leakage and unsupported strengthening of a supported source.

Run 97 is the pre-implementation GLM baseline, and run 98 was started on the
pre-plan-119 code with DeepSeek max. Neither measures this implementation. A
post-change live comparison remains pending; offline rendering and scripted
verdicts cannot demonstrate improved model judgment.
