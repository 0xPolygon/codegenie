import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeReviewCommand, parseReviewCommand } from "../src/cli/review-command.js";
import { executeEvalCommand } from "../src/evals/eval-command.js";
import { commitAll, initRepo, writeRepoFile } from "./helpers/git.js";

const model = "gpt-4.1-mini";
const envKey = "fixture-env-openai-key";
const storedKey = "fixture-override-openai-key";

function authFixture(stored: boolean) {
  const directory = mkdtempSync(path.join(tmpdir(), "codegenie-auth-home-"));
  const home = path.join(directory, "override");
  const ambientHome = path.join(directory, "ambient");
  const suite = path.join(directory, "suite");
  for (const dir of [home, ambientHome, suite]) mkdirSync(dir);
  function writeAuth(dir: string, apiKey: string) {
    writeFileSync(path.join(dir, "auth.json"), JSON.stringify({
      openai: { type: "api_key", apiKey, createdAt: new Date(0).toISOString() }
    }));
  }
  writeAuth(ambientHome, "fixture-ambient-openai-key");
  if (stored) writeAuth(home, storedKey);
  vi.stubEnv("CODEGENIE_HOME", ambientHome);
  vi.stubEnv("OPENAI_API_KEY", envKey);
  const authorization: Array<string | null> = [];
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    authorization.push(headers.get("authorization"));
    return new Response(JSON.stringify({ error: { message: "Stopped by offline test", type: "invalid_request_error" } }), {
      status: 400, headers: { "content-type": "application/json" }
    });
  });
  const repo = initRepo();
  writeRepoFile(repo, "app.ts", "export const count = 1;\n");
  const base = commitAll(repo, "base");
  writeRepoFile(repo, "app.ts", "export const count = 2;\n");
  const head = commitAll(repo, "change");
  return {
    home, suite, repo, base, head, authorization,
    logs: path.join(directory, "logs"),
    dispose() {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  };
}

describe("resolved auth home", () => {
  it.each([
    { entrypoint: "review", stored: true },
    { entrypoint: "review", stored: false },
    { entrypoint: "eval", stored: true },
    { entrypoint: "repeat eval", stored: false }
  ] as const)("$entrypoint selects the resolved home's key when stored=$stored", async ({ entrypoint, stored }) => {
    const fixture = authFixture(stored);
    try {
      const { home, suite, repo, base, head, logs } = fixture;
      writeFileSync(path.join(home, "config.toml"), `[llm]\nprovider = "openai"\nmodel = "${model}"\n[cache]\nenabled = false\n`);
      const options = { repoRoot: repo, homeOverride: home, env: {}, writeOutput: () => undefined };
      if (entrypoint === "review") {
        const parsed = parseReviewCommand(["review", "--base", base, "--head", head], options);
        await expect(executeReviewCommand(parsed, options)).rejects.toMatchObject({ code: "llm_call_failed" });
      } else {
        writeFileSync(path.join(suite, "case.yml"), JSON.stringify({
          name: "live-auth", repo: { external: repo }, command: { base, head }, logs: { dir: logs },
          ...(entrypoint === "repeat eval" ? { repeat: 2, review: { cache: false } } : {})
        }));
        await expect(executeEvalCommand(["eval", "--eval-dir", suite], options)).resolves.toBe(1);
      }
      expect(new Set(fixture.authorization)).toEqual(new Set([`Bearer ${stored ? storedKey : envKey}`]));
    } finally {
      fixture.dispose();
    }
  });

  it("uses the resolved auth home for live and artifact-replay recommendation judging", async () => {
    const fixture = authFixture(true);
    try {
      const { home, suite, repo, base, head, logs } = fixture;
      writeFileSync(path.join(home, "config.toml"), '[llm]\nprovider = "fake"\nmodel = "fake-model"\n');
      writeFileSync(path.join(suite, "case.yml"), JSON.stringify({
        name: "judge-auth", repo: { external: repo }, command: { base, head }, logs: { dir: logs },
        recommendationJudge: {
          provider: "openai", model, reasoning: "low", checks: [{ id: "advice", rubric: "Preserve the published contract." }]
        }
      }));
      const options = { repoRoot: repo, homeOverride: home, env: {} };
      await expect(executeEvalCommand(["eval", "--eval-dir", suite], options)).resolves.toBe(0);
      expect(fixture.authorization).toEqual([`Bearer ${storedKey}`]);
      await expect(executeEvalCommand(["eval", "--from-artifacts", path.join(logs, "1"), "--judge"], options)).resolves.toBe(0);
      expect(fixture.authorization).toEqual([`Bearer ${storedKey}`, `Bearer ${storedKey}`]);
    } finally {
      fixture.dispose();
    }
  });
});
