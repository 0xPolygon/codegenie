import type { DeliveredSourceRange } from "../types.js";
import { credentialSafeCut } from "../telemetry/redaction.js";

export const CONTEXT_CUT_MARKER = "\n[... content truncated to fit packet context budget ...]";

/** Keep the original packing coordinates in memory until the text is emitted. */
export type PacketText = {
  text: string;
  decisionText: string;
  prefixAt?: (decisionEnd: number) => string;
  /** Offsets into text, carried through composition and credential-safe clipping. */
  sourceSpans?: Array<{ range: DeliveredSourceRange; lineEnds: number[] }>;
};

export function packetText(text: string): PacketText {
  return { text, decisionText: text };
}

/** Attach coordinates to a source body rendered verbatim at the end of the block. */
export function packetSource(text: string, body: string, path: string, side: DeliveredSourceRange["side"],
  interval?: [number, number], completeBody = body): PacketText {
  if (!interval || !body.length) return packetText(text);
  let end = text.length - body.length;
  const lineEnds = completeBody.split("\n").slice(0, interval[1] - interval[0] + 1).map(line => {
    const lineEnd = end + line.length;
    end = lineEnd + 1;
    return lineEnd;
  }).filter(lineEnd => lineEnd <= text.length);
  return { ...packetText(text), sourceSpans: [{ range: { path, side, lineRange: interval }, lineEnds }] };
}

export function packetTextRanges(value: PacketText): DeliveredSourceRange[] {
  return value.sourceSpans?.flatMap(({ range, lineEnds }) => lineEnds.length
    ? [{ ...range, lineRange: [range.lineRange[0], range.lineRange[0] + lineEnds.length - 1] }] : []) ?? [];
}

export function joinPacketText(parts: PacketText[], separator: string): PacketText {
  const text = parts.map(part => part.text).join(separator);
  const decisionText = parts.map(part => part.decisionText).join(separator);
  let offset = 0;
  const sourceSpans = parts.flatMap(part => {
    const spans = part.sourceSpans?.map(({ range, lineEnds }) => ({ range, lineEnds: lineEnds.map(end => end + offset) })) ?? [];
    offset += part.text.length + separator.length;
    return spans;
  });
  const combined = { text, decisionText, ...(sourceSpans.length ? { sourceSpans } : {}) };
  if (text === decisionText) return combined;
  return { ...combined, prefixAt: end => {
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
  const sourceSpans = input.sourceSpans?.map(({ range, lineEnds }) => ({
    range, lineEnds: lineEnds.filter(lineEnd => lineEnd <= deliveredPrefix.length)
  }));
  const clipped = { text, decisionText, ...(sourceSpans ? { sourceSpans } : {}) };
  if (text === decisionText) return clipped;
  return { ...clipped, prefixAt: nextEnd => nextEnd <= decisionPrefix.length
    ? deliveredPrefix.slice(0, prefixAt(input, nextEnd).length)
    : deliveredPrefix + marker.slice(0, nextEnd - decisionPrefix.length) };
}

function prefixAt(value: PacketText, index: number): string {
  if (index >= value.decisionText.length) return value.text;
  return value.prefixAt?.(index) ?? value.text.slice(0, index);
}
