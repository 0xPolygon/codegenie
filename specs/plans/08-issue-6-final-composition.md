# Issue 6: Final Composition

Status: COMPLETE

## Problem

The fallback final review was rough:

- It repeated fields inside each finding.
- It listed noisy coverage reasons.
- It published two relay-decimals findings with the same root cause, one inline and one summary-only.
- The semantic composer was skipped due budget exhaustion, so deterministic fallback quality mattered and was not good enough.

Final output is the main user-facing product, so fallback composition must be professional even without an LLM composer.

## Plan

1. Improve deterministic dedupe:
   - Group by normalized root-cause fingerprint:
     - path
     - category
     - normalized title/failure-mode terms
     - related symbols
     - anchor hunk proximity.
   - Prefer changed-line anchored findings over summary-only duplicates.
   - Merge summary-only evidence into the anchored finding when useful.

2. Fix fallback rendering:
   - Do not print the same `Failure mode`, `Why it matters`, `Suggested fix`, and `Suggested test` twice.
   - Keep each finding concise:
     - title
     - file/line
     - confidence/severity
     - impact
     - evidence
     - suggested fix/test.
   - Summary-only findings should be clearly separated and not duplicate inline findings.

3. Clean coverage section:
   - Show concise partial-review summary.
   - Group unreviewed hunks by file.
   - Suppress non-actionable default/planner coverage reasons.
   - Include verification incomplete count and budget stop reason.

4. Make semantic composer budget-safe:
   - Composer should have a reserved final call when possible.
   - If budget is exhausted, fallback composer must still produce polished output.
   - Consider a smaller composer prompt mode using only final verified findings and coverage summary.

5. Add final-output snapshot tests:
   - Partial run.
   - Duplicate findings.
   - Summary-only finding.
   - Composer fallback.

## Tests

- Two relay-decimals findings merge into one final finding.
- Fallback Markdown contains no repeated failure-mode blocks.
- Coverage summary excludes `planner_missing_coverage` and groups budget-stopped hunks.
- Snapshot test for final-review.md in a partial-budget run.

## Acceptance Criteria

- Final fallback output is acceptable to paste into a PR without manual cleanup.
- Duplicate root causes are grouped even without LLM composition.
- Partial coverage is concise, honest, and actionable.
