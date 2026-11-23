import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { parseDiff } from "../src/git/diff-parser.js";
import type { LlmRunner, LlmStructuredRequest } from "../src/llm/llm-runner.js";
import { renderMarkdownReview } from "../src/output/markdown-renderer.js";
import { dedupeRankAndComposeReview } from "../src/pipeline/composer.js";
import type { LensRegistry } from "../src/skills/lens-registry.js";
import { createPromptBuilder } from "../src/skills/prompt-builder.js";
import type {
  CandidateFinding,
  PacketReviewResult,
  ReviewPacket,
  ReviewPlan,
  RunCoverageStatus,
  VerificationVerdict
} from "../src/types.js";
import { nullTelemetry } from "./helpers/git.js";

const DIFF = [
  "diff --git a/src/service.ts b/src/service.ts",
  "index 1111111..2222222 100644",
  "--- a/src/service.ts",
  "+++ b/src/service.ts",
  "@@ -1,1 +1,8 @@",
  "-export const version = 0;",
  "+export const line1 = 1;",
  "+export const line2 = 2;",
  "+export const line3 = 3;",
  "+export const line4 = 4;",
  "+export const line5 = 5;",
  "+export const line6 = 6;",
  "+export const line7 = 7;",
  "+export const line8 = 8;",
  ""
].join("\n");

describe("suppressed findings preserve their source concerns (#52)", () => {
  it("does not send a conclusively refuted promoted question to the reader", async () => {
    const diff = parseDiff(DIFF);
    const question = "Does the changed handler reject a missing token?";
    const promoted = candidate({ id: "refuted", title: "Missing token", path: "src/service.ts", failureMode: "Token is accepted.",
      provenance: { source: "uncertainty_promotion", sourceKind: "follow_up_hint", sourcePacketId: "packet-1",
        question, files: ["src/service.ts"], symbols: ["handler"], reason: "Check the guard." } });
    const packetResult: PacketReviewResult = { packetId: "packet-1", lenses: ["core/code-review"], findings: [promoted],
      followUpHints: [{ question, files: ["src/service.ts"], symbols: ["handler"], suggestedLenses: [],
        projectedSkillIds: [], reason: "Check the guard.", confidence: "medium" }], uncertainties: [], status: "completed" };
    const result = await dedupeRankAndComposeReview(
      { verified: [], verdicts: [{ candidateId: promoted.id, verdict: "reject", reason: "The guard rejects it.",
        requiredEvidencePresent: true, falsePositiveRisk: "low", proofAssessment: { status: "refuted", evidence: "The guard rejects it.", assumptions: [] } }] },
      fakePlan(), fakeResolved(), fakeCoverage(), defaultConfig, nullTelemetry(), {
        runner: { runStructured: async <T>() => ({ summary: "No credible findings.", composedFindings: [], attentionResolutions: [] }) as T },
        promptBuilder: fakePromptBuilder(), packets: [fakePacket(diff.files[0]!.hunks[0]!.id)], packetResults: [packetResult], diff
      }
    );
    expect(result.needsHumanAttention).toEqual([]);
    expect(packetResult.followUpHints).toHaveLength(1);
  });

  it("preserves a packet concern and tool diagnostic when its kept low-confidence promoted finding is suppressed by confidence-threshold", async () => {
    const diff = parseDiff(DIFF);
    const hunk = diff.files[0]!.hunks[0]!;
    const question = "Does handleRequest reject expired session tokens before reading storage?";
    const promoted = candidate({
      id: "promoted-low",
      title: "Expired session token bypasses storage guard",
      severity: "medium",
      confidence: "low",
      path: "src/service.ts",
      anchor: { path: "src/service.ts", line: 2, side: "RIGHT", hunkId: hunk.id },
      // Omit relatedCode so the low-confidence behavior-delta hatch does not publish it.
      evidence: { changedCode: "+export const line2 = 2;" },
      failureMode: "Expired tokens skip revocation check.",
      whyThisMatters: "Revoked callers read storage.",
      verification: "Observed in handleRequest.",
      provenance: {
        source: "uncertainty_promotion",
        sourceKind: "follow_up_hint",
        sourcePacketId: "packet-1",
        question,
        files: ["src/service.ts"],
        symbols: ["handleRequest"],
        reason: "Could not inspect caller middleware."
      }
    });
    const verdict: VerificationVerdict = {
      candidateId: promoted.id,
      verdict: "keep",
      requiredEvidencePresent: true,
      falsePositiveRisk: "low",
      reason: "Confirmed missing expiry guard.",
      proofAssessment: {
        status: "established",
        evidence: "handleRequest reads storage without checking token.expiresAt.",
        assumptions: []
      }
    };
    const packetResult: PacketReviewResult = {
      packetId: "packet-1",
      lenses: ["core/code-review"],
      findings: [promoted],
      followUpHints: [{
        question,
        files: ["src/service.ts"],
        symbols: ["handleRequest"],
        suggestedLenses: [],
        projectedSkillIds: [],
        reason: "Could not inspect caller middleware.",
        confidence: "medium"
      }],
      uncertainties: [],
      status: "completed"
    };
    const coverage: RunCoverageStatus = {
      ...fakeCoverage(),
      diagnostics: [{
        stage: 7,
        workItem: "packet-1",
        kind: "incomplete",
        code: "budget_exhausted",
        reason: "Caller lookup truncated",
        recoveryExhausted: true,
        origin: "tool"
      }]
    };
    const artifacts = new Map<string, unknown>();
    const telemetry = {
      ...nullTelemetry(),
      writeArtifact: async (name: string, data: unknown) => { artifacts.set(name, data); }
    };

    const result = await dedupeRankAndComposeReview(
      { verified: [promoted], verdicts: [verdict] },
      fakePlan(),
      fakeResolved(),
      coverage,
      defaultConfig,
      telemetry,
      {
        runner: resolvingComposerRunner([promoted], `${promoted.id}/verification`),
        promptBuilder: fakePromptBuilder(),
        packets: [fakePacket(hunk.id)],
        packetResults: [packetResult],
        diff
      }
    );

    expect(result.findings).toEqual([]);
    expect(result.summaryOnlyFindings).toEqual([]);
    expect(result.needsHumanAttention.map((note) => note.question)).toEqual([question]);
    expect(result.health?.status).not.toBe("completed");
    expect(result.summary).not.toContain("No credible findings");
    // Tool diagnostic must NOT be cleared when the resolution was rejected.
    expect(result.coverage.diagnostics).toHaveLength(1);
    const noteArtifact = artifacts.get("human-attention-notes.json") as {
      reconciliation: { decisions: Array<{ accepted: boolean; rejectionReason?: string }> };
    };
    expect(noteArtifact.reconciliation.decisions).toContainEqual(expect.objectContaining({
      accepted: false,
      rejectionReason: "suppressed_finding_evidence"
    }));
  });

  it("preserves concerns when their supporting keep/revise finding is suppressed by report-cap or severity-threshold", async () => {
    const diff = parseDiff(DIFF);
    const hunk = diff.files[0]!.hunks[0]!;
    const high = candidate({
      id: "high-kept",
      title: "Unchecked signature bypasses auth",
      severity: "high",
      confidence: "high",
      path: "src/service.ts",
      anchor: { path: "src/service.ts", line: 1, side: "RIGHT", hunkId: hunk.id },
      failureMode: "Signature check returns early on empty header.",
      whyThisMatters: "Unauthenticated requests gain write access."
    });
    const medium = candidate({
      id: "med-capped",
      title: "Missing retry backoff on transient error",
      severity: "medium",
      confidence: "medium",
      path: "src/service.ts",
      anchor: { path: "src/service.ts", line: 5, side: "RIGHT", hunkId: hunk.id },
      failureMode: "Loop retries immediately without delay on HTTP 503.",
      whyThisMatters: "Transient outages trigger a tight retry storm."
    });
    const question = "Does the HTTP client apply backoff on 503 responses?";
    const packetResult: PacketReviewResult = {
      packetId: "packet-1",
      lenses: ["core/code-review"],
      findings: [high, medium],
      followUpHints: [{
        question,
        files: ["src/service.ts"],
        symbols: ["fetchRetry"],
        suggestedLenses: [],
        projectedSkillIds: [],
        reason: "Retry policy unclear from local hunk.",
        confidence: "medium"
      }],
      uncertainties: [],
      status: "completed"
    };
    const verdicts: VerificationVerdict[] = [
      { candidateId: high.id, verdict: "keep", requiredEvidencePresent: true, falsePositiveRisk: "low", reason: "Confirmed." },
      { candidateId: medium.id, verdict: "revise", requiredEvidencePresent: true, falsePositiveRisk: "low", reason: "Confirmed tight retry loop." }
    ];

    // report-cap (maxFindings: 1): high stays published, medium is suppressed -> concern preserved.
    const reportCapped = await dedupeRankAndComposeReview(
      { verified: [high, medium], verdicts },
      fakePlan(),
      fakeResolved(),
      fakeCoverage(),
      { ...defaultConfig, review: { ...defaultConfig.review, maxFindings: 1 } },
      nullTelemetry(),
      {
        runner: resolvingComposerRunner([high, medium], `${medium.id}/verification`),
        promptBuilder: fakePromptBuilder(),
        packets: [fakePacket(hunk.id)],
        packetResults: [packetResult],
        diff
      }
    );
    expect(reportCapped.findings.map((finding) => finding.id)).toEqual(["high-kept"]);
    expect(reportCapped.needsHumanAttention.map((note) => note.question)).toEqual([question]);

    // severity-threshold (minSeverity: "high"): medium is suppressed -> concern preserved.
    const severityCapped = await dedupeRankAndComposeReview(
      { verified: [high, medium], verdicts },
      fakePlan(),
      fakeResolved(),
      fakeCoverage(),
      { ...defaultConfig, review: { ...defaultConfig.review, minSeverity: "high" } },
      nullTelemetry(),
      {
        runner: resolvingComposerRunner([high, medium], `${medium.id}/verification`),
        promptBuilder: fakePromptBuilder(),
        packets: [fakePacket(hunk.id)],
        packetResults: [packetResult],
        diff
      }
    );
    expect(severityCapped.findings.map((finding) => finding.id)).toEqual(["high-kept"]);
    expect(severityCapped.needsHumanAttention.map((note) => note.question)).toEqual([question]);
  });

  it("preserves a concern whose supporting finding was suppressed by composer pre-trim above 40 findings", async () => {
    const diff = parseDiff(DIFF);
    const hunk = diff.files[0]!.hunks[0]!;
    const question = "Does the pre-trimmed low-priority worker flush metrics on exit?";
    const trimmed = candidate({
      id: "zz-pretrimmed",
      title: "Metrics buffer dropped on process exit",
      severity: "low",
      confidence: "medium",
      path: "src/service.ts",
      anchor: { path: "src/service.ts", line: 8, side: "RIGHT", hunkId: hunk.id },
      failureMode: "Shutdown hook exits before flushing telemetry queue.",
      whyThisMatters: "Final batch of counters is lost."
    });
    const kept40 = Array.from({ length: 40 }, (_, i) => candidate({
      id: `kept-${String(i).padStart(2, "0")}`,
      title: `Distinct defect ${i}`,
      severity: "high",
      confidence: "high",
      path: "src/service.ts",
      anchor: { path: "src/service.ts", line: (i % 7) + 1, side: "RIGHT", hunkId: hunk.id },
      failureMode: `Unique defect failure mode number ${i} with distinct token alpha${i}.`,
      whyThisMatters: `Unique impact number ${i} beta${i}.`
    }));
    const all = [...kept40, trimmed];
    const verdicts: VerificationVerdict[] = all.map((item) => ({
      candidateId: item.id,
      verdict: "keep",
      requiredEvidencePresent: true,
      falsePositiveRisk: "low",
      reason: `Confirmed ${item.id}.`,
      ...(item.id === trimmed.id ? {
        proofAssessment: {
          status: "established" as const,
          evidence: "Shutdown exits before flushing metrics queue.",
          assumptions: []
        }
      } : {})
    }));
    const packetResult: PacketReviewResult = {
      packetId: "packet-1",
      lenses: ["core/code-review"],
      findings: all,
      followUpHints: [{
        question,
        files: ["src/service.ts"],
        symbols: ["flushMetrics"],
        suggestedLenses: [],
        projectedSkillIds: [],
        reason: "Could not inspect shutdown hook.",
        confidence: "medium"
      }],
      uncertainties: [],
      status: "completed"
    };

    const result = await dedupeRankAndComposeReview(
      { verified: all, verdicts },
      fakePlan(),
      fakeResolved(),
      fakeCoverage(),
      defaultConfig,
      nullTelemetry(),
      {
        runner: resolvingComposerRunner(kept40, `attention/${trimmed.id}/proofAssessment`),
        promptBuilder: fakePromptBuilder(),
        packets: [fakePacket(hunk.id)],
        packetResults: [packetResult],
        diff
      }
    );

    expect([...result.findings, ...result.summaryOnlyFindings].some((finding) => finding.id === trimmed.id)).toBe(false);
    expect(result.needsHumanAttention.map((note) => note.question)).toContain(question);
  });

  it("still resolves concerns backed by a rejected verdict, a repository read, or a published (or merged) finding", async () => {
    const diff = parseDiff(DIFF);
    const hunk = diff.files[0]!.hunks[0]!;
    const question = "Does parseToken validate signature length?";

    // 1. Independently refuted (verdict: "reject") with zero findings -> resolved, health completed.
    const rejected = candidate({
      id: "rejected-candidate",
      title: "Suspected missing signature length check",
      severity: "medium",
      confidence: "medium",
      path: "src/service.ts",
      anchor: { path: "src/service.ts", line: 2, side: "RIGHT", hunkId: hunk.id },
      failureMode: "Suspected missing length check.",
      whyThisMatters: "Invalid signature could slip through."
    });
    const packetWithHint = (extra?: Partial<PacketReviewResult>): PacketReviewResult => ({
      packetId: "packet-1",
      lenses: ["core/code-review"],
      findings: [rejected],
      followUpHints: [{
        question,
        files: ["src/service.ts"],
        symbols: ["parseToken"],
        suggestedLenses: [],
        projectedSkillIds: [],
        reason: "Need to check parseToken implementation.",
        confidence: "medium"
      }],
      uncertainties: [],
      status: "completed",
      ...extra
    });
    const refutedResult = await dedupeRankAndComposeReview(
      {
        verified: [],
        verdicts: [{
          candidateId: rejected.id,
          verdict: "reject",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low",
          reason: "Signature length is already validated.",
          proofAssessment: { status: "refuted", evidence: "parseToken checks sig.length === 64.", assumptions: [] }
        }]
      },
      fakePlan(),
      fakeResolved(),
      fakeCoverage(),
      defaultConfig,
      nullTelemetry(),
      {
        runner: resolvingComposerRunner([], `attention/${rejected.id}/proofAssessment`),
        promptBuilder: fakePromptBuilder(),
        packets: [fakePacket(hunk.id)],
        packetResults: [packetWithHint()],
        diff
      }
    );
    expect(refutedResult.needsHumanAttention).toEqual([]);
    expect(refutedResult.health?.status).toBe("completed");

    // 2. Repository tool read with zero findings -> resolved, health completed.
    const repoReadResult = await dedupeRankAndComposeReview(
      { verified: [], verdicts: [] },
      fakePlan(),
      fakeResolved(),
      fakeCoverage(),
      defaultConfig,
      nullTelemetry(),
      {
        runner: resolvingComposerRunner([], "repository/packet-1/read-1"),
        promptBuilder: fakePromptBuilder(),
        packets: [fakePacket(hunk.id)],
        packetResults: [packetWithHint({
          findings: [],
          repositoryEvidence: [{
            id: "read-1",
            tool: "read_range",
            source: "head",
            path: "src/service.ts",
            text: "function parseToken(sig: Uint8Array) { if (sig.length !== 64) throw new Error('bad'); }"
          }]
        })],
        diff
      }
    );
    expect(repoReadResult.needsHumanAttention).toEqual([]);
    expect(repoReadResult.health?.status).toBe("completed");

    // 3. Resolution backed by a candidate merged into a published finding (#151-style merge) -> accepted.
    const primary = candidate({
      id: "primary-published",
      title: "Token validation skips length check",
      severity: "high",
      confidence: "high",
      path: "src/service.ts",
      anchor: { path: "src/service.ts", line: 2, side: "RIGHT", hunkId: hunk.id },
      failureMode: "parseToken skips signature length validation.",
      whyThisMatters: "Short signatures are accepted."
    });
    const mergedSibling = candidate({
      id: "merged-sibling",
      title: "Short signatures accepted by parseToken",
      severity: "medium",
      confidence: "low",
      path: "src/service.ts",
      anchor: { path: "src/service.ts", line: 2, side: "RIGHT", hunkId: hunk.id },
      failureMode: "Short signatures bypass length validation in parseToken.",
      whyThisMatters: "Malformed tokens pass verification."
    });
    const mergedResult = await dedupeRankAndComposeReview(
      {
        verified: [primary, mergedSibling],
        verdicts: [
          { candidateId: primary.id, verdict: "keep", requiredEvidencePresent: true, falsePositiveRisk: "low", reason: "Confirmed." },
          { candidateId: mergedSibling.id, verdict: "keep", requiredEvidencePresent: true, falsePositiveRisk: "low", reason: "Confirmed sibling." }
        ]
      },
      fakePlan(),
      fakeResolved(),
      fakeCoverage(),
      defaultConfig,
      nullTelemetry(),
      {
        runner: {
          runStructured: async <T>(req: LlmStructuredRequest<T>) => {
            const concernId = extractFirstConcernId(req.prompt);
            return {
              summary: "Found 1 verified issue.",
              composedFindings: [{
                findingIds: [primary.id, mergedSibling.id],
                publication: "inline",
                sections: [
                  { kind: "impact", text: "parseToken accepts short signatures.", sourceRefs: [`${primary.id}/failureMode`, `${primary.id}/whyThisMatters`, `${mergedSibling.id}/failureMode`, `${mergedSibling.id}/whyThisMatters`] },
                  { kind: "verification", text: "Confirmed in parseToken.", sourceRefs: [`${primary.id}/verification`, `${mergedSibling.id}/verification`] }
                ],
                evidenceRefs: [`${primary.id}/evidence/changedCode`, `${mergedSibling.id}/evidence/changedCode`]
              }],
              attentionResolutions: [{
                concernId,
                disposition: "resolved",
                supportingRefs: [`${mergedSibling.id}/verification`],
                rationale: "Published merged finding establishes the missing length check."
              }]
            } as T;
          }
        },
        promptBuilder: fakePromptBuilder(),
        packets: [fakePacket(hunk.id)],
        packetResults: [packetWithHint({ findings: [primary, mergedSibling] })],
        diff
      }
    );
    expect(mergedResult.findings).toHaveLength(1);
    expect(mergedResult.findings[0]!.mergedCandidateIds).toEqual(expect.arrayContaining([primary.id, mergedSibling.id]));
    expect(mergedResult.needsHumanAttention).toEqual([]);
  });

  it("prioritizes suppressed-evidence preserved concerns ahead of ordinary notes inside the 5-note cap and leaves Stage 10 prompt unchanged", async () => {
    const diff = parseDiff(DIFF);
    const hunk = diff.files[0]!.hunks[0]!;
    const suppressedQuestion = "Does zzzLateHandler drop uncommitted writes on disconnect?";
    const suppressedFinding = candidate({
      id: "suppressed-low-cap",
      title: "Uncommitted writes dropped on disconnect",
      severity: "medium",
      confidence: "low",
      path: "src/service.ts",
      anchor: { path: "src/service.ts", line: 7, side: "RIGHT", hunkId: hunk.id },
      evidence: { changedCode: "+export const line7 = 7;" },
      failureMode: "Disconnect closes handle before flush.",
      whyThisMatters: "Writes disappear silently.",
      verification: "Observed in zzzLateHandler."
    });
    const ordinaryHints = Array.from({ length: 5 }, (_, i) => ({
      question: `Does alphaCheck${i} handle empty payload?`,
      files: ["src/service.ts"],
      symbols: [`alphaCheck${i}`],
      suggestedLenses: [],
      projectedSkillIds: [],
      reason: `Ordinary high-confidence question ${i}.`,
      confidence: "high" as const
    }));
    const packetResult: PacketReviewResult = {
      packetId: "packet-1",
      lenses: ["core/code-review"],
      findings: [suppressedFinding],
      followUpHints: [
        ...ordinaryHints,
        {
          question: suppressedQuestion,
          files: ["src/service.ts"],
          symbols: ["zzzLateHandler"],
          suggestedLenses: [],
          projectedSkillIds: [],
          reason: "Medium-confidence question that would rank 6th without fallback priority.",
          confidence: "medium"
        }
      ],
      uncertainties: [],
      status: "completed"
    };
    const verdict: VerificationVerdict = {
      candidateId: suppressedFinding.id,
      verdict: "keep",
      requiredEvidencePresent: true,
      falsePositiveRisk: "low",
      reason: "Confirmed missing flush."
    };

    const capturedPrompts: string[] = [];
    const result = await dedupeRankAndComposeReview(
      { verified: [suppressedFinding], verdicts: [verdict] },
      fakePlan(),
      fakeResolved(),
      fakeCoverage(),
      defaultConfig,
      nullTelemetry(),
      {
        runner: {
          runStructured: async <T>(req: LlmStructuredRequest<T>) => {
            capturedPrompts.push(req.prompt);
            const inventory = extractAttentionInventory(req.prompt);
            const resolutions = inventory.concerns.map((concern) => concern.question === suppressedQuestion
              ? {
                  concernId: concern.id,
                  disposition: "resolved" as const,
                  supportingRefs: [`${suppressedFinding.id}/verification`],
                  rationale: "Suppressed finding confirmed missing flush."
                }
              : {
                  concernId: concern.id,
                  disposition: "unresolved" as const,
                  supportingRefs: [],
                  rationale: "No evidence supplied."
                });
            const response = {
              summary: "Found 1 issue.",
              composedFindings: [{
                findingIds: [suppressedFinding.id],
                publication: "inline" as const,
                sections: [
                  { kind: "impact" as const, text: "Disconnect drops uncommitted writes.", sourceRefs: [`${suppressedFinding.id}/failureMode`, `${suppressedFinding.id}/whyThisMatters`] },
                  { kind: "verification" as const, text: "Observed in zzzLateHandler.", sourceRefs: [`${suppressedFinding.id}/verification`] }
                ],
                evidenceRefs: [`${suppressedFinding.id}/evidence/changedCode`]
              }],
              attentionResolutions: resolutions
            };
            // Stage 10 submit validation still accepts the pre-cap submission unchanged.
            expect(req.validateSubmit?.(response as T)?.ok).toBe(true);
            return response as T;
          }
        },
        promptBuilder: fakePromptBuilder(),
        packets: [fakePacket(hunk.id)],
        packetResults: [packetResult],
        diff
      }
    );

    expect(result.findings).toEqual([]);
    expect(result.needsHumanAttention).toHaveLength(5);
    expect(result.needsHumanAttention[0]!.question).toBe(suppressedQuestion);
    expect(result.needsHumanAttentionOmittedCount).toBe(1);
    // Stage 10 prompt contains the pre-cap evidence inventory unchanged (no post-cap filtering).
    expect(capturedPrompts[0]).toContain(`${suppressedFinding.id}/verification`);
    expect(capturedPrompts[0]).not.toContain("suppressed_finding_evidence");
  });

  it("prioritizes a suppressed-evidence verifier concern ahead of five ordinary packet notes inside the 5-note cap", async () => {
    const diff = parseDiff(DIFF);
    const hunk = diff.files[0]!.hunks[0]!;
    const verifierQuestion = "Does the billing webhook verify the timestamp window?";
    const suppressedFinding = candidate({
      id: "suppressed-for-verifier",
      title: "Webhook skips timestamp window check",
      severity: "medium",
      confidence: "low",
      path: "src/service.ts",
      anchor: { path: "src/service.ts", line: 6, side: "RIGHT", hunkId: hunk.id },
      evidence: { changedCode: "+export const line6 = 6;" },
      failureMode: "Timestamp header is ignored during webhook verification.",
      whyThisMatters: "Replayed webhooks succeed indefinitely.",
      verification: "Observed in verifyWebhook."
    });
    const packetResult: PacketReviewResult = {
      packetId: "packet-1",
      lenses: ["core/code-review"],
      findings: [suppressedFinding],
      followUpHints: Array.from({ length: 5 }, (_, i) => ({
        question: `Does alphaCheck${i} handle empty payload?`,
        files: ["src/service.ts"],
        symbols: [`alphaCheck${i}`],
        suggestedLenses: [],
        projectedSkillIds: [],
        reason: `Ordinary high-confidence question ${i}.`,
        confidence: "high" as const
      })),
      uncertainties: [],
      status: "completed"
    };
    const verdicts: VerificationVerdict[] = [
      {
        candidateId: suppressedFinding.id,
        verdict: "keep",
        requiredEvidencePresent: true,
        falsePositiveRisk: "low",
        reason: "Confirmed missing timestamp check."
      },
      {
        candidateId: "verifier-question",
        verdict: "reject",
        requiredEvidencePresent: false,
        falsePositiveRisk: "high",
        reason: "Missing caller context.",
        proofAssessment: {
          status: "unresolved",
          evidence: "Webhook timestamp validation was not established.",
          assumptions: [{ question: verifierQuestion, essential: true }]
        },
        unresolvedConcern: {
          question: verifierQuestion,
          files: ["src/service.ts"],
          symbols: ["verifyWebhook"],
          reason: "Webhook timestamp window unverified.",
          confidence: "medium",
          sourcePacketIds: ["packet-1"]
        }
      }
    ];

    const result = await dedupeRankAndComposeReview(
      { verified: [suppressedFinding], verdicts },
      fakePlan(),
      fakeResolved(),
      fakeCoverage(),
      defaultConfig,
      nullTelemetry(),
      {
        runner: {
          runStructured: async <T>(req: LlmStructuredRequest<T>) => {
            const inventory = extractAttentionInventory(req.prompt);
            return {
              summary: "Found 1 issue.",
              composedFindings: [{
                findingIds: [suppressedFinding.id],
                publication: "inline" as const,
                sections: [
                  { kind: "impact" as const, text: "Replayed webhooks succeed.", sourceRefs: [`${suppressedFinding.id}/failureMode`, `${suppressedFinding.id}/whyThisMatters`] },
                  { kind: "verification" as const, text: "Observed in verifyWebhook.", sourceRefs: [`${suppressedFinding.id}/verification`] }
                ],
                evidenceRefs: [`${suppressedFinding.id}/evidence/changedCode`]
              }],
              attentionResolutions: inventory.concerns.map((concern) => concern.id === "verifier-question/assumptions/0"
                ? {
                    concernId: concern.id,
                    disposition: "resolved" as const,
                    supportingRefs: [`${suppressedFinding.id}/verification`],
                    rationale: "Suppressed finding confirmed missing timestamp check."
                  }
                : {
                    concernId: concern.id,
                    disposition: "unresolved" as const,
                    supportingRefs: [],
                    rationale: "No evidence supplied."
                  })
            } as T;
          }
        },
        promptBuilder: fakePromptBuilder(),
        packets: [fakePacket(hunk.id)],
        packetResults: [packetResult],
        diff
      }
    );

    expect(result.findings).toEqual([]);
    expect(result.needsHumanAttention).toHaveLength(5);
    expect(result.needsHumanAttention[0]!.question).toBe(verifierQuestion);
    expect(result.needsHumanAttentionOmittedCount).toBe(1);
  });

  it("sets unresolved health and non-no-findings summary on clean-coverage restore, keeps resolved when published (control), restores original question on mixed narrowed refs with telemetry counts, and handles suppressed merged groups", async () => {
    const diff = parseDiff(DIFF);
    const hunk = diff.files[0]!.hunks[0]!;
    const originalQuestion = "Does handleRequest reject expired tokens and enforce tenant isolation?";
    const promoted = candidate({
      id: "promoted-control",
      title: "Expired token skips revocation check",
      severity: "medium",
      confidence: "low",
      path: "src/service.ts",
      anchor: { path: "src/service.ts", line: 3, side: "RIGHT", hunkId: hunk.id },
      evidence: { changedCode: "+export const line3 = 3;" },
      failureMode: "Expired tokens skip revocation check.",
      whyThisMatters: "Revoked callers read storage.",
      verification: "Observed in handleRequest."
    });
    const verdict: VerificationVerdict = {
      candidateId: promoted.id,
      verdict: "keep",
      requiredEvidencePresent: true,
      falsePositiveRisk: "low",
      reason: "Confirmed missing expiry guard."
    };
    const packetResult: PacketReviewResult = {
      packetId: "packet-1",
      lenses: ["core/code-review"],
      findings: [promoted],
      followUpHints: [{
        question: originalQuestion,
        files: ["src/service.ts"],
        symbols: ["handleRequest"],
        suggestedLenses: [],
        projectedSkillIds: [],
        reason: "Need to verify token expiry and tenant isolation.",
        confidence: "medium"
      }],
      uncertainties: [],
      repositoryEvidence: [{
        id: "tenant-check",
        tool: "read_range",
        source: "head",
        path: "src/service.ts",
        text: "if (session.tenantId !== resource.tenantId) throw new Error('forbidden');"
      }],
      status: "completed"
    };

    // 1. Clean coverage + suppressed promoted finding -> health is exact "unresolved",
    // summary & markdown do not say "No credible findings" / "No Findings", telemetry counts 1/0.
    const cleanEvents: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const restoredClean = await dedupeRankAndComposeReview(
      { verified: [promoted], verdicts: [verdict] },
      fakePlan(),
      fakeResolved(),
      fakeCoverage(),
      defaultConfig,
      { ...nullTelemetry(), event: (event) => { cleanEvents.push(event); } },
      {
        runner: resolvingComposerRunner([promoted], `${promoted.id}/verification`),
        promptBuilder: fakePromptBuilder(),
        packets: [fakePacket(hunk.id)],
        packetResults: [packetResult],
        diff
      }
    );
    expect(restoredClean.findings).toEqual([]);
    expect(restoredClean.needsHumanAttention.map((note) => note.question)).toEqual([originalQuestion]);
    expect(restoredClean.health?.status).toBe("unresolved");
    expect(restoredClean.summary).not.toContain("No credible findings");
    expect(restoredClean.summary).toContain("Unresolved questions require attention");
    const markdown = renderMarkdownReview(restoredClean);
    expect(markdown).not.toContain("✅ No Findings");
    expect(markdown).not.toContain("No credible findings");
    expect(cleanEvents.find((event) => event.message === "human_attention_reconciliation")?.data).toMatchObject({
      restoredForSuppressedFinding: 1,
      restoredWithSurvivingRef: 0
    });

    // 2. Control: same finding published (minConfidence: "low") -> concern stays resolved, health completed.
    const publishedControl = await dedupeRankAndComposeReview(
      { verified: [promoted], verdicts: [verdict] },
      fakePlan(),
      fakeResolved(),
      fakeCoverage(),
      { ...defaultConfig, review: { ...defaultConfig.review, minConfidence: "low" } },
      nullTelemetry(),
      {
        runner: resolvingComposerRunner([promoted], `${promoted.id}/verification`),
        promptBuilder: fakePromptBuilder(),
        packets: [fakePacket(hunk.id)],
        packetResults: [packetResult],
        diff
      }
    );
    expect([...publishedControl.findings, ...publishedControl.summaryOnlyFindings].map((f) => f.id)).toEqual([promoted.id]);
    expect(publishedControl.needsHumanAttention).toEqual([]);
    expect(publishedControl.health?.status).toBe("completed");

    // 3. Mixed refs [suppressedKeep, repoRead] on a narrowed decision -> restores ORIGINAL
    // question (not narrowed remainingQuestion) and records restoredWithSurvivingRef: 1.
    const mixedEvents: Array<{ message: string; data?: Record<string, unknown> }> = [];
    const mixedNarrowed = await dedupeRankAndComposeReview(
      { verified: [promoted], verdicts: [verdict] },
      fakePlan(),
      fakeResolved(),
      fakeCoverage(),
      defaultConfig,
      { ...nullTelemetry(), event: (event) => { mixedEvents.push(event); } },
      {
        runner: {
          runStructured: async <T>(req: LlmStructuredRequest<T>) => {
            const concernId = extractFirstConcernId(req.prompt);
            return {
              summary: "Found 1 issue.",
              composedFindings: [{
                findingIds: [promoted.id],
                publication: "inline" as const,
                sections: [
                  { kind: "impact" as const, text: promoted.failureMode, sourceRefs: [`${promoted.id}/failureMode`, `${promoted.id}/whyThisMatters`] },
                  { kind: "verification" as const, text: promoted.verification, sourceRefs: [`${promoted.id}/verification`] }
                ],
                evidenceRefs: [`${promoted.id}/evidence/changedCode`]
              }],
              attentionResolutions: [{
                concernId,
                disposition: "narrowed" as const,
                supportingRefs: [`${promoted.id}/verification`, "repository/packet-1/tenant-check"],
                rationale: "Both refs together narrow the question.",
                remainingQuestion: "Only the narrowed remainder?"
              }]
            } as T;
          }
        },
        promptBuilder: fakePromptBuilder(),
        packets: [fakePacket(hunk.id)],
        packetResults: [packetResult],
        diff
      }
    );
    expect(mixedNarrowed.needsHumanAttention.map((note) => note.question)).toEqual([originalQuestion]);
    expect(mixedNarrowed.needsHumanAttention[0]!.question).not.toContain("narrowed remainder");
    expect(mixedEvents.find((event) => event.message === "human_attention_reconciliation")?.data).toMatchObject({
      restoredForSuppressedFinding: 1,
      restoredWithSurvivingRef: 1
    });

    // 4. Merged group suppressed by report-cap: even when the cited member had high
    // confidence, the final merged finding was suppressed so the concern is restored.
    const blocker = candidate({
      id: "high-blocker",
      title: "Critical auth bypass",
      severity: "critical",
      confidence: "high",
      path: "src/service.ts",
      anchor: { path: "src/service.ts", line: 1, side: "RIGHT", hunkId: hunk.id },
      failureMode: "Critical auth bypass permits anonymous admin calls.",
      whyThisMatters: "Full privilege escalation."
    });
    const mergedA = candidate({
      id: "merged-suppressed-a",
      title: "Missing retry jitter",
      severity: "medium",
      confidence: "high",
      path: "src/service.ts",
      anchor: { path: "src/service.ts", line: 4, side: "RIGHT", hunkId: hunk.id },
      failureMode: "Retry delay omits jitter under contention.",
      whyThisMatters: "Clients synchronize retries."
    });
    const mergedB = candidate({
      id: "merged-suppressed-b",
      title: "Synchronized retries lack jitter",
      severity: "medium",
      confidence: "low",
      path: "src/service.ts",
      anchor: { path: "src/service.ts", line: 4, side: "RIGHT", hunkId: hunk.id },
      failureMode: "Fixed retry interval lacks jitter.",
      whyThisMatters: "Traffic spikes repeat in lockstep."
    });
    const mergedSuppressed = await dedupeRankAndComposeReview(
      {
        verified: [blocker, mergedA, mergedB],
        verdicts: [
          { candidateId: blocker.id, verdict: "keep", requiredEvidencePresent: true, falsePositiveRisk: "low", reason: "Confirmed." },
          { candidateId: mergedA.id, verdict: "keep", requiredEvidencePresent: true, falsePositiveRisk: "low", reason: "Confirmed." },
          { candidateId: mergedB.id, verdict: "keep", requiredEvidencePresent: true, falsePositiveRisk: "low", reason: "Confirmed." }
        ]
      },
      fakePlan(),
      fakeResolved(),
      fakeCoverage(),
      { ...defaultConfig, review: { ...defaultConfig.review, maxFindings: 1 } },
      nullTelemetry(),
      {
        runner: {
          runStructured: async <T>(req: LlmStructuredRequest<T>) => {
            const concernId = extractFirstConcernId(req.prompt);
            return {
              summary: "Found 2 issues.",
              composedFindings: [
                {
                  findingIds: [blocker.id],
                  publication: "inline" as const,
                  sections: [
                    { kind: "impact" as const, text: blocker.failureMode, sourceRefs: [`${blocker.id}/failureMode`, `${blocker.id}/whyThisMatters`] },
                    { kind: "verification" as const, text: blocker.verification, sourceRefs: [`${blocker.id}/verification`] }
                  ],
                  evidenceRefs: [`${blocker.id}/evidence/changedCode`]
                },
                {
                  findingIds: [mergedA.id, mergedB.id],
                  publication: "inline" as const,
                  sections: [
                    { kind: "impact" as const, text: mergedA.failureMode, sourceRefs: [`${mergedA.id}/failureMode`, `${mergedA.id}/whyThisMatters`, `${mergedB.id}/failureMode`, `${mergedB.id}/whyThisMatters`] },
                    { kind: "verification" as const, text: mergedA.verification, sourceRefs: [`${mergedA.id}/verification`, `${mergedB.id}/verification`] }
                  ],
                  evidenceRefs: [`${mergedA.id}/evidence/changedCode`, `${mergedB.id}/evidence/changedCode`]
                }
              ],
              attentionResolutions: [{
                concernId,
                disposition: "resolved" as const,
                supportingRefs: [`${mergedA.id}/verification`],
                rationale: "Merged group confirms missing jitter."
              }]
            } as T;
          }
        },
        promptBuilder: fakePromptBuilder(),
        packets: [fakePacket(hunk.id)],
        packetResults: [{ ...packetResult, findings: [blocker, mergedA, mergedB] }],
        diff
      }
    );
    expect(mergedSuppressed.findings.map((f) => f.id)).toEqual([blocker.id]);
    expect(mergedSuppressed.needsHumanAttention.map((note) => note.question)).toEqual([originalQuestion]);
  });
});

function extractAttentionInventory(prompt: string): { concerns: Array<{ id: string; question: string }> } {
  const match = /(`{4,})untrusted-data label=attention-reconciliation\n([\s\S]*?)\n\1/u.exec(prompt);
  if (!match?.[2]) {
    throw new Error("missing attention-reconciliation block in prompt");
  }
  return JSON.parse(match[2]) as { concerns: Array<{ id: string; question: string }> };
}

function extractFirstConcernId(prompt: string): string {
  const first = extractAttentionInventory(prompt).concerns[0];
  if (!first) {
    throw new Error("missing concern in prompt inventory");
  }
  return first.id;
}

function resolvingComposerRunner(findings: CandidateFinding[], supportingRef: string): LlmRunner {
  return {
    runStructured: async <T>(req: LlmStructuredRequest<T>) => {
      const concernId = extractFirstConcernId(req.prompt);
      const response = {
        summary: findings.length > 0 ? `Found ${findings.length} verified issue${findings.length === 1 ? "" : "s"}.` : "No credible findings.",
        composedFindings: findings.map((finding) => ({
          findingIds: [finding.id],
          publication: "inline" as const,
          sections: [
            { kind: "impact" as const, text: finding.failureMode, sourceRefs: [`${finding.id}/failureMode`, `${finding.id}/whyThisMatters`] },
            { kind: "verification" as const, text: finding.verification, sourceRefs: [`${finding.id}/verification`] }
          ],
          evidenceRefs: [`${finding.id}/evidence/changedCode`]
        })),
        attentionResolutions: [{
          concernId,
          disposition: "resolved" as const,
          supportingRefs: [supportingRef],
          rationale: "Supported by verified evidence."
        }]
      };
      expect(req.validateSubmit?.(response as T)?.ok).toBe(true);
      return response as T;
    }
  };
}

function candidate(overrides: Partial<CandidateFinding> & { id: string; title: string; path: string; failureMode: string }): CandidateFinding {
  return {
    severity: "medium",
    confidence: "high",
    changedLine: overrides.anchor !== undefined,
    category: "correctness",
    evidence: { changedCode: `+export const ${overrides.id.replace(/[^a-z0-9]/giu, "_")} = 1;` },
    whyThisMatters: "Breaks expected behavior.",
    verification: `Verified directly for ${overrides.id}.`,
    producedBy: { kind: "packet", stage: 7, packetId: "packet-1", lensId: "core/code-review", skillIds: [] },
    ...overrides
  };
}

function fakePacket(hunkId: string): ReviewPacket {
  return {
    id: "packet-1",
    dispatchRank: [0, -1],
    kind: "hunk",
    prSummary: "Update service.ts",
    path: "src/service.ts",
    fileStatus: "modified",
    isDeletedContent: false,
    language: "typescript",
    reviewPriority: "normal",
    coverage: "normal",
    reviewProfile: "standard",
    lenses: ["core/code-review"],
    hunks: [{
      hunkId,
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 8,
      contentWithLineNumbers: "   1    1 +export const line1 = 1;",
      lines: [{ kind: "add", content: "export const line1 = 1;", newLine: 1 }],
      changedNewLineNumbers: [1, 2, 3, 4, 5, 6, 7, 8],
      changedOldLineNumbers: [1]
    }],
    symbolFacts: [],
    context: { path: "src/service.ts" },
    contextText: "",
    relevantTests: [],
    surroundingContextHints: [],
    labels: [],
    attentionNotes: [],
    relatedChangedContext: [],
    toolBudget: { maxToolCalls: 1, maxInvestigationRounds: 1, maxResultChars: 4000 }
  };
}

function fakePromptBuilder() {
  const registry: LensRegistry = {
    allLenses: () => [],
    enabledLenses: () => [],
    lens: () => undefined,
    skillsForLens: () => [],
    skillsById: () => [],
    registryHash: () => "fake-registry"
  };
  return createPromptBuilder(registry);
}

function fakePlan(): ReviewPlan {
  return {
    diffUnderstanding: {
      declaredIntent: "Update service.ts",
      inferredBehavior: "Changes exported lines in service.ts"
    },
    coverage: []
  };
}

function fakeCoverage(): RunCoverageStatus {
  return {
    totalHunks: 1,
    reviewedHunks: 1,
    skippedHunks: 0,
    failedHunks: 0,
    coverageByLevel: { deep: 0, normal: 1, light: 0, skip: 0 },
    degradedPlanning: false,
    budgetStopped: false,
    verificationIncompleteCount: 0,
    partial: false,
    reasons: []
  };
}

function fakeResolved() {
  return {
    mode: "branch" as const,
    repoRoot: "/repo",
    baseRef: "b".repeat(40),
    headRef: "h".repeat(40),
    mergeBase: "m".repeat(40),
    headSha: "h".repeat(40),
    commits: [],
    rawDiff: DIFF
  };
}
