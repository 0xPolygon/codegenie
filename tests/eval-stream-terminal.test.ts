import { describe, expect, it } from 'vitest';
// @ts-expect-error Dev-only ESM has no emitted types.
import { observeStreamTerminal } from '../evals/runner/stream-terminal.mjs';

const encoder = new TextEncoder();
const response = (chunks: string[], fail = false) => {
  let index = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]!));
    else if (fail) controller.error(new Error('synthetic reset'));
    else controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
};

describe('physical SSE terminal observation', () => {
  it('forwards bytes exactly and sees split CRLF, multiline error and UTF-8 text', async () => {
    const text = ': comment\r\ndata: {"choices":[{"delta":{"content":"caf\u00e9 error [DONE]"},"finish_reason":null}]}\r\n\r\nevent: err' + 'or\r\ndata: {"error":\r\ndata: {"message":"synthetic"}}\r\n\r\n';
    const bytes = encoder.encode(text), terminals: string[] = [];
    const source = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
    const observed = observeStreamTerminal(source, { record: (value: string) => terminals.push(value) });
    expect(await observed.text()).toBe(text); expect(terminals).toEqual(['provider_error_event']);
  });
  it('records DONE before SDK cancellation and treats model-text markers as data', async () => {
    const terminals: string[] = [], chunk = 'data: {"choices":[{"delta":{"content":"[DONE] error"},"finish_reason":null}]}\n\ndata: [DO' + 'NE]\n\n';
    const stream = observeStreamTerminal(response([chunk]), { record: (value: string) => terminals.push(value) });
    const reader = stream.body!.getReader(); await reader.read(); await reader.cancel(); expect(terminals).toEqual(['done']);
  });
  it('flushes a final complete SSE event at EOF without a blank line', async () => {
    for (const [text, expected] of [
      ['data: [DONE]', 'done'],
      ['event: error\ndata: {"error":"synthetic"}', 'provider_error_event'],
      ['data: {"choices":[{"finish_reason":"stop"}]}', 'done']
    ] as const) {
      const terminals: string[] = [];
      await observeStreamTerminal(response([text]), { record: (value: string) => terminals.push(value) }).text();
      expect(terminals).toEqual([expected]);
    }
  });
  it('distinguishes resets, clean EOF, usage-only, invalid and oversized evidence', async () => {
    for (const [chunks, fail, expected] of [
      [['data: {"choices":[]}\n\n'], true, 'body_reset'],
      [['data: {"choices":[]}\n\n'], false, 'unknown'],
      [['data: {"usage":{"total_tokens":0}}\n\n'], false, 'unknown'],
      [['data: not-json\n\n'], true, 'unknown'],
      [[`data: ${'x'.repeat(70_000)}\n\n`], true, 'unknown']
    ] as Array<[string[], boolean, string]>) {
      const terminals: string[] = [], stream = observeStreamTerminal(response(chunks, fail), { record: (value: string) => terminals.push(value) });
      try { await stream.text(); } catch { /* synthetic body reset */ }
      expect(terminals).toEqual([expected]);
    }
  });
  it('does not treat a finish chunk as stronger than a later explicit error', async () => {
    const terminals: string[] = [];
    const body = response(['data: {"choices":[{"finish_reason":"stop"}]}\n\n', 'data: {"error":{"message":"failure"}}\n\n']);
    await observeStreamTerminal(body, { record: (value: string) => terminals.push(value) }).text();
    expect(terminals).toEqual(['provider_error_event']);
  });
  it('uses primary-choice and SDK error-event semantics', async () => {
    for (const [text, expected] of [
      ['event: error\ndata: "synthetic"\n\ndata: [DONE]\n\n', 'provider_error_event'],
      ['data: {"error":"synthetic"}\n\ndata: [DONE]\n\n', 'provider_error_event'],
      ['event: thread.message\ndata: {"error":"not a completion error"}\n\n', 'unknown'],
      ['data: {"choices":[{"finish_reason":"network_error"}]}\n\ndata: [DONE]\n\n', 'provider_error_event'],
      ['data: {"choices":[{"finish_reason":null},{"finish_reason":"stop"}]}\n\n', 'unknown']
    ] as const) {
      const terminals: string[] = [];
      await observeStreamTerminal(response([text]), { record: (value: string) => terminals.push(value) }).text();
      expect(terminals).toEqual([expected]);
    }
  });
  it('records a body reset after finish but before usage and DONE', async () => {
    const finish = 'data: {"choices":[{"finish_reason":"stop"}]}\n\n';
    for (const [fail, expected] of [[true, 'body_reset'], [false, 'done']] as const) {
      const terminals: string[] = [], stream = observeStreamTerminal(response(['data: {"choices":[]}\n\n', finish], fail), { record: (value: string) => terminals.push(value) });
      try { await stream.text(); } catch { /* synthetic reset */ }
      expect(terminals).toEqual([expected]);
    }
  });
  it('distinguishes local abort from ambiguous consumer cancellation', async () => {
    for (const [abort, expected] of [[true, 'local_cancel'], [false, 'unknown']] as const) {
      const signal = new AbortController(), terminals: string[] = [];
      const stream = observeStreamTerminal(response(['data: {"choices":[]}\n\n']), { signal: signal.signal, record: (value: string) => terminals.push(value) });
      const reader = stream.body!.getReader(); await reader.read(); if (abort) signal.abort(); await reader.cancel();
      expect(terminals).toEqual([expected]);
    }
  });
});
