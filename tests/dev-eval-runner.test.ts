import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const checkout = process.cwd();
const runner = path.join(checkout, "evals/runner/main.mjs");
const caseModule = pathToFileURL(path.join(checkout, "evals/runner/case.mjs")).href;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

beforeAll(() => {
  execFileSync("pnpm", ["build"], { cwd: checkout, stdio: "pipe" });
}, 60_000);

describe("development eval entry point", () => {
  it("runs one bundled fixture through the built eval runner with external artifacts", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "codegenie-dev-eval-"));
    try {
      const config = path.join(tmp, "campaign.json");
      const output = path.join(tmp, "output");
      writeFileSync(config, JSON.stringify({ caseDir: path.join(checkout, "evals/fixtures"), caseName: "fixture-core-lens", outputDir: output }));
      const raw = execFileSync("node", [runner, "run", "--campaign", config], { encoding: "utf8", env: { ...process.env, CODEGENIE_HOME: path.join(tmp, "home") }, timeout: 60_000 });
      const result = JSON.parse(raw) as { status: string; runDir: string; caseName: string };
      expect(result).toMatchObject({ caseName: "fixture-core-lens", status: "pass" });
      expect(result.runDir.startsWith(`${output}${path.sep}`)).toBe(true);
      expect(JSON.parse(readFileSync(path.join(result.runDir, "info.json"), "utf8"))).toBeDefined();
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }, 90_000);

  it("prepares a pinned detached checkout and refuses to overwrite a dirty one", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "codegenie-%20-dev-eval-git-"));
    try {
      const source = path.join(tmp, "source"), target = path.join(tmp, "target");
      mkdirSync(source);
      git(source, "init", "--quiet");
      git(source, "config", "user.name", "Fixture");
      git(source, "config", "user.email", "fixture@example.test");
      writeFileSync(path.join(source, "source.txt"), "base\n");
      git(source, "add", "source.txt"); git(source, "commit", "--quiet", "-m", "base");
      const base = git(source, "rev-parse", "HEAD");
      writeFileSync(path.join(source, "source.txt"), "head\n");
      git(source, "commit", "--quiet", "-am", "head");
      const head = git(source, "rev-parse", "HEAD");
      const script = `import {prepareTarget} from ${JSON.stringify(caseModule)}; prepareTarget(...process.argv.slice(1));`;
      const invoke = () => execFileSync("node", ["--input-type=module", "-e", script, target, pathToFileURL(source).href, base, head], { stdio: "pipe" });
      const badTarget = path.join(tmp, "bad-parent");
      expect(() => execFileSync("node", ["--input-type=module", "-e", script, badTarget, pathToFileURL(source).href, head, head], { stdio: "pipe" })).toThrow();
      expect(existsSync(badTarget)).toBe(false);
      expect(readdirSync(tmp).filter((name) => name.startsWith(".bad-parent-staging-"))).toEqual([]);
      const failing = () => execFileSync("node", ["--input-type=module", "-e", script, target, pathToFileURL(path.join(tmp, "missing")).href, base, head], { stdio: "pipe" });
      expect(failing).toThrow();
      expect(existsSync(target)).toBe(false);
      expect(readdirSync(tmp).filter((name) => name.startsWith(".target-staging-"))).toEqual([]);
      invoke(); invoke();
      expect(git(target, "rev-parse", "HEAD")).toBe(head);
      writeFileSync(path.join(target, "source.txt"), "local changes\n");
      expect(invoke).toThrow();
      expect(readFileSync(path.join(target, "source.txt"), "utf8")).toBe("local changes\n");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
