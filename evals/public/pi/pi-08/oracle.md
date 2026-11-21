---
repo: pi
case: pi-08
role: positive
intro: 3595e080cb013232c4141cab9976eebcdddcc417
base: bb437b097bf31f32608580d2f3d09d994533751c
introDate: 2026-07-20
fix: a77207d9ceaf47aeb270d293b6ebc75e3e3ed6b3
kind: logic
severity: medium
contaminationSplit: pre-2026-08-01
---

# pi pi-08

Review base `bb437b097bf31f32608580d2f3d09d994533751c` (the parent) against head `3595e080cb013232c4141cab9976eebcdddcc417`.

## Expectation `paste-marker-undefined-suffix`

### Expected finding

The renumbering callback builds the new marker as `[paste #N` followed by the second capture group. That group is optional in `PASTE_MARKER_REGEX` (line 22), so for a marker without a size suffix it is `undefined` and the marker becomes `[paste #1undefined]`. That text no longer matches a registered paste, so it is submitted literally instead of the pasted content.

### Anchor

packages/tui/src/components/editor.ts:1308

### Severity floor

The matcher floor is low. Expected severity is medium; record it as a calibration note, not as a miss.

### Fixing evidence

a77207d9c uses `suffixGroup ?? ''` and adds the test "renumbers short paste markers without a size suffix".

