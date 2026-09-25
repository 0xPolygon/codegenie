import { repairJson, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { isDeepStrictEqual } from "node:util";
import { xmlParameterSyntax } from "./json-syntax-guidance.js";
import { createHash } from "node:crypto";
import { stripCredentials } from "../telemetry/redaction.js";
import type {
  PiAssistantMessage,
  PiArgumentSyntaxDiagnostic,
  PiInvalidToolCall,
  PiToolCall,
  PiTrustedArgumentParse,
  PiUntrustedArgumentParse
} from "./llm-runner.js";

type PublicAssistantEventStream = AsyncIterable<AssistantMessageEvent>;

type Capture = {
  started: boolean;
  ended: boolean;
  ambiguous: boolean;
  sawDelta: boolean;
  text: string;
  endCall?: PiToolCall;
};

export type FinalToolArgumentHooks = {
  onEvent?(event: AssistantMessageEvent): void;
  onBuffersCleared?(remainingChars: number): void;
  onRejectedArguments?(diagnostic: RejectedArgumentDiagnostic): void;
};

export type RejectedArgumentDiagnostic = {
  contentIndex: number;
  toolCallId: string;
  name: string;
  parse: PiUntrustedArgumentParse;
  capturedChars: number;
  sha256: string;
  syntaxErrorOffset?: number;
  syntaxDiagnostic?: PiArgumentSyntaxDiagnostic;
  prefix: string;
  suffix: string;
  omittedChars: number;
  sampleChars: number;
};

/**
 * Consume Pi's public stream and establish final-argument provenance for one
 * named stage submit tool. Only bounded, redacted diagnostics may leave via
 * the optional hook. Capture buffers are cleared before returning or throwing.
 */
export async function consumeFinalToolArguments(
  stream: PublicAssistantEventStream,
  submitToolName: string,
  hooks: FinalToolArgumentHooks = {}
): Promise<PiAssistantMessage> {
  const captures = new Map<number, Capture>();
  let terminal: PiAssistantMessage | undefined;

  try {
    for await (const event of stream) {
      hooks.onEvent?.(event);
      if (event.type === "toolcall_start") {
        const existing = captures.get(event.contentIndex);
        if (existing !== undefined) {
          existing.ambiguous = true;
        } else {
          captures.set(event.contentIndex, emptyCapture(true));
        }
      } else if (event.type === "toolcall_delta") {
        const capture = captures.get(event.contentIndex) ?? emptyCapture(false);
        if (!captures.has(event.contentIndex)) {
          captures.set(event.contentIndex, capture);
        }
        if (capture.ended) {
          capture.ambiguous = true;
        }
        capture.sawDelta = true;
        capture.text += event.delta;
      } else if (event.type === "toolcall_end") {
        const capture = captures.get(event.contentIndex) ?? emptyCapture(false);
        if (!captures.has(event.contentIndex)) {
          captures.set(event.contentIndex, capture);
        }
        if (capture.ended) {
          capture.ambiguous = true;
        }
        capture.ended = true;
        capture.endCall = event.toolCall as PiToolCall;
      } else if (event.type === "done") {
        terminal = event.message as PiAssistantMessage;
      } else if (event.type === "error") {
        terminal = event.error as PiAssistantMessage;
      }
    }

    if (terminal === undefined) {
      throw new Error("Pi stream ended without a terminal event");
    }
    return finalizeMessage(terminal, submitToolName, captures, hooks);
  } finally {
    for (const capture of captures.values()) {
      capture.text = "";
      delete capture.endCall;
    }
    captures.clear();
    hooks.onBuffersCleared?.(0);
  }
}

function emptyCapture(started: boolean): Capture {
  return { started, ended: false, ambiguous: false, sawDelta: false, text: "" };
}

function finalizeMessage(
  message: PiAssistantMessage,
  submitToolName: string,
  captures: ReadonlyMap<number, Capture>,
  hooks: FinalToolArgumentHooks
): PiAssistantMessage {
  const content = message.content.map((block, contentIndex) => {
    if (!isPiToolCall(block) || block.name !== submitToolName) {
      return block;
    }
    const parse = message.stopReason === "length"
      ? { state: "length_stopped" } as const
      : parseCapturedArguments(captures.get(contentIndex), block);
    if (parse.state === "strict" || parse.state === "repaired") {
      const argumentParse: PiTrustedArgumentParse = parse.state === "strict"
        ? { state: "strict" }
        : { state: "repaired", repairs: ["pi_narrow_string_repair"] };
      return { ...block, arguments: parse.value, argumentParse } satisfies PiToolCall;
    }
    // Diagnostics never become usable arguments. Only a small syntax excerpt
    // can enter repair prompts; larger samples stay in redacted debug artifacts.
    const raw = captures.get(contentIndex)?.text ?? "";
    const sample = stripCredentials(raw);
    const syntaxDiagnostic = parse.state === "partial" || parse.state === "invalid" || parse.state === "length_stopped"
      ? argumentSyntaxDiagnostic(sample) : undefined;
    if (hooks.onRejectedArguments) {
      let syntaxErrorOffset: number | undefined;
      try { JSON.parse(raw); } catch (cause) {
        const offset = cause instanceof SyntaxError ? cause.message.match(/position (\d+)/u)?.[1] : undefined;
        if (offset !== undefined) syntaxErrorOffset = Number(offset);
      }
      // Redact before slicing so a boundary cannot expose part of a secret.
      const prefix = sample.slice(0, 8192);
      const suffix = sample.length > prefix.length ? sample.slice(Math.max(prefix.length, sample.length - 8192)) : "";
      hooks.onRejectedArguments({ contentIndex, toolCallId: block.id, name: block.name, parse,
        capturedChars: raw.length, sha256: createHash("sha256").update(raw).digest("hex"),
        ...(syntaxErrorOffset !== undefined ? { syntaxErrorOffset } : {}),
        ...(syntaxDiagnostic ? { syntaxDiagnostic } : {}),
        prefix, suffix, sampleChars: sample.length, omittedChars: sample.length - prefix.length - suffix.length });
    }
    return {
      type: "invalidToolCall",
      id: block.id,
      name: block.name,
      argumentParse: parse,
      ...(syntaxDiagnostic ? { syntaxDiagnostic } : {})
    } satisfies PiInvalidToolCall;
  });
  return { ...message, content };
}

// Locate the error after redaction so offsets remain meaningful without
// slicing through secrets. Parser messages can echo raw input: allow only
// structural descriptions, never the parser's embedded string preview.
function argumentSyntaxDiagnostic(sample: string): PiArgumentSyntaxDiagnostic | undefined {
  try { JSON.parse(sample); return undefined; } catch (cause) {
    if (!(cause instanceof SyntaxError)) return undefined;
    const xml = xmlParameterSyntax(sample);
    const position = cause.message.match(/position (\d+)/u)?.[1];
    const offset = position !== undefined ? Number(position)
      : xml?.offset ?? (/end of JSON|unterminated/iu.test(cause.message) ? sample.length : undefined);
    const error = cause.message.match(/^(?:Expected .*? in JSON|Unterminated string in JSON|Unexpected (?:non-whitespace character after JSON|end of JSON input))/u)?.[0] ?? "Invalid JSON syntax";
    // Some runtimes provide only a quoted preview, not an offset. Locate it
    // only when it occurs exactly once; never report a guessed error offset.
    const preview = cause.message.match(/, (?:\.\.\.)?"([\s\S]*)"(?:\.\.\.)? is not valid JSON$/u)?.[1];
    const previewStart = preview && sample.indexOf(preview) === sample.lastIndexOf(preview) ? sample.indexOf(preview) : -1;
    const excerptStart = Math.max(0, (offset ?? Math.max(0, previewStart)) - 256);
    return { error: error.slice(0, 160), ...(offset !== undefined ? { offset } : {}),
      ...(xml ? { xmlParameter: { ...(xml.field ? { field: xml.field } : {}) } } : {}),
      excerptStart, excerpt: sample.slice(excerptStart, excerptStart + 512) };
  }
}

type ParsedCapture =
  | { state: "strict"; value: Record<string, unknown> }
  | { state: "repaired"; value: Record<string, unknown> }
  | PiUntrustedArgumentParse;

function parseCapturedArguments(capture: Capture | undefined, finalCall: PiToolCall): ParsedCapture {
  if (
    capture === undefined ||
    !capture.started ||
    !capture.sawDelta ||
    !capture.ended ||
    capture.ambiguous ||
    capture.endCall === undefined ||
    capture.endCall.id !== finalCall.id ||
    capture.endCall.name !== finalCall.name
  ) {
    return { state: "event_capture_missing" };
  }

  let value: unknown;
  let state: "strict" | "repaired" = "strict";
  try {
    value = JSON.parse(capture.text);
  } catch (strictCause) {
    let repaired: string;
    try {
      repaired = repairJson(capture.text);
    } catch {
      return classifySyntaxFailure(strictCause, capture.text);
    }
    if (repaired === capture.text) {
      return classifySyntaxFailure(strictCause, capture.text);
    }
    try {
      value = JSON.parse(repaired);
      state = "repaired";
    } catch {
      return classifySyntaxFailure(strictCause, capture.text);
    }
  }

  if (!isRecord(value)) {
    return { state: "invalid", errorKind: "non_object_root" };
  }
  if (!isDeepStrictEqual(value, capture.endCall.arguments) || !isDeepStrictEqual(value, finalCall.arguments)) {
    return { state: "event_final_mismatch" };
  }
  return { state, value };
}

function classifySyntaxFailure(cause: unknown, text: string): PiUntrustedArgumentParse {
  const message = cause instanceof SyntaxError ? cause.message : "";
  const completeness = jsonDelimiterCompleteness(text);
  if (/unterminated/iu.test(message) || completeness === "unterminated_string") {
    return { state: "partial", errorKind: "unterminated" };
  }
  if (/unexpected end|end of json/iu.test(message) || completeness === "open_delimiter" || text.trim() === "") {
    return { state: "partial", errorKind: "unexpected_end" };
  }
  return { state: "invalid", errorKind: "invalid_syntax" };
}

function jsonDelimiterCompleteness(text: string): "balanced" | "open_delimiter" | "unterminated_string" {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      stack.pop();
    }
  }
  if (inString) {
    return "unterminated_string";
  }
  return stack.length > 0 ? "open_delimiter" : "balanced";
}

function isPiToolCall(value: unknown): value is PiToolCall {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "toolCall" &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
