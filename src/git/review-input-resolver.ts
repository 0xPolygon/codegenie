import type {
  CodeninjaConfig,
  GitHubClient,
  PullRequestMetadata,
  ResolvedReviewInput,
  ReviewCommandTarget,
  ReviewInput
} from "../types.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import { CodeninjaError } from "../util/errors.js";
import { createGitClient, type InternalGitClient } from "./git-client.js";
import { createGitHubClient } from "../github/github-client.js";

type ResolveOptions = {
  repoRoot?: string;
  git?: InternalGitClient;
  github?: GitHubClient;
};

type ResolvedBranch = {
  sha: string;
  ref: string;
  shortName: string;
};

type ResolvedPullRequestCommits = {
  pr: PullRequestMetadata;
  remote?: string;
};

const DEEPEN_STEPS = [100, 1000] as const;

export async function resolveReviewCommandTarget(
  target: ReviewCommandTarget,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  opts: ResolveOptions = {}
): Promise<ResolvedReviewInput> {
  const git = opts.git ?? createGitClient(opts.repoRoot ?? process.cwd());

  if (target.mode === "default_branch") {
    await ensureWorktree(git);
    const currentBranch = await git.currentBranch();
    if (!currentBranch) {
      throw new CodeninjaError(
        "invalid_args",
        "HEAD is detached; pass an explicit review target (`--pr`, `--branch`, or a commit)."
      );
    }
    return resolveBranchReview(
      { mode: "branch", branchName: currentBranch, ...(target.baseBranch ? { baseBranch: target.baseBranch } : {}) },
      config,
      telemetry,
      git,
      { defaultBranchName: currentBranch }
    );
  }

  if (target.mode === "single_ref") {
    await ensureWorktree(git);
    const branch = await resolveBranchWithShallowRecovery(target.ref, git, telemetry);
    if (branch) {
      return resolveBranchReview(
        { mode: "branch", branchName: target.ref, ...(target.baseBranch ? { baseBranch: target.baseBranch } : {}) },
        config,
        telemetry,
        git,
        { preResolvedBranch: branch }
      );
    }
    if (target.baseBranch !== undefined) {
      throw new CodeninjaError(
        "invalid_args",
        `--base can only be used when '${target.ref}' resolves as a branch; use <base>...<head> for explicit head/base review.`
      );
    }
    return resolveCommitReview({ mode: "commit_range", startCommit: target.ref }, telemetry, git);
  }

  return resolveReviewInput(target, config, telemetry, { ...opts, git });
}

export async function resolveReviewInput(
  input: ReviewInput,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  opts: ResolveOptions = {}
): Promise<ResolvedReviewInput> {
  const git = opts.git ?? createGitClient(opts.repoRoot ?? process.cwd());
  await ensureWorktree(git);

  switch (input.mode) {
    case "github_pr":
      return resolvePullRequestReview(input, telemetry, git, opts.github ?? createGitHubClient(await git.repoRoot()));
    case "branch":
      return resolveBranchReview(input, config, telemetry, git);
    case "head":
      return resolveHeadReview(input, telemetry, git);
    case "commit_range":
      return resolveCommitReview(input, telemetry, git);
  }
}

async function ensureWorktree(git: InternalGitClient): Promise<void> {
  if (!(await git.isInsideWorktree())) {
    throw new CodeninjaError("not_git_worktree", "codeninja review must run inside a git worktree");
  }
}

async function resolvePullRequestReview(
  input: Extract<ReviewInput, { mode: "github_pr" }>,
  telemetry: TelemetryRecorder,
  git: InternalGitClient,
  github: GitHubClient
): Promise<ResolvedReviewInput> {
  const repoRoot = await git.repoRoot();
  await cleanupPullRequestRefs(git, input.prNumber, telemetry, "start");
  const initialPr = await github.viewPr(input.prNumber);
  const prCommits = await ensurePrCommitsAvailable(initialPr, github, git, telemetry);
  const pr = prCommits.pr;
  const mergeBase = await withShallowDeepening(
    git,
    telemetry,
    [pr.baseSha, pr.headSha],
    () => git.mergeBase(pr.baseSha, pr.headSha),
    prCommits.remote !== undefined ? { preferredRemote: prCommits.remote } : {}
  );
  const rawDiff = await git.diff(mergeBase, pr.headSha);
  const commits = await withShallowDeepening(
    git,
    telemetry,
    [pr.baseSha, pr.headSha],
    () => git.log(`${mergeBase}..${pr.headSha}`),
    prCommits.remote !== undefined ? { preferredRemote: prCommits.remote } : {}
  );

  telemetry.event({
    stage: 1,
    level: "info",
    message: "github pr input resolved",
    data: {
      mode: "github_pr",
      prNumber: input.prNumber,
      baseSha: pr.baseSha,
      headSha: pr.headSha,
      mergeBase,
      commitCount: commits.length
    }
  });

  return {
    mode: "github_pr",
    repoRoot,
    baseRef: pr.baseSha,
    headRef: pr.headSha,
    mergeBase,
    headSha: pr.headSha,
    pr,
    commits,
    rawDiff
  };
}

async function ensurePrCommitsAvailable(
  initialPr: PullRequestMetadata,
  github: GitHubClient,
  git: InternalGitClient,
  telemetry: TelemetryRecorder
): Promise<ResolvedPullRequestCommits> {
  let pr = initialPr;
  let refreshed = false;
  let remote: string | undefined;

  for (;;) {
    const baseExists = await git.commitExists(pr.baseSha);
    const headExists = await git.commitExists(pr.headSha);
    if (baseExists && headExists) {
      remote ??= await selectPrRemote(git, pr);
      return { pr, ...(remote !== undefined ? { remote } : {}) };
    }

    remote = await selectPrRemote(git, pr);
    if (!remote) {
      throw new CodeninjaError("git_fetch_failed", "no git remote available to fetch PR commits");
    }

    if (!headExists) {
      await fetchPrHead(git, pr, remote, telemetry);
    }
    if (!baseExists) {
      await fetchPrBase(git, pr, remote, telemetry);
    }

    const nextBaseExists = await git.commitExists(pr.baseSha);
    const nextHeadExists = await git.commitExists(pr.headSha);
    if (nextBaseExists && nextHeadExists) {
      return { pr, remote };
    }

    if (!nextHeadExists && !refreshed) {
      refreshed = true;
      const nextPr = await github.viewPr(pr.number, { refresh: true });
      if (nextPr.headSha !== pr.headSha || nextPr.baseSha !== pr.baseSha) {
        telemetry.event({
          stage: 1,
          level: "warn",
          message: "github pr head moved during fetch; retrying with fresh metadata",
          data: { prNumber: pr.number, oldHeadSha: pr.headSha, newHeadSha: nextPr.headSha }
        });
        pr = nextPr;
        continue;
      }
    }

    throw new CodeninjaError(
      "git_fetch_failed",
      `failed to fetch PR #${pr.number} commits (${pr.baseSha}..${pr.headSha})`
    );
  }
}

async function fetchPrHead(
  git: InternalGitClient,
  pr: PullRequestMetadata,
  remote: string,
  telemetry: TelemetryRecorder
): Promise<void> {
  const refspec = `+refs/pull/${pr.number}/head:refs/codeninja/pr/${pr.number}/head`;
  await git.fetchFrom(remote, refspec);
  telemetry.event({
    stage: 1,
    level: "info",
    message: "pr_refs_fetched",
    data: { prNumber: pr.number, remote, kind: "head", refspec }
  });
}

async function fetchPrBase(
  git: InternalGitClient,
  pr: PullRequestMetadata,
  remote: string,
  telemetry: TelemetryRecorder
): Promise<void> {
  const directRefspec = `+${pr.baseSha}:refs/codeninja/pr/${pr.number}/base`;
  try {
    await git.fetchFrom(remote, directRefspec);
    telemetry.event({
      stage: 1,
      level: "info",
      message: "pr_refs_fetched",
      data: { prNumber: pr.number, remote, kind: "base-sha", refspec: directRefspec }
    });
    if (await git.commitExists(pr.baseSha)) {
      return;
    }
  } catch (error) {
    telemetry.event({
      stage: 1,
      level: "warn",
      message: "pr_base_sha_fetch_failed",
      data: { prNumber: pr.number, remote, error: error instanceof Error ? error.message : String(error) }
    });
  }

  if (pr.baseRefName.trim().length === 0) {
    throw new CodeninjaError("git_fetch_failed", `failed to fetch PR #${pr.number} base commit ${pr.baseSha}`);
  }
  const branchRefspec = `+refs/heads/${pr.baseRefName}:refs/codeninja/pr/${pr.number}/base`;
  await git.fetchFrom(remote, branchRefspec);
  telemetry.event({
    stage: 1,
    level: "info",
    message: "pr_refs_fetched",
    data: { prNumber: pr.number, remote, kind: "base-branch", refspec: branchRefspec }
  });
}

async function selectPrRemote(git: InternalGitClient, pr: PullRequestMetadata): Promise<string | undefined> {
  const remotes = await git.remotes();
  const matching = remotes.find((remote) => remoteMatchesPr(remote.url, pr));
  if (matching !== undefined) {
    return matching.name;
  }
  return remotes.find((remote) => remote.name === "origin")?.name ?? [...remotes].sort((a, b) => a.name.localeCompare(b.name))[0]?.name;
}

function remoteMatchesPr(url: string, pr: PullRequestMetadata): boolean {
  const normalized = normalizeRemoteUrl(url);
  return normalized?.owner.toLowerCase() === pr.owner.toLowerCase() &&
    normalized.repo.toLowerCase() === pr.repo.toLowerCase();
}

function normalizeRemoteUrl(url: string): { host?: string; owner: string; repo: string } | undefined {
  const trimmed = url.trim().replace(/\.git$/u, "");
  const scp = /^(?<user>[^@]+)@(?<host>[^:]+):(?<path>.+)$/u.exec(trimmed);
  if (scp?.groups?.path) {
    return ownerRepoFromPath(scp.groups.path, scp.groups.host);
  }
  try {
    const parsed = new URL(trimmed);
    return ownerRepoFromPath(parsed.pathname.replace(/^\/+/u, ""), parsed.hostname);
  } catch {
    return ownerRepoFromPath(trimmed);
  }
}

function ownerRepoFromPath(path: string, host?: string): { host?: string; owner: string; repo: string } | undefined {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }
  const [owner, repo] = parts.slice(-2);
  if (!owner || !repo) {
    return undefined;
  }
  return host !== undefined ? { host, owner, repo } : { owner, repo };
}

export async function cleanupPullRequestRefs(
  git: InternalGitClient,
  prNumber: number,
  telemetry: TelemetryRecorder,
  timing: "start" | "end"
): Promise<void> {
  try {
    const refs = await git.listRefs(`refs/codeninja/pr/${prNumber}`);
    for (const ref of refs) {
      await git.deleteRef(ref);
    }
    if (refs.length > 0) {
      telemetry.event({
        stage: 1,
        level: "info",
        message: "pr_refs_cleaned",
        data: { prNumber, timing, refs }
      });
    }
  } catch (error) {
    telemetry.event({
      stage: 1,
      level: "warn",
      message: "pr_refs_cleanup_failed",
      data: { prNumber, timing, error: error instanceof Error ? error.message : String(error) }
    });
  }
}

async function resolveBranchReview(
  input: Extract<ReviewInput, { mode: "branch" }>,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  git: InternalGitClient,
  opts: { defaultBranchName?: string; preResolvedBranch?: ResolvedBranch } = {}
): Promise<ResolvedReviewInput> {
  const repoRoot = await git.repoRoot();
  const branch = opts.preResolvedBranch ?? await resolveBranchWithShallowRecovery(input.branchName, git, telemetry);
  if (!branch) {
    throw new CodeninjaError("git_ref_missing", `review branch '${input.branchName}' could not be resolved`);
  }

  const base = await resolveBaseBranch(input, config, git, telemetry);
  if (opts.defaultBranchName !== undefined && opts.defaultBranchName === base.shortName) {
    throw new CodeninjaError(
      "invalid_args",
      `current branch ${opts.defaultBranchName} is the base branch; pass an explicit review target.`
    );
  }

  const mergeBase = await withShallowDeepening(
    git,
    telemetry,
    [base, branch],
    () => git.mergeBase(base.sha, branch.sha)
  );
  const rawDiff = await git.diff(mergeBase, branch.sha);
  const commits = await withShallowDeepening(
    git,
    telemetry,
    [base, branch],
    () => git.log(`${mergeBase}..${branch.sha}`)
  );

  telemetry.event({
    stage: 1,
    level: "info",
    message: "branch input resolved",
    data: {
      mode: "branch",
      branchName: input.branchName,
      branchRef: branch.ref,
      baseRef: base.ref,
      baseBranch: base.shortName,
      mergeBase,
      headSha: branch.sha,
      commitCount: commits.length
    }
  });

  return {
    mode: "branch",
    repoRoot,
    baseRef: base.sha,
    headRef: branch.sha,
    mergeBase,
    headSha: branch.sha,
    commits,
    rawDiff
  };
}

async function resolveBaseBranch(
  input: Extract<ReviewInput, { mode: "branch" }>,
  config: CodeninjaConfig,
  git: InternalGitClient,
  telemetry: TelemetryRecorder
): Promise<ResolvedBranch> {
  if (input.baseBranch !== undefined) {
    return resolveRequiredBase(input.baseBranch, git, telemetry, "CLI --base");
  }
  if (config.git.baseBranch !== undefined) {
    return resolveRequiredBase(config.git.baseBranch, git, telemetry, "git.baseBranch");
  }

  for (const candidate of ["master", "main"]) {
    const resolved = await resolveBranchWithShallowRecovery(candidate, git, telemetry);
    if (resolved) {
      return resolved;
    }
  }

  throw new CodeninjaError(
    "git_base_branch_unresolved",
    "no base branch could be resolved; pass --base or configure git.baseBranch"
  );
}

async function resolveRequiredBase(
  branchName: string,
  git: InternalGitClient,
  telemetry: TelemetryRecorder,
  source: string
): Promise<ResolvedBranch> {
  const resolved = await resolveBranchWithShallowRecovery(branchName, git, telemetry);
  if (!resolved) {
    throw new CodeninjaError(
      "git_base_branch_unresolved",
      `${source} '${branchName}' could not be resolved`
    );
  }
  return { ...resolved, shortName: branchName };
}

async function resolveCommitReview(
  input: Extract<ReviewInput, { mode: "commit_range" }>,
  telemetry: TelemetryRecorder,
  git: InternalGitClient
): Promise<ResolvedReviewInput> {
  const repoRoot = await git.repoRoot();
  const startSha = await revParseWithShallowRecovery(input.startCommit, git, telemetry);

  if (input.endCommit === undefined) {
    const parent = (await firstParentWithShallowRecovery(startSha, git, telemetry)) ?? (await git.emptyTreeSha());
    const rawDiff = await git.diff(parent, startSha);
    const commits = await withShallowDeepening(git, telemetry, [startSha], () => git.log(`${startSha}^!`));
    telemetry.event({
      stage: 1,
      level: "info",
      message: "single commit input resolved",
      data: { mode: "commit_range", startCommit: startSha, baseRef: parent, headSha: startSha }
    });
    return {
      mode: "commit_range",
      repoRoot,
      baseRef: parent,
      headRef: startSha,
      startCommit: startSha,
      mergeBase: parent,
      headSha: startSha,
      commits,
      rawDiff
    };
  }

  const endSha = await revParseWithShallowRecovery(input.endCommit, git, telemetry);
  const rawDiff = await git.diff(startSha, endSha);
  const commits = await withShallowDeepening(git, telemetry, [startSha, endSha], () =>
    git.log(`${startSha}..${endSha}`)
  );
  telemetry.event({
    stage: 1,
    level: "info",
    message: "commit range input resolved",
    data: {
      mode: "commit_range",
      startCommit: startSha,
      endCommit: endSha,
      commitCount: commits.length
    }
  });
  return {
    mode: "commit_range",
    repoRoot,
    baseRef: startSha,
    headRef: endSha,
    startCommit: startSha,
    endCommit: endSha,
    mergeBase: startSha,
    headSha: endSha,
    commits,
    rawDiff
  };
}

async function resolveHeadReview(
  input: Extract<ReviewInput, { mode: "head" }>,
  telemetry: TelemetryRecorder,
  git: InternalGitClient
): Promise<ResolvedReviewInput> {
  const repoRoot = await git.repoRoot();
  const baseSha = await revParseWithShallowRecovery(input.baseRef, git, telemetry);
  const headSha = await revParseWithShallowRecovery(input.headRef, git, telemetry);
  const mergeBase = await withShallowDeepening(
    git,
    telemetry,
    [input.baseRef, input.headRef],
    () => git.mergeBase(baseSha, headSha)
  );
  const rawDiff = await git.diff(mergeBase, headSha);
  const commits = await withShallowDeepening(
    git,
    telemetry,
    [input.baseRef, input.headRef],
    () => git.log(`${mergeBase}..${headSha}`)
  );

  telemetry.event({
    stage: 1,
    level: "info",
    message: "head input resolved",
    data: {
      mode: "head",
      baseRef: input.baseRef,
      headRef: input.headRef,
      baseSha,
      headSha,
      mergeBase,
      commitCount: commits.length
    }
  });

  return {
    mode: "head",
    repoRoot,
    baseRef: baseSha,
    headRef: headSha,
    mergeBase,
    headSha,
    commits,
    rawDiff
  };
}

async function resolveBranchWithShallowRecovery(
  branchName: string,
  git: InternalGitClient,
  telemetry: TelemetryRecorder
): Promise<ResolvedBranch | undefined> {
  const direct = await git.resolveBranch(branchName);
  if (direct) {
    return { ...direct, shortName: branchName };
  }
  if (!(await git.isShallow())) {
    return undefined;
  }

  const remote = await primaryRemote(git);
  if (!remote) {
    return undefined;
  }

  const refspec = `+refs/heads/${branchName}:refs/remotes/${remote}/${branchName}`;
  for (const depth of DEEPEN_STEPS) {
    try {
      await git.fetchFrom(remote, refspec, { deepen: depth });
      telemetry.event({
        stage: 1,
        level: "info",
        message: "shallow repository deepened",
        data: { depth, refspec }
      });
    } catch {
      continue;
    }
    const resolved = await git.resolveBranch(branchName);
    if (resolved) {
      return { ...resolved, shortName: branchName };
    }
  }
  return undefined;
}

async function revParseWithShallowRecovery(
  ref: string,
  git: InternalGitClient,
  telemetry: TelemetryRecorder
): Promise<string> {
  try {
    return await git.revParse(ref);
  } catch (error) {
    if (!isShallowRetryable(error) || !(await git.isShallow())) {
      throw error;
    }
    let lastError: unknown = error;
    let fetched = false;
    for (const depth of DEEPEN_STEPS) {
      fetched = (await deepenRefs(git, telemetry, [ref], depth)) || fetched;
      try {
        return await git.revParse(ref);
      } catch (retryError) {
        lastError = retryError;
      }
    }
    if (!fetched) {
      throw error;
    }
    throw shallowUnresolved(lastError);
  }
}

async function firstParentWithShallowRecovery(
  sha: string,
  git: InternalGitClient,
  telemetry: TelemetryRecorder
): Promise<string | undefined> {
  const parent = await git.firstParent(sha);
  if (parent !== undefined) {
    return parent;
  }

  const recordedParents = await git.parentShas(sha);
  if (recordedParents.length === 0) {
    return undefined;
  }
  if (!(await git.isShallow())) {
    throw new CodeninjaError("git_ref_missing", `parent commit ${recordedParents[0]} is not available`);
  }

  let fetched = false;
  for (const depth of DEEPEN_STEPS) {
    fetched = (await deepenRefs(git, telemetry, [sha], depth)) || fetched;
    const retryParent = await git.firstParent(sha);
    if (retryParent !== undefined) {
      return retryParent;
    }
  }
  throw shallowUnresolved(fetched ? undefined : new Error("no remote available for shallow deepening"));
}

async function withShallowDeepening<T>(
  git: InternalGitClient,
  telemetry: TelemetryRecorder,
  refs: Array<ResolvedBranch | string>,
  operation: () => Promise<T>,
  opts: { preferredRemote?: string } = {}
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isShallowRetryable(error) || !(await git.isShallow())) {
      throw error;
    }
    let lastError: unknown = error;
    let fetched = false;
    for (const depth of DEEPEN_STEPS) {
      fetched = (await deepenRefs(git, telemetry, refs, depth, opts)) || fetched;
      try {
        return await operation();
      } catch (retryError) {
        lastError = retryError;
      }
    }
    if (!fetched) {
      throw error;
    }
    throw shallowUnresolved(lastError);
  }
}

async function deepenRefs(
  git: InternalGitClient,
  telemetry: TelemetryRecorder,
  refs: Array<ResolvedBranch | string>,
  depth: number,
  opts: { preferredRemote?: string } = {}
): Promise<boolean> {
  const remote = opts.preferredRemote ?? await primaryRemote(git);
  if (!remote) {
    return false;
  }

  let fetched = false;
  const refspecs = refs.map((ref) => deepenRefspec(ref, remote));
  for (const refspec of refspecs) {
    try {
      await git.fetchFrom(remote, refspec, { deepen: depth });
      fetched = true;
    } catch {
      // Some local branches have no matching remote branch. Other refs may still deepen enough.
    }
  }
  if (fetched) {
    telemetry.event({
      stage: 1,
      level: "info",
      message: "shallow repository deepened",
      data: { depth, refspecs }
    });
  }
  return fetched;
}

function deepenRefspec(ref: ResolvedBranch | string, remote: string): string {
  if (typeof ref === "string") {
    return ref;
  }
  const remotePrefix = `refs/remotes/${remote}/`;
  if (ref.ref.startsWith(remotePrefix)) {
    const branchName = ref.ref.slice(remotePrefix.length);
    return `+refs/heads/${branchName}:refs/remotes/${remote}/${branchName}`;
  }
  if (ref.ref.startsWith("refs/heads/")) {
    const branchName = ref.ref.slice("refs/heads/".length);
    return `+refs/heads/${branchName}:refs/remotes/${remote}/${branchName}`;
  }
  return ref.sha;
}

async function primaryRemote(git: InternalGitClient): Promise<string | undefined> {
  const remotes = await git.remotes();
  return remotes.find((remote) => remote.name === "origin")?.name ?? remotes[0]?.name;
}

function isShallowRetryable(error: unknown): boolean {
  return error instanceof CodeninjaError && error.code === "git_ref_missing";
}

function shallowUnresolved(cause: unknown): CodeninjaError {
  return new CodeninjaError(
    "git_ref_missing",
    "repository is shallow; run `git fetch --unshallow` (or fetch more history) and retry",
    { cause }
  );
}
