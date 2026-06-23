import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = typeof packageJson.version === "string" && packageJson.version.trim()
  ? packageJson.version.trim()
  : "unknown";

const commit = nonEmpty(process.env.CODEGENIE_BUILD_COMMIT) ?? gitCommit() ?? "unknown";
const line = `codegenie v${version} / ${commit}`;

mkdirSync(path.join(root, "dist"), { recursive: true });
writeFileSync(path.join(root, "dist", "version"), `${line}\n`);

function gitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      CLICOLOR: "0"
    },
    timeout: 10_000
  });
  return nonEmpty(result.stdout);
}

function nonEmpty(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
