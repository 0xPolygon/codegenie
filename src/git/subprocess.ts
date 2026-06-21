import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { execa } from "execa";
import { scrubGitHubSecrets } from "../github/comment-sanitizer.js";
import { stripCredentials } from "../telemetry/redaction.js";
import { CodegenieError, type CodegenieErrorCode } from "../util/errors.js";

export type GitCommandOptions = {
  stripFinalNewline?: boolean;
  timeoutMs?: number;
  network?: boolean;
  allowedExitCodes?: number[];
  errorCode?: CodegenieErrorCode;
  input?: string | Uint8Array | Readable;
  maxBuffer?: number;
};

export type GitCappedCommandOptions = {
  maxBytes: number;
  maxLines: number;
  timeoutMs?: number;
  errorCode?: CodegenieErrorCode;
  allowedExitCodes?: number[];
};

const LOCAL_TIMEOUT_MS = 60_000;
const NETWORK_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

const SAFE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  CLICOLOR: "0"
};

export async function runGit(
  repoRoot: string,
  args: string[],
  opts: GitCommandOptions = {}
): Promise<string> {
  return runCommand("git", repoRoot, args, opts);
}

export async function runGh(
  repoRoot: string,
  args: string[],
  opts: GitCommandOptions = {}
): Promise<string> {
  return runCommand("gh", repoRoot, args, { ...opts, network: true });
}

export async function runGitCapped(
  repoRoot: string,
  args: string[],
  opts: GitCappedCommandOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    const errorCode = opts.errorCode ?? "git_ref_missing";
    const allowedExitCodes = new Set(opts.allowedExitCodes ?? [0]);
    const child = spawn("git", args, {
      cwd: repoRoot,
      env: { ...process.env, ...SAFE_ENV },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let collectedBytes = 0;
    let collectedLines = 0;
    let reachedLimit = false;
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        reachedLimit = false;
        child.kill("SIGTERM");
      }
    }, opts.timeoutMs ?? LOCAL_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      if (reachedLimit) {
        return;
      }
      const remaining = opts.maxBytes - collectedBytes;
      if (remaining > 0) {
        const slice = chunk.subarray(0, Math.max(0, remaining));
        chunks.push(slice);
        collectedBytes += slice.length;
        collectedLines += countByte(slice, 0x0a);
      }
      if (collectedBytes >= opts.maxBytes || collectedLines >= opts.maxLines) {
        reachedLimit = true;
        child.kill("SIGTERM");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      settled = true;
      reject(
        new CodegenieError(errorCode, commandFailureMessage("git", args, error.message), {
          context: scrubSubprocessValue("git", { command: "git", args, error: error.message }),
          cause: error
        })
      );
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      const output = truncateLines(Buffer.concat(chunks).toString("utf8"), opts.maxLines);
      if (reachedLimit || (typeof code === "number" && allowedExitCodes.has(code))) {
        resolve(output);
        return;
      }
      const detail = Buffer.concat(stderrChunks).toString("utf8").trim() || `exit ${code ?? signal ?? "unknown"}`;
      reject(
        new CodegenieError(errorCode, commandFailureMessage("git", args, detail), {
          context: scrubSubprocessValue("git", { command: "git", args, exitCode: code, signal, stderr: detail })
        })
      );
    });
  });
}

async function runCommand(
  command: string,
  repoRoot: string,
  args: string[],
  opts: GitCommandOptions
): Promise<string> {
  const allowedExitCodes = new Set(opts.allowedExitCodes ?? [0]);
  const errorCode = opts.errorCode ?? "git_ref_missing";
  try {
    const result = await execa(command, args, {
      cwd: repoRoot,
      env: SAFE_ENV,
      shell: false,
      reject: false,
      stripFinalNewline: opts.stripFinalNewline ?? true,
      timeout: opts.timeoutMs ?? (opts.network ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS),
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
      ...(opts.input !== undefined ? { input: opts.input } : {})
    });

    if (
      typeof result.exitCode === "number" &&
      !result.timedOut &&
      result.signal === undefined &&
      allowedExitCodes.has(result.exitCode)
    ) {
      return result.stdout;
    }

    const detail = subprocessFailureDetail(result);
    throw new CodegenieError(errorCode, commandFailureMessage(command, args, detail), {
      context: scrubSubprocessValue(command, {
        command,
        args,
        exitCode: result.exitCode,
        failed: result.failed,
        timedOut: result.timedOut,
        isMaxBuffer: result.isMaxBuffer,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr
      })
    });
  } catch (error) {
    if (error instanceof CodegenieError) {
      throw error;
    }
    throw new CodegenieError(errorCode, commandFailureMessage(command, args, errorMessage(error)), {
      context: scrubSubprocessValue(command, {
        command,
        args,
        error: errorMessage(error)
      }),
      cause: error
    });
  }
}

function commandFailureMessage(command: string, args: string[], detail: unknown): string {
  const safeDetail = String(scrubSubprocessValue(command, detail) ?? "").trim();
  const suffix = safeDetail.length > 0 ? `: ${safeDetail}` : "";
  return String(scrubSubprocessValue(command, `${command} ${args.join(" ")} failed${suffix}`));
}

export function scrubSubprocessValue<T>(command: string, value: T): T {
  return command === "gh" ? scrubGitHubSecrets(value) : stripCredentials(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function subprocessFailureDetail(result: {
  stderr: string;
  exitCode?: number;
  failed: boolean;
  timedOut: boolean;
  isMaxBuffer?: boolean;
  signal?: string;
}): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) {
    return stderr;
  }
  if (result.timedOut) {
    return "timed out";
  }
  if (result.signal !== undefined) {
    return `terminated by signal ${result.signal}`;
  }
  if (typeof result.exitCode === "number") {
    return `exit ${result.exitCode}`;
  }
  return result.failed ? "subprocess failed" : "subprocess did not complete successfully";
}

export function assertSafeRef(ref: string, label = "ref"): void {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new CodegenieError("invalid_args", `${label} must be non-empty`);
  }
  if (ref.startsWith("-")) {
    throw new CodegenieError("invalid_args", `${label} must not start with '-'`);
  }
  if (ref === "@") {
    throw new CodegenieError("invalid_args", `${label} is not a valid git ref`);
  }
  if (/[\u0000-\u001f\u007f\s]/u.test(ref)) {
    throw new CodegenieError("invalid_args", `${label} contains invalid whitespace or control characters`);
  }
  if (ref.includes("..") || ref.includes("@{")) {
    throw new CodegenieError("invalid_args", `${label} is not a valid git ref`);
  }
  if (/[~^:?*[\\]/u.test(ref)) {
    throw new CodegenieError("invalid_args", `${label} contains invalid git ref characters`);
  }
  if (ref.startsWith("/") || ref.endsWith("/") || ref.includes("//")) {
    throw new CodegenieError("invalid_args", `${label} is not a valid git ref`);
  }
  if (ref.endsWith(".") || ref.endsWith(".lock")) {
    throw new CodegenieError("invalid_args", `${label} is not a valid git ref`);
  }
  for (const part of ref.split("/")) {
    if (part.length === 0 || part.startsWith(".") || part.endsWith(".lock")) {
      throw new CodegenieError("invalid_args", `${label} is not a valid git ref`);
    }
  }
}

export function assertSafePath(path: string, label = "path"): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new CodegenieError("invalid_args", `${label} must be non-empty`);
  }
  if (path.startsWith("-")) {
    throw new CodegenieError("invalid_args", `${label} must not start with '-'`);
  }
  if (path.includes("\0")) {
    throw new CodegenieError("invalid_args", `${label} contains a NUL byte`);
  }
}

export function assertSafePathspec(pathspec: string, label = "pathspec"): void {
  if (typeof pathspec !== "string" || pathspec.length === 0) {
    throw new CodegenieError("invalid_args", `${label} must be non-empty`);
  }
  if (pathspec.includes("\0")) {
    throw new CodegenieError("invalid_args", `${label} contains a NUL byte`);
  }
}

export function assertSafeGlob(glob: string, label = "glob"): void {
  if (typeof glob !== "string" || glob.length === 0) {
    throw new CodegenieError("invalid_args", `${label} must be non-empty`);
  }
  if (glob.includes("\0")) {
    throw new CodegenieError("invalid_args", `${label} contains a NUL byte`);
  }
}

export function assertSafeRefspec(refspec: string, label = "refspec"): void {
  if (typeof refspec !== "string" || refspec.length === 0) {
    throw new CodegenieError("invalid_args", `${label} must be non-empty`);
  }
  if (refspec.startsWith("-")) {
    throw new CodegenieError("invalid_args", `${label} must not start with '-'`);
  }
  const withoutForce = refspec.startsWith("+") ? refspec.slice(1) : refspec;
  if (withoutForce.length === 0) {
    throw new CodegenieError("invalid_args", `${label} must include a ref`);
  }
  const parts = withoutForce.split(":");
  if (parts.length > 2) {
    throw new CodegenieError("invalid_args", `${label} must be a bare ref or <src>:<dst>`);
  }
  if (parts.some((part) => part.length === 0)) {
    throw new CodegenieError("invalid_args", `${label} must not contain empty ref components`);
  }
  for (const part of parts) {
    assertSafeRef(part, label);
  }
}

export function assertSafeLogRange(range: string): void {
  if (range.endsWith("^!")) {
    assertSafeRef(range.slice(0, -2), "log range");
    return;
  }

  const parts = range.split("..");
  if (parts.length === 2 && parts[0] && parts[1]) {
    assertSafeRef(parts[0], "log range start");
    assertSafeRef(parts[1], "log range end");
    return;
  }

  assertSafeRef(range, "log range");
}

function countByte(buffer: Buffer, byte: number): number {
  let count = 0;
  for (const value of buffer) {
    if (value === byte) {
      count += 1;
    }
  }
  return count;
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split(/\n/u);
  if (lines.length <= maxLines) {
    return text;
  }
  return lines.slice(0, maxLines).join("\n");
}
