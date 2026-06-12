import { stripCredentials } from "../telemetry/redaction.js";

export function sanitizeGitHubCommentBody(body: string): string {
  return scrubGitHubSecrets(
    body
      .replace(/<!--[\s\S]*?-->/gu, "")
      .replace(/(^|[^\w`])@([A-Za-z0-9][A-Za-z0-9-]*)/gu, "$1`@$2`")
  );
}

export function scrubGitHubSecrets<T>(input: T): T {
  return scrubValue(input, new WeakSet()) as T;
}

function scrubValue(input: unknown, seen: WeakSet<object>): unknown {
  if (typeof input === "string") {
    return scrubSecretString(input);
  }
  if (Array.isArray(input)) {
    return input.map((item) => scrubValue(item, seen));
  }
  if (input && typeof input === "object") {
    if (seen.has(input)) {
      return "[redacted:circular]";
    }
    seen.add(input);
    if (input instanceof Date) {
      return input.toISOString();
    }
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      output[key] = scrubValue(value, seen);
    }
    return output;
  }
  return input;
}

function scrubSecretString(body: string): string {
  return String(stripCredentials(body))
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "[redacted:private-key]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{36,}\b/gu, "[redacted:github-token]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{22,}\b/gu, "[redacted:github-token]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, "[redacted:aws-key]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu, "[redacted:slack-token]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, "[redacted:jwt]")
    .replace(/\b(api[_-]?key|secret|token|passw(?:or)?d|authorization)(\s*[:=]\s*['"]?)\S{8,}/giu, "$1$2[redacted:secret]");
}
