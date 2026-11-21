import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { InternalGitClient } from "../git/git-client.js";
import type { ResolvedReviewInput } from "../types.js";
import { CodegenieError } from "../util/errors.js";

const CONFIG_PATH = "codegenie.toml";
const SKILLS_PATH = ".codegenie/skills";

export type RepositoryPolicyFile = { path: string; content: string };
export type RepositorySkillFile = RepositoryPolicyFile | { path: string; readError: string };

export type RepositoryPolicy =
  | { origin: "base-revision"; revision: string; config?: RepositoryPolicyFile; skillFiles: RepositoryPolicyFile[] }
  | { origin: "working-tree"; revision?: never; config?: RepositoryPolicyFile; skillFiles: RepositorySkillFile[] }
  | { origin: "none"; revision?: never; config?: never; skillFiles: [] };

export function isRepositoryPolicyPath(filePath: string): boolean {
  return filePath === CONFIG_PATH || isRepositorySkillPath(filePath);
}

function isRepositorySkillPath(filePath: string): boolean {
  return filePath.startsWith(`${SKILLS_PATH}/`) && filePath.endsWith(".md");
}

export async function readRepoConfigAt(git: InternalGitClient, revision: string): Promise<RepositoryPolicyFile | undefined> {
  const entry = await git.lsTreeEntry(revision, CONFIG_PATH);
  if (entry === undefined) {
    return undefined;
  }
  if (entry.type !== "blob" || entry.mode === "120000") {
    throw new CodegenieError("config_error", `expected a regular config file at ${revision}:${CONFIG_PATH}`);
  }
  return { path: CONFIG_PATH, content: await git.catFile(revision, CONFIG_PATH) };
}

export async function readBaseRevisionPolicy(resolved: ResolvedReviewInput, git: InternalGitClient): Promise<RepositoryPolicy> {
  const revision = resolved.baseRef;
  if (revision === undefined || revision === await git.emptyTreeSha()) {
    return { origin: "none", skillFiles: [] };
  }
  const config = await readRepoConfigAt(git, revision);
  const files = (await git.lsTree(revision)).filter(isRepositorySkillPath).sort(comparePaths);
  const skillFiles: RepositoryPolicyFile[] = [];
  for (const filePath of files) {
    skillFiles.push({ path: filePath, content: await git.catFile(revision, filePath) });
  }
  return { origin: "base-revision", revision, ...(config !== undefined ? { config } : {}), skillFiles };
}

// Evals deliberately retain the policy from their fixture checkout.
export function readWorkingTreePolicy(repoRoot: string): RepositoryPolicy {
  const configPath = path.join(repoRoot, CONFIG_PATH);
  let config: RepositoryPolicyFile | undefined;
  try {
    if (existsSync(configPath)) config = { path: CONFIG_PATH, content: readFileSync(configPath, "utf8") };
  } catch (cause) {
    throw new CodegenieError("config_error", `failed to read config file at ${configPath}`, { context: { path: configPath }, cause });
  }
  const skillFiles = discoverMarkdownFiles(path.join(repoRoot, SKILLS_PATH)).map((filePath): RepositorySkillFile => {
    const relativePath = path.relative(repoRoot, filePath).split(path.sep).join("/");
    try {
      return { path: relativePath, content: readFileSync(filePath, "utf8") };
    } catch (cause) {
      return { path: relativePath, readError: cause instanceof Error ? cause.message : String(cause) };
    }
  });
  return { origin: "working-tree", ...(config !== undefined ? { config } : {}), skillFiles };
}

export function discoverMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const stat = statSync(root);
  if (stat.isFile()) return root.endsWith(".md") ? [root] : [];
  if (!stat.isDirectory()) return [];

  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (entry.isFile() && filePath.endsWith(".md")) files.push(filePath);
    }
  };
  visit(root);
  return files.sort(comparePaths);
}

function comparePaths(a: string, b: string): number {
  return a.localeCompare(b);
}
