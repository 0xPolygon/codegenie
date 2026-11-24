import { credentialSafeCut } from "../telemetry/redaction.js";

export const CONTEXT_CUT_MARKER = "\n[... content truncated to fit packet context budget ...]";

/** Keep the original packing coordinates in memory until the text is emitted. */
export type PacketText = {
  text: string;
  decisionText: string;
  prefixAt?: (decisionEnd: number) => string;
};

export function packetText(text: string): PacketText {
  return { text, decisionText: text };
}

export function joinPacketText(parts: PacketText[], separator: string): PacketText {
  const text = parts.map(part => part.text).join(separator);
  const decisionText = parts.map(part => part.decisionText).join(separator);
  if (text === decisionText) return packetText(text);
  return { text, decisionText, prefixAt: end => {
    const prefix: string[] = [];
    for (const [index, part] of parts.entries()) {
      if (index > 0) {
        prefix.push(separator.slice(0, end));
        end -= separator.length;
        if (end <= 0) break;
      }
      prefix.push(prefixAt(part, end));
      end -= part.decisionText.length;
      if (end <= 0) break;
    }
    return prefix.join("");
  } };
}

export function truncatePacketText(input: PacketText, maxChars: number, marker = CONTEXT_CUT_MARKER,
  safeCut = credentialSafeCut): PacketText {
  if (input.decisionText.length <= maxChars) return input;

  const end = Math.max(0, maxChars - marker.length);
  const originalPrefix = input.decisionText.slice(0, end);
  const decisionPrefix = marker ? originalPrefix.trimEnd() : originalPrefix;
  const projectedEnd = prefixAt(input, end).length;
  const safePrefix = input.text.slice(0, safeCut(input.text, projectedEnd));
  const deliveredPrefix = marker ? safePrefix.trimEnd() : safePrefix;
  const text = deliveredPrefix + marker;
  const decisionText = decisionPrefix + marker;
  if (text === decisionText) return packetText(text);
  return { text, decisionText, prefixAt: nextEnd => nextEnd <= decisionPrefix.length
    ? deliveredPrefix.slice(0, prefixAt(input, nextEnd).length)
    : deliveredPrefix + marker.slice(0, nextEnd - decisionPrefix.length) };
}

function prefixAt(value: PacketText, index: number): string {
  if (index >= value.decisionText.length) return value.text;
  return value.prefixAt?.(index) ?? value.text.slice(0, index);
}
