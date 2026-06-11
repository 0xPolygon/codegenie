import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CodeninjaPaths } from "../types.js";

export function getCodeninjaPaths(
  homeOverride?: string,
  env: NodeJS.ProcessEnv = process.env
): CodeninjaPaths {
  const home = resolveHomePath(homeOverride ?? env.CODENINJA_HOME ?? "~/.codeninja");
  return {
    home,
    authPath: path.join(home, "auth.json"),
    modelsPath: path.join(home, "models.json"),
    settingsPath: path.join(home, "settings.json"),
    configTomlPath: path.join(home, "config.toml"),
    sessionsDir: path.join(home, "sessions")
  };
}

export function ensureCodeninjaHome(paths: CodeninjaPaths = getCodeninjaPaths()): CodeninjaPaths {
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
