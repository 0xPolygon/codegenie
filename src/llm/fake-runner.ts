import type { LlmRunner, LlmStructuredRequest } from "./llm-runner.js";
import type {
  CandidateFinding,
  Confidence,
  PacketHunk,
  ReviewPacket,
  Severity
} from "../types.js";

type FakePlannerDossier = {
  files?: Array<{
    path?: string;
    hunks?: Array<{ hunkId?: string }>;
  }>;
};

type FakeGroupedFinding = {
  representative?: CandidateFinding;
  findings?: CandidateFinding[];
};

export function shouldUseFakeRunner(llm: { provider?: string; model?: string }): boolean {
  return llm.provider === "fake" || llm.model === "fake" || llm.model === "fake-model";
}

export function createFakeRunner(): LlmRunner {
  return {
    runStructured: async <T>(request: LlmStructuredRequest<T>): Promise<T> => {
      switch (request.stage) {
        case 5:
          return fakePlan(request.prompt) as T;
        case 7:
          return fakePacketReview(request.prompt) as T;
        case 9:
          return fakeVerdict(request.prompt) as T;
        case 10:
          return fakeComposition(request.prompt) as T;
        default:
          return {} as T;
      }
    }
  };
}

function fakePlan(prompt: string): unknown {
  const dossier = extractJsonBlock<FakePlannerDossier>(prompt, "planner-dossier") ?? {};
  const coverage = (dossier.files ?? []).flatMap((file) =>
    (file.hunks ?? []).flatMap((hunk) =>
      file.path && hunk.hunkId
        ? [
            {
              hunkId: hunk.hunkId,
              path: file.path,
              coverage: "normal",
              lenses: defaultFakeLenses(file.path),
              surroundingContextHints: [],
              reason: "fake planner default coverage"
            }
          ]
        : []
    )
  );

  return {
    diffUnderstanding: {
      declaredIntent: "Exercise the review pipeline without provider API calls.",
      inferredBehavior: "Deterministic fake planning pass."
    },
    riskAreas: [],
    coverage
  };
}

function fakePacketReview(prompt: string): unknown {
  const packet = extractJsonBlock<ReviewPacket>(prompt, "review-packet");
  if (!packet) {
    return { findings: [], followUpHints: [], uncertainties: [] };
  }

  const triggerLine = firstTriggeredLine(packet);
  const findings = triggerLine
    ? [
        {
          title: `Fake finding in ${packet.path}`,
          severity: fakeSeverity(triggerLine.content),
          confidence: fakeConfidence(triggerLine.content),
          path: packet.path,
          anchor:
            triggerLine.newLine !== undefined
              ? {
                  path: packet.path,
                  line: triggerLine.newLine,
                  side: "RIGHT",
                  hunkId: triggerLine.hunk.hunkId
                }
              : undefined,
          category: "correctness",
          evidence: {
            changedCode: triggerLine.content
          },
          failureMode: "The fake runner was asked to produce a deterministic finding for this changed line.",
          whyThisMatters: "This exercises candidate, verification, composition, renderer, and artifact flow.",
          suggestedFix: "Remove the fake trigger or replace it with the intended implementation.",
          suggestedTest: "Keep a fixture that asserts this deterministic fake finding reaches the final review.",
          verification: "The trigger text appears in a changed line."
        }
      ]
    : [];

  const hasHint = packet.hunks.some((hunk) => hunk.contentWithLineNumbers.includes("CODENINJA_FAKE_HINT"));
  return {
    findings,
    followUpHints: hasHint
      ? [
          {
            question: "Check the fake follow-up hint path.",
            files: [packet.path],
            symbols: [],
            suggestedLenses: packet.lenses,
            reason: "The packet contains CODENINJA_FAKE_HINT.",
            confidence: "medium"
          }
        ]
      : [],
    uncertainties: []
  };
}

function fakeVerdict(prompt: string): unknown {
  const candidate = extractJsonBlock<CandidateFinding>(prompt, "candidate-finding");
  return {
    verdict: "keep",
    reason: candidate ? "fake verifier kept the deterministic candidate" : "fake verifier had no candidate context",
    requiredEvidencePresent: true,
    falsePositiveRisk: "low"
  };
}

function fakeComposition(prompt: string): unknown {
  const groups = extractJsonBlock<FakeGroupedFinding[]>(prompt, "grouped-findings") ?? [];
  const findings = groups
    .flatMap((group) => group.representative ?? group.findings?.[0])
    .filter((finding): finding is CandidateFinding => finding !== undefined);

  return {
    summary: findings.length === 0 ? "No credible findings." : `Found ${findings.length} verified issue${findings.length === 1 ? "" : "s"}.`,
    composedFindings: findings.map((finding) => ({
      findingIds: [finding.id, ...(finding.duplicateOf ? [finding.duplicateOf] : [])],
      finalBody: [
        finding.failureMode,
        "",
        `Evidence: ${finding.evidence.changedCode}`,
        finding.suggestedFix ? `Suggested fix: ${finding.suggestedFix}` : ""
      ]
        .filter(Boolean)
        .join("\n"),
      publication: finding.anchor ? "inline" : "summary-only"
    }))
  };
}

function firstTriggeredLine(packet: ReviewPacket):
  | { hunk: PacketHunk; content: string; newLine?: number }
  | undefined {
  for (const hunk of packet.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add" && /CODENINJA_FAKE_FINDING|codeninja-fake-finding/u.test(line.content)) {
        return {
          hunk,
          content: line.content,
          ...(line.newLine !== undefined ? { newLine: line.newLine } : {})
        };
      }
    }
  }
  return undefined;
}

function defaultFakeLenses(path: string): string[] {
  const lenses = ["core/code-review"];
  if (/(?:^|[./_-])(test|spec)\.(ts|tsx|js|jsx|go)$/u.test(path) || /_test\.go$/u.test(path)) {
    lenses.push("core/tests");
  }
  if (/\.(go)$/u.test(path)) {
    lenses.push("lang/go");
  } else if (/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/u.test(path)) {
    lenses.push("lang/typescript");
  }
  return lenses;
}

function fakeSeverity(content: string): Severity {
  if (/CRITICAL/u.test(content)) {
    return "critical";
  }
  if (/HIGH/u.test(content)) {
    return "high";
  }
  if (/LOW/u.test(content)) {
    return "low";
  }
  return "medium";
}

function fakeConfidence(content: string): Confidence {
  if (/LOW_CONFIDENCE/u.test(content)) {
    return "low";
  }
  if (/HIGH_CONFIDENCE/u.test(content)) {
    return "high";
  }
  return "medium";
}

function extractJsonBlock<T>(prompt: string, label: string): T | undefined {
  const marker = `untrusted-data label=${label}`;
  const markerIndex = prompt.indexOf(marker);
  if (markerIndex === -1) {
    return undefined;
  }
  const jsonStart = prompt.indexOf("\n", markerIndex);
  if (jsonStart === -1) {
    return undefined;
  }
  const afterStart = jsonStart + 1;
  const fenceStart = prompt.lastIndexOf("\n", markerIndex);
  const fence = fenceStart === -1 ? "" : prompt.slice(fenceStart + 1, markerIndex).trim().replace(/untrusted-data.*/u, "");
  const endPattern = fence && /^`+$/u.test(fence) ? `\n${fence}` : "\n````";
  const jsonEnd = prompt.indexOf(endPattern, afterStart);
  if (jsonEnd === -1) {
    return undefined;
  }
  try {
    return JSON.parse(prompt.slice(afterStart, jsonEnd)) as T;
  } catch {
    return undefined;
  }
}
