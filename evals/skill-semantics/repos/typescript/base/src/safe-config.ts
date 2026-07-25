import { connect, type Config } from "./config.js";

export function useValidatedConfig(input: unknown): boolean {
  if (!isConfig(input)) {
    throw new Error("invalid config");
  }
  return connect(input);
}

function isConfig(input: unknown): input is Config {
  return typeof input === "object" && input !== null &&
    typeof (input as Record<string, unknown>).url === "string" &&
    typeof (input as Record<string, unknown>).retries === "number";
}
