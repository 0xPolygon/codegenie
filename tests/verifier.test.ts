import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.js";
import { parseDiff } from "../src/git/diff-parser.js";
import type { LlmRunner, LlmStructuredRequest } from "../src/llm/llm-runner.js";
import { SCHEMA_VERSIONS } from "../src/llm/schemas.js";
import { verifyFindings } from "../src/pipeline/verifier.js";
import { renderRetainedComposition } from "../src/pipeline/composition-content.js";
import { inferAnchorFromChangedCode, representativeAnchorFromPacket } from "../src/pipeline/pipeline-utils.js";
import { createPromptBuilder } from "../src/skills/prompt-builder.js";
import type { Skill } from "../src/skills/skill-loader.js";
import type {
  CandidateFinding,
  CodegenieConfig,
  EvalVerificationRecord,
  PacketReviewResult,
  RepositoryTools,
  RepositoryToolsHost,
  ReviewPacket,
  TelemetryEvent,
  UnifiedDiff
} from "../src/types.js";
import { scoreEvalRun } from "../src/evals/eval-scoring.js";
import { nullTelemetry } from "./helpers/git.js";

describe("stage 9 evidence-aware verification", () => {
  it("hands a relevant source read from another completed packet to the verifier with provenance", async () => {
    const fixture = reviewFixture(["service.ts"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("reused-source", packet);
    const other = packetResult("other-packet", []);
    const text = "function handler() { if (!caller.active) return deny(); return value; }";
    other.repositoryEvidence = [{ id: "read-1", tool: "read_range", path: finding.path, source: "head", text }];
    let prompt = "";
    await verifyFindings({ packetResults: [packetResult(packet.id, [finding]), other], packets: [packet] }, fakeTools(), config(), nullTelemetry(), {
      runner: { runStructured: async <T>(request: LlmStructuredRequest<T>) => {
        prompt = request.prompt;
        return { verdict: "reject", reason: "The complete supplied branch enforces the guard.", requiredEvidencePresent: true,
          falsePositiveRisk: "high", proofAssessment: { status: "refuted", evidence: text, assumptions: [] } } as T;
      } }, promptBuilder: createPromptBuilder(fakeLensRegistry()), lensRegistry: fakeLensRegistry(), diff: fixture.diff
    });
    expect(prompt).toContain("untrusted-data label=collected-source-evidence");
    expect(prompt).toContain(text);
    expect(prompt).toContain('"packetId": "other-packet"');
    expect(prompt).toContain('"source": "head"');
  });
  it.each(["unresolved", "recovered", "refuted", "bad-argument", "budget"] as const)("retains source-failure diagnostics only when evidence remains unresolved: %s", async mode => {
    const fixture = reviewFixture(["service.ts"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("source-failure", packet);
    const result = await verifyFindings({ packetResults: [packetResult(packet.id, [finding])], packets: [packet] }, fakeTools(), config(), nullTelemetry(), {
      runner: { runStructured: async <T>(request: LlmStructuredRequest<T>) => {
        request.onToolResults?.([{ id: "t1", tool: "search_files", target: "service.ts", requestKey: "exact", status: "error", resultChars: 50,
          errorCode: mode === "bad-argument" ? "invalid_args" : mode === "budget" ? "budget_exhausted" : "git_ref_missing", preview: "Unable to inspect selected revision" },
          ...(mode === "recovered" ? [{ id: "t2", tool: "search_files", target: "service.ts", requestKey: "exact", status: "ok" as const, resultChars: 100 }] : [])]);
        return { verdict: "reject", reason: "No supported defect.", requiredEvidencePresent: mode === "refuted", falsePositiveRisk: "high",
          proofAssessment: { status: mode === "refuted" ? "refuted" : "unresolved", evidence: "Caller policy inspected only in supplied scope.",
            assumptions: mode === "refuted" ? [] : [{ question: "Which caller requires this route?", essential: true }] } } as T;
      } }, promptBuilder: createPromptBuilder(fakeLensRegistry()), lensRegistry: fakeLensRegistry(), diff: fixture.diff
    });
    const verdict = result.verdicts[0]!;
    expect(verdict.verdict).toBe("reject");
    if (mode === "unresolved" || mode === "budget") expect(verdict.diagnostic).toMatchObject({ stage: 9, kind: mode === "budget" ? "incomplete" : "failure" });
    else expect(verdict.diagnostic).toBeUndefined();
  });

  it.each([
    { title: "An extra malformed-input case", actionable: false, evidence: "No consequential contract gap established; transport tests already exercise rejection." },
    { title: "Tenant assertion accepts another tenant", actionable: true, evidence: "The inspected tenant isolation boundary requires denial, but this assertion accepts cross-tenant access." },
    { title: "Payment limit test accepts an excessive charge", actionable: true, evidence: "The caller contract caps the amount; the modified assertion accepts a violating charge." },
    { title: "Missing rejection test for a correct authorization guard", actionable: true, evidence: "The established authorization boundary requires rejection. Inspected relevant tests would still pass if its currently correct guard were removed." }
  ])("keeps testing findings evidence-based without blanket suppression: $title", async ({ title, actionable, evidence }) => {
    // Scripted decisions test the prompt/publication contract, not live model judgment.
    const fixture = reviewFixture(["test_boundary.py"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("test-contract", packet, { category: "testing", title });
    const result = await verifyFindings({ packetResults: [packetResult(packet.id, [finding])], packets: [packet] }, fakeTools(), config(), nullTelemetry(), {
      runner: { runStructured: async <T>(request: LlmStructuredRequest<T>) => {
        expect(request.prompt).toContain("A missing test for a new branch alone is not a finding");
        expect(request.prompt).toContain("no existing production bug or executed mutation is required");
        expect(request.prompt).toContain("accept valid remedies");
        return { verdict: actionable ? "keep" : "reject", reason: evidence, requiredEvidencePresent: actionable,
          falsePositiveRisk: actionable ? "low" : "high", proofAssessment: { status: actionable ? "established" : "refuted", evidence, assumptions: [] } } as T;
      } }, promptBuilder: createPromptBuilder(fakeLensRegistry()), lensRegistry: fakeLensRegistry(), diff: fixture.diff
    });
    expect(result.verified).toHaveLength(actionable ? 1 : 0);
  });

  it.each([
    { material: true, title: "Recovery instructions disable authorization on a public listener",
      reason: "The documented public recovery command disables authorization, contradicting the deployment requirement." },
    { material: false, title: "Incident explanation omits an unrelated refactor",
      reason: "The incident-specific explanation need not enumerate unrelated implementation changes; no consequential misleading instruction was established." },
    { material: false, title: "Backup example mixes a rounded duration with an exact duration",
      reason: "The surrounding example provides the exact duration and correct recovery command. No evidence shows an incorrect retention decision or unsafe action; a possible future misunderstanding alone is not a demonstrated consequence." }
  ])("respects supplied documentation impact judgments without a documentation blacklist: $title", ({ material, title, reason }) => {
    // These are supplied verifier decisions, not a keyword-based materiality filter.
    const fixture = reviewFixture(["docs/operations.md"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("documentation-impact", packet, { category: "maintainability", title });
    return verifyFindings({ packetResults: [packetResult(packet.id, [finding])], packets: [packet] }, fakeTools(), config(), nullTelemetry(), {
      runner: verifierRunner(() => ({ verdict: material ? "keep" : "reject", reason, requiredEvidencePresent: material,
        falsePositiveRisk: material ? "low" : "high", proofAssessment: { status: material ? "established" : "refuted", evidence: reason, assumptions: [] } })),
      promptBuilder: createPromptBuilder(fakeLensRegistry()), lensRegistry: fakeLensRegistry(), diff: fixture.diff
    }).then(result => {
      expect(result.verified).toHaveLength(material ? 1 : 0);
      expect(result.verdicts[0]!.verdict).toBe(material ? "keep" : "reject");
      expect(result.incompleteCount).toBe(0);
    });
  });

  it("projects only neutral and packet-compatible skills into Stage 9", async () => {
    const fixture = reviewFixture(["src/lib.rs"]);
    const packet: ReviewPacket = {
      ...fixture.packets[0]!,
      language: "rust",
      lenses: ["shared/review"]
    };
    const finding = candidate("rust-projection", packet, {
      producedBy: {
        kind: "packet",
        stage: 7,
        packetId: packet.id,
        lensId: "shared/review",
        skillIds: ["projection/neutral", "projection/rust", "projection/python"]
      }
    });
    const skills = [
      projectionSkill("neutral", [], "VERIFIER_NEUTRAL_MARKER"),
      projectionSkill("rust", ["rust"], "VERIFIER_RUST_MARKER"),
      projectionSkill("python", ["python"], "VERIFIER_PYTHON_MARKER")
    ];
    const registry = registryWithSkills(skills);
    let prompt = "";

    await verifyFindings(
      { packetResults: [packetResult(packet.id, [finding])], packets: [packet] },
      fakeTools(),
      config(),
      nullTelemetry(),
      {
        runner: {
          runStructured: async <T>(request: LlmStructuredRequest<T>) => {
            prompt = request.prompt;
            return {
              verdict: "keep",
              reason: "The changed branch is reachable.",
              requiredEvidencePresent: true,
              falsePositiveRisk: "low"
            } as T;
          }
        },
        promptBuilder: createPromptBuilder(registry),
        lensRegistry: registry,
        diff: fixture.diff
      }
    );

    expect(prompt).toContain("VERIFIER_NEUTRAL_MARKER");
    expect(prompt).toContain("VERIFIER_RUST_MARKER");
    expect(prompt).not.toContain("VERIFIER_PYTHON_MARKER");
  });

  it("derives Stage 8 candidate language from the diff before Stage 9 projection", async () => {
    const fixture = reviewFixture(["src/lib.rs"]);
    const originPacket = fixture.packets[0]!;
    const finding = candidate("stage8-rust-projection", originPacket, {
      producedBy: {
        kind: "packet",
        stage: 8,
        packetId: "system-task-not-a-packet",
        lensId: "shared/review",
        skillIds: ["projection/neutral", "projection/rust", "projection/python", "projection/solidity"]
      }
    });
    const skills = [
      projectionSkill("neutral", [], "STAGE8_NEUTRAL_MARKER"),
      projectionSkill("rust", ["rust"], "STAGE8_RUST_MARKER"),
      projectionSkill("python", ["python"], "STAGE8_PYTHON_MARKER"),
      projectionSkill("solidity", ["solidity"], "STAGE8_SOLIDITY_MARKER")
    ];
    const registry = registryWithSkills(skills);
    let prompt = "";

    await verifyFindings(
      { packetResults: [packetResult("system-task-not-a-packet", [finding])], packets: [originPacket] },
      fakeTools(),
      config(),
      nullTelemetry(),
      {
        runner: {
          runStructured: async <T>(request: LlmStructuredRequest<T>) => {
            prompt = request.prompt;
            return {
              verdict: "keep",
              reason: "The system finding is supported by the changed Rust file.",
              requiredEvidencePresent: true,
              falsePositiveRisk: "low"
            } as T;
          }
        },
        promptBuilder: createPromptBuilder(registry),
        lensRegistry: registry,
        diff: fixture.diff
      }
    );

    expect(prompt).toContain("STAGE8_NEUTRAL_MARKER");
    expect(prompt).toContain("STAGE8_RUST_MARKER");
    expect(prompt).not.toContain("STAGE8_PYTHON_MARKER");
    expect(prompt).not.toContain("STAGE8_SOLIDITY_MARKER");
  });

  it("projects only neutral skills when a packetless candidate path is language-ambiguous", async () => {
    const fixture = reviewFixture(["src/lib.rs", "src/lib.py"]);
    const originPacket = fixture.packets.find((packet) => packet.path === "src/lib.rs")!;
    const finding = candidate("stage8-ambiguous-projection", originPacket, {
      producedBy: {
        kind: "packet",
        stage: 8,
        packetId: "system-task-not-a-packet",
        lensId: "shared/review",
        skillIds: ["projection/neutral", "projection/rust", "projection/python"]
      }
    });
    const pythonFile = fixture.diff.files.find((file) => file.path === "src/lib.py")!;
    const ambiguousDiff: UnifiedDiff = {
      ...fixture.diff,
      files: fixture.diff.files.map((file) => file === pythonFile ? { ...file, oldPath: "src/lib.rs" } : file)
    };
    const skills = [
      projectionSkill("neutral", [], "AMBIGUOUS_NEUTRAL_MARKER"),
      projectionSkill("rust", ["rust"], "AMBIGUOUS_RUST_MARKER"),
      projectionSkill("python", ["python"], "AMBIGUOUS_PYTHON_MARKER")
    ];
    const registry = registryWithSkills(skills);
    let prompt = "";

    await verifyFindings(
      { packetResults: [packetResult("system-task-not-a-packet", [finding])], packets: [originPacket] },
      fakeTools(),
      config(),
      nullTelemetry(),
      {
        runner: {
          runStructured: async <T>(request: LlmStructuredRequest<T>) => {
            prompt = request.prompt;
            return {
              verdict: "keep",
              reason: "The ambiguous system finding retains neutral guidance only.",
              requiredEvidencePresent: true,
              falsePositiveRisk: "low"
            } as T;
          }
        },
        promptBuilder: createPromptBuilder(registry),
        lensRegistry: registry,
        diff: ambiguousDiff
      }
    );

    expect(prompt).toContain("AMBIGUOUS_NEUTRAL_MARKER");
    expect(prompt).not.toContain("AMBIGUOUS_RUST_MARKER");
    expect(prompt).not.toContain("AMBIGUOUS_PYTHON_MARKER");
  });

  it("keeps Go and TypeScript Stage 9 prompts isolated from new language skills", async () => {
    for (const { path, language, compatibleMarker } of [
      { path: "pkg/service.go", language: "go", compatibleMarker: "VERIFIER_GO_MARKER" },
      { path: "src/service.ts", language: "typescript", compatibleMarker: "VERIFIER_TYPESCRIPT_MARKER" }
    ]) {
      const fixture = reviewFixture([path]);
      const packet: ReviewPacket = {
        ...fixture.packets[0]!,
        language,
        lenses: ["shared/review"]
      };
      const finding = candidate(`${language}-projection`, packet, {
        producedBy: {
          kind: "packet",
          stage: 7,
          packetId: packet.id,
          lensId: "shared/review",
          skillIds: [
            "projection/neutral",
            "projection/go",
            "projection/typescript",
            "projection/rust",
            "projection/python",
            "projection/solidity"
          ]
        }
      });
      const skills = [
        projectionSkill("neutral", [], "VERIFIER_EXISTING_NEUTRAL"),
        projectionSkill("go", ["go"], "VERIFIER_GO_MARKER"),
        projectionSkill("typescript", ["typescript"], "VERIFIER_TYPESCRIPT_MARKER"),
        projectionSkill("rust", ["rust"], "VERIFIER_NEW_RUST"),
        projectionSkill("python", ["python"], "VERIFIER_NEW_PYTHON"),
        projectionSkill("solidity", ["solidity"], "VERIFIER_NEW_SOLIDITY")
      ];
      const registry = registryWithSkills(skills);
      let prompt = "";

      await verifyFindings(
        { packetResults: [packetResult(packet.id, [finding])], packets: [packet] },
        fakeTools(),
        config(),
        nullTelemetry(),
        {
          runner: {
            runStructured: async <T>(request: LlmStructuredRequest<T>) => {
              prompt = request.prompt;
              return {
                verdict: "keep",
                reason: "The existing-language candidate is supported.",
                requiredEvidencePresent: true,
                falsePositiveRisk: "low"
              } as T;
            }
          },
          promptBuilder: createPromptBuilder(registry),
          lensRegistry: registry,
          diff: fixture.diff
        }
      );

      expect(prompt).toContain("VERIFIER_EXISTING_NEUTRAL");
      expect(prompt).toContain(compatibleMarker);
      expect(prompt).not.toContain("VERIFIER_NEW_RUST");
      expect(prompt).not.toContain("VERIFIER_NEW_PYTHON");
      expect(prompt).not.toContain("VERIFIER_NEW_SOLIDITY");
    }
  });

  it("treats empty provenance as authoritative and omits the empty guidance block", async () => {
    const fixture = reviewFixture(["src/service.ts"]);
    const packet = { ...fixture.packets[0]!, language: "typescript", lenses: ["shared/review"] };
    const finding = candidate("empty-provenance", packet, {
      producedBy: { kind: "packet", stage: 7, packetId: packet.id, lensId: "shared/review", skillIds: [] }
    });
    const addedLater = projectionSkill("added-later", ["typescript"], "MUST_NOT_APPEAR");
    const registry = registryWithSkills([addedLater]);
    let prompt = "";

    await verifyFindings(
      { packetResults: [packetResult(packet.id, [finding])], packets: [packet] },
      fakeTools(),
      config(),
      nullTelemetry(),
      {
        runner: {
          runStructured: async <T>(request: LlmStructuredRequest<T>) => {
            prompt = request.prompt;
            return { verdict: "reject", reason: "not supported", requiredEvidencePresent: false, falsePositiveRisk: "high" } as T;
          }
        },
        promptBuilder: createPromptBuilder(registry),
        lensRegistry: registry,
        diff: fixture.diff
      }
    );

    expect(prompt).not.toContain("MUST_NOT_APPEAR");
    expect(prompt).not.toContain("## Skill:");
    expect(prompt).not.toContain("Skill false-positive guidance:");
  });

  it("drops unknown and language-incompatible recorded ids without lens fallback", async () => {
    const fixture = reviewFixture(["src/service.ts"]);
    const packet = { ...fixture.packets[0]!, language: "typescript", lenses: ["shared/review"] };
    const finding = candidate("strict-provenance", packet, {
      producedBy: {
        kind: "packet",
        stage: 7,
        packetId: packet.id,
        lensId: "shared/review",
        skillIds: ["projection/neutral", "projection/python", "projection/stale"]
      }
    });
    const neutral = projectionSkill("neutral", [], "STRICT_NEUTRAL");
    const python = projectionSkill("python", ["python"], "STRICT_PYTHON");
    const addedLater = projectionSkill("added-later", ["typescript"], "STRICT_ADDED_LATER");
    const registry = registryWithSkills([neutral, python, addedLater]);
    const telemetry = captureTelemetry();
    let prompt = "";

    await verifyFindings(
      { packetResults: [packetResult(packet.id, [finding])], packets: [packet] },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: {
          runStructured: async <T>(request: LlmStructuredRequest<T>) => {
            prompt = request.prompt;
            return { verdict: "reject", reason: "not supported", requiredEvidencePresent: false, falsePositiveRisk: "high" } as T;
          }
        },
        promptBuilder: createPromptBuilder(registry),
        lensRegistry: registry,
        diff: fixture.diff
      }
    );

    expect(prompt).toContain("STRICT_NEUTRAL");
    expect(prompt).not.toContain("STRICT_PYTHON");
    expect(prompt).not.toContain("STRICT_ADDED_LATER");
    expect(telemetry.events).toContainEqual(expect.objectContaining({
      stage: 9,
      message: "verifier_skill_provenance",
      data: expect.objectContaining({
        requestedSkillIds: ["projection/neutral", "projection/python", "projection/stale"],
        resolvedSkillIds: ["projection/neutral"],
        droppedSkillIds: ["projection/python", "projection/stale"],
        unknownSkillIds: ["projection/stale"],
        languageIncompatibleSkillIds: ["projection/python"]
      })
    }));
  });

  it("rejects runtime-missing skill provenance instead of inferring it", async () => {
    const fixture = reviewFixture(["src/service.ts"]);
    const packet = fixture.packets[0]!;
    const malformed = candidate("missing-provenance", packet) as CandidateFinding & {
      producedBy: Omit<CandidateFinding["producedBy"], "skillIds"> & { skillIds?: string[] };
    };
    delete (malformed.producedBy as { skillIds?: string[] }).skillIds;

    const result = await verifyFindings(
      { packetResults: [packetResult(packet.id, [malformed as CandidateFinding])], packets: [packet] },
      fakeTools(),
      config(),
      nullTelemetry(),
      {
        runner: verifierRunner(() => ({ verdict: "reject", reason: "unused", requiredEvidencePresent: false, falsePositiveRisk: "high" })),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );
    expect(result).toMatchObject({
      verified: [],
      incompleteCount: 1,
      verdicts: [{
        candidateId: "missing-provenance",
        verdict: "incomplete",
        reason: expect.stringContaining("malformed skill provenance")
      }]
    });
  });

  it("schedules evidence-backed low-confidence correctness candidates for verification", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const finding = candidate("low-evidence", fixture.packets[0]!, {
      confidence: "low",
      severity: "medium",
      category: "correctness",
      evidence: {
        changedCode: "+ return route(provider)",
        relatedCode: [{
          path: "src/caller.ts",
          lines: "42: route(preferredProvider)",
          whyRelevant: "The caller supplies the preference affected by this behavior change."
        }]
      },
      failureMode: "The changed branch can skip the caller's explicit provider preference when fallback routing is needed."
    });
    const telemetry = captureTelemetry();
    let calls = 0;

    const result = await verifyFindings(
      { packetResults: [packetResult(fixture.packets[0]!.id, [finding])], packets: fixture.packets },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: verifierRunner(() => {
          calls += 1;
          return {
            verdict: "keep",
            reason: "The related caller evidence confirms the changed branch is reachable.",
            requiredEvidencePresent: true,
            falsePositiveRisk: "low"
          };
        }),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    expect(calls).toBe(1);
    expect(result.verified).toHaveLength(1);
    expect(result.verified[0]?.id).toBe("low-evidence");
    expect(telemetry.artifacts.get("verification.json")).toEqual([
      expect.objectContaining({
        candidateId: "low-evidence",
        gate: "passed",
        gateDecision: "scheduled_for_evidence_resolution",
        gateReason: "low_confidence_evidence_backed",
        verificationLane: "evidence_resolution",
        verdict: expect.objectContaining({ verdict: "keep" })
      })
    ]);
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 9,
        message: "pipeline_metrics",
        data: expect.objectContaining({
          candidates: expect.objectContaining({
            lowConfidenceEvidenceEligible: 1,
            lowConfidenceEvidenceScheduled: 1,
            lowConfidenceEvidenceKept: 1
          })
        })
      })
    ]));
  });

  it("keeps weak low-confidence candidates suppressed before verification", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const finding = candidate("low-weak", fixture.packets[0]!, {
      confidence: "low",
      severity: "medium",
      category: "correctness"
    });
    const telemetry = captureTelemetry();
    let calls = 0;

    const result = await verifyFindings(
      { packetResults: [packetResult(fixture.packets[0]!.id, [finding])], packets: fixture.packets },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: verifierRunner(() => {
          calls += 1;
          return {
            verdict: "keep",
            reason: "should not run",
            requiredEvidencePresent: true,
            falsePositiveRisk: "low"
          };
        }),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    expect(calls).toBe(0);
    expect(result.verified).toEqual([]);
    expect(result.gateRejections).toBe(1);
    expect(telemetry.artifacts.get("verification.json")).toEqual([
      expect.objectContaining({
        candidateId: "low-weak",
        gate: "suppressed",
        gateDecision: "suppressed",
        gateReason: "low_confidence_no_related_evidence"
      })
    ]);
  });

  it("caps the evidence-resolution lane and records unscheduled candidates", async () => {
    const paths = Array.from({ length: 5 }, (_value, index) => `src/case-${index}.ts`);
    const fixture = reviewFixture(paths);
    const findings = fixture.packets.map((packet, index) => candidate(`low-evidence-${index}`, packet, {
      confidence: "low",
      severity: "medium",
      category: "logic_bug",
      evidence: {
        changedCode: `+ return route${index}(provider)`,
        relatedCode: [{
          path: `src/caller-${index}.ts`,
          lines: `${index + 10}: route${index}(preferredProvider)`,
          whyRelevant: "The caller reaches this changed behavior."
        }]
      },
      failureMode: `The changed branch for case ${index} can now skip required fallback handling for callers.`
    }));
    const telemetry = captureTelemetry();
    let calls = 0;

    await verifyFindings(
      { packetResults: findings.map((finding) => packetResult(finding.producedBy.packetId, [finding])), packets: fixture.packets },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: verifierRunner(() => {
          calls += 1;
          return {
            verdict: "reject",
            reason: "Evidence predicate unresolved.",
            requiredEvidencePresent: false,
            falsePositiveRisk: "medium"
          };
        }),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    const records = telemetry.artifacts.get("verification.json") as EvalVerificationRecord[];
    expect(calls).toBe(4);
    expect(records.filter((record) => "verdict" in record)).toHaveLength(4);
    expect(records.filter((record) =>
      !("verdict" in record) &&
      record.gateDecision === "scheduled_for_evidence_resolution" &&
      record.gateReason === "low_confidence_evidence_resolution_lane_limit"
    )).toHaveLength(1);
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 9,
        message: "pipeline_metrics",
        data: expect.objectContaining({
          candidates: expect.objectContaining({
            lowConfidenceEvidenceEligible: 5,
            lowConfidenceEvidenceScheduled: 4,
            lowConfidenceEvidenceLaneLimited: 1,
            lowConfidenceEvidenceRejected: 4
          })
        })
      })
    ]));
  });

  it("records an incomplete promoted verdict even when a direct runner bypasses semantic validation", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("promoted-incomplete", packet, { provenance: {
      source: "uncertainty_promotion", sourceKind: "uncertainty", sourcePacketId: packet.id,
      question: "Does revocation deny access?", files: [packet.path], symbols: [], reason: "Investigate access"
    } });
    let validation: unknown;
    const result = await verifyFindings({ packetResults: [packetResult(packet.id, [finding])], packets: [packet] },
      fakeTools(), config(), nullTelemetry(), {
        runner: { runStructured: async <T>(request: LlmStructuredRequest<T>) => {
          const value = { verdict: "revise", reason: "Changed classification and severity", revisedAnchor: finding.anchor,
            requiredEvidencePresent: true, falsePositiveRisk: "low", proofAssessment: { status: "established", evidence: "Read handler omits membership check", assumptions: [] } };
          validation = request.validateSubmit?.(value as T);
          return value as T;
        } },
        promptBuilder: createPromptBuilder(fakeLensRegistry()), lensRegistry: fakeLensRegistry(), diff: fixture.diff
      });
    expect(validation).toMatchObject({ ok: false, details: expect.stringContaining("findingUpdates.title") });
    expect(result.verified).toEqual([]);
    expect(result.incompleteCount).toBe(1);
    expect(result.verdicts[0]).toMatchObject({ verdict: "incomplete", verificationIncomplete: true });
  });

  it("asks for a new evidence-backed verdict only when the original submission is unreadable", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("repair-instructions", packet);
    let checked = false;
    await verifyFindings({ packetResults: [packetResult(packet.id, [finding])], packets: [packet] },
      fakeTools(), config(), nullTelemetry(), {
        runner: { runStructured: async <T>(request: LlmStructuredRequest<T>) => {
          const input = { stage: 9 as const, submitTool: "submit_verdict", error: "Invalid JSON", submitCalls: [],
            untrustedSubmitCalls: [{ id: "bad", name: "submit_verdict", state: "invalid" as const, errorKind: "invalid_syntax" as const }], extraToolNames: [] };
          const unreadable = request.schemaRepair!.buildPrompt!(input);
          expect(unreadable).toContain("Generate a new complete Stage 9 verifier submission");
          expect(unreadable).toContain("not available as a trusted verdict");
          expect(unreadable).toContain("repository-tool evidence are retained");
          expect(unreadable).not.toContain("Preserve the verdict and substantive conclusions");
          const readable = request.schemaRepair!.buildPrompt!({ ...input, untrustedSubmitCalls: [], submitCalls: [{ id: "readable", arguments: { verdict: "keep" } }] });
          expect(readable).toContain("Preserve the verdict and substantive conclusions of the retained readable submission");
          expect(readable).not.toContain("Generate a new complete");
          checked = true;
          return { verdict: "keep", reason: "Confirmed", requiredEvidencePresent: true, falsePositiveRisk: "low" } as T;
        } }, promptBuilder: createPromptBuilder(fakeLensRegistry()), lensRegistry: fakeLensRegistry(), diff: fixture.diff
      });
    expect(checked).toBe(true);
  });

  it("supplies precise promoted repair targets through the live verifier request", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("promoted-repair", packet, { provenance: {
      source: "uncertainty_promotion", sourceKind: "uncertainty", sourcePacketId: packet.id,
      question: "Does revocation deny access?", files: [packet.path], symbols: [], reason: "Investigate access"
    } });
    let repaired = false;
    const result = await verifyFindings({ packetResults: [packetResult(packet.id, [finding])], packets: [packet] },
      fakeTools(), config(), nullTelemetry(), {
        runner: { runStructured: async <T>(request: LlmStructuredRequest<T>) => {
          const input = { verdict: "revise", reason: "Confirmed the missing permission check", requiredEvidencePresent: true,
            falsePositiveRisk: "low", proofAssessment: { status: "established", evidence: "Read handler omits membership check", assumptions: [] },
            findingUpdates: Object.fromEntries(["title", "failureMode", "whyThisMatters", "verification", "category"].map(key => [key, finding[key as keyof CandidateFinding]])) };
          expect(request.validateSubmit?.(input as T)).toMatchObject({ ok: false });
          const repair = request.schemaRepair!.createFieldRepair!(request.schema, input)!;
          expect(repair.paths).toEqual(["findingUpdates.severity", "findingUpdates.confidence"]);
          const merged = repair.merge({ "findingUpdates.severity": "medium", "findingUpdates.confidence": "high" });
          expect(request.validateSubmit?.(merged as T)).toEqual({ ok: true });
          repaired = true;
          return merged as T;
        } }, promptBuilder: createPromptBuilder(fakeLensRegistry()), lensRegistry: fakeLensRegistry(), diff: fixture.diff
      });
    expect(repaired).toBe(true);
    expect(result.incompleteCount).toBe(0);
    expect(result.verified[0]).toMatchObject({ severity: "medium", confidence: "high" });
  });

  it("keeps promoted uncertainty provenance in verification records and metrics", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const finding = candidate("promoted-uncertainty", fixture.packets[0]!, {
      confidence: "low",
      evidence: {
        changedCode: "+ return route(provider)",
        relatedCode: [{
          path: "src/app.ts",
          lines: "function changed0(provider: string)",
          whyRelevant: "Changed symbol attached to the promoted uncertainty."
        }]
      },
      provenance: {
        source: "uncertainty_promotion",
        sourceKind: "uncertainty",
        sourcePacketId: fixture.packets[0]!.id,
        question: "Verify fallback behavior still preserves caller contract",
        files: ["src/app.ts"],
        symbols: ["changed0"],
        reason: "packet reviewer reported an unresolved uncertainty"
      }
    });
    const telemetry = captureTelemetry();

    await verifyFindings(
      { packetResults: [packetResult(fixture.packets[0]!.id, [finding])], packets: fixture.packets },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: verifierRunner(() => ({
          verdict: "keep",
          reason: "The verifier confirmed the promoted predicate.",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low",
          findingUpdates: { title: finding.title, failureMode: finding.failureMode, whyThisMatters: finding.whyThisMatters,
            verification: finding.verification, category: finding.category, severity: finding.severity, confidence: finding.confidence }
        })),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    expect(telemetry.artifacts.get("verification.json")).toEqual([
      expect.objectContaining({
        candidateId: "promoted-uncertainty",
        candidateProvenance: expect.objectContaining({
          source: "uncertainty_promotion",
          sourceKind: "uncertainty",
          sourcePacketId: fixture.packets[0]!.id
        }),
        verdict: expect.objectContaining({ verdict: "revise" })
      })
    ]);
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 9,
        message: "pipeline_metrics",
        data: expect.objectContaining({
          candidates: expect.objectContaining({
            promotedCandidates: 1,
            promotedVerificationScheduled: 1,
            promotedVerificationKept: 1
          })
        })
      })
    ]));
  });

  it.each([true, false])("retains unresolved essential concerns without publishing them: %s", async essential => {
    const fixture = reviewFixture(["app.ts"]);
    const packet = fixture.packets[0]!;
    const input = candidate("conditional-contract", packet);
    const assessment = { status: essential ? "unresolved" : "established", evidence: "Changed conversion is visible; the downstream contract determines the impact.",
      assumptions: [{ question: "Does the deployed contract interpret the amount in destination units?", essential }] };
    let validation: unknown;
    const result = await verifyFindings({ packetResults: [packetResult(packet.id, [input])], packets: [packet] },
      fakeTools(), config(), nullTelemetry(), {
        runner: { runStructured: async <T>(request: LlmStructuredRequest<T>) => {
          const value = { verdict: "keep", reason: "The amount conversion changed.", requiredEvidencePresent: true,
            falsePositiveRisk: "medium", proofAssessment: assessment };
          expect((request.schema as { required?: string[] }).required).toContain("proofAssessment");
          validation = request.validateSubmit?.(value as T);
          return value as T;
        } },
        promptBuilder: createPromptBuilder(fakeLensRegistry()), lensRegistry: fakeLensRegistry(), diff: fixture.diff
      });
    expect(validation).toMatchObject({ ok: !essential });
    expect(result.verified).toHaveLength(essential ? 0 : 1);
    if (essential) {
      expect(result.verdicts[0]?.unresolvedConcern?.question).toContain("destination units");
      expect(result.verdicts[0]?.proofAssessment).toEqual(assessment);
      expect(result.incompleteCount).toBe(0);
    }
  });

  it.each(["truncated", "counterexample", "complete-absence", "secondary"] as const)("propagates supplied absence-claim proof boundaries: %s", async mode => {
    const fixture = reviewFixture(["app.ts"]);
    const packet = fixture.packets[0]!;
    const input = candidate("absence-check", packet);
    const assessment = {
      status: mode === "truncated" ? "unresolved" : mode === "counterexample" ? "refuted" : "established",
      evidence: mode === "truncated" ? "Only the first part of the authorization handler was delivered."
        : mode === "counterexample" ? "The full handler includes requireActiveMembership after the truncated prefix."
        : "The complete read handler has no active-membership check and returns private content.",
      assumptions: mode === "truncated" ? [{ question: "Does the uninspected remainder enforce membership?", essential: true }]
        : mode === "secondary" ? [{ question: "How many cached sessions remain live?", essential: false }] : []
    };
    const shouldKeep = mode === "complete-absence" || mode === "secondary";
    const result = await verifyFindings({ packetResults: [packetResult(packet.id, [input])], packets: [packet] },
      fakeTools(), config(), nullTelemetry(), {
        runner: verifierRunner(() => ({ verdict: shouldKeep ? "keep" : "reject", reason: assessment.evidence,
          requiredEvidencePresent: shouldKeep, falsePositiveRisk: shouldKeep ? "low" : "high", proofAssessment: assessment })),
        promptBuilder: createPromptBuilder(fakeLensRegistry()), lensRegistry: fakeLensRegistry(), diff: fixture.diff
      });
    expect(result.verified).toHaveLength(shouldKeep ? 1 : 0);
    expect(result.verdicts[0]?.proofAssessment).toEqual(assessment);
    expect(result.incompleteCount).toBe(0);
    if (mode === "truncated") expect(result.verdicts[0]?.unresolvedConcern?.question).toContain("uninspected remainder");
  });

  it("publishes one coherent expanded revision when a broad claim is narrowed", async () => {
    const fixture = reviewFixture(["app.ts"]);
    const packet = fixture.packets[0]!;
    const input = candidate("narrowed", packet, { title: "All requests bypass authorization", whyThisMatters: "Every request leaks data." });
    const updates = { title: "Revoked members retain read access", failureMode: "The cached-session path omits an active membership check.",
      whyThisMatters: "Only reads using an existing cached membership leak private content after revocation.",
      verification: "Fresh sessions are checked. The cached read path is the remaining defect." };
    const result = await verifyFindings({ packetResults: [packetResult(packet.id, [input])], packets: [packet] },
      fakeTools(), config(), nullTelemetry(), {
        runner: verifierRunner(() => ({ verdict: "revise", reason: "Fresh-session guards refute the broad premise.",
          requiredEvidencePresent: true, falsePositiveRisk: "low", findingUpdates: updates })),
        promptBuilder: createPromptBuilder(fakeLensRegistry()), lensRegistry: fakeLensRegistry(), diff: fixture.diff
      });
    expect(result.verified[0]).toMatchObject(updates);
    expect(result.verdicts[0]?.finalFinding).toMatchObject(updates);
    expect(result.verified[0]?.evidence).toEqual(input.evidence);
    expect(result.verified[0]?.whyThisMatters).not.toContain("Every request");
  });

  it("rejects keep verdicts that report required evidence is missing", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const finding = candidate("missing-evidence-keep", fixture.packets[0]!);
    const telemetry = captureTelemetry();

    const result = await verifyFindings(
      { packetResults: [packetResult(fixture.packets[0]!.id, [finding])], packets: fixture.packets },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: verifierRunner(() => ({
          verdict: "keep",
          reason: "The helper source was unavailable, so this could not be confirmed.",
          requiredEvidencePresent: false,
          falsePositiveRisk: "medium"
        })),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    expect(result.verified).toEqual([]);
    expect(telemetry.artifacts.get("verification.json")).toEqual([
      expect.objectContaining({
        candidateId: "missing-evidence-keep",
        verdict: expect.objectContaining({
          verdict: "reject",
          requiredEvidencePresent: false,
          falsePositiveRisk: "high",
          reason: expect.stringContaining("required evidence missing")
        })
      })
    ]);
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 9,
        message: "verification_missing_evidence_normalized_to_reject",
        data: expect.objectContaining({
          candidateId: "missing-evidence-keep",
          originalVerdict: "keep"
        })
      })
    ]));
  });
});

describe("stage 9 eval diagnostics and prompts", () => {
  it("separates low-confidence pre-gate suppression from evidence lane limits", () => {
    const suppressed = candidate("low-suppressed", fakePacket("packet-1", "src/app.ts"), {
      confidence: "low"
    });
    const laneLimited = candidate("lane-limited", fakePacket("packet-2", "src/other.ts"), {
      confidence: "low",
      evidence: {
        changedCode: "+ return other()",
        relatedCode: [{ path: "src/caller.ts", lines: "10: other()", whyRelevant: "Caller reaches this code." }]
      }
    });

    const score = scoreEvalRun({
      name: "loss-labels",
      artifacts: { path: "unused" },
      should_find: [
        { id: "suppressed", path: "src/app.ts" },
        { id: "lane", path: "src/other.ts" }
      ]
    }, {
      candidates: [suppressed, laneLimited],
      verification: [
        { candidateId: "low-suppressed", gate: "suppressed", gateReason: "low_confidence_no_related_evidence" },
        { candidateId: "lane-limited", gate: "suppressed", gateReason: "low_confidence_evidence_resolution_lane_limit", verificationLane: "evidence_resolution" }
      ],
      finalSelection: [],
      finalFindings: [],
      packets: [],
      hintEvents: [],
      metricsSources: {}
    }, "live");

    expect(score.expectationResults.map((result) => result.loss?.subReason)).toEqual([
      "low-confidence-pre-gate-suppressed",
      "evidence-resolution-lane-limit"
    ]);
  });

  it("includes confidence calibration and same-PR-test guidance in prompts", () => {
    const packet = fakePacket("packet-1", "src/app.ts");
    const finding = candidate("candidate-1", packet);
    const promptBuilder = createPromptBuilder(fakeLensRegistry());

    const packetPrompt = promptBuilder.buildPacketReviewPrompt({ packet, skills: [] }).prompt;
    const verifierPrompt = promptBuilder.buildVerifierPrompt({
      candidate: finding,
      originContext: "",
      hunksText: packet.hunks[0]!.contentWithLineNumbers,
      skills: []
    }).prompt;

    expect(packetPrompt).toContain("do not mark a changed-line correctness/security finding low confidence solely");
    expect(packetPrompt).toContain("verifier-resolvable predicate remains");
    expect(packetPrompt).toContain("specific instruction or decision the reader would get wrong");
    expect(packetPrompt).toContain("hypothetical monitoring/implementation mistake alone does not establish material impact");
    expect(verifierPrompt).toContain("As a final verification decision, assess each final suggestion");
    expect(verifierPrompt).toContain("Select one concrete supported remedy");
    expect(verifierPrompt).toContain("findingUpdates.suggestedFix containing only the supported branch");
    expect(verifierPrompt).toContain("A caveat to confirm compatibility cannot authorize a weaker guarantee");
    expect(verifierPrompt).toContain("Omit suggestionText to bind it automatically");
    expect(verifierPrompt).toContain("accept other requirement-preserving fixes");
    expect(verifierPrompt).toContain("specific symptom-hiding remedy, and the legitimate remedies");
    expect(verifierPrompt).toContain("original input and authoritative contract");
    expect(verifierPrompt).toContain("explain the result in the existing assessment rationale");
    expect(verifierPrompt).toContain("Checking two values against their separate expected values");
    expect(verifierPrompt).toContain("A remedy-specific test may cover one explicitly identified alternative");
    expect(verifierPrompt).toContain("specific instruction or decision the reader would get wrong");
    expect(verifierPrompt).toContain("hypothetical monitoring/implementation mistake alone does not establish material impact");
    expect(verifierPrompt).toContain("Read the surrounding example and corrective instructions");
    expect(verifierPrompt).toContain("do not assert downstream failure without support");
    expect(verifierPrompt).toContain("A supported fix does not make its test supported");
    expect(verifierPrompt).toContain("otherwise leave the test unverified");
    expect(verifierPrompt).toContain("Do not invent tolerances or weaken the original requirement");
    expect(verifierPrompt).toContain("Rejecting an extreme workaround alone is insufficient");
    expect(verifierPrompt).toContain("test advice in either suggestedFix or suggestedTest");
    expect(verifierPrompt).toContain("Treat rejection as an alternative only when the contract permits it");
    expect(verifierPrompt).toContain("Source inspection does not mean tests were executed");
    expect(verifierPrompt).toContain("Same-PR tests that assert new behavior prove the behavior changed");
    expect(verifierPrompt).toContain("refactor, cleanup, consolidation, behavior-preserving");
    expect(verifierPrompt).toContain("cite the exact helper/callee branch that proves the failure mode");
    expect(verifierPrompt).toContain("For category:\"testing\" candidates, production code does not need to change");
    expect(verifierPrompt).toContain("old/base tests covered a named behavior boundary");
    expect(verifierPrompt).toContain("reject generic add-more-tests comments");
    expect(verifierPrompt).toContain("verify the concrete predicate preserved in provenance");
    expect(verifierPrompt).toContain("Commit titles, PR text, and intent signals are context, not proof");
    // Issue 73: caller-visible guarantee / deliverability nudges
    expect(packetPrompt).toContain("caller-visible");
    expect(packetPrompt).toContain("deliverable/satisfiable");
    expect(packetPrompt).toContain("internally consistent");
    expect(verifierPrompt).toContain("promoted lossy-transform");
    expect(verifierPrompt).toContain("caller-visible");
    expect(verifierPrompt).toContain("transformed value");
    expect(verifierPrompt).toContain("original source value");
    expect(verifierPrompt).toContain("A bare keep means");
    expect(verifierPrompt).toContain("a revision must include findingUpdates or revisedAnchor");
    expect(verifierPrompt).toContain("Calibrate confidence from proof, not tool pressure on secondary checks");
    expect(verifierPrompt).toContain("explicitly supply final title, failureMode, whyThisMatters, verification, category, severity and confidence");
    expect(verifierPrompt).toContain("weakening the caller's original requirement");
    expect(verifierPrompt).toContain("plausible answer to an open question eliminates the defect");
    expect(verifierPrompt).toContain("low means bounded or localized impact");
    expect(verifierPrompt).toContain("Measure magnitude and reach");
    expect(verifierPrompt).toContain("changing severity by more than one level");
  });
});

function reviewFixture(paths: string[]): { diff: UnifiedDiff; packets: ReviewPacket[] } {
  const rawDiff = paths.map((filePath, index) => `diff --git a/${filePath} b/${filePath}
index 1111111..2222222 100644
--- a/${filePath}
+++ b/${filePath}
@@ -1,3 +1,3 @@
 export function changed${index}(provider: string) {
-  return previous(provider);
+  return route${index}(provider);
 }
`).join("");
  const diff = parseDiff(rawDiff);
  return {
    diff,
    packets: diff.files.map((file, index) => {
      const hunk = file.hunks[0];
      if (!hunk) {
        throw new Error(`missing hunk for ${file.path}`);
      }
      return fakePacket(`packet-${index}`, file.path, hunk.id, `changed${index}`);
    })
  };
}

function fakePacket(packetId: string, filePath: string, hunkId = "h1", symbol = "changed"): ReviewPacket {
  return {
    id: packetId,
    dispatchRank: [0, -1],
    kind: "hunk",
    prSummary: "test",
    path: filePath,
    fileStatus: "modified",
    isDeletedContent: false,
    language: "typescript",
    reviewPriority: "normal",
    coverage: "normal",
    reviewProfile: "standard",
    lenses: ["core/code-review"],
    hunks: [
      {
        hunkId,
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        contentWithLineNumbers: `   1    1  export function ${symbol}(provider: string) {\n   2    2 +  return route(provider);\n   3    3  }\n`,
        lines: [
          { kind: "context", content: `export function ${symbol}(provider: string) {`, oldLine: 1, newLine: 1 },
          { kind: "add", content: "return route(provider);", newLine: 2 },
          { kind: "context", content: "}", oldLine: 3, newLine: 3 }
        ],
        changedNewLineNumbers: [2],
        changedOldLineNumbers: []
      }
    ],
    symbolFacts: [
      {
        path: filePath,
        hunkId,
        enclosingSymbol: symbol,
        symbolKind: "function",
        symbolRange: [1, 3],
        changedLines: [2],
        changedLinesSide: "new",
        signature: `function ${symbol}(provider: string)`,
        source: "tree-sitter",
        confidence: "syntactic"
      }
    ],
    context: { path: filePath },
    contextText: "",
    relevantTests: [],
    surroundingContextHints: [],
    labels: [],
    attentionNotes: [],
    relatedChangedContext: [],
    toolBudget: { maxToolCalls: 1, maxInvestigationRounds: 1, maxResultChars: 4000 }
  };
}

function packetResult(packetId: string, findings: CandidateFinding[]): PacketReviewResult {
  return {
    packetId,
    lenses: ["core/code-review"],
    findings,
    followUpHints: [],
    uncertainties: [],
    status: "completed"
  };
}

function candidate(id: string, packet: ReviewPacket, overrides: Partial<CandidateFinding> = {}): CandidateFinding {
  const hunk = packet.hunks[0];
  if (!hunk) {
    throw new Error("expected packet hunk");
  }
  return {
    id,
    title: `Candidate ${id}`,
    severity: "medium",
    confidence: "high",
    path: packet.path,
    anchor: { path: packet.path, line: 2, side: "RIGHT", hunkId: hunk.hunkId },
    changedLine: true,
    category: "correctness",
    evidence: { changedCode: "+ return route(provider);" },
    failureMode: "The changed branch can return a different route for an existing caller-visible condition.",
    whyThisMatters: "Callers can receive a route that violates the previous contract.",
    verification: "The candidate is based on the changed line.",
    producedBy: { kind: "packet", stage: 7, packetId: packet.id, lensId: "core/code-review", skillIds: [] },
    ...overrides
  };
}

function verifierRunner(result: () => Record<string, unknown>): LlmRunner {
  return {
    runStructured: async <T>() => result() as T
  };
}

function fakeTools(): RepositoryTools {
  const meta = { backend: "text" as const, precision: "exact" as const, degraded: false };
  const tools: RepositoryTools & Pick<RepositoryToolsHost, "bindPackets" | "buildPacketContext" | "withToolCallContext"> = {
    readRange: async () => ({ text: "", meta }),
    readFileOutline: async (path) => ({ outline: { path, language: "typescript", imports: [], topLevelSymbols: [], testSymbols: [], notes: [] }, meta }),
    readSymbol: async () => ({ meta }),
    readDiffBlocks: async () => ({ blocks: [], meta }),
    findDefinition: async () => ({ definitions: [], meta }),
    searchFiles: async () => ({ results: [], meta }),
    findSymbolMentions: async () => ({ results: [], meta }),
    findLikelyTests: async () => ({ tests: [], meta }),
    listFiles: async () => ({ paths: [], meta }),
    bindPackets: () => undefined,
    buildPacketContext: async (file) => ({ context: { path: file.path }, relevantTests: [] }),
    withToolCallContext: async <T>(_context: Parameters<RepositoryToolsHost["withToolCallContext"]>[0], run: () => Promise<T>) => run()
  };
  return tools;
}

function fakeLensRegistry() {
  return {
    allLenses: () => [],
    enabledLenses: () => [],
    lens: () => undefined,
    skillsForLens: () => [],
    skillsById: () => [],
    registryHash: () => "fake"
  };
}

function registryWithSkills(skills: Skill[]) {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  return {
    ...fakeLensRegistry(),
    skillsForLens: () => skills,
    skillsById: (ids: string[]) => ids.flatMap((id) => {
      const skill = byId.get(id);
      return skill === undefined ? [] : [skill];
    })
  };
}

function projectionSkill(id: string, languages: string[], marker: string): Skill {
  return {
    id: `projection/${id}`,
    title: `Projection ${id}`,
    lenses: ["shared/review"],
    languages,
    categories: ["correctness"],
    enabledByDefault: true,
    source: "bundled",
    filePath: `bundled-skills/projection/${id}.md`,
    contentSha: id,
    summaryLine: marker,
    sections: { checks: marker, falsePositives: marker }
  };
}

function config(): CodegenieConfig {
  return {
    ...defaultConfig,
    lenses: { enabled: ["core/code-review"], disabled: [], extraSkillPaths: [] },
    telemetry: { ...defaultConfig.telemetry, enabled: false },
    llm: { provider: "fake", model: "fake-model", maxConcurrentCalls: 1 },
    review: { ...defaultConfig.review, concurrency: 1 }
  };
}

function captureTelemetry(): {
  events: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">>;
  artifacts: Map<string, unknown>;
  recorder: ReturnType<typeof nullTelemetry>;
} {
  const events: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">> = [];
  const artifacts = new Map<string, unknown>();
  return {
    events,
    artifacts,
    recorder: {
      ...nullTelemetry(),
      event: (event) => {
        events.push(event);
      },
      writeArtifact: async (relPath, data) => {
        artifacts.set(relPath, data);
      }
    }
  };
}

describe("plan 106 verifier revision semantics", () => {
  it("canonicalizes legacy keep payloads to revise while preserving both payload kinds", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("legacy-keep-payload", packet);
    const telemetry = captureTelemetry();

    const result = await verifyFindings(
      { packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: verifierRunner(() => ({
          verdict: "keep",
          reason: "Legacy provider changed the finding while saying keep.",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low",
          finalFinding: {
            title: "Calibrated legacy finding",
            severity: "medium",
            confidence: "medium",
            path: packet.path,
            category: "correctness",
            evidence: { changedCode: "+ return route(provider);" },
            failureMode: finding.failureMode,
            whyThisMatters: finding.whyThisMatters,
            verification: "The decisive changed branch confirms the failure mode."
          },
          revisedAnchor: { path: packet.path, line: 2, side: "RIGHT", hunkId: packet.hunks[0]!.hunkId }
        })),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    expect(result.verdicts[0]).toMatchObject({ verdict: "revise", finalFinding: { title: "Calibrated legacy finding" } });
    expect(result.verified[0]).toMatchObject({ title: "Calibrated legacy finding", confidence: "medium", anchorSource: "verifier_revised" });
    expect(telemetry.events).toContainEqual(expect.objectContaining({
      message: "verification_keep_payload_canonicalized",
      data: { candidateId: finding.id, payloadKinds: ["finalFinding", "revisedAnchor"] }
    }));
  });

  it("rejects a canonicalized keep payload when required evidence is missing", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("legacy-keep-missing-evidence", packet);
    const telemetry = captureTelemetry();

    const result = await verifyFindings(
      { packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: verifierRunner(() => ({
          verdict: "keep",
          reason: "Legacy payload is not backed by required evidence.",
          requiredEvidencePresent: false,
          falsePositiveRisk: "high",
          finalFinding: {
            title: "Unsupported legacy revision",
            severity: "medium",
            confidence: "medium",
            path: packet.path,
            category: "correctness",
            evidence: { changedCode: "+ return route(provider);" },
            failureMode: finding.failureMode,
            whyThisMatters: finding.whyThisMatters,
            verification: "The decisive predicate was not confirmed."
          }
        })),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    expect(result.verified).toEqual([]);
    expect(result.verdicts[0]).toMatchObject({
      verdict: "reject",
      requiredEvidencePresent: false,
      falsePositiveRisk: "high",
      reason: expect.stringContaining("required evidence missing; original keep verdict rejected")
    });
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "verification_keep_payload_canonicalized",
        data: { candidateId: finding.id, payloadKinds: ["finalFinding"] }
      }),
      expect.objectContaining({
        message: "verification_missing_evidence_normalized_to_reject",
        data: expect.objectContaining({ candidateId: finding.id, originalVerdict: "keep" })
      })
    ]));
    expect(telemetry.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "verification_severity_revision" })
    ]));
  });

  it("applies compact updates while preserving evidence, identity, and anchor provenance", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("compact-update", packet, {
      anchorSource: "model", suggestedFix: "Preserve the old route."
    });
    const telemetry = captureTelemetry();
    const result = await verifyFindings(
      { packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
      fakeTools(), config(), telemetry.recorder,
      {
        runner: verifierRunner(() => ({
          verdict: "revise", reason: "Clarify the confirmed trigger.",
          requiredEvidencePresent: true, falsePositiveRisk: "low",
          findingUpdates: { title: "Changed branch returns an incompatible route", confidence: "medium" }
        })),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(), diff: fixture.diff
      }
    );
    expect(result.verified).toHaveLength(1);
    expect(result.verified[0]).toMatchObject({
      id: finding.id, title: "Changed branch returns an incompatible route", confidence: "medium",
      evidence: finding.evidence, failureMode: finding.failureMode, verification: finding.verification,
      suggestedFix: finding.suggestedFix, producedBy: finding.producedBy,
      anchor: finding.anchor, anchorSource: finding.anchorSource
    });
    expect(result.verified[0]).not.toHaveProperty("originalSuggestions");
    expect(finding.title).toBe("Candidate compact-update");
    expect(telemetry.events).toContainEqual(expect.objectContaining({ message: "verification_primary_submit_accepted" }));
  });

  it.each(["keep", "compact", "full"])("binds omitted assessment text to the final %s suggestion", async representation => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("implicit-binding", packet, { suggestedTest: "Check the requested minimum (e.g. 1001)." });
    const finalText = representation === "keep" ? finding.suggestedTest! : "Check the original request and delivery (e.g. 1001).";
    const result = await verifyFindings({ packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
      fakeTools(), config(), nullTelemetry(), {
        runner: verifierRunner(() => ({ verdict: representation === "keep" ? "keep" : "revise",
          reason: "The original requirement must survive the fix.", requiredEvidencePresent: true, falsePositiveRisk: "low",
          ...(representation === "compact" ? { findingUpdates: { suggestedTest: finalText } } : {}),
          ...(representation === "full" ? { finalFinding: { ...finding, suggestedTest: finalText } } : {}),
          suggestionAssessments: { suggestedTest: { status: "supported", rationale: "Tests the caller's original bound.",
            contractCheck: { status: "established", requirement: "Delivery must meet the original request." },
            evidence: [{ path: "caller.ts", lines: "10-12", whyRelevant: "Checks the requested minimum." }] } }
        })), promptBuilder: createPromptBuilder(fakeLensRegistry()), lensRegistry: fakeLensRegistry(), diff: fixture.diff
      });
    expect(result.verified[0]?.suggestionAssessments?.suggestedTest).toMatchObject({ status: "supported", suggestionText: finalText });
    expect(result.verified[0]?.suggestedTest).toBe(finalText);
  });

  it.each(["Check the original minimum (e.g., 1001).", "Check only the lowered minimum."])("keeps explicit assessment mismatch strict: %s", async assessedText => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("explicit-binding", packet, { suggestedTest: "Check the original minimum (e.g. 1001)." });
    const telemetry = captureTelemetry();
    const result = await verifyFindings({ packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
      fakeTools(), config(), telemetry.recorder, {
        runner: verifierRunner(() => ({ verdict: "keep", reason: "Confirmed", requiredEvidencePresent: true, falsePositiveRisk: "low",
          suggestionAssessments: { suggestedTest: { status: "supported", suggestionText: assessedText, rationale: "A source-backed check.",
            contractCheck: { status: "established", requirement: "Preserve the original minimum." },
            evidence: [{ path: "caller.ts", lines: "10-12", whyRelevant: "Defines the minimum." }] } }
        })), promptBuilder: createPromptBuilder(fakeLensRegistry()), lensRegistry: fakeLensRegistry(), diff: fixture.diff
      });
    expect(result.verified[0]?.suggestionAssessments?.suggestedTest?.status).toBe("unverified");
    expect(result.verified[0]?.suggestedTest).toBe(finding.suggestedTest);
    expect(telemetry.events).toContainEqual(expect.objectContaining({ message: "verification_suggestion_support_downgraded" }));
  });

  it.each([
    { name: "rounded delivery", compound: "Round delivery up, or lower the published minimum to the floored delivery.",
      chosen: "Round delivery up while keeping the original requested minimum.",
      weakTest: "Assert delivery is at least the published minimum.",
      chosenTest: "For request 1001 with transfer granularity 1000, assert request <= minimum <= delivery; for the round-up remedy delivery is 2000.",
      requirement: "A successful quote must deliver at least the original request.",
      cases: [{ request: 1001, minimum: 1001, delivery: 1000 }, { request: 1001, minimum: 1000, delivery: 1000 }, { request: 1001, minimum: 1001, delivery: 2000 }],
      accepts: (x: { request: number; minimum: number; delivery: number }) => x.request <= x.minimum && x.minimum <= x.delivery },
    { name: "retention allocation", compound: "Allocate enough storage for the retention request, or reduce the advertised retention to available storage.",
      chosen: "Allocate capacity meeting the caller's original retention request.",
      weakTest: "Assert advertised retention does not exceed capacity.",
      chosenTest: "For a 30-day request, assert requested retention <= advertised retention <= capacity; accept capacity of 30 or more days.",
      requirement: "Successful allocation preserves the caller's minimum retention period.",
      cases: [{ request: 30, minimum: 30, delivery: 29 }, { request: 30, minimum: 29, delivery: 29 }, { request: 30, minimum: 30, delivery: 31 }],
      accepts: (x: { request: number; minimum: number; delivery: number }) => x.request <= x.minimum && x.minimum <= x.delivery }
  ])("publishes the selected $name remedy and aligned test, retaining the compound as provenance", async example => {
    // Executable counterexamples establish the fixture's contract. The scripted
    // verifier exercises revision/publication, not live model judgment.
    expect(example.cases.map(example.accepts)).toEqual([false, false, true]);
    expect(example.cases.map(x => x.minimum <= x.delivery)).toEqual([false, true, true]);
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("compound-remedy", packet, { suggestedFix: example.compound, suggestedTest: example.weakTest });
    const evidence = [{ path: "caller-contract.ts", lines: "10-15", whyRelevant: example.requirement }];
    let calls = 0;
    const result = await verifyFindings({ packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
      fakeTools(), config(), nullTelemetry(), {
        runner: verifierRunner(() => {
          calls++;
          return { verdict: "revise", reason: "Select the branch that satisfies the original caller requirement.",
            requiredEvidencePresent: true, falsePositiveRisk: "low",
            findingUpdates: { suggestedFix: example.chosen, suggestedTest: example.chosenTest },
            suggestionAssessments: Object.fromEntries(["suggestedFix", "suggestedTest"].map(field => [field, {
              status: "supported", contractCheck: { status: "established", requirement: example.requirement }, evidence,
              rationale: "The chosen branch preserves the request. The revised assertion rejects the defect and the weaker promise, and accepts the chosen remedy."
            }])) };
        }), promptBuilder: createPromptBuilder(fakeLensRegistry()), lensRegistry: fakeLensRegistry(), diff: fixture.diff
      });
    expect(calls).toBe(1);
    expect(result.incompleteCount).toBe(0);
    const verified = result.verified[0]!;
    const body = renderRetainedComposition([verified]);
    const primary = body.split("\n\n<details>")[0]!;
    expect(primary).toContain(example.chosen);
    expect(primary).toContain(example.chosenTest);
    expect(primary).not.toContain(example.compound);
    expect(primary).not.toContain(example.weakTest);
    expect(verified.originalSuggestions?.suggestedFix?.suggestionText).toBe(example.compound);
    expect(body).toContain(example.compound);
    expect(body).toContain(example.weakTest);
  });

  it.each([true, false])("binds remedy assessments after compact expansion (matching=%s)", async matching => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("assessed-revision", packet, {
      suggestedFix: "Lower the promised output.", suggestedTest: "Assert the lower output."
    });
    const updatedFix = "Round up to satisfy the caller minimum.";
    const telemetry = captureTelemetry();
    let calls = 0;
    const result = await verifyFindings(
      { packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
      fakeTools(), config(), telemetry.recorder,
      {
        runner: verifierRunner(() => {
          calls++;
          return {
            verdict: "revise", reason: "The caller requires the original minimum.", requiredEvidencePresent: true, falsePositiveRisk: "low",
            findingUpdates: { suggestedFix: updatedFix },
            proofAssessment: { status: "established", evidence: "Changed code floors the requested transfer.", assumptions: [] },
            suggestionAssessments: { suggestedFix: {
              contractCheck: { status: "established", requirement: "Preserve the caller guarantee." },
              status: "supported", suggestionText: matching ? updatedFix : finding.suggestedFix!,
              rationale: "Preserves the caller minimum.", evidence: [{ path: "caller.ts", lines: "10-12", whyRelevant: "Rejects amounts below the request." }]
            } }
          };
        }),
        promptBuilder: createPromptBuilder(fakeLensRegistry()), lensRegistry: fakeLensRegistry(), diff: fixture.diff
      }
    );
    expect(calls).toBe(1);
    expect(result.verified).toHaveLength(1);
    expect(result.verified[0]).toMatchObject({ suggestedFix: updatedFix, proofAssessment: { status: "established" }, suggestionAssessments: {
      suggestedFix: { status: matching ? "supported" : "unverified", suggestionText: updatedFix },
      suggestedTest: { status: "unverified", suggestionText: finding.suggestedTest }
    } });
    expect(result.verified[0]?.originalSuggestions).toEqual({ suggestedFix: {
      status: "unverified", suggestionText: finding.suggestedFix,
      rationale: "Behavioral requirement compatibility was not assessed.", evidence: []
    } });
    expect(finding).not.toHaveProperty("originalSuggestions");
    expect(result.verdicts[0]?.suggestionAssessments).toEqual(result.verified[0]?.suggestionAssessments);
    expect(telemetry.events).toContainEqual(expect.objectContaining({ message: "verification_suggestion_assessments" }));
  });

  it.each([
    { field: "suggestedTest" as const, category: "correctness" as const,
      proposal: "Assert reported retention is at least 7 days and no greater than configured retention.",
      replacement: "For a requested retention of 30 days, require reported retention of at least 30 days and storage capable of retaining it; accept either valid storage strategy.",
      requirement: "The caller's requested retention is a minimum, not a best-effort target.",
      rationale: "The invented 7-day tolerance rejects zero but accepts a 29-day report for a 30-day request. The replacement rejects that specific weaker remedy without constraining storage strategy." },
    { field: "suggestedFix" as const, category: "testing" as const,
      proposal: "Add tests requiring owner reads to succeed and unauthenticated reads to fail.",
      replacement: "Add tests that owners and authorized delegates can read while unauthenticated callers cannot; accept either supported permission backend.",
      requirement: "Both owners and authorized delegates retain read access.",
      rationale: "Owner success rejects deny-everyone, but the proposed test still passes if all delegates are denied. The replacement exercises the delegate trigger and rejects that weaker remedy while accepting either backend." }
  ].flatMap(example => [true, false].map(revised => ({ ...example, revised }))))("checks supplied specific weakening assessments for $field, revised=$revised", async example => {
    // These are supplied judgments; this test does not measure live semantic accuracy.
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("specific-counterexample", packet, { category: example.category, [example.field]: example.proposal });
    let calls = 0;
    const result = await verifyFindings({ packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
      fakeTools(), config(), nullTelemetry(), {
        runner: verifierRunner(() => {
          calls++;
          return { verdict: example.revised ? "revise" : "keep", reason: "The defect remains proven; assess its advice separately.",
            requiredEvidencePresent: true, falsePositiveRisk: "low",
            proofAssessment: { status: "established", evidence: "The complete changed branch fails the caller's established requirement.", assumptions: [] },
            ...(example.revised ? { findingUpdates: { [example.field]: example.replacement } } : {}),
            suggestionAssessments: { [example.field]: {
              status: example.revised ? "supported" : "incompatible", suggestionText: example.revised ? example.replacement : example.proposal,
              rationale: example.rationale, contractCheck: { status: "established", requirement: example.requirement },
              evidence: [{ path: "caller-contract.ts", lines: "The caller supplies the required behavior.", whyRelevant: example.requirement }]
            } } };
        }), promptBuilder: createPromptBuilder(fakeLensRegistry()), lensRegistry: fakeLensRegistry(), diff: fixture.diff
      });
    expect(calls).toBe(1);
    expect(result.incompleteCount).toBe(0);
    const verified = result.verified[0]!;
    expect(verified.suggestionAssessments![example.field]!.status).toBe(example.revised ? "supported" : "incompatible");
    const body = renderRetainedComposition([verified]);
    const primary = body.split("\n\n<details>")[0]!;
    expect(primary).not.toContain(example.proposal);
    if (example.revised) {
      expect(primary).toContain(example.replacement);
      expect(verified.originalSuggestions?.[example.field]?.suggestionText).toBe(example.proposal);
    }
    expect(body).toContain(example.proposal);
  });

  it.each([true, false])("preserves the defect and supported fix when a weak test is revised or withheld (revised=%s)", async revised => {
    // Scripted assessments exercise propagation and publication, not model judgment.
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("test-contract", packet, {
      suggestedFix: "Check current membership before returning a private document.",
      suggestedTest: "Revoke membership and assert a subsequent read is denied."
    });
    const requirement = "Active members can read; revoked members cannot read private documents.";
    const evidence = [{ path: "access-policy.ts", lines: "10-14", whyRelevant: requirement }];
    const replacement = "Assert an active member can read the document, then revoke membership and assert no document is disclosed; either permitted denial transport is acceptable.";
    let calls = 0;
    const result = await verifyFindings(
      { packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
      fakeTools(), config(), nullTelemetry(), {
        runner: verifierRunner(() => {
          calls++;
          return {
            verdict: revised ? "revise" : "keep", reason: "The defect is proven; denial alone also passes a deny-everyone workaround.",
            requiredEvidencePresent: true, falsePositiveRisk: "low",
            ...(revised ? { findingUpdates: { suggestedTest: replacement } } : {}),
            proofAssessment: { status: "established", evidence: "The cached read bypasses current membership checks.", assumptions: [] },
            suggestionAssessments: {
              suggestedFix: { status: "supported", suggestionText: finding.suggestedFix!,
                rationale: "Checks revocation while preserving access for active members.",
                contractCheck: { status: "established", requirement }, evidence },
              suggestedTest: { status: revised ? "supported" : "unverified", suggestionText: revised ? replacement : finding.suggestedTest!,
                rationale: revised
                  ? "Deny-everyone fails the active-member read assertion; both permitted denial transports pass after revocation."
                  : "Deny-everyone passes this denial-only assertion while violating active-member access.",
                contractCheck: { status: "established", requirement }, evidence }
            }
          };
        }),
        promptBuilder: createPromptBuilder(fakeLensRegistry()), lensRegistry: fakeLensRegistry(), diff: fixture.diff
      }
    );
    expect(calls).toBe(1);
    expect(result.incompleteCount).toBe(0);
    expect(result.verified).toHaveLength(1);
    const verified = result.verified[0]!;
    expect(verified.suggestedFix).toBe(finding.suggestedFix);
    expect(verified.suggestionAssessments?.suggestedTest?.status).toBe(revised ? "supported" : "unverified");
    const body = renderRetainedComposition([verified]);
    const primary = body.split("\n\n<details>")[0]!;
    expect(primary).toContain(finding.suggestedFix);
    expect(primary).not.toContain(finding.suggestedTest);
    expect(primary.includes("**Suggested test:**")).toBe(revised);
    if (revised) {
      expect(primary).toContain(replacement);
      expect(verified.originalSuggestions?.suggestedTest?.suggestionText).toBe(finding.suggestedTest);
    }
    expect(body).toContain(finding.suggestedTest);
    expect(finding.suggestedTest).toBe("Revoke membership and assert a subsequent read is denied.");
  });

  it.each([{}, { id: "replacement" }, { confidence: "certain" }, { evidence: {} }, '{"title":"string"}'])(
    "records invalid compact updates as incomplete: %j", async (findingUpdates) => {
      const fixture = reviewFixture(["src/app.ts"]);
      const packet = fixture.packets[0]!;
      const finding = candidate("invalid-update", packet);
      const result = await verifyFindings(
        { packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
        fakeTools(), config(), captureTelemetry().recorder,
        {
          runner: verifierRunner(() => ({
            verdict: "revise", reason: "Update", requiredEvidencePresent: true,
            falsePositiveRisk: "low", findingUpdates
          })),
          promptBuilder: createPromptBuilder(fakeLensRegistry()),
          lensRegistry: fakeLensRegistry(), diff: fixture.diff
        }
      );
      expect(result.verified).toEqual([]);
      expect(result.verdicts[0]).toMatchObject({ verdict: "incomplete", verificationIncomplete: true });
    }
  );

  it("leaves a bare keep unchanged", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("bare-keep", packet);
    const telemetry = captureTelemetry();

    const result = await verifyFindings(
      { packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: verifierRunner(() => ({
          verdict: "keep",
          reason: "The candidate is publishable unchanged.",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low"
        })),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    expect(result.verdicts[0]?.verdict).toBe("keep");
    expect(result.verdicts[0]?.severityRevision).toBeUndefined();
    expect(result.verified[0]?.title).toBe(finding.title);
    expect(telemetry.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "verification_keep_payload_canonicalized" }),
      expect.objectContaining({ message: "verification_severity_revision" })
    ]));
    expect(telemetry.events).toContainEqual(expect.objectContaining({
      message: "verification_primary_submit_accepted",
      data: {
        candidateId: finding.id,
        submitTool: "submit_verdict",
        schemaVersion: SCHEMA_VERSIONS.submit_verdict,
        argumentsNonEmpty: true,
        schemaRepairUsed: false
      }
    }));
  });

  it("treats null keep payloads from a non-validating adapter as absent", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("null-keep-payloads", packet);
    const telemetry = captureTelemetry();

    const result = await verifyFindings(
      { packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: verifierRunner(() => ({
          verdict: "keep",
          reason: "The unchanged candidate is supported.",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low",
          finalFinding: null,
          revisedAnchor: null
        })),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    expect(result.verdicts[0]).toMatchObject({ verdict: "keep" });
    expect(result.verified).toEqual([finding]);
    expect(telemetry.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "verification_keep_payload_canonicalized" }),
      expect.objectContaining({ message: "verification_semantic_invalid" })
    ]));
  });

  it("persists an empty revise from a non-validating adapter as incomplete", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("empty-revise-defense", packet);
    const telemetry = captureTelemetry();

    const result = await verifyFindings(
      { packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: verifierRunner(() => ({
          verdict: "revise",
          reason: "Changed only in prose.",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low"
        })),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    expect(result.verified).toEqual([]);
    expect(result.incompleteCount).toBe(1);
    expect(result.verdicts[0]).toMatchObject({
      verdict: "incomplete",
      verificationIncomplete: true,
      reason: "verification incomplete: revise_without_revision_payload"
    });
    expect(telemetry.events).toContainEqual(expect.objectContaining({
      message: "verification_semantic_invalid",
      data: { candidateId: finding.id, reason: "revise_without_revision_payload" }
    }));
    expect(telemetry.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "verification_primary_submit_accepted" })
    ]));
  });

  it("treats null revise payloads from a non-validating adapter as empty", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("null-revise-payloads", packet);
    const telemetry = captureTelemetry();

    const result = await verifyFindings(
      { packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: verifierRunner(() => ({
          verdict: "revise",
          reason: "No structured revision was actually supplied.",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low",
          finalFinding: null,
          revisedAnchor: null
        })),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    expect(result.verified).toEqual([]);
    expect(result.verdicts[0]).toMatchObject({
      verdict: "incomplete",
      verificationIncomplete: true,
      reason: "verification incomplete: revise_without_revision_payload"
    });
    expect(telemetry.events).toContainEqual(expect.objectContaining({
      message: "verification_semantic_invalid",
      data: { candidateId: finding.id, reason: "revise_without_revision_payload" }
    }));
  });
});

describe("plan 108 verifier severity revision observability", () => {
  const cases = [
    { name: "decrease", original: "high", submitted: "medium", applied: "medium", deltaLevels: -1, level: "debug" },
    { name: "unchanged", original: "medium", submitted: "medium", applied: "medium", deltaLevels: 0, level: "debug" },
    { name: "one-level increase", original: "low", submitted: "medium", applied: "medium", deltaLevels: 1, level: "debug" },
    { name: "two-level increase", original: "low", submitted: "high", applied: "high", deltaLevels: 2, level: "info" },
    {
      name: "behavior-change cap",
      original: "medium",
      submitted: "high",
      applied: "medium",
      deltaLevels: 1,
      level: "debug",
      behaviorChange: "intentional_needs_confirmation"
    }
  ] as const;

  for (const testCase of cases) {
    it(`persists and emits a ${testCase.name}`, async () => {
      const fixture = reviewFixture(["src/severity.ts"]);
      const packet = fixture.packets[0]!;
      const finding = candidate(`severity-${testCase.name.replaceAll(" ", "-")}`, packet, {
        severity: testCase.original
      });
      const telemetry = captureTelemetry();

      const result = await verifyFindings(
        { packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
        fakeTools(),
        config(),
        telemetry.recorder,
        {
          runner: verifierRunner(() => ({
            verdict: "revise",
            reason: "The issue is real with calibrated impact.",
            requiredEvidencePresent: true,
            falsePositiveRisk: "low",
            ...("behaviorChange" in testCase ? { behaviorChange: testCase.behaviorChange } : {}),
            finalFinding: {
              title: "Calibrated severity finding",
              severity: testCase.submitted,
              confidence: "high",
              path: packet.path,
              category: "correctness",
              evidence: { changedCode: "+ return route(provider);" },
              failureMode: finding.failureMode,
              whyThisMatters: finding.whyThisMatters,
              verification: "The concrete impact is bounded to callers of this changed route."
            }
          })),
          promptBuilder: createPromptBuilder(fakeLensRegistry()),
          lensRegistry: fakeLensRegistry(),
          diff: fixture.diff
        }
      );

      const expectedRevision = {
        original: testCase.original,
        submitted: testCase.submitted,
        applied: testCase.applied,
        deltaLevels: testCase.deltaLevels
      };
      expect(result.verdicts[0]?.severityRevision).toEqual(expectedRevision);
      expect(result.verified[0]?.severity).toBe(testCase.applied);
      expect(telemetry.events).toContainEqual(expect.objectContaining({
        stage: 9,
        level: testCase.level,
        message: "verification_severity_revision",
        data: expect.objectContaining({
          candidateId: finding.id,
          category: "correctness",
          ...expectedRevision,
          ...("behaviorChange" in testCase ? { behaviorChange: testCase.behaviorChange } : {})
        })
      }));

      const records = telemetry.artifacts.get("verification.json") as EvalVerificationRecord[];
      expect(records[0]).toMatchObject({
        candidateId: finding.id,
        verdict: { severityRevision: expectedRevision }
      });
      if ("behaviorChange" in testCase) {
        expect(result.verified[0]).toMatchObject({
          behaviorChange: "intentional_needs_confirmation",
          severity: "medium",
          severityBeforeCap: "high"
        });
      } else {
        expect(result.verified[0]?.severityBeforeCap).toBeUndefined();
      }
    });
  }

  it("does not record severity revision telemetry for reject compatibility payloads", async () => {
    const fixture = reviewFixture(["src/severity.ts"]);
    const packet = fixture.packets[0]!;
    const finding = candidate("reject-severity-payload", packet, { severity: "low" });
    const telemetry = captureTelemetry();

    const result = await verifyFindings(
      { packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: verifierRunner(() => ({
          verdict: "reject",
          reason: "The candidate is unsupported despite the compatibility payload.",
          requiredEvidencePresent: false,
          falsePositiveRisk: "high",
          finalFinding: {
            title: "Rejected compatibility payload",
            severity: "high",
            confidence: "medium",
            path: packet.path,
            category: "correctness",
            evidence: { changedCode: "+ return route(provider);" },
            failureMode: finding.failureMode,
            whyThisMatters: finding.whyThisMatters,
            verification: "The decisive predicate was not confirmed."
          }
        })),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    expect(result.verified).toEqual([]);
    expect(result.verdicts[0]).toMatchObject({ verdict: "reject" });
    expect(result.verdicts[0]?.severityRevision).toBeUndefined();
    expect(telemetry.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "verification_severity_revision" })
    ]));
    const records = telemetry.artifacts.get("verification.json") as EvalVerificationRecord[];
    expect(records[0]).toMatchObject({ candidateId: finding.id, verdict: { verdict: "reject" } });
    expect((records[0] as Extract<EvalVerificationRecord, { verdict: unknown }>).verdict).not.toHaveProperty("severityRevision");
  });
});

describe("plan 107 related promotion signal handoff", () => {
  it("keeps related signals inside candidate provenance without changing verifier resources or primary provenance", async () => {
    const fixture = reviewFixture(["src/amount.ts"]);
    const packet = fixture.packets[0]!;
    const primaryQuestion = "Verify whether scaleExactOutput now truncates the exact output amount.";
    const relatedQuestion = "Confirm whether the exact output amount can under-deliver the caller contract.";
    const finding = candidate("related-signal-handoff", packet, {
      producedBy: {
        kind: "packet",
        stage: 9,
        packetId: packet.id,
        lensId: "shared/review",
        skillIds: ["projection/neutral"]
      },
      provenance: {
        source: "uncertainty_promotion",
        sourceKind: "follow_up_hint",
        sourcePacketId: packet.id,
        question: primaryQuestion,
        files: [packet.path],
        symbols: ["scaleExactOutput"],
        reason: "Primary promoted predicate.",
        relatedSignals: [{
          packetId: "packet-related",
          sourceKind: "follow_up_hint",
          question: relatedQuestion,
          files: [packet.path],
          symbols: ["scaleExactOutput"]
        }],
        crossPacketRelatedCount: 1
      }
    });
    const registry = registryWithSkills([projectionSkill("neutral", [], "RELATED_SIGNAL_SKILL_MARKER")]);
    let request: LlmStructuredRequest<unknown> | undefined;

    await verifyFindings(
      { packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
      fakeTools(),
      config(),
      captureTelemetry().recorder,
      {
        runner: {
          runStructured: async <T>(input: LlmStructuredRequest<T>) => {
            request = input;
            return {
              verdict: "keep",
              reason: "The primary predicate is confirmed unchanged.",
              requiredEvidencePresent: true,
              falsePositiveRisk: "low"
            } as T;
          }
        },
        promptBuilder: createPromptBuilder(registry),
        lensRegistry: registry,
        diff: fixture.diff
      }
    );

    expect(request?.toolBudget).toEqual({
      maxToolCalls: 8,
      maxInvestigationRounds: 3,
      maxResultChars: 32_000,
      maxSingleToolResultChars: 6_000,
      maxDiscoveryResultChars: 4_000,
      reservedSourceResultChars: 4_000,
    });
    expect(request?.prompt).toContain("RELATED_SIGNAL_SKILL_MARKER");
    expect(request?.prompt).toContain(`\"question\": \"${primaryQuestion}\"`);
    expect(request?.prompt).toContain("\"relatedSignals\"");
    expect(request?.prompt).toContain("\"crossPacketRelatedCount\": 1");
    expect(request?.prompt?.split(relatedQuestion)).toHaveLength(2);
    const candidateBlock = /untrusted-data label=candidate-finding\n(?<body>[\s\S]*?)\n`{4,}/u.exec(request?.prompt ?? "")?.groups?.body;
    expect(candidateBlock).toContain(relatedQuestion);
    expect(candidateBlock).toContain(primaryQuestion);
  });
});

describe("plan 76 anchor reconstruction", () => {
  it("tier 1: reconstructs a precise anchor from quoted changed code with whitespace variance", () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const anchor = inferAnchorFromChangedCode(packet, "   2    2  +   return route(provider);");
    expect(anchor).toEqual({ path: packet.path, line: 2, side: "RIGHT", hunkId: packet.hunks[0]!.hunkId });
  });

  it("tier 1: refuses truncated substring quotes", () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    expect(inferAnchorFromChangedCode(packet, "return route(provider)")).toBeUndefined();
  });

  it("tier 1: strips line-number columns quoted from contentWithLineNumbers", () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    expect(inferAnchorFromChangedCode(packet, "   2    2  return route(provider);")?.line).toBe(2);
  });

  it("tier 1: refuses ambiguous snippets that match multiple changed lines", () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const base = fixture.packets[0]!;
    const hunk = base.hunks[0]!;
    const packet = {
      ...base,
      hunks: [{
        ...hunk,
        lines: [...hunk.lines, { kind: "add" as const, content: "return route(provider);", newLine: 5 }],
        changedNewLineNumbers: [2, 5]
      }]
    };
    expect(inferAnchorFromChangedCode(packet, "+ return route(provider);")).toBeUndefined();
  });

  it("tier 1: fails cleanly on trivial-only snippets", () => {
    const fixture = reviewFixture(["src/app.ts"]);
    expect(inferAnchorFromChangedCode(fixture.packets[0]!, "}")).toBeUndefined();
  });

  it("tier 1: matches deleted lines on the LEFT side", () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const base = fixture.packets[0]!;
    const hunk = base.hunks[0]!;
    const packet = {
      ...base,
      hunks: [{
        ...hunk,
        lines: [{ kind: "delete" as const, content: "return previous(provider);", oldLine: 2 }],
        changedNewLineNumbers: [],
        changedOldLineNumbers: [2]
      }]
    };
    const anchor = inferAnchorFromChangedCode(packet, "```diff\n- return previous(provider);\n```");
    expect(anchor).toEqual({ path: packet.path, line: 2, side: "LEFT", hunkId: hunk.hunkId });
  });

  it("does not conflate internal literal whitespace, unary operators, or contradictory quote locations", () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const file = fixture.diff.files[0]!;
    const hunk = file.hunks[0]!;
    const diff: UnifiedDiff = { files: [{ ...file, hunks: [{ ...hunk, lines: [
      { kind: "add", content: 'return "a  b";', newLineNumber: 2 },
      { kind: "add", content: '-longVariable;', newLineNumber: 3 }
    ] }] }] };
    expect(inferAnchorFromChangedCode(diff, 'return "a b";')).toBeUndefined();
    expect(inferAnchorFromChangedCode(diff, 'longVariable;')).toBeUndefined();
    expect(inferAnchorFromChangedCode(diff, '```diff\n+ -longVariable;\n```')?.line).toBe(3);
    const other = { ...file, path: "src/other.ts", hunks: [{ ...hunk, lines: [{ kind: "add" as const, content: 'return elsewhere();', newLineNumber: 2 }] }] };
    diff.files.push(other);
    expect(inferAnchorFromChangedCode(diff, 'return "a  b";\nreturn elsewhere();')).toBeUndefined();
    other.hunks[0]!.lines[0]!.content = 'return "a  b";';
    expect(inferAnchorFromChangedCode(diff, 'return "a  b";')).toBeUndefined();
  });

  it("preserves bare unary plus/minus and strips prefixes only in explicit diff notation", () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const diff = fixture.diff;
    diff.files[0]!.hunks[0]!.lines = [{ kind: "add", content: "charge(amount);", newLineNumber: 2 }];
    expect(inferAnchorFromChangedCode(diff, "-charge(amount);")).toBeUndefined();
    expect(inferAnchorFromChangedCode(diff, "+charge(amount);")).toBeUndefined();
    expect(inferAnchorFromChangedCode(diff, "- charge(amount);")).toBeUndefined();
    expect(inferAnchorFromChangedCode(diff, "```diff\n-charge(amount);\n```")).toBeUndefined();
    expect(inferAnchorFromChangedCode(diff, "2    2  +charge(amount);")?.line).toBe(2);
    expect(inferAnchorFromChangedCode(diff, "```diff\n+charge(amount);\n```")?.line).toBe(2);
    expect(inferAnchorFromChangedCode(diff, "@@ -1 +1 @@\n+charge(amount);")?.line).toBe(2);
  });

  it.each(["+", "-"] as const)("explicit %s diff markers are never alternative source operators", (prefix) => {
    const fixture = reviewFixture(["src/app.ts"]);
    const diff = fixture.diff;
    diff.files[0]!.hunks[0]!.lines = [{ kind: prefix === "+" ? "add" : "delete", content: `${prefix}charge(amount);`, oldLineNumber: 2, newLineNumber: 2 }];
    for (const format of [(text: string) => `\`\`\`diff\n${text}\n\`\`\``, (text: string) => `2    2  ${text}`]) {
      expect(inferAnchorFromChangedCode(diff, format(`${prefix}charge(amount);`))).toBeUndefined();
      expect(inferAnchorFromChangedCode(diff, format(`${prefix}${prefix}charge(amount);`))).toMatchObject({ line: 2, side: prefix === "+" ? "RIGHT" : "LEFT" });
    }
    expect(inferAnchorFromChangedCode(diff, `${prefix}charge(amount);`)).toMatchObject({ line: 2, side: prefix === "+" ? "RIGHT" : "LEFT" });
  });

  it("tier 2: representative anchor prefers the first RIGHT changed line", () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    expect(representativeAnchorFromPacket(packet)).toEqual({ path: packet.path, line: 2, side: "RIGHT", hunkId: packet.hunks[0]!.hunkId });
  });

  it("tier 2: falls back to LEFT for deletion-only packets and undefined when nothing changed", () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const base = fixture.packets[0]!;
    const hunk = base.hunks[0]!;
    const deletionOnly = {
      ...base,
      hunks: [{ ...hunk, changedNewLineNumbers: [], changedOldLineNumbers: [2] }]
    };
    expect(representativeAnchorFromPacket(deletionOnly)).toEqual({ path: base.path, line: 2, side: "LEFT", hunkId: hunk.hunkId });
    const unchanged = { ...base, hunks: [{ ...hunk, changedNewLineNumbers: [], changedOldLineNumbers: [] }] };
    expect(representativeAnchorFromPacket(unchanged)).toBeUndefined();
  });

  it("verifies anchorless evidence-backed low-confidence candidates without inventing coordinates", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const { anchor: _anchor, ...anchorless } = candidate("run36-shape", packet, {
      confidence: "low",
      severity: "low",
      category: "correctness",
      evidence: {
        changedCode: "quotes.AmountFromUSD hard-errors on a zero-decimal origin token",
        relatedCode: [{
          path: "src/pricing.ts",
          lines: "17: DecimalsFactor(0) previously returned 1",
          whyRelevant: "The prior behavior accepted zero-decimal tokens."
        }]
      },
      failureMode: "Zero-decimal origin tokens now hard-error where the previous code path succeeded."
    });
    const finding = { ...anchorless, changedLine: false, modelAnchorSubmitted: false };
    const telemetry = captureTelemetry();
    let calls = 0;

    const result = await verifyFindings(
      { packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: verifierRunner(() => {
          calls += 1;
          return {
            verdict: "keep",
            reason: "The regression is confirmed against the changed code.",
            requiredEvidencePresent: true,
            falsePositiveRisk: "low"
          };
        }),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    expect(calls).toBe(1);
    expect(result.verified[0]?.id).toBe("run36-shape");
    expect(result.verified[0]?.anchor).toBeUndefined();
    expect(telemetry.artifacts.get("verification.json")).toEqual([
      expect.objectContaining({
        candidateId: "run36-shape",
        gateReason: "low_confidence_evidence_backed",
        gateFacts: expect.objectContaining({
          modelAnchorSubmitted: false,
          validAnchorPresent: false
        })
      })
    ]);
    expect(telemetry.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 9, message: "anchor_representative", data: expect.objectContaining({ candidateId: "run36-shape" }) })
    ]));
  });

  it("does not rescue a low-confidence candidate with no quoted changed code", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const { anchor: _anchor, ...anchorless } = candidate("no-evidence", packet, {
      confidence: "low",
      severity: "low",
      category: "correctness",
      evidence: { changedCode: "  " }
    });
    const finding = { ...anchorless, changedLine: false };
    const telemetry = captureTelemetry();
    let calls = 0;

    const result = await verifyFindings(
      { packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
      fakeTools(),
      config(),
      telemetry.recorder,
      {
        runner: verifierRunner(() => {
          calls += 1;
          return { verdict: "keep", reason: "should not run", requiredEvidencePresent: true, falsePositiveRisk: "low" };
        }),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    expect(calls).toBe(0);
    expect(result.verified).toEqual([]);
    expect(telemetry.artifacts.get("verification.json")).toEqual([
      expect.objectContaining({ candidateId: "no-evidence", gate: "suppressed", gateReason: "missing_evidence" })
    ]);
    expect(telemetry.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "anchor_representative" })
    ]));
  });

  it("marks verifier-revised anchors with verifier_revised provenance", async () => {
    const fixture = reviewFixture(["src/app.ts"]);
    const packet = fixture.packets[0]!;
    const hunk = packet.hunks[0]!;
    const finding = candidate("revise-anchor", packet, { confidence: "high" });

    const result = await verifyFindings(
      { packetResults: [packetResult(packet.id, [finding])], packets: fixture.packets },
      fakeTools(),
      config(),
      captureTelemetry().recorder,
      {
        runner: verifierRunner(() => ({
          verdict: "revise",
          reason: "Confirmed; anchor refined to the changed line.",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low",
          revisedAnchor: { path: packet.path, line: 2, side: "RIGHT", hunkId: hunk.hunkId }
        })),
        promptBuilder: createPromptBuilder(fakeLensRegistry()),
        lensRegistry: fakeLensRegistry(),
        diff: fixture.diff
      }
    );

    expect(result.verified[0]?.anchorSource).toBe("verifier_revised");
  });
});
