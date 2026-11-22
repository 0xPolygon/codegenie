---
repo: pi
case: pi-08
role: positive
intro: 8a2ce5a54024be2eb2b879288212141741afa65e
base: 2b00dade7cec918aefb025c8b7a4fa304a30acdd
introDate: 2026-07-07
fix: a77207d9ceaf47aeb270d293b6ebc75e3e3ed6b3
kind: logic
severity: medium
contaminationSplit: pre-2026-08-01
---

# pi pi-08

Review base `2b00dade7cec918aefb025c8b7a4fa304a30acdd` (the parent) against head `8a2ce5a54024be2eb2b879288212141741afa65e`.

## Expectation `paste-marker-undefined-suffix`

### Expected finding

Backspace at base leaves later paste markers intact. The head adds a renumbering callback that appends the optional second capture group to every renumbered marker. For a short marker such as `[paste #2]`, the suffix is `undefined`, so deleting the preceding marker rewrites it to `[paste #1undefined]`. The malformed text no longer matches the paste-marker pattern and reaches submission literally.

### Anchor

`packages/tui/src/components/editor.ts:1294`, in the newly added callback at lines 1287–1298.

### Severity floor

The matcher floor is low. Expected severity is medium; record it as a calibration note, not as a miss.

### Fixing evidence

`a77207d9c` uses `suffixGroup ?? ""` in the descendant callback and adds the test "renumbers short paste markers without a size suffix".
