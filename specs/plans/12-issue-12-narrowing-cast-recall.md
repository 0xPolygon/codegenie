# Issue 12: Lossy Conversion Recall

Status: COMPLETE

## Problem

Reviewers can notice a concrete lossy-conversion risk but leave it as an unresolved follow-up instead of producing a candidate finding. The general bug class is:

- A raw external value is converted or coerced into a narrower or lossy representation.
- A previous raw-value validation guard was removed or moved after the conversion.
- The new downstream validation checks the already-converted value, which may be too late because overflow, truncation, rounding, precision loss, or coercion already happened.

This is a recall problem: when changed-line evidence and a deterministic failure mode exist, the packet reviewer should emit a candidate finding and let Stage 9 verify it. It should not remain only as "ask a human" text.

Scope note: implement this as a generic review signal class with language-specific adapters. Do not hard-code one repository, one project, one exact function name, or one exact variable name. The first implementation can be a small Go adapter because Go narrowing casts are syntactically reliable to detect with the current tree-sitter-backed static signal path, but the rule name, prompt guidance, tests, and data model should stay language-neutral.

Do not add automatic finding promotion, a new LLM pass, broad dataflow analysis, or eval-only telemetry in this plan. If later evals still show repeated misses after this signal reaches packets, add a separate follow-up for recall-miss telemetry or eval-specific scoring.

## Plan

1. Add a generic lossy-conversion static signal:
   - Use a language-neutral rule id such as `correctness/lossy-conversion-before-validation`.
   - Signal when a changed line appears to convert or coerce a non-literal value into a narrower or lossy representation.
   - Prefer evidence that the same hunk or nearby deleted lines changed a validation guard. Use simple validation-ish terms/operators such as `validate`, `check`, `range`, `bound`, `min`, `max`, `overflow`, `<`, `>`, `<=`, `>=`.
   - Keep this syntactic and conservative. Do not try to solve full type/dataflow.
   - Keep this as a signal, not an automatic finding.
   - Include the changed line, nearby deleted guard if available, and a short explanation.

2. Implement the first small language adapter:
   - Start with Go narrowing casts such as `uint8(...)`, `uint16(...)`, `int8(...)`, `int16(...)`, and `int32(...)`.
   - Only signal when the cast argument is not an obvious literal.
   - Do not add broad language coverage until each language has a reliable, low-noise pattern.

3. Improve reviewer guidance:
   - Add language-neutral guidance to the core correctness/review prompt:
     - "Validate raw external values before lossy conversion; helper validation after conversion may be too late."
   - Add Go-specific examples in the Go lens only where useful.
   - Add false-positive guidance:
     - If the source type is already bounded or generated enum-like data, do not publish.
     - If the source is provider/API JSON, decoded payloads, database data, config, or untrusted metadata, treat as candidate-worthy when changed code moved validation after conversion.
   - Tell packet reviewers:
     - Do not leave concrete deterministic failure modes as follow-up hints when changed-line evidence exists.
     - Emit a medium-confidence candidate and let Stage 9 verify it.

4. Keep follow-up handling simple:
   - Do not automatically publish or promote follow-up hints.
   - Do not add `candidate_recall_missed_signal` telemetry in this plan.
   - Static signals are prompt hints only. Stage 7 must still produce a candidate finding for Stage 9 to verify it.

5. Add focused tests:
   - Use a small synthetic fixture where a raw value was validated before a conversion and is now converted first.
   - Assert the static signal is produced.
   - Assert obvious literal conversions do not produce the signal.
   - Assert the review packet/prompt receives the signal.
   - Do not add a full live LLM eval in this plan.

## Likely Files

- `bundled-skills/lang/go.md`
- `src/repo/static-signals.ts`
- `tests/repository-intelligence.test.ts`
- `tests/pipeline-phase5.test.ts` or packet-builder focused test file

## Tests

- Go adapter static-signal test for `uint8(externalDecimals)` after deleted raw validation.
- Packet-review fake-runner test proving a supported lossy-conversion signal is present in the packet/reviewer prompt.
- Negative test for literal/bounded casts such as `uint8(18)`.
- Negative test for a cast line without nearby validation-change evidence.

## Acceptance Criteria

- A generic raw-value lossy-conversion-after-validation-removal issue is emitted as a static signal in deterministic tests.
- The signal is present in the review packet/prompt that Stage 7 sees.
- The change improves a generic class of lossy-conversion review bugs, not one hard-coded case.
- False positives remain controlled by conservative signal conditions and verifier review of any model-produced candidate.
