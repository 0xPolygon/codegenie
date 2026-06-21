import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TelemetryRecorder } from "../../src/telemetry/telemetry-recorder.js";

export function initRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "codegenie-git-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Test User"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  return repo;
}

export function git(repo: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com"
    }
  });
}

export function writeRepoFile(repo: string, relPath: string, content: string): void {
  const fullPath = path.join(repo, relPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

export function commitAll(repo: string, message: string, body?: string): string {
  git(repo, ["add", "."]);
  const args = ["commit", "-m", message];
  if (body !== undefined) {
    args.push("-m", body);
  }
  git(repo, args);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

export function nullTelemetry(): TelemetryRecorder {
  return {
    runId: "test-run",
    runDir: undefined,
    event: () => undefined,
    recordModelCall: () => undefined,
    recordToolCall: () => "tc-test",
    writeArtifact: async () => undefined,
    writeDebug: async () => undefined,
    flush: async () => undefined
  };
}
