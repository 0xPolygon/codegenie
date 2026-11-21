---
repo: pi
case: pi-09
role: positive
intro: c48f656f88697b23c65cce1e658893eda02c4c12
base: 2fbdff9dab1a1652aa9f97e9508b90b4ae44a7ce
introDate: 2026-06-14
fix: 080932e53cb6f82076b111efc424845e4d5c1902
kind: logic
severity: medium
contaminationSplit: pre-2026-08-01
---

# pi pi-09

Review base `2fbdff9dab1a1652aa9f97e9508b90b4ae44a7ce` (the parent) against head `c48f656f88697b23c65cce1e658893eda02c4c12`.

## Expectation `update-check-uses-inequality`

### Expected finding

`shouldUpdateNpmSource` and `npmHasAvailableUpdate` both decide that an update exists with `targetVersion !== installedVersion`. When the installed version is newer than the version the registry or range resolves to (installed 2.0.0, registry 1.9.0), this still reports an update, and the update then installs the older version. The comparison must be "target is greater than installed".

### Anchor

packages/coding-agent/src/core/package-manager.ts:1128 (shouldUpdateNpmSource); the same defect is at line 1446 (npmHasAvailableUpdate, optional expectation). A hit on either counts as the detection.

### Severity floor

The matcher floor is low. Expected severity is medium; record it as a calibration note, not as a miss.

### Fixing evidence

080932e53 replaces both comparisons with semver `gt` and adds two tests named "... when the installed version is newer than the registry version".

## Expectation `update-check-uses-inequality-second-site` (optional)

### Expected finding

The same inequality defect in `npmHasAvailableUpdate`. Count a hit here as the same detection after adjudication.

### Anchor

packages/coding-agent/src/core/package-manager.ts:1446

### Severity floor

The matcher floor is low. Expected severity is medium; record it as a calibration note, not as a miss.

### Fixing evidence

Same fix as the required expectation.
