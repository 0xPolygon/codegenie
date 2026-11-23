import type { ToolResultMeta } from "../types.js";

// Shared by normal tool delivery and bounded result packing.
export const MISSING_FILE_GUIDANCE = "The requested file does not exist at the selected revision. Discover an existing path with list_files (head only), or search_files/find_definition with the intended source revision, then read that path. Do not infer that the implementation is absent or retry a guessed filename with different line bounds.";
const SIX_MISSING_FILE_GUIDANCE = "The requested file does not exist at the selected revision. Find an existing path with list_files (head only), search_files with the intended source, or read_definition with name and source and without path. Then read the returned path. Do not infer that the implementation is absent or retry a guessed filename with different line bounds.";

export function renderSourceBlockHeader(
  path: string, source: string, range: readonly [number, number], totalLines: number, kind?: "declaration"
): string {
  return `${path}@${source} ${kind ? `${kind} ` : ""}lines ${range[0]}-${range[1]} of ${totalLines}`;
}

export function numberSourceLine(line: string, lineNumber: number): string {
  return `${lineNumber}\t${line}`;
}

export function withMeta(text: string, meta: ToolResultMeta, deliveryNotes: string[] = []): string {
  return renderMeta(text, meta, deliveryNotes, false);
}

export function withSixToolMeta(text: string, meta: ToolResultMeta, deliveryNotes: string[] = []): string {
  return renderMeta(text, meta, deliveryNotes, true);
}

function renderMeta(text: string, meta: ToolResultMeta, deliveryNotes: string[], six: boolean): string {
  const notes: string[] = [];
  if (meta.requestedSource !== undefined || meta.sourceUsed !== undefined) {
    notes.push(`source: requested ${meta.requestedSource ?? "unspecified"}, used ${meta.sourceUsed ?? "unknown"}`);
  }
  if (meta.sourceFallback) {
    notes.push("source fallback: head to base");
  }
  if (meta.baseOnly) {
    notes.push("symbol exists only in base");
  }
  if (meta.lookupStatus !== undefined) {
    notes.push(`lookup: ${meta.lookupStatus}`);
  }
  if (meta.lookupNote !== undefined) {
    notes.push(meta.lookupNote);
  }
  if (meta.lookupStatus === "file_missing") {
    notes.push(six ? SIX_MISSING_FILE_GUIDANCE : MISSING_FILE_GUIDANCE);
  }
  if (meta.deliveryStatus !== undefined) {
    notes.push(`delivery: ${meta.deliveryStatus}`);
  }
  if (meta.recovery !== undefined) {
    const sourceArgument = six ? JSON.stringify({ kind: meta.recovery.source }) : meta.recovery.source;
    notes.push(
      `recovery: call ${meta.recovery.tool} path=${meta.recovery.path} startLine=${String(meta.recovery.startLine)} endLine=${String(meta.recovery.endLine)} source=${sourceArgument}`
    );
    notes.push(`recovery reason: ${meta.recovery.reason}`);
  }
  if (meta.degraded) {
    notes.push(`degraded${meta.degradationReason ? `: ${meta.degradationReason}` : ""}`);
  }
  if (meta.truncated) {
    notes.push(`truncated${meta.omittedCount ? `: ${meta.omittedCountIsLowerBound ? "at least " : ""}${meta.omittedCount} omitted` : ""}`);
  }
  notes.push(...deliveryNotes);
  const request = meta.requestedRange;
  if (request && meta.totalLines !== undefined && !meta.deliveredLineRange) {
    const target = `${request.path}@${meta.sourceUsed}`;
    const span = `requested lines ${request.startLine}-${request.endLine}`;
    notes.push(`${target} has ${meta.totalLines} lines; ${span}; delivered lines: none`);
    if (meta.truncated && request.startLine <= meta.totalLines) {
      notes.push(`next undelivered line: ${request.startLine}`);
    }
  }
  if (request && meta.truncated && meta.degradationReason && deliveryNotes.length === 0) {
    notes.push(`truncation: ${meta.degradationReason}`);
  }
  if (meta.truncated && meta.deliveredLineRange && (!request || meta.deliveredLineRange[1] < request.endLine)) {
    const [first, last] = meta.deliveredLineRange;
    const total = meta.totalLines === undefined ? "" : ` of ${meta.totalLines}`;
    const requestedEnd = request ? `, endLine=${request.endLine}` : "";
    notes.push(`delivered lines ${first}-${last}${total}`);
    notes.push(`continue with startLine=${last + 1}${requestedEnd}`);
  }
  return notes.length > 0 ? `${text}\n\n[tool meta: ${notes.join("; ")}]` : text;
}
