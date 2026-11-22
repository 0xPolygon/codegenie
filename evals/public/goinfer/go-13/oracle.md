---
repo: goinfer
case: go-13
role: positive
intro: a1640a6aa0dc1b7d05ec4165b7af38a1a2b8f39b
base: 49d849de42ed328272bba422c6d178fd1906a193
introDate: 2026-09-16
fix: b47b145ea5929ffb2c610c1adf2b8c639f293e98
kind: resource-ownership
severity: medium
---

# goinfer go-13

Review [49d849de42ed](https://github.com/townsendmerino/goinfer/commit/49d849de42ed328272bba422c6d178fd1906a193) against its child [a1640a6aa0dc](https://github.com/townsendmerino/goinfer/commit/a1640a6aa0dc1b7d05ec4165b7af38a1a2b8f39b).

## Expected finding for metal-batch-growth-abandons-buffers

Growing a Metal resident's batch capacity overwrites batchX and batchLogits with newly allocated buffers. The former buffers remain leased even though the resident has discarded their handles. Capacity growth can keep old GPU allocations alive until the resident closes.

## Why the diff introduces it

The parent has no dynamic ensureBatchCap allocation path. The change allocates an initial capacity during resident setup and calls the same helper when a later batch is larger. The branch reallocates the two row buffers without returning their old allocations.

## Anchors

[metal/model.go:1255–1269](https://github.com/townsendmerino/goinfer/blob/a1640a6aa0dc1b7d05ec4165b7af38a1a2b8f39b/metal/model.go#L1255-L1269).

## Severity floor

The prefilter uses low. Expected severity is medium. Adjudicate severity independently of detection.

## Fixing evidence

After the backend move, the fix releases the existing row buffers at growth once the executor is stopped. TestMetalScratch_batchGrowthGivesBackTheOld checks that growing no longer keeps both old row allocations charged. The same fix includes unrelated prefill scratch changes. [Fixing commit](https://github.com/townsendmerino/goinfer/commit/b47b145ea5929ffb2c610c1adf2b8c639f293e98)
