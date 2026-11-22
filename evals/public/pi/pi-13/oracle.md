---
repo: pi
case: pi-13
role: positive
intro: 8e53e0e49cf3ecec20c840c4cb03e692e96c50f1
base: 890b3547af230d1ad75a4ec2a8989387fae2bd2b
introDate: 2026-07-21
contaminationSplit: pre-2026-08-01
fix: 51ba3ab5b98ec93b4cc8f97335a2fe38698e1ec7
kind: resource-ownership
severity: low
---

# pi pi-13

Review [890b3547af23](https://github.com/earendil-works/pi/commit/890b3547af230d1ad75a4ec2a8989387fae2bd2b) against its child [8e53e0e49cf3](https://github.com/earendil-works/pi/commit/8e53e0e49cf3ecec20c840c4cb03e692e96c50f1).

## Expected finding for retry-backoff-retains-abort-listener

A completed retry backoff leaves its abort listener attached to the caller's signal. The timer resolves the promise directly, while the one-shot listener only removes itself when the signal aborts. Reusing a signal across successful retry sequences retains one closure per completed backoff for the lifetime of the signal.

## Why the diff introduces it

The parent lacks the shared assistant retry helper and its abort-aware sleep. This change routes compaction and branch summarization through that helper. The timer's success path and the listener registration are introduced together.

## Anchors

[packages/ai/src/utils/retry.ts:124–132](https://github.com/earendil-works/pi/blob/8e53e0e49cf3ecec20c840c4cb03e692e96c50f1/packages/ai/src/utils/retry.ts#L124-L132).

## Severity floor

The prefilter uses low. Expected severity is low. Adjudicate severity independently of detection.

## Fixing evidence

The fix removes the listener when the timer resolves and still clears the timer on abort. The upstream retry test runs through successful retries and asserts that the signal has zero remaining abort listeners. [Fixing commit](https://github.com/earendil-works/pi/commit/51ba3ab5b98ec93b4cc8f97335a2fe38698e1ec7)
