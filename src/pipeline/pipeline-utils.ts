import { buildDiffAnchorIndex, validateDiffAnchor } from "../git/diff-parser.js";
import type { DiffAnchor, ReviewPacket, UnifiedDiff } from "../types.js";
import { isCodegenieError } from "../util/errors.js";

export function isRunFatalLlmError(error: unknown): boolean {
  return isLlmFailure(error) && errorField(error, "recoverable") !== true;
}

export function isRecoverableLlmError(error: unknown): boolean {
  return isLlmFailure(error) && errorField(error, "recoverable") === true;
}

function isLlmFailure(error: unknown): boolean {
  return isCodegenieError(error) &&
    (error.code === "llm_call_failed" || error.code === "llm_schema_invalid") &&
    !isBudgetExhaustedError(error);
}

export function isProviderOutageError(error: unknown): boolean {
  return isCodegenieError(error) &&
    error.code === "llm_call_failed" &&
    errorField(error, "recoverable") === true &&
    errorContextReason(error) === "transient_error";
}

export function isBudgetExhaustedError(error: unknown): boolean {
  return errorField(error, "code") === "budget_exhausted" || errorContextReason(error) === "budget_exhausted";
}

export function isSchemaInvalidError(error: unknown): boolean {
  return isCodegenieError(error) && error.code === "llm_schema_invalid";
}

export function isRecoverableTransientLlmError(error: unknown): boolean {
  if (errorField(error, "code") !== "llm_call_failed" || errorField(error, "recoverable") !== true) {
    return false;
  }
  const reason = errorContextReason(error);
  return reason === "transient_error" || reason === "timeout";
}

export function isRecoverableWorkerError(error: unknown): boolean {
  // Pass-timeout errors are excluded from the one transient re-dispatch: a
  // pass that burned its soft+grace time budget should not be replayed in
  // full (plan 85) — the retry economics are worse than the grace already
  // granted. Provider blips (transient_error) remain re-dispatchable.
  return !isRunFatalLlmError(error) &&
    !isBudgetExhaustedError(error) &&
    errorContextReason(error) !== "timeout";
}

function errorContextReason(error: unknown): unknown {
  const context = errorField(error, "context");
  return context && typeof context === "object" ? (context as Record<string, unknown>).reason : undefined;
}

function errorField(error: unknown, field: string): unknown {
  return error && typeof error === "object" ? (error as Record<string, unknown>)[field] : undefined;
}

export function validateAnchorForPacket(anchor: DiffAnchor | undefined, packet: ReviewPacket): DiffAnchor | undefined {
  if (!anchor) {
    return undefined;
  }
  const expectedPath = anchor.side === "LEFT" ? packet.oldPath ?? packet.path : packet.path;
  if (anchor.path !== expectedPath) {
    return undefined;
  }
  const hunk = packet.hunks.find((candidate) => candidate.hunkId === anchor.hunkId);
  if (!hunk) {
    return undefined;
  }
  const changedLine =
    anchor.side === "RIGHT"
      ? hunk.changedNewLineNumbers.includes(anchor.line)
      : hunk.changedOldLineNumbers.includes(anchor.line);
  return changedLine ? anchor : undefined;
}

export function validateAnchorForDiff(anchor: DiffAnchor | undefined, diff: UnifiedDiff | undefined): DiffAnchor | undefined {
  if (!anchor || !diff) {
    return undefined;
  }
  const validation = validateDiffAnchor(anchor, buildDiffAnchorIndex(diff));
  return validation.valid ? anchor : undefined;
}

// ---------------------------------------------------------------------------
// Recover coordinates only from exact changed-line quotes, never semantic guesses.

type ChangedLineTarget = {
  normalized: string;
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  hunkId: string;
};

const MIN_MATCHABLE_SNIPPET_CHARS = 8;

function normalizeCodeLine(line: string): string {
  // Preserve internal whitespace: it may be part of a string literal.
  return line.trim();
}

// Models sometimes quote code copied from contentWithLineNumbers, which
// prefixes one or two line-number columns.
function stripLineNumberColumns(line: string): string {
  return line.replace(/^\s*\d+(?:\s+\d+)?\s{2,}/, "");
}

function isTrivialSnippet(normalized: string): boolean {
  if (normalized.length < MIN_MATCHABLE_SNIPPET_CHARS) {
    return true;
  }
  return /^[{}()[\];,.:\s]*$/.test(normalized);
}

function changedLineTargets(packet: ReviewPacket): ChangedLineTarget[] {
  const targets: ChangedLineTarget[] = [];
  for (const hunk of packet.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add" && line.newLine !== undefined) {
        targets.push({ normalized: normalizeCodeLine(line.content), path: packet.path, line: line.newLine, side: "RIGHT", hunkId: hunk.hunkId });
      } else if (line.kind === "delete" && line.oldLine !== undefined) {
        targets.push({ normalized: normalizeCodeLine(line.content), path: packet.oldPath ?? packet.path, line: line.oldLine, side: "LEFT", hunkId: hunk.hunkId });
      }
    }
  }
  return targets;
}

/** Exact quote recovery across the full diff (or a packet for standalone consumers).
 * Ambiguous matches and matches spanning files, sides, or hunks remain unresolved.
 */
export function inferAnchorFromChangedCode(packet: ReviewPacket | UnifiedDiff, changedCode: string): DiffAnchor | undefined {
  const targets = ("files" in packet ? packet.files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines.flatMap((line): ChangedLineTarget[] => {
    const side = line.kind === "add" ? "RIGHT" : line.kind === "delete" ? "LEFT" : undefined;
    const number = side === "RIGHT" ? line.newLineNumber : line.oldLineNumber;
    return side && number !== undefined ? [{ normalized: normalizeCodeLine(line.content), path: side === "LEFT" ? file.oldPath ?? file.path : file.path, line: number, side, hunkId: hunk.id }] : [];
  }))) : changedLineTargets(packet)).filter((target) => !isTrivialSnippet(target.normalized));
  if (targets.length === 0) {
    return undefined;
  }
  const uniqueMatches: ChangedLineTarget[] = [];
  let explicitDiff = false;
  for (const rawLine of changedCode.split("\n")) {
    if (/^\s*(?:```|~~~)diff\s*$/i.test(rawLine) || /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(rawLine)) {
      explicitDiff = true;
      continue;
    }
    if (/^\s*(?:```|~~~)\s*$/.test(rawLine)) {
      explicitDiff = false;
      continue;
    }
    const numbered = stripLineNumberColumns(rawLine);
    // A bare leading +/- may be a unary operator. Only displayed line
    // columns or explicit diff notation justify removing a diff prefix.
    const variants = new Set([rawLine, numbered].map(normalizeCodeLine));
    const diffPrefix = explicitDiff || numbered !== rawLine ? /^\s*([+-])/.exec(numbered)?.[1] : undefined;
    if (diffPrefix !== undefined) {
      variants.clear();
      variants.add(normalizeCodeLine(numbered.replace(/^\s*[+-] ?/, "")));
    }
    const expectedSide = diffPrefix === "+" ? "RIGHT" : diffPrefix === "-" ? "LEFT" : undefined;
    const matches = targets.filter((target) => variants.has(target.normalized) && (expectedSide === undefined || target.side === expectedSide));
    const distinct = new Set(matches.map((match) => `${match.path}:${match.side}:${match.line}:${match.hunkId}`));
    if (distinct.size > 1) return undefined;
    if (distinct.size === 1) uniqueMatches.push(matches[0]!);
  }

  if (uniqueMatches.length === 0) {
    return undefined;
  }
  const hunkIds = new Set(uniqueMatches.map((match) => `${match.path}:${match.side}:${match.hunkId}`));
  if (hunkIds.size > 1) {
    return undefined;
  }
  const chosen = uniqueMatches[0]!;
  return { path: chosen.path, line: chosen.line, side: chosen.side, hunkId: chosen.hunkId };
}

/**
 * Tier 2: coarse, gate-only representative anchor — the packet's first
 * changed line. Proves on-diff-ness by construction; may point at the wrong
 * line. Consumers must treat anchorSource "backfill_packet_representative"
 * as unpublishable (see plan 76).
 */
export function representativeAnchorFromPacket(packet: ReviewPacket): DiffAnchor | undefined {
  for (const hunk of packet.hunks) {
    const line = hunk.changedNewLineNumbers[0];
    if (line !== undefined) {
      return { path: packet.path, line, side: "RIGHT", hunkId: hunk.hunkId };
    }
  }
  for (const hunk of packet.hunks) {
    const line = hunk.changedOldLineNumbers[0];
    if (line !== undefined) {
      return { path: packet.oldPath ?? packet.path, line, side: "LEFT", hunkId: hunk.hunkId };
    }
  }
  return undefined;
}

/** Numbered diff context follows the finding location, independently of discovery. */
export function findingDiffContext(diff: UnifiedDiff | undefined, paths: readonly string[], hunkId?: string): string {
  return diff?.files.filter((file) => paths.includes(file.path) || (file.oldPath !== undefined && paths.includes(file.oldPath)))
    .flatMap((file) => file.hunks.filter((hunk) => hunkId === undefined || hunk.id === hunkId).map((hunk) =>
      `File: ${file.path}${file.oldPath ? ` (old: ${file.oldPath})` : ""}\nHunk: ${hunk.id}\n${hunk.lines.map((line) =>
        `${line.oldLineNumber ?? "-"} ${line.newLineNumber ?? "-"} ${line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "}${line.content}`).join("\n")}`)).join("\n\n") ?? "";
}
