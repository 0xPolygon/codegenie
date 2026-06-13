import type { CommitInfo, SearchResult } from "../types.js";
import { CodeninjaError } from "../util/errors.js";
import {
  assertSafeGlob,
  assertSafeLogRange,
  assertSafePath,
  assertSafePathspec,
  assertSafeRef,
  assertSafeRefspec,
  runGit,
  runGitCapped
} from "./subprocess.js";

export interface GitClient {
  revParse(ref: string): Promise<string>;
  catFile(ref: string, path: string): Promise<string>;
  lsTree(ref: string, glob?: string): Promise<string[]>;
  lsFiles(paths: string[]): Promise<string[]>;
  grep(
    ref: string,
    pattern: string,
    opts?: { glob?: string; maxResults?: number; caseSensitive?: boolean; fixedString?: boolean; word?: boolean }
  ): Promise<SearchResult[]>;
  mergeBase(a: string, b: string): Promise<string>;
  log(range: string): Promise<CommitInfo[]>;
  diff(base: string, head: string): Promise<string>;
  fetch(refspec: string): Promise<void>;
  isShallow(): Promise<boolean>;
}

export type GitRemote = {
  name: string;
  url: string;
};

export type GitTreeEntry = {
  mode: string;
  type: string;
  oid: string;
};

export interface InternalGitClient extends GitClient {
  currentBranch(): Promise<string | undefined>;
  isInsideWorktree(): Promise<boolean>;
  repoRoot(): Promise<string>;
  commitExists(sha: string): Promise<boolean>;
  resolveBranch(name: string): Promise<{ sha: string; ref: string } | undefined>;
  remotes(): Promise<GitRemote[]>;
  fetchFrom(remote: string, refspec: string, opts?: { deepen?: number }): Promise<void>;
  deleteRef(ref: string): Promise<void>;
  listRefs(prefix: string): Promise<string[]>;
  lsTreeEntry(ref: string, path: string): Promise<GitTreeEntry | undefined>;
  emptyTreeSha(): Promise<string>;
  firstParent(sha: string): Promise<string | undefined>;
  parentShas(sha: string): Promise<string[]>;
  checkIgnored(paths: string[]): Promise<Set<string>>;
  catFilePrefix(ref: string, path: string, opts: { maxBytes: number; maxLines: number }): Promise<string>;
}

type CreateGitClientOptions = {
  defaultRemote?: string;
};

const LOG_FORMAT = "%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1e";
const DIFF_FLAGS = [
  "-c",
  "core.quotepath=off",
  "-c",
  "diff.mnemonicPrefix=false",
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--unified=3",
  "--find-renames",
  "--find-copies",
  "--diff-algorithm=myers",
  "--src-prefix=a/",
  "--dst-prefix=b/"
];

export function createGitClient(repoRoot: string, opts: CreateGitClientOptions = {}): InternalGitClient {
  let emptyTree: string | undefined;
  const defaultRemote = opts.defaultRemote ?? "origin";

  return {
    async revParse(ref: string): Promise<string> {
      assertSafeRef(ref);
      return trimSha(
        await runGit(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`], {
          errorCode: "git_ref_missing"
        })
      );
    },

    async catFile(ref: string, filePath: string): Promise<string> {
      assertSafeRef(ref);
      assertSafePath(filePath);
      return runGit(repoRoot, ["cat-file", "blob", `${ref}:${filePath}`], {
        stripFinalNewline: false,
        errorCode: "git_ref_missing"
      });
    },

    async lsTree(ref: string, glob?: string): Promise<string[]> {
      assertSafeRef(ref);
      const args = ["ls-tree", "-r", "--name-only", ref, "--"];
      if (glob !== undefined) {
        assertSafeGlob(glob);
        args.push(`:(glob)${glob}`);
      }
      const stdout = await runGit(repoRoot, args, { errorCode: "git_ref_missing" });
      return stdout.split("\n").filter(Boolean);
    },

    async lsFiles(paths: string[]): Promise<string[]> {
      if (paths.length === 0) {
        return [];
      }
      for (const filePath of paths) {
        assertSafePathspec(filePath);
      }
      const stdout = await runGit(repoRoot, ["ls-files", "-z", "--", ...paths], {
        stripFinalNewline: false,
        errorCode: "invalid_args"
      });
      return splitNul(stdout);
    },

    async grep(
      ref: string,
      pattern: string,
      grepOpts: { glob?: string; maxResults?: number; caseSensitive?: boolean; fixedString?: boolean; word?: boolean } = {}
    ): Promise<SearchResult[]> {
      assertSafeRef(ref);
      if (grepOpts.glob !== undefined) {
        assertSafeGlob(grepOpts.glob);
      }
      const args = [
        "grep",
        "-I",
        "-n",
        "--column",
        "--no-color",
        grepOpts.fixedString === true ? "-F" : "-E",
        ...(grepOpts.word === true ? ["-w"] : []),
        ...(grepOpts.caseSensitive === false ? ["-i"] : []),
        "-e",
        pattern,
        ref,
        "--"
      ];
      if (grepOpts.glob !== undefined) {
        args.push(`:(glob)${grepOpts.glob}`);
      }
      const maxResults = grepOpts.maxResults ?? 50;
      const stdout = await runGitCapped(repoRoot, args, {
        maxBytes: Math.max(64 * 1024, maxResults * 1024),
        maxLines: maxResults,
        allowedExitCodes: [0, 1],
        errorCode: "git_ref_missing"
      });
      return stdout
        .split("\n")
        .filter(Boolean)
        .slice(0, maxResults)
        .map((line) => parseGrepLine(line, ref))
        .filter((result): result is SearchResult => result !== undefined);
    },

    async mergeBase(a: string, b: string): Promise<string> {
      assertSafeRef(a, "merge-base ref");
      assertSafeRef(b, "merge-base ref");
      return trimSha(
        await runGit(repoRoot, ["merge-base", a, b], {
          errorCode: "git_ref_missing"
        })
      );
    },

    async log(range: string): Promise<CommitInfo[]> {
      assertSafeLogRange(range);
      const stdout = await runGit(
        repoRoot,
        ["log", "--no-show-signature", "--date=iso-strict", `--format=${LOG_FORMAT}`, range, "--"],
        { errorCode: "git_ref_missing" }
      );
      return parseLog(stdout);
    },

    async diff(base: string, head: string): Promise<string> {
      assertSafeRef(base, "diff base");
      assertSafeRef(head, "diff head");
      try {
        return await runGit(repoRoot, [...DIFF_FLAGS, base, head, "--"], {
          stripFinalNewline: false,
          errorCode: "git_ref_missing"
        });
      } catch (error) {
        if (error instanceof CodeninjaError && error.context?.isMaxBuffer === true) {
          throw new CodeninjaError("diff_parse_failed", error.message, {
            context: error.context,
            cause: error
          });
        }
        throw error;
      }
    },

    async fetch(refspec: string): Promise<void> {
      assertSafeRef(defaultRemote, "default remote");
      assertSafeRefspec(refspec);
      await runGit(repoRoot, ["fetch", defaultRemote, refspec], {
        network: true,
        errorCode: "git_fetch_failed"
      });
    },

    async isShallow(): Promise<boolean> {
      const stdout = await runGit(repoRoot, ["rev-parse", "--is-shallow-repository"], {
        errorCode: "git_ref_missing"
      });
      return stdout.trim() === "true";
    },

    async currentBranch(): Promise<string | undefined> {
      const stdout = await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], {
        errorCode: "git_ref_missing"
      });
      const branch = stdout.trim();
      return branch === "HEAD" ? undefined : branch;
    },

    async isInsideWorktree(): Promise<boolean> {
      try {
        const stdout = await runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"], {
          errorCode: "not_git_worktree"
        });
        return stdout.trim() === "true";
      } catch {
        return false;
      }
    },

    async repoRoot(): Promise<string> {
      return runGit(repoRoot, ["rev-parse", "--show-toplevel"], {
        errorCode: "not_git_worktree"
      });
    },

    async commitExists(sha: string): Promise<boolean> {
      assertSafeRef(sha, "commit sha");
      try {
        await runGit(repoRoot, ["cat-file", "-e", `${sha}^{commit}`], {
          errorCode: "git_ref_missing"
        });
        return true;
      } catch (error) {
        if (error instanceof CodeninjaError && error.code === "git_ref_missing") {
          return false;
        }
        throw error;
      }
    },

    async resolveBranch(name: string): Promise<{ sha: string; ref: string } | undefined> {
      assertSafeRef(name, "branch name");
      const localRef = `refs/heads/${name}`;
      const local = await tryRevParse(localRef);
      if (local) {
        return { sha: local, ref: localRef };
      }

      for (const remote of orderRemotes(await this.remotes())) {
        const remoteRef = `refs/remotes/${remote.name}/${name}`;
        const remoteSha = await tryRevParse(remoteRef);
        if (remoteSha) {
          return { sha: remoteSha, ref: remoteRef };
        }
      }
      return undefined;
    },

    async remotes(): Promise<GitRemote[]> {
      const stdout = await runGit(repoRoot, ["remote", "-v"], {
        allowedExitCodes: [0],
        errorCode: "git_ref_missing"
      });
      const seen = new Map<string, GitRemote>();
      for (const line of stdout.split("\n")) {
        const match = /^(?<name>\S+)\s+(?<url>\S+)\s+\((?:fetch|push)\)$/.exec(line);
        const name = match?.groups?.name;
        const url = match?.groups?.url;
        if (name !== undefined && url !== undefined && !seen.has(name)) {
          seen.set(name, { name, url });
        }
      }
      return [...seen.values()];
    },

    async fetchFrom(remote: string, refspec: string, fetchOpts: { deepen?: number } = {}): Promise<void> {
      assertSafeRef(remote, "remote");
      assertSafeRefspec(refspec);
      const args = ["fetch"];
      if (fetchOpts.deepen !== undefined) {
        args.push(`--deepen=${fetchOpts.deepen}`);
      }
      args.push(remote, refspec);
      await runGit(repoRoot, args, { network: true, errorCode: "git_fetch_failed" });
    },

    async deleteRef(ref: string): Promise<void> {
      assertSafeRef(ref);
      await runGit(repoRoot, ["update-ref", "-d", ref], {
        allowedExitCodes: [0, 1],
        errorCode: "git_ref_missing"
      });
    },

    async listRefs(prefix: string): Promise<string[]> {
      assertSafeRef(prefix, "ref prefix");
      const stdout = await runGit(repoRoot, ["for-each-ref", "--format=%(refname)", prefix], {
        errorCode: "git_ref_missing"
      });
      return stdout.split("\n").filter(Boolean);
    },

    async lsTreeEntry(ref: string, filePath: string): Promise<GitTreeEntry | undefined> {
      assertSafeRef(ref);
      assertSafePathspec(filePath);
      const stdout = await runGit(repoRoot, ["ls-tree", ref, "--", filePath], {
        errorCode: "git_ref_missing"
      });
      const line = stdout.split("\n").find(Boolean);
      if (!line) {
        return undefined;
      }
      const match = /^(?<mode>\d+)\s+(?<type>\S+)\s+(?<oid>[0-9a-fA-F]+)\t/.exec(line);
      const mode = match?.groups?.mode;
      const type = match?.groups?.type;
      const oid = match?.groups?.oid;
      return mode !== undefined && type !== undefined && oid !== undefined ? { mode, type, oid } : undefined;
    },

    async emptyTreeSha(): Promise<string> {
      emptyTree ??= trimSha(
        await runGit(repoRoot, ["hash-object", "-t", "tree", "/dev/null"], {
          errorCode: "git_ref_missing"
        })
      );
      return emptyTree;
    },

    async firstParent(sha: string): Promise<string | undefined> {
      assertSafeRef(sha, "commit sha");
      try {
        return trimSha(
          await runGit(repoRoot, ["rev-parse", "--verify", `${sha}^1`], {
            errorCode: "git_ref_missing"
          })
        );
      } catch (error) {
        if (error instanceof CodeninjaError && error.code === "git_ref_missing") {
          return undefined;
        }
        throw error;
      }
    },

    async parentShas(sha: string): Promise<string[]> {
      assertSafeRef(sha, "commit sha");
      const stdout = await runGit(repoRoot, ["cat-file", "-p", sha], {
        stripFinalNewline: false,
        errorCode: "git_ref_missing"
      });
      return stdout
        .split("\n")
        .slice(0, commitHeaderLineCount(stdout))
        .filter((line) => line.startsWith("parent "))
        .map((line) => line.slice("parent ".length).trim())
        .filter(Boolean);
    },

    async checkIgnored(paths: string[]): Promise<Set<string>> {
      if (paths.length === 0) {
        return new Set();
      }
      for (const filePath of paths) {
        assertSafePathspec(filePath);
      }
      const stdout = await runGit(repoRoot, ["check-ignore", "--no-index", "--stdin", "-z"], {
        input: `${paths.join("\0")}\0`,
        stripFinalNewline: false,
        allowedExitCodes: [0, 1],
        errorCode: "git_ref_missing"
      });
      return new Set(splitNul(stdout));
    },

    async catFilePrefix(
      ref: string,
      filePath: string,
      prefixOpts: { maxBytes: number; maxLines: number }
    ): Promise<string> {
      assertSafeRef(ref);
      assertSafePath(filePath);
      return runGitCapped(repoRoot, ["cat-file", "blob", `${ref}:${filePath}`], {
        maxBytes: prefixOpts.maxBytes,
        maxLines: prefixOpts.maxLines,
        errorCode: "git_ref_missing"
      });
    }
  };

  async function tryRevParse(ref: string): Promise<string | undefined> {
    try {
      return await (createGitClient(repoRoot, opts).revParse(ref));
    } catch (error) {
      if (error instanceof CodeninjaError && error.code === "git_ref_missing") {
        return undefined;
      }
      throw error;
    }
  }
}

function commitHeaderLineCount(stdout: string): number {
  const lines = stdout.split("\n");
  const blankIndex = lines.findIndex((line) => line === "");
  return blankIndex === -1 ? lines.length : blankIndex;
}

function parseLog(stdout: string): CommitInfo[] {
  return stdout
    .split("\x1e")
    .map((record) => record.replace(/^\n/u, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const fields = record.split("\x1f");
      const [sha, authorName, authoredAt, title, body = ""] = fields;
      if (!sha || !title) {
        throw new CodeninjaError("git_ref_missing", "failed to parse git log output");
      }
      return {
        sha,
        title,
        body: body.replace(/\n$/u, ""),
        ...(authorName ? { authorName } : {}),
        ...(authoredAt ? { authoredAt } : {})
      };
    });
}

function parseGrepLine(line: string, ref: string): SearchResult | undefined {
  const match = /^(?<path>.*?):(?<line>\d+):(?<column>\d+):(?<text>.*)$/u.exec(line);
  if (!match?.groups) {
    return undefined;
  }
  const rawPath = match.groups.path ?? "";
  const pathPrefix = `${ref}:`;
  return {
    path: rawPath.startsWith(pathPrefix) ? rawPath.slice(pathPrefix.length) : rawPath,
    line: Number(match.groups.line ?? "0"),
    column: Number(match.groups.column ?? "0"),
    matchText: match.groups.text ?? ""
  };
}

function splitNul(stdout: string): string[] {
  return stdout.split("\0").filter(Boolean);
}

function trimSha(stdout: string): string {
  return stdout.trim();
}

function orderRemotes(remotes: GitRemote[]): GitRemote[] {
  return [...remotes].sort((a, b) => {
    if (a.name === "origin") {
      return -1;
    }
    if (b.name === "origin") {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });
}
