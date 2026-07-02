import picomatch from "picomatch";
import type {
  CandidateFinding,
  EvalArtifacts,
  EvalAssignment,
  EvalBudgetResult,
  EvalCase,
  EvalExpectationResult,
  EvalFindingExpectation,
  EvalHintEvent,
  EvalLossDetail,
  EvalLossLabel,
  EvalMatchOutcome,
  EvalRunMetrics,
  EvalScore,
  EvalSelectionRecord,
  EvalVerificationRecord,
  EvalViolation,
  FindingCategory,
  FinalFinding,
  ReviewStage,
  Severity
} from "../types.js";
import { isLocalToolBudgetRejectionReason } from "../util/context-pressure.js";

type ScorableFinding = CandidateFinding | FinalFinding;
type ScoreMode = "live" | "replay";
type FindingLocationVariant = {
  path: string;
  range?: [number, number];
  source: "finding" | "merged-candidate" | "related-evidence";
  findingId?: string;
};
type FindingMatchView = {
  id?: string;
  title: string;
  category: FindingCategory;
  severity: Severity;
  failureMode: string;
  finalBody?: string;
  source: "finding" | "merged-candidate" | "merged-metadata";
};
type FieldMatch = {
  matched: boolean;
  actual: string;
  via?: string;
};

const severityRank: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

type RankedLossInstance = {
  rank: number;
  order: number;
  label: EvalLossLabel;
  subReason?: string;
  instance: EvalLossDetail["nearestInstances"][number];
};

export function scoreEvalRun(evalCase: EvalCase, artifacts: EvalArtifacts, mode: ScoreMode): EvalScore {
  const reportedFinals = artifacts.finalFindings.filter(isReportedFinalFinding);
  const metrics = buildMetrics(artifacts);
  const shouldNot = scoreShouldNotFind(evalCase.should_not_find ?? [], reportedFinals, artifacts, mode);
  const allExpectationResults = [
    ...scorePositiveList("should_find", evalCase.should_find ?? [], reportedFinals, artifacts, mode),
    ...scorePositiveList("should_find_candidate", evalCase.should_find_candidate ?? [], artifacts.candidates, artifacts, mode),
    ...shouldNot.results
  ];
  metrics.stageLossCounts = countLosses(allExpectationResults);
  const budgetResults = scoreBudgets(evalCase, metrics, mode);
  const status = allExpectationResults.some((result) => result.status === "fail") ||
    shouldNot.violations.length > 0 ||
    budgetResults.some((result) => result.status === "fail")
    ? "fail"
    : "pass";
  return {
    status,
    expectationResults: allExpectationResults,
    budgetResults,
    violations: shouldNot.violations,
    nearViolations: shouldNot.nearViolations,
    metrics
  };
}

export function matchExpectation(
  expectation: EvalFindingExpectation,
  finding: ScorableFinding,
  artifacts?: EvalArtifacts
): EvalMatchOutcome {
  const fields: EvalMatchOutcome["fields"] = [];
  const location = matchFindingLocation(expectation, finding, artifacts);
  if (expectation.path !== undefined) {
    fields.push({
      field: "path",
      present: true,
      matched: location.pathMatched,
      expected: expectation.path,
      actual: location.actualPaths.join(", ")
    });
  }
  if (expectation.lineRange !== undefined) {
    fields.push({
      field: "lineRange",
      present: true,
      matched: location.lineRangeMatched,
      expected: `${expectation.lineRange[0]}-${expectation.lineRange[1]}`,
      ...(location.actualRanges.length > 0 ? { actual: location.actualRanges.join(", ") } : {})
    });
  }
  if (expectation.category !== undefined) {
    const category = matchCategory(expectation.category, finding, artifacts);
    fields.push({
      field: "category",
      present: true,
      matched: category.matched,
      expected: expectation.category,
      actual: category.actual,
      ...(category.via !== undefined ? { via: category.via } : {})
    });
  }
  if (expectation.severityAtLeast !== undefined) {
    const severity = matchSeverity(expectation.severityAtLeast, finding, artifacts);
    fields.push({
      field: "severityAtLeast",
      present: true,
      matched: severity.matched,
      expected: expectation.severityAtLeast,
      actual: severity.actual,
      ...(severity.via !== undefined ? { via: severity.via } : {})
    });
  }
  if (expectation.titlePattern !== undefined) {
    const title = matchTitlePattern(expectation.titlePattern, finding, artifacts);
    fields.push({
      field: "titlePattern",
      present: true,
      matched: title.matched,
      expected: expectation.titlePattern,
      actual: title.actual,
      ...(title.via !== undefined ? { via: title.via } : {})
    });
  }
  if (expectation.failureModePattern !== undefined) {
    const failureMode = matchFailureModePattern(expectation.failureModePattern, finding, artifacts);
    fields.push({
      field: "failureModePattern",
      present: true,
      matched: failureMode.matched,
      expected: expectation.failureModePattern,
      actual: failureMode.actual,
      ...(failureMode.via !== undefined ? { via: failureMode.via } : {})
    });
  }
  return {
    matched: fields.every((field) => field.matched),
    fields
  };
}

export function assignExpectations(
  expectations: EvalFindingExpectation[],
  findings: ScorableFinding[],
  artifacts?: EvalArtifacts
): EvalAssignment {
  const matches = expectations.map((expectation) =>
    findings.map((finding) => matchExpectation(expectation, finding, artifacts).matched)
  );
  const findingToExpectation = new Array<number>(findings.length).fill(-1);

  for (let expectationIndex = 0; expectationIndex < expectations.length; expectationIndex += 1) {
    augment(expectationIndex, new Set<number>(), matches, findingToExpectation);
  }

  const pairs = findingToExpectation
    .map((expectationIndex, findingIndex) => ({ expectationIndex, findingIndex }))
    .filter((pair) => pair.expectationIndex !== -1)
    .sort((a, b) => a.expectationIndex - b.expectationIndex)
    .map((pair) => ({
      expectationId: expectations[pair.expectationIndex]?.id ?? "",
      findingId: findings[pair.findingIndex]?.id ?? ""
    }));
  const matchedExpectationIds = new Set(pairs.map((pair) => pair.expectationId));
  const matchedFindingIds = new Set(pairs.map((pair) => pair.findingId));
  return {
    pairs,
    unmatchedExpectationIds: expectations
      .map((expectation) => expectation.id)
      .filter((id) => !matchedExpectationIds.has(id)),
    unmatchedFindingIds: findings
      .map((finding) => finding.id)
      .filter((id) => !matchedFindingIds.has(id))
  };
}

export function attributeLoss(
  expectation: EvalFindingExpectation,
  artifacts: EvalArtifacts
): EvalLossDetail {
  const hints = matchingHints(expectation, artifacts.hintEvents);
  const exactInstances = exactLossInstances(expectation, artifacts);
  if (exactInstances.length > 0) {
    const [winner] = exactInstances;
    return addHints({
      label: winner?.label ?? "missed-before-candidate-generation",
      ...(winner?.subReason !== undefined ? { subReason: winner.subReason } : {}),
      nearestInstances: exactInstances.map((entry) => entry.instance)
    }, hints);
  }

  const partial = nearestPartialMatches(expectation, artifacts, "all");
  if (partial.length > 0) {
    return addHints({
      label: "partial-match",
      nearestInstances: partial
    }, hints);
  }

  return addHints({
    label: "missed-before-candidate-generation",
    subReason: missedSubReason(expectation, artifacts),
    nearestInstances: [],
    ...packetCoverageDetails(expectation, artifacts)
  }, hints);
}

function exactLossInstances(expectation: EvalFindingExpectation, artifacts: EvalArtifacts): RankedLossInstance[] {
  let order = 0;
  const instances: RankedLossInstance[] = [];

  for (const finding of artifacts.finalFindings) {
    if (finding.publication !== "suppressed" || !matchExpectation(expectation, finding, artifacts).matched) {
      continue;
    }
    const subReason = selectionReasonForFinding(finding, artifacts.finalSelection) ?? "suppressed";
    instances.push({
      rank: 3,
      order: order++,
      label: "lost-at-composition",
      subReason,
      instance: {
        findingId: finding.id,
        artifact: "final-findings",
        outcome: `publication=${finding.publication} reason=${subReason}`
      }
    });
  }

  for (const finding of verifiedKeptFindings(artifacts)) {
    if (!matchExpectation(expectation, finding, artifacts).matched) {
      continue;
    }
    const absorbing = artifacts.finalFindings.find((finalFinding) =>
      finalFinding.id === finding.id || finalFinding.mergedCandidateIds.includes(finding.id)
    );
    const subReason = absorbing ? "merged-deduped-away" : "unrecorded";
    instances.push({
      rank: 3,
      order: order++,
      label: "lost-at-composition",
      subReason,
      instance: {
        findingId: finding.id,
        artifact: absorbing ? "final-selection" : "verification",
        outcome: absorbing
          ? `mergedInto=${absorbing.fingerprint} publication=${absorbing.publication}`
          : "verified-kept without final selection"
      }
    });
  }

  for (const candidate of artifacts.candidates) {
    if (!matchExpectation(expectation, candidate, artifacts).matched || verificationKeptCandidate(candidate, artifacts)) {
      continue;
    }
    const outcome = verificationOutcome(candidate, artifacts.verification, artifacts.candidates);
    instances.push({
      rank: 2,
      order: order++,
      label: "lost-at-verification",
      subReason: outcome.subReason,
      instance: {
        findingId: candidate.id,
        artifact: "verification",
        outcome: outcome.outcome
      }
    });
  }

  return instances.sort((a, b) => b.rank - a.rank || a.order - b.order);
}

function scorePositiveList(
  list: "should_find" | "should_find_candidate",
  expectations: EvalFindingExpectation[],
  findings: ScorableFinding[],
  artifacts: EvalArtifacts,
  mode: ScoreMode
): EvalExpectationResult[] {
  const assignment = assignPositiveExpectations(expectations, findings, artifacts);
  const pairByExpectation = new Map(assignment.pairs.map((pair) => [pair.expectationId, pair.findingId]));
  return expectations.map((expectation) => {
    const tier = expectation.tier ?? "required";
    const findingId = pairByExpectation.get(expectation.id);
    if (findingId !== undefined) {
      return {
        expectationId: expectation.id,
        list,
        tier,
        status: "pass",
        fromReplayedArtifacts: mode === "replay",
        matched: [{
          findingId,
          artifact: list === "should_find" ? "final-findings" : "candidate-findings"
        }]
      };
    }
    if (tier === "optional") {
      return {
        expectationId: expectation.id,
        list,
        tier,
        status: "skipped",
        skipReason: "optional-unmatched",
        fromReplayedArtifacts: mode === "replay",
        matched: []
      };
    }
    return {
      expectationId: expectation.id,
      list,
      tier,
      status: "fail",
      fromReplayedArtifacts: mode === "replay",
      matched: [],
      loss: list === "should_find"
        ? attributeLoss(expectation, artifacts)
        : attributeCandidateLoss(expectation, artifacts)
    };
  });
}

function assignPositiveExpectations(
  expectations: EvalFindingExpectation[],
  findings: ScorableFinding[],
  artifacts: EvalArtifacts
): EvalAssignment {
  const requiredExpectations = expectations.filter((expectation) => (expectation.tier ?? "required") !== "optional");
  const optionalExpectations = expectations.filter((expectation) => expectation.tier === "optional");
  if (optionalExpectations.length === 0) {
    return assignExpectations(expectations, findings, artifacts);
  }

  const requiredAssignment = assignExpectations(requiredExpectations, findings, artifacts);
  const requiredFindingIds = new Set(requiredAssignment.pairs.map((pair) => pair.findingId));
  const remainingFindings = findings.filter((finding) => !requiredFindingIds.has(finding.id));
  const optionalAssignment = assignExpectations(optionalExpectations, remainingFindings, artifacts);
  const matchedExpectationIds = new Set([
    ...requiredAssignment.pairs.map((pair) => pair.expectationId),
    ...optionalAssignment.pairs.map((pair) => pair.expectationId)
  ]);
  const matchedFindingIds = new Set([
    ...requiredAssignment.pairs.map((pair) => pair.findingId),
    ...optionalAssignment.pairs.map((pair) => pair.findingId)
  ]);
  return {
    pairs: [...requiredAssignment.pairs, ...optionalAssignment.pairs],
    unmatchedExpectationIds: expectations
      .map((expectation) => expectation.id)
      .filter((id) => !matchedExpectationIds.has(id)),
    unmatchedFindingIds: findings
      .map((finding) => finding.id)
      .filter((id) => !matchedFindingIds.has(id))
  };
}

function scoreShouldNotFind(
  expectations: EvalFindingExpectation[],
  reportedFinals: Array<FinalFinding & { publication: "inline" | "summary-only" }>,
  artifacts: EvalArtifacts,
  mode: ScoreMode
): {
  results: EvalExpectationResult[];
  violations: EvalViolation[];
  nearViolations: Array<{ expectationId: string; findingId: string; artifact: string }>;
} {
  const violations: EvalViolation[] = [];
  const nearViolations: Array<{ expectationId: string; findingId: string; artifact: string }> = [];
  const results = expectations.map((expectation): EvalExpectationResult => {
    const tier = expectation.tier ?? "required";
    const matches = reportedFinals.filter((finding) => matchExpectation(expectation, finding, artifacts).matched);
    for (const finding of matches) {
      if (tier === "optional") {
        nearViolations.push({ expectationId: expectation.id, findingId: finding.id, artifact: "final-findings" });
      } else {
        violations.push({
          expectationId: expectation.id,
          findingId: finding.id,
          publication: finding.publication
        });
      }
    }
    for (const finding of artifacts.candidates.filter((candidate) => matchExpectation(expectation, candidate, artifacts).matched)) {
      nearViolations.push({ expectationId: expectation.id, findingId: finding.id, artifact: "candidate-findings" });
    }
    for (const finding of artifacts.finalFindings.filter((candidate) =>
      candidate.publication === "suppressed" && matchExpectation(expectation, candidate, artifacts).matched
    )) {
      nearViolations.push({ expectationId: expectation.id, findingId: finding.id, artifact: "final-findings:suppressed" });
    }
    return {
      expectationId: expectation.id,
      list: "should_not_find",
      tier,
      status: matches.length === 0 ? "pass" : tier === "optional" ? "skipped" : "fail",
      ...(matches.length > 0 && tier === "optional" ? { skipReason: "optional-matched" } : {}),
      fromReplayedArtifacts: mode === "replay",
      matched: matches.map((finding) => ({ findingId: finding.id, artifact: "final-findings" }))
    };
  });
  return { results, violations, nearViolations };
}

function attributeCandidateLoss(expectation: EvalFindingExpectation, artifacts: EvalArtifacts): EvalLossDetail {
  const hints = matchingHints(expectation, artifacts.hintEvents);
  const partial = nearestPartialMatches(expectation, artifacts, "candidates");
  if (partial.length > 0) {
    return addHints({ label: "partial-match", nearestInstances: partial }, hints);
  }
  return addHints({
    label: "missed-before-candidate-generation",
    subReason: missedSubReason(expectation, artifacts),
    nearestInstances: [],
    ...packetCoverageDetails(expectation, artifacts)
  }, hints);
}

function scoreBudgets(
  evalCase: EvalCase,
  metrics: EvalRunMetrics,
  mode: ScoreMode
): EvalBudgetResult[] {
  const expect = evalCase.expect ?? {};
  const results: EvalBudgetResult[] = [];
  if (expect.minFindings !== undefined) {
    results.push(budgetResult("minFindings", expect.minFindings, metrics.reportedFindings, "minimum", metrics.reportedFindings >= expect.minFindings, mode));
  }
  if (expect.maxFindings !== undefined) {
    results.push(budgetResult("maxFindings", expect.maxFindings, metrics.reportedFindings, "maximum", metrics.reportedFindings <= expect.maxFindings, mode));
  }
  if (expect.maxDuplicateGroups !== undefined) {
    results.push(budgetResult("maxDuplicateGroups", expect.maxDuplicateGroups, metrics.duplicateGroups, "maximum", metrics.duplicateGroups <= expect.maxDuplicateGroups, mode));
  }
  const replaySkip = mode === "replay" ? "stage not executed in artifact replay" : undefined;
  if (expect.maxCostUSD !== undefined) {
    results.push(metricBudgetResult("maxCostUSD", expect.maxCostUSD, metrics.costUSD, replaySkip));
  }
  if (expect.maxElapsedSeconds !== undefined) {
    results.push(metricBudgetResult("maxElapsedSeconds", expect.maxElapsedSeconds, metrics.elapsedSeconds, replaySkip));
  }
  if (expect.maxModelCalls !== undefined) {
    results.push(metricBudgetResult("maxModelCalls", expect.maxModelCalls, metrics.modelCalls, replaySkip));
  }
  if (expect.maxToolCalls !== undefined) {
    results.push(metricBudgetResult("maxToolCalls", expect.maxToolCalls, metrics.toolCalls, replaySkip));
  }
  for (const [stageKey, limit] of Object.entries(expect.maxPromptCharsByStage ?? {})) {
    if (limit === undefined) {
      continue;
    }
    const stage = Number(stageKey);
    if (!isReviewStage(stage)) {
      continue;
    }
    const actual = metrics.maxPromptCharsByStage?.[stage];
    results.push(metricBudgetResult("maxPromptCharsByStage", limit, actual, replaySkip, stage));
  }
  if (expect.reviewCompleteness !== undefined) {
    results.push(completenessBudgetResult(expect.reviewCompleteness, metrics.reviewCompleteness));
  }
  if (expect.maxBudgetOverruns !== undefined) {
    results.push(metricBudgetResult("maxBudgetOverruns", expect.maxBudgetOverruns, metrics.budgetOverruns, undefined));
  }
  if (expect.maxToolBudgetRejections !== undefined) {
    results.push(metricBudgetResult("maxToolBudgetRejections", expect.maxToolBudgetRejections, metrics.toolBudgetRejections, undefined));
  }
  if (expect.maxDegradedHunks !== undefined) {
    results.push(metricBudgetResult("maxDegradedHunks", expect.maxDegradedHunks, metrics.degradedHunks, undefined));
  }
  if (expect.maxUnresolvedNotesSuppressed !== undefined) {
    results.push(metricBudgetResult("maxUnresolvedNotesSuppressed", expect.maxUnresolvedNotesSuppressed, metrics.unresolvedNotesSuppressed, undefined));
  }
  return results;
}

function budgetResult(
  check: EvalBudgetResult["check"],
  limit: number,
  actual: number,
  direction: EvalBudgetResult["direction"],
  passed: boolean,
  mode: ScoreMode
): EvalBudgetResult {
  return {
    check,
    status: passed ? "pass" : "fail",
    limit,
    actual,
    direction,
    fromReplayedArtifacts: mode === "replay"
  };
}

function completenessBudgetResult(
  expected: "complete" | "partial",
  actual: "complete" | "partial" | undefined
): EvalBudgetResult {
  if (actual === undefined) {
    return {
      check: "reviewCompleteness",
      status: "skipped",
      skipReason: "metric unavailable",
      expected,
      direction: "equals"
    };
  }
  return {
    check: "reviewCompleteness",
    status: actual === expected ? "pass" : "fail",
    expected,
    actualText: actual,
    direction: "equals"
  };
}

function metricBudgetResult(
  check: EvalBudgetResult["check"],
  limit: number,
  actual: number | undefined,
  replaySkip?: string,
  stage?: ReviewStage
): EvalBudgetResult {
  if (replaySkip !== undefined) {
    return {
      check,
      ...(stage !== undefined ? { stage } : {}),
      status: "skipped",
      skipReason: replaySkip,
      limit,
      direction: "maximum"
    };
  }
  if (actual === undefined) {
    return {
      check,
      ...(stage !== undefined ? { stage } : {}),
      status: "skipped",
      skipReason: "metric unavailable",
      limit,
      direction: "maximum"
    };
  }
  return {
    check,
    ...(stage !== undefined ? { stage } : {}),
    status: actual <= limit ? "pass" : "fail",
    limit,
    actual,
    direction: "maximum"
  };
}

function buildMetrics(artifacts: EvalArtifacts): EvalRunMetrics {
  const reported = artifacts.finalFindings.filter(isReportedFinalFinding);
  const modelCalls = artifacts.metricsSources.modelCalls ?? [];
  const toolCalls = artifacts.metricsSources.toolCalls ?? [];
  const maxPromptCharsByStage = maxPromptChars(modelCalls);
  const metrics: EvalRunMetrics = {
    reportedFindings: reported.length,
    inlineFindings: reported.filter((finding) => finding.publication === "inline").length,
    summaryOnlyFindings: reported.filter((finding) => finding.publication === "summary-only").length,
    suppressedFindings: artifacts.finalFindings.filter((finding) => finding.publication === "suppressed").length,
    candidateFindings: artifacts.candidates.length,
    duplicateGroups: artifacts.finalFindings.filter((finding) => finding.mergedCandidateIds.length >= 2).length,
    stageLossCounts: emptyLossCounts()
  };
  const budgetSummary = artifacts.metricsSources.budgetSummary;
  if (budgetSummary !== undefined) {
    metrics.reviewCompleteness = budgetSummary.completeness;
    metrics.budgetOverruns = budgetSummary.overruns.length;
    if (budgetSummary.contextPressure !== undefined) {
      metrics.toolBudgetRejections = budgetSummary.contextPressure.toolBudgetRejections;
      if (budgetSummary.contextPressure.toolBudgetExtensions !== undefined) {
        metrics.toolBudgetExtensions = budgetSummary.contextPressure.toolBudgetExtensions.granted;
        metrics.toolBudgetExtensionDenials = budgetSummary.contextPressure.toolBudgetExtensions.denied;
      }
      metrics.degradedHunks = budgetSummary.contextPressure.degradedHunks;
      metrics.unresolvedNotesSuppressed = budgetSummary.contextPressure.unresolvedNotes.omitted;
    }
  } else if (artifacts.coverage !== undefined) {
    metrics.reviewCompleteness = artifacts.coverage.partial ? "partial" : "complete";
  }
  const costUSD = numberPath(artifacts.metricsSources.costProfile, ["totalCostUSD"]);
  if (costUSD !== undefined) {
    metrics.costUSD = costUSD;
  }
  const elapsedMs = numberPath(artifacts.metricsSources.runJson, ["durationMs"]);
  if (elapsedMs !== undefined) {
    metrics.elapsedSeconds = elapsedMs / 1000;
  }
  const modelCallsTotal = numberPath(artifacts.metricsSources.modelCallsSummary, ["totalCalls"]) ??
    numberPath(artifacts.metricsSources.modelCallsSummary, ["providerCalls"]) ??
    (modelCalls.length > 0 ? modelCalls.length : undefined);
  if (modelCallsTotal !== undefined) {
    metrics.modelCalls = modelCallsTotal;
  }
  const verificationCalls = modelCalls.filter((call) => isRecord(call) && call.stage === 9).length;
  if (verificationCalls > 0) {
    metrics.verificationCalls = verificationCalls;
  } else {
    const verificationVerdicts = artifacts.verification.filter((record) => "verdict" in record).length;
    if (verificationVerdicts > 0) {
      metrics.verificationCalls = verificationVerdicts;
    }
  }
  const toolCallTotal = toolCalls.length > 0 ? toolCalls.length : numberPath(artifacts.metricsSources.toolCallsSummary, ["totalCalls"]);
  if (toolCallTotal !== undefined) {
    metrics.toolCalls = toolCallTotal;
  }
  if (metrics.toolBudgetRejections === undefined) {
    const toolBudgetRejections = countRawToolBudgetRejections(toolCalls);
    if (toolBudgetRejections !== undefined) {
      metrics.toolBudgetRejections = toolBudgetRejections;
    }
  }
  if (Object.keys(maxPromptCharsByStage).length > 0) {
    metrics.maxPromptCharsByStage = maxPromptCharsByStage;
  }
  const localCacheHits = firstNumberPath([
    [artifacts.metricsSources.modelCallsSummary, ["localModelCallCache", "hit"]],
    [artifacts.metricsSources.costProfile, ["localModelCallCache", "hit"]],
    [artifacts.metricsSources.modelCallsSummary, ["cache", "hit"]]
  ]);
  if (localCacheHits !== undefined) {
    metrics.localModelCallCacheHits = localCacheHits;
    metrics.cacheHits = localCacheHits;
  }
  const localCacheMisses = firstNumberPath([
    [artifacts.metricsSources.modelCallsSummary, ["localModelCallCache", "miss"]],
    [artifacts.metricsSources.costProfile, ["localModelCallCache", "miss"]],
    [artifacts.metricsSources.modelCallsSummary, ["cache", "miss"]]
  ]);
  if (localCacheMisses !== undefined) {
    metrics.localModelCallCacheMisses = localCacheMisses;
    metrics.cacheMisses = localCacheMisses;
  }
  const localCacheWrites = firstNumberPath([
    [artifacts.metricsSources.modelCallsSummary, ["localModelCallCache", "write"]],
    [artifacts.metricsSources.costProfile, ["localModelCallCache", "write"]],
    [artifacts.metricsSources.modelCallsSummary, ["cache", "write"]]
  ]);
  if (localCacheWrites !== undefined) {
    metrics.localModelCallCacheWrites = localCacheWrites;
  }
  const providerPromptCacheReadTokens = firstNumberPath([
    [artifacts.metricsSources.modelCallsSummary, ["providerPromptCache", "readTokens"]],
    [artifacts.metricsSources.costProfile, ["providerPromptCache", "readTokens"]],
    [artifacts.metricsSources.costProfile, ["costBreakdown", "providerPromptCacheRead", "tokens"]],
    [artifacts.metricsSources.modelCallsSummary, ["cacheReadTokens"]],
    [artifacts.metricsSources.costProfile, ["tokens", "cacheReadTokens"]]
  ]);
  if (providerPromptCacheReadTokens !== undefined) {
    metrics.providerPromptCacheReadTokens = providerPromptCacheReadTokens;
  }
  const providerPromptCacheWriteTokens = firstNumberPath([
    [artifacts.metricsSources.modelCallsSummary, ["providerPromptCache", "writeTokens"]],
    [artifacts.metricsSources.costProfile, ["providerPromptCache", "writeTokens"]],
    [artifacts.metricsSources.costProfile, ["costBreakdown", "providerPromptCacheWrite", "tokens"]],
    [artifacts.metricsSources.modelCallsSummary, ["cacheWriteTokens"]],
    [artifacts.metricsSources.costProfile, ["tokens", "cacheWriteTokens"]]
  ]);
  if (providerPromptCacheWriteTokens !== undefined) {
    metrics.providerPromptCacheWriteTokens = providerPromptCacheWriteTokens;
  }
  const providerPromptCacheReadCostUSD = firstNumberPath([
    [artifacts.metricsSources.modelCallsSummary, ["providerPromptCache", "readCostUSD"]],
    [artifacts.metricsSources.costProfile, ["providerPromptCache", "readCostUSD"]],
    [artifacts.metricsSources.costProfile, ["costBreakdown", "providerPromptCacheRead", "costUSD"]],
    [artifacts.metricsSources.modelCallsSummary, ["cacheReadCostUSD"]],
    [artifacts.metricsSources.costProfile, ["cost", "cacheReadCostUSD"]]
  ]);
  if (providerPromptCacheReadCostUSD !== undefined) {
    metrics.providerPromptCacheReadCostUSD = providerPromptCacheReadCostUSD;
  }
  const providerPromptCacheWriteCostUSD = firstNumberPath([
    [artifacts.metricsSources.modelCallsSummary, ["providerPromptCache", "writeCostUSD"]],
    [artifacts.metricsSources.costProfile, ["providerPromptCache", "writeCostUSD"]],
    [artifacts.metricsSources.costProfile, ["costBreakdown", "providerPromptCacheWrite", "costUSD"]],
    [artifacts.metricsSources.modelCallsSummary, ["cacheWriteCostUSD"]],
    [artifacts.metricsSources.costProfile, ["cost", "cacheWriteCostUSD"]]
  ]);
  if (providerPromptCacheWriteCostUSD !== undefined) {
    metrics.providerPromptCacheWriteCostUSD = providerPromptCacheWriteCostUSD;
  }
  const schemaRecovery = schemaRecoveryMetrics(artifacts);
  if (schemaRecovery.schemaInvalidCalls !== undefined) {
    metrics.schemaInvalidCalls = schemaRecovery.schemaInvalidCalls;
  }
  if (schemaRecovery.schemaInvalidRecovered !== undefined) {
    metrics.schemaInvalidRecovered = schemaRecovery.schemaInvalidRecovered;
  }
  if (schemaRecovery.schemaInvalidUnrecovered !== undefined) {
    metrics.schemaInvalidUnrecovered = schemaRecovery.schemaInvalidUnrecovered;
  }
  if (schemaRecovery.schemaRepairAttempts !== undefined) {
    metrics.schemaRepairAttempts = schemaRecovery.schemaRepairAttempts;
  }
  if (schemaRecovery.schemaRepairRecovered !== undefined) {
    metrics.schemaRepairRecovered = schemaRecovery.schemaRepairRecovered;
  }
  if (schemaRecovery.deterministicSchemaRecovered !== undefined) {
    metrics.deterministicSchemaRecovered = schemaRecovery.deterministicSchemaRecovered;
  }
  if (schemaRecovery.schemaRecoveryFailed !== undefined) {
    metrics.schemaRecoveryFailed = schemaRecovery.schemaRecoveryFailed;
  }
  return metrics;
}

function schemaRecoveryMetrics(artifacts: EvalArtifacts): Partial<Pick<
  EvalRunMetrics,
  | "schemaInvalidCalls"
  | "schemaInvalidRecovered"
  | "schemaInvalidUnrecovered"
  | "schemaRepairAttempts"
  | "schemaRepairRecovered"
  | "deterministicSchemaRecovered"
  | "schemaRecoveryFailed"
>> {
  const sources = [
    fieldAtPath(artifacts.metricsSources.modelCallsSummary, ["schemaRecovery"]),
    fieldAtPath(artifacts.metricsSources.telemetry, ["schemaRecovery"]),
    fieldAtPath(artifacts.metricsSources.runJson, ["totals", "schemaRecovery"])
  ];
  const source = sources.find(isRecord);
  const schemaInvalidCalls = firstNumberPath([
    [source, ["schemaInvalidCalls"]],
    [artifacts.metricsSources.modelCallsSummary, ["schemaInvalidCalls"]],
    [artifacts.metricsSources.telemetry, ["modelCalls", "schemaInvalidCalls"]],
    [artifacts.metricsSources.runJson, ["totals", "schemaInvalidCalls"]]
  ]);
  const schemaInvalidRecovered = firstNumberPath([[source, ["schemaInvalidRecovered"]]]);
  const schemaInvalidUnrecovered = firstNumberPath([[source, ["schemaInvalidUnrecovered"]]]);
  const schemaRepairAttempts = firstNumberPath([[source, ["schemaRepairAttempts"]]]);
  const schemaRepairRecovered = firstNumberPath([[source, ["schemaRepairRecovered"]]]);
  const deterministicSchemaRecovered = firstNumberPath([[source, ["deterministicSchemaRecovered"]]]);
  const schemaRecoveryFailed = firstNumberPath([[source, ["schemaRecoveryFailed"]]]);
  return {
    ...(schemaInvalidCalls !== undefined ? { schemaInvalidCalls } : {}),
    ...(schemaInvalidRecovered !== undefined ? { schemaInvalidRecovered } : {}),
    ...(schemaInvalidUnrecovered !== undefined ? { schemaInvalidUnrecovered } : {}),
    ...(schemaRepairAttempts !== undefined ? { schemaRepairAttempts } : {}),
    ...(schemaRepairRecovered !== undefined ? { schemaRepairRecovered } : {}),
    ...(deterministicSchemaRecovered !== undefined ? { deterministicSchemaRecovered } : {}),
    ...(schemaRecoveryFailed !== undefined ? { schemaRecoveryFailed } : {})
  };
}

function countRawToolBudgetRejections(toolCalls: unknown[]): number | undefined {
  if (toolCalls.length === 0) {
    return undefined;
  }
  let count = 0;
  for (const call of toolCalls) {
    if (!isRecord(call) || call.status !== "rejected") {
      continue;
    }
    if (isLocalToolBudgetRejectionReason(call.degradationReason)) {
      count += 1;
    }
  }
  return count;
}

function maxPromptChars(modelCalls: unknown[]): Partial<Record<ReviewStage, number>> {
  const byStage: Partial<Record<ReviewStage, number>> = {};
  for (const call of modelCalls) {
    if (!isRecord(call) || typeof call.stage !== "number" || !isReviewStage(call.stage)) {
      continue;
    }
    const promptChars = typeof call.promptChars === "number" ? call.promptChars : undefined;
    if (promptChars === undefined) {
      continue;
    }
    byStage[call.stage] = Math.max(byStage[call.stage] ?? 0, promptChars);
  }
  return byStage;
}

function countLosses(results: EvalExpectationResult[]): Record<EvalLossLabel, number> {
  const counts = emptyLossCounts();
  for (const result of results) {
    if (result.loss !== undefined) {
      counts[result.loss.label] += 1;
    }
  }
  return counts;
}

function emptyLossCounts(): Record<EvalLossLabel, number> {
  return {
    "missed-before-candidate-generation": 0,
    "lost-at-verification": 0,
    "lost-at-composition": 0,
    "partial-match": 0
  };
}

function verifiedKeptFindings(artifacts: EvalArtifacts): CandidateFinding[] {
  return artifacts.candidates.flatMap((candidate) => {
    const resolved = verificationRecordForCandidate(candidate, artifacts.verification, artifacts.candidates);
    if (resolved === undefined ||
      !("verdict" in resolved.record) ||
      resolved.record.verdict.verdict === "reject" ||
      resolved.record.verdict.verificationIncomplete === true) {
      return [];
    }
    return [resolved.viaDuplicate ? candidate : resolved.record.verdict.finalFinding ?? candidate];
  });
}

function verificationOutcome(
  candidate: CandidateFinding,
  records: EvalVerificationRecord[],
  candidates: CandidateFinding[]
): { subReason: string; outcome: string } {
  const resolved = verificationRecordForCandidate(candidate, records, candidates);
  const record = resolved?.record;
  if (record === undefined) {
    return { subReason: "unrecorded", outcome: "verification=unrecorded" };
  }
  const duplicateSuffix = resolved?.viaDuplicate === true ? ` via duplicateOf=${record.candidateId}` : "";
  if (!("verdict" in record)) {
    return { subReason: normalizeGateReason(record.gateReason), outcome: `pre-gate=${record.gateReason}${duplicateSuffix}` };
  }
  if (record.verdict.verificationIncomplete === true) {
    return { subReason: "verification-incomplete", outcome: `outcome=incomplete${duplicateSuffix} reason=${record.verdict.reason}` };
  }
  if (record.verdict.verdict === "reject") {
    return { subReason: "verifier-rejected", outcome: `verdict=reject${duplicateSuffix} reason=${record.verdict.reason}` };
  }
  return { subReason: "unrecorded", outcome: `verdict=${record.verdict.verdict}${duplicateSuffix}` };
}

function verificationRecordForCandidate(
  candidate: CandidateFinding,
  records: EvalVerificationRecord[],
  candidates: CandidateFinding[]
): { record: EvalVerificationRecord; viaDuplicate: boolean } | undefined {
  const direct = records.find((record) => record.candidateId === candidate.id);
  if (direct !== undefined) {
    return { record: direct, viaDuplicate: false };
  }
  const representativeId = representativeCandidateId(candidate, candidates);
  if (representativeId === undefined || representativeId === candidate.id) {
    return undefined;
  }
  const representative = records.find((record) => record.candidateId === representativeId);
  return representative !== undefined ? { record: representative, viaDuplicate: true } : undefined;
}

function verificationKeptCandidate(candidate: CandidateFinding, artifacts: EvalArtifacts): boolean {
  const resolved = verificationRecordForCandidate(candidate, artifacts.verification, artifacts.candidates);
  if (resolved === undefined || !("verdict" in resolved.record)) {
    return false;
  }
  return resolved.record.verdict.verdict !== "reject" && resolved.record.verdict.verificationIncomplete !== true;
}

function representativeCandidateId(candidate: CandidateFinding, candidates: CandidateFinding[]): string | undefined {
  const byId = new Map(candidates.map((item) => [item.id, item]));
  const seen = new Set<string>();
  let current: CandidateFinding | undefined = candidate;
  for (;;) {
    const nextId = current.duplicateOf ?? current.clusterId;
    if (nextId === undefined) {
      return current.id;
    }
    if (seen.has(nextId)) {
      return undefined;
    }
    seen.add(nextId);
    const next = byId.get(nextId);
    if (next === undefined) {
      return nextId;
    }
    current = next;
  }
}

function selectionReasonForFinding(finding: FinalFinding, selection: EvalSelectionRecord[]): string | undefined {
  for (const id of [finding.id, ...finding.mergedCandidateIds]) {
    const record = selection.find((item) => item.findingId === id);
    if (record !== undefined) {
      return record.reason;
    }
  }
  return undefined;
}

function nearestPartialMatches(
  expectation: EvalFindingExpectation,
  artifacts: EvalArtifacts,
  target: "all" | "candidates"
): EvalLossDetail["nearestInstances"] {
  if (expectation.path === undefined) {
    return [];
  }
  const findings: Array<{ artifact: "candidate-findings" | "final-findings"; finding: ScorableFinding }> = [
    ...artifacts.candidates.map((finding) => ({ artifact: "candidate-findings" as const, finding })),
    ...(target === "all" ? artifacts.finalFindings.map((finding) => ({ artifact: "final-findings" as const, finding })) : [])
  ];
  return findings
    .map(({ artifact, finding }) => ({ artifact, finding, outcome: matchExpectation(expectation, finding, artifacts) }))
    .filter((item) =>
      findingLocationVariants(item.finding, artifacts).some((location) => pathMatches(expectation.path ?? "", location.path)) &&
      !item.outcome.matched
    )
    .sort((a, b) => failedFieldCount(a.outcome) - failedFieldCount(b.outcome))
    .slice(0, 5)
    .map((item) => ({
      findingId: item.finding.id,
      artifact: item.artifact,
      outcome: "same path, field mismatch",
      fieldMismatches: item.outcome.fields.filter((field) => !field.matched)
    }));
}

function matchingHints(expectation: EvalFindingExpectation, hints: EvalHintEvent[]): EvalLossDetail["matchingHints"] {
  const comparable = expectation.path !== undefined ||
    expectation.titlePattern !== undefined ||
    expectation.failureModePattern !== undefined;
  if (!comparable) {
    return [];
  }
  return hints.flatMap((hint) => {
    if (expectation.path !== undefined && !hint.files.some((file) => pathMatches(expectation.path ?? "", normalizePath(file)))) {
      return [];
    }
    const text = [hint.question, hint.reason ?? "", ...hint.symbols].join("\n");
    if (expectation.titlePattern !== undefined && !regexMatches(expectation.titlePattern, text)) {
      return [];
    }
    if (expectation.failureModePattern !== undefined && !regexMatches(expectation.failureModePattern, text)) {
      return [];
    }
    return [{
      ...(hint.packetId !== undefined ? { packetId: hint.packetId } : {}),
      question: hint.question,
      files: hint.files,
      symbols: hint.symbols,
      confidence: hint.confidence
    }];
  });
}

function missedSubReason(expectation: EvalFindingExpectation, artifacts: EvalArtifacts): string {
  if (expectation.path === undefined) {
    return "unknown";
  }
  const records = coverageRecords(artifacts);
  const anyPacket = artifacts.packets.some((packet) => pathMatches(expectation.path ?? "", normalizePath(packet.path)));
  const anyCoverage = records.some((record) =>
    typeof record.path === "string" && pathMatches(expectation.path ?? "", normalizePath(record.path))
  );
  if (!anyPacket && !anyCoverage) {
    return "path-not-in-diff";
  }
  const failed = records.find((record) =>
    record.status === "review_failed" && coverageRecordCoversExpectation(record, expectation, artifacts)
  );
  if (failed !== undefined) {
    return "packet-review-failed";
  }
  const plannerSkipped = records.find((record) =>
    record.status === "skipped" &&
    coverageRecordCoversExpectation(record, expectation, artifacts) &&
    isPlannerSkipRecord(record, artifacts)
  );
  if (plannerSkipped !== undefined) {
    return "hunk-skipped-by-planner";
  }
  const filterSkipped = records.find((record) =>
    record.status === "skipped" && coverageRecordCoversExpectation(record, expectation, artifacts)
  );
  if (filterSkipped !== undefined) {
    return "file-filtered";
  }
  const reviewed = artifacts.packets.some((packet) => packetOverlapsExpectation(packet, expectation));
  return reviewed ? "reviewed-no-candidate" : "unknown";
}

function packetCoverageDetails(
  expectation: EvalFindingExpectation,
  artifacts: EvalArtifacts
): Pick<EvalLossDetail, "coveringPacketIds" | "coveringPacketLenses" | "plannerCoverage"> {
  const packets = artifacts.packets.filter((packet) => packetOverlapsExpectation(packet, expectation));
  const details: Pick<EvalLossDetail, "coveringPacketIds" | "coveringPacketLenses" | "plannerCoverage"> = {};
  if (packets.length > 0) {
    details.coveringPacketIds = packets.map((packet) => packet.id);
    details.coveringPacketLenses = [...new Set(packets.flatMap((packet) => packet.lenses))].sort();
  }
  const coverage = artifacts.reviewPlan?.coverage.find((decision) =>
    expectation.path !== undefined && pathMatches(expectation.path, normalizePath(decision.path))
  );
  if (coverage !== undefined) {
    details.plannerCoverage = coverage.coverage;
  }
  return details;
}

function packetOverlapsExpectation(packet: { path: string; hunks: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number }> }, expectation: EvalFindingExpectation): boolean {
  if (expectation.path !== undefined && !pathMatches(expectation.path, normalizePath(packet.path))) {
    return false;
  }
  if (expectation.lineRange === undefined) {
    return true;
  }
  return packet.hunks.some((hunk) =>
    packetHunkOverlapsLineRange(hunk, expectation.lineRange ?? [0, 0])
  );
}

function coverageRecords(artifacts: EvalArtifacts): Array<Record<string, unknown>> {
  const hunks = artifacts.coverage?.hunks;
  return Array.isArray(hunks) ? hunks.filter(isRecord) : [];
}

function coverageRecordCoversExpectation(
  record: Record<string, unknown>,
  expectation: EvalFindingExpectation,
  artifacts: EvalArtifacts
): boolean {
  if (typeof record.path !== "string" || !pathMatches(expectation.path ?? "", normalizePath(record.path))) {
    return false;
  }
  if (expectation.lineRange === undefined) {
    return true;
  }
  if (typeof record.hunkId !== "string") {
    return true;
  }
  const hunk = artifacts.packets
    .flatMap((packet) => packet.hunks)
    .find((candidate) => candidate.hunkId === record.hunkId);
  return hunk === undefined || packetHunkOverlapsLineRange(hunk, expectation.lineRange);
}

function isPlannerSkipRecord(record: Record<string, unknown>, artifacts: EvalArtifacts): boolean {
  if (typeof record.hunkId !== "string") {
    return false;
  }
  return artifacts.reviewPlan?.coverage.some((decision) =>
    decision.hunkId === record.hunkId &&
    decision.coverage === "skip" &&
    (typeof record.path !== "string" || normalizePath(decision.path) === normalizePath(record.path))
  ) === true;
}

function packetHunkOverlapsLineRange(
  hunk: { oldStart: number; oldLines: number; newStart: number; newLines: number },
  lineRange: [number, number]
): boolean {
  return rangesOverlap(lineRange, [hunk.newStart, hunk.newStart + Math.max(0, hunk.newLines - 1)]) ||
    rangesOverlap(lineRange, [hunk.oldStart, hunk.oldStart + Math.max(0, hunk.oldLines - 1)]);
}

function addHints(detail: EvalLossDetail, hints: EvalLossDetail["matchingHints"]): EvalLossDetail {
  return hints !== undefined && hints.length > 0 ? { ...detail, matchingHints: hints } : detail;
}

function augment(
  expectationIndex: number,
  seenFindings: Set<number>,
  matches: boolean[][],
  findingToExpectation: number[]
): boolean {
  for (let findingIndex = 0; findingIndex < findingToExpectation.length; findingIndex += 1) {
    if (seenFindings.has(findingIndex) || matches[expectationIndex]?.[findingIndex] !== true) {
      continue;
    }
    seenFindings.add(findingIndex);
    const currentExpectationIndex = findingToExpectation[findingIndex];
    if (currentExpectationIndex === -1 ||
      (currentExpectationIndex !== undefined && augment(currentExpectationIndex, seenFindings, matches, findingToExpectation))) {
      findingToExpectation[findingIndex] = expectationIndex;
      return true;
    }
  }
  return false;
}

function matchCategory(
  expected: FindingCategory,
  finding: ScorableFinding,
  artifacts?: EvalArtifacts
): FieldMatch {
  const views = findingMatchViews(finding, artifacts);
  const actual = uniqueStrings(views.map((view) => view.category));
  const exact = views.find((view) => view.category === expected);
  if (exact !== undefined) {
    return { matched: true, actual: actual.join(", "), via: exact.source === "finding" ? "category" : exact.source };
  }
  const compatible = views.find((view) => categoriesCompatible(expected, view.category));
  if (compatible !== undefined) {
    return { matched: true, actual: actual.join(", "), via: "category-compatible" };
  }
  return { matched: false, actual: actual.join(", ") };
}

function matchSeverity(
  expected: Severity,
  finding: ScorableFinding,
  artifacts?: EvalArtifacts
): FieldMatch {
  const views = findingMatchViews(finding, artifacts);
  const actual = uniqueStrings(views.map((view) => view.severity));
  const matched = views.some((view) => severityRank[view.severity] >= severityRank[expected]);
  return {
    matched,
    actual: actual.join(", "),
    ...(matched && views.some((view) => view.source !== "finding" && severityRank[view.severity] >= severityRank[expected])
      ? { via: "merged-candidate" }
      : {})
  };
}

function matchTitlePattern(
  pattern: string,
  finding: ScorableFinding,
  artifacts?: EvalArtifacts
): FieldMatch {
  const checks: Array<{ value: string; via: string }> = [];
  for (const view of findingMatchViews(finding, artifacts)) {
    checks.push({ value: view.title, via: view.source === "finding" ? "title" : "mergedTitle" });
    if (view.finalBody !== undefined) {
      checks.push({ value: firstParagraph(view.finalBody), via: "body" });
    }
  }
  return matchPatternAcrossText(pattern, checks);
}

function matchFailureModePattern(
  pattern: string,
  finding: ScorableFinding,
  artifacts?: EvalArtifacts
): FieldMatch {
  const checks = findingMatchViews(finding, artifacts).map((view) => ({
    value: view.failureMode,
    via: view.source === "finding" ? "failureMode" : "mergedFailureMode"
  }));
  return matchPatternAcrossText(pattern, checks);
}

function matchPatternAcrossText(pattern: string, checks: Array<{ value: string; via: string }>): FieldMatch {
  const actual = uniqueStrings(checks.map((check) => check.value)).join(" | ");
  for (const check of checks) {
    if (regexMatches(pattern, check.value)) {
      return { matched: true, actual: check.value, via: check.via };
    }
  }
  for (const check of checks) {
    if (tokenFallbackMatches(pattern, check.value)) {
      return { matched: true, actual: check.value, via: "tokenFallback" };
    }
  }
  return { matched: false, actual };
}

function findingMatchViews(finding: ScorableFinding, artifacts?: EvalArtifacts): FindingMatchView[] {
  const views: FindingMatchView[] = [{
    id: finding.id,
    title: finding.title,
    category: finding.category,
    severity: finding.severity,
    failureMode: finding.failureMode,
    ...(isFinalFinding(finding) ? { finalBody: finding.finalBody } : {}),
    source: "finding"
  }];

  if (artifacts !== undefined && isFinalFinding(finding)) {
    const sourceCandidates = sourceCandidatesForFinal(finding, artifacts);
    for (const candidate of sourceCandidates) {
      views.push({
        id: candidate.id,
        title: candidate.title,
        category: candidate.category,
        severity: candidate.severity,
        failureMode: candidate.failureMode,
        source: "merged-candidate"
      });
    }
    if (sourceCandidates.length === 0) {
      views.push(...metadataViewsForFinal(finding));
    }
  }

  return dedupeMatchViews(views);
}

function metadataViewsForFinal(finding: FinalFinding): FindingMatchView[] {
  const count = Math.max(
    finding.mergedTitles?.length ?? 0,
    finding.mergedCategories?.length ?? 0,
    finding.mergedSeverities?.length ?? 0
  );
  const views: FindingMatchView[] = [];
  for (let index = 0; index < count; index += 1) {
    const title = finding.mergedTitles?.[index];
    const category = finding.mergedCategories?.[index];
    const severity = finding.mergedSeverities?.[index];
    if (title === undefined && category === undefined && severity === undefined) {
      continue;
    }
    views.push({
      title: title ?? finding.title,
      category: category ?? finding.category,
      severity: severity ?? finding.severity,
      failureMode: finding.failureMode,
      source: "merged-metadata"
    });
  }
  return views;
}

function dedupeMatchViews(views: FindingMatchView[]): FindingMatchView[] {
  const seen = new Set<string>();
  const output: FindingMatchView[] = [];
  for (const view of views) {
    const key = [
      view.id ?? "",
      view.title,
      view.category,
      view.severity,
      view.failureMode,
      view.source
    ].join("\0");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(view);
  }
  return output;
}

function categoriesCompatible(expected: FindingCategory, actual: FindingCategory): boolean {
  return (expected === "correctness" && actual === "logic_bug") ||
    (expected === "logic_bug" && actual === "correctness");
}

function firstParagraph(input: string): string {
  return input.split(/\n\s*\n/u)[0]?.trim() ?? input.trim();
}

function matchFindingLocation(
  expectation: EvalFindingExpectation,
  finding: ScorableFinding,
  artifacts?: EvalArtifacts
): {
  pathMatched: boolean;
  lineRangeMatched: boolean;
  actualPaths: string[];
  actualRanges: string[];
} {
  const variants = findingLocationVariants(finding, artifacts);
  const pathMatchedVariants = expectation.path === undefined
    ? variants
    : variants.filter((variant) => pathMatches(expectation.path ?? "", variant.path));
  const rangeCandidates = expectation.path === undefined ? variants : pathMatchedVariants;
  const pathMatched = expectation.path === undefined || pathMatchedVariants.length > 0;
  const lineRangeMatched = expectation.lineRange === undefined ||
    rangeCandidates.some((variant) => variant.range !== undefined && rangesOverlap(expectation.lineRange ?? [0, 0], variant.range));

  return {
    pathMatched,
    lineRangeMatched,
    actualPaths: uniqueStrings(variants.map((variant) => variant.path)),
    actualRanges: uniqueStrings(rangeCandidates.flatMap((variant) =>
      variant.range === undefined ? [] : [`${variant.path}:${variant.range[0]}-${variant.range[1]}`]
    ))
  };
}

function findingLocationVariants(finding: ScorableFinding, artifacts?: EvalArtifacts): FindingLocationVariant[] {
  const variants: FindingLocationVariant[] = [];
  addFindingLocationVariant(variants, finding, "finding", finding.id);

  if (artifacts !== undefined && isFinalFinding(finding)) {
    const sourceCandidates = sourceCandidatesForFinal(finding, artifacts);
    for (const candidate of sourceCandidates) {
      addFindingLocationVariant(variants, candidate, "merged-candidate", candidate.id);
      addRelatedEvidenceLocationVariants(variants, candidate, "related-evidence", candidate.id);
    }
    if (sourceCandidates.length === 0) {
      addFinalMetadataLocationVariants(variants, finding);
    }
    addRelatedEvidenceLocationVariants(variants, finding, "related-evidence", finding.id);
  }

  return dedupeLocationVariants(variants);
}

function addFinalMetadataLocationVariants(variants: FindingLocationVariant[], finding: FinalFinding): void {
  for (const anchor of finding.mergedAnchors ?? []) {
    const start = anchor.startLine ?? anchor.line;
    const end = anchor.line;
    variants.push({
      path: normalizePath(anchor.path),
      range: [Math.min(start, end), Math.max(start, end)],
      source: "merged-candidate"
    });
  }
  for (const path of finding.mergedPaths ?? []) {
    variants.push({
      path: normalizePath(path),
      source: "merged-candidate"
    });
  }
}

function addFindingLocationVariant(
  variants: FindingLocationVariant[],
  finding: ScorableFinding,
  source: FindingLocationVariant["source"],
  findingId?: string
): void {
  const path = normalizePath(finding.anchor?.path ?? finding.path);
  const range = findingLineRange(finding);
  variants.push({
    path,
    ...(range !== undefined ? { range } : {}),
    source,
    ...(findingId !== undefined ? { findingId } : {})
  });
}

function addRelatedEvidenceLocationVariants(
  variants: FindingLocationVariant[],
  finding: ScorableFinding,
  source: FindingLocationVariant["source"],
  findingId?: string
): void {
  for (const related of finding.evidence.relatedCode ?? []) {
    variants.push({
      path: normalizePath(related.path),
      source,
      ...(findingId !== undefined ? { findingId } : {})
    });
  }
}

function sourceCandidatesForFinal(finding: FinalFinding, artifacts: EvalArtifacts): CandidateFinding[] {
  const sourceIds = new Set<string>([finding.id, ...finding.mergedCandidateIds]);
  for (const record of artifacts.finalSelection) {
    if (record.mergedIntoFingerprint === finding.fingerprint) {
      sourceIds.add(record.findingId);
    }
  }
  const candidatesById = new Map(artifacts.candidates.map((candidate) => [candidate.id, candidate]));
  return [...sourceIds].flatMap((id) => {
    const candidate = candidatesById.get(id);
    return candidate === undefined ? [] : [candidate];
  });
}

function dedupeLocationVariants(variants: FindingLocationVariant[]): FindingLocationVariant[] {
  const seen = new Set<string>();
  const output: FindingLocationVariant[] = [];
  for (const variant of variants) {
    const range = variant.range === undefined ? "" : `${variant.range[0]}-${variant.range[1]}`;
    const key = `${variant.path}:${range}:${variant.source}:${variant.findingId ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(variant);
  }
  return output;
}

function uniqueStrings(input: string[]): string[] {
  return [...new Set(input)].sort();
}

function isFinalFinding(finding: ScorableFinding): finding is FinalFinding {
  return Array.isArray((finding as FinalFinding).mergedCandidateIds) &&
    typeof (finding as FinalFinding).fingerprint === "string";
}

function findingLineRange(finding: ScorableFinding): [number, number] | undefined {
  if (finding.anchor === undefined) {
    return undefined;
  }
  const start = finding.anchor.startLine ?? finding.anchor.line;
  const end = finding.anchor.line;
  return [Math.min(start, end), Math.max(start, end)];
}

function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return Math.max(a[0], b[0]) <= Math.min(a[1], b[1]);
}

function pathMatches(pattern: string, input: string): boolean {
  const normalizedPattern = normalizePath(pattern);
  if (hasGlobMeta(normalizedPattern)) {
    return picomatch.isMatch(input, normalizedPattern, { dot: true });
  }
  return input === normalizedPattern;
}

function normalizePath(input: string): string {
  return input.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function hasGlobMeta(input: string): boolean {
  return /[*?[\]{}]/u.test(input);
}

function regexMatches(pattern: string, input: string): boolean {
  return new RegExp(pattern, "i").test(input);
}

function tokenFallbackMatches(pattern: string, input: string): boolean {
  const alternatives = tokenAlternativesForPattern(pattern);
  if (alternatives.length === 0) {
    return false;
  }
  const inputTokens = new Set(tokensForText(input));
  return alternatives.some((tokens) => tokens.every((token) => tokenPresent(token, inputTokens)));
}

function tokenPresent(token: string, inputTokens: Set<string>): boolean {
  if (inputTokens.has(token)) {
    return true;
  }
  if (token === "zero") {
    return inputTokens.has("non-positive") || inputTokens.has("nonpositive");
  }
  return false;
}

function tokenAlternativesForPattern(pattern: string): string[][] {
  return pattern
    .split("|")
    .map((part) => tokensForSimplePattern(part))
    .filter((tokens): tokens is string[] => tokens !== undefined && tokens.length >= 2);
}

function tokensForSimplePattern(pattern: string): string[] | undefined {
  const simplified = pattern
    .replace(/\\b/gu, " ")
    .replace(/\\s\+/gu, " ")
    .replace(/\.\*/gu, " ")
    .replace(/[\^$]/gu, " ");
  if (/[()[\]{}+?]/u.test(simplified)) {
    return undefined;
  }
  const tokens = tokensForText(simplified);
  if (tokens.some((token) => token.length < 3)) {
    return undefined;
  }
  return tokens;
}

function tokensForText(input: string): string[] {
  return [...new Set(input.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/gu) ?? [])];
}

function failedFieldCount(outcome: EvalMatchOutcome): number {
  return outcome.fields.filter((field) => !field.matched).length;
}

function isReportedFinalFinding(finding: FinalFinding): finding is FinalFinding & { publication: "inline" | "summary-only" } {
  return finding.publication === "inline" || finding.publication === "summary-only";
}

function normalizeGateReason(reason: string): string {
  if (/invalid_anchor/u.test(reason)) {
    return "invalid-anchor";
  }
  if (/evidence_resolution_lane_limit/u.test(reason)) {
    return "evidence-resolution-lane-limit";
  }
  if (/low_confidence|confidence/u.test(reason)) {
    return "low-confidence-pre-gate-suppressed";
  }
  if (/evidence/u.test(reason)) {
    return "no-evidence";
  }
  if (/failure/u.test(reason)) {
    return "no-failure-mode";
  }
  if (/budget/u.test(reason)) {
    return "budget-exhausted";
  }
  return reason;
}

function numberPath(input: unknown, pathParts: string[]): number | undefined {
  const value = fieldAtPath(input, pathParts);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function fieldAtPath(input: unknown, pathParts: string[]): unknown {
  let cursor = input;
  for (const part of pathParts) {
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function firstNumberPath(paths: Array<[unknown, string[]]>): number | undefined {
  for (const [input, pathParts] of paths) {
    const value = numberPath(input, pathParts);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function isReviewStage(input: number): input is ReviewStage {
  return Number.isInteger(input) && input >= 1 && input <= 11;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}
