import { buildDiffAnchorIndex, validateDiffAnchor } from "../git/diff-parser.js";
import type { DiffAnchor, ReviewPacket, UnifiedDiff } from "../types.js";
import { isCodeninjaError } from "../util/errors.js";

export function isFatalLlmError(error: unknown): boolean {
  return isCodeninjaError(error) &&
    (error.code === "llm_call_failed" || error.code === "llm_schema_invalid") &&
    !isBudgetExhaustedError(error);
}

export function isBudgetExhaustedError(error: unknown): boolean {
  return isCodeninjaError(error) && (error.code === "budget_exhausted" || error.context?.reason === "budget_exhausted");
}

export function isSchemaInvalidError(error: unknown): boolean {
  return isCodeninjaError(error) && error.code === "llm_schema_invalid";
}

export function isRecoverableWorkerError(error: unknown): boolean {
  return !isFatalLlmError(error) && !isBudgetExhaustedError(error);
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
