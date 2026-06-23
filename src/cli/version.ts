import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCodegeniePackageRoot, resolveCodegenieRuntimeProvenance } from "../util/runtime-provenance.js";

export function renderVersion(): string {
  const generated = readGeneratedVersionLine();
  if (generated !== undefined) {
    return `${generated}\n`;
  }
  const provenance = resolveCodegenieRuntimeProvenance();
  return formatVersionLine(provenance.packageVersion, provenance.commit);
}

export function formatVersionLine(version: string, commit: string | undefined): string {
  return `codegenie v${version} / ${commit ?? "unknown"}\n`;
}

function readGeneratedVersionLine(): string | undefined {
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
