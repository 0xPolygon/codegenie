import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCodegeniePackageRoot, resolveCodegenieRuntimeProvenance } from "./runtime-provenance.js";

export type CodegenieVersionInfo = {
  version: string;
  commit?: string;
};

/** Version and build commit of the running codegenie. Prefers the line
 * stamped into dist/version at build time (the only provenance available in
 * an npm install); falls back to runtime provenance for source checkouts. */
export function codegenieVersionInfo(): CodegenieVersionInfo {
  const generated = readGeneratedVersionLine();
  const match = generated !== undefined ? /^codegenie v(\S+) \/ (\S+)$/u.exec(generated) : null;
  if (match !== null && match[1] !== undefined) {
    const commit = match[2];
    return { version: match[1], ...(commit !== undefined && commit !== "unknown" ? { commit } : {}) };
  }
  const provenance = resolveCodegenieRuntimeProvenance();
  return {
    version: provenance.packageVersion,
    ...(provenance.commit !== undefined ? { commit: provenance.commit } : {})
  };
}

/** URL of the current GitHub Actions run, when running inside one. */
export function workflowRunUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const server = nonEmpty(env.GITHUB_SERVER_URL);
  const repo = nonEmpty(env.GITHUB_REPOSITORY);
  const runId = nonEmpty(env.GITHUB_RUN_ID);
  if (server === undefined || repo === undefined || runId === undefined) {
    return undefined;
  }
  return `${server}/${repo}/actions/runs/${runId}`;
}

export function readGeneratedVersionLine(): string | undefined {
  if (!runningFromDist()) {
    return undefined;
  }
  const packageRoot = findCodegeniePackageRoot();
  if (packageRoot === undefined) {
    return undefined;
  }
  const versionPath = path.join(packageRoot, "dist", "version");
  if (!existsSync(versionPath)) {
    return undefined;
  }
  const line = readFileSync(versionPath, "utf8").trim();
  return line.length > 0 ? line : undefined;
}

function runningFromDist(): boolean {
  const filePath = fileURLToPath(import.meta.url);
  return filePath.split(path.sep).includes("dist");
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}
