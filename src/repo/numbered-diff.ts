import type { DiffLine, PacketLine } from "../types.js";

export function renderNumberedDiffLine(line: PacketLine): string {
  const oldLine = line.oldLine === undefined ? "" : String(line.oldLine);
  const newLine = line.newLine === undefined ? "" : String(line.newLine);
  const marker = line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " ";
  return `${oldLine.padStart(4)} ${newLine.padStart(4)} ${marker}${line.content}`;
}

export function packetDiffLine(line: DiffLine): PacketLine {
  return {
    kind: line.kind,
    content: line.content,
    ...(line.oldLineNumber !== undefined ? { oldLine: line.oldLineNumber } : {}),
    ...(line.newLineNumber !== undefined ? { newLine: line.newLineNumber } : {})
  };
}
