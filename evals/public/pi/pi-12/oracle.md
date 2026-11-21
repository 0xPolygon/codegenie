---
repo: pi
case: pi-12
role: positive
intro: 4f81c3c28db28c089c5571aab68a8624ae99abd6
base: 1a4d153d7af76a636d67567d30ba705b1320a06d
introDate: 2026-03-14
fix: 612a172e6e398f6e514bf0c5d153677c94a53400
kind: escaping
severity: low
contaminationSplit: pre-2026-08-01
---

# pi pi-12

Review base `1a4d153d7af76a636d67567d30ba705b1320a06d` (the parent) against head `4f81c3c28db28c089c5571aab68a8624ae99abd6`.

## Expectation `single-segment-fd-query-unescaped`

### Expected finding

`buildFdPathQuery` escapes regex metacharacters in each segment of a query that contains `/`, but returns a query without `/` unchanged. The result is passed to fd as a regular expression (line 151), so a single-segment query containing characters such as `(`, `[`, `+` or `.` matches the wrong files or makes fd fail with a regex error.

### Anchor

packages/tui/src/autocomplete.ts:19-21 (the same raw return at 34-36). Do not credit findings about Windows path separators or about the trailing-separator branch.

### Severity floor

The matcher floor is low. Expected severity is low; record it as a calibration note, not as a miss.

### Fixing evidence

612a172e6 returns `escapeRegex(normalized)` for the single-segment case and adds tests.
