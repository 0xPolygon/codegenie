import { resolveCodegenieRuntimeProvenance } from "../util/runtime-provenance.js";
import { readGeneratedVersionLine } from "../util/version-info.js";

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
