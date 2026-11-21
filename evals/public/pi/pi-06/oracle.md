---
repo: pi
case: pi-06
role: positive
intro: d7951ec3624fa3c8fed15426292de905cf496e3d
base: b7f788194971a2397526f17aa836881d77394df5
introDate: 2026-09-20
fix: 36af9dc48e69a3fe36c2e588a5696864d2c37fd2
kind: logic
severity: low
contaminationSplit: post-2026-08-01
---

# pi pi-06

Review base `b7f788194971a2397526f17aa836881d77394df5` (the parent) against head `d7951ec3624fa3c8fed15426292de905cf496e3d`.

## Expectation `skill-prefix-no-longer-lists-skills`

### Expected finding

For commands named `skill:<name>`, the filter now matches the typed prefix against the bare name only, unless the prefix already starts with `skill:`. A user who types the start of the word "skill" (for example "sk", or "skill" without the colon) no longer gets the skill commands listed, because bare names such as `research-idea` do not match. Matching on the full name must remain as a fallback.

### Anchor

packages/tui/src/autocomplete.ts:335-339

### Severity floor

The matcher floor is low. Expected severity is low; record it as a calibration note, not as a miss.

### Fixing evidence

36af9dc48 adds a second pass on the full name and the test "lists skills while typing the skill prefix" (regression test for #9944).

