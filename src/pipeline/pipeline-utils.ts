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
// Anchor reconstruction (plan 76). Tier 1 is precise and publishable: match
// the model's quoted changedCode against the packet's changed lines. Tier 2
// is coarse and gate-only: any changed line proves the packet is on-diff but
// says nothing about placement.

type ChangedLineTarget = {
  normalized: string;
  path: string;
  line: number;
  side: "RIGHT" | "LEFT";
  hunkId: string;
};

const MIN_MATCHABLE_SNIPPET_CHARS = 8;

function normalizeCodeLine(line: string): string {
  return line
    .replace(/^\s*[+-]\s?/, "")
    .replace(/\s+/g, " ")
    .trim();
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

function snippetMatchesTarget(snippet: string, target: string): boolean {
  if (snippet === target) {
    return true;
  }
  // Tolerate truncation/reflow in either direction, but only on substantial
  // lines — containment on short fragments would match everywhere.
  if (snippet.length >= MIN_MATCHABLE_SNIPPET_CHARS && target.length >= MIN_MATCHABLE_SNIPPET_CHARS) {
    return target.includes(snippet) || snippet.includes(target);
  }
  return false;
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

/**
 * Tier 1: reconstruct a precise, publishable anchor by matching the model's
 * quoted changedCode against the packet's changed lines. Conservative by
 * design: ambiguous snippets (matching more than one location) contribute
 * nothing, and reconstruction fails unless the uniquely-matched lines agree
 * on a single hunk. Failure is an expected path — that is what Tier 2 is for.
 */
export function inferAnchorFromChangedCode(packet: ReviewPacket, changedCode: string): DiffAnchor | undefined {
  const targets = changedLineTargets(packet).filter((target) => !isTrivialSnippet(target.normalized));
  if (targets.length === 0) {
    return undefined;
  }
  const uniqueMatches: ChangedLineTarget[] = [];
  for (const rawLine of changedCode.split("\n")) {
    const variants = new Set([normalizeCodeLine(rawLine), normalizeCodeLine(stripLineNumberColumns(rawLine))]);
    for (const snippet of variants) {
      if (isTrivialSnippet(snippet)) {
        continue;
      }
      const matches = targets.filter((target) => snippetMatchesTarget(snippet, target.normalized));
      const distinct = new Set(matches.map((match) => `${match.side}:${match.line}:${match.hunkId}`));
      if (distinct.size === 1) {
        uniqueMatches.push(matches[0]!);
        break;
      }
    }
  }
  if (uniqueMatches.length === 0) {
    return undefined;
  }
  const hunkIds = new Set(uniqueMatches.map((match) => match.hunkId));
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
