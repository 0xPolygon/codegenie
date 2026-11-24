// Observe bounded response metadata on the SDK's read path. No response text
// is retained, and the original bytes and cancellation pass through unchanged.
export function observeOpenRouterResponse(response: Response, observe: (value: unknown, failure: boolean) => void): Response {
  if (!response.body) return response;
  const sse = /\btext\/event-stream\b/iu.test(response.headers.get("content-type") ?? "");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const limit = 65_536;
  let buffer = "", line = "", data: string[] = [], event = "";
  let size = 0, oversized = false, uncertain = false, terminal = false, skipLF = false, lineHasChars = false;
  const frame = (): void => {
    if (!terminal && !uncertain && !oversized && (event || data.length)) {
      const payload = data.join("\n");
      if (payload === "[DONE]") terminal = true;
      else {
        try {
          const value: unknown = JSON.parse(payload);
          if (!event.startsWith("thread.")) {
            const failure = event === "error" || Boolean(value && typeof value === "object" && "error" in value && value.error);
            observe(value, failure);
            if (failure) terminal = true;
          }
        } catch { uncertain = true; }
      }
    } else if (oversized) uncertain = true;
    data = []; event = ""; size = 0; oversized = false;
  };
  const consumeLine = (): void => {
    if (!lineHasChars) frame();
    else if (!oversized && !line.startsWith(":")) {
      const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
      else if (field === "event") event = value;
    }
    line = ""; lineHasChars = false;
  };
  const scan = (text: string): void => {
    if (!sse) {
      if (!oversized && buffer.length + text.length <= limit) buffer += text;
      else { oversized = true; buffer = ""; }
      return;
    }
    for (const char of text) {
      if (terminal) return;
      if (skipLF) { skipLF = false; if (char === "\n") continue; }
      if (char === "\n" || char === "\r") { consumeLine(); if (char === "\r") skipLF = true; continue; }
      lineHasChars = true;
      if (++size > limit) { oversized = true; line = ""; data = []; event = ""; }
      else if (!oversized) line += char;
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          scan(decoder.decode());
          if (sse) { if (lineHasChars) consumeLine(); if (data.length || event) frame(); }
          else if (!oversized && buffer.length) {
            try { observe(JSON.parse(buffer) as unknown, !response.ok); } catch { /* No complete JSON evidence. */ }
          }
          controller.close();
        } else {
          for (let offset = 0; offset < result.value.length; offset += 4096)
            scan(decoder.decode(result.value.subarray(offset, offset + 4096), { stream: true }));
          controller.enqueue(result.value);
        }
      } catch (error) { controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason); }
  }, { highWaterMark: 0 });
  const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  for (const name of ["url", "redirected", "type"] as const) Object.defineProperty(wrapped, name, { value: response[name], configurable: true });
  return wrapped;
}
