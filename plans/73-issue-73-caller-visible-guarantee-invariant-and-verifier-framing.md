# Issue 73: Caller-Visible Guarantee Invariant and Verifier Framing

Status: COMPLETE
Planned from: trails-api eval `49f4645b/logs/19` compared with `49f4645b/logs/17` and `49f4645b/logs/18`, 2026-06-19
Planned at: commit `bf6951d`
Recommended priority: high after Issue 72. Issue 72 preserved the right relationship notes, but run 19 still missed because Stage 7 and Stage 9 checked internal consistency/materiality rather than tracing whether the caller-visible guarantee remained deliverable.

## Problem

Run 19 shows that the structural context path now works:

```text
GetQuote packet attentionNotes:
  Planner context hint links this hunk to changed symbol scaleAmount.
  Planner context hint links this hunk to changed symbol processQuote.
  Collateral sufficiency comparison rewritten...
```

That is the intended Issue 72 behavior: deterministic relationship notes lead the planner note.

The packet reviewer then inspected the related path and still cleared it as no findings. Its reasoning engaged `scaleAmount`, `processQuote`, and the `EXACT_OUTPUT` path, but checked the wrong property:

```text
Checked: internal consistency of denominations and fields.
Missed: whether the floor-truncated transformed value can still satisfy the caller-visible quote/minimum/guarantee.
```

The useful follow-up hint did preserve a better predicate:

```text
transferAmount = scaleAmount(...) truncates down, while destinationAmount/quote output can still report the requested value.
```

That predicate reached Stage 9. The verifier confirmed the literal truncation behavior, then rejected it as non-actionable because it treated the loss as bounded precision dust and cited deliberate/documented scaling intent. The verifier did not complete the decisive reasoning step:

```text
Before dismissing precision loss as dust, trace the caller-visible output back
to its source:
  - if the output is derived from the same rounded/transformed value, dust may be benign;
  - if the output is derived from the unrounded source, the output can overstate what the path delivers.
```

The promotion evidence handoff was still weak, but it was not the primary run-19 failure. The promoted candidate contained the right predicate and only one related-evidence summary for `scaleAmount`. The source packet's attached related context was one hop away (`scaleAmount -> GetQuote`); the decisive output path (`processQuote` / `quoteParams`) lived another hop away on the GetQuote packet. A one-hop `packet.relatedChangedContext` carry-through would not by itself have fixed run 19.

So the remaining failure is not Stage 5 planning, Stage 6 relationship context, Stage 7 attention-note ordering, Stage 8 follow-up policy, or Stage 10 publication. It is a narrower Stage 7/9 quality gap:

```text
lossy transformation -> caller-visible bound/quote/guarantee
  must be checked for satisfiability/deliverability,
  not just internal unit/type/field consistency

and before Stage 9 rejects as immaterial/dust,
  it must trace whether the visible promise is derived from the rounded value or the unrounded source
```

## Rationale

This should not become a taxonomy of financial, protocol, exact-output, token, Go, or bridge bugs.

The general review principle is broader:

```text
When changed code transforms a value and later exposes a caller-visible promise derived from that value, the promise must remain satisfiable from the transformed value.
```

Examples of caller-visible promises include bounds, quotes, limits, minimums, maximums, balances, capacities, offsets, counts, deadlines, permissions, and guarantees. The exact domain does not matter. The failure mode is overstating what the changed path can deliver after a lossy or narrowing transformation.

This belongs in the bundled core review skill because it is a reusable correctness check. Skills are projected into both Stage 7 and Stage 9, so the verifier will receive the rule through the normal skill projection path. Small Stage 7 and Stage 9 prompt lines are also justified because skill text is capped and this eval shows the verifier can confidently apply the wrong materiality frame.

There is also a small handoff hardening opportunity in `uncertainty-promotion.ts` because promotion already builds `CandidateFinding.evidence.relatedCode`. The current hook is shallow:

```ts
function relatedEvidence(source: PromotionSource): NonNullable<CandidateFinding["evidence"]["relatedCode"]> {
  const symbolLines = source.packet.symbolFacts
    .map((fact) => [fact.enclosingSymbol, fact.signature].filter(Boolean).join(" | "))
    .filter((line) => line.trim().length > 0)
    .slice(0, 8)
    .join("\n");
  const entries: NonNullable<CandidateFinding["evidence"]["relatedCode"]> = [];
  if (symbolLines.trim().length > 0) {
    entries.push({
      path: source.packet.path,
      lines: symbolLines,
      whyRelevant: "Changed symbols attached to the unresolved predicate."
    });
  }
  for (const file of source.files.filter((file) => file !== source.packet.path).slice(0, 4)) {
    entries.push({
      path: file,
      lines: `Referenced by ${source.sourceKind}: ${source.question.trim()}`,
      whyRelevant: "The reviewer pointed at this related file as part of the unresolved predicate."
    });
  }
  return entries;
}
```

It only adds related files explicitly named by the hint. It is reasonable to inherit bounded related-context evidence when the hint's files or symbols match `packet.relatedChangedContext`. However, this is secondary hardening. It should not be presented as the run-19 fix because the decisive output-path context was not directly attached to the promoted source packet.

## Functional Spec

### 1. Core Review Skill Invariant

Add one generic correctness check to `bundled-skills/core/code-review.md`.

Expected wording should be close to:

```text
Caller-visible guarantees after transformation: when changed code rounds,
truncates, normalizes, narrows, coerces, or otherwise transforms a value that is
later exposed as a caller-visible bound, quote, limit, minimum, maximum,
balance, capacity, or guarantee, verify that the exposed promise is still
satisfiable from the transformed value. Internal unit/type/field consistency is
not enough.
```

Add one false-positive guard that requires tracing the visible output before dismissing the issue:

```text
Do not report unavoidable precision dust when the caller-visible output is
derived from the same rounded value, or when the rounding/narrowing behavior is
explicitly part of the contract and does not overstate what can be delivered.
Before applying this guard, trace whether the visible output is derived from
the rounded/transformed value or from the original unrounded value.
```

Add one example that is generic and not tied to trails-api:

```text
A function floors an available quantity before reservation, but reports the
unfloored request as the guaranteed minimum to the caller; this is a correctness
finding if the guarantee can no longer be met.
```

Do not mention Hyperlane, tokens, exact output, bridges, decimals, Go, or any repo-specific symbol.

### 2. Stage 7 and Stage 9 Prompt Nudges

Add one compact sentence near the existing Stage 7 lossy-conversion guidance in `src/skills/prompt-builder.ts`.

Stage 7 expected behavior:

```text
For lossy transformations that feed caller-visible outputs or bounds, check
whether the published value remains deliverable/satisfiable, not only whether
units or fields are internally consistent.
```

Add one compact sentence to the Stage 9 verifier prompt.

Stage 9 expected behavior:

```text
For promoted lossy-transform predicates, verify that caller-visible outputs or
bounds remain deliverable/satisfiable; before rejecting as immaterial precision
loss, trace whether the visible output is derived from the transformed value or
from the original source value.
```

Keep each addition to one sentence. Do not add examples or a list of domains. Do not create a general invariant catalog.

Also keep the intent framing clear:

```text
Documented or deliberate transformation intent can explain why the conversion
exists, but it is not evidence that an overstated caller-visible guarantee is
safe.
```

This may be covered by the same Stage 9 sentence or by nearby existing intent guidance. Do not duplicate large blocks of prompt text.

### 3. Promotion Evidence Carry-Through as Secondary Hardening

Extend `relatedEvidence(source)` in `src/pipeline/uncertainty-promotion.ts` so promoted follow-up hints and uncertainties can carry bounded related changed context already attached to the packet.

This is useful generic hardening, but it is not the primary run-19 fix. Do not build a multi-hop graph traversal in this plan. If a promoted source packet lacks the decisive related context, this step should do nothing rather than inventing context.

Functional behavior:

- Continue to include the existing packet symbol summary.
- Continue to include files explicitly named by the hint.
- Additionally inspect `source.packet.relatedChangedContext`.
- Select related context entries when either:
  - the entry path is in `source.files`;
  - the entry target hunk path is in `source.files`;
  - any entry symbol/relationship target/source text matches one of `source.symbols`;
  - the hint `question` or `reason` text contains a related-context symbol name.
- Add selected entries to `evidence.relatedCode` using the related-context path and bounded lines/source already present on the packet.
- Cap the total added related-context evidence so promoted candidates stay compact.
- Deduplicate by path plus normalized lines.

Suggested limits:

```text
MAX_RELATED_CONTEXT_EVIDENCE = 3 entries
MAX_RELATED_CONTEXT_EVIDENCE_CHARS = reuse MAX_EVIDENCE_CHARS or a smaller local cap
```

Exact constants can differ if the implementation finds an existing local convention. Keep the total Stage 9 candidate prompt bounded.

`whyRelevant` should explain why the evidence was carried:

```text
Attached related changed context matched the unresolved predicate by referenced symbol/path.
```

The implementation should not run new repository tools during promotion. It should only reuse evidence already present on `ReviewPacket.relatedChangedContext`.

Explicit non-behavior:

```text
scaleAmount packet has only GetQuote related context
  -> carry GetQuote if matched
  -> do not chase GetQuote's related processQuote context here
```

If repeated evals show that verifier candidates need multi-hop relationship context, write a separate plan for bounded graph evidence expansion. Do not fold it into this plan.

### 4. Promotion Telemetry

Add lightweight telemetry to the existing uncertainty-promotion artifact or event:

- number of promoted candidates with related-context evidence attached;
- per promoted candidate, count of related-context evidence entries added;
- optionally the matching reason (`path`, `symbol`, or `predicate_text`) if cheap.

Do not add a new model call or a large artifact.

### 5. Documentation

Update only if terminology changes:

- `specs/projects/codegenie/functional_spec.md`
- `specs/projects/codegenie/components/review_pipeline.md`

The docs should say that promoted hints may carry bounded packet related-context evidence into verification. Do not document this as a new review category.

## Architecture Notes

This plan keeps current stage ownership intact:

- Stage 5 remains a lightweight scheduling scout.
- Stage 6 remains deterministic packet/context construction.
- Stage 7 remains the first issue-finding stage.
- Stage 8 remains narrow and repeated-hint triggered.
- Stage 9 remains strict independent verification.
- Stage 10 remains conservative composition.

The skill/prompt change helps Stage 7 choose the right semantic property to inspect and helps Stage 9 apply the right materiality frame. The promotion change is secondary hardening: it helps Stage 9 reuse directly attached packet context when available, but it must not expand into a new multi-hop context system.

This is not a deterministic finding rule. codegenie should not auto-report all lossy conversions, all minimums, or all transformed outputs. The model still decides whether a concrete failure mode exists, and the verifier still rejects unproven or immaterial claims.

## Non-Goals

- Do not add a fixed invariant taxonomy.
- Do not add domain-specific words such as Hyperlane, bridge, token, exact-output, fee, quoteParams, or any trails-api symbol.
- Do not loosen Stage 9 verification.
- Do not lower confidence or severity thresholds.
- Do not make Stage 8 run for single hints.
- Do not make Stage 5 ask questions or prove bugs.
- Do not add repository tool calls to uncertainty promotion.
- Do not add multi-hop relationship graph traversal to uncertainty promotion.
- Do not treat documented or deliberate transformation intent as evidence that an overstated caller-visible guarantee is safe.
- Do not blanket-upgrade coverage or budget.

## In-Scope Files

- `bundled-skills/core/code-review.md`
- `src/skills/prompt-builder.ts`
- `src/pipeline/uncertainty-promotion.ts`
- relevant tests, likely:
  - `tests/phase4-skills-provider.test.ts` or another skill/prompt projection test
  - `tests/uncertainty-promotion.test.ts`
  - `tests/pipeline-phase7.test.ts` if prompt text is asserted there
  - `tests/verifier.test.ts` if verifier prompt text is asserted there
- specs only if public behavior text changes:
  - `specs/projects/codegenie/functional_spec.md`
  - `specs/projects/codegenie/components/review_pipeline.md`

## Out of Scope

- `src/pipeline/planner.ts`
- `src/pipeline/packet-builder.ts`, unless a test helper needs to construct packets with related context
- `src/pipeline/verifier.ts`, unless existing verifier tests need fixture updates
- Stage 8 grouping logic
- Composer/publication logic
- Eval YAML changes

## Implementation Steps

### Step 1: Add the core skill invariant

Update `bundled-skills/core/code-review.md`:

- add the caller-visible guarantee check under `# Checks`;
- add the false-positive guard under `# False Positives`;
- add one generic example under `# Examples`.

Keep wording compact. The skill should remain a short checklist, not a handbook.

Verify:

```sh
pnpm exec vitest run tests/phase4-skills-provider.test.ts
```

Expected result: tests pass.

### Step 2: Add the Stage 7 and Stage 9 prompt nudges

Update the Stage 7 prompt in `src/skills/prompt-builder.ts` near the existing lossy-conversion sentence. Update the Stage 9 verifier prompt near the existing promoted-predicate and intent-framing guidance.

Bump `PROMPT_TEMPLATE_VERSIONS[7]` from `p7.8` to `p7.9`.
Bump `PROMPT_TEMPLATE_VERSIONS[9]` from `p9.4` to `p9.5`.

Add or update prompt-builder tests if existing tests assert prompt text. The Stage 7 prompt test should assert the prompt contains:

- `caller-visible`
- `deliverable` or `satisfiable`
- `internally consistent`

The Stage 9 prompt test should assert the prompt contains:

- `promoted lossy-transform` or equivalent wording
- `caller-visible`
- `transformed value` and `original source value`

Do not assert a long exact prompt string.

Verify:

```sh
pnpm exec vitest run tests/pipeline-phase7.test.ts
pnpm exec vitest run tests/verifier.test.ts
```

Expected result: tests pass.

### Step 3: Carry matching related context into promoted evidence

Update `relatedEvidence(source)` in `src/pipeline/uncertainty-promotion.ts`.

Suggested shape:

```ts
function relatedContextEvidence(source: PromotionSource): RelatedCodeEvidence[] {
  const referencedFiles = new Set(source.files.map(normalizePath));
  const referencedSymbols = new Set(source.symbols.map(normalize));
  const predicateText = normalize([source.question, source.reason].join(" "));

  return source.packet.relatedChangedContext
    .filter((context) => relatedContextMatches(context, referencedFiles, referencedSymbols, predicateText))
    .map(toRelatedCodeEvidence)
    .filter(dedupe)
    .slice(0, MAX_RELATED_CONTEXT_EVIDENCE);
}
```

The actual helper names can differ. Keep helpers small and deterministic.

Matching should be structural:

- path match;
- target/source hunk path match;
- symbol name match;
- predicate text contains the symbol.

Avoid semantic keyword matching. Do not look for `minimum`, `round`, `quote`, `amount`, etc. That would reintroduce eval-specific behavior.

Verify:

```sh
pnpm exec vitest run tests/uncertainty-promotion.test.ts
```

Expected result: tests pass.

### Step 4: Add tests for evidence handoff

Add tests in `tests/uncertainty-promotion.test.ts` or the nearest existing promotion test file.

Required cases:

1. A follow-up hint references a symbol that exists in `packet.relatedChangedContext`; the promoted candidate includes that related context in `evidence.relatedCode`.
2. A hint that names only the packet's own path and no related symbol does not pull unrelated related context.
3. Related-context evidence is capped and deduped.
4. Existing explicit `source.files` related evidence still works.
5. A packet without the decisive second-hop context does not invent or chase that context.

The fixtures should be language-neutral. Use symbols like `transformValue`, `publishResult`, `caller`, and paths like `src/producer.ts` / `src/consumer.ts` rather than trails-api names.

Verify:

```sh
pnpm exec vitest run tests/uncertainty-promotion.test.ts
```

Expected result: new and existing tests pass.

### Step 5: Add telemetry

Extend the uncertainty-promotion summary artifact or decisions with compact fields such as:

```ts
relatedContextEvidenceCount?: number;
relatedContextEvidenceMatchReasons?: string[];
```

Keep this diagnostic only. Do not let telemetry shape behavior.

Verify:

```sh
pnpm exec vitest run tests/uncertainty-promotion.test.ts
pnpm run typecheck
```

Expected result: tests and typecheck pass.

### Step 6: Update docs only if needed

If public docs describe promotion evidence, update the relevant spec to say:

```text
Promoted follow-up hints and uncertainties may carry bounded related changed context from their source packet into verification when that context matches referenced files or symbols.
```

Do not add user-facing terminology for a new invariant category.

Verify:

```sh
pnpm run typecheck
```

Expected result: exits 0.

## Validation

Automated checks:

```sh
pnpm exec vitest run tests/uncertainty-promotion.test.ts
pnpm exec vitest run tests/pipeline-phase7.test.ts
pnpm exec vitest run tests/verifier.test.ts
pnpm exec vitest run tests/phase4-skills-provider.test.ts
pnpm run typecheck
pnpm test
pnpm run build
```

Expected result: all commands exit 0.

Eval checks after implementation:

```sh
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/49f4645b --no-cache
pnpm run dev eval --eval-dir /home/peter/Dev/0xPolygon/codegenie-private-evals/trails-api/0c4d5213 --no-cache
```

Expected diagnostic improvements:

- In `49f4645b`, Stage 7 no-finding or hint reasoning should explicitly consider deliverability/satisfiability of caller-visible outputs after transformation, not only internal consistency.
- In `49f4645b`, Stage 9 should reject or keep based on whether the caller-visible guarantee is derived from the transformed value or the original source value, not merely because the precision loss is bounded or documented.
- If directly attached related context matches a promoted hint's referenced files/symbols, the promoted candidate should include that context in `evidence.relatedCode`. If the decisive context is not directly attached to the source packet, this plan should not fabricate it.
- `0c4d5213` should not gain should-not-find violations or broad lossy-conversion false positives.
- Plan success does not require forcing the finding to publish. A strict verifier may still reject if it proves the caller-visible promise remains satisfiable or immaterial. The important improvement is that it adjudicates the right predicate with the right evidence.

## Done Criteria

- The core bundled skill includes the caller-visible guarantee invariant and false-positive guard.
- Stage 7 prompt includes one compact deliverable/satisfiable-output nudge and template version is bumped.
- Stage 9 prompt includes one compact promoted lossy-transform/materiality nudge and template version is bumped.
- Promotion carries matching directly attached packet `relatedChangedContext` into `CandidateFinding.evidence.relatedCode`.
- Promotion evidence carry-through is capped and deduped.
- Tests cover matched, unmatched, capped, explicit-file, and no-multi-hop related evidence cases.
- `pnpm run typecheck`, `pnpm test`, and `pnpm run build` pass.
- `plans/README.md` status row is updated.

## Stop Conditions

Stop and report back if:

- Implementing evidence carry-through requires running repository tools during promotion.
- The clean implementation needs a semantic keyword taxonomy to decide which related context to include.
- The Stage 7 or Stage 9 prompt change grows beyond one compact generic rule each.
- Tests show broad unrelated related context being attached to promoted candidates.
- The verifier starts keeping weak promoted candidates only because they gained extra context, without concrete changed-line evidence.

## Maintenance Notes

This plan is intentionally a small correction to review reasoning and evidence preservation. Future additions should remain in one of two lanes:

- reusable review guidance belongs in bundled skills;
- already-attached packet evidence belongs in promotion/verifier handoff.

Do not grow a central invariant catalog unless multiple languages/repos show that skill-based guidance is insufficient. If this plan improves `49f4645b` but creates false positives on `0c4d5213`, first inspect whether the Stage 9 materiality wording is too strong. Prefer softening prompt wording over weakening verifier evidence requirements.
