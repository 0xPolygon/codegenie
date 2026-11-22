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

## Expectation `ranged-npm-update-allows-downgrade`

### Expected finding

At base, a version-qualified source such as `npm:example@^1.0.0` is pinned and skipped by both update paths. The head treats non-exact ranges as update-eligible. With `1.8.0` already installed and `1.7.0` the highest registry version satisfying the range, `targetVersion !== installedVersion` now advertises an update and queues another install even though the installed version satisfies the range and the target is older. The ordinary unpinned case already uses inequality at base. Credit the newly reachable ranged-source behavior.

### Anchor

`packages/coding-agent/src/core/package-manager.ts:1127–1128` (`shouldUpdateNpmSource`). The update eligibility change is at lines 1408–1409. The optional `npmHasAvailableUpdate` anchor is an alternate location for the same defect.

### Severity floor

The matcher floor is low. Expected severity is medium; record it as a calibration note, not as a miss.

### Fixing evidence

`080932e53` replaces both shared comparisons with semver `gt`. This also rejects the older target on the ranged path. The added regression tests cover the same ordering rule using unpinned sources.

## Expectation `ranged-npm-update-allows-downgrade-second-site` (optional)

### Expected finding

`npmHasAvailableUpdate` advertises the older target for the newly update-eligible range for the same reason. Count a hit here as the same detection after adjudication.

### Anchor

`packages/coding-agent/src/core/package-manager.ts:1445–1446`.

### Severity floor

The matcher floor is low. Expected severity is medium; record it as a calibration note, not as a miss.

### Fixing evidence

Same fix as the required expectation.
