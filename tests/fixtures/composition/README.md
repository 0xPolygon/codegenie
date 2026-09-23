# Plan 117 offline reporting fixture

`contract-review.ts` contains a sanitized run-91-style coverage correction and
minimum-output contract. Assessments are explicit fixture inputs, not claims
that a new model run performed the lookups. Production and testing candidates
remain independently identifiable. The proposed composition is handcrafted.

Preview the report without any provider calls:

```sh
pnpm exec tsx scripts/preview-composition.ts > /tmp/composition-preview.md
pnpm exec vitest run tests/composition-contract.test.ts tests/verifier.test.ts
```

Metrics go to stderr; narrative, primary presentation, and provenance are measured
separately before rendering containers. The script also accepts a saved JSON
bundle with `findings`, `sections`, `evidenceRefs`, and `presentation` fields.
Do not infer model quality from this deterministic fixture.

For the deferred live reasoning comparison, save the same verified candidates,
source inventory, intent, coverage, and follow-up notes for both conditions. Use
the existing Stage-10 runner, production prompt builder and live submission schema;
change only the composition effort override, disable response cache reuse, and
retain existing deadlines. Save debug requests/responses (prompt/schema/runtime,
model, resolved effort and routing), latency, usage, repair/fallback events and
composition presentation metrics. Compare factual conclusions and caller-compatible
fixes/tests manually; source-accounting validity does not prove paraphrase fidelity.
Multiple authorized generations and a subsequent full eval are needed before
changing the default reasoning policy. This implementation does not run or add
a paid experiment command.
