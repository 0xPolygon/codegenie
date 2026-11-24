const registeredSecrets = new Set<string>();
// Multiline component lines are redacted at telemetry sinks.
const sinkOnlySecrets = new Set<string>();

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
// Retry neither of these unbounded patterns at every separator in a long
// token. If the earliest eligible start fails, a later start in the same
// run cannot match. Capture the actual credential without the skipped prefix.
const BOUNDARY_SCAN_PATTERNS = new Map([
  [URL_USERINFO_PATTERN, new RegExp(
    String.raw`(?<![a-z0-9+.-])(?:(?!\b[a-z])[a-z0-9+.-])*(${URL_USERINFO_PATTERN.source})`, "gi")],
  [JWT_PATTERN, new RegExp(
    String.raw`(?<![A-Za-z0-9_-])(?:(?!\beyJ)[A-Za-z0-9_-])*(${JWT_PATTERN.source})`, "g")]
]);

export function registerSecret(value: string | undefined | null): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length >= 6) {
    registeredSecrets.add(trimmed);
    addSecretVariants(sinkOnlySecrets, trimmed);
    if (/[\r\n]/u.test(trimmed)) {
      for (const line of trimmed.split(/\r?\n|\r/u)) {
        const component = line.trim();
        if (component.length >= 6) addSecretVariants(sinkOnlySecrets, component);
      }
    }
  }
}

function addSecretVariants(target: Set<string>, value: string): void {
  target.add(value);
  // Verifier repair serializes angle-bracket escapes into persisted requests.
  const escaped = value.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  target.add(escaped);
  target.add(JSON.stringify(escaped).slice(1, -1));
}

export function clearRegisteredSecretsForTests(): void {
  registeredSecrets.clear();
  sinkOnlySecrets.clear();
}

export function stripCredentials<T>(input: T): T {
  return stripValue(input, new WeakSet(), false) as T;
}

/** Retreat a model-facing cut to the start of any credential it would split. */
export function credentialSafeCut(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;

  const spans: Array<[start: number, end: number]> = [];
  for (const secret of registeredSecrets) {
    for (let start = text.indexOf(secret); start >= 0 && start < index; start = text.indexOf(secret, start + 1)) {
      spans.push([start, start + secret.length]);
    }
  }
  // Run patterns on the original text to preserve word boundaries and detect
  // values that extend beyond a fixed lookaround window.
  for (const [pattern] of CREDENTIAL_RULES) {
    const scan = BOUNDARY_SCAN_PATTERNS.get(pattern);
    for (const match of text.matchAll(scan ?? pattern)) {
      const end = match.index + match[0].length;
      const start = scan ? end - match[1]!.length : match.index;
      if (start >= index) break;
      spans.push([start, end]);
    }
  }

  // Moving a cut can enter another overlapping span. Walk backwards so each
  // earlier span is checked at the new boundary before it is returned.
  spans.sort(([a], [b]) => b - a);
  for (const [start, end] of spans) {
    if (start < index && index < end) index = start;
  }
  return index;
}

/** Include additional component and encoded variants only for persisted output. */
export function stripCredentialsAtSink<T>(input: T): T {
  return stripValue(input, new WeakSet(), true) as T;
}

/** Redact before applying a character cap, including incomplete credential tails. */
export function redactThenTruncate(text: string, maxChars: number, marker = "", preserveUtf16Boundary = false): string {
  const redacted = stripCredentialsAtSink(text);
  const limit = Math.max(0, Math.floor(maxChars));
  if (redacted.length <= limit) return redacted;
  const suffix = marker.slice(0, limit);
  let end = Math.max(0, limit - suffix.length);
  // Do not cut between the UTF-16 halves of a code point.
  if (!preserveUtf16Boundary && end > 0 && /[\uD800-\uDBFF]/u.test(redacted[end - 1]!) && /[\uDC00-\uDFFF]/u.test(redacted[end] ?? "")) end--;
  let prefix = redacted.slice(0, end);
  if (suffix) prefix = prefix.trimEnd();
  let registeredStart = prefix.length;
  for (const secret of [...registeredSecrets, ...sinkOnlySecrets]) {
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
  const final = stripCredentialsAtSink(prefix);
  let finalEnd = Math.max(0, limit - suffix.length);
  if (!preserveUtf16Boundary && finalEnd > 0 && /[\uD800-\uDBFF]/u.test(final[finalEnd - 1] ?? "") && /[\uDC00-\uDFFF]/u.test(final[finalEnd] ?? "")) finalEnd--;
  return final.slice(0, finalEnd) + suffix;
}

export type RedactionSummary = {
  applied: boolean;
  markerCounts: Record<string, number>;
};

export function stripCredentialsWithSummary<T>(input: T): { value: T; summary: RedactionSummary } {
  const value = stripCredentialsAtSink(input);
  const markerCounts = countRedactionMarkers(stableInspectableText(value));
  return {
    value,
    summary: {
      applied: Object.keys(markerCounts).length > 0,
      markerCounts
    }
  };
}

function stripValue(input: unknown, active: WeakSet<object>, sink: boolean): unknown {
  if (typeof input === "string") {
    return stripString(input, sink);
  }

  if (Array.isArray(input)) {
    if (active.has(input)) {
      return "[redacted:circular]";
    }
    active.add(input);
    try {
      return input.map((item) => stripValue(item, active, sink));
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

      const entries = Object.entries(input);
      if (sink) {
        const names = redactSinkKeys(entries);
        return Object.fromEntries(entries.map(([key, value]) => [
          names.get(key) ?? key, stripValue(value, active, true)
        ]));
      }

      const output: Record<string, unknown> = {};
      for (const [key, value] of entries) {
        output[key] = stripValue(value, active, false);
      }
      return output;
    } finally {
      active.delete(input);
    }
  }

  return input;
}

function redactSinkKeys(entries: Array<[string, unknown]>): Map<string, string> {
  const used = new Set<string>();
  const changed = new Map<string, string>();
  for (const [key] of entries) {
    const redacted = stripString(key, true);
    if (redacted === key) used.add(key);
    else changed.set(key, redacted);
  }

  // Reserve literal keys before allocating suffixes. Sort only allocation,
  // then emit properties in the caller's original order.
  const nextSuffix = new Map<string, number>();
  for (const key of [...changed.keys()].sort()) {
    const redacted = changed.get(key)!;
    let name = redacted;
    if (used.has(name)) {
      let suffix = nextSuffix.get(redacted) ?? 2;
      do {
        name = `${redacted}#${suffix++}`;
      } while (used.has(name));
      nextSuffix.set(redacted, suffix);
    }
    changed.set(key, name);
    used.add(name);
  }
  return changed;
}

function stripString(input: string, sink: boolean): string {
  if (!sink) {
    let output = input;
    for (const secret of registeredSecrets) output = output.split(secret).join("[redacted:secret]");
    for (const [pattern, replacement] of CREDENTIAL_RULES) output = output.replace(pattern, replacement);
    return output;
  }
  // Match all registered values against the original input: replacing one
  // first can otherwise hide an overlapping secret from later replacements.
  const spans: Array<[number, number]> = [];
  for (const secret of [...registeredSecrets, ...sinkOnlySecrets]) {
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
