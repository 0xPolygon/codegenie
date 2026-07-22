import { runGh } from "../git/subprocess.js";
import { CodegenieError, isCodegenieError, type CodegenieErrorCode } from "../util/errors.js";

type RunGh = typeof runGh;

export type IssueComment = {
  id: number;
  body: string;
  author: string;
  authorType?: string;
};

export type IssueCommentClient = {
  listComments(issueNumber: number): Promise<IssueComment[]>;
  createComment(issueNumber: number, body: string): Promise<IssueComment>;
  updateComment(commentId: number, body: string): Promise<void>;
  getCollaboratorPermission(login: string): Promise<string>;
  // The authenticated login, or undefined when the token has no /user
  // context (Actions installation tokens).
  getViewerLogin(): Promise<string | undefined>;
};

type CreateIssueCommentClientOptions = {
  runGh?: RunGh;
};

type GhIssueComment = {
  id?: number;
  body?: string;
  user?: { login?: string; type?: string };
};

// Issue-comment CRUD for the github-action adapter. Deliberately not part of
// the shared src/github/ client: that client is scoped to PR-review posting
// (plan 97 isolation rule), while issue comments exist only for the status
// comment. Composes the same runGh primitive.
export function createIssueCommentClient(
  repoRoot: string,
  repoFullName: string,
  opts: CreateIssueCommentClientOptions = {}
): IssueCommentClient {
  const gh = opts.runGh ?? runGh;
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repoFullName)) {
    throw new CodegenieError("invalid_args", `invalid repository name: ${repoFullName}`);
  }

  return {
    async listComments(issueNumber: number): Promise<IssueComment[]> {
      const comments: IssueComment[] = [];
      for (let page = 1; ; page += 1) {
        const stdout = await gh(
          repoRoot,
          ["api", `repos/${repoFullName}/issues/${issueNumber}/comments?per_page=100&page=${page}`],
          { errorCode: "gh_auth_failed" }
        );
        const parsed = parseJson<GhIssueComment[]>(stdout, "failed to parse issue comments", "gh_auth_failed");
        for (const comment of parsed) {
          const mapped = mapComment(comment);
          if (mapped !== undefined) {
            comments.push(mapped);
          }
        }
        if (parsed.length < 100) {
          break;
        }
      }
      return comments;
    },

    async createComment(issueNumber: number, body: string): Promise<IssueComment> {
      const stdout = await gh(
        repoRoot,
        ["api", `repos/${repoFullName}/issues/${issueNumber}/comments`, "--method", "POST", "--input", "-"],
        { input: JSON.stringify({ body }), errorCode: "github_post_failed" }
      );
      const created = mapComment(parseJson<GhIssueComment>(stdout, "failed to parse created comment", "github_post_failed"));
      if (created === undefined) {
        throw new CodegenieError("github_post_failed", "GitHub did not return the created comment");
      }
      return created;
    },

    async updateComment(commentId: number, body: string): Promise<void> {
      await gh(
        repoRoot,
        ["api", `repos/${repoFullName}/issues/comments/${commentId}`, "--method", "PATCH", "--input", "-"],
        { input: JSON.stringify({ body }), errorCode: "github_post_failed" }
      );
    },

    async getViewerLogin(): Promise<string | undefined> {
      try {
        const stdout = await gh(repoRoot, ["api", "user", "--jq", ".login"], { errorCode: "gh_auth_failed" });
        const login = stdout.trim();
        return login === "" ? undefined : login;
      } catch (error) {
        // Installation tokens do not have a user context. Only that known
        // limitation may fall through to github-actions[bot]; authentication
        // and infrastructure failures must remain visible.
        if (isInstallationTokenUserError(error)) {
          return undefined;
        }
        throw error;
      }
    },

    async getCollaboratorPermission(login: string): Promise<string> {
      const stdout = await gh(
        repoRoot,
        ["api", `repos/${repoFullName}/collaborators/${encodeURIComponent(login)}/permission`, "--jq", ".permission"],
        { errorCode: "gh_auth_failed" }
      );
      return stdout.trim();
    }
  };
}

function isInstallationTokenUserError(error: unknown): boolean {
  if (!isCodegenieError(error)) {
    return false;
  }
  const raw = [error.message, error.context?.stderr, error.context?.stdout]
    .map((value) => (typeof value === "string" ? value : ""))
    .join("\n");
  return /Resource not accessible by integration|\b404\b|Not Found/iu.test(raw);
}

function mapComment(comment: GhIssueComment): IssueComment | undefined {
  if (typeof comment.id !== "number") {
    return undefined;
  }
  const mapped: IssueComment = {
    id: comment.id,
    body: comment.body ?? "",
    author: comment.user?.login ?? ""
  };
  if (comment.user?.type !== undefined) {
    mapped.authorType = comment.user.type;
  }
  return mapped;
}

function parseJson<T>(stdout: string, message: string, code: CodegenieErrorCode): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw new CodegenieError(code, message, { cause: error });
  }
}
