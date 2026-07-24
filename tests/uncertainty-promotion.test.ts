import { describe, expect, it } from "vitest";
import { promoteUncertaintiesForVerification } from "../src/pipeline/uncertainty-promotion.js";
import type { PacketReviewResult, ReviewPacket } from "../src/types.js";
import type { TelemetryRecorder } from "../src/telemetry/telemetry-recorder.js";

describe("uncertainty promotion", () => {
  it("promotes concrete changed-test coverage uncertainty into a verifier candidate", async () => {
    const packet = fakePacket("packet-coverage", "tests/billing.test.ts", {
      symbol: "TestBillingRetries",
      line: "+ expect(fetchBalance()).toEqual(0)"
    });
    const telemetry = captureTelemetry();

    const result = await promoteUncertaintiesForVerification({
      packets: [packet],
      packetResults: [{
        packetId: packet.id,
        lenses: ["core/tests"],
        findings: [],
        followUpHints: [],
        uncertainties: [{
          question: "Verify deleted coverage still exercises BalanceReader through the production billing path",
          files: ["tests/billing.test.ts", "src/billing.ts"],
          symbols: ["BalanceReader"],
          projectedSkillIds: ["core/tests"]
        }],
        status: "completed"
      }]
    }, telemetry.recorder);

    expect(result.summary).toMatchObject({
      considered: 1,
      promoted: 1,
      laneLimited: 0,
      promotedCandidateIds: [expect.stringMatching(/^packet-c-u1-/u)]
    });
    const promoted = result.packetResults[0]?.findings[0];
    // Plan 81: no fabricated anchors — the promoted candidate is anchorless
    // (plan 76's gate-only representative anchor proves on-diff-ness later)
    // and its title is the hint's own predicate, not a template.
    expect(promoted).toMatchObject({
      category: "testing",
      confidence: "medium",
      changedLine: false,
      modelAnchorSubmitted: false,
      producedBy: { stage: 9, packetId: packet.id, lensId: "core/tests", skillIds: ["core/tests"] },
      provenance: {
        source: "uncertainty_promotion",
        sourceKind: "uncertainty",
        sourcePacketId: packet.id,
        files: ["src/billing.ts", "tests/billing.test.ts"],
        symbols: ["BalanceReader"]
      }
    });
    expect(promoted?.anchor).toBeUndefined();
    expect(promoted?.title).toBe("Verify deleted coverage still exercises BalanceReader through the production billing path");
    expect(promoted?.evidence.changedCode).toContain("fetchBalance");
    expect(telemetry.artifacts.get("uncertainty-promotion.json")).toMatchObject({
      promoted: 1,
      decisions: [expect.objectContaining({ promoted: true, reason: "promoted_for_verification" })]
    });
    expect(telemetry.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 9,
        message: "uncertainty_promotion",
        data: expect.objectContaining({ considered: 1, promoted: 1 })
      })
    ]));
  });

  it("routes a test-scoped hint with a runtime predicate as correctness", async () => {
    const packet = fakePacket("packet-runtime-predicate", "src/quote.ts", {
      symbol: "buildQuote",
      line: "+ return buildQuoteWithScaledTransfer(request)"
    });

    const result = await promoteUncertaintiesForVerification({
      packets: [packet],
      packetResults: [{
        packetId: packet.id,
        lenses: ["core/code-review"],
        findings: [],
        followUpHints: [{
          question: "Do the added tests cover whether buildQuote still preserves the caller contract?",
          files: ["src/quote.ts", "tests/quote.test.ts"],
          symbols: ["buildQuote", "scaleAmount"],
          suggestedLenses: ["core/tests"],
          reason: "The changed transfer calculation truncates toward zero and could under-report the value promised to callers.",
          confidence: "medium",
          projectedSkillIds: ["lang/typescript", "core/code-review"]
        }],
        uncertainties: [],
        status: "completed"
      }]
    }, captureTelemetry().recorder);

    const promoted = result.packetResults[0]?.findings[0];
    expect(result.summary).toMatchObject({ considered: 1, promoted: 1 });
    expect(promoted).toMatchObject({
      category: "correctness",
      confidence: "low",
      provenance: {
        sourceKind: "follow_up_hint",
        question: "Do the added tests cover whether buildQuote still preserves the caller contract?",
        reason: "The changed transfer calculation truncates toward zero and could under-report the value promised to callers."
      }
    });
    expect(promoted?.failureMode).toContain("truncates toward zero");
    expect(promoted?.failureMode).toContain("under-report");
  });

  it("keeps promotion bounded and explains dropped sources", async () => {
    const packets = Array.from({ length: 6 }, (_value, index) =>
      fakePacket(`packet-${index}`, `src/case-${index}.ts`, {
        symbol: `changed${index}`,
        line: `+ return fallback${index}(value)`
      })
    );
    const packetResults: PacketReviewResult[] = packets.map((packet, index) => ({
      packetId: packet.id,
      lenses: ["core/code-review"],
      findings: [],
      followUpHints: [{
        question: `Verify fallback behavior for changed${index} still preserves caller contract`,
        files: [packet.path],
        symbols: [`changed${index}`],
        suggestedLenses: ["core/code-review"],
        reason: "The changed fallback path may alter caller-visible behavior.",
        confidence: "high",
        projectedSkillIds: ["core/code-review"]
      }],
      uncertainties: index === 0
        ? [{ question: "Check this maybe", files: [], symbols: [], projectedSkillIds: ["core/code-review"] }]
        : [],
      status: "completed"
    }));
    const telemetry = captureTelemetry();

    const result = await promoteUncertaintiesForVerification({ packets, packetResults }, telemetry.recorder);

    expect(result.summary.considered).toBe(7);
    expect(result.summary.promoted).toBe(2);
    expect(result.summary.laneLimited).toBe(4);
    expect(result.summary.notPromoted).toMatchObject({ no_concrete_file_or_symbol: 1 });
    expect(result.packetResults.flatMap((item) => item.findings)).toHaveLength(2);
    expect(result.summary.decisions.filter((decision) => decision.reason === "promotion_lane_limited")).toHaveLength(4);
  });

  it("does not promote same-scope follow-ups when the packet already produced a finding", async () => {
    const packet = fakePacket("packet-existing", "src/divide.ts", {
      symbol: "divide",
      line: "+ return total / count"
    });
    const result = await promoteUncertaintiesForVerification({
      packets: [packet],
      packetResults: [{
        packetId: packet.id,
        lenses: ["core/code-review"],
        findings: [{
          id: "existing",
          title: "Division guard removed",
          severity: "high",
          confidence: "high",
          path: packet.path,
          anchor: { path: packet.path, line: 2, side: "RIGHT", hunkId: "h1" },
          changedLine: true,
          category: "correctness",
          evidence: { changedCode: "+ return total / count" },
          failureMode: "Calling divide with count zero now returns an invalid numeric result.",
          whyThisMatters: "Callers can propagate invalid values.",
          verification: "The changed hunk removes the guard.",
          producedBy: { kind: "packet", stage: 7, packetId: packet.id, lensId: "core/code-review", skillIds: [] }
        }],
        followUpHints: [{
          question: "Check whether callers can pass zero count.",
          files: ["src/divide.ts"],
          symbols: ["divide"],
          suggestedLenses: ["core/code-review"],
          reason: "The changed function now divides by count directly.",
          confidence: "medium",
          projectedSkillIds: ["core/code-review"]
        }],
        uncertainties: [],
        status: "completed"
      }]
    }, captureTelemetry().recorder);

    expect(result.packetResults[0]?.findings).toHaveLength(1);
    expect(result.summary).toMatchObject({
      considered: 1,
      promoted: 0,
      notPromoted: { covered_by_existing_candidate: 1 }
    });
  });

  it("does not promote broad follow-ups without a concrete failure predicate", async () => {
    const packet = fakePacket("packet-broad", "src/charge.ts", {
      symbol: "charge",
      line: "+ return calculateCharge(input)"
    });
    const result = await promoteUncertaintiesForVerification({
      packets: [packet],
      packetResults: [{
        packetId: packet.id,
        lenses: ["core/code-review"],
        findings: [],
        followUpHints: [{
          question: "Verify this looks safe overall.",
          files: [packet.path],
          symbols: ["charge"],
          suggestedLenses: ["core/code-review"],
          reason: "General safety concern without a concrete failure mode.",
          confidence: "high",
          projectedSkillIds: ["core/code-review"]
        }],
        uncertainties: [],
        status: "completed"
      }]
    }, captureTelemetry().recorder);

    expect(result.packetResults[0]?.findings).toEqual([]);
    expect(result.summary).toMatchObject({
      considered: 1,
      promoted: 0,
      notPromoted: { broad_follow_up_only: 1 }
    });
  });

  it("promotes low-confidence concrete behavior-delta hints for verifier adjudication", async () => {
    const packet = fakePacket("packet-refactor", "src/routing.ts", {
      symbol: "routeWithFallback",
      line: "+ return routeStrictFallback(request)"
    });
    packet.intentSignals = {
      refactorLike: true,
      behaviorChangeLike: false,
      explicitlyBehaviorPreserving: true,
      signals: [],
      summary: "refactor-like behavior-preserving change"
    };

    const result = await promoteUncertaintiesForVerification({
      packets: [packet],
      packetResults: [{
        packetId: packet.id,
        lenses: ["core/code-review"],
        findings: [],
        followUpHints: [{
          question: "Verify whether routeWithFallback now rejects explicit fallback requests that previously used the default provider.",
          files: ["src/routing.ts"],
          symbols: ["routeWithFallback"],
          suggestedLenses: ["core/code-review"],
          reason: "This behavior-preserving refactor changes a fallback contract boundary.",
          confidence: "low",
          projectedSkillIds: ["core/code-review"]
        }],
        uncertainties: [],
        status: "completed"
      }]
    }, captureTelemetry().recorder);

    expect(result.summary).toMatchObject({
      considered: 1,
      promoted: 1,
      notPromoted: {}
    });
    expect(result.packetResults[0]?.findings[0]).toMatchObject({
      category: "correctness",
      provenance: {
        sourceKind: "follow_up_hint",
        sourcePacketId: packet.id
      }
    });
  });

  it("still suppresses low-confidence broad hints that lack a behavior-delta predicate", async () => {
    const packet = fakePacket("packet-low-broad", "src/routing.ts", {
      symbol: "route",
      line: "+ return route(request)"
    });

    const result = await promoteUncertaintiesForVerification({
      packets: [packet],
      packetResults: [{
        packetId: packet.id,
        lenses: ["core/code-review"],
        findings: [],
        followUpHints: [{
          question: "Check whether this routing change is okay.",
          files: ["src/routing.ts"],
          symbols: ["route"],
          suggestedLenses: ["core/code-review"],
          reason: "General low-confidence concern.",
          confidence: "low",
          projectedSkillIds: ["core/code-review"]
        }],
        uncertainties: [],
        status: "completed"
      }]
    }, captureTelemetry().recorder);

    expect(result.packetResults[0]?.findings).toEqual([]);
    expect(result.summary).toMatchObject({
      considered: 1,
      promoted: 0,
      notPromoted: { low_confidence_hint: 1 }
    });
  });

  it("reserves a promotion lane for concrete behavior deltas", async () => {
    const packets = Array.from({ length: 6 }, (_value, index) =>
      fakePacket(`packet-lane-${index}`, `src/case-${index}.ts`, {
        symbol: `changed${index}`,
        line: `+ return changed${index}(value)`
      })
    );
    packets[5]!.intentSignals = {
      refactorLike: true,
      behaviorChangeLike: false,
      explicitlyBehaviorPreserving: true,
      signals: [],
      summary: "refactor-like behavior-preserving change"
    };
    const packetResults: PacketReviewResult[] = packets.map((packet, index) => ({
      packetId: packet.id,
      lenses: ["core/code-review"],
      findings: [],
      followUpHints: [{
        question: index === 5
          ? "Verify whether changed5 now rejects zero values that previously used the default fallback."
          : `Verify whether changed${index} allows tenant access when the token is missing.`,
        files: [packet.path],
        symbols: [`changed${index}`],
        suggestedLenses: ["core/code-review"],
        reason: index === 5
          ? "This behavior-preserving refactor changes a fallback boundary."
          : "The authorization path can affect production callers.",
        confidence: index === 5 ? "low" : "high",
        projectedSkillIds: ["core/code-review"]
      }],
      uncertainties: [],
      status: "completed"
    }));

    const result = await promoteUncertaintiesForVerification({ packets, packetResults }, captureTelemetry().recorder);

    expect(result.summary.promoted).toBe(2);
    expect(result.summary.laneLimited).toBe(4);
    expect(result.packetResults.find((item) => item.packetId === "packet-lane-5")?.findings).toHaveLength(1);
  });

  it("prioritizes local behavior deltas over broad behavior deltas when the lane is saturated", async () => {
    const localPacket = fakePacket("packet-local-delta", "src/billing/fees.ts", {
      symbol: "computeFees",
      line: "+ return convertFromUsdStrict(value)"
    });
    localPacket.intentSignals = {
      refactorLike: true,
      behaviorChangeLike: false,
      explicitlyBehaviorPreserving: true,
      signals: [],
      summary: "behavior-preserving helper replacement"
    };
    const securityPackets = [0, 1].map((index) =>
      fakePacket(`packet-security-${index}`, `src/security/check-${index}.ts`, {
        symbol: `authorizeTenant${index}`,
        line: `+ return authorizeTenant${index}(request, token)`
      })
    );
    const telemetry = captureTelemetry();

    const result = await promoteUncertaintiesForVerification({
      packets: [localPacket, ...securityPackets],
      packetResults: [
        {
          packetId: localPacket.id,
          lenses: ["core/code-review"],
          findings: [],
          followUpHints: [
            {
              question: "Verify whether convertFromUsdStrict now fails for a concrete edge input that the old computeFees conversion accepted.",
              files: ["src/billing/fees.ts"],
              symbols: ["computeFees", "convertFromUsdStrict"],
              suggestedLenses: ["core/code-review"],
              reason: "The behavior-preserving helper replacement changes a local conversion boundary.",
              confidence: "low",
              projectedSkillIds: ["core/code-review"]
            },
            {
              question: "Verify whether convertFromUsdStrict now fails for value after this replacement across all billing modules.",
              files: [
                "src/billing/invoices.ts",
                "src/billing/payments.ts",
                "src/billing/reports.ts",
                "src/billing/subscriptions.ts"
              ],
              symbols: [],
              suggestedLenses: ["core/code-review"],
              reason: "The broader conversion behavior might affect every billing caller after the replacement.",
              confidence: "high",
              projectedSkillIds: ["core/code-review"]
            }
          ],
          uncertainties: [],
          status: "completed"
        },
        ...securityPackets.map((packet, index): PacketReviewResult => ({
          packetId: packet.id,
          lenses: ["domain/security"],
          findings: [],
          followUpHints: [{
            question: `Verify whether authorizeTenant${index} allows tenant access when the token is missing.`,
            files: [packet.path],
            symbols: [`authorizeTenant${index}`],
            suggestedLenses: ["domain/security"],
            reason: "The changed authorization path can affect production access control.",
            confidence: "high",
            projectedSkillIds: ["domain/security"]
          }],
          uncertainties: [],
          status: "completed"
        }))
      ]
    }, telemetry.recorder);

    expect(result.summary.promoted).toBe(2);
    expect(result.packetResults.find((item) => item.packetId === localPacket.id)?.findings).toHaveLength(1);
    const promotedFindings = result.packetResults.flatMap((item) => item.findings);
    expect(promotedFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: localPacket.path,
        producedBy: expect.objectContaining({ skillIds: ["core/code-review"] })
      }),
      expect.objectContaining({
        path: expect.stringMatching(/^src\/security\//u),
        producedBy: expect.objectContaining({ skillIds: ["domain/security"] })
      })
    ]));

    const localDecision = result.summary.decisions.find((decision) =>
      decision.question.includes("old computeFees conversion")
    );
    const broadDecision = result.summary.decisions.find((decision) =>
      decision.question.includes("across all billing modules")
    );
    expect(localDecision).toMatchObject({
      promoted: true,
      reason: "promoted_for_verification",
      promotionClass: "local_behavior_delta",
      selectedBy: "local_behavior_delta_reserve"
    });
    expect(localDecision?.localityScore).toBeGreaterThan(broadDecision?.localityScore ?? 0);
    expect(broadDecision).toMatchObject({
      promoted: false,
      reason: "promotion_lane_limited",
      promotionClass: "broad_behavior_delta",
      rank: expect.any(Number),
      localityScore: expect.any(Number)
    });

    expect(telemetry.artifacts.get("uncertainty-promotion.json")).toMatchObject({
      promoted: 2,
      decisions: expect.arrayContaining([
        expect.objectContaining({
          promotionClass: "local_behavior_delta",
          selectedBy: "local_behavior_delta_reserve"
        }),
        expect.objectContaining({
          promotionClass: "broad_behavior_delta",
          promoted: false,
          reason: "promotion_lane_limited"
        })
      ])
    });
  });

  it("still promotes broad behavior deltas when no local behavior delta exists", async () => {
    const broadPacket = fakePacket("packet-broad-delta", "src/billing/fees.ts", {
      symbol: "computeFees",
      line: "+ return convertFromUsdStrict(value)"
    });
    const securityPackets = [0, 1].map((index) =>
      fakePacket(`packet-broad-security-${index}`, `src/security/check-${index}.ts`, {
        symbol: `authorizeTenant${index}`,
        line: `+ return authorizeTenant${index}(request, token)`
      })
    );

    const result = await promoteUncertaintiesForVerification({
      packets: [broadPacket, ...securityPackets],
      packetResults: [
        {
          packetId: broadPacket.id,
          lenses: ["core/code-review"],
          findings: [],
          followUpHints: [{
            question: "Verify whether convertFromUsdStrict now fails for value after this replacement across all billing modules.",
            files: ["src/billing/invoices.ts", "src/billing/payments.ts", "src/billing/reports.ts"],
            symbols: [],
            suggestedLenses: ["core/code-review"],
            reason: "The broader conversion behavior might affect every billing caller after the helper replacement.",
            confidence: "high",
            projectedSkillIds: ["core/code-review"]
          }],
          uncertainties: [],
          status: "completed"
        },
        ...securityPackets.map((packet, index): PacketReviewResult => ({
          packetId: packet.id,
          lenses: ["domain/security"],
          findings: [],
          followUpHints: [{
            question: `Verify whether authorizeTenant${index} allows tenant access when the token is missing.`,
            files: [packet.path],
            symbols: [`authorizeTenant${index}`],
            suggestedLenses: ["domain/security"],
            reason: "The changed authorization path can affect production access control.",
            confidence: "high",
            projectedSkillIds: ["domain/security"]
          }],
          uncertainties: [],
          status: "completed"
        }))
      ]
    }, captureTelemetry().recorder);

    const broadDecision = result.summary.decisions.find((decision) =>
      decision.question.includes("across all billing modules")
    );
    expect(result.summary.promoted).toBe(2);
    expect(broadDecision).toMatchObject({
      promoted: true,
      reason: "promoted_for_verification",
      promotionClass: "broad_behavior_delta",
      selectedBy: "local_behavior_delta_reserve"
    });
  });

  it("does not reject non-test correctness uncertainty through the test coverage lane", async () => {
    const packet = fakePacket("packet-routing", "src/routing.ts", {
      symbol: "SolveQuoteRoutingWithFallbacks",
      line: "+ return fallbackProvider(intent)"
    });

    const result = await promoteUncertaintiesForVerification({
      packets: [packet],
      packetResults: [{
        packetId: packet.id,
        lenses: ["core/code-review"],
        findings: [],
        followUpHints: [],
        uncertainties: [{
          question: "Verify whether this fallback contract still preserves caller behavior when the preferred provider fails in tests.",
          files: ["src/routing.ts"],
          symbols: ["SolveQuoteRoutingWithFallbacks"],
          projectedSkillIds: ["core/code-review"]
        }],
        status: "completed"
      }]
    }, captureTelemetry().recorder);

    expect(result.summary.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        promoted: true,
        reason: "promoted_for_verification"
      })
    ]));
    expect(result.summary.notPromoted).not.toHaveProperty("test_risk_without_changed_test_or_deleted_coverage");
    expect(result.packetResults[0]?.findings[0]).toMatchObject({
      category: "correctness",
      provenance: { sourceKind: "uncertainty" }
    });
  });

  it("carries directly attached related changed context into a promoted candidate's evidence", async () => {
    const packet: ReviewPacket = {
      ...fakePacket("packet-producer", "src/producer.ts", { symbol: "transformValue", line: "+ return Math.floor(value / 10);" }),
      relatedChangedContext: [{
        path: "src/consumer.ts",
        hunkId: "h-consumer",
        symbol: "publishResult",
        reason: "Changed symbol transformValue is referenced by changed symbol publishResult.",
        relationshipSource: "symbol_mention",
        relationshipStrength: "strong",
        sourceKind: "source",
        sourceSnippet: "export function publishResult(value) { return { guaranteedMin: requestedValue }; }"
      }]
    };
    const telemetry = captureTelemetry();

    const result = await promoteUncertaintiesForVerification({
      packets: [packet],
      packetResults: [{
        packetId: packet.id,
        lenses: ["core/code-review"],
        findings: [],
        followUpHints: [{
          question: "transformValue truncates the request before publishResult reports the original value to the caller.",
          files: ["src/producer.ts"],
          symbols: ["transformValue", "publishResult"],
          suggestedLenses: ["core/code-review"],
          reason: "The changed transform truncates toward zero and could under-report the value promised to callers.",
          confidence: "medium",
          projectedSkillIds: ["core/code-review"]
        }],
        uncertainties: [],
        status: "completed"
      }]
    }, telemetry.recorder);

    const relatedCode = result.packetResults[0]?.findings[0]?.evidence.relatedCode ?? [];
    expect(relatedCode).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "src/consumer.ts",
        lines: expect.stringContaining("guaranteedMin"),
        whyRelevant: expect.stringContaining("Attached related changed context matched")
      })
    ]));
    expect(result.summary.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ promoted: true, relatedContextEvidenceCount: 1 })
    ]));
  });

  it("does not pull unrelated related context the promoted hint never referenced", async () => {
    const packet: ReviewPacket = {
      ...fakePacket("packet-producer-only", "src/producer.ts", { symbol: "transformValue", line: "+ return Math.floor(value / 10);" }),
      relatedChangedContext: [{
        path: "src/logging.ts",
        hunkId: "h-logging",
        symbol: "loggingHelper",
        reason: "Changed symbol loggingHelper is referenced elsewhere.",
        relationshipSource: "symbol_mention",
        relationshipStrength: "strong",
        sourceKind: "source",
        sourceSnippet: "export function loggingHelper() {}"
      }]
    };

    const result = await promoteUncertaintiesForVerification({
      packets: [packet],
      packetResults: [{
        packetId: packet.id,
        lenses: ["core/code-review"],
        findings: [],
        followUpHints: [{
          question: "transformValue truncates the request and could under-report the value promised to the caller.",
          files: ["src/producer.ts"],
          symbols: ["transformValue"],
          suggestedLenses: ["core/code-review"],
          reason: "The changed transform truncates toward zero and could under-report the delivered value.",
          confidence: "medium",
          projectedSkillIds: ["core/code-review"]
        }],
        uncertainties: [],
        status: "completed"
      }]
    }, captureTelemetry().recorder);

    const relatedCode = result.packetResults[0]?.findings[0]?.evidence.relatedCode ?? [];
    expect(relatedCode.some((entry) => entry.path === "src/logging.ts")).toBe(false);
    expect(result.summary.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ promoted: true })
    ]));
    expect(result.summary.decisions.find((decision) => decision.promoted)).not.toHaveProperty("relatedContextEvidenceCount");
  });

  it("does not attach related context from short symbol substring matches", async () => {
    const packet: ReviewPacket = {
      ...fakePacket("packet-short-symbol", "src/producer.ts", { symbol: "render", line: "+ return render(value);" }),
      relatedChangedContext: [{
        path: "src/id.ts",
        hunkId: "h-id",
        symbol: "id",
        reason: "Changed short symbol id is referenced elsewhere.",
        relationshipSource: "symbol_mention",
        relationshipStrength: "strong",
        sourceKind: "source",
        sourceSnippet: "export function id() {}"
      }]
    };

    const result = await promoteUncertaintiesForVerification({
      packets: [packet],
      packetResults: [{
        packetId: packet.id,
        lenses: ["core/code-review"],
        findings: [],
        followUpHints: [{
          question: "render now publishes a caller-visible value and should preserve the contract.",
          files: ["src/producer.ts"],
          symbols: ["render"],
          suggestedLenses: ["core/code-review"],
          reason: "The changed rendering path could under-report the value.",
          confidence: "medium",
          projectedSkillIds: ["core/code-review"]
        }],
        uncertainties: [],
        status: "completed"
      }]
    }, captureTelemetry().recorder);

    const relatedCode = result.packetResults[0]?.findings[0]?.evidence.relatedCode ?? [];
    expect(relatedCode.some((entry) => entry.path === "src/id.ts")).toBe(false);
  });

  it("caps and dedupes carried related-context evidence", async () => {
    const relatedSymbols = ["alpha", "beta", "gamma", "delta"];
    const packet: ReviewPacket = {
      ...fakePacket("packet-many-related", "src/producer.ts", { symbol: "transformValue", line: "+ return Math.floor(value / 10);" }),
      relatedChangedContext: [
        ...relatedSymbols.map((symbol) => ({
          path: `src/${symbol}.ts`,
          hunkId: `h-${symbol}`,
          symbol,
          reason: `Changed symbol transformValue references ${symbol}.`,
          relationshipSource: "symbol_mention" as const,
          relationshipStrength: "strong" as const,
          sourceKind: "source" as const,
          sourceSnippet: `export function ${symbol}() {}`
        })),
        // duplicate of alpha (same path + body) should dedupe away
        {
          path: "src/alpha.ts",
          hunkId: "h-alpha-2",
          symbol: "alpha",
          reason: "duplicate",
          relationshipSource: "symbol_mention" as const,
          relationshipStrength: "strong" as const,
          sourceKind: "source" as const,
          sourceSnippet: "export function alpha() {}"
        }
      ]
    };

    const result = await promoteUncertaintiesForVerification({
      packets: [packet],
      packetResults: [{
        packetId: packet.id,
        lenses: ["core/code-review"],
        findings: [],
        followUpHints: [{
          question: "transformValue truncates the request across alpha, beta, gamma, delta and could under-report the value promised to the caller.",
          files: ["src/producer.ts"],
          symbols: ["transformValue", ...relatedSymbols],
          suggestedLenses: ["core/code-review"],
          reason: "The changed transform truncates toward zero and could under-report the delivered value.",
          confidence: "medium",
          projectedSkillIds: ["core/code-review"]
        }],
        uncertainties: [],
        status: "completed"
      }]
    }, captureTelemetry().recorder);

    const relatedCode = result.packetResults[0]?.findings[0]?.evidence.relatedCode ?? [];
    const carried = relatedCode.filter((entry) => entry.whyRelevant.startsWith("Attached related changed context matched"));
    expect(carried.length).toBeLessThanOrEqual(3);
    expect(new Set(carried.map((entry) => entry.path)).size).toBe(carried.length);
  });
});

function fakePacket(
  id: string,
  filePath: string,
  opts: { symbol: string; line: string }
): ReviewPacket {
  return {
    id,
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
    lenses: filePath.includes("test") ? ["core/tests"] : ["core/code-review"],
    hunks: [{
      hunkId: "h1",
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      contentWithLineNumbers: `   1    1  export function ${opts.symbol}(value: number) {\n   2    2 ${opts.line}\n   3    3  }\n`,
      lines: [
        { kind: "context", content: `export function ${opts.symbol}(value: number) {`, oldLine: 1, newLine: 1 },
        { kind: "add", content: opts.line.replace(/^\+\s*/u, ""), newLine: 2 },
        { kind: "context", content: "}", oldLine: 3, newLine: 3 }
      ],
      changedNewLineNumbers: [2],
      changedOldLineNumbers: []
    }],
    symbolFacts: [{
      path: filePath,
      hunkId: "h1",
      enclosingSymbol: opts.symbol,
      symbolKind: "function",
      symbolRange: [1, 3],
      changedLines: [2],
      changedLinesSide: "new",
      signature: `function ${opts.symbol}(value: number)`,
      source: "tree-sitter",
      confidence: "syntactic"
    }],
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

function captureTelemetry(): {
  events: Array<Parameters<TelemetryRecorder["event"]>[0]>;
  artifacts: Map<string, unknown>;
  recorder: TelemetryRecorder;
} {
  const events: Array<Parameters<TelemetryRecorder["event"]>[0]> = [];
  const artifacts = new Map<string, unknown>();
  return {
    events,
    artifacts,
    recorder: {
      runId: "test-run",
      runDir: undefined,
      event: (event) => events.push(event),
      recordModelCall: () => undefined,
      recordToolCall: () => "tc-test",
      writeArtifact: async (name, value) => {
        artifacts.set(name, value);
      },
      writeDebug: async () => undefined,
      flush: async () => undefined
    }
  };
}
