import type { ReviewStage } from "../types.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import { CodegenieError, type CodegenieErrorCode } from "../util/errors.js";

type GuardTelemetry = {
  telemetry?: TelemetryRecorder;
  stage?: ReviewStage;
  toolName?: string;
};

export function containPath(repoRoot: string, input: string, opts: GuardTelemetry = {}): string {
  return guardPathLike(repoRoot, input, "path", opts);
}

export function containGlob(repoRoot: string, input: string, opts: GuardTelemetry = {}): string {
  return guardPathLike(repoRoot, input, "glob", opts);
}

export function containRef(ref: string): string {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new CodegenieError("invalid_args", "ref must be non-empty");
  }
  if (ref.startsWith("-")) {
    throw new CodegenieError("invalid_args", "ref must not start with '-'");
  }
  if (/^[0-9a-fA-F]{4,64}$/u.test(ref)) {
    return ref;
  }
  if (ref === "@" || ref.startsWith("/") || ref.endsWith("/") || ref.includes("//")) {
    throw new CodegenieError("invalid_args", "ref is not a valid git ref");
  }
  if (/[\u0000-\u001f\u007f\s]/u.test(ref)) {
    throw new CodegenieError("invalid_args", "ref contains invalid whitespace or control characters");
  }
  if (ref.includes("..") || ref.includes("@{")) {
    throw new CodegenieError("invalid_args", "ref is not a valid git ref");
  }
  if (/[~^:?*[\\]/u.test(ref)) {
    throw new CodegenieError("invalid_args", "ref contains invalid git ref characters");
  }
  if (ref.endsWith(".") || ref.endsWith(".lock")) {
    throw new CodegenieError("invalid_args", "ref is not a valid git ref");
  }
  for (const part of ref.split("/")) {
    if (part.length === 0 || part.startsWith(".") || part.endsWith(".lock")) {
      throw new CodegenieError("invalid_args", "ref is not a valid git ref");
    }
  }
  return ref;
}

function guardPathLike(repoRoot: string, input: string, label: "path" | "glob", opts: GuardTelemetry): string {
  void repoRoot;
  if (typeof input !== "string" || input.length === 0) {
    throwViolation("path_outside_repo", `${label} must be non-empty`, input, opts);
  }
  if (input.includes("\0")) {
    throwViolation("path_outside_repo", `${label} contains a NUL byte`, input, opts);
  }
  if (input.startsWith("/") || input.startsWith("//")) {
    throwViolation("path_outside_repo", `${label} must be repo-relative`, input, opts);
  }
  if (input.includes("\\")) {
    throwViolation("path_outside_repo", `${label} must use POSIX separators`, input, opts);
  }

  const parts = input.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) {
    throwViolation("path_outside_repo", `${label} must not contain '..'`, input, opts);
  }
  if (parts[0] === ".git") {
    throwViolation("path_outside_repo", `${label} must not address .git`, input, opts);
  }
  const normalized = parts.join("/");
  if (normalized.length === 0) {
    throwViolation("path_outside_repo", `${label} must be non-empty`, input, opts);
  }
  return normalized;
}

function throwViolation(
  code: CodegenieErrorCode,
  message: string,
  input: string,
  opts: GuardTelemetry
): never {
  opts.telemetry?.event({
    stage: opts.stage ?? 4,
    level: "warn",
    message: "path containment violation",
    data: {
      toolName: opts.toolName,
      reason: message,
      input: truncateForTelemetry(input)
    }
  });
  throw new CodegenieError(code, message, {
    context: {
      input: truncateForTelemetry(input)
    }
  });
}

function truncateForTelemetry(value: string): string {
  return value.length <= 200 ? value : `${value.slice(0, 200)}...`;
}
