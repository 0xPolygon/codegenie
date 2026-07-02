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
