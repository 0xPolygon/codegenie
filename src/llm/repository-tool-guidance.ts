import type { ToolResultMeta } from "../types.js";

// Shared by normal tool delivery and bounded result packing.
export const MISSING_FILE_GUIDANCE = "The requested file does not exist at the selected revision. Discover an existing path with list_files (head only), or search_files/find_definition with the intended source revision, then read that path. Do not infer that the implementation is absent or retry a guessed filename with different line bounds.";

export function withMeta(text: string, meta: ToolResultMeta, deliveryNotes: string[] = []): string {
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
  if (meta.lookupStatus === "file_missing") {
    notes.push(MISSING_FILE_GUIDANCE);
  }
  if (meta.deliveryStatus !== undefined) {
    notes.push(`delivery: ${meta.deliveryStatus}`);
  }
  if (meta.recovery !== undefined) {
    notes.push(
      `recovery: call ${meta.recovery.tool} path=${meta.recovery.path} startLine=${String(meta.recovery.startLine)} endLine=${String(meta.recovery.endLine)} source=${meta.recovery.source}`
    );
  }
  if (meta.degraded) {
    notes.push(`degraded${meta.degradationReason ? `: ${meta.degradationReason}` : ""}`);
  }
  if (meta.truncated) {
    notes.push(`truncated${meta.omittedCount ? `: ${meta.omittedCountIsLowerBound ? "at least " : ""}${meta.omittedCount} omitted` : ""}`);
  }
  notes.push(...deliveryNotes);
  return notes.length > 0 ? `${text}\n\n[tool meta: ${notes.join("; ")}]` : text;
}
