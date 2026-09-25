import {
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
  type AssistantMessageEventStream
} from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { clearRegisteredSecretsForTests, registerSecret } from "../src/telemetry/redaction.js";
import { describe, expect, it, vi } from "vitest";
import { consumeFinalToolArguments } from "../src/llm/final-tool-arguments.js";
import type { PiAssistantMessage, PiInvalidToolCall, PiToolCall } from "../src/llm/llm-runner.js";

const SUBMIT = "submit_review";

describe("final tool argument provenance", () => {
  it.each([
    ["fragmented", ['{"find', 'ings":[]}']],
    ["canonical", ['{"findings":[]}']]
  ])("accepts a %s strict object", async (_label, deltas) => {
    const final = message(call("submit-1", SUBMIT, { findings: [] }));
    const onEvent = vi.fn();
    const result = await consumeFinalToolArguments(sequence(final, deltas), SUBMIT, { onEvent });
    expect(onEvent.mock.calls.some(([event]) => event.type === "toolcall_delta")).toBe(true);
    expect(result).toEqual({
      ...final,
      content: [{ ...call("submit-1", SUBMIT, { findings: [] }), argumentParse: { state: "strict" } }]
    });
  });

  it("accepts key-order differences after semantic deep equality", async () => {
    const final = message(call("submit-1", SUBMIT, { a: 1, b: 2 }));
    const result = await consumeFinalToolArguments(sequence(final, ['{"b":2,"a":1}']), SUBMIT);
    expect(result.content[0]).toMatchObject({
      arguments: { b: 2, a: 1 },
      argumentParse: { state: "strict" }
    });
  });

  it.each([
    ["raw control", '{"reason":"line\nbreak"}', "line\nbreak"],
    ["invalid backslash", '{"reason":"C:\\temp\\q"}', "C:\temp\\q"]
  ])("accepts Pi's narrow %s repair and records only its kind", async (_label, delta, expected) => {
    const final = message(call("submit-1", SUBMIT, { reason: expected }));
    const result = await consumeFinalToolArguments(sequence(final, [delta]), SUBMIT);
    expect(result.content[0]).toMatchObject({
      arguments: { reason: expected },
      argumentParse: { state: "repaired", repairs: ["pi_narrow_string_repair"] }
    });
  });

  it.each([
    ["unterminated string", '{"reason":"secret', { state: "partial", errorKind: "unterminated" }],
    ["unterminated object", '{"reason":"ok"', { state: "partial", errorKind: "unexpected_end" }],
    ["unterminated array", '{"items":[1,2', { state: "partial", errorKind: "unexpected_end" }],
    ["malformed complete", '{"a":}', { state: "invalid", errorKind: "invalid_syntax" }],
    ["empty", "", { state: "partial", errorKind: "unexpected_end" }],
    ["scalar", "7", { state: "invalid", errorKind: "non_object_root" }],
    ["array", "[]", { state: "invalid", errorKind: "non_object_root" }]
  ])("rejects %s without returning captured data", async (_label, delta, expected) => {
    const secret = "repository-secret-value";
    const final = message(call("submit-1", SUBMIT, { secret }));
    const result = await consumeFinalToolArguments(sequence(final, [delta]), SUBMIT);
    expect(result.content[0]).toMatchObject({
      type: "invalidToolCall",
      id: "submit-1",
      name: SUBMIT,
      argumentParse: expected
    });
    expect(JSON.stringify(result.content[0])).not.toContain(secret);
    expect(result.content[0]).not.toHaveProperty("arguments");
  });

  it("keeps bounded, redacted rejected-argument diagnostics separate from trusted arguments", async () => {
    registerSecret("unique-diagnostic-secret");
    const onRejectedArguments = vi.fn();
    const onBuffersCleared = vi.fn();
    const raw = '{"reason":"' + "x".repeat(8170) + 'unique-diagnostic-secret' + "y".repeat(20_000) + '","verdict":}';
    try {
      const final = message(call("submit-bad", SUBMIT, { reason: "partial guess" }));
      const result = await consumeFinalToolArguments(sequence(final, [raw]), SUBMIT, { onRejectedArguments, onBuffersCleared });
      expect(result.content[0]).toMatchObject({ type: "invalidToolCall", id: "submit-bad", name: SUBMIT,
        argumentParse: { state: "invalid", errorKind: "invalid_syntax" } });
      expect(onRejectedArguments).toHaveBeenCalledOnce();
      const diagnostic = onRejectedArguments.mock.calls[0]![0];
      expect(diagnostic).toMatchObject({ toolCallId: "submit-bad", contentIndex: 0,
        capturedChars: raw.length, sha256: createHash("sha256").update(raw).digest("hex"),
        parse: { state: "invalid", errorKind: "invalid_syntax" } });
      expect(diagnostic.prefix.length + diagnostic.suffix.length).toBe(16_384);
      expect(diagnostic.omittedChars).toBe(diagnostic.sampleChars - 16_384);
      expect(diagnostic.prefix).not.toContain("unique-");
      expect(diagnostic.suffix).toContain('"verdict":}');
      expect(onBuffersCleared).toHaveBeenCalledWith(0);
      expect(JSON.stringify(result)).not.toContain("partial guess");
    } finally { clearRegisteredSecretsForTests(); }
  });

  it.each([
    ['{"findings":[]}}', "Unexpected non-whitespace character after JSON"],
    ['{"findings":[{"title":"x"],"followUpHints":[]}', "Expected"],
    ['{"findings":[', "Unexpected end"]
  ])("provides bounded syntax feedback without accepting malformed JSON: %s", async (raw, error) => {
    const result = await consumeFinalToolArguments(sequence(message(call("bad", SUBMIT, { findings: [] })), [raw]), SUBMIT);
    const block = result.content[0] as PiInvalidToolCall;
    expect(block.type).toBe("invalidToolCall");
    expect(block).not.toHaveProperty("arguments");
    expect(block.syntaxDiagnostic?.error).toContain(error);
    expect(block.syntaxDiagnostic?.excerpt).toBe(raw);
    expect(block.syntaxDiagnostic?.excerptStart).toBe(0);
  });

  it("centers syntax excerpts on the error after redaction, even outside debug prefixes", async () => {
    const secret = "syntax-secret-with-a-long-credential-value";
    registerSecret(secret);
    try {
      const raw = '{"secret":"' + secret + '","padding":"' + "x".repeat(10_000) + '","bad":},"tail":"' + "y".repeat(10_000) + '"}';
      const result = await consumeFinalToolArguments(sequence(message(call("bad", SUBMIT, {})), [raw]), SUBMIT);
      const diagnostic = (result.content[0] as PiInvalidToolCall).syntaxDiagnostic!;
      expect(diagnostic.excerpt).toContain('"bad":}');
      expect(diagnostic.excerpt.length).toBeLessThanOrEqual(512);
      expect(diagnostic.excerptStart).toBeGreaterThan(8192);
      if (diagnostic.offset !== undefined) expect(diagnostic.offset - diagnostic.excerptStart).toBe(256);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.content[0]).not.toHaveProperty("arguments");
    } finally { clearRegisteredSecretsForTests(); }
  });

  it("identifies XML parameter syntax in streamed nested arguments without accepting the draft", async () => {
    const raw = '{"reason":"' + "x".repeat(1000) + '","proofAssessment":\n<parameter name="status">unresolved,"assumptions":"[]"}';
    const result = await consumeFinalToolArguments(sequence(message(call("bad", SUBMIT, { reason: "partial" })),
      [raw.slice(0, 1010), raw.slice(1010)]), SUBMIT);
    expect(result.content[0]).toMatchObject({ type: "invalidToolCall", argumentParse: { state: "invalid" },
      syntaxDiagnostic: { xmlParameter: { field: "proofAssessment" }, excerpt: expect.stringContaining('<parameter name="status">') } });
    expect(result.content[0]).not.toHaveProperty("arguments");
  });

  it("captures short malformed text completely but produces no diagnostic for valid submissions", async () => {
    const onRejectedArguments = vi.fn();
    const raw = '{"verdict":}';
    await consumeFinalToolArguments(sequence(message(call("bad", SUBMIT, {})), [raw]), SUBMIT, { onRejectedArguments });
    expect(onRejectedArguments.mock.calls[0]![0]).toMatchObject({ prefix: raw, suffix: "", omittedChars: 0 });
    await consumeFinalToolArguments(sequence(message(call("good", SUBMIT, { verdict: "keep" })), ['{"verdict":"keep"}']), SUBMIT, { onRejectedArguments });
    expect(onRejectedArguments).toHaveBeenCalledOnce();
  });

  it("does not mislabel missing stream provenance as a JSON syntax error", async () => {
    const result = await consumeFinalToolArguments(sequence(message(call("bad", SUBMIT, {})), ['{"unfinished":'], { omitStart: true }), SUBMIT);
    expect(result.content[0]).toMatchObject({ type: "invalidToolCall", argumentParse: { state: "event_capture_missing" } });
    expect(result.content[0]).not.toHaveProperty("syntaxDiagnostic");
  });

  it.each([
    ["missing start", { omitStart: true }],
    ["missing delta", { omitDelta: true }],
    ["missing end", { omitEnd: true }],
    ["duplicate framing", { duplicateStart: true }],
    ["id mismatch", { endId: "other" }],
    ["name mismatch", { endName: "other" }]
  ])("rejects %s as capture missing", async (_label, options) => {
    const final = message(call("submit-1", SUBMIT, { ok: true }));
    const result = await consumeFinalToolArguments(sequence(final, ['{"ok":true}'], options), SUBMIT);
    expect(result.content[0]).toMatchObject({
      type: "invalidToolCall",
      argumentParse: { state: "event_capture_missing" }
    });
  });

  it("rejects toolcall-end arguments that diverge from the captured event value", async () => {
    const final = message(call("submit-1", SUBMIT, { complete: false }));
    const result = await consumeFinalToolArguments(
      sequence(final, ['{"complete":false}'], { endArguments: { complete: true } }),
      SUBMIT
    );
    expect(result.content[0]).toMatchObject({ argumentParse: { state: "event_final_mismatch" } });
    expect(result.content[0]).not.toHaveProperty("arguments");
  });

  it("rejects final-message substitution when event and toolcall-end arguments agree", async () => {
    const final = message(call("submit-1", SUBMIT, { complete: true }));
    const result = await consumeFinalToolArguments(
      sequence(final, ['{"complete":false}'], { endArguments: { complete: false } }),
      SUBMIT
    );
    expect(result.content[0]).toMatchObject({ argumentParse: { state: "event_final_mismatch" } });
    expect(result.content[0]).not.toHaveProperty("arguments");
  });

  it("gives normalized length stop precedence over valid JSON", async () => {
    const final = { ...message(call("submit-1", SUBMIT, { ok: true })), stopReason: "length" };
    const result = await consumeFinalToolArguments(sequence(final, ['{"ok":true}']), SUBMIT);
    expect(result.content[0]).toMatchObject({
      type: "invalidToolCall",
      id: "submit-1",
      name: SUBMIT,
      argumentParse: { state: "length_stopped" }
    });
  });

  it("preserves terminal error semantics, leaves repository calls unchanged, and clears buffers", async () => {
    const cleared = vi.fn();
    const repository = call("read-1", "read_range", { path: "src/secret.ts" });
    const final = {
      ...message(repository, call("submit-1", SUBMIT, { ok: true })),
      stopReason: "error",
      errorMessage: "provider error"
    };
    const result = await consumeFinalToolArguments(
      sequence(final, ['{"ok":true}'], { contentIndex: 1 }),
      SUBMIT,
      { onBuffersCleared: cleared }
    );
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("provider error");
    expect(result.content[0]).toEqual(repository);
    expect(result.content[1]).toMatchObject({ argumentParse: { state: "strict" } });
    expect(cleared).toHaveBeenCalledWith(0);
  });

  it("throws a bounded error and clears buffers when the stream has no terminal event", async () => {
    const cleared = vi.fn();
    const stream = createAssistantMessageEventStream();
    const final = message(call("submit-1", SUBMIT, { secret: "never expose me" }));
    push(stream, { type: "toolcall_start", contentIndex: 0, partial: final as never });
    push(stream, { type: "toolcall_delta", contentIndex: 0, delta: '{"secret":"never expose me"}', partial: final as never });
    stream.end();
    await expect(consumeFinalToolArguments(stream, SUBMIT, { onBuffersCleared: cleared }))
      .rejects.toThrow("Pi stream ended without a terminal event");
    expect(cleared).toHaveBeenCalledWith(0);
  });
});

function call(id: string, name: string, args: Record<string, unknown>): PiToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function message(...content: PiToolCall[]): PiAssistantMessage {
  return {
    role: "assistant",
    content,
    provider: "fake",
    model: "fake-model",
    usage: { input: 3, output: 2, totalTokens: 5 },
    stopReason: "toolUse",
    timestamp: 1
  };
}

function sequence(
  final: PiAssistantMessage,
  deltas: string[],
  options: {
    contentIndex?: number;
    omitStart?: boolean;
    omitDelta?: boolean;
    omitEnd?: boolean;
    duplicateStart?: boolean;
    endId?: string;
    endName?: string;
    endArguments?: Record<string, unknown>;
  } = {}
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const contentIndex = options.contentIndex ?? 0;
  const finalCall = final.content[contentIndex] as PiToolCall;
  const endCall = call(
    options.endId ?? finalCall.id,
    options.endName ?? finalCall.name,
    options.endArguments ?? finalCall.arguments
  );
  push(stream, { type: "start", partial: final as never });
  if (!options.omitStart) {
    push(stream, { type: "toolcall_start", contentIndex, partial: final as never });
    if (options.duplicateStart) {
      push(stream, { type: "toolcall_start", contentIndex, partial: final as never });
    }
  }
  if (!options.omitDelta) {
    for (const delta of deltas) {
      push(stream, { type: "toolcall_delta", contentIndex, delta, partial: final as never });
    }
  }
  if (!options.omitEnd) {
    push(stream, { type: "toolcall_end", contentIndex, toolCall: endCall as never, partial: final as never });
  }
  if (final.stopReason === "error" || final.stopReason === "aborted") {
    push(stream, { type: "error", reason: final.stopReason, error: final as never });
  } else {
    push(stream, {
      type: "done",
      reason: final.stopReason === "length" ? "length" : final.stopReason === "toolUse" ? "toolUse" : "stop",
      message: final as never
    });
  }
  return stream;
}

function push(stream: AssistantMessageEventStream, event: AssistantMessageEvent): void {
  stream.push(event);
}
