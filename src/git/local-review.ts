import { copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LocalReviewTarget, ResolvedReviewInput } from "../types.js";
import { CodegenieError, isCodegenieError } from "../util/errors.js";
import { createGitClient, type InternalGitClient } from "./git-client.js";
import { runGit, type GitEnvironment } from "./subprocess.js";

type SnapshotOptions = {
  repoRoot: string;
  runsRoot: string;
  onCleanup(task: () => Promise<void>): void;
};

export function localReviewHeadName(mode: LocalReviewTarget["mode"]): string {
  return mode === "staged" ? "index" : "tracked worktree";
}

export async function captureLocalReview(
  target: LocalReviewTarget,
  opts: SnapshotOptions
): Promise<{ resolved: ResolvedReviewInput; git: InternalGitClient }> {
  const original = createGitClient(opts.repoRoot);
  if (!(await original.isInsideWorktree())) {
    throw new CodegenieError("not_git_worktree", "codegenie review must run inside a git worktree");
  }
  const repoRoot = await original.repoRoot();
  const [index, objects, head, parent, repository, runs] = await Promise.all([
    runGit(repoRoot, ["rev-parse", "--path-format=absolute", "--git-path", "index"]),
    runGit(repoRoot, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]),
    runGit(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowedExitCodes: [0, 1] }),
    realpath(tmpdir()),
    realpath(repoRoot),
    realpath(opts.runsRoot).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return opts.runsRoot;
      throw error;
    })
  ]);
  if (isInside(repository, parent) || isInside(runs, parent)) {
    throw new CodegenieError("invalid_args", "choose a temporary directory outside the repository and the review runs directory");
  }
  if (head.length === 0) {
    const symbolic = await runGit(repoRoot, ["symbolic-ref", "--quiet", "HEAD"], { allowedExitCodes: [0, 1] });
    if (symbolic.length === 0) {
      throw new CodegenieError("git_ref_missing", "HEAD could not be resolved");
    }
  }

  const scratch = await mkdtemp(path.join(parent, "codegenie-snapshot-"));
  opts.onCleanup(() => rm(scratch, { recursive: true, force: true }));
  const scratchIndex = path.join(scratch, "index");
  const scratchObjects = path.join(scratch, "objects");
  const gitEnv: GitEnvironment = {
    GIT_OBJECT_DIRECTORY: scratchObjects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [quoteAlternate(objects), process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES]
      .filter(Boolean).join(path.delimiter),
    GIT_NO_LAZY_FETCH: "1"
  };
  const captureEnv: GitEnvironment = { ...gitEnv, GIT_INDEX_FILE: scratchIndex };
  const scratchGit = (args: string[]) => runGit(repoRoot, [
    "-c", `core.hooksPath=${scratch}`, "-c", "core.fsmonitor=false", "-c", "core.splitIndex=false", ...args
  ], { gitEnv: captureEnv });

  try {
    await mkdir(scratchObjects, { mode: 0o700 });
    try {
      await copyFile(index, scratchIndex);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await scratchGit(["read-tree", "--empty"]);
    }
    if ((await scratchGit(["ls-files", "--unmerged", "-z"])).length > 0) {
      throw new CodegenieError("invalid_args", "resolve unmerged index entries before reviewing uncommitted changes");
    }

    let untrackedFiles: number | undefined;
    if (target.mode === "uncommitted") {
      const untracked = await scratchGit(["ls-files", "--others", "--exclude-standard", "-z"]);
      untrackedFiles = untracked.split("\0").filter(Boolean).length;
      await scratchGit(["add", "--update", "--"]);
    }
    const headTree = await scratchGit(["write-tree"]);
    const baseTree = head.length > 0
      ? await runGit(repoRoot, ["rev-parse", "--verify", `${head}^{tree}`], { gitEnv })
      : await runGit(repoRoot, ["hash-object", "-w", "-t", "tree", "--stdin"], { gitEnv, input: "" });
    const git = createGitClient(repoRoot, { gitEnv });
    const rawDiff = await git.diff(baseTree, headTree);

    return {
      resolved: {
        mode: target.mode, repoRoot, baseRef: baseTree, headRef: headTree,
        baseRefName: head.length > 0 ? "HEAD" : "empty tree (unborn HEAD)",
        headRefName: localReviewHeadName(target.mode),
        ...(untrackedFiles !== undefined && untrackedFiles > 0 ? { untrackedFiles } : {}),
        commits: [], rawDiff
      },
      git
    };
  } catch (error) {
    // Git may include config arguments or output paths in an error.
    const message = (error instanceof Error ? error.message : String(error)).replaceAll(scratch, "<temporary snapshot>");
    throw new CodegenieError(isCodegenieError(error) ? error.code : "git_ref_missing", message, { cause: error });
  }
}

function quoteAlternate(value: string): string {
  // Git accepts C-quoted alternate paths, including platform list separators.
  return '"' + value.replace(/[\\"\u0000-\u001f\u007f]/gu, (char) =>
    char === "\\" || char === '"' ? "\\" + char : "\\" + char.charCodeAt(0).toString(8).padStart(3, "0")
  ) + '"';
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
