---
repo: codegenie
case: cg-n5
role: negative-control
intro: 99bc6185b1c7bbcfcc1c91f3575faa6be53c8232
base: 466786a2cfc644c608bffb12026c889d8c27f833
introDate: 2026-11-21
kind: control/presentation-only
severity: medium
pr: 195
---

# codegenie cg-n5

Review [466786a2cfc6](https://github.com/0xPolygon/codegenie/commit/466786a2cfc644c608bffb12026c889d8c27f833) against its child [99bc6185b1c7](https://github.com/0xPolygon/codegenie/commit/99bc6185b1c7bbcfcc1c91f3575faa6be53c8232).

## Control rationale

The approved feature changes reader order to severity and then file and line. Selection records and caps are computed first. Each already selected list is copied and sorted without changing a finding, its severity, anchor or publication kind. Existing comparison and cap code still consumes its original order. Rendering adds an explanatory note at the first applicable list, and the deterministic tests check ordering and selection separately.

## Anchors

[src/pipeline/composer.ts:267–271](https://github.com/0xPolygon/codegenie/blob/99bc6185b1c7bbcfcc1c91f3575faa6be53c8232/src/pipeline/composer.ts#L267-L271), [src/util/markdown.ts:82–100](https://github.com/0xPolygon/codegenie/blob/99bc6185b1c7bbcfcc1c91f3575faa6be53c8232/src/util/markdown.ts#L82-L100).

Medium-or-higher reports in these spans are leads for source adjudication.
