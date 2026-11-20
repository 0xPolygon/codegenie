import { stripCredentials } from "../telemetry/redaction.js";
import type { PiAssistantMessage, StoredProviderResponse } from "./llm-runner.js";

// Provider signatures are protocol data. Redact readable content for replay,
// while leaving opaque signatures intact. Diagnostic writers still redact
// the complete message, including opaque fields.
export function redactAssistantForReplay(message: PiAssistantMessage): PiAssistantMessage {
  const redacted = stripCredentials(message);
  for (const [index, block] of message.content.entries()) {
    const field = signatureField(block);
    const redactedBlock = redacted.content[index];
    if (field && redactedBlock) {
      const signature = (block as Record<string, unknown>)[field];
      if (typeof signature === "string") {
        (redactedBlock as Record<string, unknown>)[field] = redactReadableSignatureFields(signature);
      }
    }
  }
  return redacted;
}

const REDACTION_MARKER = /\[redacted(?::[a-z0-9_-]+)?\]/iu;
const SIGNATURE_ENVELOPE = /^\s*[\[{]/u;

export function hasUncacheableReplaySignature(message: PiAssistantMessage): boolean {
  return message.content.some((block) => {
    const field = signatureField(block);
    const signature = field && (block as Record<string, unknown>)[field];
    if (typeof signature !== "string") {
      return false;
    }
    if (REDACTION_MARKER.test(signature) || stripCredentials(signature) !== signature) {
      return true;
    }
    // Also scan the decoded fields. Escapes in a serialized envelope can hide
    // a credential from the string-level checks.
    const envelope = parseSignatureEnvelope(signature);
    if (envelope === undefined) {
      return false;
    }
    const encoded = JSON.stringify(envelope);
    return REDACTION_MARKER.test(encoded) || JSON.stringify(stripCredentials(envelope)) !== encoded;
  });
}

export function redactStoredResponseForReplay({ message, ...metadata }: StoredProviderResponse): StoredProviderResponse {
  return { ...stripCredentials(metadata), message: redactAssistantForReplay(message) };
}

function signatureField(block: PiAssistantMessage["content"][number]): string | undefined {
  // Pi also carries Google thought signatures on text and tool-call parts.
  switch (block.type) {
    case "thinking": return "thinkingSignature";
    case "text": return "textSignature";
    case "toolCall": return "thoughtSignature";
    default: return undefined;
  }
}

function redactReadableSignatureFields(signature: string): string {
  // Pi's OpenAI adapters use JSON envelopes that can contain both readable
  // summaries and opaque fields. Other adapters use a bare signature string.
  const envelope = parseSignatureEnvelope(signature);
  if (envelope === undefined) {
    return signature;
  }
  const redacted = Array.isArray(envelope) ? envelope.map(redactReasoningDetail) : redactReasoningDetail(envelope);
  const encoded = JSON.stringify(redacted);
  return encoded === JSON.stringify(envelope) ? signature : encoded;
}

function parseSignatureEnvelope(signature: string): unknown {
  if (!SIGNATURE_ENVELOPE.test(signature)) {
    return undefined;
  }
  try {
    return JSON.parse(signature);
  } catch {
    return undefined;
  }
}

function redactReasoningDetail(detail: unknown): unknown {
  const redacted = stripCredentials(detail);
  if (!isRecord(detail) || !isRecord(redacted)) {
    return redacted;
  }
  const opaqueField = detail.type === "reasoning.encrypted" ? "data"
    : detail.type === "reasoning.text" ? "signature"
      : detail.type === "reasoning" ? "encrypted_content" : undefined;
  if (opaqueField && typeof detail[opaqueField] === "string") {
    redacted[opaqueField] = detail[opaqueField];
  }
  return redacted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
