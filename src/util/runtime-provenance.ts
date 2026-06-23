import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodegenieRuntimeProvenance } from "../types.js";

type RuntimeProvenanceOptions = {
  env?: NodeJS.ProcessEnv;
  projectRoot?: string;
  packageVersion?: string;
  runGit?: (cwd: string, args: string[]) => string;
};

const BUILD_ENV_KEYS = [
  "CODEGENIE_BUILD_VERSION",
  "CODEGENIE_BUILD_COMMIT",
  "CODEGENIE_BUILD_BRANCH",
  "CODEGENIE_BUILD_DIRTY"
] as const;

export function resolveCodegenieRuntimeProvenance(
  opts: RuntimeProvenanceOptions = {}
): CodegenieRuntimeProvenance {
  const env = opts.env ?? process.env;
  const packageRoot = opts.projectRoot ?? findCodegeniePackageRoot();
  const packageVersion =
    nonEmpty(env.CODEGENIE_BUILD_VERSION) ??
    nonEmpty(opts.packageVersion) ??
    (packageRoot !== undefined ? readPackageVersion(packageRoot) : undefined) ??
    nonEmpty(env.npm_package_version) ??
    "unknown";

  const buildCommit = nonEmpty(env.CODEGENIE_BUILD_COMMIT);
  const buildBranch = nonEmpty(env.CODEGENIE_BUILD_BRANCH);
  const buildDirty = parseDirtyFlag(env.CODEGENIE_BUILD_DIRTY);
  if (BUILD_ENV_KEYS.some((key) => nonEmpty(env[key]) !== undefined)) {
    return withOptionalGitFields({
      packageVersion,
      ...(buildCommit !== undefined ? { commit: buildCommit } : {}),
      ...(buildBranch !== undefined ? { branch: buildBranch } : {}),
      ...(buildDirty !== undefined ? { dirty: buildDirty } : {}),
      source: "build_env"
    });
  }

  if (packageRoot !== undefined) {
    const git = readGitProvenance(packageRoot, opts.runGit ?? runGitSync);
    if (git !== undefined) {
      return withOptionalGitFields({
        packageVersion,
        ...git,
        source: "git"
      });
    }
  }

  return {
    packageVersion,
    source: packageVersion === "unknown" ? "unknown" : "package"
  };
}

function readGitProvenance(
  cwd: string,
  runGit: (cwd: string, args: string[]) => string
): Pick<CodegenieRuntimeProvenance, "commit" | "branch" | "dirty"> | undefined {
  let commit: string | undefined;
  try {
    commit = nonEmpty(runGit(cwd, ["rev-parse", "HEAD"]));
  } catch {
    return undefined;
  }
  if (commit === undefined) {
    return undefined;
  }

  let branch: string | undefined;
  try {
    branch = nonEmpty(runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]));
  } catch {
    branch = undefined;
  }

  let dirty: boolean | undefined;
  try {
    dirty = runGit(cwd, ["status", "--porcelain"]).trim().length > 0;
  } catch {
    dirty = undefined;
  }

  return {
    commit,
    ...(branch !== undefined && branch !== "HEAD" ? { branch } : {}),
    ...(dirty !== undefined ? { dirty } : {})
  };
}

function runGitSync(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      CLICOLOR: "0"
    },
    shell: false,
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git exited ${result.status ?? "unknown"}`);
  }
  return result.stdout.trim();
}

function withOptionalGitFields(
  input: {
    packageVersion: string;
    commit?: string;
    branch?: string;
    dirty?: boolean;
    source: CodegenieRuntimeProvenance["source"];
  }
): CodegenieRuntimeProvenance {
  return {
    packageVersion: input.packageVersion,
    ...(input.commit !== undefined ? { commit: input.commit, shortCommit: input.commit.slice(0, 12) } : {}),
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    ...(input.dirty !== undefined ? { dirty: input.dirty } : {}),
    source: input.source
  };
}

export function findCodegeniePackageRoot(): string | undefined {
  let currentDir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown };
        if (parsed.name === "codegenie" || parsed.name === "@0xsequence/codegenie") {
          return currentDir;
        }
      } catch {
        return currentDir;
      }
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    currentDir = parent;
  }
  return undefined;
}

function readPackageVersion(packageRoot: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim().length > 0 ? parsed.version.trim() : undefined;
  } catch {
    return undefined;
  }
}

function parseDirtyFlag(value: string | undefined): boolean | undefined {
  const normalized = nonEmpty(value)?.toLowerCase();
  if (normalized === undefined) {
    return undefined;
  }
  if (["1", "true", "yes", "dirty"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "clean"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
