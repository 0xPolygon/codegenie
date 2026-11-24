// Observe bounded SSE frames on the consumer's read path. No response text is
// retained after a frame is examined, and the original bytes pass through.
const MAX_FRAME = 65_536;
const finishes = new Set(['stop', 'end', 'length', 'function_call', 'tool_calls']);

export function observeStreamTerminal(response, { signal, record }) {
  if (!response.body || !/\btext\/event-stream\b/iu.test(response.headers.get('content-type') ?? '')) return response;
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '', data = [], event = '', size = 0, overflow = false, uncertain = false, skipLF = false, lineHasChars = false;
  let terminal, sawFinish = false, recorded = false, cancelled = false;
  const persist = (value) => { if (!recorded) { record(value); recorded = true; } };
  const frame = () => {
    if (!overflow && data.length) {
      const payload = data.join('\n');
      if (payload === '[DONE]') terminal ??= 'done';
      else {
        try {
          const parsed = JSON.parse(payload);
          // The SDK yields thread envelopes before inspecting data.error;
          // named error events and truthy top-level errors otherwise throw.
          if (event.startsWith('thread.')) { /* not a completion terminal */ }
          else if (event === 'error' || (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'error') && Boolean(parsed.error))) terminal = 'provider_error_event';
          else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.choices)) {
            const reason = parsed.choices[0]?.finish_reason;
            if (['network_error', 'content_filter'].includes(reason)) terminal = 'provider_error_event';
            else if (finishes.has(reason)) sawFinish = true;
          }
        } catch { uncertain = true; }
      }
    }
    line = ''; data = []; event = ''; size = 0; overflow = false;
  };
  const consumeLine = () => {
    if (!lineHasChars) { frame(); return; }
    if (line[0] !== ':' && !overflow) {
      const colon = line.indexOf(':'), field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
    }
    line = ''; lineHasChars = false;
  };
  const scan = (text) => {
    for (const char of text) {
      if (uncertain || terminal) return;
      if (skipLF) { skipLF = false; if (char === '\n') continue; }
      if (char === '\r' || char === '\n') { consumeLine(); if (char === '\r') skipLF = true; continue; }
      lineHasChars = true;
      if (++size > MAX_FRAME) { overflow = true; uncertain = true; line = ''; data = []; event = ''; }
      else if (!overflow) line += char;
    }
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          try {
            scan(decoder.decode());
            // The SDK flushes a final SSE event even without a trailing blank
            // line, but never flushes a partial event after a reader error.
            if (!uncertain && !terminal) {
              if (lineHasChars) consumeLine();
              if (data.length || event) frame();
            }
          } catch { uncertain = true; }
          persist(terminal ?? (sawFinish && !uncertain ? 'done' : signal?.aborted ? 'local_cancel' : 'unknown'));
          controller.close();
          return;
        }
        try {
          // Bound temporary decoding even if the transport supplies one huge
          // chunk; the original byte chunk is still forwarded unchanged.
          for (let offset = 0; offset < result.value.length && !uncertain && !terminal; offset += 4096) {
            scan(decoder.decode(result.value.subarray(offset, offset + 4096), { stream: true }));
          }
        } catch { uncertain = true; }
        // [DONE]/an explicit provider error is decisive even when the SDK
        // stops reading and cancels immediately after the frame.
        if (terminal) persist(terminal);
        controller.enqueue(result.value);
      } catch (error) {
        try { persist(terminal ?? (signal?.aborted || cancelled ? 'local_cancel' : uncertain ? 'unknown' : 'body_reset')); }
        catch (accountingError) { controller.error(accountingError); return; }
        controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      try { persist(terminal ?? (sawFinish && !uncertain ? 'done' : signal?.aborted ? 'local_cancel' : 'unknown')); }
      finally { await reader.cancel(reason); }
    }
  }, { highWaterMark: 0 });
  const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  for (const name of ['url', 'redirected', 'type']) Object.defineProperty(wrapped, name, { value: response[name], configurable: true });
  return wrapped;
}
