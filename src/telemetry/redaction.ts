const registeredSecrets = new Set<string>();
// Component lines also protect character cuts, so the writer can match them whole.
const registeredSecretLines = new Set<string>();

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
const CREDENTIAL_RULES: Array<[RegExp, string]> = [
  [URL_USERINFO_PATTERN, "$1[redacted]@"], [AUTH_HEADER_PATTERN, "$1[redacted:pattern]"],
  [TOKEN_ASSIGNMENT_PATTERN, "$1$2[redacted:pattern]"], [GITHUB_TOKEN_PATTERN, "[redacted:pattern]"],
  [GITHUB_PAT_PATTERN, "[redacted:pattern]"], [OPENAI_STYLE_TOKEN_PATTERN, "[redacted:pattern]"],
  [AWS_ACCESS_KEY_PATTERN, "[redacted:pattern]"], [JWT_PATTERN, "[redacted:pattern]"],
  [BEARER_VALUE_PATTERN, "$1[redacted:pattern]"]
];

export function registerSecret(value: string | undefined | null): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length >= 6) {
    registeredSecrets.add(trimmed);
    if (/[\r\n]/u.test(trimmed)) {
      for (const line of trimmed.split(/\r?\n|\r/u)) {
        const component = line.trim();
        if (component.length >= 6) registeredSecretLines.add(component);
      }
    }
  }
}

export function clearRegisteredSecretsForTests(): void {
  registeredSecrets.clear();
  registeredSecretLines.clear();
}

export function stripCredentials<T>(input: T): T {
  return stripValue(input, new WeakSet()) as T;
}

/** Original-text spans protected by exactly the same rules as writer redaction. */
export function credentialSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const secret of [...registeredSecrets, ...registeredSecretLines]) {
    for (let start = text.indexOf(secret); start >= 0; start = text.indexOf(secret, start + 1)) spans.push([start, start + secret.length]);
  }
  for (const [pattern] of CREDENTIAL_RULES) {
    for (const match of text.matchAll(pattern)) spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}

/** Normalize prose whitespace without changing recognized credential values. */
export function normalizeSourceWhitespace(input: string): string {
  const spans = credentialSpans(input).sort((a, b) => a[0] - b[0]);
  if (!spans.length) return input.replace(/\s+/gu, " ").trim();
  const merged: Array<[number, number]> = [];
  for (const [start, end] of spans) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let output = "", pendingSpace = false, index = 0;
  for (const [start, end] of merged) {
    for (; index < start; index++) {
      const char = input[index]!;
      if (/\s/u.test(char)) pendingSpace = output.length > 0;
      else { if (pendingSpace) output += " "; output += char; pendingSpace = false; }
    }
    if (pendingSpace) output += " ";
    output += input.slice(start, end);
    pendingSpace = false;
    index = end;
  }
  for (; index < input.length; index++) {
    const char = input[index]!;
    if (/\s/u.test(char)) pendingSpace = output.length > 0;
    else { if (pendingSpace) output += " "; output += char; pendingSpace = false; }
  }
  return output.trim();
}

/** Clip source without cutting through a registered or recognized credential. */
export function protectedSourceSlice(text: string, requestedStart: number, requestedEnd: number): { text: string; start: number; end: number } {
  let start = Math.max(0, Math.min(text.length, requestedStart));
  let end = Math.max(start, Math.min(text.length, requestedEnd));
  const spans = credentialSpans(text);
  // Recheck overlaps after moving a boundary: credentials can overlap.
  let changed: boolean;
  do {
    const previousStart = start, previousEnd = end;
    for (const [a, b] of spans) {
      if (a < start && start < b) start = b;
      if (a < end && end < b) end = a;
    }
    changed = start !== previousStart || end !== previousEnd;
  } while (changed && start < end);
  if (start > end) start = end;
  if (start > 0 && /[\uD800-\uDBFF]/u.test(text[start - 1]!) && /[\uDC00-\uDFFF]/u.test(text[start] ?? "")) start++;
  if (end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1]!) && /[\uDC00-\uDFFF]/u.test(text[end] ?? "")) end--;
  if (start > end) start = end;
  return { text: text.slice(start, end), start, end };
}

/** Preserve the original cap's packing charge while omitting a cut credential. */
export function protectedSignaturePrefix(text: string, limit: number, trimEnd = true): string {
  const rawPrefix = text.slice(0, limit);
  const safe = protectedSourceSlice(text, 0, limit).text;
  const oldPrefix = trimEnd ? rawPrefix.trimEnd() : rawPrefix;
  const safePrefix = trimEnd ? safe.trimEnd() : safe;
  const space = oldPrefix.length - safePrefix.length;
  const notice = space >= 5 ? "[...]" : "";
  return (safePrefix + notice).padEnd(oldPrefix.length, " ");
}

/** Redact before applying a character cap, including incomplete credential tails. */
export function redactThenTruncate(text: string, maxChars: number, marker = ""): string {
  const redacted = stripCredentials(text);
  const limit = Math.max(0, Math.floor(maxChars));
  if (redacted.length <= limit) return redacted;
  const suffix = marker.slice(0, limit);
  let end = Math.max(0, limit - suffix.length);
  // Do not cut between the UTF-16 halves of a code point.
  if (end > 0 && /[\uD800-\uDBFF]/u.test(redacted[end - 1]!) && /[\uDC00-\uDFFF]/u.test(redacted[end] ?? "")) end--;
  let prefix = redacted.slice(0, end);
  if (suffix) prefix = prefix.trimEnd();
  let registeredStart = prefix.length;
  for (const secret of [...registeredSecrets, ...registeredSecretLines]) {
    for (let size = Math.min(secret.length - 1, prefix.length); size >= 4; size--) {
      if (prefix.endsWith(secret.slice(0, size))) { registeredStart = Math.min(registeredStart, prefix.length - size); break; }
    }
  }
  const tail = /[A-Za-z0-9._~+/=_-]+$/u.exec(prefix);
  let redactStart = registeredStart;
  if (tail) {
    const token = tail[0];
    const credentialPrefix = /^(?:sk-|gh[pousr]_|github_pat_|AKIA|eyJ)/u.test(token);
    const context = prefix.slice(0, tail.index);
    const credentialContext = /(?:\bBearer\s+|\bAuthorization\s*:\s*|\b(?:api[_-]?key|apikey|secret|token|password|passwd|authorization)\s*[:=]\s*['"]?)$/iu.test(context)
      || /^(?:api[_-]?key|apikey|secret|token|password|passwd|authorization)=/iu.test(token);
    if (credentialPrefix || credentialContext) redactStart = Math.min(redactStart, tail.index);
  }
  if (redactStart < prefix.length) {
    const replacement = "[REDACTED]".slice(0, Math.max(0, limit - suffix.length));
    prefix = prefix.slice(0, Math.min(redactStart, Math.max(0, limit - suffix.length - replacement.length))) + replacement;
  }
  const final = stripCredentials(prefix);
  let finalEnd = Math.max(0, limit - suffix.length);
  if (finalEnd > 0 && /[\uD800-\uDBFF]/u.test(final[finalEnd - 1] ?? "") && /[\uDC00-\uDFFF]/u.test(final[finalEnd] ?? "")) finalEnd--;
  return final.slice(0, finalEnd) + suffix;
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
  // Match all registered values against the original input: replacing one
  // first can otherwise hide an overlapping secret from later replacements.
  const spans: Array<[number, number]> = [];
  for (const secret of [...registeredSecrets, ...registeredSecretLines]) {
    for (let start = input.indexOf(secret); start >= 0; start = input.indexOf(secret, start + 1)) spans.push([start, start + secret.length]);
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let output = "", offset = 0;
  for (let i = 0; i < spans.length; i++) {
    const [start, firstEnd] = spans[i]!;
    let end = firstEnd;
    while (i + 1 < spans.length && spans[i + 1]![0] < end) end = Math.max(end, spans[++i]![1]);
    output += input.slice(offset, start) + "[redacted:secret]";
    offset = end;
  }
  output += input.slice(offset);

  for (const [pattern, replacement] of CREDENTIAL_RULES) output = output.replace(pattern, replacement);
  return output;
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
