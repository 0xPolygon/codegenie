---
created: 2026-11-19T20:26:49Z
author: architect-2
source: "0xPolygon/codegenie#44, owner-authorized Anthropic token-count checks"
status: provisional
---

# Anthropic rejects the default submit request on two current models

**Live confirmation on November 19, 2026.** Opus 5.5 and Fable 5.2 both rejected codegenie's named planner tool with HTTP 400. Both accepted an otherwise identical request with automatic tool choice. The older Opus 5 accepted its normal named tool. This confirms the request incompatibility in section 1 of the [provider workstream](./20261119-201523-model-providers-fast-lane.md).

| Model | Serialized thinking | Tool choice | HTTP | Result |
| --- | --- | --- | ---: | --- |
| claude-opus-5-5 | adaptive | named submit_plan | 400 | invalid_request_error |
| claude-opus-5-5 | adaptive | auto | 200 | 1,950 input tokens |
| claude-fable-5-2 | adaptive | named submit_plan | 400 | invalid_request_error |
| claude-fable-5-2 | adaptive | auto | 200 | 1,950 input tokens |
| claude-opus-5 | disabled | named submit_plan | 200 | 2,076 input tokens |

Both errors carried the same message, `tool_choice: type "tool" and "any" are not supported for this model.` The captures used master `f240376`, pi-ai 1.5.2, the real stage-5 schema and a synthetic prompt. An in-memory transport captured the serialized tools (including Pi's deferred placeholder), model-specific thinking, named choice, message and headers. Only the count-compatible request fields went to `POST /v1/messages/count_tokens`. Generation-only `stream`, `max_tokens`, `thread` and `fallbacks` fields were omitted. The owner's ordinary credential resolution was used. No generation request was sent. Token counting verifies acceptance of the request shape. End-to-end auto-submit recall remains a separate measurement. Sources: `src/llm/pi-runner.ts:488,990–1019,1745–1752,1962–1968`, `src/llm/schemas.ts:54`. [Opus 5.5 tool-choice rules and token-count validation](https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5) · [Fable 5.2 tool-choice rules](https://platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2).

Two additional owner-authorized named-submit controls used the same token-count procedure at 20:30 UTC on November 19. Haiku 5.5 sent disabled thinking and received HTTP 200 (2,076 input tokens). Fable 5 omitted the thinking field and received HTTP 200 (2,079 input tokens). Both reported no error. Fable 5 therefore accepts a named tool despite having a catalog thinking-level mapping of `off: null`. A fix using that catalog marker applies a conservative automatic-choice policy to Fable 5. It does not identify precisely which models reject named tools.
