import picomatch from "picomatch";
import type { SearchResult, SourceSelector, ResolvedReviewInput } from "../types.js";
import { createGitClient, type InternalGitClient } from "../git/git-client.js";
import { CodegenieError } from "../util/errors.js";
import { sha256Hex } from "../util/hashing.js";
import { containGlob, containPath, containRef } from "./path-guard.js";

export type RevisionBinding = {
  headCommit: string;
  baseCommit: string;
};

export type ResolvedContent = {
  path: string;
  source: SourceSelector;
  commit: string;
  content: string;
  contentSha: string;
  blobSha?: string;
};

export class SourceResolver {
  readonly repoRoot: string;
  readonly git: InternalGitClient;
  readonly binding: RevisionBinding;
  private readonly contentCache = new Map<string, Promise<ResolvedContent | undefined>>();

  private constructor(
    repoRoot: string,
    git: InternalGitClient,
    binding: RevisionBinding
  ) {
    this.repoRoot = repoRoot;
    this.git = git;
    this.binding = binding;
  }

  static async create(resolved: ResolvedReviewInput, git: InternalGitClient = createGitClient(resolved.repoRoot)): Promise<SourceResolver> {
    const binding = await deriveRevisionBinding(resolved, git);
    return new SourceResolver(resolved.repoRoot, git, binding);
  }

  resolveSource(source: SourceSelector = { kind: "head" }): string {
    return source.kind === "base" ? this.binding.baseCommit : this.binding.headCommit;
  }

  async readFile(relPath: string, source: SourceSelector = { kind: "head" }): Promise<ResolvedContent | undefined> {
    const contained = containPath(this.repoRoot, relPath);
    const commit = this.resolveSource(source);
    const cacheKey = `${commit}:${contained}`;
    let pending = this.contentCache.get(cacheKey);
    if (!pending) {
      pending = this.readFileUncached(contained, source, commit);
      this.contentCache.set(cacheKey, pending);
    }
    return pending;
  }

  async listFiles(glob?: string, source: SourceSelector = { kind: "head" }): Promise<string[]> {
    const containedGlob = glob === undefined ? undefined : containGlob(this.repoRoot, glob);
    const paths = await this.git.lsTree(this.resolveSource(source));
    if (containedGlob === undefined) {
      return paths;
    }
    const isMatch = picomatch(containedGlob, { dot: true });
    return paths.filter((filePath) => isMatch(filePath));
  }

  async grep(
    pattern: string,
    opts: {
      source?: SourceSelector;
      glob?: string;
      maxResults?: number;
      caseSensitive?: boolean;
      fixedString?: boolean;
      word?: boolean;
    } = {}
  ): Promise<SearchResult[]> {
    const commit = this.resolveSource(opts.source);
    const containedGlob = opts.glob === undefined ? undefined : containGlob(this.repoRoot, opts.glob);
    return this.git.grep(commit, pattern, {
      ...(containedGlob !== undefined ? { glob: containedGlob } : {}),
      ...(opts.maxResults !== undefined ? { maxResults: opts.maxResults } : {}),
      ...(opts.caseSensitive !== undefined ? { caseSensitive: opts.caseSensitive } : {}),
      ...(opts.fixedString !== undefined ? { fixedString: opts.fixedString } : {}),
      ...(opts.word !== undefined ? { word: opts.word } : {})
    });
  }

  private async readFileUncached(
    relPath: string,
    source: SourceSelector,
    commit: string
  ): Promise<ResolvedContent | undefined> {
    try {
      // Repository review tools read committed blobs through git plumbing. Do not
      // replace this with worktree filesystem reads; symlinks must stay inert.
      const content = await this.git.catFile(commit, relPath);
      const entry = await this.git.lsTreeEntry(commit, relPath);
      const blobSha = entry?.type === "blob" ? entry.oid : undefined;
      return {
        path: relPath,
        source,
        commit,
        content,
        contentSha: blobSha ?? sha256Hex(content),
        ...(blobSha !== undefined ? { blobSha } : {})
      };
    } catch (error) {
      if (error instanceof CodegenieError && error.code === "git_ref_missing") {
        return undefined;
      }
      throw error;
    }
  }
}

export async function deriveRevisionBinding(
  resolved: ResolvedReviewInput,
  git: InternalGitClient = createGitClient(resolved.repoRoot)
): Promise<RevisionBinding> {
  const headCommit = await resolveHeadCommit(resolved, git);
  const baseCommit = await resolveBaseCommit(resolved, git);
  return { headCommit, baseCommit };
}

async function resolveHeadCommit(resolved: ResolvedReviewInput, git: InternalGitClient): Promise<string> {
  if (resolved.headSha !== undefined) {
    return containRef(resolved.headSha);
  }
  if (resolved.endCommit !== undefined) {
    return git.revParse(containRef(resolved.endCommit));
  }
  if (resolved.startCommit !== undefined) {
    return git.revParse(containRef(resolved.startCommit));
  }
  if (resolved.headRef !== undefined) {
    return git.revParse(containRef(resolved.headRef));
  }
  return git.revParse("HEAD");
}

async function resolveBaseCommit(resolved: ResolvedReviewInput, git: InternalGitClient): Promise<string> {
  if (resolved.mergeBase !== undefined) {
    return containRef(resolved.mergeBase);
  }
  if (resolved.baseRef !== undefined) {
    return git.revParse(containRef(resolved.baseRef));
  }
  if (resolved.startCommit !== undefined && resolved.endCommit !== undefined) {
    return git.revParse(containRef(resolved.startCommit));
  }
  if (resolved.startCommit !== undefined) {
    return (await git.firstParent(containRef(resolved.startCommit))) ?? (await git.emptyTreeSha());
  }
  return git.emptyTreeSha();
}
