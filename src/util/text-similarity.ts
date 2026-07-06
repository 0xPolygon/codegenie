// Shared text similarity and follow-up key normalizers live here first.
// Stage-local copies are a review flag unless their semantics are named here.
const ROOT_CAUSE_STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "before",
  "because",
  "being",
  "cannot",
  "code",
  "could",
  "from",
  "have",
  "into",
  "line",
  "more",
  "should",
  "that",
  "this",
  "when",
  "where",
  "will",
  "with",
  "without",
  "would"
]);

export const ATTENTION_SIMILARITY_STOP_WORDS = new Set([
  ...ROOT_CAUSE_STOP_WORDS,
  "check",
  "confirm",
  "review",
  "verify"
]);

export function normalizedTerms(text: string, stopWords: ReadonlySet<string> = ROOT_CAUSE_STOP_WORDS): Set<string> {
  return new Set(text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/gu, " ")
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4 && !stopWords.has(term)));
}

export function normalizedAttentionTerms(text: string): Set<string> {
  return normalizedTerms(text, ATTENTION_SIMILARITY_STOP_WORDS);
}

export function tokenJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const term of a) {
    if (b.has(term)) {
      intersection += 1;
    }
  }
  return intersection / (a.size + b.size - intersection);
}

export function cleanStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

export function normalizeFollowUpQuestion(question: string): string {
  return question.toLowerCase()
    .replace(/[`"'’]/gu, "")
    .replace(/[^a-z0-9_./:-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeLooseFollowUpQuestion(question: string): string {
  return question
    .replace(/^(please\s+)?(check|confirm|verify|investigate|review)\s+(whether|if|that)?\s*/u, "")
    .replace(/^(whether|if)\s+/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}
