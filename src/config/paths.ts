import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CodegeniePaths } from "../types.js";

export function getCodegeniePaths(
  homeOverride?: string,
  env: NodeJS.ProcessEnv = process.env
): CodegeniePaths {
  const home = resolveHomePath(homeOverride ?? env.CODEGENIE_HOME ?? "~/.codegenie");
  return {
    home,
    authPath: path.join(home, "auth.json"),
    modelsPath: path.join(home, "models.json"),
    settingsPath: path.join(home, "settings.json"),
    configTomlPath: path.join(home, "config.toml"),
    sessionsDir: path.join(home, "sessions")
  };
}

export function ensureCodegenieHome(paths: CodegeniePaths = getCodegeniePaths()): CodegeniePaths {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  mkdirSync(paths.sessionsDir, { recursive: true, mode: 0o700 });
  return paths;
}

export function resolveHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  return path.resolve(value);
}
