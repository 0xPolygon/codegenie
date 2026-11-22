---
repo: pi
case: pi-14
role: positive
intro: 3a7bb6f48cc64986608ffa1b0cb52c3ff938ef2a
base: 43fb4e3106d5c5474ada9e3b2ac2162a7638be97
introDate: 2026-11-04
contaminationSplit: post-2026-08-01
fix: ef9361ab70206e521a46fa7b3d1068442eec4908
kind: failure-path
severity: medium
pr: 11750
---

# pi pi-14

Review [43fb4e3106d5](https://github.com/earendil-works/pi/commit/43fb4e3106d5c5474ada9e3b2ac2162a7638be97) against its child [3a7bb6f48cc6](https://github.com/earendil-works/pi/commit/3a7bb6f48cc64986608ffa1b0cb52c3ff938ef2a).

## Expected finding for read-abort-emits-unhandled-stream-error

An abort while the local file is being opened or statted can leave an already-aborted signal on the stream constructor. The stream can emit an error before its iterator is listening for errors. The read promise can reject normally and the process can still crash from the separate unhandled stream error.

## Why the diff introduces it

The previous default reads a buffer through readFile. The streaming replacement opens and stats a handle before creating an abort-driven ReadStream. Its finally block closes the handle but does not cover the error-listener gap.

## Anchors

[packages/coding-agent/src/core/tools/read.ts:75–83](https://github.com/earendil-works/pi/blob/3a7bb6f48cc64986608ffa1b0cb52c3ff938ef2a/packages/coding-agent/src/core/tools/read.ts#L75-L83).

## Severity floor

The prefilter uses low. Expected severity is medium. Adjudicate severity independently of detection.

## Fixing evidence

The fix checks cancellation during stream consumption and closes the handle without passing the abort signal to the stream constructor. The upstream regression aborts during fs.open and checks that the read rejects without an unhandled stream error. [Fixing commit](https://github.com/earendil-works/pi/commit/ef9361ab70206e521a46fa7b3d1068442eec4908)
