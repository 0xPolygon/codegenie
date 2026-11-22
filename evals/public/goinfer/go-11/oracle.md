---
repo: goinfer
case: go-11
role: contaminated-control
intro: 9383547fcbbb5c37dee7c7177babe2e751948449
base: a9297c9b571a368c1aa2b1e19731d04c2dc8314f
introDate: 2026-10-12
kind: control/in-process-http-streaming
---

## Exclusion rationale

The base has no in-process transport. The head adds a transport that defers closing the request body until its handler returns. Request cancellation before headers can return from `RoundTrip` while the handler is still blocked reading that body. After headers, request cancellation leaves the response pipe open. Client reads and handler writes use the pipe directly. An explicit `Body.Close` closes it. Go's outgoing request contract applies cancellation to response body reads too. [Go request context documentation](https://pkg.go.dev/net/http#NewRequestWithContext)

The two deadline methods acknowledge success without enforcing a deadline, as documented in the new code. The new streaming test also has an acknowledgement send with no timeout of its own. Keep this pin for exploratory review and exclude it from the clean-control and required-detection denominators.

## Source

The cancellation and deadline paths are in `internal/inproc/transport.go:26-139`. Separate tests cover explicit body closure and cancellation before the reply. The streaming test's acknowledgement wait and send are in `internal/inproc/transport_test.go:62-84`. [Pinned change](https://github.com/townsendmerino/goinfer/commit/9383547fcbbb5c37dee7c7177babe2e751948449)
