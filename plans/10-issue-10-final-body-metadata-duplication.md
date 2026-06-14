# Issue 10: Final Body Metadata Duplication

## Problem

The latest final Markdown no longer repeats `Failure mode`, `Why it matters`, and `Suggested fix` blocks, but composed finding bodies still repeat title and metadata already owned by the renderer:

- The renderer prints `### SEVERITY: title`.
- The renderer prints `File: ...` and `Confidence: ...`.
- The LLM-composed `finalBody` then often starts with the same title and a `Severity / Confidence / Category` line.

This is not a correctness bug, but it makes otherwise strong findings feel machine-generated and less polished.

## Plan

1. Define ownership clearly:
   - Renderer owns:
     - heading/title
     - file/line
     - severity
     - confidence
   - Final body owns:
     - concrete failure mode
     - impact
     - evidence
     - suggested fix/test.

2. Update composer instructions:
   - Prompt the LLM composer to not include:
     - Markdown title headings
     - severity/confidence/category metadata lines
     - repeated file/line metadata.
   - Ask it to start with the concrete issue sentence.

3. Add deterministic body cleanup:
   - Add a small `normalizeFinalBodyForRendering` step before final findings are rendered or persisted.
   - Strip only obvious redundant prefixes:
     - first line matching the finding title
     - first heading matching the finding title
     - metadata lines matching `Severity:`, `Confidence:`, `Category:`, or `Severity: ... · Confidence: ...`.
   - Do not strip body text that differs materially from the finding title.

4. Keep fallback body format concise:
   - Confirm deterministic fallback bodies still do not add title/severity metadata.
   - Keep fallback body structured around impact/evidence/fix.

5. Preserve GitHub comment quality:
   - The same cleaned `finalBody` should be used for stdout Markdown and GitHub comments.
   - Avoid making inline comments lose useful context; only remove redundant metadata.

## Likely Files

- `src/pipeline/composer.ts`
- `src/output/markdown-renderer.ts`
- `src/skills/prompt-builder.ts`
- `tests/pipeline-phase5.test.ts`

## Tests

- Semantic composer output with duplicate title/metadata is cleaned before rendering.
- A body whose first sentence happens to contain title terms but is not an exact duplicate is preserved.
- Deterministic fallback output still renders cleanly.
- GitHub final finding body uses the cleaned version.
- Markdown snapshot has one title and one confidence line per finding.

## Acceptance Criteria

- Final findings no longer start with duplicated titles or `Severity / Confidence / Category` metadata.
- No useful failure-mode/evidence/fix text is stripped.
- The final review reads like a polished staff review, not a nested report inside a report.
