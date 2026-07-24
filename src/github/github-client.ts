import type {
  ExistingReviewThread,
  GitHubClient,
  InlineCommentInput,
  PullRequestMetadata
} from "../types.js";
import { CodegenieError, isCodegenieError, type CodegenieErrorCode } from "../util/errors.js";
import { runGh } from "../git/subprocess.js";
import { parseCodegenieMarker } from "./duplicate-detector.js";

type RunGh = typeof runGh;

type CreateGitHubClientOptions = {
  runGh?: RunGh;
};

type RepoMetadata = {
  owner: string;
  repo: string;
};

type GhPrView = {
  number?: number;
  title?: string;
  body?: string;
  url?: string;
  baseRefName?: string;
  headRefName?: string;
  baseRefOid?: string;
  headRefOid?: string;
};

type GhPullRest = {
  base?: { sha?: string };
  head?: { sha?: string };
};

type GhReviewComment = {
  id?: number | string;
  path?: string;
  side?: string;
  line?: number | null;
  original_line?: number | null;
  body?: string;
  user?: { login?: string };
};

export function createGitHubClient(repoRoot: string, opts: CreateGitHubClientOptions = {}): GitHubClient {
  const gh = opts.runGh ?? runGh;
  let repo: RepoMetadata | undefined;
  let viewerLogin: string | undefined;
  let preflightDone = false;
  const prCache = new Map<number, PullRequestMetadata>();

  async function preflight(): Promise<void> {
    if (preflightDone) {
      return;
    }
    await gh(repoRoot, ["--version"], { errorCode: "gh_missing" });
    try {
      await gh(repoRoot, ["auth", "status"], { errorCode: "gh_auth_failed" });
    } catch {
      // Actions installation tokens have no /user context, so `gh auth status`
      // reports them invalid even though they authenticate API calls fine.
      // Probe an endpoint any valid token can reach; a genuinely bad token
      // fails this too and surfaces the same gh_auth_failed.
      await gh(repoRoot, ["api", "rate_limit"], { errorCode: "gh_auth_failed" });
    }
    preflightDone = true;
  }

  async function loadRepo(): Promise<RepoMetadata> {
    if (repo !== undefined) {
      return repo;
    }
    await preflight();
    const stdout = await gh(repoRoot, ["repo", "view", "--json", "owner,name"], { errorCode: "gh_auth_failed" });
    const parsed = parseJson<Record<string, unknown>>(stdout, "failed to parse gh repo metadata", "gh_auth_failed");
    const owner = ownerLogin(parsed.owner);
    const name = stringField(parsed.name);
    if (!owner || !name) {
      throw new CodegenieError("gh_auth_failed", "gh repo view did not return owner/name metadata");
    }
    repo = { owner, repo: name };
    return repo;
  }

  async function loadViewerLogin(): Promise<string> {
    if (viewerLogin !== undefined) {
      return viewerLogin;
    }
    await preflight();
    try {
      const stdout = await gh(repoRoot, ["api", "user", "--jq", ".login"], { errorCode: "gh_auth_failed" });
      const login = stdout.trim();
      if (login.length === 0) {
        throw new CodegenieError("gh_auth_failed", "gh api user did not return the authenticated login");
      }
      viewerLogin = login;
    } catch (error) {
      // Actions installation tokens have no /user context; the github-action
      // adapter injects the bot login it read back from the status comment.
      const fallback = process.env.CODEGENIE_GITHUB_LOGIN?.trim();
      if (fallback === undefined || fallback === "") {
        throw error;
      }
      viewerLogin = fallback;
    }
    return viewerLogin;
  }

  async function viewPr(number: number, viewOpts: { refresh?: boolean } = {}): Promise<PullRequestMetadata> {
    if (viewOpts.refresh !== true) {
      const cached = prCache.get(number);
      if (cached !== undefined) {
        return cached;
      }
    }
    const loadedRepo = await loadRepo();
    const fields = [
      "number",
      "title",
      "body",
      "url",
      "baseRefName",
      "headRefName",
      "baseRefOid",
      "headRefOid"
    ].join(",");
    const stdout = await gh(repoRoot, ["pr", "view", String(number), "--json", fields], {
      errorCode: "pr_not_found"
    });
    const prView = parseJson<GhPrView>(stdout, "failed to parse gh PR metadata", "pr_not_found");
    const rest = !prView.baseRefOid || !prView.headRefOid
      ? await loadPullRest(loadedRepo, number)
      : undefined;
    const metadata: PullRequestMetadata = {
      owner: loadedRepo.owner,
      repo: loadedRepo.repo,
      number: prView.number ?? number,
      title: prView.title ?? "",
      body: prView.body ?? "",
      url: prView.url ?? "",
      baseRefName: prView.baseRefName ?? "",
      baseSha: prView.baseRefOid ?? rest?.base?.sha ?? missingPrSha("base", number),
      headRefName: prView.headRefName ?? "",
      headSha: prView.headRefOid ?? rest?.head?.sha ?? missingPrSha("head", number)
    };
    prCache.set(number, metadata);
    return metadata;
  }

  async function loadPullRest(loadedRepo: RepoMetadata, number: number): Promise<GhPullRest> {
    const stdout = await gh(repoRoot, ["api", `repos/${loadedRepo.owner}/${loadedRepo.repo}/pulls/${number}`], {
      errorCode: "pr_not_found"
    });
    return parseJson<GhPullRest>(stdout, "failed to parse gh PR REST metadata", "pr_not_found");
  }

  return {
    viewPr,

    async createReview(
      number: number,
      review: { body: string; event: "COMMENT"; comments: InlineCommentInput[] }
    ): Promise<void> {
      const pr = prCache.get(number) ?? await viewPr(number);
      const loadedRepo = await loadRepo();
      const payload = {
        body: review.body,
        event: review.event,
        commit_id: pr.headSha,
        comments: review.comments
      };
      try {
        await gh(repoRoot, ["api", `repos/${loadedRepo.owner}/${loadedRepo.repo}/pulls/${number}/reviews`, "--method", "POST", "--input", "-"], {
          input: JSON.stringify(payload),
          errorCode: "github_post_failed"
        });
      } catch (error) {
        throw normalizeCreateReviewError(error);
      }
    },

    async listOwnComments(number: number): Promise<ExistingReviewThread[]> {
      const [loadedRepo, viewer] = await Promise.all([loadRepo(), loadViewerLogin()]);
      const own: ExistingReviewThread[] = [];
      for (let page = 1; ; page += 1) {
        const stdout = await gh(
          repoRoot,
          ["api", `repos/${loadedRepo.owner}/${loadedRepo.repo}/pulls/${number}/comments?per_page=100&page=${page}`],
          { errorCode: "gh_auth_failed" }
        );
        const comments = parseJson<GhReviewComment[]>(stdout, "failed to parse gh review comments", "gh_auth_failed");
        for (const comment of comments) {
          const author = comment.user?.login ?? "";
          if (author.toLowerCase() !== viewer.toLowerCase()) {
            continue;
          }
          const marker = parseCodegenieMarker(comment.body ?? "");
          const line = typeof comment.line === "number" ? comment.line :
            typeof comment.original_line === "number" ? comment.original_line :
              undefined;
          const thread: ExistingReviewThread = {
            id: String(comment.id ?? ""),
            author,
            isCodegenie: marker !== undefined
          };
          if (comment.path !== undefined) {
            thread.path = comment.path;
          }
          if (line !== undefined) {
            thread.line = line;
          }
          if (comment.side === "RIGHT" || comment.side === "LEFT") {
            thread.side = comment.side;
          }
          if (marker !== undefined) {
            thread.fingerprint = marker.fingerprint;
          }
          own.push(thread);
        }
        if (comments.length < 100) {
          break;
        }
      }
      return own;
    }
  };
}

function parseJson<T>(stdout: string, message: string, code: CodegenieErrorCode): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw new CodegenieError(code, message, { cause: error });
  }
}

function normalizeCreateReviewError(error: unknown): unknown {
  if (!isCodegenieError(error) || error.code !== "github_post_failed") {
    return error;
  }
  const status = extractHttpStatus(error);
  const responseBody = extractResponseBody(error);
  return new CodegenieError(
    "github_post_failed",
    status === undefined ? error.message : `GitHub review creation failed with HTTP ${status}`,
    {
      context: {
        ...(error.context ?? {}),
        ...(status !== undefined ? { httpStatus: status } : {}),
        ...(responseBody !== undefined ? { responseBody } : {})
      },
      cause: error
    }
  );
}

function extractHttpStatus(error: CodegenieError): number | undefined {
  const existing = error.context?.httpStatus;
  if (typeof existing === "number" && Number.isInteger(existing)) {
    return existing;
  }
  const raw = [error.context?.stderr, error.context?.stdout, error.message]
    .map((value) => typeof value === "string" ? value : "")
    .join("\n");
  const match = /\bHTTP\s+(\d{3})\b/iu.exec(raw) ?? /\bstatus(?:\s+code)?[=:]\s*(\d{3})\b/iu.exec(raw);
  return match?.[1] !== undefined ? Number(match[1]) : undefined;
}

function extractResponseBody(error: CodegenieError): unknown | undefined {
  const existing = error.context?.responseBody;
  if (existing !== undefined) {
    return existing;
  }
  for (const value of [error.context?.stdout, error.context?.stderr]) {
    if (typeof value !== "string") {
      continue;
    }
    const parsed = parseFirstJsonObject(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function parseFirstJsonObject(raw: string): unknown | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) {
    return undefined;
  }
  try {
    return JSON.parse(raw.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

function ownerLogin(owner: unknown): string | undefined {
  if (typeof owner === "string") {
    return owner;
  }
  if (owner && typeof owner === "object" && "login" in owner && typeof owner.login === "string") {
    return owner.login;
  }
  return undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function missingPrSha(kind: "base" | "head", number: number): never {
  throw new CodegenieError("pr_not_found", `PR #${number} did not include a ${kind} commit SHA`);
}
