import type { IntentSignal, IntentSignals } from "../types.js";

type IntentSource = IntentSignal["source"];

type IntentSignalInput = {
  pr?: {
    title?: string;
    body?: string;
  };
  commits?: Array<{
    sha?: string;
    title?: string;
    body?: string;
  }>;
};

type PatternGroup = {
  kind: IntentSignal["kind"];
  reason: string;
  patterns: RegExp[];
};

const MAX_SIGNALS = 16;
const MAX_SNIPPET_CHARS = 240;

const PATTERN_GROUPS: PatternGroup[] = [
  {
    kind: "explicitlyBehaviorPreserving",
    reason: "text explicitly claims behavior should be preserved",
    patterns: [
      /\bbehaviou?r[-\s]?preserving\b/iu,
      /\bno\s+behaviou?r\s+change\b/iu,
      /\bno\s+semantic\s+change\b/iu,
      /\bpreserve\s+(?:existing\s+)?behaviou?r\b/iu,
      /\bsemantically\s+equivalent\b/iu,
      /\bequivalence\b/iu
    ]
  },
  {
    kind: "refactorLike",
    reason: "text presents the change as a refactor or cleanup",
    patterns: [
      /\brefactor(?:ing|ed)?\b/iu,
      /\bclean\s*up\b/iu,
      /\bcleanup\b/iu,
      /\bconsolidat(?:e|es|ed|ing|ion)\b/iu,
      /\bdeduplicat(?:e|es|ed|ing|ion)\b/iu,
      /\bsimplif(?:y|ies|ied|ication)\b/iu,
      /\breorganis(?:e|es|ed|ing|ation)\b/iu,
      /\breorganiz(?:e|es|ed|ing|ation)\b/iu,
      /\bextract(?:ed|ing)?\b/iu,
      /\brename(?:d|s|ing)?\b/iu,
      /\bmove(?:d|s|ing)?\b/iu
    ]
  },
  {
    kind: "behaviorChangeLike",
    reason: "text suggests a caller-visible behavior or contract change",
    patterns: [
      /\bbehaviou?r\b/iu,
      /\bsemantic(?:s)?\b/iu,
      /\bcontract\b/iu,
      /\bbreak(?:ing)?\b/iu,
      /\bstrict(?:er|ly)?\b/iu,
      /\bfail(?:s|ed|ing)?\b/iu,
      /\breject(?:s|ed|ing)?\b/iu,
      /\benforce(?:s|d|ment|ing)?\b/iu,
      /\ballow(?:s|ed|ing)?\b/iu,
      /\bdisallow(?:s|ed|ing)?\b/iu,
      /\bforbid(?:s|den|ding)?\b/iu,
      /\bfallback\b/iu,
      /\bdefault(?:s|ed|ing)?\b/iu,
      /\bprefer(?:s|red|ence|ences)?\b/iu,
      /\bvalidat(?:e|es|ed|ing|ion)\b/iu,
      /\brequir(?:e|es|ed|ing)\b/iu
    ]
  }
];

export function buildIntentSignals(input: IntentSignalInput): IntentSignals {
  const signals: IntentSignal[] = [];
  for (const entry of intentEntries(input)) {
    for (const group of PATTERN_GROUPS) {
      if (!group.patterns.some((pattern) => pattern.test(entry.text))) {
        continue;
      }
      signals.push({
        kind: group.kind,
        source: entry.source,
        snippet: truncate(entry.text.replace(/\s+/gu, " ").trim(), MAX_SNIPPET_CHARS),
        reason: group.reason,
        ...(entry.sha !== undefined ? { commitSha: entry.sha } : {})
      });
    }
  }

  const deduped = dedupeSignals(signals).slice(0, MAX_SIGNALS);
  return {
    refactorLike: deduped.some((signal) => signal.kind === "refactorLike"),
    behaviorChangeLike: deduped.some((signal) => signal.kind === "behaviorChangeLike"),
    explicitlyBehaviorPreserving: deduped.some((signal) => signal.kind === "explicitlyBehaviorPreserving"),
    signals: deduped,
    summary: summarizeSignals(deduped)
  };
}

export function summarizeIntentSignals(signals: IntentSignals | undefined): string {
  if (signals === undefined || signals.signals.length === 0) {
    return "No explicit intent signals were detected from PR or commit text.";
  }
  const flags = [
    signals.refactorLike ? "refactor-like" : undefined,
    signals.behaviorChangeLike ? "behavior-change-like" : undefined,
    signals.explicitlyBehaviorPreserving ? "explicitly behavior-preserving" : undefined
  ].filter((flag): flag is string => flag !== undefined);
  const evidence = signals.signals
    .slice(0, 6)
    .map((signal) => `- ${signal.kind} from ${signal.source}: ${signal.snippet}`)
    .join("\n");
  return [`Detected intent signals: ${flags.join(", ") || "none"}.`, evidence].filter(Boolean).join("\n");
}

function intentEntries(input: IntentSignalInput): Array<{ source: IntentSource; text: string; sha?: string }> {
  const entries: Array<{ source: IntentSource; text: string; sha?: string }> = [];
  const prTitle = input.pr?.title?.trim();
  if (prTitle) {
    entries.push({ source: "pr_title", text: prTitle });
  }
  const prBody = input.pr?.body?.trim();
  if (prBody) {
    entries.push({ source: "pr_body", text: prBody });
  }
  for (const commit of input.commits ?? []) {
    const title = commit.title?.trim();
    if (title) {
      entries.push({ source: "commit_title", text: title, ...(commit.sha !== undefined ? { sha: commit.sha } : {}) });
    }
    const body = commit.body?.trim();
    if (body) {
      entries.push({ source: "commit_body", text: body, ...(commit.sha !== undefined ? { sha: commit.sha } : {}) });
    }
  }
  return entries;
}

function dedupeSignals(signals: IntentSignal[]): IntentSignal[] {
  const seen = new Set<string>();
  const result: IntentSignal[] = [];
  for (const signal of signals) {
    const key = [signal.kind, signal.source, signal.commitSha ?? "", signal.snippet].join("\0");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(signal);
  }
  return result;
}

function summarizeSignals(signals: IntentSignal[]): string {
  if (signals.length === 0) {
    return "No explicit intent signals detected.";
  }
  const counts = new Map<IntentSignal["kind"], number>();
  for (const signal of signals) {
    counts.set(signal.kind, (counts.get(signal.kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([kind, count]) => `${kind}: ${String(count)}`)
    .join(", ");
}

function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}
