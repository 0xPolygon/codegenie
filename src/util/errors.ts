import { stripCredentials } from "../telemetry/redaction.js";

export type CodeninjaErrorCode =
  | "not_git_worktree"
  | "invalid_args"
  | "config_error"
  | "gh_missing"
  | "gh_auth_failed"
  | "pr_not_found"
  | "git_ref_missing"
  | "git_base_branch_unresolved"
  | "git_fetch_failed"
  | "diff_parse_failed"
  | "parser_unavailable"
  | "skill_invalid"
  | "path_outside_repo"
  | "llm_call_failed"
  | "llm_schema_invalid"
  | "github_post_failed"
  | "budget_exhausted"
  | "timeout";

export class CodeninjaError extends Error {
  readonly code: CodeninjaErrorCode;
  readonly recoverable: boolean;
  readonly context?: Record<string, unknown>;

  constructor(
    code: CodeninjaErrorCode,
    message: string,
    opts: { recoverable?: boolean; context?: Record<string, unknown>; cause?: unknown } = {}
  ) {
    super(message, { cause: opts.cause });
    this.name = "CodeninjaError";
    this.code = code;
    this.recoverable = opts.recoverable ?? false;
    if (opts.context) {
      this.context = stripCredentials(opts.context);
    }
  }

  toJSON(): {
    name: string;
    code: CodeninjaErrorCode;
    message: string;
    recoverable: boolean;
    context?: Record<string, unknown>;
  } {
    const output = {
      name: this.name,
      code: this.code,
      message: this.message,
      recoverable: this.recoverable
    };
    return this.context ? { ...output, context: this.context } : output;
  }
}

export function isCodeninjaError(error: unknown): error is CodeninjaError {
  return error instanceof CodeninjaError;
}

export function errorExitCode(error: unknown): number {
  if (!isCodeninjaError(error)) {
    return 1;
  }

  switch (error.code) {
    case "invalid_args":
    case "config_error":
    case "not_git_worktree":
    case "git_ref_missing":
    case "git_base_branch_unresolved":
    case "diff_parse_failed":
      return 2;
    default:
      return 1;
  }
}
