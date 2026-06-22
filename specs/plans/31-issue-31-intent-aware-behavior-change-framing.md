# Issue 31: Intent-Aware Behavior-Change Framing

Status: COMPLETE
Planned from: trails-api eval run 5 review, 2026-06-15
Planned at: commit `db41ed7`

## Problem

Run 5 correctly found the routing explicit-preference behavior change, but the final wording was too confident about intent. It said the change contradicted behavior-preserving intent, while the commit history also included an explicit signal:

`refactor: enhance preference handling in SolveQuoteRoutingWithFallbacks`

and body text indicating strict handling of explicit route preferences.

Codegenie should still flag risky behavior changes inside refactors, especially when callers may break. But it should distinguish:

- accidental semantic regression in a claimed refactor
- intentional behavior change that needs documentation/caller confirmation
- behavior change explicitly specified by PR/task context and therefore not a finding

This is a general code-review quality issue, not a trails-api-specific rule.

## Current State

- `src/pipeline/planner.ts` collects commit titles/bodies into the planner dossier.
- `src/pipeline/packet-builder.ts:285-289` builds packet `intentText` from PR title/body or commit body.
- `src/skills/prompt-builder.ts:152` already tells the verifier that same-PR tests do not automatically prove a behavior change is safe.
- `src/pipeline/composer.ts:241` passes declared intent and inferred behavior to the composer prompt.
- Final findings currently have no structured intent assessment, so the composer can overstate accidental-regression framing even when commit text suggests deliberate behavior.

## Plan

1. Add structured intent signals to planning output.
   - Derive lightweight deterministic intent flags from PR title/body and commit titles/bodies:
     - `refactorLike`: refactor, cleanup, consolidate, deduplicate, simplify
     - `behaviorChangeLike`: change behavior, strict, fail, reject, enforce, allow, disallow, fallback, preserve
     - `explicitlyBehaviorPreserving`: behavior-preserving, no behavior change, equivalence, preserve behavior
   - Keep this deterministic and transparent; do not add another LLM pass.
   - Store the raw snippets or short reasons in telemetry for debugging.

2. Pass intent signals through review and verification.
   - Add optional `intentSignals` or equivalent to packet/review context.
   - Include concise intent signals in packet reviewer and verifier prompts.
   - Tell reviewers to flag behavior changes with precise framing:
     - accidental regression when behavior-preserving signals dominate and no explicit behavior-change signal exists
     - contract change requiring confirmation when both refactor and behavior-change signals exist
     - reject when task/PR/spec explicitly requires the new behavior and caller impact is already covered

3. Add an intent assessment to candidates or verifier verdicts.
   - Add optional structured fields such as:
     - `behaviorChange: "accidental_regression" | "intentional_needs_confirmation" | "specified_change" | "unknown"`
     - `intentEvidence: string[]`
   - Do not require every candidate to fill these fields.
   - Use them mainly for correctness/architecture findings that compare base vs head behavior.

4. Update composer guidance.
   - Composer should not write "accidentally", "silently", or "contradicts intent" unless verifier/candidate evidence supports accidental-regression framing.
   - If intent is mixed, final text should say "This changes the contract..." or "If strict behavior is intended, document/confirm callers..." rather than assuming a bug.
   - Keep the finding actionable: impact, affected callers, and suggested test/doc still matter.

5. Add tests.
   - Refactor-only title plus behavior-changing diff leads to accidental-regression framing.
   - Refactor title plus commit body saying strict/fail behavior leads to "contract change requiring confirmation" framing.
   - Explicit task/spec saying the behavior must change leads verifier/composer to reject accidental-regression framing unless other risk remains.
   - Same-PR tests remain evidence of behavior change, but not automatic rejection.
   - Composer output avoids unsupported "accidental" wording when intent signals are mixed.

## Likely Files

- `src/pipeline/planner.ts`
- `src/pipeline/packet-builder.ts`
- `src/pipeline/verifier.ts`
- `src/pipeline/composer.ts`
- `src/skills/prompt-builder.ts`
- `src/types.ts`
- `tests/pipeline-phase5.test.ts`
- `tests/verifier.test.ts`
- `tests/phase4-llm.test.ts`

## Acceptance Criteria

- Codegenie distinguishes accidental regressions from intentional-but-risky behavior changes.
- Mixed intent signals produce cautious, precise final wording instead of overclaiming.
- Same-PR tests still do not automatically suppress material behavior changes.
- Structured artifacts expose the intent signals used for framing.
- The solution uses generic intent keywords and source context, not project-specific rules.
