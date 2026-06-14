const registeredSecrets = new Set<string>();

const URL_USERINFO_PATTERN = /(\b[a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi;
const AUTH_HEADER_PATTERN = /\b(Authorization\s*:\s*)([^\r\n]+)/gi;
const TOKEN_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|apikey|secret|token|password|passwd|authorization)\b(\s*[:=]\s*['"]?)([^\s'",}]{6,})/gi;
const GITHUB_TOKEN_PATTERN = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g;
const GITHUB_PAT_PATTERN = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g;
const OPENAI_STYLE_TOKEN_PATTERN = /\bsk-[A-Za-z0-9_-]{20,}\b/g;
const AWS_ACCESS_KEY_PATTERN = /\bAKIA[0-9A-Z]{16}\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const BEARER_VALUE_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}={0,2}\b/gi;

export function registerSecret(value: string | undefined | null): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length >= 6) {
    registeredSecrets.add(trimmed);
  }
}

export function clearRegisteredSecretsForTests(): void {
  registeredSecrets.clear();
}

export function stripCredentials<T>(input: T): T {
  return stripValue(input, new WeakSet()) as T;
}

export type RedactionSummary = {
  applied: boolean;
  markerCounts: Record<string, number>;
};

export function stripCredentialsWithSummary<T>(input: T): { value: T; summary: RedactionSummary } {
  const value = stripCredentials(input);
  const markerCounts = countRedactionMarkers(stableInspectableText(value));
  return {
    value,
    summary: {
      applied: Object.keys(markerCounts).length > 0,
      markerCounts
    }
  };
}

function stripValue(input: unknown, active: WeakSet<object>): unknown {
  if (typeof input === "string") {
    return stripString(input);
  }

  if (Array.isArray(input)) {
    if (active.has(input)) {
      return "[redacted:circular]";
    }
    active.add(input);
    try {
      return input.map((item) => stripValue(item, active));
    } finally {
      active.delete(input);
    }
  }

  if (input && typeof input === "object") {
    if (active.has(input)) {
      return "[redacted:circular]";
    }
    active.add(input);

    try {
      if (input instanceof Date) {
        return input.toISOString();
      }

      const output: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input)) {
        output[key] = stripValue(value, active);
      }
      return output;
    } finally {
      active.delete(input);
    }
  }

  return input;
}

function stripString(input: string): string {
  let output = input;
  for (const secret of registeredSecrets) {
    output = output.split(secret).join("[redacted:secret]");
  }

  return output
    .replace(URL_USERINFO_PATTERN, "$1[redacted]@")
    .replace(AUTH_HEADER_PATTERN, "$1[redacted:pattern]")
    .replace(TOKEN_ASSIGNMENT_PATTERN, "$1$2[redacted:pattern]")
    .replace(GITHUB_TOKEN_PATTERN, "[redacted:pattern]")
    .replace(GITHUB_PAT_PATTERN, "[redacted:pattern]")
    .replace(OPENAI_STYLE_TOKEN_PATTERN, "[redacted:pattern]")
    .replace(AWS_ACCESS_KEY_PATTERN, "[redacted:pattern]")
    .replace(JWT_PATTERN, "[redacted:pattern]")
    .replace(BEARER_VALUE_PATTERN, "$1[redacted:pattern]");
}

function stableInspectableText(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return String(input);
  }
}

function countRedactionMarkers(input: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const match of input.matchAll(/\[redacted(?::([a-z0-9_-]+))?\]/gi)) {
    const key = match[1] ?? "url-userinfo";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
