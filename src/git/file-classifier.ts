import picomatch from "picomatch";
import type {
  ClassificationPathRule,
  CodeninjaConfig,
  DiffFile,
  FileFacts,
  FileFilterDecision,
  FactProvenance,
  ProcessingMode,
  ResolvedReviewInput,
  ReviewPriority,
  UnifiedDiff
} from "../types.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import { createGitClient, type InternalGitClient } from "./git-client.js";
import {
  detectFile,
  detectPackageRoot,
  type FileDetectionResult
} from "./detectors.js";

type ClassifierOptions = {
  git?: InternalGitClient;
};

type MatchedRule = {
  rule: ClassificationPathRule;
  provenance: FactProvenance;
};

const detectionMemoByDecisions = new WeakMap<FileFilterDecision[], Map<string, FileDetectionResult>>();

export async function filterDiffFiles(
  resolved: ResolvedReviewInput,
  diff: UnifiedDiff,
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  opts: ClassifierOptions = {}
): Promise<{ kept: DiffFile[]; decisions: FileFilterDecision[] }> {
  const git = opts.git ?? createGitClient(resolved.repoRoot);
  const memo = new Map<string, FileDetectionResult>();
  const kept: DiffFile[] = [];
  const decisions: FileFilterDecision[] = [];

  for (const file of diff.files) {
    const detections = await detectFile(resolved, file, git);
    memo.set(file.path, detections);
    const decision = filterDecision(file, detections, config);
    decisions.push(decision);
    if (decision.action === "keep") {
      kept.push(file);
    }
  }

  detectionMemoByDecisions.set(decisions, memo);
  telemetry.event({
    stage: 2,
    level: "info",
    message: "diff files filtered",
    data: {
      total: diff.files.length,
      kept: kept.length,
      skipped: decisions.filter((decision) => decision.action === "skip").length
    }
  });

  return { kept, decisions };
}

export async function classifyChangedFiles(
  resolved: ResolvedReviewInput,
  kept: DiffFile[],
  decisions: FileFilterDecision[],
  config: CodeninjaConfig,
  telemetry: TelemetryRecorder,
  opts: ClassifierOptions = {}
): Promise<FileFacts[]> {
  const git = opts.git ?? createGitClient(resolved.repoRoot);
  const memo = detectionMemoByDecisions.get(decisions) ?? new Map<string, FileDetectionResult>();
  const treePaths = await headTreePaths(resolved, git);
  const facts: FileFacts[] = [];

  for (const file of kept) {
    let detections = memo.get(file.path);
    if (!detections) {
      detections = await detectFile(resolved, file, git);
      memo.set(file.path, detections);
    }

    const packageRoot = detectPackageRoot(file.path, treePaths);
    const matchedRules = matchPathRules(file, config.classification.pathRules);
    const labels: string[] = [];
    const reasons: string[] = [];
    const provenance: FactProvenance[] = [
      detections.language.provenance,
      detections.testStatus.provenance,
      detections.generated.provenance,
      detections.vendored.provenance,
      detections.lockfile.provenance,
      detections.binary.provenance
    ];
    if (packageRoot.value !== undefined) {
      provenance.push(packageRoot.provenance);
    }

    let reviewPriority: ReviewPriority = "normal";
    let configuredProcessingMode: Exclude<ProcessingMode, "skip"> | undefined;

    for (const match of matchedRules) {
      if (match.rule.labels) {
        for (const label of match.rule.labels) {
          addUnique(labels, label);
          provenance.push({ ...match.provenance, fact: "label" });
          reasons.push(`label '${label}' from path rule: ${match.rule.reason}`);
        }
      }
      if (match.rule.reviewPriority !== undefined) {
        reviewPriority = match.rule.reviewPriority;
        provenance.push({ ...match.provenance, fact: "reviewPriority" });
        reasons.push(`review priority ${reviewPriority} from path rule: ${match.rule.reason}`);
      }
      if (match.rule.processingMode !== undefined && match.rule.processingMode !== "skip") {
        configuredProcessingMode = match.rule.processingMode;
        provenance.push({ ...match.provenance, fact: "processingMode" });
        reasons.push(`processing mode ${configuredProcessingMode} from path rule: ${match.rule.reason}`);
      }
    }

    if (isPolicyChange(file.path)) {
      addUnique(labels, "policy-change");
      provenance.push({
        fact: "label",
        source: "config",
        confidence: "high",
        reason: "review policy file changed"
      });
      reasons.push("label 'policy-change' because review policy changed");
    }

    const processingMode = chooseProcessingMode(file, configuredProcessingMode, reasons, provenance);
    const fact: FileFacts = {
      path: file.path,
      language: detections.language.value,
      processingMode,
      testStatus: detections.testStatus.value,
      isGenerated: detections.generated.value,
      isVendored: detections.vendored.value,
      isLockfile: detections.lockfile.value,
      isBinary: detections.binary.value,
      changedLines: countChangedLines(file),
      hunkCount: file.hunks.length,
      labels,
      reviewPriority,
      reasons,
      provenance
    };
    if (packageRoot.value !== undefined) {
      fact.packageRoot = packageRoot.value;
    }
    if (file.status === "deleted" && detections.contentReadFailed) {
      fact.degraded = { reason: "base content unavailable for deleted file" };
    }
    facts.push(fact);
  }

  telemetry.event({
    stage: 3,
    level: "info",
    message: "changed files classified",
    data: { files: facts.length }
  });

  return facts;
}

function filterDecision(
  file: DiffFile,
  detections: FileDetectionResult,
  config: CodeninjaConfig
): FileFilterDecision {
  if (detections.binary.value) {
    return skip(file, "binary file", detections.binary.provenance);
  }
  if (detections.lockfile.value) {
    return skip(file, "lockfile", detections.lockfile.provenance);
  }
  if (detections.generated.value) {
    return skip(file, "generated file", detections.generated.provenance);
  }
  if (detections.vendored.value) {
    return skip(file, "vendored/dependency file", detections.vendored.provenance);
  }
  if (detections.ignored.value) {
    return skip(file, "ignored path", detections.ignored.provenance);
  }

  const configuredSkip = effectiveConfiguredSkip(file, config.classification.pathRules);
  if (configuredSkip) {
    return skip(file, "configured skip rule", configuredSkip);
  }
  if (detections.submodule.value) {
    return skip(file, "submodule pointer change", detections.submodule.provenance);
  }
  if (detections.symlink.value) {
    return skip(file, "symlink change", detections.symlink.provenance);
  }
  if (file.modeOnly === true) {
    return skip(file, "mode-only change", {
      fact: "modeOnly",
      source: "diff",
      confidence: "high",
      reason: "file has mode headers and no hunks"
    });
  }

  return {
    path: file.path,
    action: "keep",
    reason: "reviewable file",
    provenance: [
      detections.binary.provenance,
      detections.lockfile.provenance,
      detections.generated.provenance,
      detections.vendored.provenance
    ]
  };
}

function skip(file: DiffFile, reason: string, provenance: FactProvenance): FileFilterDecision {
  return {
    path: file.path,
    action: "skip",
    reason,
    provenance: [provenance]
  };
}

function effectiveConfiguredSkip(
  file: DiffFile,
  rules: ClassificationPathRule[]
): FactProvenance | undefined {
  let skipProvenance: FactProvenance | undefined;
  let lastMode: ProcessingMode | undefined;
  for (const match of matchPathRules(file, rules)) {
    if (match.rule.processingMode !== undefined) {
      lastMode = match.rule.processingMode;
      skipProvenance = { ...match.provenance, fact: "processingMode" };
    }
  }
  return lastMode === "skip" ? skipProvenance : undefined;
}

function matchPathRules(file: DiffFile, rules: ClassificationPathRule[]): MatchedRule[] {
  const paths = file.oldPath ? [file.path, file.oldPath] : [file.path];
  return rules.flatMap((rule) => {
    const matcher = picomatch(rule.pattern, { dot: true });
    if (!paths.some((candidate) => matcher(candidate))) {
      return [];
    }
    return [
      {
        rule,
        provenance: {
          fact: "pathRule",
          source: "config",
          confidence: "high",
          reason: rule.reason
        } satisfies FactProvenance
      }
    ];
  });
}

function chooseProcessingMode(
  file: DiffFile,
  configured: Exclude<ProcessingMode, "skip"> | undefined,
  reasons: string[],
  provenance: FactProvenance[]
): Exclude<ProcessingMode, "skip"> {
  if (configured !== undefined) {
    return configured;
  }
  if (file.status === "added" && countNewLines(file) <= 100) {
    reasons.push("small added file uses whole-file processing");
    provenance.push({
      fact: "processingMode",
      source: "diff",
      confidence: "high",
      reason: "added file has 100 or fewer new lines"
    });
    return "whole-file";
  }
  reasons.push("default per-hunk processing");
  provenance.push({
    fact: "processingMode",
    source: "diff",
    confidence: "high",
    reason: "default reviewable file mode"
  });
  return "per-hunk";
}

async function headTreePaths(resolved: ResolvedReviewInput, git: InternalGitClient): Promise<Set<string>> {
  const head = resolved.headSha ?? resolved.headRef;
  if (!head) {
    return new Set();
  }
  try {
    return new Set(await git.lsTree(head));
  } catch {
    return new Set();
  }
}

function countChangedLines(file: DiffFile): number {
  return file.hunks.reduce(
    (count, hunk) => count + hunk.lines.filter((line) => line.kind === "add" || line.kind === "delete").length,
    0
  );
}

function countNewLines(file: DiffFile): number {
  return file.hunks.reduce(
    (count, hunk) => count + hunk.lines.filter((line) => line.kind === "add" || line.kind === "context").length,
    0
  );
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function isPolicyChange(filePath: string): boolean {
  return filePath === "codeninja.toml" || filePath.startsWith(".codeninja/skills/");
}
