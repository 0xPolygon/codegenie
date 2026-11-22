---
repo: pi
case: pi-12
role: positive
intro: a61eca5dee7f13a31c07fd20f7517aaa572b7ade
base: 754e745b1fbd268f3c287fd0b5779992d900ee7a
introDate: 2025-11-28
fix: 612a172e6e398f6e514bf0c5d153677c94a53400
kind: escaping
severity: low
contaminationSplit: pre-2026-08-01
---

# pi pi-12

Review base `754e745b1fbd268f3c287fd0b5779992d900ee7a` (the parent) against head `a61eca5dee7f13a31c07fd20f7517aaa572b7ade`.

## Expectation `single-segment-fd-query-unescaped`

### Expected finding

The base searches filenames by literal substring. On a system with fd available, the new autocomplete path passes the typed query as a raw regex. Typing `@notes[` for a file named `notes[.ts` now sends an invalid pattern. fd exits with an error and autocomplete returns no suggestions, even though the filename matches the literal query.

### Anchor

`packages/tui/src/autocomplete.ts:17` (`args.push(query)` in `walkDirectoryWithFd`). Lines 26–27 turn the fd error into an empty result.

### Severity floor

The matcher floor is low. Expected severity is low; record it as a calibration note, not as a miss.

### Fixing evidence

`612a172e6` makes the descendant fd query builder escape single-segment input and adds tests. The raw regex path was introduced into this parent/child pair when the literal Node walk was replaced.
