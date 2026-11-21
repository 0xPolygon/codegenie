---
repo: codegenie
case: cg-10
role: positive
intro: 80df9e6c6869035cb0cf1c6b2dfba75debf3edd6
base: a8b1d998cb10b65de26e05dbc001b7079df5ff42
introDate: 2026-11-19
fix: edd3ec2734e6fa093eb480a9a0d4f0c41aad7855, 747cd0613af28d11aaa7b41f76cf0c7cd3f91f73
kind: error-handling
severity: low
pr: 89
---

# codegenie cg-10

Review base `a8b1d998cb10b65de26e05dbc001b7079df5ff42` (the parent) against head `80df9e6c6869035cb0cf1c6b2dfba75debf3edd6`. The head exists only on `refs/pull/89/head` because the PR was squash-merged; fetch it by SHA.

## Expectation `write-failure-loses-verified-output`

### Expected finding

A fatal, non-recoverable composer rejection followed by a failure to write a final artifact loses the already verified findings. The composer still runs deterministic fallback steps and awaits artifact writes before rethrowing. If a write throws, that error replaces the composer error, the retained review is never registered, and the failure report carries no verified findings.

### Anchor

src/pipeline/composer.ts:396-406 (deferred rethrow after artifact writes) and the review-runner failure path that looks up the retained review by the caught error

### Severity floor

The matcher floor is low. Expected severity is low; record it as a calibration note, not as a miss.

### Fixing evidence

edd3ec2 keeps the retained review when an artifact write fails after composition. Its regression test, a composer error plus a write failure, expects the write error together with the retained finding, and fails at the intro. This is the public TypeScript case used in #112 and #128.

## Expectation `primitive-composer-rejection`

### Expected finding

The Stage 10 failure handoff uses `compositionFailure !== undefined` as its presence check and stores the retained review only for object errors. A composer that rejects with `undefined` is treated as success, so the run silently completes on the deterministic fallback. A string or null rejection is rethrown without the retained review, so the failure report still drops the verified findings.

### Anchor

src/pipeline/composer.ts:402-406

### Severity floor

The matcher floor is low. Expected severity is low; record it as a calibration note, not as a miss.

### Fixing evidence

747cd06 adds an explicit failure flag and wraps primitive rejections in an Error that carries the retained review. Its regression test covers undefined, string and null rejections.

