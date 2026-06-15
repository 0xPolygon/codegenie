import type {
  EvalBudgetResult,
  EvalCompareReport,
  EvalRunInfo,
  EvalRunMetrics,
  EvalViolation,
  FinalFinding
} from "../types.js";

export function compareToPrevious(
  current: { info: EvalRunInfo; finalFindings: FinalFinding[] },
  previous: { info: EvalRunInfo; finalFindings: FinalFinding[] }
): EvalCompareReport {
  const currentExpectations = new Map(current.info.score.expectationResults.map((result) => [result.expectationId, result]));
  const previousExpectations = new Map(previous.info.score.expectationResults.map((result) => [result.expectationId, result]));
  const currentViolations = keyedViolations(current.info.score.violations);
  const previousViolations = keyedViolations(previous.info.score.violations);
  return {
    caseName: current.info.caseName,
    currentRun: current.info.runNumber,
    previousRun: previous.info.runNumber,
    caseHashChanged: current.info.caseHash !== previous.info.caseHash,
    ...(current.info.score.status !== previous.info.score.status
      ? { statusChange: { from: previous.info.score.status, to: current.info.score.status } }
      : {}),
    regressions: [...currentExpectations.values()].flatMap((result) => {
      const previousResult = previousExpectations.get(result.expectationId);
      return previousResult?.status === "pass" && result.status === "fail"
        ? [{ expectationId: result.expectationId, ...(result.loss !== undefined ? { lossLabel: result.loss.label } : {}) }]
        : [];
    }),
    fixes: [...currentExpectations.values()].flatMap((result) => {
      const previousResult = previousExpectations.get(result.expectationId);
      return previousResult?.status === "fail" && result.status === "pass"
        ? [{ expectationId: result.expectationId }]
        : [];
    }),
    lossLabelChanges: [...currentExpectations.values()].flatMap((result) => {
      const previousResult = previousExpectations.get(result.expectationId);
      const from = previousResult?.loss?.label;
      const to = result.loss?.label;
      return previousResult?.status === "fail" && result.status === "fail" && from !== undefined && to !== undefined && from !== to
        ? [{ expectationId: result.expectationId, from, to }]
        : [];
    }),
    newViolations: [...currentViolations.entries()]
      .filter(([key]) => !previousViolations.has(key))
      .map(([, violation]) => violation),
    resolvedViolations: [...previousViolations.entries()]
      .filter(([key]) => !currentViolations.has(key))
      .map(([, violation]) => violation),
    budgetChanges: budgetChanges(current.info.score.budgetResults, previous.info.score.budgetResults),
    findingDiff: diffFindings(current.finalFindings, previous.finalFindings),
    metricDeltas: metricDeltas(current.info.score.metrics, previous.info.score.metrics)
  };
}

export function renderEvalCompareText(report: EvalCompareReport): string {
  const lines = [
    `Compare ${report.caseName}: run ${report.previousRun} -> ${report.currentRun}`,
    report.caseHashChanged ? "Case YAML changed between runs." : "Case YAML unchanged."
  ];
  if (report.statusChange) {
    lines.push(`Status: ${report.statusChange.from} -> ${report.statusChange.to}`);
  }
  if (report.regressions.length > 0) {
    lines.push(`Regressions: ${report.regressions.map((item) => item.expectationId).join(", ")}`);
  }
  if (report.fixes.length > 0) {
    lines.push(`Fixes: ${report.fixes.map((item) => item.expectationId).join(", ")}`);
  }
  if (report.newViolations.length > 0) {
    lines.push(`New violations: ${report.newViolations.map((item) => `${item.expectationId}/${item.findingId}`).join(", ")}`);
  }
  if (report.resolvedViolations.length > 0) {
    lines.push(`Resolved violations: ${report.resolvedViolations.map((item) => `${item.expectationId}/${item.findingId}`).join(", ")}`);
  }
  lines.push(`Findings: +${report.findingDiff.added.length} -${report.findingDiff.removed.length} ~${report.findingDiff.changed.length}`);
  const cacheMetricLines = renderCacheMetricDeltaLines(report.metricDeltas);
  if (cacheMetricLines.length > 0) {
    lines.push("Cache metrics:");
    lines.push(...cacheMetricLines.map((line) => `  ${line}`));
  }
  return `${lines.join("\n")}\n`;
}

function budgetChanges(
  current: EvalBudgetResult[],
  previous: EvalBudgetResult[]
): Array<{ check: string; from: "pass" | "fail" | "skipped"; to: "pass" | "fail" | "skipped" }> {
  const previousByKey = new Map(previous.map((result) => [budgetKey(result), result]));
  return current.flatMap((result) => {
    const prior = previousByKey.get(budgetKey(result));
    return prior !== undefined && prior.status !== result.status
      ? [{ check: budgetKey(result), from: prior.status, to: result.status }]
      : [];
  });
}

function diffFindings(
  current: FinalFinding[],
  previous: FinalFinding[]
): EvalCompareReport["findingDiff"] {
  const currentByFingerprint = new Map(current.map((finding) => [finding.fingerprint, finding]));
  const previousByFingerprint = new Map(previous.map((finding) => [finding.fingerprint, finding]));
  return {
    added: [...currentByFingerprint.entries()]
      .filter(([fingerprint]) => !previousByFingerprint.has(fingerprint))
      .map(([, finding]) => ({
        fingerprint: finding.fingerprint,
        title: finding.title,
        severity: finding.severity,
        publication: finding.publication
      })),
    removed: [...previousByFingerprint.entries()]
      .filter(([fingerprint]) => !currentByFingerprint.has(fingerprint))
      .map(([, finding]) => ({
        fingerprint: finding.fingerprint,
        title: finding.title,
        severity: finding.severity,
        publication: finding.publication
      })),
    changed: [...currentByFingerprint.entries()].flatMap(([fingerprint, finding]) => {
      const prior = previousByFingerprint.get(fingerprint);
      if (!prior) {
        return [];
      }
      const changes = findingChanges(finding, prior);
      return Object.keys(changes).length > 0 ? [{ fingerprint, changes }] : [];
    })
  };
}

function findingChanges(current: FinalFinding, previous: FinalFinding): Record<string, { from: string; to: string }> {
  const fields: Array<[string, string, string]> = [
    ["title", previous.title, current.title],
    ["severity", previous.severity, current.severity],
    ["confidence", previous.confidence, current.confidence],
    ["publication", previous.publication, current.publication],
    ["path", previous.path, current.path],
    ["line", String(previous.anchor?.line ?? ""), String(current.anchor?.line ?? "")]
  ];
  return Object.fromEntries(fields.filter(([, from, to]) => from !== to).map(([field, from, to]) => [field, { from, to }]));
}

function metricDeltas(current: EvalRunMetrics, previous: EvalRunMetrics): EvalCompareReport["metricDeltas"] {
  const output: EvalCompareReport["metricDeltas"] = {};
  const currentFlat = flattenNumericMetrics(current);
  const previousFlat = flattenNumericMetrics(previous);
  for (const key of [...new Set([...Object.keys(currentFlat), ...Object.keys(previousFlat)])].sort()) {
    const currentValue = currentFlat[key];
    const previousValue = previousFlat[key];
    output[key] = {
      ...(previousValue !== undefined ? { previous: previousValue } : {}),
      ...(currentValue !== undefined ? { current: currentValue } : {}),
      ...(previousValue !== undefined && currentValue !== undefined ? { delta: currentValue - previousValue } : {})
    };
  }
  return output;
}

function flattenNumericMetrics(metrics: EvalRunMetrics): Record<string, number> {
  const output: Record<string, number> = {};
  const localCacheHits = metrics.localModelCallCacheHits ?? metrics.cacheHits;
  const localCacheMisses = metrics.localModelCallCacheMisses ?? metrics.cacheMisses;
  if (localCacheHits !== undefined) {
    output.localModelCallCacheHits = localCacheHits;
  }
  if (localCacheMisses !== undefined) {
    output.localModelCallCacheMisses = localCacheMisses;
  }
  if (metrics.localModelCallCacheWrites !== undefined) {
    output.localModelCallCacheWrites = metrics.localModelCallCacheWrites;
  }
  const localCacheKeys = new Set(["localModelCallCacheHits", "localModelCallCacheMisses", "localModelCallCacheWrites", "cacheHits", "cacheMisses"]);
  for (const [key, value] of Object.entries(metrics)) {
    if (localCacheKeys.has(key)) {
      continue;
    }
    if (typeof value === "number") {
      output[key] = value;
      continue;
    }
    if (key === "stageLossCounts" && isRecord(value)) {
      for (const [lossLabel, count] of Object.entries(value)) {
        if (typeof count === "number") {
          output[`stageLossCounts.${lossLabel}`] = count;
        }
      }
    }
  }
  return output;
}

function renderCacheMetricDeltaLines(metricDeltas: EvalCompareReport["metricDeltas"]): string[] {
  return Object.entries(cacheMetricLabels)
    .flatMap(([key, label]) => {
      const delta = metricDeltas[key];
      if (delta === undefined) {
        return [];
      }
      return [`${label}: ${formatMetricDelta(delta)}`];
    });
}

const cacheMetricLabels: Record<string, string> = {
  localModelCallCacheHits: "local model-call cache hits",
  localModelCallCacheMisses: "local model-call cache misses",
  localModelCallCacheWrites: "local model-call cache writes",
  providerPromptCacheReadTokens: "provider prompt cache read tokens",
  providerPromptCacheWriteTokens: "provider prompt cache write tokens",
  providerPromptCacheReadCostUSD: "provider prompt cache read cost USD",
  providerPromptCacheWriteCostUSD: "provider prompt cache write cost USD"
};

function formatMetricDelta(delta: EvalCompareReport["metricDeltas"][string]): string {
  const previous = delta.previous !== undefined ? formatNumber(delta.previous) : "n/a";
  const current = delta.current !== undefined ? formatNumber(delta.current) : "n/a";
  const change = delta.delta !== undefined ? ` (${formatSignedNumber(delta.delta)})` : "";
  return `${previous} -> ${current}${change}`;
}

function formatSignedNumber(value: number): string {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
}

function keyedViolations(violations: EvalViolation[]): Map<string, EvalViolation> {
  return new Map(violations.map((violation) => [`${violation.expectationId}:${violation.findingId}`, violation]));
}

function budgetKey(result: EvalBudgetResult): string {
  return result.stage === undefined ? result.check : `${result.check}:${result.stage}`;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}
