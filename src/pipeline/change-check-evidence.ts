import { containPath } from "../repo/path-guard.js";
import type { LlmSubmitSemanticValidation } from "../llm/llm-runner.js";
import { CHANGE_CHECK_KINDS, CHANGE_CHECK_RESULTS, type SubmittedChangeCheck, type SubmitPacketReview } from "../llm/schemas.js";
import type { ChangeCheckResult, ChangeCheckReference, DeliveredSourceRange, ReviewPacket, UnifiedDiff } from "../types.js";
import { diffRowRanges, mergeDeliveredRanges } from "../util/delivered-source.js";

export function validateChangeChecks(value: SubmitPacketReview, assigned: ReadonlySet<string>): LlmSubmitSemanticValidation {
  const reject = (details: string): LlmSubmitSemanticValidation => ({ ok: false, classification: "change_check_invalid", details });
  if (!value.changeChecks) return reject("Submit the changeChecks array.");
  const identities = new Set<string>();
  const counts = new Map<string, number>();
  for (const [index, row] of value.changeChecks.entries()) {
    const prefix = `changeChecks.${index}`;
    if (!assigned.has(row.hunkId)) return reject(`${prefix}.hunkId must belong to this packet.`);
    const count = (counts.get(row.hunkId) ?? 0) + 1;
    if (count > 2) return reject(`${prefix}: at most two rows per hunk.`);
    counts.set(row.hunkId, count);
    const identity = JSON.stringify([row.hunkId, row.changeKind, row.before, row.after, row.breakAttempt]);
    if (identities.has(identity)) return reject(`${prefix}: duplicate change check.`);
    identities.add(identity);
    const unchanged = row.result === "no_behavior_change";
    if (unchanged !== (row.changeKind === "no_behavior_change") || unchanged !== (row.breakAttempt.trim() === "")) {
      return reject(`${prefix}: no_behavior_change requires matching kind and result and an empty breakAttempt. Every other result needs a concrete breakAttempt.`);
    }
    if (!row.before.trim() || !row.after.trim()) return reject(`${prefix}: before and after must state observable behavior.`);
    const target = row.result === "finding" ? value.findings : row.result === "question" ? value.followUpHints : undefined;
    if (target ? row.ref === undefined || !Number.isInteger(row.ref) || row.ref < 0 || row.ref >= target.length : row.ref !== undefined) {
      return reject(`${prefix}.ref must index the submitted ${row.result === "finding" ? "findings" : "followUpHints"} for linked rows and be omitted otherwise.`);
    }
    const pointer = row.checkedAt;
    if ((row.result === "ruled_out") !== (pointer !== undefined)) {
      return reject(`${prefix}.checkedAt is required for ruled_out and omitted otherwise.`);
    }
    if (pointer && pointer.lineRange[0] > pointer.lineRange[1]) return reject(`${prefix}.checkedAt.lineRange must be ordered.`);
  }
  if (value.reviewStatus !== "incomplete") {
    const missing = [...assigned].filter(hunkId => !counts.has(hunkId));
    if (missing.length) return reject(`Completed review is missing changeChecks for ${missing.join(", ")}.`);
  }
  return { ok: true };
}

const POINTER_STATUSES = ["traceable", "inside_changed_rows", "source_not_delivered", "line_clipped", "pointer_missing"] as const;

export function sourcePointerStatus(
  pointer: SubmittedChangeCheck["checkedAt"],
  delivered: readonly DeliveredSourceRange[],
  changedLines: ReadonlySet<number>
): NonNullable<ChangeCheckResult["pointerStatus"]> {
  if (!pointer) return "pointer_missing";
  const path = checkedRepoPath(pointer.path);
  if (path === undefined) return "source_not_delivered";
  const ranges = delivered.filter(range => range.path === path && range.side === pointer.side);
  if (!ranges.length) return "source_not_delivered";
  const [start, end] = pointer.lineRange;
  if (!mergeDeliveredRanges(ranges).some(range => range.lineRange[0] <= start && range.lineRange[1] >= end)) return "line_clipped";
  let changed = 0;
  for (const line of changedLines) if (line >= start && line <= end) changed++;
  return changed === end - start + 1 ? "inside_changed_rows" : "traceable";
}

export function attestChangeChecks(input: {
  rows: SubmittedChangeCheck[];
  packet: ReviewPacket;
  delivered: DeliveredSourceRange[];
  diff: UnifiedDiff | undefined;
  findings: ChangeCheckReference[];
  hints: Map<number, ChangeCheckReference>;
}): ChangeCheckResult[] {
  const { packet } = input;
  const packetRanges = packet.hunks.flatMap(hunk => hunk.lines.flatMap(row => {
    const partial = hunk.partialChangedLine;
    if (partial && (partial.side === "old" ? row.oldLine : row.newLine) === partial.line) return [];
    return diffRowRanges(packet.path, packet.oldPath, row.oldLine, row.newLine);
  }));
  const delivered = mergeDeliveredRanges([...packetRanges, ...(packet.contextDeliveredRanges ?? []), ...input.delivered]);
  return input.rows.map(({ ref, ...row }) => {
    const reference = ref === undefined ? undefined
      : row.result === "finding" ? input.findings[ref] : input.hints.get(ref);
    const pointer = row.checkedAt;
    return {
      ...row,
      ...(ref !== undefined ? { refIndex: ref, ...reference } : {}),
      ...(row.result === "ruled_out"
        ? { pointerStatus: sourcePointerStatus(pointer, delivered, pointer ? changedAt(input.diff, packet, pointer) : new Set()) }
        : {})
    };
  });
}

function checkedRepoPath(path: string): string | undefined {
  // The path guard normalizes repository-relative aliases without reading files.
  try { return containPath("", path); } catch { return undefined; }
}

function changedAt(diff: UnifiedDiff | undefined, packet: ReviewPacket, pointer: DeliveredSourceRange): Set<number> {
  const base = pointer.side === "base";
  const path = checkedRepoPath(pointer.path);
  if (!diff) {
    if (path !== (base ? packet.oldPath ?? packet.path : packet.path)) return new Set();
    return new Set(packet.hunks.flatMap(hunk => base ? hunk.changedOldLineNumbers : hunk.changedNewLineNumbers));
  }
  const files = diff.files.filter(file => (base ? file.oldPath ?? file.path : file.path) === path);
  const changed = new Set<number>();
  for (const file of files) for (const hunk of file.hunks) for (const row of hunk.lines) {
    const line = base ? (row.kind === "delete" ? row.oldLineNumber : undefined)
      : (row.kind === "add" ? row.newLineNumber : undefined);
    if (line !== undefined) changed.add(line);
  }
  return changed;
}

export function changeCheckCounts(rows: readonly ChangeCheckResult[], assignedHunks: number, rowCausedRepairs: number, enabled: boolean) {
  const hunksCovered = new Set(rows.map(row => row.hunkId)).size;
  return {
    enabled,
    rowsSubmitted: rows.length,
    hunksCovered,
    hunksMissed: enabled ? assignedHunks - hunksCovered : 0,
    byKind: Object.fromEntries(CHANGE_CHECK_KINDS.map(kind => [kind, rows.filter(row => row.changeKind === kind).length])),
    byResult: Object.fromEntries(CHANGE_CHECK_RESULTS.map(result => [result, rows.filter(row => row.result === result).length])),
    pointerStatus: Object.fromEntries(POINTER_STATUSES.map(status => [status, rows.filter(row => row.pointerStatus === status).length])),
    rowCausedRepairs
  };
}
