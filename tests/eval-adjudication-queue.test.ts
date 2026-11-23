import { expect, it } from "vitest";
import { buildEvalAdjudicationQueue } from "../scripts/eval-adjudication-queue.js";
import { scoreEvalRun } from "../src/evals/eval-scoring.js";
import type { CandidateFinding, EvalArtifacts, EvalCase, FinalFinding } from "../src/types.js";

it("queues raw anchored hits and lexical misses for source review without assigning credit", () => {
  const caseData: EvalCase = { name: "held-out lease example", should_find: [
    { id: "lease-reclamation", path: "buffer.ts", lineRange: [20, 22], severityAtLeast: "medium" },
    { id: "early-return", path: "streams.ts", lineRange: [27, 28], failureModePattern: "missing release" },
    { id: "stream-lease", path: "streams.ts", failureModePattern: "releaseHandle" }
  ] };
  const findings = [
    { id: "same-anchor-unrelated", path: "buffer.ts", line: 21, failureMode: "An extra warning reaches the log." },
    { id: "correct-paraphrase", path: "streams.ts", line: 27, failureMode: "Returning here leaves the reader's lease held." },
    { id: "wrong-file", path: "unrelated.ts", line: 27, failureMode: "Returning here leaves the reader's lease held." }
  ].map(({ line, ...finding }): CandidateFinding => ({
    ...finding, title: "Review observation", severity: "medium", confidence: "high", category: "correctness",
    anchor: { path: finding.path, line, side: "RIGHT", hunkId: "hunk" }, changedLine: true,
    evidence: { changedCode: "return" }, whyThisMatters: "A reader lease remains held.",
    verification: "Fixture is anchored at the changed return.",
    producedBy: { kind: "packet", stage: 7, packetId: "packet", lensId: "core/code-review", skillIds: [] }
  }));
  const published: FinalFinding = { ...findings[0]!, publication: "inline", finalBody: findings[0]!.failureMode, fingerprint: "fixture", mergedCandidateIds: [] };
  const artifacts: EvalArtifacts = {
    candidates: findings, finalFindings: [published], packets: [], verification: [],
    finalSelection: [], hintEvents: [], metricsSources: {}
  };

  const queue = buildEvalAdjudicationQueue(caseData, artifacts);
  expect(queue.leads.map(({ expectationId, findingId, artifact, reason }) => [expectationId, findingId, artifact, reason])).toEqual([
    ["lease-reclamation", "same-anchor-unrelated", "final-findings", "machine-match"],
    ["lease-reclamation", "same-anchor-unrelated", "candidate-findings", "machine-match"],
    ["early-return", "correct-paraphrase", "candidate-findings", "location-lexical-mismatch"],
    ["stream-lease", "correct-paraphrase", "candidate-findings", "location-lexical-mismatch"]
  ]);
  expect(queue.leads.map(lead => lead.rawMatch.matched)).toEqual([true, true, false, false]);
  // #127 already shows the lexical miss as an adjudication lead; its anchored
  // positive assignment still passes a same-anchor finding about another effect.
  expect(scoreEvalRun(caseData, artifacts, "replay").expectationResults).toMatchObject([
    { expectationId: "lease-reclamation", status: "pass" },
    { expectationId: "early-return", needsAdjudication: {
      reason: "lexical-mismatch", findingIds: ["correct-paraphrase"]
    } },
    { expectationId: "stream-lease", status: "fail" }
  ]);
});
