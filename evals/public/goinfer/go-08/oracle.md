---
repo: goinfer
case: go-08
role: positive
intro: 7c410a55b8996ccd5383cd2e3093c33183db0f63
base: b1881f53d5e8fba4e3e67eaa8aa0b2a34c52def1
introDate: 2026-06-14
fix: 2c18f3b35d7efbdd559b1fcf4ece1d6df0e256e8
kind: error-handling/http-contract
severity: medium
---

## Expected finding

The new Qwen2.5-VL branch of `driveVL` discards the `Generation` returned by `GenerateQwenVL`, retaining just the token channel. When prefill or decode records a terminal error and closes that channel, the caller treats it as a clean end and emits HTTP 200 or a normal SSE finish instead of reporting the failure.

## Anchor

`cmd/serve/openai.go:535-544` at [the introducing commit](https://github.com/townsendmerino/goinfer/commit/7c410a55b8996ccd5383cd2e3093c33183db0f63).

## Severity floor

Medium.

## Fixing evidence

The fix retains the generation handle, reads its terminal error after the stream closes, and propagates it to HTTP and SSE responders. `TestGenErr` pins the difference between a failed backend and deliberate cancellation. The label covers the new Qwen path. [Fixing commit](https://github.com/townsendmerino/goinfer/commit/2c18f3b35d7efbdd559b1fcf4ece1d6df0e256e8)
