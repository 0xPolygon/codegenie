import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { defaultConfig } from "../src/config/schema.js";
import { createGitClient } from "../src/git/git-client.js";
import { parseDiff } from "../src/git/diff-parser.js";
import { runGit } from "../src/git/subprocess.js";
import { buildReviewPackets, packetDispatchRank, packetReviewContextFromDossier, toolBudget } from "../src/pipeline/packet-builder.js";
import { reconstructComposerGroupsFromArtifacts, reconstructComposerPolicyFromArtifacts } from "../src/pipeline/composer.js";
import {
  reconstructGatedVerifierCandidatesFromArtifacts,
  reconstructDuplicateVerificationVerdict,
  reconstructVerifiedFindingsFromArtifacts
} from "../src/pipeline/verifier.js";
import { buildRepositoryIndex } from "../src/repo/repository-index.js";
import { stripCredentials } from "../src/telemetry/redaction.js";
import { reconstructRunTelemetryDerivedEvidence } from "../src/telemetry/run-artifacts.js";
import type { LlmCallRecord, TelemetryRecorder } from "../src/telemetry/telemetry-recorder.js";
import type {
  CodegenieConfig,
  DiffFile,
  DiffLine,
  EvalBudgetResult,
  EvalCase,
  EvalArtifacts,
  EvalExpectationList,
  EvalExpectationResult,
  EvalInvocationManifest,
  EvalRunInfo,
  EvalSelectionRecord,
  EvalScore,
  EvalVerificationRecord,
  FileFacts,
  FileFilterDecision,
  PacketContextQuality,
  PlannerDossier,
  ResolvedReviewInput,
  ReviewPacket,
  ReviewPlan,
  ReviewProfile,
  RunCoverageStatus,
  CandidateFinding,
  FinalFinding,
  TelemetryEvent,
  ToolBudget,
  ToolCallRecord,
  UnifiedDiff
} from "../src/types.js";
import { sha256Hex } from "../src/util/hashing.js";
import { scaleToolBudget } from "../src/util/budget.js";
import { isLocalToolBudgetRejectionReason } from "../src/util/context-pressure.js";
import { loadEvalCaseDeclaration } from "../src/evals/eval-runner.js";
import { aggregateRepeatScores, scoreEvalRun } from "../src/evals/eval-scoring.js";

const MAX_HUNKS_PER_PACKET = 5;
const MAX_PATCH_CHARS = 12_000;
const EQUIVALENT_TARGET_HUNKS = 142;
const PRODUCTION_BASE_SHA = "d1c49bdf6a8002ec2ec27faac94a932d736532b2";
const PRODUCTION_HEAD_SHA = "fbb5f8761c2c296e115af17e919a7c35d9de8373";
const PRODUCTION_REPO_ROOT = "/home/peter/Dev/0xsequence/trails-api";
const PRODUCTION_TIMEOUT_MS = 60 * 60 * 1000;
const PRODUCTION_CONCURRENCY = 6;
const LEGACY_DIFF_SCHEMA_RUN_IDS = new Set([
  "20260724-135818-740d73f2",
  "20260724-150405-fe1548ae",
  "20260724-162739-81f806a6"
]);
const PROFILE_RANK: Record<ReviewProfile, number> = { simple: 0, standard: 1, investigate: 2 };
const CONTEXT_QUALITY_RANK: Record<PacketContextQuality, number> = {
  path_only: 0,
  outline_only: 1,
  sliced: 2,
  full: 3
};
const DOCS_CONFIG_EXTENSIONS = new Set([".md", ".yml", ".yaml", ".toml", ".conf", ".sample", ".txt"]);

const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/iu);
const jsonObjectSchema = z.record(z.string(), z.unknown());
const nonnegativeIntSchema = z.number().int().nonnegative();
const positiveIntSchema = z.number().int().positive();

const pullRequestMetadataSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: positiveIntSchema,
  title: z.string(),
  body: z.string(),
  url: z.string(),
  baseRefName: z.string(),
  baseSha: commitShaSchema,
  headRefName: z.string(),
  headSha: commitShaSchema
}).strict();

const resolvedInputSchema = z.object({
  mode: z.enum(["github_pr", "branch", "head", "commit_range"]),
  repoRoot: z.string(),
  baseRef: commitShaSchema.optional(),
  baseRefName: z.string().optional(),
  headRef: commitShaSchema.optional(),
  headRefName: z.string().optional(),
  startCommit: commitShaSchema.optional(),
  endCommit: commitShaSchema.optional(),
  mergeBase: commitShaSchema.optional(),
  headSha: commitShaSchema.optional(),
  pr: pullRequestMetadataSchema.optional(),
  commits: z.array(z.object({
    sha: commitShaSchema,
    title: z.string(),
    body: z.string(),
    authorName: z.string().optional(),
    authoredAt: z.string().optional()
  }).strict()),
  rawDiffChars: nonnegativeIntSchema
}).strict();

const diffLineSchema = z.object({
  kind: z.enum(["context", "add", "delete"]),
  content: z.string(),
  oldLineNumber: positiveIntSchema.optional(),
  newLineNumber: positiveIntSchema.optional()
}).strict();

const diffHunkSchema = z.object({
  id: z.string().min(1),
  // The pre-Plan-100 retained artifacts predate persisted hunkHash. Their
  // versioned migration is checked against a freshly parsed diff below.
  hunkHash: z.string().min(1).optional(),
  path: z.string().min(1),
  oldStart: nonnegativeIntSchema,
  oldLines: nonnegativeIntSchema,
  newStart: nonnegativeIntSchema,
  newLines: nonnegativeIntSchema,
  header: z.string(),
  lines: z.array(diffLineSchema)
}).strict();

const diffFileSchema = z.object({
  path: z.string().min(1),
  oldPath: z.string().min(1).optional(),
  status: z.enum(["added", "modified", "deleted", "renamed", "copied"]),
  isBinary: z.boolean().optional(),
  modeOnly: z.boolean().optional(),
  isSymlink: z.boolean().optional(),
  isSubmodule: z.boolean().optional(),
  language: z.string(),
  hunks: z.array(diffHunkSchema)
}).strict();

const unifiedDiffSchema = z.object({ files: z.array(diffFileSchema) }).strict();

const factProvenanceSchema = z.object({
  fact: z.string(),
  source: z.enum(["path", "filename", "extension", "parser", "git", "diff", "config", "generated_detector"]),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string()
}).strict();

const fileFilterDecisionSchema = z.object({
  path: z.string().min(1),
  action: z.enum(["skip", "keep"]),
  reason: z.string(),
  provenance: z.array(factProvenanceSchema)
}).strict();

const fileFactsSchema = z.object({
  path: z.string().min(1),
  language: z.string(),
  packageRoot: z.string().optional(),
  processingMode: z.enum(["per-hunk", "whole-file", "skip"]),
  testStatus: z.enum(["test", "source", "unknown"]),
  isGenerated: z.boolean(),
  isVendored: z.boolean(),
  isLockfile: z.boolean(),
  isBinary: z.boolean(),
  changedLines: nonnegativeIntSchema,
  hunkCount: nonnegativeIntSchema,
  labels: z.array(z.string()),
  reviewPriority: z.enum(["critical", "high", "normal", "low"]),
  reasons: z.array(z.string()),
  provenance: z.array(factProvenanceSchema),
  degraded: z.object({ reason: z.string() }).strict().optional()
}).strict();

const surroundingContextHintSchema = z.object({
  kind: z.enum(["enclosing_symbol", "call_site", "test", "line_range", "other"]),
  path: z.string().optional(),
  symbol: z.string().optional(),
  lineRange: z.tuple([positiveIntSchema, positiveIntSchema]).optional(),
  reason: z.string(),
  expectedUse: z.enum(["packet_context", "tool_lookup"])
}).strict();

const hunkCoverageDecisionSchema = z.object({
  hunkId: z.string().min(1),
  path: z.string().min(1),
  coverage: z.enum(["deep", "normal", "light", "skip"]),
  lenses: z.array(z.string()),
  surroundingContextHints: z.array(surroundingContextHintSchema),
  reason: z.string(),
  focusNotes: z.array(z.string()).optional(),
  relatedSymbols: z.array(z.string()).optional(),
  relatedFiles: z.array(z.string()).optional()
}).strict();

const reviewPlanSchema = z.object({
  diffUnderstanding: z.object({ declaredIntent: z.string(), inferredBehavior: z.string() }).strict(),
  intentSignals: jsonObjectSchema.optional(),
  coverage: z.array(hunkCoverageDecisionSchema),
  plannerRecovery: jsonObjectSchema.optional(),
  partialReview: z.object({
    isPartial: z.boolean(),
    reason: z.string(),
    reviewedHunks: nonnegativeIntSchema,
    totalHunks: nonnegativeIntSchema
  }).strict().optional()
}).strict();

const plannerDossierSchema = z.object({
  commits: z.array(jsonObjectSchema),
  compaction: jsonObjectSchema,
  depth: z.enum(["light", "normal", "deep"]),
  directories: z.array(z.unknown()),
  files: z.array(z.unknown()),
  filterSummary: jsonObjectSchema,
  hunkIndex: z.array(z.unknown()).optional(),
  intentSignals: jsonObjectSchema,
  lenses: z.array(z.object({ id: z.string().min(1), summary: z.string() }).strict()),
  mode: z.enum(["github_pr", "branch", "head", "commit_range"]),
  policyFilesChanged: z.array(z.string()),
  pr: z.object({
    title: z.string(),
    body: z.string(),
    url: z.string(),
    baseRefName: z.string(),
    headRefName: z.string()
  }).strict().optional(),
  runId: z.string().min(1),
  target: z.object({
    baseRef: commitShaSchema.optional(),
    headRef: commitShaSchema.optional(),
    headSha: commitShaSchema.optional(),
    mergeBase: commitShaSchema.optional()
  }).strict(),
  totals: z.object({
    addedLines: nonnegativeIntSchema,
    deletedLines: nonnegativeIntSchema,
    files: nonnegativeIntSchema,
    hunks: nonnegativeIntSchema,
    keptFiles: nonnegativeIntSchema
  }).strict()
}).strict();

const runMetadataSchema = z.object({
  argv: z.array(z.string()),
  budgetStop: z.unknown().nullable(),
  codegenieRuntime: jsonObjectSchema,
  codegenieVersion: z.string(),
  completedAt: z.string().optional(),
  durationMs: nonnegativeIntSchema,
  finishedAt: z.string(),
  nodeVersion: z.string(),
  outcome: jsonObjectSchema,
  repoRoot: z.string(),
  review: jsonObjectSchema,
  runId: z.string().min(1),
  schemaVersion: positiveIntSchema,
  startedAt: z.string(),
  totals: jsonObjectSchema
}).strict();

const toolBudgetSchema = z.object({
  maxToolCalls: z.number().int().nonnegative(),
  maxInvestigationRounds: z.number().int().nonnegative(),
  maxResultChars: z.number().int().nonnegative(),
  maxSingleToolResultChars: z.number().int().nonnegative().optional(),
  reservedSourceResultChars: z.number().int().nonnegative().optional(),
  sourceExtension: z.object({
    maxToolCalls: z.number().int().nonnegative(),
    maxResultChars: z.number().int().nonnegative()
  }).strict().optional()
}).strict();

const packetLineSchema = z.object({
  kind: z.enum(["context", "add", "delete"]),
  oldLine: positiveIntSchema.optional(),
  newLine: positiveIntSchema.optional(),
  content: z.string()
}).strict();

const packetHunkSchema = z.object({
  hunkId: z.string().min(1),
  oldStart: nonnegativeIntSchema,
  oldLines: nonnegativeIntSchema,
  newStart: nonnegativeIntSchema,
  newLines: nonnegativeIntSchema,
  header: z.string().optional(),
  contentWithLineNumbers: z.string(),
  lines: z.array(packetLineSchema),
  changedNewLineNumbers: z.array(positiveIntSchema),
  changedOldLineNumbers: z.array(positiveIntSchema),
  staticSignals: z.array(jsonObjectSchema).optional(),
  omittedSignalCount: nonnegativeIntSchema.optional(),
  truncated: z.boolean().optional(),
  omittedLineCount: nonnegativeIntSchema.optional(),
  plannerFallbackReason: z.string().optional()
}).strict();

const reviewPacketSchema = z.object({
  id: z.string().min(1),
  dispatchRank: z.tuple([nonnegativeIntSchema, z.number().int().nonpositive()]).optional(),
  kind: z.enum(["hunk", "coalesced-hunks", "file-diff", "whole-file"]),
  coverageEscalation: z.object({ rule: z.literal("test_coverage_delta"), reason: z.string() }).strict().optional(),
  prSummary: z.string(),
  intentText: z.string().optional(),
  intentSignals: jsonObjectSchema.optional(),
  path: z.string().min(1),
  oldPath: z.string().min(1).optional(),
  fileStatus: z.enum(["added", "modified", "deleted", "renamed", "copied"]),
  isDeletedContent: z.boolean(),
  language: z.string(),
  reviewPriority: z.enum(["critical", "high", "normal", "low"]),
  coverage: z.enum(["deep", "normal", "light"]),
  reviewProfile: z.enum(["simple", "standard", "investigate"]),
  lenses: z.array(z.string()),
  hunks: z.array(packetHunkSchema).min(1),
  symbolFacts: z.array(jsonObjectSchema),
  context: jsonObjectSchema,
  contextText: z.string(),
  contextQuality: z.enum(["path_only", "outline_only", "sliced", "full"]).optional(),
  contextDegradationReasons: z.array(z.string()).optional(),
  testCoverageDelta: jsonObjectSchema.optional(),
  packetSymbols: z.array(jsonObjectSchema).optional(),
  relevantTests: z.array(jsonObjectSchema),
  surroundingContextHints: z.array(surroundingContextHintSchema),
  labels: z.array(z.string()),
  attentionNotes: z.array(z.string()),
  relatedChangedContext: z.array(jsonObjectSchema),
  toolBudget: toolBudgetSchema,
  degraded: z.object({ reason: z.string() }).strict().optional(),
  fileContext: z.object({ mode: z.enum(["file-diff", "whole-file"]), reason: z.string() }).strict().optional()
}).strict();

const diffAnchorSchema = z.object({
  path: z.string().min(1), line: positiveIntSchema, side: z.enum(["RIGHT", "LEFT"]), hunkId: z.string().min(1),
  startLine: positiveIntSchema.optional(), startSide: z.enum(["RIGHT", "LEFT"]).optional(), commitSha: commitShaSchema.optional()
}).strict();

const candidateFindingSchema = z.object({
  id: z.string().min(1), title: z.string(), severity: z.enum(["critical", "high", "medium", "low"]),
  severityBeforeCap: z.enum(["critical", "high", "medium", "low"]).optional(), confidence: z.enum(["high", "medium", "low"]),
  path: z.string().min(1), anchor: diffAnchorSchema.optional(),
  anchorSource: z.enum(["model", "backfill_changed_code", "backfill_packet_representative", "verifier_revised"]).optional(),
  modelAnchorSubmitted: z.boolean().optional(), changedLine: z.boolean(),
  category: z.enum(["logic_bug", "correctness", "security", "performance", "architecture", "testing", "maintainability"]),
  evidence: z.object({
    changedCode: z.string(), relatedCode: z.array(z.object({ path: z.string(), lines: z.string(), whyRelevant: z.string() }).strict()).optional()
  }).strict(),
  failureMode: z.string(), whyThisMatters: z.string(), suggestedFix: z.string().optional(), suggestedTest: z.string().optional(),
  verification: z.string(), behaviorChange: z.enum(["accidental_regression", "intentional_needs_confirmation", "specified_change", "unknown"]).optional(),
  intentEvidence: z.array(z.string()).optional(),
  producedBy: z.object({
    kind: z.literal("packet"), stage: z.number().int().min(1).max(11), packetId: z.string().min(1), lensId: z.string().min(1),
    skillIds: z.array(z.string()), workerId: z.string().optional(), ensemblePass: positiveIntSchema.optional()
  }).strict(),
  provenance: z.object({
    source: z.literal("uncertainty_promotion"), sourceKind: z.enum(["uncertainty", "follow_up_hint"]), sourcePacketId: z.string(),
    question: z.string(), files: z.array(z.string()), symbols: z.array(z.string()), reason: z.string()
  }).strict().optional(),
  clusterId: z.string().optional(), duplicateOf: z.string().optional()
}).strict();

const finalFindingSchema = candidateFindingSchema.extend({
  fingerprint: z.string().min(1), finalBody: z.string(), publication: z.enum(["inline", "summary-only", "suppressed"]),
  mergedCandidateIds: z.array(z.string()),
  mergedCategories: z.array(z.enum(["logic_bug", "correctness", "security", "performance", "architecture", "testing", "maintainability"])).optional(),
  mergedSeverities: z.array(z.enum(["critical", "high", "medium", "low"])).optional(), mergedPaths: z.array(z.string()).optional(),
  mergedTitles: z.array(z.string()).optional(),
  // Persisted artifacts pass through the shared redactor, which emits this
  // controlled sentinel when mergedAnchors reuses the primary anchor object.
  mergedAnchors: z.array(z.union([diffAnchorSchema, z.literal("[redacted:circular]")])).optional()
}).strict();

const verificationGateFactsSchema = z.object({
  anchorSource: z.enum(["model", "backfill_changed_code", "backfill_packet_representative", "verifier_revised"]).optional(),
  category: z.enum(["logic_bug", "correctness", "security", "performance", "architecture", "testing", "maintainability"]),
  changedLine: z.boolean(), confidence: z.enum(["high", "medium", "low"]), failureModeConcrete: z.boolean(),
  hasChangedCode: z.boolean(), hasFailureMode: z.boolean(), modelAnchorSubmitted: z.boolean(), modelAnchorValid: z.boolean(),
  relatedEvidenceCount: nonnegativeIntSchema, severity: z.enum(["critical", "high", "medium", "low"]), validAnchorPresent: z.boolean()
}).strict();

const candidateProvenanceSchema = z.object({
  source: z.literal("uncertainty_promotion"), sourceKind: z.enum(["uncertainty", "follow_up_hint"]), sourcePacketId: z.string().min(1),
  question: z.string(), files: z.array(z.string()), symbols: z.array(z.string()), reason: z.string()
}).strict();

const verificationVerdictSchema = z.object({
  candidateId: z.string().min(1), verdict: z.enum(["keep", "reject", "revise", "incomplete"]), reason: z.string(),
  requiredEvidencePresent: z.boolean(), falsePositiveRisk: z.enum(["low", "medium", "high"]),
  finalFinding: candidateFindingSchema.optional(), revisedAnchor: diffAnchorSchema.optional(), verificationIncomplete: z.boolean().optional(),
  behaviorChange: z.enum(["accidental_regression", "intentional_needs_confirmation", "specified_change", "unknown"]).optional(),
  intentEvidence: z.array(z.string()).optional()
}).strict();

const verificationRecordBase = {
  candidateId: z.string().min(1), gate: z.enum(["suppressed", "passed", "gate_anchor_stripped"]),
  gateDecision: z.enum(["suppressed", "scheduled", "scheduled_for_evidence_resolution"]).optional(), gateReason: z.string().optional(),
  verificationLane: z.enum(["standard", "evidence_resolution"]).optional(), gateFacts: verificationGateFactsSchema.optional(),
  candidateProvenance: candidateProvenanceSchema.optional(), duplicateOf: z.string().optional(), clusterId: z.string().optional(),
  verificationStatus: z.enum(["completed", "incomplete"]).optional(), incompleteReason: z.string().optional(), errorCode: z.string().optional()
};

const verificationRecordSchema = z.object({ ...verificationRecordBase, verdict: verificationVerdictSchema.optional() }).strict().superRefine((record, ctx) => {
  if (record.gate === "suppressed" && record.gateReason === undefined) {
    ctx.addIssue({ code: "custom", path: ["gateReason"], message: "suppressed verification records require gateReason" });
  }
  if (record.gate === "passed" && record.verdict === undefined) {
    ctx.addIssue({ code: "custom", path: ["verdict"], message: "passed verification records require a verdict" });
  }
});

const selectionRecordSchema = z.object({
  findingId: z.string().min(1), decision: z.enum(["published", "merged", "suppressed"]), reason: z.string(),
  mergedIntoFingerprint: z.string().optional()
}).strict();

const finalSelectionArtifactSchema = z.object({
  composition: z.object({
    mode: z.enum(["llm", "llm_degraded", "deterministic_fallback", "schema_repair_fallback"]), fallbackReason: z.string().optional()
  }).strict(),
  records: z.array(selectionRecordSchema),
  publicationAnchors: z.array(z.object({
    findingId: z.string().min(1), fingerprint: z.string().min(1), publication: z.enum(["inline", "summary-only", "suppressed"]),
    source: z.enum(["selected", "merged", "none"]), reason: z.string(), sourceFindingId: z.string().optional(), anchor: diffAnchorSchema.optional()
  }).strict()),
  confidenceSelections: z.array(z.object({
    findingId: z.string().min(1), confidence: z.enum(["high", "medium", "low"]), representativeConfidence: z.enum(["high", "medium", "low"]),
    sourceFindingId: z.string().optional(), reason: z.enum(["representative", "same_severity", "compatible_lower_severity"])
  }).strict()),
  groups: z.array(z.object({ fingerprint: z.string().min(1), findingIds: z.array(z.string().min(1)).min(1) }).strict())
}).strict();

type FinalSelectionArtifact = z.infer<typeof finalSelectionArtifactSchema>;

const telemetryEventSchema = z.object({
  runId: z.string().min(1),
  eventId: z.string().min(1),
  timestamp: z.string().min(1),
  stage: z.number().int().min(0).max(11),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string().min(1),
  file: z.string().optional(),
  lineRange: z.tuple([positiveIntSchema, positiveIntSchema]).optional(),
  packetId: z.string().optional(),
  lensId: z.string().optional(),
  workerId: z.string().optional(),
  durationMs: nonnegativeIntSchema.optional(),
  cacheStatus: z.enum(["hit", "miss", "disabled", "write"]).optional(),
  data: jsonObjectSchema.optional()
}).strict().superRefine((event, ctx) => {
  if (event.message !== "same_file_atoms_packed") {
    return;
  }
  const parsed = sameFilePackingEventDataSchema.safeParse(event.data);
  if (!parsed.success) {
    ctx.addIssue({ code: "custom", path: ["data"], message: "same_file_atoms_packed data must match the strict packing schema" });
  }
});

const llmCallRecordSchema = z.object({
  callId: z.string().min(1), runId: z.string().min(1), stage: z.number().int().min(0).max(11),
  role: z.enum(["planner", "packetReview", "systemReview", "verifier", "composer"]),
  model: z.string(), provider: z.string(), workerId: z.string().optional(), packetId: z.string().optional(), candidateId: z.string().optional(),
  kind: z.enum(["initial", "tool-continuation", "repair", "finalize"]),
  finalizeMode: z.enum(["compact", "full"]).optional(), finalizeTarget: z.enum(["no_findings", "candidate_or_unknown"]).optional(),
  toolChoiceRequested: z.string().optional(), toolChoiceEffective: z.string().optional(), toolChoiceDowngraded: z.boolean().optional(),
  reasoningRequested: z.string().optional(), reasoningMechanism: z.string().optional(), reasoningLevelEffective: z.string().optional(),
  ttfbMs: nonnegativeIntSchema.optional(), providerHttpStatus: nonnegativeIntSchema.optional(), providerRequestId: z.string().optional(),
  rateLimit: z.record(z.string(), z.string()).optional(), attempt: positiveIntSchema, promptChars: nonnegativeIntSchema, promptHash: z.string(),
  outputChars: nonnegativeIntSchema, outputHash: z.string(), inputTokens: nonnegativeIntSchema.optional(), uncachedInputTokens: nonnegativeIntSchema.optional(),
  cacheReadTokens: nonnegativeIntSchema.optional(), cacheWriteTokens: nonnegativeIntSchema.optional(), billableInputTokens: nonnegativeIntSchema.optional(),
  outputTokens: nonnegativeIntSchema.optional(), reasoningTokens: nonnegativeIntSchema.optional(), totalTokens: nonnegativeIntSchema.optional(),
  costUSD: z.number().nonnegative().optional(), inputCostUSD: z.number().nonnegative().optional(), outputCostUSD: z.number().nonnegative().optional(),
  cacheReadCostUSD: z.number().nonnegative().optional(), cacheWriteCostUSD: z.number().nonnegative().optional(), durationMs: nonnegativeIntSchema,
  cacheStatus: z.enum(["hit", "miss", "disabled", "write"]), schemaValid: z.boolean().optional(),
  stopReason: z.enum(["submit", "tool_calls", "text", "error"]),
  status: z.enum(["ok", "schema_invalid", "transient_error", "auth_error", "timeout", "aborted"]),
  errorCode: z.string().optional(), errorMessage: z.string().optional(), retryable: z.boolean().optional(), retryReason: z.string().optional(),
  maxAttempts: positiveIntSchema.optional(), retryExhausted: z.boolean().optional()
}).strict();

const toolCallRecordSchema = z.object({
  runId: z.string().min(1), toolCallId: z.string().min(1), timestamp: z.string().min(1), stage: z.number().int().min(1).max(11),
  initiator: z.enum(["model", "harness"]), workerId: z.string().optional(), packetId: z.string().optional(), taskId: z.string().optional(),
  candidateId: z.string().optional(), modelCallId: z.string().optional(), tool: z.string().min(1), args: z.object({
    path: z.string().optional(), symbolName: z.string().optional(), line: positiveIntSchema.optional(), startLine: positiveIntSchema.optional(),
    endLine: positiveIntSchema.optional(), query: z.string().optional(), glob: z.string().optional(), source: z.string().optional(),
    contextMode: z.string().optional(), maxResults: positiveIntSchema.optional()
  }).strict(),
  backend: z.enum(["tree-sitter", "text", "language-analyzer"]), precision: z.enum(["exact", "semantic", "syntactic", "heuristic", "text"]),
  engine: z.literal("git-grep").optional(), degraded: z.boolean(), degradationReason: z.string().optional(), truncated: z.boolean().optional(),
  omittedCount: nonnegativeIntSchema.optional(), lookupStatus: z.enum(["found", "not_found", "ambiguous", "file_missing", "unavailable"]).optional(),
  deliveryStatus: z.enum(["full", "truncated", "budget_rejected", "empty"]).optional(), recovery: z.object({
    tool: z.literal("read_range"), path: z.string(), startLine: positiveIntSchema, endLine: positiveIntSchema,
    source: z.enum(["head", "base"]), reason: z.string()
  }).strict().optional(),
  budgetState: z.object({
    toolCallsUsed: nonnegativeIntSchema, maxToolCalls: nonnegativeIntSchema, investigationRoundsUsed: nonnegativeIntSchema,
    maxInvestigationRounds: nonnegativeIntSchema, resultCharsUsed: nonnegativeIntSchema, maxResultChars: nonnegativeIntSchema,
    remainingResultChars: nonnegativeIntSchema, maxSingleToolResultChars: nonnegativeIntSchema.optional(), reservedSourceResultChars: nonnegativeIntSchema.optional(),
    toolResultCharLimit: nonnegativeIntSchema.optional(), sourceExtensionCallsUsed: nonnegativeIntSchema.optional(), sourceExtensionMaxCalls: nonnegativeIntSchema.optional(),
    sourceExtensionResultCharsUsed: nonnegativeIntSchema.optional(), sourceExtensionMaxResultChars: nonnegativeIntSchema.optional(),
    sourceExtensionRemainingResultChars: nonnegativeIntSchema.optional(), sourceExtensionActive: z.boolean().optional()
  }).strict().optional(), cacheStatus: z.enum(["hit", "miss", "disabled", "write"]).optional(), backendExecuted: z.boolean().optional(),
  cacheHitKind: z.enum(["stored", "inflight"]).optional(), cacheEvictedEntries: nonnegativeIntSchema.optional(), resultCount: nonnegativeIntSchema.optional(),
  resultChars: nonnegativeIntSchema, durationMs: nonnegativeIntSchema, status: z.enum(["ok", "error", "rejected", "skipped"]), errorCode: z.string().optional()
}).strict();

const cacheCountsSchema = z.object({
  hit: nonnegativeIntSchema, miss: nonnegativeIntSchema, disabled: nonnegativeIntSchema, write: nonnegativeIntSchema
}).strict();
const providerPromptCacheSchema = z.object({
  readTokens: nonnegativeIntSchema, writeTokens: nonnegativeIntSchema,
  readCostUSD: z.number().nonnegative(), writeCostUSD: z.number().nonnegative()
}).strict();
const modelFinalizeSummarySchema = z.object({
  compactCalls: nonnegativeIntSchema, fullCalls: nonnegativeIntSchema, noFindingCalls: nonnegativeIntSchema,
  candidateOrUnknownCalls: nonnegativeIntSchema, promptChars: nonnegativeIntSchema, noFindingPromptChars: nonnegativeIntSchema,
  candidateOrUnknownPromptChars: nonnegativeIntSchema, costUSD: z.number().nonnegative(), noFindingCostUSD: z.number().nonnegative(),
  candidateOrUnknownCostUSD: z.number().nonnegative(), unknownCostCalls: nonnegativeIntSchema
}).strict();
const schemaRecoveryCountersSchema = z.object({
  schemaInvalidCalls: nonnegativeIntSchema, schemaInvalidRecovered: nonnegativeIntSchema, schemaInvalidUnrecovered: nonnegativeIntSchema,
  schemaRepairAttempts: nonnegativeIntSchema, schemaRepairRecovered: nonnegativeIntSchema,
  deterministicSchemaRecovered: nonnegativeIntSchema, schemaRecoveryFailed: nonnegativeIntSchema
}).strict();
const schemaRecoverySummarySchema = schemaRecoveryCountersSchema.extend({
  byStage: z.record(z.string().regex(/^\d+$/u), schemaRecoveryCountersSchema)
}).strict();
const modelSummaryBaseShape = {
  totalRecords: nonnegativeIntSchema, totalCalls: nonnegativeIntSchema, providerCalls: nonnegativeIntSchema,
  inputTokens: nonnegativeIntSchema, uncachedInputTokens: nonnegativeIntSchema, cacheReadTokens: nonnegativeIntSchema,
  cacheWriteTokens: nonnegativeIntSchema, billableInputTokens: nonnegativeIntSchema, outputTokens: nonnegativeIntSchema,
  reasoningTokens: nonnegativeIntSchema, totalTokens: nonnegativeIntSchema, costUSD: z.number().nonnegative(),
  inputCostUSD: z.number().nonnegative(), outputCostUSD: z.number().nonnegative(), cacheReadCostUSD: z.number().nonnegative(),
  cacheWriteCostUSD: z.number().nonnegative(), unknownCostCalls: nonnegativeIntSchema, cache: cacheCountsSchema,
  retryAttempts: nonnegativeIntSchema, repairCalls: nonnegativeIntSchema, schemaInvalidCalls: nonnegativeIntSchema,
  toolChoiceDowngradedCalls: nonnegativeIntSchema, finalize: modelFinalizeSummarySchema
};
const modelStageSummarySchema = z.object({
  recordCount: nonnegativeIntSchema, count: nonnegativeIntSchema, providerCalls: nonnegativeIntSchema,
  inputTokens: nonnegativeIntSchema, uncachedInputTokens: nonnegativeIntSchema, cacheReadTokens: nonnegativeIntSchema,
  cacheWriteTokens: nonnegativeIntSchema, billableInputTokens: nonnegativeIntSchema, outputTokens: nonnegativeIntSchema,
  reasoningTokens: nonnegativeIntSchema, totalTokens: nonnegativeIntSchema, costUSD: z.number().nonnegative(),
  inputCostUSD: z.number().nonnegative(), outputCostUSD: z.number().nonnegative(), cacheReadCostUSD: z.number().nonnegative(),
  cacheWriteCostUSD: z.number().nonnegative(), unknownCostCalls: nonnegativeIntSchema, cache: cacheCountsSchema,
  retryAttempts: nonnegativeIntSchema, repairCalls: nonnegativeIntSchema, schemaInvalidCalls: nonnegativeIntSchema,
  statuses: z.object({
    ok: nonnegativeIntSchema, schema_invalid: nonnegativeIntSchema, transient_error: nonnegativeIntSchema,
    auth_error: nonnegativeIntSchema, timeout: nonnegativeIntSchema, aborted: nonnegativeIntSchema
  }).strict(),
  finalize: modelFinalizeSummarySchema, localModelCallCache: cacheCountsSchema,
  providerPromptCache: providerPromptCacheSchema, schemaRecovery: schemaRecoveryCountersSchema
}).strict();
const modelCallsSummarySchema = z.object({
  ...modelSummaryBaseShape,
  localModelCallCache: cacheCountsSchema,
  providerPromptCache: providerPromptCacheSchema,
  schemaRecovery: schemaRecoverySummarySchema,
  byStage: z.record(z.string().regex(/^\d+$/u), modelStageSummarySchema)
}).strict();
const costBreakdownSchema = z.object({
  uncachedInput: z.object({ tokens: nonnegativeIntSchema, costUSD: z.number().nonnegative() }).strict(),
  providerPromptCacheRead: z.object({ tokens: nonnegativeIntSchema, costUSD: z.number().nonnegative() }).strict(),
  providerPromptCacheWrite: z.object({ tokens: nonnegativeIntSchema, costUSD: z.number().nonnegative() }).strict(),
  output: z.object({ tokens: nonnegativeIntSchema, costUSD: z.number().nonnegative() }).strict(),
  total: z.object({ tokens: nonnegativeIntSchema, costUSD: z.number().nonnegative() }).strict()
}).strict();
const costProfileStageSchema = modelStageSummarySchema.omit({ schemaRecovery: true }).extend({ costBreakdown: costBreakdownSchema }).strict();
const costProfileSchema = z.object({
  totalCostUSD: z.number().nonnegative(), unknownCostCalls: nonnegativeIntSchema,
  localModelCallCache: cacheCountsSchema, providerPromptCache: providerPromptCacheSchema, costBreakdown: costBreakdownSchema,
  tokens: z.object({
    inputTokens: nonnegativeIntSchema, uncachedInputTokens: nonnegativeIntSchema, cacheReadTokens: nonnegativeIntSchema,
    cacheWriteTokens: nonnegativeIntSchema, billableInputTokens: nonnegativeIntSchema, outputTokens: nonnegativeIntSchema,
    reasoningTokens: nonnegativeIntSchema, totalTokens: nonnegativeIntSchema
  }).strict(),
  cost: z.object({
    inputCostUSD: z.number().nonnegative(), outputCostUSD: z.number().nonnegative(), cacheReadCostUSD: z.number().nonnegative(),
    cacheWriteCostUSD: z.number().nonnegative(), totalCostUSD: z.number().nonnegative()
  }).strict(),
  byStage: z.record(z.string().regex(/^\d+$/u), costProfileStageSchema)
}).strict();
const toolResultCacheSummarySchema = z.object({
  hits: nonnegativeIntSchema, misses: nonnegativeIntSchema, writes: nonnegativeIntSchema, disabled: nonnegativeIntSchema,
  inflightHits: nonnegativeIntSchema, evictions: nonnegativeIntSchema, backendExecutions: nonnegativeIntSchema,
  savedBackendCalls: nonnegativeIntSchema
}).strict();
const toolBucketSummarySchema = z.object({
  count: nonnegativeIntSchema, errors: nonnegativeIntSchema, rejections: nonnegativeIntSchema, degraded: nonnegativeIntSchema,
  backendExecutions: nonnegativeIntSchema, savedBackendCalls: nonnegativeIntSchema, totalDurationMs: nonnegativeIntSchema,
  totalResultChars: nonnegativeIntSchema, resultCache: toolResultCacheSummarySchema,
  averageDurationMs: z.number().nonnegative(), averageResultChars: z.number().nonnegative()
}).strict();
const toolCallsSummarySchema = z.object({
  totalCalls: nonnegativeIntSchema, resultCache: toolResultCacheSummarySchema,
  byTool: z.record(z.string().min(1), toolBucketSummarySchema), byStage: z.record(z.string().regex(/^\d+$/u), toolBucketSummarySchema)
}).strict();

const evalDeclaredExpectationSchema = z.object({
  id: z.string().min(1), tier: z.enum(["required", "optional"]).optional(), path: z.string().min(1).optional(),
  lineRange: z.tuple([positiveIntSchema, positiveIntSchema]).optional(),
  category: z.enum(["logic_bug", "correctness", "security", "performance", "architecture", "testing", "maintainability"]).optional(),
  severityAtLeast: z.enum(["critical", "high", "medium", "low"]).optional(), titlePattern: z.string().min(1).optional(),
  failureModePattern: z.string().min(1).optional(), minRecallRate: z.number().min(0).max(1).optional(), minCandidateRate: z.number().min(0).max(1).optional()
}).strict();

const evalCaseArtifactSchema = z.object({
  name: z.string().min(1), repeat: positiveIntSchema.optional(),
  repo: z.object({ external: z.string().min(1).optional(), fixture: z.string().min(1).optional() }).strict().optional(),
  command: z.object({
    pr: positiveIntSchema.optional(), branch: z.string().min(1).optional(), head: z.string().min(1).optional(),
    base: z.string().min(1).optional(), target: z.string().min(1).optional()
  }).strict().optional(),
  review: z.object({
    depth: z.enum(["light", "normal", "deep"]).optional(), lenses: z.array(z.string().min(1)).optional(), maxFindings: positiveIntSchema.optional(),
    concurrency: positiveIntSchema.optional(), budgetBoost: z.number().positive().optional(), packSameFileHunks: z.boolean().optional(),
    packedToolBudgetMode: z.enum(["base", "atom-scaled"]).optional(), maxTimeMinutes: z.number().positive().optional(),
    maxBudgetTokens: positiveIntSchema.optional(), deepEnsemblePasses: positiveIntSchema.optional(), adaptiveSecondPass: z.boolean().optional(),
    verify: z.boolean().optional(), cache: z.boolean().optional(), cacheDir: z.string().min(1).optional(), debug: z.boolean().optional(),
    provider: z.string().min(1).optional(), model: z.string().min(1).optional(), reasoning: z.string().min(1).optional()
  }).strict().optional(),
  llm: z.object({
    provider: z.string().min(1).optional(), model: z.string().min(1).optional(), reasoning: z.string().min(1).optional(),
    maxConcurrentCalls: positiveIntSchema.optional()
  }).strict().optional(),
  logs: z.object({ dir: z.string().min(1).optional() }).strict().optional(),
  artifacts: z.object({ path: z.string().min(1) }).strict().optional(),
  expect: z.object({
    minFindings: z.number().nonnegative().optional(), maxFindings: z.number().positive().optional(), maxDuplicateGroups: z.number().positive().optional(),
    maxCostUSD: z.number().positive().optional(), maxElapsedSeconds: z.number().positive().optional(), maxModelCalls: z.number().positive().optional(),
    maxToolCalls: z.number().positive().optional(), maxPromptCharsByStage: z.record(z.string(), positiveIntSchema).optional(),
    reviewCompleteness: z.enum(["complete", "partial"]).optional(), maxBudgetOverruns: nonnegativeIntSchema.optional(),
    maxToolBudgetRejections: nonnegativeIntSchema.optional(), maxDegradedHunks: nonnegativeIntSchema.optional(),
    maxUnresolvedNotesSuppressed: nonnegativeIntSchema.optional()
  }).strict().optional(),
  should_find: z.array(evalDeclaredExpectationSchema).optional(),
  should_find_candidate: z.array(evalDeclaredExpectationSchema).optional(),
  should_not_find: z.array(evalDeclaredExpectationSchema).optional()
}).strict();

const evalExpectationResultSchema = z.object({
  expectationId: z.string().min(1), list: z.enum(["should_find", "should_find_candidate", "should_not_find"]),
  tier: z.enum(["required", "optional"]).optional(), status: z.enum(["pass", "fail", "skipped"]), skipReason: z.string().optional(),
  fromReplayedArtifacts: z.boolean().optional(),
  matched: z.array(z.object({ findingId: z.string().min(1), artifact: z.enum(["final-findings", "candidate-findings"]) }).strict()),
  loss: z.object({
    label: z.enum(["missed-before-candidate-generation", "lost-at-verification", "lost-at-composition", "partial-match"]),
    subReason: z.string().optional(), nearestInstances: z.array(z.object({
      findingId: z.string().optional(), artifact: z.enum(["final-findings", "final-selection", "verification", "candidate-findings", "events"]),
      outcome: z.string(), fieldMismatches: z.array(z.object({
        field: z.enum(["path", "lineRange", "category", "severityAtLeast", "titlePattern", "failureModePattern"]),
        present: z.boolean(), matched: z.boolean(), expected: z.string().optional(), actual: z.string().optional(), via: z.string().optional()
      }).strict()).optional()
    }).strict()),
    matchingHints: z.array(z.object({
      packetId: z.string().optional(), question: z.string(), files: z.array(z.string()), symbols: z.array(z.string()),
      confidence: z.enum(["high", "medium", "low"])
    }).strict()).optional(), coveringPacketIds: z.array(z.string()).optional(), coveringPacketLenses: z.array(z.string()).optional(),
    plannerCoverage: z.string().optional(), surfacedAsNote: z.boolean().optional()
  }).strict().optional(), note: z.string().optional()
}).strict();

const evalBudgetResultSchema = z.object({
  check: z.string().min(1), stage: z.number().int().min(1).max(11).optional(), status: z.enum(["pass", "fail", "skipped"]),
  skipReason: z.string().optional(), limit: z.number().optional(), actual: z.number().optional(), expected: z.string().optional(),
  actualText: z.string().optional(), direction: z.enum(["minimum", "maximum", "equals"]), fromReplayedArtifacts: z.boolean().optional()
}).strict();

const evalMetricsSchema = z.object({
  reportedFindings: nonnegativeIntSchema, inlineFindings: nonnegativeIntSchema, summaryOnlyFindings: nonnegativeIntSchema,
  suppressedFindings: nonnegativeIntSchema, candidateFindings: nonnegativeIntSchema, duplicateGroups: nonnegativeIntSchema,
  costUSD: z.number().nonnegative().optional(), elapsedSeconds: z.number().nonnegative().optional(), modelCalls: nonnegativeIntSchema.optional(),
  verificationCalls: nonnegativeIntSchema.optional(), toolCalls: nonnegativeIntSchema.optional(), toolChoiceDowngradedCalls: nonnegativeIntSchema.optional(),
  attentionEfficiency: jsonObjectSchema.optional(), missingArtifacts: z.array(z.string()).optional(), maxPromptCharsByStage: jsonObjectSchema.optional(),
  reviewCompleteness: z.enum(["complete", "partial"]).optional(), budgetOverruns: nonnegativeIntSchema.optional(),
  toolBudgetRejections: nonnegativeIntSchema.optional(), toolBudgetExtensions: nonnegativeIntSchema.optional(), toolBudgetExtensionDenials: nonnegativeIntSchema.optional(),
  degradedHunks: nonnegativeIntSchema.optional(), unresolvedNotesSuppressed: nonnegativeIntSchema.optional(), localModelCallCacheHits: nonnegativeIntSchema.optional(),
  localModelCallCacheMisses: nonnegativeIntSchema.optional(), localModelCallCacheWrites: nonnegativeIntSchema.optional(),
  providerPromptCacheReadTokens: nonnegativeIntSchema.optional(), providerPromptCacheWriteTokens: nonnegativeIntSchema.optional(),
  providerPromptCacheReadCostUSD: z.number().nonnegative().optional(), providerPromptCacheWriteCostUSD: z.number().nonnegative().optional(),
  reasoningTokens: nonnegativeIntSchema.optional(), schemaInvalidCalls: nonnegativeIntSchema.optional(), schemaInvalidRecovered: nonnegativeIntSchema.optional(),
  schemaInvalidUnrecovered: nonnegativeIntSchema.optional(), schemaRepairAttempts: nonnegativeIntSchema.optional(), schemaRepairRecovered: nonnegativeIntSchema.optional(),
  deterministicSchemaRecovered: nonnegativeIntSchema.optional(), schemaRecoveryFailed: nonnegativeIntSchema.optional(), cacheHits: nonnegativeIntSchema.optional(),
  cacheMisses: nonnegativeIntSchema.optional(),
  stageLossCounts: z.object({
    "missed-before-candidate-generation": nonnegativeIntSchema,
    "lost-at-verification": nonnegativeIntSchema,
    "lost-at-composition": nonnegativeIntSchema,
    "partial-match": nonnegativeIntSchema
  }).strict()
}).strict();

const evalScoreSchema = z.object({
  status: z.enum(["pass", "fail", "error"]), expectationResults: z.array(evalExpectationResultSchema), budgetResults: z.array(evalBudgetResultSchema),
  violations: z.array(z.object({ expectationId: z.string(), findingId: z.string(), publication: z.enum(["inline", "summary-only"]) }).strict()),
  nearViolations: z.array(z.object({ expectationId: z.string(), findingId: z.string(), artifact: z.string() }).strict()),
  metrics: evalMetricsSchema, error: z.object({ code: z.string(), message: z.string() }).strict().optional()
}).strict();

const evalRepeatExpectationSchema = z.object({
  expectationId: z.string().min(1), list: z.enum(["should_find", "should_find_candidate", "should_not_find"]),
  tier: z.enum(["required", "optional"]), finalMatched: nonnegativeIntSchema, candidateMatched: nonnegativeIntSchema,
  noteSurfaced: nonnegativeIntSchema, finalRecallRate: z.number().min(0).max(1), candidateRecallRate: z.number().min(0).max(1),
  noteRate: z.number().min(0).max(1), lossHistogram: z.record(z.string(), nonnegativeIntSchema), fingerprintsStable: z.boolean().optional(),
  distinctFingerprints: nonnegativeIntSchema.optional(), gate: z.object({
    minRecallRate: z.number().min(0).max(1).optional(), minCandidateRate: z.number().min(0).max(1).optional(), passed: z.boolean()
  }).strict().optional()
}).strict();

const evalRepeatAggregateSchema = z.object({
  repeat: positiveIntSchema,
  executions: z.array(z.object({ runDir: z.string().min(1), status: z.enum(["pass", "fail", "error"]) }).strict()),
  expectations: z.array(evalRepeatExpectationSchema),
  totals: z.object({ costUSD: z.number().nonnegative(), elapsedSeconds: z.number().nonnegative(), errors: nonnegativeIntSchema }).strict()
}).strict();

const evalRepoProvenanceSchema = z.object({
  root: z.string().min(1), baseSha: commitShaSchema.optional(), headSha: commitShaSchema.optional(), mergeBase: commitShaSchema.optional()
}).strict();

const codegenieRuntimeSchema = z.object({
  packageVersion: z.string().min(1), commit: commitShaSchema.optional(), shortCommit: z.string().min(1).optional(),
  branch: z.string().min(1).optional(), dirty: z.boolean().optional(), source: z.enum(["build_env", "git", "package", "unknown"])
}).strict();

const attentionRecordSchema = z.object({
  packetId: z.string().min(1), path: z.string().min(1), coverage: z.enum(["deep", "normal", "light"]),
  coverageSource: z.union([z.enum(["planner", "deterministic_default"]), z.string().regex(/^escalated:.+/u)]),
  ensemblePasses: nonnegativeIntSchema, directCandidates: nonnegativeIntSchema, promotedCandidates: nonnegativeIntSchema,
  hintsEmitted: nonnegativeIntSchema, uncertaintiesEmitted: nonnegativeIntSchema, keptVerified: nonnegativeIntSchema,
  published: nonnegativeIntSchema
}).strict();
const attentionDroppedPathSchema = z.object({ path: z.string(), reason: z.string() }).strict();
const attentionNoteSchema = z.object({
  question: z.string(), files: z.array(z.string()), symbols: z.array(z.string()), reason: z.string(),
  confidence: z.enum(["high", "medium"]), sourcePacketIds: z.array(z.string()).optional()
}).strict();
const attentionRawHintSchema = z.object({
  id: z.string(), source: z.enum(["follow_up_hint", "uncertainty"]), packetId: z.string(), question: z.string(), reason: z.string(),
  confidence: z.enum(["high", "medium", "low"]), files: z.array(z.string()), originalFiles: z.array(z.string()),
  droppedPaths: z.array(attentionDroppedPathSchema), symbols: z.array(z.string()), suggestedLenses: z.array(z.string())
}).strict();
const attentionGroupSchema = z.object({
  key: z.string(), noteIds: z.array(z.string()), question: z.string(), reason: z.string(), confidence: z.enum(["high", "medium"]),
  files: z.array(z.string()), droppedPaths: z.array(attentionDroppedPathSchema), invalidPathCount: nonnegativeIntSchema,
  symbols: z.array(z.string()), reasons: z.array(z.string()), packetIds: z.array(z.string()),
  sources: z.array(z.enum(["follow_up_hint", "uncertainty"])), count: positiveIntSchema
}).strict();
const humanAttentionArtifactSchema = z.union([
  z.array(z.object({ question: z.string(), files: z.array(z.string()), reasons: z.array(z.string()).optional(), reason: z.string().optional() }).strict()),
  z.object({
    schemaVersion: z.literal(2), notes: z.array(attentionRawHintSchema), groups: z.array(attentionGroupSchema),
    mergeStats: z.object({ exactDuplicateHints: nonnegativeIntSchema, nearDuplicateHints: nonnegativeIntSchema, nearDuplicateGroupsMerged: nonnegativeIntSchema }).strict(),
    composerPromptGroupIds: z.array(z.string()), outputGroupIds: z.array(z.string()), outputNotes: z.array(attentionNoteSchema),
    omittedCount: nonnegativeIntSchema,
    suppressedByFindings: z.array(z.object({ groupKey: z.string(), noteIds: z.array(z.string()) }).strict()),
    suppressedByVerification: z.array(z.object({
      groupKey: z.string(), noteIds: z.array(z.string()), candidateId: z.string(), verdict: z.enum(["keep", "reject", "revise", "incomplete"]),
      reason: z.string(), verdictReason: z.string(), match: z.object({
        sharedFiles: z.array(z.string()), sharedSymbols: z.array(z.string()), sharedTerms: nonnegativeIntSchema,
        similarity: z.number().min(0).max(1), questionMatched: z.boolean(), provenanceMatched: z.boolean()
      }).strict()
    }).strict()),
    keptForOutputGroupIds: z.array(z.string())
  }).strict()
]);
const budgetLimitEventSchema = z.object({
  stage: z.number().int().min(0).max(11), reason: z.enum(["runtime_reserved_tail", "max_model_calls", "max_budget_tokens", "hard_timeout"]),
  elapsedMs: nonnegativeIntSchema, kind: z.enum(["runtime", "model_calls", "tokens"]), actual: z.number().nonnegative(),
  limit: z.number().nonnegative(), totalTokens: nonnegativeIntSchema, modelCalls: nonnegativeIntSchema, afterDispatchedCall: z.boolean()
}).strict();
const contextPressureSummarySchema = z.object({
  toolBudgetRejections: nonnegativeIntSchema, toolBudgetRejectionsByStage: z.record(z.string().regex(/^\d+$/u), nonnegativeIntSchema),
  toolBudgetExtensions: z.object({
    granted: nonnegativeIntSchema, denied: nonnegativeIntSchema, resultChars: nonnegativeIntSchema,
    grantedByStage: z.record(z.string().regex(/^\d+$/u), nonnegativeIntSchema),
    deniedByStage: z.record(z.string().regex(/^\d+$/u), nonnegativeIntSchema)
  }).strict().optional(),
  degradedToolResults: nonnegativeIntSchema, degradedToolResultsByStage: z.record(z.string().regex(/^\d+$/u), nonnegativeIntSchema),
  degradedHunks: nonnegativeIntSchema, rejectionReasons: z.array(z.object({ reason: z.string(), count: positiveIntSchema }).strict()),
  unresolvedNotes: z.object({ emitted: nonnegativeIntSchema, omitted: nonnegativeIntSchema }).strict()
}).strict();
const budgetSummarySchema = z.object({
  completeness: z.enum(["complete", "partial"]), partialReasons: z.array(z.string()), multiplier: z.number().positive(),
  configured: z.object({ timeoutMs: positiveIntSchema, maxModelCalls: positiveIntSchema.optional(), maxBudgetTokens: positiveIntSchema.optional() }).strict(),
  effective: z.object({ timeoutMs: positiveIntSchema, maxModelCalls: positiveIntSchema.optional(), maxBudgetTokens: positiveIntSchema.optional() }).strict(),
  usage: z.object({
    modelCalls: nonnegativeIntSchema, totalTokens: nonnegativeIntSchema, costUSD: z.number().nonnegative().optional(),
    byStage: z.array(z.object({ stage: z.number().int().min(1).max(11), modelCalls: nonnegativeIntSchema, totalTokens: nonnegativeIntSchema }).strict())
  }).strict(),
  overruns: z.array(budgetLimitEventSchema), dispatchBlocks: z.array(budgetLimitEventSchema), contextPressure: contextPressureSummarySchema.optional()
}).strict();
const budgetStopSchema = z.object({
  reason: z.enum(["runtime_reserved_tail", "max_model_calls", "max_budget_tokens", "hard_timeout"]), stage: z.number().int().min(0).max(11),
  elapsedMs: nonnegativeIntSchema, timeoutMs: positiveIntSchema, hardTimeoutMs: positiveIntSchema, remainingRuntimeMs: nonnegativeIntSchema,
  reservedTailRuntimeMs: nonnegativeIntSchema, modelCalls: nonnegativeIntSchema, inFlightModelCalls: nonnegativeIntSchema,
  projectedModelCalls: nonnegativeIntSchema, maxModelCalls: positiveIntSchema.optional(), remainingModelCalls: nonnegativeIntSchema.optional(),
  reservedModelCalls: nonnegativeIntSchema.optional(), totalTokens: nonnegativeIntSchema, inFlightTokens: nonnegativeIntSchema,
  projectedTokens: nonnegativeIntSchema, maxBudgetTokens: positiveIntSchema.optional(), remainingTokens: nonnegativeIntSchema.optional(),
  reservedTokens: nonnegativeIntSchema.optional()
}).strict();
const runReviewSummarySchema = z.object({
  mode: z.string(), target: z.unknown().nullable(), prNumber: positiveIntSchema.nullable(), baseRef: z.string().nullable(), headRef: z.string().nullable(),
  baseSha: z.string().nullable(), headSha: z.string().nullable(), depth: z.string().nullable(), concurrency: positiveIntSchema.nullable(),
  budgetBoost: z.number().positive().nullable(), llmMaxConcurrentCalls: positiveIntSchema.nullable(), lenses: z.array(z.string()),
  format: z.string().nullable(), postGithubComments: z.boolean()
}).strict();
const modelTotalsSchema = z.object({
  events: nonnegativeIntSchema, modelCallRecords: nonnegativeIntSchema, modelCalls: nonnegativeIntSchema, providerCalls: nonnegativeIntSchema,
  toolCalls: nonnegativeIntSchema, toolResultCache: toolResultCacheSummarySchema,
  inputTokens: nonnegativeIntSchema, uncachedInputTokens: nonnegativeIntSchema, cacheReadTokens: nonnegativeIntSchema,
  cacheWriteTokens: nonnegativeIntSchema, billableInputTokens: nonnegativeIntSchema, outputTokens: nonnegativeIntSchema,
  reasoningTokens: nonnegativeIntSchema, totalTokens: nonnegativeIntSchema, totalCostUSD: z.number().nonnegative(),
  inputCostUSD: z.number().nonnegative(), outputCostUSD: z.number().nonnegative(), cacheReadCostUSD: z.number().nonnegative(),
  cacheWriteCostUSD: z.number().nonnegative(), costBreakdown: costBreakdownSchema, unknownCostCalls: nonnegativeIntSchema,
  cache: cacheCountsSchema, localModelCallCache: cacheCountsSchema, providerPromptCache: providerPromptCacheSchema,
  retryAttempts: nonnegativeIntSchema, repairCalls: nonnegativeIntSchema, schemaInvalidCalls: nonnegativeIntSchema,
  schemaRecovery: schemaRecoverySummarySchema,
  stage7SchemaRepair: z.object({
    candidateInvalidSubmits: nonnegativeIntSchema, noFindingInvalidSubmits: nonnegativeIntSchema, cleanupAttempted: nonnegativeIntSchema,
    cleanupRecovered: nonnegativeIntSchema, cleanupRejected: nonnegativeIntSchema, compactRepairScheduled: nonnegativeIntSchema,
    appendRepairScheduled: nonnegativeIntSchema, repairRecovered: nonnegativeIntSchema, repairFailed: nonnegativeIntSchema,
    repairPromptChars: nonnegativeIntSchema, compactRepairPromptChars: nonnegativeIntSchema, appendRepairPromptChars: nonnegativeIntSchema,
    actualRepairCalls: nonnegativeIntSchema, actualRepairPromptChars: nonnegativeIntSchema
  }).strict(),
  logOverflow: z.object({ droppedDebugInfo: nonnegativeIntSchema, droppedWarnError: nonnegativeIntSchema }).strict(),
  filesChanged: nonnegativeIntSchema, hunks: nonnegativeIntSchema, packets: nonnegativeIntSchema, packetReviews: nonnegativeIntSchema,
  candidates: nonnegativeIntSchema, verified: nonnegativeIntSchema, finalFindings: nonnegativeIntSchema, postedComments: nonnegativeIntSchema
}).strict();
const evalRunTelemetrySchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().min(1), codegenieVersion: z.string(), codegenieRuntime: codegenieRuntimeSchema,
  nodeVersion: z.string(), argv: z.array(z.string()), repoRoot: z.string().nullable(), review: runReviewSummarySchema,
  startedAt: z.string(), finishedAt: z.string(), completedAt: z.string(), durationMs: nonnegativeIntSchema,
  outcome: z.object({ status: z.enum(["completed_full", "completed_partial", "failed"]), errorCode: z.string().nullable(), exitCode: z.number().int(), budgetStop: budgetStopSchema.nullable() }).strict(),
  budgetStop: budgetStopSchema.optional(), totals: modelTotalsSchema
}).strict();
const telemetryStageSummarySchema = z.object({
  events: nonnegativeIntSchema,
  levels: z.object({ debug: nonnegativeIntSchema, info: nonnegativeIntSchema, warn: nonnegativeIntSchema, error: nonnegativeIntSchema }).strict(),
  cache: cacheCountsSchema, startedAt: z.string().optional(), completedAt: z.string().optional(), runtimeMs: nonnegativeIntSchema,
  schemaRecovery: schemaRecoveryCountersSchema
}).strict();
const pipelineTelemetrySummaryShape = {
  workers: z.object({ started: nonnegativeIntSchema, completed: nonnegativeIntSchema, failed: nonnegativeIntSchema, retried: nonnegativeIntSchema, timedOut: nonnegativeIntSchema }).strict(),
  packets: z.object({ generated: nonnegativeIntSchema, reviewed: nonnegativeIntSchema, failed: nonnegativeIntSchema, degraded: nonnegativeIntSchema }).strict(),
  lenses: z.object({ selected: nonnegativeIntSchema, byLens: z.record(z.string(), nonnegativeIntSchema) }).strict(),
  coverage: z.object({
    byLevel: z.object({ deep: nonnegativeIntSchema, normal: nonnegativeIntSchema, light: nonnegativeIntSchema, skip: nonnegativeIntSchema }).strict(),
    hunks: z.object({ total: nonnegativeIntSchema, reviewed: nonnegativeIntSchema, skipped: nonnegativeIntSchema, failed: nonnegativeIntSchema, degraded: nonnegativeIntSchema }).strict()
  }).strict(),
  candidates: z.object({
    generated: nonnegativeIntSchema, gateRejected: nonnegativeIntSchema, verificationScheduled: nonnegativeIntSchema,
    verificationBudgetLimited: nonnegativeIntSchema, clusteredDuplicates: nonnegativeIntSchema, verificationRepresentatives: nonnegativeIntSchema,
    lowConfidenceSuppressed: nonnegativeIntSchema, lowConfidenceEvidenceEligible: nonnegativeIntSchema,
    lowConfidenceEvidenceScheduled: nonnegativeIntSchema, lowConfidenceEvidenceLaneLimited: nonnegativeIntSchema,
    lowConfidenceEvidenceKept: nonnegativeIntSchema, lowConfidenceEvidenceRejected: nonnegativeIntSchema,
    lowConfidenceEvidenceIncomplete: nonnegativeIntSchema
  }).strict(),
  verdicts: z.object({ accept: nonnegativeIntSchema, revise: nonnegativeIntSchema, reject: nonnegativeIntSchema, incomplete: nonnegativeIntSchema }).strict(),
  dedup: z.object({ clusters: nonnegativeIntSchema, duplicates: nonnegativeIntSchema, suppressed: nonnegativeIntSchema }).strict(),
  finalSelection: z.object({ published: nonnegativeIntSchema, merged: nonnegativeIntSchema, suppressed: nonnegativeIntSchema, finalFindings: nonnegativeIntSchema, compositionMode: z.string().nullable(), fallbackReason: z.string().nullable() }).strict(),
  posting: z.object({ attempted: nonnegativeIntSchema, postedComments: nonnegativeIntSchema, skippedDuplicates: nonnegativeIntSchema, failed: nonnegativeIntSchema }).strict()
};
const telemetrySummarySchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().min(1), codegenieRuntime: codegenieRuntimeSchema, startedAt: z.string(), finishedAt: z.string(),
  completedAt: z.string(), durationMs: nonnegativeIntSchema, logLevel: z.enum(["debug", "info", "warn", "error"]), debugTrace: z.boolean(),
  events: nonnegativeIntSchema, logs: z.object({ bufferedOverflow: z.object({ droppedDebugInfo: nonnegativeIntSchema, droppedWarnError: nonnegativeIntSchema }).strict() }).strict(),
  budgetStop: budgetStopSchema.optional(), totals: modelTotalsSchema, stages: z.record(z.string().regex(/^\d+$/u), telemetryStageSummarySchema),
  ...pipelineTelemetrySummaryShape,
  schemaRecovery: schemaRecoverySummarySchema,
  schemaRepair: z.object({ stage7: modelTotalsSchema.shape.stage7SchemaRepair }).strict(),
  modelCalls: modelCallsSummarySchema, toolCalls: toolCallsSummarySchema
}).strict();

const invocationIdSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/u);
const evalInvocationReferenceSchema = z.object({
  id: invocationIdSchema, caseIndex: nonnegativeIntSchema, manifest: z.string().regex(/^invocations\/[a-zA-Z0-9_-]+\.json$/u)
}).strict();

const evalInvocationCaseSchema = z.object({
  caseIndex: nonnegativeIntSchema, caseName: z.string().min(1), caseHash: z.string().min(1), caseFile: z.string().min(1)
}).strict();

const evalInvocationRunSchema = z.object({
  caseIndex: nonnegativeIntSchema, caseName: z.string().min(1), caseHash: z.string().min(1), runNumber: positiveIntSchema,
  logsRoot: z.string().min(1).refine((value) => path.isAbsolute(value), "logsRoot must be absolute"),
  runPath: z.string().regex(/^\d+$/u)
}).strict();

const evalInvocationManifestSchema = z.object({
  schemaVersion: z.literal(1), invocationId: invocationIdSchema,
  suiteDir: z.string().min(1).refine((value) => path.isAbsolute(value), "suiteDir must be absolute"),
  status: z.enum(["running", "complete"]),
  startedAt: z.string().min(1), completedAt: z.string().min(1).optional(), cases: z.array(evalInvocationCaseSchema).min(1), runs: z.array(evalInvocationRunSchema)
}).strict();

const evalRunInfoSchema = z.object({
  runNumber: positiveIntSchema, caseName: z.string().min(1), caseFile: z.string().optional(), caseHash: z.string().min(1),
  caseSnapshot: evalCaseArtifactSchema, mode: z.enum(["live", "replay"]), repeats: evalRepeatAggregateSchema.optional(),
  replay: z.object({ sourceArtifacts: z.string().min(1), caseSource: z.enum(["yaml", "snapshot"]) }).strict().optional(),
  repo: evalRepoProvenanceSchema.optional(), reviewRunId: z.string().optional(), codegenieRuntime: codegenieRuntimeSchema.optional(),
  invocation: evalInvocationReferenceSchema.optional(),
  cache: z.object({ enabled: z.boolean(), source: z.enum(["cli", "case", "config"]), dir: z.string().optional() }).strict(),
  effectiveConfig: z.object({
    review: z.object({
      concurrency: positiveIntSchema, timeoutMs: positiveIntSchema, verify: z.boolean(),
      minSeverity: z.enum(["critical", "high", "medium", "low"]).optional(), maxFindings: positiveIntSchema,
      softCommentCap: positiveIntSchema, minConfidence: z.enum(["high", "medium", "low"]),
      minInlineConfidence: z.enum(["high", "medium", "low"]), packSameFileHunks: z.boolean(),
      packedToolBudgetMode: z.enum(["base", "atom-scaled"]), maxBudgetTokens: positiveIntSchema.optional()
    }).strict(),
    llm: z.object({
      provider: z.string().optional(), model: z.string().optional(), reasoning: z.string().optional(), maxConcurrentCalls: positiveIntSchema
    }).strict()
  }).strict().optional(),
  startedAt: z.string().min(1), finishedAt: z.string().min(1), score: evalScoreSchema
}).strict();

const coverageArtifactSchema = z.object({
  status: z.object({
    totalHunks: nonnegativeIntSchema, reviewedHunks: nonnegativeIntSchema, skippedHunks: nonnegativeIntSchema, failedHunks: nonnegativeIntSchema,
    coverageByLevel: z.object({ deep: nonnegativeIntSchema, normal: nonnegativeIntSchema, light: nonnegativeIntSchema, skip: nonnegativeIntSchema }).strict(),
    degradedPlanning: z.boolean(), budgetStopped: z.boolean(), budgetStop: jsonObjectSchema.optional(),
    unreviewedHunksByPath: z.array(jsonObjectSchema).optional(), verificationIncompleteCount: nonnegativeIntSchema,
    verificationSkipped: z.boolean().optional(), partial: z.boolean(), reasons: z.array(z.string())
  }).strict(),
  records: z.array(z.object({
    hunkId: z.string().min(1), path: z.string().min(1), coverage: z.enum(["deep", "normal", "light", "skip"]),
    source: z.enum(["planner", "deterministic_default", "config"]), status: z.enum(["reviewed", "skipped", "review_failed", "degraded"]),
    reason: z.string().optional()
  }).strict())
}).strict();

export type PacketPackingArtifactKind =
  | "packet" | "event" | "model-call" | "tool-call" | "coverage" | "eval-info"
  | "attention" | "human-attention" | "budget-summary" | "cost-profile" | "model-summary" | "tool-summary" | "run-summary" | "telemetry-summary";

export function validatePacketPackingArtifact(kind: PacketPackingArtifactKind, value: unknown): void {
  const schemas: Record<PacketPackingArtifactKind, z.ZodType> = {
    packet: reviewPacketSchema,
    event: telemetryEventSchema,
    "model-call": llmCallRecordSchema,
    "tool-call": toolCallRecordSchema,
    coverage: coverageArtifactSchema,
    "eval-info": evalRunInfoSchema,
    attention: z.array(attentionRecordSchema),
    "human-attention": humanAttentionArtifactSchema,
    "budget-summary": budgetSummarySchema,
    "cost-profile": costProfileSchema,
    "model-summary": modelCallsSummarySchema,
    "tool-summary": toolCallsSummarySchema,
    "run-summary": evalRunTelemetrySchema,
    "telemetry-summary": telemetrySummarySchema
  };
  const parsed = schemas[kind].safeParse(value);
  assertReport(parsed.success, "corrupt_artifact_schema", `invalid ${kind} artifact`, {
    issues: parsed.success ? [] : parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message }))
  });
}

const sameFilePackingEventDataSchema = z.object({
  packetId: z.string().min(1),
  atomIds: z.array(z.string().min(1)).min(1),
  standaloneProfiles: z.array(z.enum(["simple", "standard", "investigate"])).min(1),
  sourceAtomCount: z.number().int().positive(),
  hunkCount: z.number().int().positive(),
  effectiveCoverage: z.enum(["deep", "normal", "light"]),
  requestedLensSignature: z.string(),
  capUsage: z.object({
    hunks: z.number().int().nonnegative(),
    maxHunks: z.number().int().positive(),
    patchChars: z.number().int().nonnegative(),
    maxPatchChars: z.number().int().positive()
  }),
  derivedPackedProfile: z.enum(["simple", "standard", "investigate"]),
  profileFloor: z.enum(["simple", "standard", "investigate"]),
  effectiveProfile: z.enum(["simple", "standard", "investigate"]),
  profileFloorApplied: z.boolean(),
  plannerLensesPreserved: z.boolean(),
  toolBudgetMode: z.enum(["base", "atom-scaled"]),
  baseToolBudget: toolBudgetSchema,
  effectiveToolBudget: toolBudgetSchema
}).strict();

type PackingEventData = z.infer<typeof sameFilePackingEventDataSchema> & {
  baseToolBudget: ToolBudget;
  effectiveToolBudget: ToolBudget;
};

export type ReportFailure = {
  code: string;
  message: string;
  context?: Record<string, unknown>;
};

export type CapturedTelemetry = {
  events: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp">>;
  modelCalls: Array<Omit<LlmCallRecord, "runId">>;
  toolCalls: Array<Omit<ToolCallRecord, "runId" | "toolCallId" | "timestamp">>;
};

export type ReplayAnalysisInput = {
  runId: string;
  recordedPackets: ReviewPacket[];
  offPackets: ReviewPacket[];
  onPackets: ReviewPacket[];
  onEvents: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp"> | TelemetryEvent>;
  fileFacts: FileFacts[];
  diff: UnifiedDiff;
  plan: ReviewPlan;
  expectedRefs?: { base: string; head: string };
  actualRefs?: { base: string; head: string };
  flagOffParityPackets?: ReviewPacket[];
  flagOffParityMigrations?: Array<{ code: string; packets: number; explanation: string }>;
  modelCallsObserved?: number;
};

export type ReplayRow = {
  runId: string;
  offPackets: number;
  onPackets: number;
  reductionPercent: number;
  sourceAtoms: number;
  packedMultiAtomPackets: number;
  reviewableHunks: number;
  newCoveragePromotions: number;
  hunkBijectionFailures: number;
  atomInvariantFailures: number;
  capViolations: number;
  lensDrops: number;
  highPriorityNoteOmissions: number;
  deepContextDowngrades: number;
  relatedContextOmissions: number;
  derivedProfileDowngrades: number;
  profileFloorApplications: number;
  effectiveProfileDowngrades: number;
  effectiveBudgetDowngrades: number;
  invalidDispatchRanks: number;
  modelCallsObserved: number;
  schedulingMoves: number;
  proxyPackedPackets: number;
  countReconciliation: "historical-target" | "real-patch-74" | "real-patch-76" | "not-motivating-run";
  flagOffParityDifferences: {
    missingPacketIds: string[];
    extraPacketIds: string[];
    changedPackets: Array<{
      packetId: string;
      paths: string[];
      samples: Array<{ path: string; recorded: ValueFingerprint; rebuilt: ValueFingerprint }>;
    }>;
    historicalMigrations: Array<{ code: string; packets: number; explanation: string }>;
  };
  contextComparison: {
    contextTruncationsOff: number;
    contextTruncationsOn: number;
    relatedContextOmissions: number;
    attentionNoteOmissions: number;
    lensDrops: number;
  };
  distribution: {
    offHunksPerPacket: Record<string, number>;
    onHunksPerPacket: Record<string, number>;
    sourceAtomsPerOnPacket: Record<string, number>;
    onCoverage: Record<string, number>;
    onProfiles: Record<string, number>;
    onBudgetModes: Record<string, number>;
    maxOnHunks: number;
    eligiblePackingPackets: number;
    bypassPackets: number;
    maxEligiblePackingPatchChars: number;
  };
  packetMembership: Array<{
    packetId: string;
    path: string;
    hunkIds: string[];
    coverage: string;
    lenses: string[];
    profile: string;
    budget: ToolBudget;
    dispatchRank: [number, number];
    atomIds: string[];
  }>;
  failures: ReportFailure[];
};

type ValueFingerprint = {
  kind: "string" | "json";
  length: number;
  sha256: string;
};

export type EvalExecutionInput = {
  repeat: number;
  score: EvalScore;
  telemetryDir: string;
  packets: ReviewPacket[];
  events: TelemetryEvent[];
  modelCalls: LlmCallRecord[];
  toolCalls: ToolCallRecord[];
  fileFacts: FileFacts[];
  diff: UnifiedDiff;
  plan: ReviewPlan;
  candidateFindings: CandidateFinding[];
  verification: EvalVerificationRecord[];
  finalSelection: EvalSelectionRecord[];
  finalSelectionArtifact: FinalSelectionArtifact;
  finalFindings: FinalFinding[];
  scoringArtifacts: EvalArtifacts;
  summaryArtifacts?: {
    attention: unknown;
    humanAttention: unknown;
    budget: unknown;
    cost: unknown;
    model: unknown;
    tool: unknown;
    run: unknown;
    telemetry: unknown;
  };
  reviewedHunkIds: string[];
  wallTimeSeconds: number;
};

export type EvalCaseRunInput = {
  runNumber: number;
  runDir: string;
  info: EvalRunInfo;
  declaredCase: EvalCase;
  invocationManifest?: EvalInvocationManifest;
  executions: EvalExecutionInput[];
};

export type CohortSelection = {
  id: string;
  runs: EvalCaseRunInput[];
};

export class PacketPackingReportError extends Error {
  readonly failures: ReportFailure[];

  constructor(message: string, failures: ReportFailure[]) {
    super(message);
    this.name = "PacketPackingReportError";
    this.failures = failures;
  }
}

function failure(code: string, message: string, context?: Record<string, unknown>): ReportFailure {
  return { code, message, ...(context === undefined ? {} : { context }) };
}

function fail(code: string, message: string, context?: Record<string, unknown>): never {
  throw new PacketPackingReportError(message, [failure(code, message, context)]);
}

function assertReport(condition: unknown, code: string, message: string, context?: Record<string, unknown>): asserts condition {
  if (!condition) {
    fail(code, message, context);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function sortedUnique(values: string[]): string[] {
  return unique(values.filter((value) => value.length > 0)).sort();
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function countDistribution(values: Array<string | number>): Record<string, number> {
  const entries = new Map<string, number>();
  for (const value of values) {
    const key = String(value);
    entries.set(key, (entries.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true })));
}

function atomIdForPacket(packet: ReviewPacket): string {
  return sha256Hex(`hunk-first\n${packet.hunks.map((hunk) => hunk.hunkId).join("\n")}`);
}

function changedLines(packet: ReviewPacket): number {
  return packet.hunks.reduce((total, hunk) => total + hunk.changedNewLineNumbers.length + hunk.changedOldLineNumbers.length, 0);
}

function budgetDowngraded(actual: ToolBudget, floor: ToolBudget): boolean {
  if (
    actual.maxToolCalls < floor.maxToolCalls ||
    actual.maxInvestigationRounds < floor.maxInvestigationRounds ||
    actual.maxResultChars < floor.maxResultChars
  ) {
    return true;
  }
  const actualExtension = actual.sourceExtension;
  const floorExtension = floor.sourceExtension;
  return floorExtension !== undefined && (
    actualExtension === undefined ||
    actualExtension.maxToolCalls < floorExtension.maxToolCalls ||
    actualExtension.maxResultChars < floorExtension.maxResultChars
  );
}

function packingEvents(
  events: Array<Omit<TelemetryEvent, "runId" | "eventId" | "timestamp"> | TelemetryEvent>,
  failures: ReportFailure[]
): Map<string, PackingEventData> {
  const byPacket = new Map<string, PackingEventData>();
  for (const event of events) {
    if (event.stage !== 6 || event.message !== "same_file_atoms_packed") {
      continue;
    }
    const result = sameFilePackingEventDataSchema.safeParse(event.data);
    if (!result.success) {
      failures.push(failure("missing_or_corrupt_treatment_telemetry", "same_file_atoms_packed telemetry is invalid", {
        issues: result.error.issues
      }));
      continue;
    }
    const data = result.data as PackingEventData;
    if (byPacket.has(data.packetId)) {
      failures.push(failure("duplicate_treatment_telemetry", `duplicate same_file_atoms_packed event for ${data.packetId}`));
      continue;
    }
    byPacket.set(data.packetId, data);
  }
  return byPacket;
}

function hunkPacketMap(packets: ReviewPacket[], failures: ReportFailure[], side: string): Map<string, ReviewPacket> {
  const result = new Map<string, ReviewPacket>();
  for (const packet of packets) {
    for (const hunk of packet.hunks) {
      if (result.has(hunk.hunkId)) {
        failures.push(failure("hunk_bijection", `${side} duplicates hunk ${hunk.hunkId}`, { packetId: packet.id }));
      }
      result.set(hunk.hunkId, packet);
    }
  }
  return result;
}

function contextTruncated(packet: ReviewPacket): boolean {
  return packet.contextDegradationReasons?.some((reason) => reason.includes("context truncated")) === true ||
    packet.contextText.includes("[... content truncated to fit packet context budget ...]");
}

function packetSourcePositions(diff: UnifiedDiff): Map<string, number> {
  const positions = new Map<string, number>();
  let position = 0;
  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      positions.set(hunk.id, position);
      position += 1;
    }
  }
  return positions;
}

function actualPatchCharsForHunk(diff: UnifiedDiff): Map<string, number> {
  const values = new Map<string, number>();
  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      values.set(hunk.id, renderDiffLines(hunk.lines).length);
    }
  }
  return values;
}

function renderDiffLines(lines: DiffLine[]): string {
  return lines.map((line) => {
    const oldLine = line.oldLineNumber === undefined ? " " : String(line.oldLineNumber);
    const newLine = line.newLineNumber === undefined ? " " : String(line.newLineNumber);
    const prefix = line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " ";
    return `${oldLine.padStart(4)} ${newLine.padStart(4)} ${prefix}${line.content}`;
  }).join("\n");
}

function legacyDiffParityView(diff: UnifiedDiff): unknown {
  return {
    files: diff.files.map((file) => ({
      ...file,
      hunks: file.hunks.map(({ hunkHash: _hunkHash, id: _id, ...hunk }) => hunk)
    }))
  };
}

export function validateRecordedDiffParity(runId: string, recorded: UnifiedDiff, rebuilt: UnifiedDiff): void {
  const recordedHunks = recorded.files.flatMap((file) => file.hunks);
  const missingHunkHashes = recordedHunks.filter((hunk) => hunk.hunkHash === undefined).length;
  assertReport(missingHunkHashes === 0 || missingHunkHashes === recordedHunks.length, "recorded_diff_mismatch", `recorded diff partially persists hunk hashes for ${runId}`);
  if (missingHunkHashes > 0) {
    assertReport(LEGACY_DIFF_SCHEMA_RUN_IDS.has(runId), "unpermitted_legacy_diff_schema", `run ${runId} is not allowlisted for the legacy hunk identity schema`);
  }
  const rebuiltParity = missingHunkHashes === 0 ? rebuilt : legacyDiffParityView(rebuilt);
  const recordedParity = missingHunkHashes === 0 ? recorded : legacyDiffParityView(recorded);
  assertReport(stableJson(rebuiltParity) === stableJson(recordedParity), "recorded_diff_mismatch", `rebuilt diff content differs for ${runId}`, {
    recorded: valueFingerprint(recorded),
    actual: valueFingerprint(rebuilt)
  });
}

function normalizedRequestedLenses(plan: ReviewPlan, hunkIds: string[]): string {
  const ids = new Set(hunkIds);
  return JSON.stringify(sortedUnique(plan.coverage.filter((decision) => ids.has(decision.hunkId)).flatMap((decision) => decision.lenses ?? [])));
}

function proxyPackedPacketCount(
  offPackets: ReviewPacket[],
  events: Map<string, PackingEventData>,
  plan: ReviewPlan,
  diff: UnifiedDiff
): { proxy: number; actualMeasurement: number; changedSplits: number } {
  const referencedAtomIds = new Set([...events.values()].flatMap((event) => event.atomIds));
  const eligible = offPackets.filter((packet) => referencedAtomIds.has(atomIdForPacket(packet)));
  const ineligible = offPackets.length - eligible.length;
  const realPatchChars = actualPatchCharsForHunk(diff);
  type Group = { hunks: number; proxyChars: number; realChars: number };
  const proxyGroups = new Map<string, Group[]>();
  const realGroups = new Map<string, Group[]>();
  for (const packet of eligible) {
    const key = `${packet.path}\0${packet.coverage}\0${normalizedRequestedLenses(plan, packet.hunks.map((hunk) => hunk.hunkId))}`;
    const proxyChars = sum(packet.hunks.map((hunk) => hunk.contentWithLineNumbers.length));
    const realChars = sum(packet.hunks.map((hunk) => realPatchChars.get(hunk.hunkId) ?? Number.MAX_SAFE_INTEGER));
    appendGreedy(proxyGroups, key, packet.hunks.length, proxyChars, realChars, "proxyChars");
    appendGreedy(realGroups, key, packet.hunks.length, proxyChars, realChars, "realChars");
  }
  const proxy = ineligible + sum([...proxyGroups.values()].map((groups) => groups.length));
  const actualMeasurement = ineligible + sum([...realGroups.values()].map((groups) => groups.length));
  return { proxy, actualMeasurement, changedSplits: Math.abs(proxy - actualMeasurement) };
}

function appendGreedy(
  groupsByKey: Map<string, Array<{ hunks: number; proxyChars: number; realChars: number }>>,
  key: string,
  hunks: number,
  proxyChars: number,
  realChars: number,
  measurement: "proxyChars" | "realChars"
): void {
  const groups = groupsByKey.get(key) ?? [];
  const current = groups.at(-1);
  if (current !== undefined && current.hunks + hunks <= MAX_HUNKS_PER_PACKET && current[measurement] + (measurement === "proxyChars" ? proxyChars : realChars) <= MAX_PATCH_CHARS) {
    current.hunks += hunks;
    current.proxyChars += proxyChars;
    current.realChars += realChars;
  } else {
    groups.push({ hunks, proxyChars, realChars });
  }
  groupsByKey.set(key, groups);
}

export function analyzeReplayComparison(input: ReplayAnalysisInput): ReplayRow {
  const failures: ReportFailure[] = [];
  const modelCallsObserved = input.modelCallsObserved ?? 0;
  if (modelCallsObserved !== 0) {
    failures.push(failure("replay_model_call", "deterministic replay recorded model calls", { modelCallsObserved }));
  }
  if (input.expectedRefs !== undefined && input.actualRefs !== undefined) {
    if (input.expectedRefs.base !== input.actualRefs.base || input.expectedRefs.head !== input.actualRefs.head) {
      failures.push(failure("stale_replay_refs", "recorded replay refs do not match resolved refs", {
        expected: input.expectedRefs,
        actual: input.actualRefs
      }));
    }
  }

  const recordedById = new Map(input.recordedPackets.map((packet) => [packet.id, packet]));
  const parityOffById = new Map((input.flagOffParityPackets ?? input.offPackets).map((packet) => [packet.id, packet]));
  const flagOffParityDifferences = {
    missingPacketIds: [...recordedById.keys()].filter((id) => !parityOffById.has(id)).sort(),
    extraPacketIds: [...parityOffById.keys()].filter((id) => !recordedById.has(id)).sort(),
    changedPackets: [...recordedById].flatMap(([id, packet]) => {
      const current = parityOffById.get(id);
      return current === undefined || stableJson(packet) === stableJson(current)
        ? []
        : [{
          packetId: id,
          paths: changedValuePaths(packet, current).slice(0, 50),
          samples: changedValueSamples(packet, current).slice(0, 10)
        }];
    }),
    historicalMigrations: input.flagOffParityMigrations ?? []
  };
  if (recordedById.size !== parityOffById.size || [...recordedById].some(([id, packet]) => stableJson(packet) !== stableJson(parityOffById.get(id)))) {
    failures.push(failure("flag_off_parity", "packing-off packets are not artifact-identical to the recorded Stage-6 packets", flagOffParityDifferences));
  }

  const offById = new Map(input.offPackets.map((packet) => [packet.id, packet]));
  const offByHunk = hunkPacketMap(input.offPackets, failures, "packing-off");
  const onByHunk = hunkPacketMap(input.onPackets, failures, "packing-on");
  const expectedHunks = [...offByHunk.keys()].sort();
  const actualHunks = [...onByHunk.keys()].sort();
  if (stableJson(expectedHunks) !== stableJson(actualHunks)) {
    failures.push(failure("hunk_bijection", "packing-on hunk set differs from packing-off", {
      missing: expectedHunks.filter((id) => !onByHunk.has(id)),
      extra: actualHunks.filter((id) => !offByHunk.has(id))
    }));
  }

  const positions = packetSourcePositions(input.diff);
  const patchCharsByHunk = actualPatchCharsForHunk(input.diff);
  const factsByPath = new Map(input.fileFacts.map((facts) => [facts.path, facts]));
  const eventByPacket = packingEvents(input.onEvents, failures);
  const offAtomById = new Map(input.offPackets.map((packet) => [atomIdForPacket(packet), packet]));
  const observedAtomIds: string[] = [];
  let atomInvariantFailures = 0;
  let capViolations = 0;
  let newCoveragePromotions = 0;
  let lensDrops = 0;
  let highPriorityNoteOmissions = 0;
  let deepContextDowngrades = 0;
  let relatedContextOmissions = 0;
  let derivedProfileDowngrades = 0;
  let profileFloorApplications = 0;
  let effectiveProfileDowngrades = 0;
  let effectiveBudgetDowngrades = 0;
  let invalidDispatchRanks = 0;
  let previousPacketSourcePosition = -1;
  const eligiblePackingPatchChars: number[] = [];

  for (const packet of input.offPackets) {
    const facts = factsByPath.get(packet.path);
    if (facts === undefined) {
      invalidDispatchRanks += 1;
      failures.push(failure("missing_file_facts", `missing file facts for packing-off packet ${packet.path}`));
      continue;
    }
    const expectedRank = packetDispatchRank(packet.path, facts, changedLines(packet));
    if (stableJson(packet.dispatchRank) !== stableJson(expectedRank)) {
      invalidDispatchRanks += 1;
      failures.push(failure("invalid_dispatch_rank", `packing-off packet ${packet.id} has invalid dispatch rank`, {
        expected: expectedRank,
        actual: packet.dispatchRank
      }));
    }
  }

  for (const packet of input.onPackets) {
    const sourcePositions = packet.hunks.map((hunk) => positions.get(hunk.hunkId) ?? Number.MAX_SAFE_INTEGER);
    if (sourcePositions.some((position, index) => index > 0 && position < (sourcePositions[index - 1] ?? -1))) {
      atomInvariantFailures += 1;
      failures.push(failure("source_order", `packet ${packet.id} reorders hunks`));
    }
    const firstSourcePosition = Math.min(...sourcePositions);
    if (firstSourcePosition < previousPacketSourcePosition) {
      atomInvariantFailures += 1;
      failures.push(failure("source_packet_order", `packet ${packet.id} appears before an earlier source packet`, {
        previousPacketSourcePosition,
        firstSourcePosition
      }));
    }
    previousPacketSourcePosition = firstSourcePosition;
    const facts = factsByPath.get(packet.path);
    if (facts === undefined) {
      invalidDispatchRanks += 1;
      failures.push(failure("missing_file_facts", `missing file facts for ${packet.path}`));
    } else {
      const expectedRank = packetDispatchRank(packet.path, facts, changedLines(packet));
      if (stableJson(packet.dispatchRank) !== stableJson(expectedRank)) {
        invalidDispatchRanks += 1;
        failures.push(failure("invalid_dispatch_rank", `packet ${packet.id} has invalid dispatch rank`, {
          expected: expectedRank,
          actual: packet.dispatchRank
        }));
      }
    }

    const event = eventByPacket.get(packet.id);
    const atoms = event?.atomIds.map((id) => offAtomById.get(id)).filter((atom): atom is ReviewPacket => atom !== undefined) ?? [];
    if (event !== undefined) {
      observedAtomIds.push(...event.atomIds);
      const actualPatchChars = sum(packet.hunks.map((hunk) => patchCharsByHunk.get(hunk.hunkId) ?? Number.MAX_SAFE_INTEGER));
      const combinesMultipleAtoms = event.sourceAtomCount > 1;
      if (combinesMultipleAtoms) {
        eligiblePackingPatchChars.push(actualPatchChars);
      }
      if (event.atomIds.length !== event.sourceAtomCount || event.standaloneProfiles.length !== event.sourceAtomCount || atoms.length !== event.sourceAtomCount) {
        atomInvariantFailures += 1;
        failures.push(failure("atom_bijection", `packet ${packet.id} has missing or inconsistent atom provenance`, {
          atomIds: event.atomIds,
          sourceAtomCount: event.sourceAtomCount,
          resolvedAtoms: atoms.length
        }));
      }
      const flattened = atoms.flatMap((atom) => atom.hunks.map((hunk) => hunk.hunkId));
      if (stableJson(flattened) !== stableJson(packet.hunks.map((hunk) => hunk.hunkId))) {
        atomInvariantFailures += 1;
        failures.push(failure("atom_split_or_reorder", `packet ${packet.id} does not preserve source atom membership/order`));
      }
      if (
        event.hunkCount !== packet.hunks.length ||
        event.capUsage.hunks !== packet.hunks.length ||
        event.capUsage.maxHunks !== MAX_HUNKS_PER_PACKET ||
        event.capUsage.maxPatchChars !== MAX_PATCH_CHARS ||
        event.capUsage.hunks > MAX_HUNKS_PER_PACKET ||
        event.capUsage.patchChars > MAX_PATCH_CHARS ||
        (combinesMultipleAtoms && (event.capUsage.patchChars !== actualPatchChars || actualPatchChars > MAX_PATCH_CHARS))
      ) {
        capViolations += 1;
        failures.push(failure("packet_cap", `packet ${packet.id} violates packing caps`, {
          capUsage: event.capUsage,
          actualPatchChars
        }));
      }
      if (atoms.some((atom) => atom.path !== packet.path || atom.language !== packet.language)) {
        atomInvariantFailures += 1;
        failures.push(failure("file_language_boundary", `packet ${packet.id} crosses a file or language boundary`));
      }
      if (atoms.some((atom) => atom.coverage !== packet.coverage) || event.effectiveCoverage !== packet.coverage) {
        newCoveragePromotions += 1;
        failures.push(failure("coverage_promotion", `packet ${packet.id} promotes or mixes atom coverage`));
      }
      const missingLenses = sortedUnique(atoms.flatMap((atom) => atom.lenses)).filter((lens) => !packet.lenses.includes(lens));
      if (!event.plannerLensesPreserved || missingLenses.length > 0) {
        lensDrops += missingLenses.length > 0 ? missingLenses.length : 1;
        failures.push(failure("planner_lens_drop", `packet ${packet.id} drops a standalone routed lens`, { missingLenses }));
      }
      const floor = event.standaloneProfiles.reduce((highest, profile) => PROFILE_RANK[profile] > PROFILE_RANK[highest] ? profile : highest, "simple" as ReviewProfile);
      if (event.profileFloor !== floor) {
        failures.push(failure("profile_floor_mismatch", `packet ${packet.id} reports the wrong profile floor`, { expected: floor, actual: event.profileFloor }));
      }
      if (PROFILE_RANK[event.derivedPackedProfile] < PROFILE_RANK[floor]) {
        derivedProfileDowngrades += 1;
      }
      if (event.profileFloorApplied) {
        profileFloorApplications += 1;
      }
      if (PROFILE_RANK[event.effectiveProfile] < PROFILE_RANK[floor] || packet.reviewProfile !== event.effectiveProfile) {
        effectiveProfileDowngrades += 1;
        failures.push(failure("effective_profile_downgrade", `packet ${packet.id} falls below its standalone profile floor`, {
          floor,
          effective: event.effectiveProfile
        }));
      }
      if (atoms.some((atom) => budgetDowngraded(event.effectiveToolBudget, atom.toolBudget)) || stableJson(event.effectiveToolBudget) !== stableJson(packet.toolBudget)) {
        effectiveBudgetDowngrades += 1;
        failures.push(failure("effective_budget_downgrade", `packet ${packet.id} has a downgraded or inconsistent effective tool budget`));
      }
    } else {
      observedAtomIds.push(atomIdForPacket(packet));
      const off = offById.get(packet.id);
      if (off === undefined || stableJson(off) !== stableJson(packet)) {
        atomInvariantFailures += 1;
        failures.push(failure("missing_treatment_telemetry", `packing-on packet ${packet.id} has no provenance and is not an unchanged bypass packet`));
      }
    }

    for (const hunk of packet.hunks) {
      const off = offByHunk.get(hunk.hunkId);
      if (off === undefined) {
        continue;
      }
      const omittedLenses = off.lenses.filter((lens) => !packet.lenses.includes(lens));
      lensDrops += omittedLenses.length;
      const omittedNotes = off.attentionNotes.filter((note) => !packet.attentionNotes.includes(note));
      if ((off.reviewPriority === "critical" || off.reviewPriority === "high") && omittedNotes.length > 0) {
        highPriorityNoteOmissions += omittedNotes.length;
        failures.push(failure("high_priority_focus_omitted", `packing omits a high/critical attention note for hunk ${hunk.hunkId}`, {
          omittedNoteCount: omittedNotes.length,
          omittedNoteFingerprints: omittedNotes.map(valueFingerprint)
        }));
      }
      if (off.coverage === "deep" && contextQualityRank(packet.contextQuality) < contextQualityRank(off.contextQuality)) {
        deepContextDowngrades += 1;
        failures.push(failure("deep_context_downgrade", `deep hunk ${hunk.hunkId} loses context quality`, {
          from: off.contextQuality,
          to: packet.contextQuality
        }));
      }
      const offRelated = off.relatedChangedContext.map(relatedContextKey);
      const onRelated = new Set(packet.relatedChangedContext.map(relatedContextKey));
      relatedContextOmissions += offRelated.filter((key) => !onRelated.has(key)).length;
    }
  }

  const expectedAtomIds = [...offAtomById.keys()].sort();
  const actualAtomIds = observedAtomIds.sort();
  if (stableJson(expectedAtomIds) !== stableJson(actualAtomIds)) {
    atomInvariantFailures += 1;
    failures.push(failure("atom_bijection", "packing-on atom set differs from packing-off atoms", {
      missing: expectedAtomIds.filter((id) => !actualAtomIds.includes(id)),
      extra: actualAtomIds.filter((id) => !expectedAtomIds.includes(id))
    }));
  }

  const offOrder = schedulingOrder(input.offPackets);
  const onOrder = schedulingOrder(input.onPackets);
  const offPositionByHunk = new Map(offOrder.flatMap((packet, index) => packet.hunks.map((hunk) => [hunk.hunkId, index] as const)));
  const onPositionByHunk = new Map(onOrder.flatMap((packet, index) => packet.hunks.map((hunk) => [hunk.hunkId, index] as const)));
  const schedulingMoves = expectedHunks.filter((hunkId) => offPositionByHunk.get(hunkId) !== onPositionByHunk.get(hunkId)).length;
  const proxy = proxyPackedPacketCount(input.offPackets, eventByPacket, input.plan, input.diff);
  const motivating = input.runId.includes("dca8d870");
  let countReconciliation: ReplayRow["countReconciliation"] = "not-motivating-run";
  if (input.onPackets.length > input.offPackets.length) {
    failures.push(failure("packet_count_increase", `${input.runId} gains packets with packing enabled`));
  }
  if (motivating) {
    if (input.offPackets.length !== 96) {
      failures.push(failure("motivating_off_count", `motivating run must rebuild 96 packing-off packets, got ${input.offPackets.length}`));
    }
    if (input.onPackets.length === 75) {
      countReconciliation = "historical-target";
    } else if (input.onPackets.length === 74 || input.onPackets.length === 76) {
      countReconciliation = input.onPackets.length === 74 ? "real-patch-74" : "real-patch-76";
      if (proxy.proxy !== 75 || proxy.actualMeasurement !== input.onPackets.length || proxy.changedSplits !== 1) {
        failures.push(failure("unexplained_packet_count", "74/76 motivating count is not attributable solely to proxy-versus-real patch measurement", { proxy }));
      }
    } else {
      failures.push(failure("unpermitted_packet_count", `motivating run packed count must be 74, 75, or 76; got ${input.onPackets.length}`));
    }
    if ((1 - input.onPackets.length / Math.max(1, input.offPackets.length)) < 0.2) {
      failures.push(failure("insufficient_packet_reduction", "motivating run packet reduction is below 20%"));
    }
  }

  const attentionNoteOmissions = sum(expectedHunks.map((hunkId) => {
    const off = offByHunk.get(hunkId);
    const on = onByHunk.get(hunkId);
    return off === undefined || on === undefined ? 0 : off.attentionNotes.filter((note) => !on.attentionNotes.includes(note)).length;
  }));
  const contextComparison = {
    contextTruncationsOff: input.offPackets.filter(contextTruncated).length,
    contextTruncationsOn: input.onPackets.filter(contextTruncated).length,
    relatedContextOmissions,
    attentionNoteOmissions,
    lensDrops
  };
  const packingEventValues = [...eventByPacket.values()];
  const distribution = {
    offHunksPerPacket: countDistribution(input.offPackets.map((packet) => packet.hunks.length)),
    onHunksPerPacket: countDistribution(input.onPackets.map((packet) => packet.hunks.length)),
    sourceAtomsPerOnPacket: countDistribution(input.onPackets.map((packet) => eventByPacket.get(packet.id)?.sourceAtomCount ?? 1)),
    onCoverage: countDistribution(input.onPackets.map((packet) => packet.coverage)),
    onProfiles: countDistribution(input.onPackets.map((packet) => packet.reviewProfile)),
    onBudgetModes: countDistribution(input.onPackets.map((packet) => eventByPacket.get(packet.id)?.toolBudgetMode ?? "bypass-base")),
    maxOnHunks: Math.max(0, ...input.onPackets.map((packet) => packet.hunks.length)),
    eligiblePackingPackets: packingEventValues.length,
    bypassPackets: input.onPackets.length - packingEventValues.length,
    maxEligiblePackingPatchChars: Math.max(0, ...eligiblePackingPatchChars)
  };

  return {
    runId: input.runId,
    offPackets: input.offPackets.length,
    onPackets: input.onPackets.length,
    reductionPercent: round((1 - input.onPackets.length / Math.max(1, input.offPackets.length)) * 100, 3),
    sourceAtoms: input.offPackets.length,
    packedMultiAtomPackets: [...eventByPacket.values()].filter((event) => event.sourceAtomCount > 1).length,
    reviewableHunks: expectedHunks.length,
    newCoveragePromotions,
    hunkBijectionFailures: failures.filter((entry) => entry.code === "hunk_bijection").length,
    atomInvariantFailures,
    capViolations,
    lensDrops,
    highPriorityNoteOmissions,
    deepContextDowngrades,
    relatedContextOmissions,
    derivedProfileDowngrades,
    profileFloorApplications,
    effectiveProfileDowngrades,
    effectiveBudgetDowngrades,
    invalidDispatchRanks,
    modelCallsObserved,
    schedulingMoves,
    proxyPackedPackets: proxy.proxy,
    countReconciliation,
    flagOffParityDifferences,
    contextComparison,
    distribution,
    packetMembership: input.onPackets.map((packet) => ({
      packetId: packet.id,
      path: packet.path,
      hunkIds: packet.hunks.map((hunk) => hunk.hunkId),
      coverage: packet.coverage,
      lenses: [...packet.lenses],
      profile: packet.reviewProfile,
      budget: packet.toolBudget,
      dispatchRank: packet.dispatchRank,
      atomIds: eventByPacket.get(packet.id)?.atomIds ?? [atomIdForPacket(packet)]
    })),
    failures
  };
}

function changedValuePaths(before: unknown, after: unknown, prefix = ""): string[] {
  if (Object.is(before, after)) {
    return [];
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      return [`${prefix}.length`];
    }
    return before.flatMap((value, index) => changedValuePaths(value, after[index], `${prefix}[${index}]`));
  }
  if (isRecord(before) && isRecord(after)) {
    return sortedUnique([...Object.keys(before), ...Object.keys(after)]).flatMap((key) =>
      changedValuePaths(before[key], after[key], prefix.length === 0 ? key : `${prefix}.${key}`)
    );
  }
  return [prefix.length === 0 ? "<root>" : prefix];
}

function changedValueSamples(
  before: unknown,
  after: unknown,
  prefix = ""
): Array<{ path: string; recorded: ValueFingerprint; rebuilt: ValueFingerprint }> {
  if (Object.is(before, after)) {
    return [];
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      return [{ path: `${prefix}.length`, recorded: valueFingerprint(before.length), rebuilt: valueFingerprint(after.length) }];
    }
    return before.flatMap((value, index) => changedValueSamples(value, after[index], `${prefix}[${index}]`));
  }
  if (isRecord(before) && isRecord(after)) {
    return sortedUnique([...Object.keys(before), ...Object.keys(after)]).flatMap((key) =>
      changedValueSamples(before[key], after[key], prefix.length === 0 ? key : `${prefix}.${key}`)
    );
  }
  return [{
    path: prefix.length === 0 ? "<root>" : prefix,
    recorded: valueFingerprint(before),
    rebuilt: valueFingerprint(after)
  }];
}

function valueFingerprint(value: unknown): ValueFingerprint {
  const serialized = typeof value === "string" ? value : JSON.stringify(stableValue(value)) ?? String(value);
  return {
    kind: typeof value === "string" ? "string" : "json",
    length: serialized.length,
    sha256: sha256Hex(serialized)
  };
}

export function historicalFlagOffParityView(
  runId: string,
  recordedPackets: ReviewPacket[],
  rebuiltPackets: ReviewPacket[]
): {
  packets: ReviewPacket[];
  migrations: Array<{ code: string; packets: number; explanation: string }>;
} {
  const legacyDispatchRuns = new Set([
    "20260724-135818-740d73f2",
    "20260724-150405-fe1548ae",
    "20260724-162739-81f806a6"
  ]);
  const packets = structuredClone(rebuiltPackets);
  const migrations: Array<{ code: string; packets: number; explanation: string }> = [];
  const recordedById = new Map(recordedPackets.map((packet) => [packet.id, packet]));

  if (
    legacyDispatchRuns.has(runId) &&
    recordedPackets.length > 0 &&
    recordedPackets.every((packet) => !Object.prototype.hasOwnProperty.call(packet, "dispatchRank"))
  ) {
    for (const packet of packets) {
      delete (packet as Partial<ReviewPacket>).dispatchRank;
    }
    migrations.push({
      code: "pre_plan100_dispatch_rank_schema",
      packets: packets.length,
      explanation: "recorded artifacts predate dispatchRank; parity omits only that absent field after validating the rebuilt current rank formula"
    });
  }

  if (runId === "20260724-135818-740d73f2") {
    let migratedPackets = 0;
    for (const packet of packets) {
      const recorded = recordedById.get(packet.id);
      if (recorded === undefined || stableJson(recorded) === stableJson(packet)) {
        continue;
      }
      const onlyKnownPaths = changedValuePaths(recorded, packet).every((entry) => entry === "contextText" || entry === "relevantTests.length");
      const selfTest = packet.relevantTests.length === 1 ? packet.relevantTests[0] : undefined;
      const expectedContext = selfTest === undefined
        ? undefined
        : `${recorded.contextText}\nLikely tests: ${selfTest.path}:${selfTest.name}`;
      if (
        onlyKnownPaths &&
        recorded.relevantTests.length === 0 &&
        selfTest?.path === packet.path &&
        selfTest.name === packet.path &&
        packet.contextText === expectedContext
      ) {
        packet.relevantTests = [];
        packet.contextText = recorded.contextText;
        migratedPackets += 1;
      }
    }
    if (migratedPackets > 0) {
      migrations.push({
        code: "pre_self_test_context_filter",
        packets: migratedPackets,
        explanation: "the oldest clean artifact predates the self-test context filter; parity removes only the exact redundant path:path test line"
      });
    }
  }

  return { packets, migrations };
}

function relatedContextKey(context: ReviewPacket["relatedChangedContext"][number]): string {
  return stableJson({
    path: context.path,
    hunkId: context.hunkId,
    relatedHunkIds: context.relatedHunkIds,
    symbol: context.symbol,
    source: context.relationshipSource,
    strength: context.relationshipStrength
  });
}

function contextQualityRank(quality: PacketContextQuality | undefined): number {
  return quality === undefined ? CONTEXT_QUALITY_RANK.path_only : CONTEXT_QUALITY_RANK[quality];
}

function schedulingOrder(packets: ReviewPacket[]): ReviewPacket[] {
  const priorityRank = { critical: 0, high: 1, normal: 2, low: 3 } as const;
  const coverageRank = { deep: 0, normal: 1, light: 2 } as const;
  return packets.map((packet, index) => ({ packet, index })).sort((a, b) =>
    priorityRank[a.packet.reviewPriority] - priorityRank[b.packet.reviewPriority] ||
    coverageRank[a.packet.coverage] - coverageRank[b.packet.coverage] ||
    a.packet.dispatchRank[0] - b.packet.dispatchRank[0] ||
    a.packet.dispatchRank[1] - b.packet.dispatchRank[1] ||
    a.index - b.index
  ).map((entry) => entry.packet);
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function createCaptureTelemetry(runId: string): { telemetry: TelemetryRecorder; captured: CapturedTelemetry } {
  const captured: CapturedTelemetry = { events: [], modelCalls: [], toolCalls: [] };
  let toolCall = 0;
  return {
    captured,
    telemetry: {
      runId,
      runDir: undefined,
      event: (event) => captured.events.push(structuredClone(event)),
      recordModelCall: (record) => captured.modelCalls.push(structuredClone(record)),
      recordToolCall: (record) => {
        captured.toolCalls.push(structuredClone(record));
        toolCall += 1;
        return `replay-tool-${String(toolCall).padStart(6, "0")}`;
      },
      writeArtifact: async () => undefined,
      writeDebug: async () => undefined,
      flush: async () => undefined
    }
  };
}

type ExperimentArm = "A" | "B" | "C";

type ExecutionPressure = {
  reviewedPackets: number;
  reviewedAtoms: number;
  requestedToolCalls: number;
  usedToolCalls: number;
  rejectedToolCalls: number;
  rejectionRatePerAtom: number;
  rejectionReasons: Record<string, number>;
  resultChars: number;
  continuations: number;
  modelServiceSeconds: number;
  inputTokens: number;
  outputTokens: number;
  stage7CostUSD: number;
  costPerReviewedAtomUSD: number | null;
};

type TreatmentExecution = {
  repeat: number;
  treated: boolean;
  atomIds: string[];
  hunkIds: string[];
  targetPacketId?: string;
  targetPath?: string;
  targetFilePackets?: number;
  targetAtomCount?: number;
  targetCoverage?: string;
  targetRequestedLensSignature?: string;
  pressure: ExecutionPressure;
  failures: ReportFailure[];
};

type ExpectationRate = {
  expectationId: string;
  list: EvalExpectationList;
  candidateHits: number;
  finalHits: number;
  denominator: number;
  candidateRate: number;
  finalRate: number;
  lossHistogram: Record<string, number>;
  lossByAtomCount: Record<string, { denominator: number; missedBeforeCandidate: number }>;
};

type EvalArmReport = {
  runNumber: number;
  treatment: { treated: number; total: number; minimum: number; valid: boolean };
  intentToTreat: ExpectationRate[];
  treatedOnly: { label: "secondary-treated-only"; denominatorByExpectation: Record<string, number>; rates: ExpectationRate[] };
  pressure: ExecutionPressure;
  actualCostUSD: number;
};

type EvalCaseReport = {
  case: string;
  selectedArm?: "B" | "C";
  arms: Record<ExperimentArm, EvalArmReport>;
};

export type EvalReport = {
  schemaVersion: 1;
  mode: "eval";
  cohort: { id: string; runNumbers: number[]; actualCostUSD: number };
  evidence: "repeated-packing-sensitive" | "production-capacity";
  expectedRepeats: number;
  selectedArm?: "B" | "C";
  cases?: EvalCaseReport[];
  productionEconomics?: ProductionEconomics;
  productionThroughput?: ProductionThroughput;
  failures: ReportFailure[];
};

export type ProductionThroughput = {
  baseline: ProductionArmThroughput;
  selected: ProductionArmThroughput;
};

type ProductionArmThroughput = {
  reviewedHunkIds: string[];
  reviewedHunks: number;
  reviewedAtoms: number;
  reviewedPackets: number;
  wallTimeSeconds: number;
  reviewedHunksPerWallSecond: number;
  modelServiceSeconds: number;
  modelServiceSecondsPerReviewedHunk: number;
  totalTokens: number;
  tokensPerReviewedHunk: number;
  reasoningTokens: number;
  reasoningTokensPerReviewedHunk: number;
  continuations: number;
  continuationsPerReviewedAtom: number;
  pressure: ExecutionPressure;
};

export type ProductionEconomics = {
  equivalentTargetHunks: 142;
  baseline: ProductionArmEconomics;
  selected: ProductionArmEconomics;
  equivalentReviewSavingsUSD: number;
  validationCostInputUSD: number;
  validationCostInputLabel: "cohort_actual_cost_minimum" | "explicit_cumulative_validation_cost";
  breakEvenReviewCount: number;
};

type ProductionArmEconomics = {
  actualCostUSD: number;
  reviewedHunks: number;
  costPerReviewedHunkUSD: number;
  equivalentReviewCostUSD: number;
  equivalentCostExtrapolated: boolean;
};

export type RegressionReport = {
  schemaVersion: 1;
  mode: "regression";
  evidence: "one-repeat-collateral-only";
  baselineCohort: { id: string; runNumbers: number[]; actualCostUSD: number };
  selectedCohort: { id: string; runNumbers: number[]; actualCostUSD: number };
  expectedRepeats: number;
  cases: Array<{
    caseName: string;
    baselineRun: number;
    selectedRun: number;
    expectationTransitions: Array<{ expectationId: string; list: string; from: string; to: string }>;
    selectedTreatmentExecutions: number;
    dispatchOrderChanges: number;
    baselinePressure: ExecutionPressure;
    selectedPressure: ExecutionPressure;
  }>;
  failures: ReportFailure[];
};

function armForRun(run: EvalCaseRunInput): ExperimentArm {
  const effective = run.info.effectiveConfig?.review;
  assertReport(effective !== undefined, "missing_effective_config", `run ${run.runNumber} has no effective packet-packing config`);
  assertReport(
    typeof effective.packSameFileHunks === "boolean" &&
      (effective.packedToolBudgetMode === "base" || effective.packedToolBudgetMode === "atom-scaled"),
    "invalid_arm_config",
    `run ${run.runNumber} has invalid effective packet-packing settings`
  );
  if (!effective.packSameFileHunks) {
    assertReport(effective.packedToolBudgetMode === "base", "invalid_arm_config", `baseline run ${run.runNumber} must use base tool budget`);
    return "A";
  }
  return effective.packedToolBudgetMode === "base" ? "B" : "C";
}

function caseFamily(run: EvalCaseRunInput): string {
  const source = run.info.caseFile ?? run.info.caseName;
  return source
    .replace(/\.ya?ml$/u, "")
    .replace(/-(?:a|b|c|baseline|selected)$/iu, "");
}

export function selectExplicitCohort(runs: EvalCaseRunInput[], selector: string): CohortSelection {
  assertReport(runs.length > 0, "empty_cohort", "no eval run info files were found");
  const byInvocation = new Map<string, EvalCaseRunInput[]>();
  for (const run of runs.filter((candidate) => candidate.info.invocation !== undefined && candidate.invocationManifest !== undefined)) {
    const id = run.info.invocation?.id;
    assertReport(id !== undefined, "missing_invocation_manifest", `run ${run.runNumber} lacks invocation identity`);
    byInvocation.set(id, [...(byInvocation.get(id) ?? []), run]);
  }
  for (const [id, invocation] of byInvocation) {
    byInvocation.set(id, [...invocation].sort((left, right) =>
      (left.info.invocation?.caseIndex ?? Number.MAX_SAFE_INTEGER) - (right.info.invocation?.caseIndex ?? Number.MAX_SAFE_INTEGER)
    ));
  }
  assertReport(byInvocation.size > 0, "missing_invocation_manifest", "no cohort-eligible eval invocation manifests were found");
  const invocations = [...byInvocation.values()].sort((left, right) =>
    (left[0]?.invocationManifest?.startedAt ?? "").localeCompare(right[0]?.invocationManifest?.startedAt ?? "") ||
      Math.max(...left.map((run) => run.runNumber)) - Math.max(...right.map((run) => run.runNumber)) ||
      (left[0]?.info.invocation?.id ?? "").localeCompare(right[0]?.info.invocation?.id ?? "")
  );
  let selected: EvalCaseRunInput[] | undefined;
  if (byInvocation.has(selector)) {
    selected = byInvocation.get(selector);
  } else if (selector === "latest") {
    selected = invocations.at(-1);
  } else if (/^\d+$/u.test(selector)) {
    const endingRun = Number(selector);
    const matches = invocations.filter((invocation) => invocation.at(-1)?.runNumber === endingRun);
    assertReport(matches.length <= 1, "ambiguous_cohort_selector", `run ${selector} matches multiple persisted invocations; use the invocation UUID`);
    selected = matches[0];
    assertReport(selected !== undefined, "unknown_cohort", `run ${selector} is not an exact persisted invocation boundary`);
  } else {
    const match = /^(\d+)-(\d+)$/u.exec(selector);
    assertReport(match !== null, "invalid_cohort_selector", `cohort must be latest, an invocation UUID, an ending run number, or a min-max range: ${selector}`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const matches = invocations.filter((invocation) => invocation[0]?.runNumber === start && invocation.at(-1)?.runNumber === end);
    assertReport(matches.length <= 1, "ambiguous_cohort_selector", `cohort ${selector} matches multiple persisted invocations; use the invocation UUID`);
    selected = matches[0];
    assertReport(selected !== undefined, "unknown_cohort", `cohort ${selector} is not an exact persisted invocation boundary`);
  }
  assertReport(selected !== undefined && selected.length > 0, "unknown_cohort", `cohort ${selector} is empty`);
  validateCompleteInvocation(selected);
  assertNoMixedRuns(selected);
  return { id: selected[0]?.info.invocation?.id ?? "unknown", runs: selected };
}

function validateCompleteInvocation(runs: EvalCaseRunInput[]): void {
  const manifest = runs[0]?.invocationManifest;
  assertReport(manifest !== undefined, "missing_invocation_manifest", "cohort invocation manifest is missing");
  const expectedIndexes = Array.from({ length: manifest.cases.length }, (_, index) => index);
  const caseIndexes = manifest.cases.map((entry) => entry.caseIndex);
  const runIndexes = manifest.runs.map((entry) => entry.caseIndex);
  const loadedIndexes = runs.map((run) => run.info.invocation?.caseIndex).filter((index): index is number => index !== undefined);
  const loadedRunDirs = runs.map((run) => path.resolve(run.runDir));
  assertReport(
    manifest.status === "complete" && manifest.completedAt !== undefined &&
      stableJson(caseIndexes) === stableJson(expectedIndexes) &&
      stableJson(runIndexes) === stableJson(expectedIndexes) &&
      stableJson(loadedIndexes) === stableJson(expectedIndexes) &&
      manifest.runs.length === manifest.cases.length && runs.length === manifest.cases.length &&
      unique(loadedRunDirs).length === loadedRunDirs.length,
    "partial_latest_cohort",
    "persisted eval invocation is incomplete or its exact ordered case set does not match loaded runs",
    { invocationId: manifest.invocationId, expectedCount: manifest.cases.length, recordedCount: manifest.runs.length, loadedCount: runs.length }
  );
  for (const [index, run] of runs.entries()) {
    validateInvocationManifestRun(manifest, run.info, run.runDir);
    assertReport(run.info.invocation?.caseIndex === index, "invocation_manifest_join", `run ${run.runNumber} is out of invocation order`);
  }
}

function assertNoMixedRuns(runs: EvalCaseRunInput[]): void {
  const caseNames = runs.map((run) => run.info.caseName);
  assertReport(unique(caseNames).length === caseNames.length, "mixed_cohort", "selected cohort contains multiple generations of the same case", { caseNames });
  const runtimeCommits = sortedUnique(runs.flatMap((run) => run.info.codegenieRuntime?.commit ?? []));
  if (runtimeCommits.length > 1) {
    fail("mixed_cohort", "selected cohort mixes Codegenie commits", { runtimeCommits });
  }
}

export function analyzeEvalCohort(
  cohort: CohortSelection,
  expectedRepeats: number,
  options: { actualValidationCostUSD?: number } = {}
): EvalReport {
  const failures: ReportFailure[] = [];
  assertReport(Number.isInteger(expectedRepeats) && expectedRepeats > 0, "invalid_expected_repeats", "expected repeats must be a positive integer");
  const arms = cohort.runs.map((run) => ({ run, arm: armForRun(run), family: caseFamily(run) }));
  const armSet = new Set(arms.map((entry) => entry.arm));
  const production = cohort.runs.length === 2 && armSet.has("A") && (armSet.has("B") || armSet.has("C"));
  const actualCostUSD = aggregateCohortCost(cohort.runs, failures);

  if (production) {
    const baseline = arms.find((entry) => entry.arm === "A");
    const selected = arms.find((entry) => entry.arm !== "A");
    assertReport(baseline !== undefined && selected !== undefined, "production_pair", "production comparison requires one baseline and one selected run");
    if (stableJson(normalizeExperimentSnapshot(baseline.run.declaredCase)) !== stableJson(normalizeExperimentSnapshot(selected.run.declaredCase))) {
      failures.push(failure("production_case_mismatch", "production baseline and selected cases differ outside packet-packing review settings"));
    }
    validateRunRepeatCount(baseline.run, expectedRepeats, failures);
    validateRunRepeatCount(selected.run, expectedRepeats, failures);
    validateRunEvidence(baseline.run, "production/baseline", failures);
    validateRunEvidence(selected.run, "production/selected", failures);
    const baselineTreatment = baseline.run.executions.map((execution) => analyzeTreatmentExecution(baseline.run, execution, "A"));
    const selectedTreatment = selected.run.executions.map((execution) => analyzeTreatmentExecution(
      selected.run,
      execution,
      selected.arm,
      baseline.run.executions.find((candidate) => candidate.repeat === execution.repeat)
    ));
    failures.push(...baselineTreatment.flatMap((entry) => entry.failures), ...selectedTreatment.flatMap((entry) => entry.failures));
    validateProductionProvenance(baseline.run, selected.run, failures);
    validateRunScoreExpectations("production/baseline", baseline.run, failures);
    validateRunScoreExpectations("production/selected", selected.run, failures);
    validateProductionExpectations(baseline.run, selected.run, failures);
    validateProductionModelAccounting(baseline.run, baselineTreatment, failures, "baseline");
    validateProductionModelAccounting(selected.run, selectedTreatment, failures, "selected");
    if (selectedTreatment.every((entry) => !entry.treated)) {
      failures.push(failure("missing_treatment", "selected production run never packed multiple atoms"));
    }
    const productionThroughput = analyzeProductionThroughput(
      baseline.run,
      baselineTreatment,
      selected.run,
      selectedTreatment,
      failures
    );
    const economics = computeProductionEconomics(
      {
        actualCostUSD: costForRun(baseline.run, failures),
        reviewedHunks: reviewedHunksForRun(baseline.run)
      },
      {
        actualCostUSD: costForRun(selected.run, failures),
        reviewedHunks: reviewedHunksForRun(selected.run)
      },
      options.actualValidationCostUSD ?? actualCostUSD,
      options.actualValidationCostUSD === undefined ? "cohort_actual_cost_minimum" : "explicit_cumulative_validation_cost",
      failures
    );
    if (selected.run.info.score.status === "error" || baseline.run.info.score.status === "error") {
      failures.push(failure("eval_error", "production cohort contains an errored eval run"));
    }
    return {
      schemaVersion: 1,
      mode: "eval",
      cohort: { id: cohort.id, runNumbers: cohort.runs.map((run) => run.runNumber), actualCostUSD },
      evidence: "production-capacity",
      expectedRepeats,
      productionEconomics: economics,
      productionThroughput,
      failures
    };
  }

  const grouped = new Map<string, Partial<Record<ExperimentArm, EvalCaseRunInput>>>();
  for (const entry of arms) {
    const group = grouped.get(entry.family) ?? {};
    if (group[entry.arm] !== undefined) {
      failures.push(failure("mixed_cohort", `cohort has duplicate ${entry.arm} arm for ${entry.family}`));
    }
    group[entry.arm] = entry.run;
    grouped.set(entry.family, group);
  }

  const cases: NonNullable<EvalReport["cases"]> = [];
  for (const [family, group] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.A === undefined || group.B === undefined || group.C === undefined) {
      failures.push(failure("incomplete_abc_cohort", `case ${family} does not have exactly one A/B/C run`));
      continue;
    }
    const runByArm = group as Record<ExperimentArm, EvalCaseRunInput>;
    const evidenceScores = {} as Record<ExperimentArm, Map<number, EvalScore>>;
    for (const arm of ["A", "B", "C"] as const) {
      validateRunRepeatCount(runByArm[arm], expectedRepeats, failures);
      evidenceScores[arm] = new Map(validateRunEvidence(runByArm[arm], `${family}/${arm}`, failures)
        .map((score, index) => [runByArm[arm].executions[index]!.repeat, score]));
      if (runByArm[arm].info.score.status === "error") {
        failures.push(failure("eval_error", `${family}/${arm} is an errored eval run`));
      }
    }
    assertMatchingCaseDefinitions(runByArm, failures);
    validateExpectationJoins(family, runByArm, failures);
    const treatmentByArm = {} as Record<ExperimentArm, TreatmentExecution[]>;
    treatmentByArm.A = runByArm.A.executions.map((execution) => analyzeTreatmentExecution(runByArm.A, execution, "A"));
    for (const arm of ["B", "C"] as const) {
      treatmentByArm[arm] = runByArm[arm].executions.map((execution) => analyzeTreatmentExecution(
        runByArm[arm],
        execution,
        arm,
        runByArm.A.executions.find((candidate) => candidate.repeat === execution.repeat)
      ));
    }
    failures.push(...Object.values(treatmentByArm).flatMap((entries) => entries.flatMap((entry) => entry.failures)));
    compareTargetTreatment(family, treatmentByArm, failures);

    const minimumTreatment = expectedRepeats >= 10 ? 8 : expectedRepeats;
    const armReports = {} as EvalCaseReport["arms"];
    for (const arm of ["A", "B", "C"] as const) {
      const executions = runByArm[arm].executions;
      const treatedCount = arm === "A" ? executions.length : treatmentByArm[arm].filter((entry) => entry.treated).length;
      if (arm !== "A" && treatedCount < minimumTreatment) {
        failures.push(failure("insufficient_treatment", `${family}/${arm} treated ${treatedCount}/${executions.length}; minimum is ${minimumTreatment}`));
      }
      const atomCounts = new Map(treatmentByArm[arm].map((entry) => [entry.repeat, entry.targetAtomCount ?? 1]));
      const intentToTreat = expectationRates(executions, () => true, evidenceScores[arm], atomCounts);
      const treatedOnly = expectationRates(executions, (execution) => {
        if (arm === "A") {
          return true;
        }
        return treatmentByArm[arm].find((entry) => entry.repeat === execution.repeat)?.treated === true;
      }, evidenceScores[arm], atomCounts);
      armReports[arm] = {
        runNumber: runByArm[arm].runNumber,
        treatment: {
          treated: treatedCount,
          total: executions.length,
          minimum: arm === "A" ? executions.length : minimumTreatment,
          valid: arm === "A" || treatedCount >= minimumTreatment
        },
        intentToTreat,
        treatedOnly: {
          label: "secondary-treated-only",
          denominatorByExpectation: Object.fromEntries(treatedOnly.map((rate) => [`${rate.list}:${rate.expectationId}`, rate.denominator])),
          rates: treatedOnly
        },
        pressure: combinePressure(treatmentByArm[arm].map((entry) => entry.pressure)),
        actualCostUSD: costForRun(runByArm[arm], failures)
      };
    }
    if (expectedRepeats >= 10) {
      enforceRequiredRecallZero(family, armReports, failures);
      enforcePressureGate(family, armReports, failures);
    }
    cases.push({ case: family, arms: armReports });
  }

  if (expectedRepeats >= 10) {
    enforceCohortRecallGates(cases, failures);
  }
  const selectedArm = expectedRepeats >= 10 ? selectCohortPackedArm(cases, expectedRepeats, failures) : undefined;
  if (selectedArm !== undefined) {
    for (const entry of cases) {
      entry.selectedArm = selectedArm;
    }
  }

  return {
    schemaVersion: 1,
    mode: "eval",
    cohort: { id: cohort.id, runNumbers: cohort.runs.map((run) => run.runNumber), actualCostUSD },
    evidence: "repeated-packing-sensitive",
    expectedRepeats,
    ...(selectedArm === undefined ? {} : { selectedArm }),
    cases,
    failures
  };
}

function validateRunRepeatCount(run: EvalCaseRunInput, expectedRepeats: number, failures: ReportFailure[]): void {
  const declared = run.declaredCase.repeat ?? 1;
  if (declared !== expectedRepeats || run.executions.length !== expectedRepeats) {
    failures.push(failure("repeat_count_mismatch", `run ${run.runNumber} has ${run.executions.length} executions, expected ${expectedRepeats}`, {
      declared
    }));
  }
  const indexes = run.executions.map((execution) => execution.repeat).sort((a, b) => a - b);
  if (stableJson(indexes) !== stableJson(Array.from({ length: expectedRepeats }, (_, index) => index + 1))) {
    failures.push(failure("repeat_join_mismatch", `run ${run.runNumber} has missing or duplicate repeat indexes`, { indexes }));
  }
}

function assertMatchingCaseDefinitions(
  runs: Record<ExperimentArm, EvalCaseRunInput>,
  failures: ReportFailure[]
): void {
  const normalized = (["A", "B", "C"] as const).map((arm) => stableJson(normalizeExperimentSnapshot(runs[arm].declaredCase)));
  if (unique(normalized).length !== 1) {
    failures.push(failure("arm_case_mismatch", "A/B/C case definitions differ outside packet-packing review fields"));
  }
}

function validateExpectationJoins(
  family: string,
  runs: Record<ExperimentArm, EvalCaseRunInput>,
  failures: ReportFailure[]
): void {
  const canonical = declaredExpectationKeys(runs.A.declaredCase);
  if (canonical.duplicates.length > 0) {
    failures.push(failure("declared_expectation_join", `${family}/A declares duplicate expectation keys`, { duplicateKeys: canonical.duplicates }));
  }
  for (const arm of ["B", "C"] as const) {
    const declared = declaredExpectationKeys(runs[arm].declaredCase);
    if (declared.duplicates.length > 0 || stableJson(declared.values) !== stableJson(canonical.values)) {
      failures.push(failure("declared_expectation_join", `${family}/${arm} declared expectations differ from A`, {
        expected: canonical.values,
        actual: declared.values,
        duplicateKeys: declared.duplicates
      }));
    }
  }
  for (const arm of ["A", "B", "C"] as const) {
    const scores = [runs[arm].info.score, ...runs[arm].executions.map((execution) => execution.score)];
    for (const [scoreIndex, score] of scores.entries()) {
      const keys = expectationKeys(score);
      if (keys.duplicates.length > 0 || stableJson(keys.values) !== stableJson(canonical.values)) {
        failures.push(failure("expectation_join", `${family}/${arm}/score ${scoreIndex} does not have the exact bidirectional declared expectation join`, {
          expected: canonical.values,
          actual: keys.values,
          duplicateKeys: keys.duplicates
        }));
      }
    }
  }
}

function expectationKeys(score: EvalScore | undefined): { values: string[]; duplicates: string[] } {
  const raw = score?.expectationResults.map((result) => `${result.list}\0${result.expectationId}`) ?? [];
  return { values: [...raw].sort(), duplicates: duplicateValues(raw) };
}

function declaredExpectationKeys(evalCase: EvalCase): { values: string[]; duplicates: string[] } {
  const raw = (["should_find", "should_find_candidate", "should_not_find"] as const).flatMap((list) =>
    (evalCase[list] ?? []).map((expectation) => `${list}\0${expectation.id}`)
  );
  return { values: [...raw].sort(), duplicates: duplicateValues(raw) };
}

function normalizeExperimentSnapshot(snapshot: EvalCase): unknown {
  const copy = structuredClone(snapshot);
  copy.name = copy.name.replace(/-(?:a|b|c|baseline|selected)$/iu, "");
  delete copy.repeat;
  if (copy.review !== undefined) {
    delete copy.review.packSameFileHunks;
    delete copy.review.packedToolBudgetMode;
  }
  return copy;
}

function analyzeTreatmentExecution(
  run: EvalCaseRunInput,
  execution: EvalExecutionInput,
  arm: ExperimentArm,
  baselineExecution?: EvalExecutionInput,
  requireTreatment = true
): TreatmentExecution {
  const failures: ReportFailure[] = [];
  const eventByPacket = packingEvents(execution.events, failures);
  const packetById = new Map(execution.packets.map((packet) => [packet.id, packet]));
  const atoms = arm === "A" ? execution.packets : baselineExecution?.packets ?? [];
  const atomById = new Map(atoms.map((packet) => [atomIdForPacket(packet), packet]));
  if (atomById.size !== atoms.length) {
    failures.push(failure("atom_bijection", `run ${run.runNumber}/repeat ${execution.repeat} has ambiguous A atom IDs`));
  }
  if (arm !== "A" && baselineExecution === undefined) {
    failures.push(failure("missing_baseline_atoms", `run ${run.runNumber}/repeat ${execution.repeat} cannot join treatment to A atoms`));
  }
  const duplicateHunks = duplicateValues(execution.packets.flatMap((packet) => packet.hunks.map((hunk) => hunk.hunkId)));
  if (duplicateHunks.length > 0) {
    failures.push(failure("hunk_bijection", `run ${run.runNumber}/repeat ${execution.repeat} duplicates hunks`, { duplicateHunks }));
  }
  const factsByPath = new Map(execution.fileFacts.map((facts) => [facts.path, facts]));
  if (factsByPath.size !== execution.fileFacts.length) {
    failures.push(failure("duplicate_file_facts", `run ${run.runNumber}/repeat ${execution.repeat} has duplicate file facts`));
  }
  for (const packet of execution.packets) {
    if (packet.hunks.length > MAX_HUNKS_PER_PACKET) {
      failures.push(failure("packet_cap", `packet ${packet.id} exceeds the five-hunk cap`));
    }
    const facts = factsByPath.get(packet.path);
    if (facts === undefined || stableJson(packet.dispatchRank) !== stableJson(packetDispatchRank(packet.path, facts, changedLines(packet)))) {
      failures.push(failure("invalid_dispatch_rank", `packet ${packet.id} has an invalid dispatch rank`));
    }
    if (requestedLensSignatureForAtom(execution, packet) === undefined) {
      failures.push(failure("stage5_lens_join", `packet ${packet.id} lacks a non-empty Stage-5 lens decision for every hunk`));
    }
  }
  if (arm !== "A") {
    const baselineHunks = atoms.flatMap((packet) => packet.hunks.map((hunk) => hunk.hunkId));
    const selectedHunks = execution.packets.flatMap((packet) => packet.hunks.map((hunk) => hunk.hunkId));
    if (stableJson([...baselineHunks].sort()) !== stableJson([...selectedHunks].sort())) {
      failures.push(failure("hunk_bijection", `run ${run.runNumber}/repeat ${execution.repeat} does not preserve the exact A hunk set`));
    }
  }
  const usedAtomIds: string[] = [];
  for (const [packetId, event] of eventByPacket) {
    const packet = packetById.get(packetId);
    if (packet === undefined) {
      failures.push(failure("missing_packet", `treatment telemetry references missing packet ${packetId}`));
      continue;
    }
    const sourceAtoms = event.atomIds.map((atomId) => atomById.get(atomId));
    const allAtomsResolved = sourceAtoms.every((atom): atom is ReviewPacket => atom !== undefined);
    if (!allAtomsResolved) {
      failures.push(failure("unknown_source_atom", `packet ${packetId} references an atom absent from the matching A repeat`));
    }
    const resolvedAtoms = sourceAtoms.filter((atom): atom is ReviewPacket => atom !== undefined);
    const expectedHunks = resolvedAtoms.flatMap((atom) => atom.hunks.map((hunk) => hunk.hunkId));
    const packetHunks = packet.hunks.map((hunk) => hunk.hunkId);
    const standaloneProfiles = resolvedAtoms.map((atom) => atom.reviewProfile);
    const profileFloor = standaloneProfiles.reduce((highest, profile) => PROFILE_RANK[profile] > PROFILE_RANK[highest] ? profile : highest, "simple" as ReviewProfile);
    const rawPatchChars = actualPatchCharsForHunk(execution.diff);
    const patchChars = sum(packet.hunks.map((hunk) => rawPatchChars.get(hunk.hunkId) ?? Number.MAX_SAFE_INTEGER));
    const depth = run.declaredCase.review?.depth ?? "normal";
    const baseBudget = toolBudget(packet.coverage, depth, packet.reviewProfile);
    const additionalAtoms = Math.max(0, resolvedAtoms.length - 1);
    const packedBudget = arm === "C" && resolvedAtoms.length > 1 && packet.reviewProfile !== "simple"
      ? {
          ...baseBudget,
          maxToolCalls: Math.min(baseBudget.maxToolCalls + additionalAtoms, Math.ceil(1.75 * baseBudget.maxToolCalls)),
          maxResultChars: Math.min(baseBudget.maxResultChars + additionalAtoms * 2_000, Math.ceil(1.75 * baseBudget.maxResultChars))
        }
      : baseBudget;
    const expectedEffectiveBudget = scaleToolBudget(packedBudget, run.declaredCase.review?.budgetBoost ?? 1);
    if (
      event.sourceAtomCount !== event.atomIds.length ||
      unique(event.atomIds).length !== event.atomIds.length ||
      stableJson(event.standaloneProfiles) !== stableJson(standaloneProfiles) ||
      stableJson(expectedHunks) !== stableJson(packetHunks) ||
      event.hunkCount !== packet.hunks.length ||
      event.capUsage.hunks !== packet.hunks.length ||
      event.capUsage.maxHunks !== MAX_HUNKS_PER_PACKET ||
      event.capUsage.maxPatchChars !== MAX_PATCH_CHARS ||
      event.capUsage.patchChars !== patchChars ||
      event.capUsage.hunks > MAX_HUNKS_PER_PACKET ||
      event.capUsage.patchChars > MAX_PATCH_CHARS ||
      resolvedAtoms.some((atom) => atom.path !== packet.path || atom.language !== packet.language || atom.coverage !== packet.coverage) ||
      event.effectiveCoverage !== packet.coverage ||
      event.effectiveProfile !== packet.reviewProfile ||
      event.profileFloor !== profileFloor ||
      stableJson(event.baseToolBudget) !== stableJson(baseBudget) ||
      stableJson(event.effectiveToolBudget) !== stableJson(expectedEffectiveBudget) ||
      stableJson(event.effectiveToolBudget) !== stableJson(packet.toolBudget) ||
      event.toolBudgetMode !== (arm === "C" ? "atom-scaled" : "base")
    ) {
      failures.push(failure("treatment_invariant", `packet ${packetId} has invalid atom/cap telemetry`));
    }
    if (PROFILE_RANK[event.effectiveProfile] < PROFILE_RANK[profileFloor]) {
      failures.push(failure("effective_profile_downgrade", `packet ${packetId} falls below its standalone profile floor`));
    }
    if (budgetDowngraded(event.effectiveToolBudget, event.baseToolBudget)) {
      failures.push(failure("effective_budget_downgrade", `packet ${packetId} effective budget falls below its base budget`));
    }
    if (!event.plannerLensesPreserved) {
      failures.push(failure("planner_lens_drop", `packet ${packetId} reports a planner-selected lens drop`));
    }
    if (baselineExecution !== undefined) {
      const requestedSignatures = resolvedAtoms.map((atom) => requestedLensSignatureForAtom(baselineExecution, atom));
      const selectedRequestedSignature = requestedLensSignatureForAtom(execution, packet);
      if (
        requestedSignatures.some((signature) => signature === undefined) || selectedRequestedSignature === undefined ||
        unique(requestedSignatures).length !== 1 || requestedSignatures[0] !== event.requestedLensSignature ||
        selectedRequestedSignature !== event.requestedLensSignature
      ) {
        failures.push(failure("requested_lens_join", `packet ${packetId} requested-lens telemetry does not match Stage-5 decisions for its A atoms`));
      }
      const aRequestedLenses = sortedUnique(resolvedAtoms.flatMap((atom) => requestedLensesForAtom(baselineExecution, atom) ?? []));
      const aRoutedLenses = sortedUnique(resolvedAtoms.flatMap((atom) => atom.lenses));
      const selectedRoutedLenses = sortedUnique(packet.lenses);
      const missingFromA = aRequestedLenses.filter((lens) => !aRoutedLenses.includes(lens));
      if (missingFromA.length > 0) {
        failures.push(failure("a_lens_route_join", `A atoms omit one or more of their explicit Stage-5 lenses`, {
          missingLensHashes: missingFromA.map((lens) => sha256Hex(lens))
        }));
      }
      if (stableJson(selectedRoutedLenses) !== stableJson(aRoutedLenses)) {
        const missingRoutedLenses = aRoutedLenses.filter((lens) => !selectedRoutedLenses.includes(lens));
        const extraRoutedLenses = selectedRoutedLenses.filter((lens) => !aRoutedLenses.includes(lens));
        failures.push(failure("routed_lens_join", `packet ${packetId} does not exactly preserve the allowed routed-lens set from its A atoms`, {
          missingLensHashes: missingRoutedLenses.map((lens) => sha256Hex(lens)),
          extraLensHashes: extraRoutedLenses.map((lens) => sha256Hex(lens))
        }));
      }
    }
    usedAtomIds.push(...event.atomIds);
  }
  if (arm !== "A") {
    for (const packet of execution.packets.filter((candidate) => !eventByPacket.has(candidate.id))) {
      const matchingAtom = atomById.get(atomIdForPacket(packet));
      if (matchingAtom === undefined || stableJson(matchingAtom) !== stableJson(packet)) {
        failures.push(failure("untreated_packet_mismatch", `packet ${packet.id} has no treatment event and is not an exact A atom`));
      } else {
        usedAtomIds.push(atomIdForPacket(matchingAtom));
      }
    }
    if (stableJson([...usedAtomIds].sort()) !== stableJson([...atomById.keys()].sort())) {
      failures.push(failure("atom_bijection", `run ${run.runNumber}/repeat ${execution.repeat} does not consume each A atom exactly once`));
    }
  }
  if (arm === "A" && eventByPacket.size > 0) {
    failures.push(failure("baseline_treatment", `baseline run ${run.runNumber} emitted packing treatment telemetry`));
  }
  if (arm !== "A" && requireTreatment && eventByPacket.size === 0) {
    failures.push(failure("missing_treatment_telemetry", `packed run ${run.runNumber}/repeat ${execution.repeat} has no same_file_atoms_packed telemetry`));
  }

  const target = targetPacket(run.declaredCase, execution.packets);
  const targetEvent = target === undefined ? undefined : eventByPacket.get(target.id);
  const treated = arm !== "A" && targetEvent !== undefined && targetEvent.sourceAtomCount >= 2;
  if (arm !== "A" && target === undefined) {
    failures.push(failure("missing_target_packet", `run ${run.runNumber}/repeat ${execution.repeat} has no packet for its positive expectation`));
  }
  const pressure = executionPressure(execution, eventByPacket, failures);
  const targetAtomCount = target === undefined
    ? undefined
    : arm === "A"
      ? 1
      : targetEvent?.atomIds.length ?? atoms.filter((atom) => atom.hunks.some((hunk) => target.hunks.some((targetHunk) => targetHunk.hunkId === hunk.hunkId))).length;
  const targetRequestedLensSignature = arm === "A" && target !== undefined
    ? requestedLensSignatureForAtom(execution, target)
    : targetEvent?.requestedLensSignature;
  return {
    repeat: execution.repeat,
    treated,
    atomIds: [...atomById.keys()].sort(),
    hunkIds: execution.packets.flatMap((packet) => packet.hunks.map((hunk) => hunk.hunkId)).sort(),
    ...(target === undefined ? {} : {
      targetPacketId: target.id,
      targetPath: target.path,
      targetFilePackets: execution.packets.filter((packet) => packet.path === target.path).length,
      ...(targetAtomCount === undefined ? {} : { targetAtomCount }),
      targetCoverage: target.coverage,
      ...(targetRequestedLensSignature === undefined ? {} : { targetRequestedLensSignature })
    }),
    pressure,
    failures
  };
}

function targetPacket(evalCase: EvalCase, packets: ReviewPacket[]): ReviewPacket | undefined {
  const expectation = evalCase.should_find_candidate?.[0] ?? evalCase.should_find?.[0];
  if (expectation === undefined) {
    return packets[0];
  }
  const pathMatches = packets.filter((packet) => expectation.path === undefined || globMatches(expectation.path, packet.path));
  if (expectation.lineRange === undefined) {
    return pathMatches[0];
  }
  return pathMatches.find((packet) => packet.hunks.some((hunk) =>
    [...hunk.changedNewLineNumbers, ...hunk.changedOldLineNumbers].some((line) => line >= expectation.lineRange![0] && line <= expectation.lineRange![1])
  ));
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*\*/gu, "\u0000").replace(/\*/gu, "[^/]*").replace(/\u0000/gu, ".*");
  return new RegExp(`^${escaped}$`, "u").test(value);
}

function requestedLensSignatureForAtom(execution: EvalExecutionInput, atom: ReviewPacket): string | undefined {
  const lenses = requestedLensesForAtom(execution, atom);
  return lenses === undefined ? undefined : JSON.stringify(lenses);
}

function requestedLensesForAtom(execution: EvalExecutionInput, atom: ReviewPacket): string[] | undefined {
  const decisions = new Map(execution.plan.coverage.map((decision) => [decision.hunkId, decision]));
  const lenses = atom.hunks.flatMap((hunk) => {
    const decision = decisions.get(hunk.hunkId);
    return decision?.lenses ?? [];
  });
  if (atom.hunks.some((hunk) => {
    const decision = decisions.get(hunk.hunkId);
    return decision === undefined || decision.lenses.length === 0 || decision.lenses.some((lens) => lens.trim().length === 0);
  })) {
    return undefined;
  }
  return sortedUnique(lenses.map((lens) => lens.trim()));
}

function compareTargetTreatment(
  family: string,
  treatments: Record<ExperimentArm, TreatmentExecution[]>,
  failures: ReportFailure[]
): void {
  for (const repeat of treatments.A.map((entry) => entry.repeat)) {
    const a = treatments.A.find((entry) => entry.repeat === repeat);
    const b = treatments.B.find((entry) => entry.repeat === repeat);
    const c = treatments.C.find((entry) => entry.repeat === repeat);
    if (a === undefined || b === undefined || c === undefined) {
      continue;
    }
    for (const [arm, packed] of [["B", b], ["C", c]] as const) {
      if (packed.targetPath !== a.targetPath || packed.targetCoverage !== a.targetCoverage) {
        failures.push(failure("target_semantics_mismatch", `${family}/${arm}/repeat ${repeat} changes target path or coverage`));
      }
      if (packed.targetFilePackets !== undefined && a.targetFilePackets !== undefined && packed.treated && packed.targetFilePackets >= a.targetFilePackets) {
        failures.push(failure("target_packet_count", `${family}/${arm}/repeat ${repeat} treatment does not reduce target-file packet count`));
      }
    }
    if (b.targetRequestedLensSignature !== a.targetRequestedLensSignature || c.targetRequestedLensSignature !== a.targetRequestedLensSignature) {
      failures.push(failure("target_lens_signature", `${family}/repeat ${repeat} packed requested-lens signatures differ from A`));
    }
  }
}

function executionPressure(
  execution: EvalExecutionInput,
  eventByPacket: Map<string, PackingEventData>,
  failures: ReportFailure[]
): ExecutionPressure {
  const reviewedPacketIds = new Set(execution.modelCalls.filter((call) => call.stage === 7 && call.role === "packetReview" && call.packetId !== undefined).map((call) => call.packetId as string));
  const reviewedAtoms = sum([...reviewedPacketIds].map((packetId) => eventByPacket.get(packetId)?.sourceAtomCount ?? 1));
  const tools = execution.toolCalls.filter((call) => call.stage === 7 && call.initiator === "model" && (call.packetId === undefined || reviewedPacketIds.has(call.packetId)));
  const modelCalls = execution.modelCalls.filter((call) => call.stage === 7 && call.role === "packetReview" && call.cacheStatus !== "hit");
  const rejected = tools.filter((call) => call.status === "rejected");
  const reasons: Record<string, number> = {};
  for (const call of rejected) {
    const reason = call.degradationReason ?? call.errorCode ?? "unknown";
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  if (modelCalls.length > 0 && reviewedAtoms === 0) {
    failures.push(failure("missing_reviewed_atom_telemetry", "Stage-7 model calls cannot be joined to reviewed packets/atoms"));
  }
  const stage7CostUSD = sum(modelCalls.map((call) => call.costUSD ?? 0));
  return {
    reviewedPackets: reviewedPacketIds.size,
    reviewedAtoms,
    requestedToolCalls: tools.length,
    usedToolCalls: tools.filter((call) => call.status !== "rejected" && call.status !== "skipped").length,
    rejectedToolCalls: rejected.length,
    rejectionRatePerAtom: reviewedAtoms === 0 ? 0 : round(rejected.length / reviewedAtoms),
    rejectionReasons: reasons,
    resultChars: sum(tools.map((call) => call.resultChars)),
    continuations: modelCalls.filter((call) => call.kind === "tool-continuation").length,
    modelServiceSeconds: round(sum(modelCalls.map((call) => call.durationMs)) / 1000),
    inputTokens: sum(modelCalls.map((call) => call.inputTokens ?? 0)),
    outputTokens: sum(modelCalls.map((call) => call.outputTokens ?? 0)),
    stage7CostUSD: round(stage7CostUSD),
    costPerReviewedAtomUSD: reviewedAtoms === 0 ? null : round(stage7CostUSD / reviewedAtoms)
  };
}

function combinePressure(entries: ExecutionPressure[]): ExecutionPressure {
  const reviewedAtoms = sum(entries.map((entry) => entry.reviewedAtoms));
  const rejected = sum(entries.map((entry) => entry.rejectedToolCalls));
  const stage7CostUSD = sum(entries.map((entry) => entry.stage7CostUSD));
  const reasons: Record<string, number> = {};
  for (const entry of entries) {
    for (const [reason, count] of Object.entries(entry.rejectionReasons)) {
      reasons[reason] = (reasons[reason] ?? 0) + count;
    }
  }
  return {
    reviewedPackets: sum(entries.map((entry) => entry.reviewedPackets)),
    reviewedAtoms,
    requestedToolCalls: sum(entries.map((entry) => entry.requestedToolCalls)),
    usedToolCalls: sum(entries.map((entry) => entry.usedToolCalls)),
    rejectedToolCalls: rejected,
    rejectionRatePerAtom: reviewedAtoms === 0 ? 0 : round(rejected / reviewedAtoms),
    rejectionReasons: reasons,
    resultChars: sum(entries.map((entry) => entry.resultChars)),
    continuations: sum(entries.map((entry) => entry.continuations)),
    modelServiceSeconds: round(sum(entries.map((entry) => entry.modelServiceSeconds)), 3),
    inputTokens: sum(entries.map((entry) => entry.inputTokens)),
    outputTokens: sum(entries.map((entry) => entry.outputTokens)),
    stage7CostUSD: round(stage7CostUSD),
    costPerReviewedAtomUSD: reviewedAtoms === 0 ? null : round(stage7CostUSD / reviewedAtoms)
  };
}

function expectationRates(
  executions: EvalExecutionInput[],
  include: (execution: EvalExecutionInput) => boolean,
  evidenceScores: Map<number, EvalScore>,
  atomCounts: Map<number, number>
): ExpectationRate[] {
  const selected = executions.filter(include);
  const keys = sortedUnique(executions.flatMap((execution) => (evidenceScores.get(execution.repeat) ?? execution.score).expectationResults
    .filter((result) => result.list !== "should_not_find")
    .map((result) => `${result.list}\0${result.expectationId}`)));
  return keys.map((key) => {
    const [list, expectationId] = key.split("\0") as [EvalExpectationList, string];
    let candidateHits = 0;
    let finalHits = 0;
    const lossHistogram: Record<string, number> = {};
    const lossByAtomCount: Record<string, { denominator: number; missedBeforeCandidate: number }> = {};
    for (const execution of selected) {
      const result = (evidenceScores.get(execution.repeat) ?? execution.score).expectationResults.find((entry) => entry.list === list && entry.expectationId === expectationId);
      const atomBucket = String(atomCounts.get(execution.repeat) ?? 1);
      const bucket = lossByAtomCount[atomBucket] ?? { denominator: 0, missedBeforeCandidate: 0 };
      bucket.denominator += 1;
      lossByAtomCount[atomBucket] = bucket;
      if (result === undefined) {
        lossHistogram.error = (lossHistogram.error ?? 0) + 1;
        continue;
      }
      if (candidateMatched(result)) {
        candidateHits += 1;
      }
      if (finalMatched(result)) {
        finalHits += 1;
      }
      if (result.loss !== undefined) {
        lossHistogram[result.loss.label] = (lossHistogram[result.loss.label] ?? 0) + 1;
        if (result.loss.label === "missed-before-candidate-generation") {
          bucket.missedBeforeCandidate += 1;
        }
      }
    }
    return {
      expectationId,
      list,
      candidateHits,
      finalHits,
      denominator: selected.length,
      candidateRate: selected.length === 0 ? 0 : round(candidateHits / selected.length),
      finalRate: selected.length === 0 ? 0 : round(finalHits / selected.length),
      lossHistogram,
      lossByAtomCount
    };
  });
}

function candidateMatched(result: EvalExpectationResult): boolean {
  if (result.status === "pass") {
    return true;
  }
  return result.list === "should_find" &&
    (result.loss?.label === "lost-at-verification" || result.loss?.label === "lost-at-composition");
}

function finalMatched(result: EvalExpectationResult): boolean {
  return result.list === "should_find" && result.status === "pass";
}

function enforceRequiredRecallZero(
  family: string,
  arms: EvalCaseReport["arms"],
  failures: ReportFailure[]
): void {
  const baselineByKey = new Map(arms.A.intentToTreat.map((rate) => [`${rate.list}\0${rate.expectationId}`, rate]));
  for (const arm of ["B", "C"] as const) {
    for (const rate of arms[arm].intentToTreat) {
      const baseline = baselineByKey.get(`${rate.list}\0${rate.expectationId}`);
      if (baseline === undefined) {
        failures.push(failure("expectation_join", `${family}/${arm} has an expectation absent from A: ${rate.expectationId}`));
        continue;
      }
      if ((baseline.candidateHits > 0 && rate.candidateHits === 0) || (baseline.finalHits > 0 && rate.finalHits === 0)) {
        failures.push(failure("required_recall_zero", `${family}/${arm}/${rate.expectationId} falls from non-zero recall to zero`));
      }
    }
  }
}

function cohortRecallEvidence(cases: EvalCaseReport[], arm: ExperimentArm): {
  candidateHits: number;
  finalHits: number;
  earlyLosses: number;
  observations: number;
  lossByAtomCount: Record<string, { denominator: number; missedBeforeCandidate: number }>;
} {
  const rates = cases.flatMap((entry) => entry.arms[arm].intentToTreat);
  const buckets = sortedUnique(rates.flatMap((rate) => Object.keys(rate.lossByAtomCount)));
  return {
    candidateHits: sum(rates.map((rate) => rate.candidateHits)),
    finalHits: sum(rates.map((rate) => rate.finalHits)),
    earlyLosses: sum(rates.map((rate) => rate.lossHistogram["missed-before-candidate-generation"] ?? 0)),
    observations: sum(rates.map((rate) => rate.denominator)),
    lossByAtomCount: Object.fromEntries(buckets.map((bucket) => [bucket, {
      denominator: sum(rates.map((rate) => rate.lossByAtomCount[bucket]?.denominator ?? 0)),
      missedBeforeCandidate: sum(rates.map((rate) => rate.lossByAtomCount[bucket]?.missedBeforeCandidate ?? 0))
    }]))
  };
}

function cohortArmRecallPasses(cases: EvalCaseReport[], arm: "B" | "C"): boolean {
  const baseline = cohortRecallEvidence(cases, "A");
  const packed = cohortRecallEvidence(cases, arm);
  const baselineEarlyRate = baseline.observations === 0 ? 0 : baseline.earlyLosses / baseline.observations;
  return baseline.candidateHits - packed.candidateHits <= 1 && baseline.finalHits - packed.finalHits <= 1 &&
    packed.earlyLosses - baseline.earlyLosses <= 1 && Object.values(packed.lossByAtomCount).every((bucket) =>
      bucket.missedBeforeCandidate - baselineEarlyRate * bucket.denominator <= 1
    );
}

function enforceCohortRecallGates(cases: EvalCaseReport[], failures: ReportFailure[]): void {
  const baseline = cohortRecallEvidence(cases, "A");
  const baselineEarlyRate = baseline.observations === 0 ? 0 : baseline.earlyLosses / baseline.observations;
  for (const arm of ["B", "C"] as const) {
    const packed = cohortRecallEvidence(cases, arm);
    if (baseline.candidateHits - packed.candidateHits > 1 || baseline.finalHits - packed.finalHits > 1) {
      failures.push(failure("recall_non_inferiority", `${arm} loses more than the single cohort-wide candidate or final hit allowance`, {
        baselineCandidate: baseline.candidateHits,
        packedCandidate: packed.candidateHits,
        baselineFinal: baseline.finalHits,
        packedFinal: packed.finalHits
      }));
    }
    if (packed.earlyLosses - baseline.earlyLosses > 1) {
      failures.push(failure("candidate_generation_loss", `${arm} exceeds the single cohort-wide allowance for losses before candidate generation`));
    }
    for (const [bucket, evidence] of Object.entries(packed.lossByAtomCount)) {
      if (evidence.missedBeforeCandidate - baselineEarlyRate * evidence.denominator > 1) {
        failures.push(failure("candidate_generation_loss_by_atom_count", `${arm} exceeds the cohort-wide atom-count ${bucket} loss allowance`, {
          atomCount: Number(bucket), ...evidence, baselineEarlyRate: round(baselineEarlyRate)
        }));
      }
    }
  }
}

function enforcePressureGate(
  family: string,
  arms: EvalCaseReport["arms"],
  failures: ReportFailure[]
): void {
  const aRecall = sum(arms.A.intentToTreat.map((rate) => rate.candidateHits));
  for (const arm of ["B", "C"] as const) {
    const packedRecall = sum(arms[arm].intentToTreat.map((rate) => rate.candidateHits));
    if (arms[arm].pressure.rejectionRatePerAtom - arms.A.pressure.rejectionRatePerAtom > 0.1 && packedRecall <= aRecall) {
      failures.push(failure("tool_pressure", `${family}/${arm} exceeds A by more than 0.10 rejected attempts per reviewed atom without higher candidate recall`));
    }
  }
  if (arms.C.pressure.rejectionRatePerAtom > arms.B.pressure.rejectionRatePerAtom) {
    failures.push(failure("atom_scaled_pressure", `${family}/C increases normalized tool rejections over B`));
  }
}

function selectCohortPackedArm(
  cases: EvalCaseReport[],
  expectedRepeats: number,
  failures: ReportFailure[]
): "B" | "C" {
  let eligible = new Set<"B" | "C">(["B", "C"]);
  const globalBRecallPasses = cohortArmRecallPasses(cases, "B");
  const globalCRecallPasses = cohortArmRecallPasses(cases, "C");
  const eligibilityByCase = cases.map((entry) => ({
    entry,
    B: packedArmPasses(entry.arms, "B", expectedRepeats) && globalBRecallPasses,
    C: packedArmPasses(entry.arms, "C", expectedRepeats) && globalCRecallPasses && cStrictlyQualifies(entry.arms)
  }));
  const bCohortEligible = eligibilityByCase.every((entry) => entry.B);
  let cCohortEligible = eligibilityByCase.every((entry) => entry.C);
  if (!bCohortEligible && cCohortEligible) {
    const retention = cohortPacketCountServiceSavingsRetention(cases);
    if (retention < 0.85) {
      cCohortEligible = false;
      failures.push(failure("atom_scaled_savings_retention", "C does not retain at least 85% of cohort packet-count-implied service-time savings while B is ineligible", {
        retention: round(retention, 6)
      }));
    }
  }
  for (const { entry, B: bPasses, C: caseCPasses } of eligibilityByCase) {
    const cPasses = caseCPasses && cCohortEligible;
    const passing: Array<"B" | "C"> = [];
    if (bPasses) {
      passing.push("B");
    }
    if (cPasses) {
      passing.push("C");
    }
    if (passing.length === 0) {
      failures.push(failure("no_passing_arm", `${entry.case} has no packed arm that passes treatment, recall, and pressure gates`));
    }
    eligible = new Set([...eligible].filter((arm) => passing.includes(arm)));
  }
  if (eligible.size === 0) {
    failures.push(failure("conflicting_arm_selection", "case-level gates require conflicting product arms; one cohort-wide arm cannot be selected"));
    eligible = new Set(["B", "C"]);
  }
  if (eligible.size === 1) {
    return [...eligible][0]!;
  }
  const economics = Object.fromEntries((["B", "C"] as const).map((arm) => [arm, {
    costUSD: round(sum(cases.map((entry) => entry.arms[arm].actualCostUSD))),
    modelServiceSeconds: round(sum(cases.map((entry) => entry.arms[arm].pressure.modelServiceSeconds)), 3)
  }])) as Record<"B" | "C", { costUSD: number; modelServiceSeconds: number }>;
  const bDominates = economics.B.costUSD <= economics.C.costUSD && economics.B.modelServiceSeconds <= economics.C.modelServiceSeconds;
  const cDominates = economics.C.costUSD <= economics.B.costUSD && economics.C.modelServiceSeconds <= economics.B.modelServiceSeconds;
  if (bDominates && !cDominates) {
    return "B";
  }
  if (cDominates && !bDominates) {
    return "C";
  }
  if (!bDominates && !cDominates) {
    failures.push(failure("conflicting_arm_economics", "B/C trade off actual cost against model-service speed; neither is globally cheaper and faster", economics));
  }
  return "B";
}

function packedArmPasses(arms: EvalCaseReport["arms"], arm: "B" | "C", expectedRepeats: number): boolean {
  if (!arms[arm].treatment.valid) {
    return false;
  }
  if (expectedRepeats < 10) {
    return true;
  }
  const baselineByKey = new Map(arms.A.intentToTreat.map((rate) => [`${rate.list}\0${rate.expectationId}`, rate]));
  const requiredZeroPasses = arms[arm].intentToTreat.every((rate) => {
    const baseline = baselineByKey.get(`${rate.list}\0${rate.expectationId}`);
    if (baseline === undefined) {
      return false;
    }
    return !((baseline.candidateHits > 0 && rate.candidateHits === 0) || (baseline.finalHits > 0 && rate.finalHits === 0));
  });
  const baselineCandidate = sum(arms.A.intentToTreat.map((rate) => rate.candidateHits));
  const packedCandidate = sum(arms[arm].intentToTreat.map((rate) => rate.candidateHits));
  const pressurePasses = arms[arm].pressure.rejectionRatePerAtom - arms.A.pressure.rejectionRatePerAtom <= 0.1 || packedCandidate > baselineCandidate;
  const cPressurePasses = arm !== "C" || arms.C.pressure.rejectionRatePerAtom <= arms.B.pressure.rejectionRatePerAtom;
  return requiredZeroPasses && pressurePasses && cPressurePasses;
}

function cStrictlyQualifies(arms: EvalCaseReport["arms"]): boolean {
  if (arms.C.pressure.rejectionRatePerAtom > arms.B.pressure.rejectionRatePerAtom) {
    return false;
  }
  const bCandidate = sum(arms.B.intentToTreat.map((rate) => rate.candidateHits));
  const cCandidate = sum(arms.C.intentToTreat.map((rate) => rate.candidateHits));
  const bFinal = sum(arms.B.intentToTreat.map((rate) => rate.finalHits));
  const cFinal = sum(arms.C.intentToTreat.map((rate) => rate.finalHits));
  return arms.C.pressure.rejectionRatePerAtom < arms.B.pressure.rejectionRatePerAtom || cCandidate > bCandidate || cFinal > bFinal;
}

function cohortPacketCountServiceSavingsRetention(cases: EvalCaseReport[]): number {
  const baselinePackets = sum(cases.map((entry) => entry.arms.A.pressure.reviewedPackets));
  const packedPackets = sum(cases.map((entry) => entry.arms.C.pressure.reviewedPackets));
  const baselineService = sum(cases.map((entry) => entry.arms.A.pressure.modelServiceSeconds));
  const packedService = sum(cases.map((entry) => entry.arms.C.pressure.modelServiceSeconds));
  const packetCountSavings = baselinePackets > 0
    ? baselineService * Math.max(0, baselinePackets - packedPackets) / baselinePackets
    : 0;
  const actualSavings = baselineService - packedService;
  return packetCountSavings > 0 ? actualSavings / packetCountSavings : 0;
}

function duplicateValues(values: string[]): string[] {
  return sortedUnique(values.filter((value, index) => values.indexOf(value) !== index));
}

function aggregateCohortCost(runs: EvalCaseRunInput[], failures: ReportFailure[]): number {
  return round(sum(runs.map((run) => costForRun(run, failures))));
}

function costForRun(run: EvalCaseRunInput, failures: ReportFailure[]): number {
  const costs = run.executions.map((execution) => {
    const providerCalls = execution.modelCalls.filter((call) => call.cacheStatus !== "hit");
    return providerCalls.every((call) => call.costUSD !== undefined)
      ? sum(providerCalls.map((call) => call.costUSD ?? 0))
      : undefined;
  });
  if (costs.some((cost) => cost === undefined)) {
    failures.push(failure("missing_spend_data", `run ${run.runNumber} lacks actual spend data for one or more executions`));
  }
  return round(sum(costs.map((cost) => cost ?? 0)));
}

function reviewedHunksForRun(run: EvalCaseRunInput): number {
  return sum(run.executions.map((execution) => execution.reviewedHunkIds.length));
}

function validateProductionProvenance(
  baseline: EvalCaseRunInput,
  selected: EvalCaseRunInput,
  failures: ReportFailure[]
): void {
  for (const [label, run] of [["baseline", baseline], ["selected", selected]] as const) {
    const repo = run.info.repo;
    if (
      repo?.root !== PRODUCTION_REPO_ROOT || repo.baseSha !== PRODUCTION_BASE_SHA ||
      repo.mergeBase !== PRODUCTION_BASE_SHA || repo.headSha !== PRODUCTION_HEAD_SHA
    ) {
      failures.push(failure("production_refs", `${label} production run does not use the exact pinned Plan 102 refs`));
    }
    const command = run.declaredCase.command;
    if (
      run.declaredCase.repo?.external !== PRODUCTION_REPO_ROOT || command?.base !== PRODUCTION_BASE_SHA || command.head !== PRODUCTION_HEAD_SHA
    ) {
      failures.push(failure("production_refs", `${label} production case does not declare the exact pinned Plan 102 base/head`));
    }
    const review = run.declaredCase.review;
    const effective = run.info.effectiveConfig;
    if (
      review?.cache !== false || run.info.cache.enabled !== false || review.concurrency !== PRODUCTION_CONCURRENCY ||
      review.maxTimeMinutes !== 60 || effective?.review.concurrency !== PRODUCTION_CONCURRENCY ||
      effective.review.timeoutMs !== PRODUCTION_TIMEOUT_MS || effective.llm.maxConcurrentCalls !== PRODUCTION_CONCURRENCY
    ) {
      failures.push(failure("production_run_shape", `${label} production arm must use the exact external repo, cache-off, concurrency-6, 60-minute declared/effective run shape`));
    }
  }
  const baselineRuntime = baseline.info.codegenieRuntime;
  const selectedRuntime = selected.info.codegenieRuntime;
  if (
    baselineRuntime?.commit === undefined || selectedRuntime?.commit === undefined ||
    baselineRuntime.commit !== selectedRuntime.commit || baselineRuntime.dirty !== false || selectedRuntime.dirty !== false
  ) {
    failures.push(failure("production_runtime_provenance", "production arms must share one present clean Codegenie runtime commit"));
  }
}

function validateProductionExpectations(
  baseline: EvalCaseRunInput,
  selected: EvalCaseRunInput,
  failures: ReportFailure[]
): void {
  const canonical = declaredExpectationKeys(baseline.declaredCase);
  const selectedDeclared = declaredExpectationKeys(selected.declaredCase);
  if (
    canonical.values.length === 0 || canonical.duplicates.length > 0 || selectedDeclared.duplicates.length > 0 ||
    stableJson(canonical.values) !== stableJson(selectedDeclared.values)
  ) {
    failures.push(failure("declared_expectation_join", "production arms do not declare the exact same unique expectation set"));
  }
  const requiredKeys = new Set((["should_find", "should_find_candidate", "should_not_find"] as const).flatMap((list) =>
    (baseline.declaredCase[list] ?? []).filter((expectation) => expectation.tier !== "optional").map((expectation) => `${list}\0${expectation.id}`)
  ));
  for (const [label, run] of [["baseline", baseline], ["selected", selected]] as const) {
    for (const execution of run.executions) {
      const actual = expectationKeys(execution.score);
      if (actual.duplicates.length > 0 || stableJson(actual.values) !== stableJson(canonical.values)) {
        failures.push(failure("expectation_join", `${label} production score does not match its declared expectations bidirectionally`));
      }
      const candidateIds = new Set(execution.candidateFindings.map((finding) => finding.id));
      const finalIds = new Set(execution.finalFindings.map((finding) => finding.id));
      validateProductionFindingArtifacts(execution, failures, label);
      for (const result of execution.score.expectationResults) {
        const expectedArtifact = result.list === "should_find_candidate" ? "candidate-findings" : "final-findings";
        if (result.matched.some((match) =>
          match.artifact !== expectedArtifact ||
          (match.artifact === "candidate-findings" ? !candidateIds.has(match.findingId) : !finalIds.has(match.findingId))
        )) {
          failures.push(failure("production_finding_artifact_join", `${label} production score references a finding absent from its strict candidate/final artifacts`));
        }
        const requiredPositive = requiredKeys.has(`${result.list}\0${result.expectationId}`) && result.list !== "should_not_find";
        if (
          (requiredKeys.has(`${result.list}\0${result.expectationId}`) && result.status !== "pass") ||
          requiredPositive && result.matched.length === 0
        ) {
          failures.push(failure("production_finding_preservation", `${label} production arm does not preserve a required declared finding outcome`));
        }
      }
    }
  }
}

function validateProductionFindingArtifacts(
  execution: EvalExecutionInput,
  failures: ReportFailure[],
  label: string
): void {
  const packetIds = new Set(execution.packets.map((packet) => packet.id));
  const hunkPaths = new Map(execution.diff.files.flatMap((file) => file.hunks.map((hunk) => [hunk.id, hunk.path] as const)));
  const candidateIds = new Set(execution.candidateFindings.map((finding) => finding.id));
  const validAnchor = (anchor: { hunkId: string; path: string } | undefined): boolean =>
    anchor === undefined || hunkPaths.get(anchor.hunkId) === anchor.path;
  const candidateRelationsValid = execution.candidateFindings.every((finding) =>
    packetIds.has(finding.producedBy.packetId) && validAnchor(finding.anchor)
  );
  const finalRelationsValid = execution.finalFindings.every((finding) =>
    packetIds.has(finding.producedBy.packetId) && validAnchor(finding.anchor) &&
    finding.mergedCandidateIds.length > 0 && finding.mergedCandidateIds.every((id) => candidateIds.has(id)) &&
    (finding.mergedAnchors ?? []).every((anchor) => validAnchor(anchor))
  );
  const inline = execution.finalFindings.filter((finding) => finding.publication === "inline").length;
  const summaryOnly = execution.finalFindings.filter((finding) => finding.publication === "summary-only").length;
  const suppressed = execution.finalFindings.filter((finding) => finding.publication === "suppressed").length;
  const metrics = execution.score.metrics;
  const countsValid =
    metrics.candidateFindings === execution.candidateFindings.length && metrics.inlineFindings === inline &&
    metrics.summaryOnlyFindings === summaryOnly && metrics.suppressedFindings === suppressed &&
    metrics.reportedFindings === inline + summaryOnly;
  if (!candidateRelationsValid || !finalRelationsValid || !countsValid) {
    failures.push(failure("production_finding_relations", `${label} production candidate/final artifacts do not join exactly to packets, hunks, lineage, and score counts`, {
      candidates: execution.candidateFindings.length,
      finals: execution.finalFindings.length,
      packets: packetIds.size,
      hunks: hunkPaths.size
    }));
  }
}

function validateProductionModelAccounting(
  run: EvalCaseRunInput,
  treatments: TreatmentExecution[],
  failures: ReportFailure[],
  label: string
): void {
  for (const execution of run.executions) {
    const treatment = treatments.find((entry) => entry.repeat === execution.repeat);
    const reviewedHunks = new Set(execution.reviewedHunkIds);
    const reviewedPacketIds = new Set(execution.packets.filter((packet) => packet.hunks.some((hunk) => reviewedHunks.has(hunk.hunkId))).map((packet) => packet.id));
    const stage7 = execution.modelCalls.filter((call) => call.stage === 7 && call.role === "packetReview");
    const initialPacketIds = stage7.filter((call) => call.kind === "initial" && call.packetId !== undefined).map((call) => call.packetId as string);
    const completeFields = execution.modelCalls.every((call) =>
      call.inputTokens !== undefined && call.outputTokens !== undefined && call.reasoningTokens !== undefined && call.totalTokens !== undefined &&
      call.costUSD !== undefined && call.durationMs > 0 && call.totalTokens >= call.inputTokens + call.outputTokens && call.status === "ok"
    );
    const joined = stage7.length > 0 && stage7.every((call) => call.packetId !== undefined && reviewedPacketIds.has(call.packetId) && call.status === "ok") &&
      unique(initialPacketIds).length === initialPacketIds.length && stableJson([...initialPacketIds].sort()) === stableJson([...reviewedPacketIds].sort());
    const scoreCount = execution.score.metrics.modelCalls;
    const scoreCost = execution.score.metrics.costUSD;
    const recordedCost = sum(execution.modelCalls.map((call) => call.costUSD ?? 0));
    const scoreJoined = scoreCount === execution.modelCalls.length && scoreCost !== undefined && Math.abs(scoreCost - recordedCost) <= 1e-9;
    if (!completeFields || !joined || !scoreJoined || reviewedPacketIds.size === 0 || treatment === undefined || treatment.pressure.reviewedAtoms <= 0) {
      failures.push(failure("production_model_accounting", `${label} production model calls are incomplete or do not join exactly to score/reviewed packets/atoms`, {
        repeat: execution.repeat,
        modelCalls: execution.modelCalls.length,
        scoreModelCalls: scoreCount ?? -1,
        reviewedPackets: reviewedPacketIds.size,
        reviewedAtoms: treatment?.pressure.reviewedAtoms ?? 0
      }));
    }
  }
}

function analyzeProductionThroughput(
  baselineRun: EvalCaseRunInput,
  baselineTreatment: TreatmentExecution[],
  selectedRun: EvalCaseRunInput,
  selectedTreatment: TreatmentExecution[],
  failures: ReportFailure[]
): ProductionThroughput {
  const baseline = productionArmThroughput(baselineRun, baselineTreatment, failures, "baseline");
  const selected = productionArmThroughput(selectedRun, selectedTreatment, failures, "selected");
  if (stableJson(baseline.reviewedHunkIds) !== stableJson(selected.reviewedHunkIds)) {
    failures.push(failure("production_hunk_loss", "selected production arm does not preserve the exact reviewed-hunk set from baseline", {
      baselineCount: baseline.reviewedHunks,
      selectedCount: selected.reviewedHunks,
      baselineSetHash: sha256Hex(baseline.reviewedHunkIds.join("\n")),
      selectedSetHash: sha256Hex(selected.reviewedHunkIds.join("\n"))
    }));
  }
  if (baseline.reviewedHunks !== EQUIVALENT_TARGET_HUNKS || selected.reviewedHunks !== EQUIVALENT_TARGET_HUNKS) {
    failures.push(failure("production_incomplete", `production comparison must review exactly ${EQUIVALENT_TARGET_HUNKS} hunks in both arms`, {
      baseline: baseline.reviewedHunks,
      selected: selected.reviewedHunks
    }));
  }
  if (!(selected.reviewedHunksPerWallSecond > baseline.reviewedHunksPerWallSecond)) {
    failures.push(failure("production_throughput", "selected production arm does not improve reviewed hunks per wall second"));
  }
  if (!(selected.wallTimeSeconds <= baseline.wallTimeSeconds)) {
    failures.push(failure("production_wall_time", "selected production arm increases total wall time"));
  }
  if (!(selected.modelServiceSecondsPerReviewedHunk < baseline.modelServiceSecondsPerReviewedHunk)) {
    failures.push(failure("production_model_service", "selected production arm does not strictly improve model-service seconds per reviewed hunk"));
  }
  if (!(selected.tokensPerReviewedHunk < baseline.tokensPerReviewedHunk)) {
    failures.push(failure("production_tokens", "selected production arm does not strictly improve tokens per reviewed hunk"));
  }
  if (!(selected.reasoningTokensPerReviewedHunk <= baseline.reasoningTokensPerReviewedHunk)) {
    failures.push(failure("production_reasoning_tokens", "selected production arm increases reasoning tokens per reviewed hunk"));
  }
  if (selected.continuations > baseline.continuations) {
    const retention = productionPacketCountServiceSavingsRetention(baseline, selected);
    if (retention < 0.85) {
      failures.push(failure("production_continuation_savings_retention", "selected production arm adds continuations without retaining at least 85% of packet-count-implied all-stage model-service savings", {
        retention: round(retention, 6),
        baselineContinuations: baseline.continuations,
        selectedContinuations: selected.continuations
      }));
    }
  }
  if (selected.pressure.rejectionRatePerAtom - baseline.pressure.rejectionRatePerAtom > 0.1) {
    failures.push(failure("production_tool_pressure", "selected production arm increases normalized tool rejection pressure by more than 0.10"));
  }
  return { baseline, selected };
}

function productionPacketCountServiceSavingsRetention(
  baseline: ProductionArmThroughput,
  selected: ProductionArmThroughput
): number {
  const packetCountSavings = baseline.reviewedPackets > 0
    ? baseline.modelServiceSeconds * Math.max(0, baseline.reviewedPackets - selected.reviewedPackets) / baseline.reviewedPackets
    : 0;
  const actualSavings = baseline.modelServiceSeconds - selected.modelServiceSeconds;
  return packetCountSavings > 0 ? actualSavings / packetCountSavings : 0;
}

function productionArmThroughput(
  run: EvalCaseRunInput,
  treatments: TreatmentExecution[],
  failures: ReportFailure[],
  label: string
): ProductionArmThroughput {
  const rawReviewedHunkIds = run.executions.flatMap((execution) => execution.reviewedHunkIds);
  if (unique(rawReviewedHunkIds).length !== rawReviewedHunkIds.length) {
    failures.push(failure("production_hunk_bijection", `${label} production arm repeats reviewed hunk IDs`));
  }
  const reviewedHunkIds = sortedUnique(rawReviewedHunkIds);
  const pressure = combinePressure(treatments.map((entry) => entry.pressure));
  const allModelCalls = run.executions.flatMap((execution) => execution.modelCalls);
  const reviewedHunks = reviewedHunkIds.length;
  const wallTimeSeconds = round(sum(run.executions.map((execution) => execution.wallTimeSeconds)), 3);
  if (!(wallTimeSeconds > 0)) {
    failures.push(failure("missing_wall_time", `${label} production arm lacks positive wall-time evidence`));
  }
  const modelServiceSeconds = round(sum(allModelCalls.map((call) => call.durationMs)) / 1000, 3);
  const totalTokens = sum(allModelCalls.map((call) => call.totalTokens ?? 0));
  const reasoningTokens = sum(allModelCalls.map((call) => call.reasoningTokens ?? 0));
  return {
    reviewedHunkIds,
    reviewedHunks,
    reviewedAtoms: pressure.reviewedAtoms,
    reviewedPackets: pressure.reviewedPackets,
    wallTimeSeconds,
    reviewedHunksPerWallSecond: wallTimeSeconds > 0 ? round(reviewedHunks / wallTimeSeconds) : 0,
    modelServiceSeconds,
    modelServiceSecondsPerReviewedHunk: reviewedHunks > 0 ? round(modelServiceSeconds / reviewedHunks) : 0,
    totalTokens,
    tokensPerReviewedHunk: reviewedHunks > 0 ? round(totalTokens / reviewedHunks) : 0,
    reasoningTokens,
    reasoningTokensPerReviewedHunk: reviewedHunks > 0 ? round(reasoningTokens / reviewedHunks) : 0,
    continuations: pressure.continuations,
    continuationsPerReviewedAtom: pressure.reviewedAtoms > 0 ? round(pressure.continuations / pressure.reviewedAtoms) : 0,
    pressure
  };
}

export function computeProductionEconomics(
  baseline: { actualCostUSD: number; reviewedHunks: number },
  selected: { actualCostUSD: number; reviewedHunks: number },
  validationCostInputUSD: number,
  label: ProductionEconomics["validationCostInputLabel"] = "explicit_cumulative_validation_cost",
  failures: ReportFailure[] = []
): ProductionEconomics {
  if (!(baseline.actualCostUSD >= 0) || !(selected.actualCostUSD >= 0)) {
    failures.push(failure("missing_spend_data", "production arm costs must be finite non-negative values"));
  }
  if (!(baseline.reviewedHunks > 0) || !(selected.reviewedHunks > 0)) {
    failures.push(failure("missing_reviewed_hunks", "production arms must report positive reviewed-hunk counts"));
  }
  const baselinePerHunk = baseline.reviewedHunks > 0 ? baseline.actualCostUSD / baseline.reviewedHunks : Number.POSITIVE_INFINITY;
  const selectedPerHunk = selected.reviewedHunks > 0 ? selected.actualCostUSD / selected.reviewedHunks : Number.POSITIVE_INFINITY;
  const baselineEquivalent = baselinePerHunk * EQUIVALENT_TARGET_HUNKS;
  const selectedEquivalent = selectedPerHunk * EQUIVALENT_TARGET_HUNKS;
  const savings = baselineEquivalent - selectedEquivalent;
  if (!(savings > 0) || !Number.isFinite(savings)) {
    failures.push(failure("non_positive_payback_denominator", "normalized equivalent-review savings must be positive", {
      baselineEquivalent,
      selectedEquivalent,
      savings
    }));
  }
  const breakEven = savings > 0 && Number.isFinite(savings) ? Math.ceil(validationCostInputUSD / savings) : 0;
  return {
    equivalentTargetHunks: EQUIVALENT_TARGET_HUNKS,
    baseline: {
      actualCostUSD: round(baseline.actualCostUSD),
      reviewedHunks: baseline.reviewedHunks,
      costPerReviewedHunkUSD: round(baselinePerHunk),
      equivalentReviewCostUSD: round(baselineEquivalent),
      equivalentCostExtrapolated: baseline.reviewedHunks < EQUIVALENT_TARGET_HUNKS
    },
    selected: {
      actualCostUSD: round(selected.actualCostUSD),
      reviewedHunks: selected.reviewedHunks,
      costPerReviewedHunkUSD: round(selectedPerHunk),
      equivalentReviewCostUSD: round(selectedEquivalent),
      equivalentCostExtrapolated: selected.reviewedHunks < EQUIVALENT_TARGET_HUNKS
    },
    equivalentReviewSavingsUSD: round(savings),
    validationCostInputUSD: round(validationCostInputUSD),
    validationCostInputLabel: label,
    breakEvenReviewCount: breakEven
  };
}

export function analyzeRegressionCohorts(
  baselineCohort: CohortSelection,
  selectedCohort: CohortSelection,
  expectedRepeats: number
): RegressionReport {
  const failures: ReportFailure[] = [];
  const baselineByName = new Map(baselineCohort.runs.map((run) => [run.info.caseName, run]));
  const selectedByName = new Map(selectedCohort.runs.map((run) => [run.info.caseName, run]));
  const allNames = sortedUnique([...baselineByName.keys(), ...selectedByName.keys()]);
  const cases: RegressionReport["cases"] = [];
  for (const caseName of allNames) {
    const baseline = baselineByName.get(caseName);
    const selected = selectedByName.get(caseName);
    if (baseline === undefined || selected === undefined) {
      failures.push(failure("regression_case_join", `case ${caseName} is missing from one regression cohort`));
      continue;
    }
    validateRunRepeatCount(baseline, expectedRepeats, failures);
    validateRunRepeatCount(selected, expectedRepeats, failures);
    const baselineEvidenceScores = validateRunEvidence(baseline, `${caseName}/baseline`, failures);
    const selectedEvidenceScores = validateRunEvidence(selected, `${caseName}/selected`, failures);
    enforceRequiredRegressionOutcomes(baseline, baselineEvidenceScores, `${caseName}/baseline`, failures);
    enforceRequiredRegressionOutcomes(selected, selectedEvidenceScores, `${caseName}/selected`, failures);
    validateRunScoreExpectations(`${caseName}/baseline`, baseline, failures);
    validateRunScoreExpectations(`${caseName}/selected`, selected, failures);
    let baselineArm: ExperimentArm | undefined;
    let selectedArm: ExperimentArm | undefined;
    try {
      baselineArm = armForRun(baseline);
      selectedArm = armForRun(selected);
    } catch (error) {
      if (error instanceof PacketPackingReportError) {
        failures.push(...error.failures);
      } else {
        throw error;
      }
    }
    if (baselineArm !== "A" || selectedArm === "A") {
      failures.push(failure("regression_arm_config", `${caseName} must compare packing-off/base to one selected packed arm`));
    }
    if (stableJson(normalizeExperimentSnapshot(baseline.declaredCase)) !== stableJson(normalizeExperimentSnapshot(selected.declaredCase))) {
      failures.push(failure("regression_yaml_delta", `${caseName} differs outside repeat and packet-packing review settings`));
    }
    if (baseline.info.score.status === "error" || selected.info.score.status === "error") {
      failures.push(failure("eval_error", `${caseName} has an errored collateral eval`));
    }
    const transitions = expectationTransitions(baseline.info.score, selected.info.score);
    for (const transition of transitions) {
      if (transition.from === "pass" && transition.to !== "pass") {
        failures.push(failure("collateral_expectation_regression", `${caseName}/${transition.expectationId} regresses from pass to ${transition.to}`));
      }
    }
    const baselineTreatment = baseline.executions.map((execution) => analyzeTreatmentExecution(baseline, execution, "A"));
    const effectiveSelectedArm = selectedArm === "C" ? "C" : "B";
    const selectedTreatment = selected.executions.map((execution) => analyzeTreatmentExecution(
      selected,
      execution,
      effectiveSelectedArm,
      baseline.executions.find((candidate) => candidate.repeat === execution.repeat),
      false
    ));
    failures.push(...baselineTreatment.flatMap((entry) => entry.failures), ...selectedTreatment.flatMap((entry) => entry.failures));
    cases.push({
      caseName,
      baselineRun: baseline.runNumber,
      selectedRun: selected.runNumber,
      expectationTransitions: transitions,
      selectedTreatmentExecutions: selectedTreatment.filter((entry) => entry.treated).length,
      dispatchOrderChanges: dispatchOrderChanges(baseline.executions, selected.executions),
      baselinePressure: combinePressure(baselineTreatment.map((entry) => entry.pressure)),
      selectedPressure: combinePressure(selectedTreatment.map((entry) => entry.pressure))
    });
  }
  const baselineCost = aggregateCohortCost(baselineCohort.runs, failures);
  const selectedCost = aggregateCohortCost(selectedCohort.runs, failures);
  return {
    schemaVersion: 1,
    mode: "regression",
    evidence: "one-repeat-collateral-only",
    baselineCohort: { id: baselineCohort.id, runNumbers: baselineCohort.runs.map((run) => run.runNumber), actualCostUSD: baselineCost },
    selectedCohort: { id: selectedCohort.id, runNumbers: selectedCohort.runs.map((run) => run.runNumber), actualCostUSD: selectedCost },
    expectedRepeats,
    cases,
    failures
  };
}

function validateRunScoreExpectations(label: string, run: EvalCaseRunInput, failures: ReportFailure[]): void {
  const declared = declaredExpectationKeys(run.declaredCase);
  const scores = [run.info.score, ...run.executions.map((execution) => execution.score)];
  for (const [index, score] of scores.entries()) {
    const actual = expectationKeys(score);
    if (declared.duplicates.length > 0 || actual.duplicates.length > 0 || stableJson(actual.values) !== stableJson(declared.values)) {
      failures.push(failure("expectation_join", `${label}/score ${index} does not match the exact declared expectation set`));
    }
  }
}

function enforceRequiredRegressionOutcomes(
  run: EvalCaseRunInput,
  scores: EvalScore[],
  label: string,
  failures: ReportFailure[]
): void {
  const required = new Set(([
    ...((run.declaredCase.should_find ?? []).map((expectation) => ({ list: "should_find" as const, expectation }))),
    ...((run.declaredCase.should_find_candidate ?? []).map((expectation) => ({ list: "should_find_candidate" as const, expectation }))),
    ...((run.declaredCase.should_not_find ?? []).map((expectation) => ({ list: "should_not_find" as const, expectation })))
  ]).filter((entry) => entry.expectation.tier !== "optional").map((entry) => `${entry.list}\0${entry.expectation.id}`));
  for (const [index, score] of scores.entries()) {
    for (const result of score.expectationResults) {
      if (!required.has(`${result.list}\0${result.expectationId}`)) {
        continue;
      }
      const passes = result.status === "pass" && (result.list === "should_not_find" || result.matched.length > 0);
      if (!passes) {
        failures.push(failure("collateral_cohort_expectation_failure", `${label}/repeat ${run.executions[index]?.repeat ?? index + 1} fails a required ${result.list} expectation`, {
          expectationId: result.expectationId,
          list: result.list
        }));
      }
    }
  }
}

function expectationTransitions(baseline: EvalScore, selected: EvalScore): RegressionReport["cases"][number]["expectationTransitions"] {
  const baselineByKey = new Map(baseline.expectationResults.map((result) => [`${result.list}\0${result.expectationId}`, result]));
  const selectedByKey = new Map(selected.expectationResults.map((result) => [`${result.list}\0${result.expectationId}`, result]));
  return sortedUnique([...baselineByKey.keys(), ...selectedByKey.keys()]).flatMap((key) => {
    const before = baselineByKey.get(key);
    const after = selectedByKey.get(key);
    const [list, expectationId] = key.split("\0");
    const from = before?.status ?? "missing";
    const to = after?.status ?? "missing";
    return from === to ? [] : [{ expectationId: expectationId ?? "unknown", list: list ?? "unknown", from, to }];
  });
}

function dispatchOrderChanges(baseline: EvalExecutionInput[], selected: EvalExecutionInput[]): number {
  let changes = 0;
  for (const baselineExecution of baseline) {
    const selectedExecution = selected.find((entry) => entry.repeat === baselineExecution.repeat);
    if (selectedExecution === undefined) {
      continue;
    }
    const baselineOrder = schedulingOrder(baselineExecution.packets);
    const selectedOrder = schedulingOrder(selectedExecution.packets);
    const baselineByHunk = new Map(baselineOrder.flatMap((packet, index) => packet.hunks.map((hunk) => [hunk.hunkId, index] as const)));
    const selectedByHunk = new Map(selectedOrder.flatMap((packet, index) => packet.hunks.map((hunk) => [hunk.hunkId, index] as const)));
    changes += [...baselineByHunk].filter(([hunkId, index]) => selectedByHunk.get(hunkId) !== index).length;
  }
  return changes;
}

type ReplayReport = {
  schemaVersion: 1;
  mode: "replay";
  noModelCalls: boolean;
  repo: string;
  rows: ReplayRow[];
  failures: ReportFailure[];
};

async function loadJsonValue(filePath: string, description: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    fail("missing_artifact", `failed to read ${description}: ${filePath}`, { error: error instanceof Error ? error.message : String(error) });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    fail("corrupt_artifact", `failed to parse ${description}: ${filePath}`, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function loadValidatedJson<S extends z.ZodType>(filePath: string, description: string, schema: S): Promise<z.infer<S>> {
  const value = await loadJsonValue(filePath, description);
  const parsed = schema.safeParse(value);
  assertReport(parsed.success, "corrupt_artifact_schema", `invalid ${description}: ${filePath}`, {
    issues: parsed.success ? [] : parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message }))
  });
  return parsed.data;
}

async function loadValidatedJsonLines<S extends z.ZodType>(filePath: string, description: string, schema: S): Promise<Array<z.infer<S>>> {
  if (!existsSync(filePath)) {
    fail("missing_artifact", `failed to read ${description}: ${filePath}`);
  }
  const raw = await readFile(filePath, "utf8");
  const result: Array<z.infer<S>> = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      fail("corrupt_artifact", `failed to parse ${description} line ${index + 1}: ${filePath}`, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    const parsed = schema.safeParse(value);
    assertReport(parsed.success, "corrupt_artifact_schema", `invalid ${description} line ${index + 1}: ${filePath}`, {
      issues: parsed.success ? [] : parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message }))
    });
    result.push(parsed.data);
  }
  return result;
}

function scoringHintEvents(events: TelemetryEvent[]): EvalArtifacts["hintEvents"] {
  return events.flatMap((event) => {
    if (event.message !== "follow_up_hint" && event.message !== "uncertainty") {
      return [];
    }
    const data = event.data ?? {};
    const question = typeof data.question === "string" ? data.question : "";
    if (question.trim().length === 0) {
      return [];
    }
    const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
    const confidence = data.confidence === "high" || data.confidence === "medium" || data.confidence === "low" ? data.confidence : "low";
    const packetId = event.packetId ?? (typeof data.packetId === "string" ? data.packetId : undefined);
    return [{
      ...(packetId === undefined ? {} : { packetId }),
      question,
      files: strings(data.files),
      symbols: strings(data.symbols),
      projectedSkillIds: strings(data.projectedSkillIds),
      ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
      confidence
    }];
  });
}

function scoringHumanAttentionNotes(raw: unknown): NonNullable<EvalArtifacts["humanAttentionNotes"]> {
  const entries = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.groups)
      ? raw.groups
      : [];
  return entries.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.question !== "string" || entry.question.length === 0) {
      return [];
    }
    const files = Array.isArray(entry.files) ? entry.files.filter((value): value is string => typeof value === "string") : [];
    const reasons = Array.isArray(entry.reasons)
      ? entry.reasons.filter((value): value is string => typeof value === "string")
      : typeof entry.reason === "string"
        ? [entry.reason]
        : [];
    return [{ question: entry.question, files, reasons }];
  });
}

async function loadPackets(packetDir: string, options: { allowLegacyDispatchRank?: boolean } = {}): Promise<ReviewPacket[]> {
  let entries: string[];
  try {
    entries = (await readdir(packetDir)).filter((entry) => entry.endsWith(".json")).sort();
  } catch (error) {
    fail("missing_artifact", `failed to read packet artifacts: ${packetDir}`, { error: error instanceof Error ? error.message : String(error) });
  }
  assertReport(entries.length > 0, "missing_artifact", `no packet artifacts found in ${packetDir}`);
  const parsedPackets = await Promise.all(entries.map((entry) => loadValidatedJson(path.join(packetDir, entry), "packet artifact", reviewPacketSchema)));
  const packetIds = new Set<string>();
  const hunkIds = new Set<string>();
  for (const [index, packet] of parsedPackets.entries()) {
    assertReport(entries[index] === `${packet.id}.json`, "packet_filename_mismatch", `packet filename does not match packet ID in ${packetDir}`);
    assertReport(!packetIds.has(packet.id), "duplicate_packet_id", `duplicate packet ID ${packet.id} in ${packetDir}`);
    packetIds.add(packet.id);
    assertReport(options.allowLegacyDispatchRank === true || packet.dispatchRank !== undefined, "missing_dispatch_rank", `packet ${packet.id} has no dispatch rank`);
    for (const hunk of packet.hunks) {
      assertReport(!hunkIds.has(hunk.hunkId), "duplicate_packet_hunk", `hunk ${hunk.hunkId} appears in multiple packet artifacts`);
      hunkIds.add(hunk.hunkId);
    }
  }
  return parsedPackets as unknown as ReviewPacket[];
}

export async function loadEvalRuns(logsDir: string, selector?: string): Promise<EvalCaseRunInput[]> {
  let locations: Array<{ logsRoot: string; runPath: string; runNumber: number }>;
  try {
    await readdir(logsDir);
  } catch (error) {
    fail("missing_logs", `failed to read eval log root: ${logsDir}`, { error: error instanceof Error ? error.message : String(error) });
  }
  const selectedManifest = selector === undefined ? undefined : await loadSelectedInvocationManifest(logsDir, selector);
  if (selectedManifest !== undefined) {
    locations = selectedManifest.runs.map((run) => ({ logsRoot: path.resolve(run.logsRoot), runPath: run.runPath, runNumber: run.runNumber }));
    for (const ownedRoot of sortedUnique(locations.map((location) => location.logsRoot))) {
      const ownedManifest = await loadValidatedJson(
        path.join(ownedRoot, "invocations", `${selectedManifest.invocationId}.json`),
        "root-owned eval invocation manifest",
        evalInvocationManifestSchema
      ) as EvalInvocationManifest;
      assertReport(
        stableJson(ownedManifest) === stableJson(selectedManifest),
        "invocation_root_ownership",
        `invocation ${selectedManifest.invocationId} differs across its declared log roots`
      );
    }
  } else {
    try {
      locations = (await readdir(logsDir)).filter((entry) => /^\d+$/u.test(entry)).sort((a, b) => Number(a) - Number(b))
        .map((runPath) => ({ logsRoot: path.resolve(logsDir), runPath, runNumber: Number(runPath) }));
    } catch (error) {
      fail("missing_logs", `failed to read eval log root: ${logsDir}`, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  const runs: EvalCaseRunInput[] = [];
  const manifests = new Map<string, EvalInvocationManifest>();
  if (selectedManifest !== undefined) {
    manifests.set(selectedManifest.invocationId, selectedManifest);
  }
  const declarations = new Map<string, EvalCase>();
  for (const location of locations) {
    const runDir = path.resolve(location.logsRoot, location.runPath);
    assertReport(
      runDir === path.join(location.logsRoot, String(location.runNumber)) && path.dirname(runDir) === location.logsRoot,
      "invocation_root_ownership",
      "eval invocation run path does not resolve to its exact declared owning root"
    );
    const info = await loadValidatedJson(path.join(runDir, "info.json"), "eval info", evalRunInfoSchema) as unknown as EvalRunInfo;
    assertReport(info.runNumber === location.runNumber, "corrupt_eval_info", `eval info run number does not match directory ${runDir}`);
    assertReport(info.caseSnapshot.name === info.caseName, "corrupt_eval_info", `eval case snapshot name does not match case name in ${runDir}`);
    let invocationManifest: EvalInvocationManifest | undefined;
    let declaredCase = info.caseSnapshot;
    if (info.invocation !== undefined) {
      assertReport(info.invocation.manifest === `invocations/${info.invocation.id}.json`, "invocation_manifest_join", `eval invocation manifest path is not canonical in ${runDir}`);
      invocationManifest = manifests.get(info.invocation.id);
      if (invocationManifest === undefined) {
        invocationManifest = await loadValidatedJson(
          path.join(location.logsRoot, info.invocation.manifest),
          "eval invocation manifest",
          evalInvocationManifestSchema
        ) as EvalInvocationManifest;
        manifests.set(info.invocation.id, invocationManifest);
      }
      validateInvocationManifestRun(invocationManifest, info, runDir);
      const declarationKey = `${invocationManifest.invocationId}\0${info.invocation.caseIndex}`;
      declaredCase = declarations.get(declarationKey) ?? await loadDeclaredEvalCase(invocationManifest, info);
      declarations.set(declarationKey, declaredCase);
    }
    const repeat = info.caseSnapshot.repeat ?? 1;
    const executions: EvalExecutionInput[] = [];
    for (let index = 1; index <= repeat; index += 1) {
      const executionDir = repeat > 1 ? path.join(runDir, "repeats", String(index)) : runDir;
      const telemetryDir = path.join(executionDir, "telemetry");
      const score = repeat > 1
        ? await loadValidatedJson(path.join(executionDir, "score.json"), "repeat score", evalScoreSchema) as unknown as EvalScore
        : info.score;
      const packets = await loadPackets(path.join(telemetryDir, "stages", "06-packets", "packets"));
      const events = await loadValidatedJsonLines(path.join(telemetryDir, "events.jsonl"), "telemetry events", telemetryEventSchema) as TelemetryEvent[];
      const modelCalls = await loadValidatedJsonLines(path.join(telemetryDir, "model-calls.jsonl"), "model calls", llmCallRecordSchema) as LlmCallRecord[];
      const toolCalls = await loadValidatedJsonLines(path.join(telemetryDir, "tool-calls.jsonl"), "tool calls", toolCallRecordSchema) as ToolCallRecord[];
      const fileFacts = await loadValidatedJson(path.join(telemetryDir, "stages", "03-classify", "file-facts.json"), "eval file facts", z.array(fileFactsSchema)) as FileFacts[];
      const diff = await loadValidatedJson(path.join(telemetryDir, "stages", "02-diff", "diff.json"), "eval diff", unifiedDiffSchema) as unknown as UnifiedDiff;
      const plan = await loadValidatedJson(path.join(telemetryDir, "stages", "05-planner", "review-plan.json"), "eval review plan", reviewPlanSchema) as unknown as ReviewPlan;
      const candidates = await loadValidatedJson(path.join(telemetryDir, "stages", "09-verification", "candidate-findings.json"), "candidate findings", z.array(candidateFindingSchema));
      const verification = await loadValidatedJson(path.join(telemetryDir, "stages", "09-verification", "verification.json"), "verification records", z.array(verificationRecordSchema));
      const finalSelectionArtifact = await loadValidatedJson(
        path.join(telemetryDir, "stages", "10-composition", "final-selection.json"),
        "final selection",
        finalSelectionArtifactSchema
      );
      const finalFindings = await loadValidatedJson(path.join(telemetryDir, "stages", "10-composition", "final-findings.json"), "final findings", z.array(finalFindingSchema));
      const coverage = await loadValidatedJson(path.join(telemetryDir, "stages", "10-composition", "coverage.json"), "coverage", coverageArtifactSchema);
      const attention = await loadValidatedJson(path.join(telemetryDir, "stages", "10-composition", "attention.json"), "attention records", z.array(attentionRecordSchema));
      const humanAttentionRaw = await loadValidatedJson(
        path.join(telemetryDir, "stages", "10-composition", "human-attention-notes.json"),
        "human attention notes",
        humanAttentionArtifactSchema
      );
      const budgetSummary = await loadValidatedJson(path.join(telemetryDir, "stages", "10-composition", "budget-summary.json"), "budget summary", budgetSummarySchema);
      const costProfile = await loadValidatedJson(path.join(telemetryDir, "stages", "00-run", "cost-profile.json"), "cost profile", costProfileSchema);
      const modelCallsSummary = await loadValidatedJson(path.join(telemetryDir, "stages", "00-run", "model-calls-summary.json"), "model calls summary", modelCallsSummarySchema);
      const toolCallsSummary = await loadValidatedJson(path.join(telemetryDir, "stages", "00-run", "tool-calls-summary.json"), "tool calls summary", toolCallsSummarySchema);
      const runJson = await loadValidatedJson(path.join(telemetryDir, "run.json"), "run telemetry", evalRunTelemetrySchema);
      const telemetrySummary = await loadValidatedJson(path.join(telemetryDir, "telemetry.json"), "telemetry summary", telemetrySummarySchema);
      const reviewedHunkIds = coverage.records.filter((record) => record.status === "reviewed").map((record) => record.hunkId).sort();
      assertReport(reviewedHunkIds.length === coverage.status.reviewedHunks, "coverage_join_mismatch", `reviewed-hunk records disagree with coverage status in ${executionDir}`);
      const normalizedFinalFindings = finalFindings.map((finding) => ({
        ...finding,
        mergedAnchors: (finding.mergedAnchors ?? []).filter((anchor): anchor is Exclude<typeof anchor, string> => typeof anchor !== "string")
      })) as FinalFinding[];
      const scoringArtifacts: EvalArtifacts = {
        candidates: candidates as CandidateFinding[],
        verification: verification as unknown as EvalVerificationRecord[],
        finalSelection: finalSelectionArtifact.records as EvalSelectionRecord[],
        finalFindings: normalizedFinalFindings,
        humanAttentionNotes: scoringHumanAttentionNotes(humanAttentionRaw),
        attention: attention as unknown as NonNullable<EvalArtifacts["attention"]>,
        packets,
        hintEvents: scoringHintEvents(events),
        coverage: { ...(coverage.status as unknown as RunCoverageStatus), hunks: coverage.records },
        reviewPlan: plan,
        metricsSources: {
          costProfile,
          modelCallsSummary,
          toolCallsSummary,
          budgetSummary: budgetSummary as unknown as NonNullable<EvalArtifacts["metricsSources"]["budgetSummary"]>,
          runJson,
          telemetry: telemetrySummary,
          modelCalls,
          toolCalls
        }
      };
      const execution: EvalExecutionInput = {
        repeat: index,
        score,
        telemetryDir,
        packets,
        events,
        modelCalls,
        toolCalls,
        fileFacts,
        diff,
        plan,
        candidateFindings: candidates as CandidateFinding[],
        verification: verification as unknown as EvalVerificationRecord[],
        finalSelection: finalSelectionArtifact.records as EvalSelectionRecord[],
        finalSelectionArtifact,
        finalFindings: normalizedFinalFindings,
        scoringArtifacts,
        summaryArtifacts: {
          attention,
          humanAttention: humanAttentionRaw,
          budget: budgetSummary,
          cost: costProfile,
          model: modelCallsSummary,
          tool: toolCallsSummary,
          run: runJson,
          telemetry: telemetrySummary
        },
        reviewedHunkIds,
        wallTimeSeconds: runJson.durationMs / 1000
      };
      validateEvalExecutionArtifacts(execution, coverage.records, info.reviewRunId);
      executions.push(execution);
    }
    runs.push({ runNumber: info.runNumber, runDir, info, declaredCase, ...(invocationManifest === undefined ? {} : { invocationManifest }), executions });
  }
  return runs;
}

async function loadSelectedInvocationManifest(logsDir: string, selector: string): Promise<EvalInvocationManifest> {
  const invocationDir = path.join(logsDir, "invocations");
  let files: string[];
  try {
    files = (await readdir(invocationDir)).filter((entry) => entry.endsWith(".json")).sort();
  } catch (error) {
    fail("missing_invocation_manifest", `failed to read eval invocation manifests: ${invocationDir}`, {
      error: valueFingerprint(error instanceof Error ? error.message : String(error))
    });
  }
  const manifests = await Promise.all(files.map((file) =>
    loadValidatedJson(path.join(invocationDir, file), "eval invocation manifest", evalInvocationManifestSchema) as Promise<EvalInvocationManifest>
  ));
  assertReport(manifests.length > 0, "missing_invocation_manifest", `no eval invocation manifests found in ${invocationDir}`);
  const ordered = [...manifests].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt) || manifestLastRun(left) - manifestLastRun(right)
  );
  let selected: EvalInvocationManifest | undefined;
  if (manifests.some((manifest) => manifest.invocationId === selector)) {
    selected = manifests.find((manifest) => manifest.invocationId === selector);
  } else if (selector === "latest") {
    selected = ordered.at(-1);
  } else if (/^\d+$/u.test(selector)) {
    const matches = manifests.filter((manifest) => manifestLastRun(manifest) === Number(selector));
    assertReport(matches.length <= 1, "ambiguous_cohort_selector", `run ${selector} matches multiple persisted invocations; use the invocation UUID`);
    selected = matches[0];
  } else {
    const match = /^(\d+)-(\d+)$/u.exec(selector);
    assertReport(match !== null, "invalid_cohort_selector", `cohort must be latest, an invocation UUID, an ending run number, or a min-max range: ${selector}`);
    const matches = manifests.filter((manifest) => manifest.runs[0]?.runNumber === Number(match[1]) && manifestLastRun(manifest) === Number(match[2]));
    assertReport(matches.length <= 1, "ambiguous_cohort_selector", `cohort ${selector} matches multiple persisted invocations; use the invocation UUID`);
    selected = matches[0];
  }
  assertReport(selected !== undefined, "unknown_cohort", `cohort ${selector} is not an exact persisted invocation boundary`);
  validateCompleteManifest(selected);
  return selected;
}

function manifestLastRun(manifest: EvalInvocationManifest): number {
  return manifest.runs.at(-1)?.runNumber ?? -1;
}

function validateCompleteManifest(manifest: EvalInvocationManifest): void {
  const expectedIndexes = Array.from({ length: manifest.cases.length }, (_, index) => index);
  assertReport(
    manifest.status === "complete" && manifest.completedAt !== undefined &&
      stableJson(manifest.cases.map((entry) => entry.caseIndex)) === stableJson(expectedIndexes) &&
      stableJson(manifest.runs.map((entry) => entry.caseIndex)) === stableJson(expectedIndexes) &&
      manifest.runs.length === manifest.cases.length &&
      unique(manifest.runs.map((entry) => `${path.resolve(entry.logsRoot)}\0${entry.runPath}`)).length === manifest.runs.length &&
      manifest.runs.every((entry) => entry.runPath === String(entry.runNumber)),
    "partial_latest_cohort",
    "selected persisted eval invocation is incomplete or has an invalid exact ordered case boundary"
  );
}

async function loadDeclaredEvalCase(manifest: EvalInvocationManifest, info: EvalRunInfo): Promise<EvalCase> {
  const reference = info.invocation;
  assertReport(reference !== undefined, "declared_case_join", `eval run ${info.runNumber} has no invocation reference`);
  const manifestCase = manifest.cases.find((entry) => entry.caseIndex === reference.caseIndex);
  assertReport(manifestCase !== undefined, "declared_case_join", `eval run ${info.runNumber} has no declared manifest case`);
  const suiteDir = path.resolve(manifest.suiteDir);
  const casePath = path.resolve(suiteDir, manifestCase.caseFile);
  const relative = path.relative(suiteDir, casePath);
  assertReport(relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative), "declared_case_join", `eval run ${info.runNumber} case YAML escapes its declared suite`);
  let declaration: Awaited<ReturnType<typeof loadEvalCaseDeclaration>>;
  try {
    declaration = await loadEvalCaseDeclaration(casePath, suiteDir);
  } catch (error) {
    fail("declared_case_join", `failed to load the exact declared eval YAML for run ${info.runNumber}`, {
      error: valueFingerprint(error instanceof Error ? error.message : String(error))
    });
  }
  assertReport(
    declaration.file === manifestCase.caseFile && declaration.evalCase.name === manifestCase.caseName &&
      declaration.caseHash === manifestCase.caseHash && declaration.caseHash === info.caseHash &&
      stableJson(declaration.evalCase) === stableJson(info.caseSnapshot),
    "declared_case_join",
    `eval run ${info.runNumber} manifest, YAML, case hash, and snapshot do not join exactly`,
    {
      declaredHash: declaration.caseHash,
      manifestHash: manifestCase.caseHash,
      infoHash: info.caseHash,
      declaredSnapshotHash: sha256Hex(stableJson(declaration.evalCase)),
      persistedSnapshotHash: sha256Hex(stableJson(info.caseSnapshot))
    }
  );
  return declaration.evalCase;
}

function validateInvocationManifestRun(manifest: EvalInvocationManifest, info: EvalRunInfo, runDir?: string): void {
  const reference = info.invocation;
  assertReport(reference !== undefined && manifest.invocationId === reference.id, "invocation_manifest_join", `eval run ${info.runNumber} invocation identity disagrees with its manifest`);
  const declared = manifest.cases.find((entry) => entry.caseIndex === reference.caseIndex);
  const recorded = manifest.runs.find((entry) => entry.caseIndex === reference.caseIndex);
  assertReport(
    declared !== undefined && recorded !== undefined &&
      declared.caseName === info.caseName && declared.caseHash === info.caseHash && declared.caseFile === info.caseFile &&
      recorded.caseName === info.caseName && recorded.caseHash === info.caseHash && recorded.runNumber === info.runNumber,
    "invocation_manifest_join",
    `eval run ${info.runNumber} does not exactly match its invocation manifest entry`
  );
  if (runDir !== undefined && recorded !== undefined) {
    assertReport(
      path.resolve(runDir) === path.resolve(recorded.logsRoot, recorded.runPath) && recorded.runPath === String(recorded.runNumber),
      "invocation_root_ownership",
      `eval run ${info.runNumber} was not loaded from its exact manifest-owned root and path`
    );
  }
}

function validateEvalExecutionArtifacts(
  execution: EvalExecutionInput,
  coverageRecords: Array<z.infer<typeof coverageArtifactSchema>["records"][number]>,
  expectedRunId: string | undefined
): void {
  const packetIds = new Set(execution.packets.map((packet) => packet.id));
  const packetHunkIds = new Set(execution.packets.flatMap((packet) => packet.hunks.map((hunk) => hunk.hunkId)));
  const diffHunks = execution.diff.files.flatMap((file) => file.hunks);
  const diffHunkById = new Map(diffHunks.map((hunk) => [hunk.id, hunk]));
  assertReport(diffHunkById.size === diffHunks.length, "duplicate_diff_hunk", "eval diff contains duplicate hunk IDs");
  assertReport(execution.packets.every((packet) => packet.hunks.every((hunk) => diffHunkById.get(hunk.hunkId)?.path === packet.path)), "packet_diff_join", "eval packet hunks do not join exactly to the recorded diff");
  const planHunkIds = execution.plan.coverage.map((decision) => decision.hunkId);
  assertReport(unique(planHunkIds).length === planHunkIds.length, "plan_diff_join", "eval review plan contains duplicate hunk IDs");
  assertReport(execution.plan.coverage.every((decision) => diffHunkById.get(decision.hunkId)?.path === decision.path), "plan_diff_join", "eval review plan decisions do not join to the recorded diff");
  assertReport(unique(execution.candidateFindings.map((finding) => finding.id)).length === execution.candidateFindings.length, "duplicate_candidate_finding", "candidate findings contain duplicate IDs");
  assertReport(unique(execution.finalFindings.map((finding) => finding.id)).length === execution.finalFindings.length, "duplicate_final_finding", "final findings contain duplicate IDs");
  const factPaths = new Set(execution.fileFacts.map((facts) => facts.path));
  assertReport(factPaths.size === execution.fileFacts.length, "duplicate_file_facts", "eval file facts contain duplicate paths");
  assertReport(execution.packets.every((packet) => factPaths.has(packet.path)), "packet_facts_join", "one or more eval packets lack file facts");
  const coverageIds = coverageRecords.map((record) => record.hunkId);
  assertReport(unique(coverageIds).length === coverageIds.length, "coverage_join_mismatch", "coverage records contain duplicate hunk IDs");
  assertReport([...packetHunkIds].every((hunkId) => coverageIds.includes(hunkId)), "coverage_join_mismatch", "packet hunks are missing from coverage records");
  assertReport(execution.reviewedHunkIds.every((hunkId) => packetHunkIds.has(hunkId)), "coverage_join_mismatch", "reviewed coverage records reference packet-less hunks");
  const modelCallIds = execution.modelCalls.map((call) => call.callId);
  assertReport(unique(modelCallIds).length === modelCallIds.length, "duplicate_model_call", "model-call telemetry contains duplicate IDs");
  const toolCallIds = execution.toolCalls.map((call) => call.toolCallId);
  assertReport(unique(toolCallIds).length === toolCallIds.length, "duplicate_tool_call", "tool-call telemetry contains duplicate IDs");
  assertReport(execution.events.every((event, index) => execution.events.findIndex((candidate) => candidate.eventId === event.eventId) === index), "duplicate_event", "event telemetry contains duplicate IDs");
  assertReport(execution.modelCalls.every((call) => call.packetId === undefined || packetIds.has(call.packetId)), "model_packet_join", "model-call telemetry references unknown packets");
  assertReport(execution.toolCalls.every((call) => call.packetId === undefined || packetIds.has(call.packetId)), "tool_packet_join", "tool-call telemetry references unknown packets");
  assertReport(execution.toolCalls.every((call) => call.modelCallId === undefined || modelCallIds.includes(call.modelCallId)), "tool_model_join", "tool-call telemetry references unknown model calls");
  assertReport(execution.events.every((event) => event.message !== "same_file_atoms_packed" || (typeof event.data?.packetId === "string" && packetIds.has(event.data.packetId))), "event_packet_join", "packing telemetry references unknown packets");
  const observedRunIds = sortedUnique([
    ...execution.events.map((event) => event.runId),
    ...execution.modelCalls.map((call) => call.runId),
    ...execution.toolCalls.map((call) => call.runId)
  ]);
  assertReport(observedRunIds.length <= 1, "telemetry_run_join", "eval telemetry streams mix review run IDs", { observedRunIds });
  if (expectedRunId !== undefined && observedRunIds.length === 1) {
    assertReport(observedRunIds[0] === expectedRunId, "telemetry_run_join", "eval telemetry run ID differs from info.json reviewRunId");
  }
}

export function reconstructEvidenceArtifacts(execution: EvalExecutionInput): EvalArtifacts {
  const rawModel = rawModelEvidence(execution.modelCalls, execution.events);
  const rawTool = rawToolEvidence(execution.toolCalls);
  const existingBudget = execution.scoringArtifacts.metricsSources.budgetSummary;
  const omittedNotes = humanAttentionOutputCounts(execution.summaryArtifacts?.humanAttention).omitted;
  const rawContextPressure = rawContextPressureEvidence(execution, omittedNotes);
  const rawBudget = existingBudget === undefined ? undefined : ({
    ...existingBudget,
    completeness: execution.scoringArtifacts.coverage?.partial === true ? "partial" : "complete",
    partialReasons: execution.scoringArtifacts.coverage?.partial === true ? [...execution.scoringArtifacts.coverage.reasons] : [],
    overruns: rawBudgetEvents(execution.events, "budget_overrun"),
    dispatchBlocks: rawBudgetEvents(execution.events, "budget_dispatch_blocked"),
    ...(rawContextPressure === undefined ? {} : { contextPressure: rawContextPressure })
  } as unknown as NonNullable<EvalArtifacts["metricsSources"]["budgetSummary"]>);
  return {
    ...execution.scoringArtifacts,
    candidates: execution.candidateFindings,
    verification: execution.verification,
    finalSelection: execution.finalSelection,
    finalFindings: execution.finalFindings,
    packets: execution.packets,
    reviewPlan: execution.plan,
    metricsSources: {
      ...execution.scoringArtifacts.metricsSources,
      costProfile: rawCostEvidence(rawModel),
      modelCallsSummary: rawModel,
      toolCallsSummary: rawTool,
      ...(rawBudget === undefined ? {} : { budgetSummary: rawBudget }),
      runJson: {
        ...(isRecord(execution.scoringArtifacts.metricsSources.runJson) ? execution.scoringArtifacts.metricsSources.runJson : {}),
        durationMs: execution.wallTimeSeconds * 1000
      },
      modelCalls: execution.modelCalls,
      toolCalls: execution.toolCalls,
    }
  };
}

function recomputeEvidenceScore(run: EvalCaseRunInput, execution: EvalExecutionInput): EvalScore {
  return scoreEvalRun(run.declaredCase, reconstructEvidenceArtifacts(execution), "live");
}

function validChangedLineAnchor(anchor: CandidateFinding["anchor"], packet: ReviewPacket, diffByHunk: Map<string, DiffFile["hunks"][number]>): boolean {
  if (anchor === undefined || anchor.path !== packet.path || !packet.hunks.some((hunk) => hunk.hunkId === anchor.hunkId)) {
    return false;
  }
  const hunk = diffByHunk.get(anchor.hunkId);
  if (hunk === undefined || hunk.path !== anchor.path) {
    return false;
  }
  return anchor.side === "RIGHT"
    ? hunk.lines.some((line) => line.kind === "add" && line.newLineNumber === anchor.line)
    : hunk.lines.some((line) => line.kind === "delete" && line.oldLineNumber === anchor.line);
}

type NumericRecord = Record<string, number>;

function emptyRawCacheCounts(): NumericRecord {
  return { hit: 0, miss: 0, disabled: 0, write: 0 };
}

function updateRawCacheCounts(target: NumericRecord, status: LlmCallRecord["cacheStatus"]): void {
  if (status === "write") {
    target.miss = (target.miss ?? 0) + 1;
    target.write = (target.write ?? 0) + 1;
  } else {
    target[status] = (target[status] ?? 0) + 1;
  }
}

function emptyRawFinalize(): NumericRecord {
  return {
    compactCalls: 0, fullCalls: 0, noFindingCalls: 0, candidateOrUnknownCalls: 0, promptChars: 0,
    noFindingPromptChars: 0, candidateOrUnknownPromptChars: 0, costUSD: 0, noFindingCostUSD: 0,
    candidateOrUnknownCostUSD: 0, unknownCostCalls: 0
  };
}

function updateRawFinalize(target: NumericRecord, call: LlmCallRecord, providerCalls: number): void {
  if (providerCalls === 0 || call.finalizeMode === undefined) {
    return;
  }
  target[call.finalizeMode === "compact" ? "compactCalls" : "fullCalls"]! += 1;
  if (call.finalizeTarget === "no_findings") {
    target.noFindingCalls! += 1;
    target.noFindingPromptChars! += call.promptChars;
    target.noFindingCostUSD! += call.costUSD ?? 0;
  } else if (call.finalizeTarget === "candidate_or_unknown") {
    target.candidateOrUnknownCalls! += 1;
    target.candidateOrUnknownPromptChars! += call.promptChars;
    target.candidateOrUnknownCostUSD! += call.costUSD ?? 0;
  }
  target.promptChars! += call.promptChars;
  if (call.costUSD === undefined) {
    target.unknownCostCalls! += 1;
  } else {
    target.costUSD! += call.costUSD;
  }
}

function emptyRawModelBucket(stage = false): Record<string, unknown> {
  return {
    ...(stage ? { recordCount: 0, count: 0, statuses: { ok: 0, schema_invalid: 0, transient_error: 0, auth_error: 0, timeout: 0, aborted: 0 } } : { totalRecords: 0, totalCalls: 0 }),
    providerCalls: 0, inputTokens: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    billableInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, costUSD: 0,
    inputCostUSD: 0, outputCostUSD: 0, cacheReadCostUSD: 0, cacheWriteCostUSD: 0, unknownCostCalls: 0,
    cache: emptyRawCacheCounts(), retryAttempts: 0, repairCalls: 0, schemaInvalidCalls: 0,
    ...(stage ? {} : { toolChoiceDowngradedCalls: 0 }), finalize: emptyRawFinalize()
  };
}

function updateRawModelBucket(bucket: Record<string, unknown>, call: LlmCallRecord, stage: boolean): void {
  const providerCalls = call.cacheStatus === "hit" ? 0 : 1;
  bucket[stage ? "recordCount" : "totalRecords"] = Number(bucket[stage ? "recordCount" : "totalRecords"]) + 1;
  bucket[stage ? "count" : "totalCalls"] = Number(bucket[stage ? "count" : "totalCalls"]) + providerCalls;
  bucket.providerCalls = Number(bucket.providerCalls) + providerCalls;
  if (providerCalls > 0) {
    for (const key of ["inputTokens", "uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "billableInputTokens", "outputTokens", "reasoningTokens", "totalTokens"] as const) {
      bucket[key] = Number(bucket[key]) + (call[key] ?? 0);
    }
  }
  updateRawCacheCounts(bucket.cache as NumericRecord, call.cacheStatus);
  bucket.retryAttempts = Number(bucket.retryAttempts) + (providerCalls > 0 && call.attempt > 1 ? 1 : 0);
  bucket.repairCalls = Number(bucket.repairCalls) + (call.kind === "repair" ? 1 : 0);
  bucket.schemaInvalidCalls = Number(bucket.schemaInvalidCalls) + (call.status === "schema_invalid" ? 1 : 0);
  if (!stage) {
    bucket.toolChoiceDowngradedCalls = Number(bucket.toolChoiceDowngradedCalls) + (providerCalls > 0 && call.toolChoiceDowngraded === true ? 1 : 0);
  } else {
    const statuses = bucket.statuses as NumericRecord;
    statuses[call.status] = (statuses[call.status] ?? 0) + 1;
  }
  updateRawFinalize(bucket.finalize as NumericRecord, call, providerCalls);
  if (providerCalls === 0) {
    return;
  }
  if (call.costUSD === undefined) {
    bucket.unknownCostCalls = Number(bucket.unknownCostCalls) + 1;
  } else {
    for (const key of ["costUSD", "inputCostUSD", "outputCostUSD", "cacheReadCostUSD", "cacheWriteCostUSD"] as const) {
      bucket[key] = Number(bucket[key]) + (call[key] ?? 0);
    }
  }
}

function cacheAliases(bucket: Record<string, unknown>): Record<string, unknown> {
  return {
    ...bucket,
    localModelCallCache: { ...(bucket.cache as NumericRecord) },
    providerPromptCache: {
      readTokens: bucket.cacheReadTokens, writeTokens: bucket.cacheWriteTokens,
      readCostUSD: bucket.cacheReadCostUSD, writeCostUSD: bucket.cacheWriteCostUSD
    }
  };
}

function emptyRawSchemaRecovery(): NumericRecord {
  return {
    schemaInvalidCalls: 0, schemaInvalidRecovered: 0, schemaInvalidUnrecovered: 0,
    schemaRepairAttempts: 0, schemaRepairRecovered: 0, deterministicSchemaRecovered: 0, schemaRecoveryFailed: 0
  };
}

function rawSchemaRecoveryEvidence(calls: LlmCallRecord[], events: TelemetryEvent[]): Record<string, unknown> {
  const total = emptyRawSchemaRecovery();
  const byStage: Record<string, NumericRecord> = {};
  const add = (stage: number, delta: Partial<NumericRecord>): void => {
    const targets = stage === 0 ? [total] : [total, byStage[String(stage)] ?? (byStage[String(stage)] = emptyRawSchemaRecovery())];
    for (const target of targets) {
      for (const [key, value] of Object.entries(delta)) target[key] = (target[key] ?? 0) + (value ?? 0);
    }
  };
  for (const call of calls) {
    if (call.status === "schema_invalid") add(call.stage, { schemaInvalidCalls: 1 });
    if (call.kind !== "repair") continue;
    if (call.status === "ok") {
      add(call.stage, { schemaRepairAttempts: 1, schemaRepairRecovered: 1, schemaInvalidRecovered: 1 });
    } else {
      add(call.stage, { schemaRepairAttempts: 1 });
      if (call.status === "schema_invalid" && call.stage !== 7 && call.stage !== 9) add(call.stage, { schemaRecoveryFailed: 1 });
    }
  }
  for (const event of events) {
    if (event.message === "schema_invalid_submit_recovered") {
      const recovered = event.data?.schemaRepairUsed === true ? 2 : 1;
      add(event.stage, { deterministicSchemaRecovered: recovered, schemaInvalidRecovered: recovered });
    } else if (event.message === "stage7_schema_cleanup_recovered") {
      add(event.stage, { deterministicSchemaRecovered: 1, schemaInvalidRecovered: 1 });
    } else if ([
      "schema_invalid_submit_recovery_invalid", "stage7_schema_cleanup_rejected", "stage7_schema_repair_failed",
      "verification_schema_repair_failed"
    ].includes(event.message)) {
      add(event.stage, { schemaRecoveryFailed: 1 });
    }
  }
  const finalize = (input: NumericRecord): NumericRecord => ({
    ...input,
    schemaInvalidRecovered: Math.min(input.schemaInvalidRecovered ?? 0, input.schemaInvalidCalls ?? 0),
    schemaInvalidUnrecovered: Math.max(0, (input.schemaInvalidCalls ?? 0) - Math.min(input.schemaInvalidRecovered ?? 0, input.schemaInvalidCalls ?? 0))
  });
  return { ...finalize(total), byStage: Object.fromEntries(Object.entries(byStage).map(([stage, counters]) => [stage, finalize(counters)])) };
}

function rawModelEvidence(calls: LlmCallRecord[], events: TelemetryEvent[] = []): Record<string, unknown> {
  const total = emptyRawModelBucket();
  const byStage: Record<string, Record<string, unknown>> = {};
  for (const call of calls) {
    updateRawModelBucket(total, call, false);
    const key = String(call.stage);
    const bucket = byStage[key] ?? (byStage[key] = emptyRawModelBucket(true));
    updateRawModelBucket(bucket, call, true);
  }
  const schemaRecovery = rawSchemaRecoveryEvidence(calls, events);
  const recoveryByStage = schemaRecovery.byStage as Record<string, NumericRecord>;
  return {
    ...cacheAliases(total),
    schemaRecovery,
    byStage: Object.fromEntries(Object.entries(byStage).map(([stage, bucket]) => [stage, {
      ...cacheAliases(bucket),
      schemaRecovery: recoveryByStage[stage] ?? emptyRawSchemaRecovery()
    }]))
  };
}

function modelEvidenceView(summary: Record<string, unknown>): Record<string, unknown> {
  const topKeys = [...Object.keys(emptyRawModelBucket()), "localModelCallCache", "providerPromptCache", "schemaRecovery"];
  const stageKeys = [...Object.keys(emptyRawModelBucket(true)), "localModelCallCache", "providerPromptCache", "schemaRecovery"];
  const pick = (input: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((key) => [key, input[key]]));
  const stages = isRecord(summary.byStage) ? summary.byStage : {};
  return {
    ...pick(summary, topKeys),
    byStage: Object.fromEntries(Object.entries(stages).map(([stage, value]) => [stage, isRecord(value) ? pick(value, stageKeys) : value]))
  };
}

function rawCostEvidence(model: Record<string, unknown>): Record<string, unknown> {
  const breakdown = (source: Record<string, unknown>) => ({
    uncachedInput: { tokens: source.uncachedInputTokens, costUSD: source.inputCostUSD },
    providerPromptCacheRead: { tokens: source.cacheReadTokens, costUSD: source.cacheReadCostUSD },
    providerPromptCacheWrite: { tokens: source.cacheWriteTokens, costUSD: source.cacheWriteCostUSD },
    output: { tokens: source.outputTokens, costUSD: source.outputCostUSD },
    total: { tokens: source.totalTokens, costUSD: source.costUSD }
  });
  const byStage = model.byStage as Record<string, Record<string, unknown>>;
  return {
    totalCostUSD: model.costUSD, unknownCostCalls: model.unknownCostCalls,
    localModelCallCache: model.localModelCallCache, providerPromptCache: model.providerPromptCache,
    costBreakdown: breakdown(model),
    tokens: Object.fromEntries(["inputTokens", "uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "billableInputTokens", "outputTokens", "reasoningTokens", "totalTokens"].map((key) => [key, model[key]])),
    cost: {
      inputCostUSD: model.inputCostUSD, outputCostUSD: model.outputCostUSD, cacheReadCostUSD: model.cacheReadCostUSD,
      cacheWriteCostUSD: model.cacheWriteCostUSD, totalCostUSD: model.costUSD
    },
    byStage: Object.fromEntries(Object.entries(byStage).map(([stage, value]) => {
      const { schemaRecovery: _schemaRecovery, ...costValue } = value;
      return [stage, { ...costValue, costBreakdown: breakdown(costValue) }];
    }))
  };
}

function emptyRawToolCache(): NumericRecord {
  return { hits: 0, misses: 0, writes: 0, disabled: 0, inflightHits: 0, evictions: 0, backendExecutions: 0, savedBackendCalls: 0 };
}

function emptyRawToolBucket(): Record<string, unknown> {
  return { count: 0, errors: 0, rejections: 0, degraded: 0, backendExecutions: 0, savedBackendCalls: 0, totalDurationMs: 0, totalResultChars: 0, resultCache: emptyRawToolCache() };
}

function updateRawToolCache(cache: NumericRecord, call: ToolCallRecord): void {
  if (call.backendExecuted === true) cache.backendExecutions! += 1;
  if (call.cacheStatus === "hit") {
    cache.hits! += 1; cache.savedBackendCalls! += 1;
    if (call.cacheHitKind === "inflight") cache.inflightHits! += 1;
  } else if (call.cacheStatus === "write") {
    cache.misses! += 1; cache.writes! += 1;
  } else if (call.cacheStatus === "miss") {
    cache.misses! += 1;
  } else {
    cache.disabled! += 1;
  }
  cache.evictions! += call.cacheEvictedEntries ?? 0;
}

function updateRawToolBucket(bucket: Record<string, unknown>, call: ToolCallRecord): void {
  bucket.count = Number(bucket.count) + 1;
  bucket.errors = Number(bucket.errors) + (call.status === "error" ? 1 : 0);
  bucket.rejections = Number(bucket.rejections) + (call.status === "rejected" ? 1 : 0);
  bucket.degraded = Number(bucket.degraded) + (call.degraded ? 1 : 0);
  bucket.backendExecutions = Number(bucket.backendExecutions) + (call.backendExecuted === true ? 1 : 0);
  bucket.savedBackendCalls = Number(bucket.savedBackendCalls) + (call.cacheStatus === "hit" ? 1 : 0);
  bucket.totalDurationMs = Number(bucket.totalDurationMs) + call.durationMs;
  bucket.totalResultChars = Number(bucket.totalResultChars) + call.resultChars;
  updateRawToolCache(bucket.resultCache as NumericRecord, call);
}

function rawToolEvidence(calls: ToolCallRecord[]): Record<string, unknown> {
  const resultCache = emptyRawToolCache();
  const byTool: Record<string, Record<string, unknown>> = {};
  const byStage: Record<string, Record<string, unknown>> = {};
  for (const call of calls) {
    updateRawToolCache(resultCache, call);
    updateRawToolBucket(byTool[call.tool] ?? (byTool[call.tool] = emptyRawToolBucket()), call);
    updateRawToolBucket(byStage[String(call.stage)] ?? (byStage[String(call.stage)] = emptyRawToolBucket()), call);
  }
  const average = (buckets: Record<string, Record<string, unknown>>) => Object.fromEntries(Object.entries(buckets).map(([key, bucket]) => [key, {
    ...bucket,
    averageDurationMs: Number(bucket.count) === 0 ? 0 : Number(bucket.totalDurationMs) / Number(bucket.count),
    averageResultChars: Number(bucket.count) === 0 ? 0 : Number(bucket.totalResultChars) / Number(bucket.count)
  }]));
  return { totalCalls: calls.length, resultCache, byTool: average(byTool), byStage: average(byStage) };
}

function eventStageEvidence(events: TelemetryEvent[], recovery: Record<string, unknown>): Record<string, unknown> {
  const recoveryByStage = recovery.byStage as Record<string, NumericRecord>;
  const byStage: Record<string, { events: number; levels: NumericRecord; cache: NumericRecord; startedAt?: string; completedAt?: string; runtimeMs: number; schemaRecovery: NumericRecord }> = {};
  for (let stage = 0; stage <= 11; stage += 1) {
    byStage[String(stage)] = {
      events: 0, levels: { debug: 0, info: 0, warn: 0, error: 0 }, cache: emptyRawCacheCounts(), runtimeMs: 0,
      schemaRecovery: recoveryByStage[String(stage)] ?? emptyRawSchemaRecovery()
    };
  }
  for (const event of events) {
    const bucket = byStage[String(event.stage)]!;
    bucket.events += 1;
    bucket.levels[event.level] = (bucket.levels[event.level] ?? 0) + 1;
    if (event.cacheStatus !== undefined) bucket.cache[event.cacheStatus] = (bucket.cache[event.cacheStatus] ?? 0) + 1;
    if (event.message === "stage_started" && bucket.startedAt === undefined) bucket.startedAt = event.timestamp;
    if ((event.message === "stage_completed" || event.message === "stage_failed") && bucket.completedAt === undefined) {
      bucket.completedAt = event.timestamp;
      if (bucket.startedAt !== undefined) bucket.runtimeMs += Math.max(0, Date.parse(event.timestamp) - Date.parse(bucket.startedAt));
    }
  }
  return byStage;
}

function telemetryStageEvidenceView(input: Record<string, unknown>): Record<string, unknown> {
  const stages = isRecord(input.stages) ? input.stages : {};
  return Object.fromEntries(Object.entries(stages).map(([stage, value]) => {
    if (!isRecord(value)) return [stage, value];
    return [stage, Object.fromEntries(["events", "levels", "cache", "startedAt", "completedAt", "runtimeMs", "schemaRecovery"]
      .filter((key) => value[key] !== undefined).map((key) => [key, value[key]]))];
  }));
}

function humanAttentionOutputCounts(input: unknown): { emitted: number; omitted: number } {
  return isRecord(input) && Array.isArray(input.outputNotes)
    ? { emitted: input.outputNotes.length, omitted: typeof input.omittedCount === "number" ? input.omittedCount : 0 }
    : { emitted: Array.isArray(input) ? input.length : 0, omitted: 0 };
}

function rawBudgetEvents(events: TelemetryEvent[], message: "budget_overrun" | "budget_dispatch_blocked"): Array<Record<string, unknown>> {
  return events.filter((event) => event.message === message).map((event) => ({ ...(event.data ?? {}) }));
}

function incrementStageCount(target: NumericRecord, stage: number): void {
  if (stage !== 0) {
    target[String(stage)] = (target[String(stage)] ?? 0) + 1;
  }
}

function rawContextPressureEvidence(execution: EvalExecutionInput, omittedNotes: number): Record<string, unknown> | undefined {
  const localRejections = execution.toolCalls.filter((call) => call.status === "rejected" &&
    isLocalToolBudgetRejectionReason(call.degradationReason ?? call.errorCode ?? "rejected"));
  const degradedCalls = execution.toolCalls.filter((call) => call.status !== "rejected" && call.degraded);
  const rejectionByStage: NumericRecord = {};
  const degradedByStage: NumericRecord = {};
  const rejectionReasons: NumericRecord = {};
  for (const call of localRejections) {
    incrementStageCount(rejectionByStage, call.stage);
    const reason = call.degradationReason ?? call.errorCode ?? "rejected";
    rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
  }
  for (const call of degradedCalls) {
    incrementStageCount(degradedByStage, call.stage);
  }
  const extensions = {
    granted: 0,
    denied: 0,
    resultChars: 0,
    grantedByStage: {} as NumericRecord,
    deniedByStage: {} as NumericRecord
  };
  for (const event of execution.events) {
    if (event.message === "tool_budget_extension_granted") {
      extensions.granted += 1;
      incrementStageCount(extensions.grantedByStage, event.stage);
      extensions.resultChars += typeof event.data?.resultChars === "number" ? event.data.resultChars : 0;
    } else if (event.message === "tool_budget_extension_denied") {
      extensions.denied += 1;
      incrementStageCount(extensions.deniedByStage, event.stage);
    }
  }
  const hasExtensionPressure = extensions.granted > 0 || extensions.denied > 0 || extensions.resultChars > 0;
  if (localRejections.length === 0 && !hasExtensionPressure && degradedCalls.length === 0 &&
      execution.packets.every((packet) => packet.degraded === undefined) && omittedNotes === 0) {
    return undefined;
  }
  return {
    toolBudgetRejections: localRejections.length,
    toolBudgetRejectionsByStage: rejectionByStage,
    ...(hasExtensionPressure ? { toolBudgetExtensions: extensions } : {}),
    degradedToolResults: degradedCalls.length,
    degradedToolResultsByStage: degradedByStage,
    degradedHunks: sum(execution.packets.filter((packet) => packet.degraded !== undefined).map((packet) => packet.hunks.length)),
    rejectionReasons: Object.entries(rejectionReasons)
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
    unresolvedNotes: { emitted: humanAttentionOutputCounts(execution.summaryArtifacts?.humanAttention).emitted, omitted: omittedNotes }
  };
}

function attentionRelationsMatch(
  records: Array<z.infer<typeof attentionRecordSchema>>,
  execution: EvalExecutionInput
): boolean {
  const candidatePacketById = new Map(execution.candidateFindings.map((candidate) => [candidate.id, candidate.producedBy.packetId]));
  const countByPacket = (predicate: (candidate: CandidateFinding) => boolean): NumericRecord => {
    const counts: NumericRecord = {};
    for (const candidate of execution.candidateFindings.filter(predicate)) {
      counts[candidate.producedBy.packetId] = (counts[candidate.producedBy.packetId] ?? 0) + 1;
    }
    return counts;
  };
  const promoted = countByPacket((candidate) => candidate.provenance?.source === "uncertainty_promotion");
  const direct = countByPacket((candidate) => candidate.provenance?.source !== "uncertainty_promotion");
  const kept: NumericRecord = {};
  for (const record of execution.verification) {
    if ("verdict" in record && (record.verdict.verdict === "keep" || record.verdict.verdict === "revise")) {
      const packetId = candidatePacketById.get(record.candidateId);
      if (packetId !== undefined) kept[packetId] = (kept[packetId] ?? 0) + 1;
    }
  }
  const published: NumericRecord = {};
  for (const finding of execution.finalFindings.filter((candidate) => candidate.publication !== "suppressed")) {
    const packetIds = new Set([finding.id, ...finding.mergedCandidateIds].flatMap((id) => candidatePacketById.get(id) ?? []));
    for (const packetId of packetIds) published[packetId] = (published[packetId] ?? 0) + 1;
  }
  const plannedHunkIds = new Set(execution.plan.coverage.map((decision) => decision.hunkId));
  return records.length === execution.packets.length && records.every((record, index) => {
    const packet = execution.packets[index];
    if (packet === undefined) return false;
    const coverageSource = packet.coverageEscalation !== undefined
      ? `escalated:${packet.coverageEscalation.rule}`
      : packet.hunks.some((hunk) => hunk.plannerFallbackReason !== undefined) ||
          packet.hunks.every((hunk) => !plannedHunkIds.has(hunk.hunkId))
        ? "deterministic_default"
        : "planner";
    return record.packetId === packet.id && record.path === packet.path && record.coverage === packet.coverage &&
      record.coverageSource === coverageSource && record.ensemblePasses >= 1 &&
      record.directCandidates === (direct[packet.id] ?? 0) && record.promotedCandidates === (promoted[packet.id] ?? 0) &&
      record.keptVerified === (kept[packet.id] ?? 0) && record.published === (published[packet.id] ?? 0);
  });
}

function humanAttentionRelationsMatch(input: z.infer<typeof humanAttentionArtifactSchema>): boolean {
  if (Array.isArray(input)) return true;
  const noteIds = input.notes.map((note) => note.id);
  const groupKeys = input.groups.map((group) => group.key);
  const noteIdSet = new Set(noteIds);
  const groupByKey = new Map(input.groups.map((group) => [group.key, group]));
  const uniqueReferences = (values: string[]): boolean => unique(values).length === values.length && values.every((value) => groupByKey.has(value));
  const findingSuppressed = input.suppressedByFindings.map((record) => record.groupKey);
  const verificationSuppressed = input.suppressedByVerification.map((record) => record.groupKey);
  const partition = [...input.keptForOutputGroupIds, ...findingSuppressed, ...verificationSuppressed].sort();
  return unique(noteIds).length === noteIds.length && unique(groupKeys).length === groupKeys.length &&
    input.groups.every((group) => group.count === group.noteIds.length && unique(group.noteIds).length === group.noteIds.length &&
      group.noteIds.every((id) => noteIdSet.has(id))) &&
    uniqueReferences(input.composerPromptGroupIds) && uniqueReferences(input.outputGroupIds) && uniqueReferences(input.keptForOutputGroupIds) &&
    uniqueReferences(findingSuppressed) && uniqueReferences(verificationSuppressed) &&
    stableJson([...groupKeys].sort()) === stableJson(partition) &&
    stableJson(input.outputGroupIds) === stableJson(input.keptForOutputGroupIds.slice(0, input.outputGroupIds.length)) &&
    input.outputNotes.length === input.outputGroupIds.length &&
    input.omittedCount === input.keptForOutputGroupIds.length - input.outputGroupIds.length &&
    input.suppressedByFindings.every((record) => stableJson(record.noteIds) === stableJson(groupByKey.get(record.groupKey)?.noteIds)) &&
    input.suppressedByVerification.every((record) => stableJson(record.noteIds) === stableJson(groupByKey.get(record.groupKey)?.noteIds));
}

function validateRawSummaryEvidence(run: EvalCaseRunInput, execution: EvalExecutionInput, label: string, failures: ReportFailure[]): void {
  const artifacts = execution.summaryArtifacts;
  if (artifacts === undefined) {
    return;
  }
  const parsedModel = modelCallsSummarySchema.safeParse(artifacts.model);
  const parsedCost = costProfileSchema.safeParse(artifacts.cost);
  const parsedTool = toolCallsSummarySchema.safeParse(artifacts.tool);
  const parsedBudget = budgetSummarySchema.safeParse(artifacts.budget);
  const parsedRun = evalRunTelemetrySchema.safeParse(artifacts.run);
  const parsedTelemetry = telemetrySummarySchema.safeParse(artifacts.telemetry);
  const parsedAttention = z.array(attentionRecordSchema).safeParse(artifacts.attention);
  const parsedHuman = humanAttentionArtifactSchema.safeParse(artifacts.humanAttention);
  if (!parsedModel.success || !parsedCost.success || !parsedTool.success || !parsedBudget.success || !parsedRun.success ||
      !parsedTelemetry.success || !parsedAttention.success || !parsedHuman.success) {
    failures.push(failure("paid_summary_schema", `${label}/repeat ${execution.repeat} summary evidence is not strictly shaped`));
    return;
  }
  const rawModel = rawModelEvidence(execution.modelCalls, execution.events);
  const rawTool = rawToolEvidence(execution.toolCalls);
  const rawDerived = reconstructRunTelemetryDerivedEvidence(execution.events, execution.modelCalls);
  const rawCost = rawCostEvidence(rawModel);
  const modelMatches = stableJson(modelEvidenceView(parsedModel.data as unknown as Record<string, unknown>)) === stableJson(rawModel);
  const telemetryModelMatches = stableJson(modelEvidenceView(parsedTelemetry.data.modelCalls as unknown as Record<string, unknown>)) === stableJson(rawModel);
  const costMatches = stableJson(parsedCost.data) === stableJson(rawCost);
  const toolMatches = stableJson(parsedTool.data) === stableJson(rawTool) && stableJson(parsedTelemetry.data.toolCalls) === stableJson(rawTool);
  const runTotals = parsedRun.data.totals;
  const telemetryTotals = parsedTelemetry.data.totals;
  const totalView = (totals: typeof runTotals) => ({
    events: totals.events, modelCallRecords: totals.modelCallRecords, modelCalls: totals.modelCalls, providerCalls: totals.providerCalls,
    toolCalls: totals.toolCalls, toolResultCache: totals.toolResultCache, inputTokens: totals.inputTokens,
    uncachedInputTokens: totals.uncachedInputTokens, cacheReadTokens: totals.cacheReadTokens, cacheWriteTokens: totals.cacheWriteTokens,
    billableInputTokens: totals.billableInputTokens, outputTokens: totals.outputTokens, reasoningTokens: totals.reasoningTokens,
    totalTokens: totals.totalTokens, totalCostUSD: totals.totalCostUSD, inputCostUSD: totals.inputCostUSD,
    outputCostUSD: totals.outputCostUSD, cacheReadCostUSD: totals.cacheReadCostUSD, cacheWriteCostUSD: totals.cacheWriteCostUSD,
    costBreakdown: totals.costBreakdown,
    unknownCostCalls: totals.unknownCostCalls, cache: totals.cache, localModelCallCache: totals.localModelCallCache,
    providerPromptCache: totals.providerPromptCache, retryAttempts: totals.retryAttempts, repairCalls: totals.repairCalls,
    schemaInvalidCalls: totals.schemaInvalidCalls, schemaRecovery: totals.schemaRecovery,
    stage7SchemaRepair: totals.stage7SchemaRepair, logOverflow: totals.logOverflow,
    filesChanged: totals.filesChanged, hunks: totals.hunks, packets: totals.packets, packetReviews: totals.packetReviews,
    candidates: totals.candidates, verified: totals.verified, finalFindings: totals.finalFindings, postedComments: totals.postedComments
  });
  const rawTotals = {
    events: execution.events.length, modelCallRecords: rawModel.totalRecords, modelCalls: rawModel.providerCalls, providerCalls: rawModel.providerCalls,
    toolCalls: execution.toolCalls.length, toolResultCache: rawTool.resultCache, inputTokens: rawModel.inputTokens,
    uncachedInputTokens: rawModel.uncachedInputTokens, cacheReadTokens: rawModel.cacheReadTokens, cacheWriteTokens: rawModel.cacheWriteTokens,
    billableInputTokens: rawModel.billableInputTokens, outputTokens: rawModel.outputTokens, reasoningTokens: rawModel.reasoningTokens,
    totalTokens: rawModel.totalTokens, totalCostUSD: rawModel.costUSD, inputCostUSD: rawModel.inputCostUSD,
    outputCostUSD: rawModel.outputCostUSD, cacheReadCostUSD: rawModel.cacheReadCostUSD, cacheWriteCostUSD: rawModel.cacheWriteCostUSD,
    costBreakdown: rawCost.costBreakdown,
    unknownCostCalls: rawModel.unknownCostCalls, cache: rawModel.cache, localModelCallCache: rawModel.localModelCallCache,
    providerPromptCache: rawModel.providerPromptCache, retryAttempts: rawModel.retryAttempts, repairCalls: rawModel.repairCalls,
    schemaInvalidCalls: rawModel.schemaInvalidCalls, schemaRecovery: rawModel.schemaRecovery,
    stage7SchemaRepair: rawDerived.stage7SchemaRepair, logOverflow: rawDerived.logOverflow,
    ...rawDerived.pipelineTotals
  };
  const totalsMatch = stableJson(totalView(runTotals)) === stableJson(rawTotals) && stableJson(totalView(telemetryTotals)) === stableJson(rawTotals);
  const stagesMatch = stableJson(telemetryStageEvidenceView(parsedTelemetry.data as unknown as Record<string, unknown>)) ===
    stableJson(eventStageEvidence(execution.events, rawModel.schemaRecovery as Record<string, unknown>));
  const recoveryMatches = stableJson(parsedTelemetry.data.schemaRecovery) === stableJson(rawModel.schemaRecovery);
  const pipelineMatches = stableJson({
    workers: parsedTelemetry.data.workers,
    packets: parsedTelemetry.data.packets,
    lenses: parsedTelemetry.data.lenses,
    coverage: parsedTelemetry.data.coverage,
    candidates: parsedTelemetry.data.candidates,
    verdicts: parsedTelemetry.data.verdicts,
    dedup: parsedTelemetry.data.dedup,
    finalSelection: parsedTelemetry.data.finalSelection,
    posting: parsedTelemetry.data.posting
  }) === stableJson(rawDerived.pipeline);
  const repairAndOverflowMatch = stableJson(parsedTelemetry.data.schemaRepair.stage7) === stableJson(rawDerived.stage7SchemaRepair) &&
    stableJson(parsedTelemetry.data.logs.bufferedOverflow) === stableJson(rawDerived.logOverflow) &&
    parsedTelemetry.data.events === execution.events.length;
  const budget = parsedBudget.data;
  const rawByStage = rawModel.byStage as Record<string, Record<string, unknown>>;
  const budgetUsage = {
    modelCalls: rawModel.providerCalls,
    totalTokens: rawModel.totalTokens,
    costUSD: Number(rawModel.costUSD) > 0 ? rawModel.costUSD : undefined,
    byStage: Object.entries(rawByStage).map(([stage, entry]) => ({ stage: Number(stage), modelCalls: entry.providerCalls, totalTokens: entry.totalTokens }))
      .sort((left, right) => left.stage - right.stage)
  };
  const usageMatches = stableJson(budget.usage) === stableJson(budgetUsage) &&
    budget.effective.timeoutMs === run.info.effectiveConfig?.review.timeoutMs &&
    budget.effective.maxBudgetTokens === run.info.effectiveConfig?.review.maxBudgetTokens;
  const noteCounts = humanAttentionOutputCounts(parsedHuman.data);
  const contextMatches = stableJson(budget.contextPressure) === stableJson(rawContextPressureEvidence(execution, noteCounts.omitted));
  const budgetEventsMatch = stableJson(budget.overruns) === stableJson(rawBudgetEvents(execution.events, "budget_overrun")) &&
    stableJson(budget.dispatchBlocks) === stableJson(rawBudgetEvents(execution.events, "budget_dispatch_blocked"));
  const rawRunIds = sortedUnique([
    ...execution.events.map((event) => event.runId),
    ...execution.modelCalls.map((call) => call.runId),
    ...execution.toolCalls.map((call) => call.runId)
  ]);
  const identityMatches = parsedRun.data.runId === parsedTelemetry.data.runId &&
    (run.info.reviewRunId === undefined || parsedRun.data.runId === run.info.reviewRunId) &&
    (rawRunIds.length === 0 || (rawRunIds.length === 1 && rawRunIds[0] === parsedRun.data.runId)) &&
    parsedRun.data.startedAt === parsedTelemetry.data.startedAt && parsedRun.data.finishedAt === parsedTelemetry.data.finishedAt &&
    parsedRun.data.completedAt === parsedRun.data.finishedAt && parsedTelemetry.data.completedAt === parsedTelemetry.data.finishedAt &&
    parsedRun.data.durationMs === Math.max(0, Date.parse(parsedRun.data.finishedAt) - Date.parse(parsedRun.data.startedAt)) &&
    parsedRun.data.durationMs === parsedTelemetry.data.durationMs && parsedRun.data.durationMs === execution.wallTimeSeconds * 1000;
  const attentionMatches = attentionRelationsMatch(parsedAttention.data, execution) && humanAttentionRelationsMatch(parsedHuman.data);
  if (!modelMatches || !telemetryModelMatches || !costMatches || !toolMatches || !totalsMatch || !stagesMatch || !recoveryMatches ||
      !pipelineMatches || !repairAndOverflowMatch || !usageMatches || !contextMatches || !budgetEventsMatch || !identityMatches || !attentionMatches) {
    failures.push(failure("paid_summary_reconciliation", `${label}/repeat ${execution.repeat} summaries do not independently reconcile to raw records`, {
      modelMatches, telemetryModelMatches, costMatches, toolMatches, totalsMatch, stagesMatch, recoveryMatches, pipelineMatches,
      repairAndOverflowMatch, usageMatches, contextMatches, budgetEventsMatch, identityMatches, attentionMatches
    }));
  }
}

function validateExecutionEvidence(run: EvalCaseRunInput, execution: EvalExecutionInput, label: string, failures: ReportFailure[]): EvalScore {
  validateRawSummaryEvidence(run, execution, label, failures);
  const packetById = new Map(execution.packets.map((packet) => [packet.id, packet]));
  const diffHunks = execution.diff.files.flatMap((file) => file.hunks);
  const diffByHunk = new Map(diffHunks.map((hunk) => [hunk.id, hunk]));
  const candidateById = new Map(execution.candidateFindings.map((finding) => [finding.id, finding]));
  const verificationById = new Map(execution.verification.map((record) => [record.candidateId, record]));
  const selectionById = new Map(execution.finalSelection.map((record) => [record.findingId, record]));
  const finalByFingerprint = new Map(execution.finalFindings.map((finding) => [finding.fingerprint, finding]));
  const selectionArtifact = execution.finalSelectionArtifact;
  const effectiveReview = run.info.effectiveConfig?.review;
  const policyConfig: CodegenieConfig = {
    ...structuredClone(defaultConfig),
    review: {
      ...structuredClone(defaultConfig.review),
      ...(effectiveReview ?? {})
    }
  };
  let relationsValid =
    candidateById.size === execution.candidateFindings.length && verificationById.size === execution.verification.length &&
    selectionById.size === execution.finalSelection.length && finalByFingerprint.size === execution.finalFindings.length &&
    verificationById.size === candidateById.size && effectiveReview !== undefined &&
    stableJson(selectionArtifact.records) === stableJson(execution.finalSelection) &&
    ((selectionArtifact.composition.mode === "deterministic_fallback" || selectionArtifact.composition.mode === "schema_repair_fallback")
      ? (selectionArtifact.composition.fallbackReason?.trim().length ?? 0) > 0
      : selectionArtifact.composition.fallbackReason === undefined);

  for (const candidate of execution.candidateFindings) {
    const packet = packetById.get(candidate.producedBy.packetId);
    const record = verificationById.get(candidate.id);
    const producerValid = packet !== undefined && candidate.producedBy.kind === "packet" &&
      (candidate.producedBy.stage === 7 || candidate.producedBy.stage === 8) && candidate.producedBy.lensId.trim().length > 0 &&
      packet.lenses.includes(candidate.producedBy.lensId) && candidate.producedBy.skillIds.every((id) => id.trim().length > 0);
    const provenanceValid = candidate.provenance === undefined || (
      packetById.has(candidate.provenance.sourcePacketId) && candidate.provenance.question.trim().length > 0 && candidate.provenance.reason.trim().length > 0 &&
      record?.candidateProvenance !== undefined && stableJson(record.candidateProvenance) === stableJson(candidate.provenance)
    );
    const recordValid = record !== undefined && (!("verdict" in record) || record.verdict.candidateId === candidate.id);
    relationsValid &&= producerValid && packet !== undefined && candidate.path === packet.path && provenanceValid && recordValid;
  }

  const keptIds = new Set(execution.verification.flatMap((record) =>
    "verdict" in record && record.verdict.verdict !== "reject" && record.verdict.verdict !== "incomplete" && record.verdict.verificationIncomplete !== true
      ? [record.candidateId]
      : []
  ));
  const reconstructedVerified = reconstructVerifiedFindingsFromArtifacts(
    execution.candidateFindings,
    execution.verification,
    execution.packets,
    execution.diff
  );
  const verifiedById = new Map(reconstructedVerified.map((finding) => [finding.id, finding]));
  const verifierPolicy = reconstructGatedVerifierCandidatesFromArtifacts(
    execution.candidateFindings,
    execution.packets,
    execution.diff,
    policyConfig
  );
  const gateEvaluationById = new Map(verifierPolicy.evaluations.map((evaluation) => [evaluation.candidate.id, evaluation]));
  const reconstructedVerifierCandidates = new Map(verifierPolicy.candidates.map((finding) => [finding.id, finding]));
  relationsValid &&= verifiedById.size === reconstructedVerified.length && stableJson([...verifiedById.keys()].sort()) === stableJson([...keptIds].sort());
  relationsValid &&= selectionById.size === keptIds.size && [...keptIds].every((id) => selectionById.has(id));
  for (const record of execution.verification) {
    const ownEvaluation = gateEvaluationById.get(record.candidateId);
    const hasVerdict = "verdict" in record;
    // Completed and budget-limited duplicate records are emitted with the
    // representative's record metadata. Lane-limited duplicate records have
    // no verdict and are emitted with the duplicate candidate's own metadata.
    const gateFactsCandidateId = effectiveReview?.verify !== false && hasVerdict && record.duplicateOf !== undefined
      ? record.duplicateOf
      : record.candidateId;
    const gateEvaluation = gateEvaluationById.get(gateFactsCandidateId);
    const gateCandidate = gateEvaluation?.candidate;
    if (gateCandidate === undefined || ownEvaluation === undefined) {
      relationsValid = false;
    }
    const gatePacket = gateCandidate === undefined ? undefined : packetById.get(gateCandidate.producedBy.packetId);
    relationsValid &&= gateCandidate !== undefined && stableJson(record.gateFacts) === stableJson(
      gateEvaluation?.decision.facts
    );
    const ownDecision = ownEvaluation?.decision;
    const ownGate = ownEvaluation?.anchorStripped === true ? "gate_anchor_stripped" : "passed";
    const expectedScheduledDecision = gateEvaluation?.decision.outcome === "schedule"
      ? gateEvaluation.decision.lane === "evidence_resolution" ? "scheduled_for_evidence_resolution" : "scheduled"
      : undefined;
    const laneLimited = !hasVerdict && ownDecision?.outcome === "schedule" &&
      ownDecision.lane === "evidence_resolution" && record.gateReason === "low_confidence_evidence_resolution_lane_limit";
    const gateStateValid = ownDecision?.outcome === "suppress"
      ? !hasVerdict && record.gate === (ownEvaluation?.anchorStripped === true ? "gate_anchor_stripped" : "suppressed") &&
        record.gateDecision === "suppressed" && record.gateReason === (ownEvaluation?.anchorStripped === true
          ? `invalid_anchor; ${ownDecision.reason}`
          : ownDecision.reason) && record.verificationLane === undefined && record.gateFacts !== undefined
      : laneLimited
        ? record.gate === "suppressed" && record.gateDecision === "scheduled_for_evidence_resolution" &&
          record.verificationLane === "evidence_resolution" && record.gateFacts !== undefined
        : hasVerdict && record.gate === ownGate && record.gateDecision === expectedScheduledDecision &&
          record.gateReason === (gateEvaluation?.decision.outcome === "schedule" ? gateEvaluation.decision.reason : undefined) &&
          record.verificationLane === (gateEvaluation?.decision.outcome === "schedule" ? gateEvaluation.decision.lane : undefined) &&
          record.gateFacts !== undefined;
    relationsValid &&= gateStateValid;
    const clusteredCandidate = reconstructedVerifierCandidates.get(record.candidateId);
    if (ownDecision?.outcome === "suppress") {
      relationsValid &&= clusteredCandidate === undefined && record.duplicateOf === undefined && record.clusterId === undefined;
    } else if (effectiveReview?.verify === false) {
      relationsValid &&= clusteredCandidate !== undefined && record.duplicateOf === undefined && record.clusterId === undefined && hasVerdict &&
        stableJson(record.verdict) === stableJson({
          candidateId: record.candidateId,
          verdict: "keep",
          reason: "verification disabled by config",
          requiredEvidencePresent: true,
          falsePositiveRisk: "low"
        });
    } else {
      relationsValid &&= clusteredCandidate !== undefined &&
        record.duplicateOf === clusteredCandidate?.duplicateOf &&
        record.clusterId === clusteredCandidate?.clusterId;
    }
    if ("verdict" in record) {
      if (record.duplicateOf !== undefined) {
        const representativeRecord = verificationById.get(record.duplicateOf);
        relationsValid &&= representativeRecord !== undefined && "verdict" in representativeRecord && clusteredCandidate !== undefined &&
          stableJson(record.verdict) === stableJson(reconstructDuplicateVerificationVerdict(clusteredCandidate, representativeRecord.verdict));
      }
      const packet = record.verdict.finalFinding === undefined ? undefined : packetById.get(record.verdict.finalFinding.producedBy.packetId);
      if (record.verdict.finalFinding !== undefined && (packet === undefined || !validChangedLineAnchor(record.verdict.finalFinding.anchor, packet, diffByHunk))) {
        relationsValid = false;
      }
      if (record.verdict.revisedAnchor !== undefined) {
        const candidate = candidateById.get(record.candidateId);
        const candidatePacket = candidate === undefined ? undefined : packetById.get(candidate.producedBy.packetId);
        if (candidatePacket === undefined || !validChangedLineAnchor(record.verdict.revisedAnchor, candidatePacket, diffByHunk)) {
          relationsValid = false;
        }
      }
      if (keptIds.has(record.candidateId)) {
        const source = verifiedById.get(record.candidateId);
        const finals = execution.finalFindings.filter((finding) => finding.mergedCandidateIds.includes(record.candidateId));
        if (source === undefined || source.id !== record.candidateId || finals.length !== 1) {
          relationsValid = false;
        } else {
          const target = finals[0]!;
          const lineageAnchor = record.verdict.revisedAnchor ?? source.anchor;
          const lineageAnchorRetained = source.anchorSource === "backfill_packet_representative" ||
            lineageAnchor === undefined || stableJson(target.anchor) === stableJson(lineageAnchor) ||
            (target.mergedAnchors ?? []).some((anchor) => stableJson(anchor) === stableJson(lineageAnchor));
          const sourcePath = lineageAnchor?.path ?? source.path;
          const sourceFieldsRetained = target.id !== record.candidateId || (
            stableJson(target.producedBy) === stableJson(source.producedBy) && target.category === source.category &&
            target.failureMode === source.failureMode && target.whyThisMatters === source.whyThisMatters &&
            target.verification === source.verification
          );
          relationsValid &&= lineageAnchorRetained && sourceFieldsRetained &&
            (target.mergedCategories === undefined || target.mergedCategories.includes(source.category)) &&
            (target.mergedPaths === undefined || target.mergedPaths.includes(sourcePath)) &&
            (target.mergedTitles === undefined || target.mergedTitles.includes(source.title));
        }
      }
    }
  }

  const composerEvidence = reconstructComposerGroupsFromArtifacts(reconstructedVerified, execution.packets);
  const composerCandidateById = new Map(composerEvidence.publishable.map((finding) => [finding.id, finding]));
  const pretrimSuppressedIds = new Set(composerEvidence.pretrimSuppressedIds);
  const capSuppressionReasons = new Set(["severity-threshold", "confidence-threshold", "report-cap"]);
  const publicationDowngradeReasons = new Set(["min-inline-confidence", "soft-comment-cap", "unanchorable"]);
  const policyDrafts = execution.finalFindings.flatMap((finding) => {
    const mergedFindings = unique(finding.mergedCandidateIds).flatMap((id) => composerCandidateById.get(id) ?? []);
    if (mergedFindings.length !== finding.mergedCandidateIds.length) {
      return [];
    }
    const selections = finding.mergedCandidateIds.flatMap((id) => selectionById.get(id) ?? []);
    const isPretrimmed = finding.mergedCandidateIds.some((id) => pretrimSuppressedIds.has(id));
    const hasPolicyDowngrade = selections.some((selection) => publicationDowngradeReasons.has(selection.reason));
    const requestedPublication = isPretrimmed
      ? "suppressed" as const
      : finding.publication === "inline" || hasPolicyDowngrade
        ? "inline" as const
        : finding.publication === "summary-only"
          ? "summary-only" as const
          : mergedFindings.some((candidate) => candidate.anchor !== undefined)
            ? "inline" as const
            : "summary-only" as const;
    const policyReasonApplied = selections.some((selection) =>
      capSuppressionReasons.has(selection.reason) || publicationDowngradeReasons.has(selection.reason)
    );
    const representativeSelection = selectionById.get(finding.id);
    const representativeBaseReason = !policyReasonApplied &&
      (representativeSelection?.reason === "composer-selected" || representativeSelection?.reason === "composer_omitted_finding")
      ? representativeSelection.reason
      : "composer-selected";
    if (representativeBaseReason === "composer_omitted_finding" && selectionArtifact.composition.mode !== "llm_degraded") {
      relationsValid = false;
    }
    return [{
      mergedFindings,
      finalBody: finding.finalBody,
      requestedPublication,
      baseSelection: finding.mergedCandidateIds.map((id) => isPretrimmed
        ? { findingId: id, decision: "suppressed" as const, reason: "composer-pre-trim" }
        : id === finding.id
          ? { findingId: id, decision: "published" as const, reason: representativeBaseReason }
          : { findingId: id, decision: "merged" as const, reason: "composer-merged", mergedIntoFingerprint: finding.fingerprint })
    }];
  });
  const verifierVerdicts = execution.verification.flatMap((record) =>
    "verdict" in record && (effectiveReview?.verify === false || record.duplicateOf === undefined) ? [record.verdict] : []
  );
  const composerPolicy = reconstructComposerPolicyFromArtifacts(
    policyDrafts,
    execution.packets,
    execution.diff,
    policyConfig,
    verifierVerdicts
  );
  relationsValid &&= policyDrafts.length === execution.finalFindings.length &&
    stableJson(composerPolicy.selection) === stableJson(execution.finalSelection) &&
    stableJson(composerPolicy.findings.map((finding) => finding.id)) === stableJson(execution.finalFindings.map((finding) => finding.id));
  const reconstructedFinalById = new Map(composerPolicy.findings.map((finding) => [finding.id, finding]));
  for (const finding of execution.finalFindings) {
    const packet = packetById.get(finding.producedBy.packetId);
    const representative = candidateById.get(finding.id);
    const mergedIds = unique(finding.mergedCandidateIds);
    const mergedValid = mergedIds.length > 0 && mergedIds.length === finding.mergedCandidateIds.length &&
      mergedIds.every((id) => candidateById.has(id) && keptIds.has(id) && selectionById.has(id));
    const publicationAnchorOwner = finding.anchor === undefined ? undefined : [...packetById.values()]
      .find((candidatePacket) => candidatePacket.hunks.some((hunk) => hunk.hunkId === finding.anchor?.hunkId));
    const publicationAnchorValid = finding.anchor === undefined
      ? finding.publication !== "inline" && finding.changedLine === false
      : publicationAnchorOwner !== undefined && validChangedLineAnchor(finding.anchor, publicationAnchorOwner, diffByHunk) && finding.changedLine === true;
    const anchorsValid = packet !== undefined && publicationAnchorValid &&
      (finding.mergedAnchors ?? []).every((anchor) => {
        const owner = [...packetById.values()].find((candidatePacket) => candidatePacket.hunks.some((hunk) => hunk.hunkId === anchor.hunkId));
        return owner !== undefined && validChangedLineAnchor(anchor, owner, diffByHunk);
      });
    const selections = mergedIds.flatMap((id) => selectionById.get(id) ?? []);
    const decisionsValid = finding.publication === "suppressed"
      ? selections.length === mergedIds.length && selections.every((selection) => selection.decision === "suppressed")
      : selections.length === mergedIds.length && selections.filter((selection) => selection.decision === "published" && selection.findingId === finding.id).length === 1 &&
        selections.every((selection) => selection.findingId === finding.id
          ? selection.decision === "published"
          : selection.decision === "merged" && selection.mergedIntoFingerprint === finding.fingerprint);
    const reconstructed = reconstructedFinalById.get(finding.id);
    const withoutMergedAnchors = (value: FinalFinding): Omit<FinalFinding, "mergedAnchors"> => {
      const { mergedAnchors: _anchors, ...rest } = value;
      return rest;
    };
    const exactFinalMetadata = reconstructed !== undefined && reconstructed.id === finding.id &&
      stableJson(withoutMergedAnchors(reconstructed)) === stableJson(withoutMergedAnchors(finding)) &&
      (finding.mergedAnchors ?? []).every((anchor) => (reconstructed.mergedAnchors ?? [])
        .some((expected) => stableJson(expected) === stableJson(anchor)));
    relationsValid &&= representative !== undefined && stableJson(representative.producedBy) === stableJson(finding.producedBy) &&
      finding.path === packet?.path && mergedValid && anchorsValid && decisionsValid && exactFinalMetadata;
  }

  const publicationById = new Map(selectionArtifact.publicationAnchors.map((record) => [record.findingId, record]));
  relationsValid &&= publicationById.size === selectionArtifact.publicationAnchors.length &&
    stableJson(selectionArtifact.publicationAnchors) === stableJson(composerPolicy.publicationAnchors) &&
    publicationById.size === execution.finalFindings.length && execution.finalFindings.every((finding) => {
      const record = publicationById.get(finding.id);
      if (record === undefined || record.fingerprint !== finding.fingerprint || record.publication !== finding.publication ||
          stableJson(record.anchor) !== stableJson(finding.anchor) || record.reason.trim().length === 0) {
        return false;
      }
      if (record.source === "none") {
        return record.sourceFindingId === undefined && record.anchor === undefined;
      }
      if (record.sourceFindingId === undefined || !finding.mergedCandidateIds.includes(record.sourceFindingId) || record.anchor === undefined) {
        return false;
      }
      return record.source === "selected" ? record.sourceFindingId === finding.id : record.sourceFindingId !== finding.id;
    });

  const confidenceIds = selectionArtifact.confidenceSelections.map((record) => record.findingId);
  relationsValid &&= unique(confidenceIds).length === confidenceIds.length &&
    stableJson(selectionArtifact.confidenceSelections) === stableJson(composerPolicy.confidenceSelections) &&
    selectionArtifact.confidenceSelections.every((record) => {
    const finding = execution.finalFindings.find((candidate) => candidate.id === record.findingId);
    const representative = verifiedById.get(record.findingId);
    const sourceValid = record.reason === "representative"
      ? record.sourceFindingId === undefined
      : record.sourceFindingId !== undefined && record.sourceFindingId !== record.findingId;
    return finding !== undefined && representative !== undefined && record.confidence === finding.confidence && sourceValid &&
      record.representativeConfidence === representative.confidence &&
      (record.sourceFindingId === undefined || finding.mergedCandidateIds.includes(record.sourceFindingId));
  });

  const groupedIds = selectionArtifact.groups.flatMap((group) => group.findingIds);
  relationsValid &&= unique(selectionArtifact.groups.map((group) => group.fingerprint)).length === selectionArtifact.groups.length &&
    unique(groupedIds).length === groupedIds.length &&
    stableJson(selectionArtifact.groups) === stableJson(composerEvidence.groups.map(({ representativeId: _representativeId, ...group }) => group)) &&
    stableJson(composerEvidence.pretrimSuppressedIds.sort()) === stableJson(execution.finalSelection
      .filter((record) => record.decision === "suppressed" && record.reason === "composer-pre-trim")
      .map((record) => record.findingId).sort());

  if (!relationsValid) {
    failures.push(failure("paid_evidence_relations", `${label}/repeat ${execution.repeat} candidate, verification, selection, and final evidence is not fully relational`, {
      candidates: execution.candidateFindings.length,
      verification: execution.verification.length,
      selections: execution.finalSelection.length,
      finals: execution.finalFindings.length
    }));
  }

  const recomputed = recomputeEvidenceScore(run, execution);
  if (stableJson(execution.score) !== stableJson(recomputed)) {
    failures.push(failure("paid_evidence_score_reconstruction", `${label}/repeat ${execution.repeat} score does not exactly reconstruct from relational artifacts`, {
      persisted: valueFingerprint(execution.score),
      reconstructed: valueFingerprint(recomputed)
    }));
  }
  const providerCalls = execution.modelCalls.filter((call) => call.cacheStatus !== "hit");
  const callCostUSD = sum(providerCalls.map((call) => call.costUSD ?? Number.NaN));
  if (providerCalls.some((call) => call.costUSD === undefined || !Number.isFinite(call.costUSD)) ||
      !Number.isFinite(callCostUSD) || Math.abs((execution.score.metrics.costUSD ?? 0) - callCostUSD) > 1e-9) {
    failures.push(failure("evidence_cost_accounting", `${label}/repeat ${execution.repeat} score cost does not exactly reconcile with finite model-call cost evidence`, {
      persistedCostUSD: execution.score.metrics.costUSD,
      modelCallCostUSD: callCostUSD
    }));
  }
  return recomputed;
}

function validateRunEvidence(run: EvalCaseRunInput, label: string, failures: ReportFailure[]): EvalScore[] {
  const canonicalRepeats = run.executions.map((execution) => execution.repeat);
  if (stableJson(canonicalRepeats) !== stableJson(Array.from({ length: run.executions.length }, (_, index) => index + 1))) {
    failures.push(failure("paid_evidence_repeat_order", `${label} repeat evidence is not in canonical repeats/<repeat> order`));
  }
  const scores = run.executions.map((execution) => validateExecutionEvidence(run, execution, label, failures));
  if (scores.length === 1) {
    if (stableJson(run.info.score) !== stableJson(scores[0]!)) {
      failures.push(failure("paid_evidence_aggregate", `${label} info score does not reconstruct from its execution evidence`));
    }
    return scores;
  }
  const recomputed = aggregateRepeatScores(run.declaredCase, run.executions.map((execution, index) => ({
    runDir: `repeats/${execution.repeat}`,
    score: scores[index]!,
    artifacts: reconstructEvidenceArtifacts(execution)
  })));
  if (run.info.repeats === undefined || stableJson(run.info.repeats) !== stableJson(recomputed.aggregate) ||
      stableJson(run.info.score) !== stableJson(recomputed.score)) {
    failures.push(failure("paid_evidence_aggregate", `${label} repeat aggregate does not reconstruct exactly from per-repeat evidence`));
  }
  return scores;
}

export function validateReplayArtifacts(
  runId: string,
  summary: z.infer<typeof resolvedInputSchema>,
  diff: UnifiedDiff,
  filterDecisions: FileFilterDecision[],
  fileFacts: FileFacts[],
  plan: ReviewPlan,
  dossier: PlannerDossier,
  runInfo: Record<string, unknown>
): { base: string; head: string } {
  assertReport(dossier.runId === runId && runInfo.runId === runId, "replay_run_join", `recorded replay artifacts disagree on run ID for ${runId}`);
  const review = isRecord(runInfo.review) ? runInfo.review : {};
  const baseRefs = sortedUnique([
    summary.baseRef,
    summary.mergeBase,
    summary.startCommit,
    summary.pr?.baseSha,
    dossier.target.baseRef,
    dossier.target.mergeBase,
    typeof review.baseRef === "string" ? review.baseRef : undefined,
    typeof review.mergeBase === "string" ? review.mergeBase : undefined
  ].filter((value): value is string => value !== undefined));
  const headRefs = sortedUnique([
    summary.headRef,
    summary.headSha,
    summary.endCommit,
    summary.pr?.headSha,
    dossier.target.headRef,
    dossier.target.headSha,
    typeof review.headRef === "string" ? review.headRef : undefined,
    typeof review.headSha === "string" ? review.headSha : undefined
  ].filter((value): value is string => value !== undefined));
  assertReport(baseRefs.length === 1 && headRefs.length === 1, "replay_ref_join", `recorded replay artifacts disagree on base/head refs for ${runId}`, {
    baseRefHashes: baseRefs.map((value) => sha256Hex(value)),
    headRefHashes: headRefs.map((value) => sha256Hex(value))
  });
  const base = baseRefs[0];
  const head = headRefs[0];
  assertReport(base !== undefined && head !== undefined, "missing_refs", `recorded run ${runId} does not contain explicit base/head refs`);

  const diffPaths = diff.files.map((file) => file.path);
  const diffHunks = diff.files.flatMap((file) => file.hunks);
  assertReport(unique(diffPaths).length === diffPaths.length, "duplicate_diff_path", `recorded diff contains duplicate file paths for ${runId}`);
  assertReport(unique(diffHunks.map((hunk) => hunk.id)).length === diffHunks.length, "duplicate_diff_hunk", `recorded diff contains duplicate hunk IDs for ${runId}`);
  assertReport(diff.files.every((file) => file.hunks.every((hunk) => hunk.path === file.path)), "diff_path_join", `recorded diff hunk/file paths disagree for ${runId}`);

  const decisionPaths = filterDecisions.map((decision) => decision.path);
  assertReport(unique(decisionPaths).length === decisionPaths.length && stableJson([...decisionPaths].sort()) === stableJson([...diffPaths].sort()), "filter_diff_join", `filter decisions do not form an exact join with the recorded diff for ${runId}`);
  const keptPaths = filterDecisions.filter((decision) => decision.action === "keep").map((decision) => decision.path).sort();
  const factPaths = fileFacts.map((facts) => facts.path);
  assertReport(unique(factPaths).length === factPaths.length && stableJson([...factPaths].sort()) === stableJson(keptPaths), "facts_filter_join", `file facts do not form an exact join with kept files for ${runId}`);
  const diffByPath = new Map(diff.files.map((file) => [file.path, file]));
  assertReport(fileFacts.every((facts) => {
    const file = diffByPath.get(facts.path);
    return file !== undefined && facts.hunkCount === file.hunks.length && facts.changedLines === sum(file.hunks.flatMap((hunk) => hunk.lines).map((line) => line.kind === "context" ? 0 : 1));
  }), "facts_diff_join", `file-fact counts disagree with the recorded diff for ${runId}`);

  const diffHunkById = new Map(diffHunks.map((hunk) => [hunk.id, hunk]));
  const coverageIds = plan.coverage.map((decision) => decision.hunkId);
  assertReport(unique(coverageIds).length === coverageIds.length, "plan_diff_join", `review plan contains duplicate hunk IDs for ${runId}`);
  assertReport(plan.coverage.every((decision) => {
    const hunk = diffHunkById.get(decision.hunkId);
    return hunk !== undefined && hunk.path === decision.path && keptPaths.includes(decision.path);
  }), "plan_diff_join", `review plan references unknown or filtered hunks for ${runId}`);
  return { base, head };
}

async function replayOne(repo: string, runDir: string): Promise<ReplayRow> {
  const runId = path.basename(runDir);
  const summary = await loadValidatedJson(path.join(runDir, "stages", "01-input", "resolved-input.json"), "resolved input", resolvedInputSchema);
  const diff = await loadValidatedJson(path.join(runDir, "stages", "02-diff", "diff.json"), "recorded diff", unifiedDiffSchema) as unknown as UnifiedDiff;
  const filterDecisions = await loadValidatedJson(path.join(runDir, "stages", "02-diff", "file-filter-decisions.json"), "file filter decisions", z.array(fileFilterDecisionSchema)) as FileFilterDecision[];
  const fileFacts = await loadValidatedJson(path.join(runDir, "stages", "03-classify", "file-facts.json"), "file facts", z.array(fileFactsSchema)) as FileFacts[];
  const plan = await loadValidatedJson(path.join(runDir, "stages", "05-planner", "review-plan.json"), "review plan", reviewPlanSchema) as unknown as ReviewPlan;
  const dossier = await loadValidatedJson(path.join(runDir, "stages", "05-planner", "planner-dossier.json"), "planner dossier", plannerDossierSchema) as unknown as PlannerDossier;
  const runInfo = await loadValidatedJson(path.join(runDir, "run.json"), "run metadata", runMetadataSchema) as Record<string, unknown>;
  const refs = validateReplayArtifacts(runId, summary, diff, filterDecisions, fileFacts, plan, dossier, runInfo);
  const { base, head } = refs;
  if (runId.includes("dca8d870")) {
    assertReport(
      base === "d1c49bdf6a8002ec2ec27faac94a932d736532b2" && head === "fbb5f8761c2c296e115af17e919a7c35d9de8373",
      "stale_replay_refs",
      "motivating run refs differ from Plan 102",
      { base, head }
    );
  }
  const git = createGitClient(repo);
  assertReport(await git.commitExists(base), "missing_ref", `base ref ${base} does not exist in ${repo}`);
  assertReport(await git.commitExists(head), "missing_ref", `head ref ${head} does not exist in ${repo}`);
  const actualBase = await git.revParse(base);
  const actualHead = await git.revParse(head);
  const rawDiff = await git.diff(actualBase, actualHead);
  assertReport(rawDiff.length === summary.rawDiffChars, "recorded_diff_mismatch", `rebuilt diff length differs for ${runId}`, {
    recorded: summary.rawDiffChars,
    actual: rawDiff.length
  });
  const rebuiltDiff = stripCredentials(parseDiff(rawDiff)) as UnifiedDiff;
  validateRecordedDiffParity(runId, diff, rebuiltDiff);
  const tempRoot = await mkdtemp(path.join(tmpdir(), "plan102-packet-replay-"));
  const worktree = path.join(tempRoot, "head");
  let worktreeAttempted = false;
  try {
    // Set this before invoking git: worktree add can fail after partially
    // registering or creating the target path.
    worktreeAttempted = true;
    await runGit(repo, ["worktree", "add", "--detach", worktree, actualHead], { errorCode: "invalid_args" });
    const resolved: ResolvedReviewInput = {
      ...(summary as Omit<ResolvedReviewInput, "rawDiff">),
      repoRoot: worktree,
      baseRef: actualBase,
      mergeBase: actualBase,
      headRef: actualHead,
      headSha: actualHead,
      commits: summary.commits as ResolvedReviewInput["commits"],
      rawDiff
    };
    const keptPaths = new Set(filterDecisions.filter((decision) => decision.action === "keep").map((decision) => decision.path));
    const kept = diff.files.filter((file) => keptPaths.has(file.path));
    const config = replayConfig(dossier, runInfo);
    const indexCapture = createCaptureTelemetry(`${runId}-index`);
    const repoIndex = await buildRepositoryIndex(resolved, kept, fileFacts, config, indexCapture.telemetry);
    const enabledLenses = dossier.lenses.map((lens) => lens.id);
    const reviewContext = packetReviewContextFromDossier(dossier);
    const offCapture = createCaptureTelemetry(`${runId}-off`);
    const offConfig = structuredClone(config) as CodegenieConfig;
    offConfig.review.packSameFileHunks = false;
    offConfig.review.packedToolBudgetMode = "base";
    const offPackets = await buildReviewPackets(plan, kept, fileFacts, repoIndex, offCapture.telemetry, {
      config: offConfig,
      enabledLenses,
      reviewContext
    });
    const artifactOffPackets = stripCredentials(offPackets);
    const onCapture = createCaptureTelemetry(`${runId}-on`);
    const onConfig = structuredClone(config) as CodegenieConfig;
    onConfig.review.packSameFileHunks = true;
    onConfig.review.packedToolBudgetMode = "base";
    const onPackets = await buildReviewPackets(plan, kept, fileFacts, repoIndex, onCapture.telemetry, {
      config: onConfig,
      enabledLenses,
      reviewContext
    });
    const artifactOnPackets = stripCredentials(onPackets);
    const recordedPackets = await loadPackets(path.join(runDir, "stages", "06-packets", "packets"), { allowLegacyDispatchRank: true });
    const flagOffParity = historicalFlagOffParityView(runId, recordedPackets, artifactOffPackets);
    return analyzeReplayComparison({
      runId,
      recordedPackets,
      offPackets: artifactOffPackets,
      onPackets: artifactOnPackets,
      onEvents: onCapture.captured.events,
      fileFacts,
      diff,
      plan,
      expectedRefs: { base, head },
      actualRefs: { base: actualBase, head: actualHead },
      flagOffParityPackets: flagOffParity.packets,
      flagOffParityMigrations: flagOffParity.migrations,
      modelCallsObserved: indexCapture.captured.modelCalls.length + offCapture.captured.modelCalls.length + onCapture.captured.modelCalls.length
    });
  } finally {
    await finalizeReplayCleanup(
      runId,
      worktreeAttempted,
      async () => runGit(repo, ["worktree", "remove", "--force", worktree], { errorCode: "invalid_args" }).then(() => undefined),
      async () => rm(tempRoot, { recursive: true, force: true }),
      async () => {
        const listing = await runGit(repo, ["worktree", "list", "--porcelain"], { errorCode: "invalid_args" });
        const registered = listing.split("\n").some((line) => line === `worktree ${worktree}`);
        return !existsSync(worktree) && !registered;
      }
    );
  }
}

export async function finalizeReplayCleanup(
  runId: string,
  worktreeAttempted: boolean,
  removeWorktree: () => Promise<void>,
  removeTempRoot: () => Promise<void>,
  verifyWorktreeRemoved: () => Promise<boolean>
): Promise<void> {
  const errors: unknown[] = [];
  let removalError: unknown;
  if (worktreeAttempted) {
    try {
      await removeWorktree();
    } catch (error) {
      removalError = error;
    }
  }
  try {
    await removeTempRoot();
  } catch (error) {
    errors.push(error);
  }
  if (worktreeAttempted) {
    try {
      if (!await verifyWorktreeRemoved()) {
        errors.push(removalError ?? new Error("worktree remains registered or present on disk"));
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    fail("replay_cleanup_failed", `failed to remove replay worktree for ${runId}`, {
      errors: errors.map((error) => valueFingerprint(error instanceof Error ? error.message : String(error)))
    });
  }
}

function replayConfig(dossier: PlannerDossier, runInfo: Record<string, unknown>): CodegenieConfig {
  const config = structuredClone(defaultConfig) as CodegenieConfig;
  if (dossier.depth === "light" || dossier.depth === "normal" || dossier.depth === "deep") {
    config.review.depth = dossier.depth;
  }
  if (isRecord(runInfo.review)) {
    const boost = asFiniteNumber(runInfo.review.budgetBoost);
    if (boost !== undefined && boost > 0) {
      config.review.budgetBoost = boost;
    }
  }
  return config;
}

type ParsedArgs = {
  mode: "replay" | "eval" | "regression";
  repo?: string;
  runs: string[];
  logs?: string;
  baselineLogs?: string;
  selectedLogs?: string;
  cohort: string;
  expectedRepeats?: number;
  actualValidationCostUSD?: number;
  output: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const mode = argv[0];
  assertReport(mode === "replay" || mode === "eval" || mode === "regression", "invalid_args", "expected replay, eval, or regression mode");
  const values = new Map<string, string[]>();
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    assertReport(key?.startsWith("--") === true, "invalid_args", `unexpected argument: ${key ?? "<missing>"}`);
    const value = argv[index + 1];
    assertReport(value !== undefined && !value.startsWith("--"), "invalid_args", `missing value for ${key}`);
    values.set(key, [...(values.get(key) ?? []), value]);
    index += 1;
  }
  const allowedKeys: Record<ParsedArgs["mode"], Set<string>> = {
    replay: new Set(["--repo", "--run", "--output"]),
    eval: new Set(["--logs", "--cohort", "--expected-repeats", "--actual-validation-cost", "--output"]),
    regression: new Set(["--baseline-logs", "--selected-logs", "--cohort", "--expected-repeats", "--output"])
  };
  const unknownKeys = [...values.keys()].filter((key) => !allowedKeys[mode].has(key));
  assertReport(unknownKeys.length === 0, "invalid_args", `${mode} received unsupported arguments`, { unknownKeys });
  const single = (key: string): string | undefined => {
    const entries = values.get(key) ?? [];
    assertReport(entries.length <= 1, "invalid_args", `${key} may be specified only once`);
    return entries[0];
  };
  const output = single("--output");
  assertReport(output !== undefined, "invalid_args", "--output is required");
  const expectedRepeatsText = single("--expected-repeats");
  const expectedRepeats = expectedRepeatsText === undefined ? undefined : Number(expectedRepeatsText);
  if (expectedRepeats !== undefined) {
    assertReport(Number.isInteger(expectedRepeats) && expectedRepeats > 0, "invalid_args", "--expected-repeats must be a positive integer");
  }
  const validationText = single("--actual-validation-cost");
  const actualValidationCostUSD = validationText === undefined ? undefined : Number(validationText);
  if (actualValidationCostUSD !== undefined) {
    assertReport(Number.isFinite(actualValidationCostUSD) && actualValidationCostUSD >= 0, "invalid_args", "--actual-validation-cost must be non-negative");
  }
  const repo = single("--repo");
  const logs = single("--logs");
  const baselineLogs = single("--baseline-logs");
  const selectedLogs = single("--selected-logs");
  return {
    mode,
    ...(repo === undefined ? {} : { repo }),
    runs: values.get("--run") ?? [],
    ...(logs === undefined ? {} : { logs }),
    ...(baselineLogs === undefined ? {} : { baselineLogs }),
    ...(selectedLogs === undefined ? {} : { selectedLogs }),
    cohort: single("--cohort") ?? "latest",
    ...(expectedRepeats === undefined ? {} : { expectedRepeats }),
    ...(actualValidationCostUSD === undefined ? {} : { actualValidationCostUSD }),
    output
  };
}

async function writeReport(output: string, report: unknown): Promise<void> {
  await writeFile(output, formatSafeReport(report));
}

export function formatSafeReport(report: unknown): string {
  return `${JSON.stringify(stripCredentials(safeReportOutput(report)), null, 2)}\n`;
}

function safeReportOutput(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(safeReportOutput);
  }
  if (!isRecord(value)) {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "failures" && Array.isArray(entry)) {
      output[key] = entry.map(safeFailureOutput);
    } else {
      output[key] = safeReportOutput(entry);
    }
  }
  return output;
}

function safeFailureOutput(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    const fingerprint = valueFingerprint(value);
    return { code: "invalid_failure", message: `sha256:${fingerprint.sha256}:${fingerprint.length}` };
  }
  const code = typeof value.code === "string" ? value.code : "invalid_failure";
  const message = typeof value.message === "string" ? value.message : stableJson(value.message);
  const fingerprint = valueFingerprint(message);
  return {
    code,
    message: `sha256:${fingerprint.sha256}:${fingerprint.length}`,
    ...(value.context === undefined ? {} : { context: safeFailureValue(value.context) })
  };
}

function safeFailureValue(value: unknown): unknown {
  if (typeof value === "string") {
    return valueFingerprint(value);
  }
  if (Array.isArray(value)) {
    return value.map(safeFailureValue);
  }
  if (isRecord(value)) {
    if (
      (value.kind === "string" || value.kind === "json") &&
      typeof value.length === "number" && Number.isInteger(value.length) && value.length >= 0 &&
      typeof value.sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.sha256) &&
      Object.keys(value).every((key) => key === "kind" || key === "length" || key === "sha256")
    ) {
      return value;
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, safeFailureValue(entry)]));
  }
  return value;
}

function failuresForError(error: unknown, code: string): ReportFailure[] {
  return error instanceof PacketPackingReportError
    ? error.failures
    : [failure(code, error instanceof Error ? error.message : String(error))];
}

export async function runPacketPackingReportCli(argv: string[]): Promise<number> {
  const fallbackOutput = rawOutputArgument(argv);
  try {
    return await runPacketPackingReportCliUnchecked(argv);
  } catch (error) {
    const mode = argv[0] === "replay" || argv[0] === "eval" || argv[0] === "regression" ? argv[0] : "unknown";
    const report = { schemaVersion: 1, mode, failures: failuresForError(error, "packet_report_error") };
    if (fallbackOutput !== undefined) {
      try {
        await writeReport(fallbackOutput, report);
        return 1;
      } catch (writeError) {
        process.stderr.write(formatSafeReport({
          schemaVersion: 1,
          mode,
          failures: [...failuresForError(error, "packet_report_error"), ...failuresForError(writeError, "report_write_error")]
        }));
        return 1;
      }
    }
    process.stderr.write(formatSafeReport(report));
    return 1;
  }
}

function rawOutputArgument(argv: string[]): string | undefined {
  const indexes = argv.flatMap((entry, index) => entry === "--output" ? [index] : []);
  if (indexes.length !== 1) {
    return undefined;
  }
  const value = argv[indexes[0]! + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

async function runPacketPackingReportCliUnchecked(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.mode === "replay") {
    assertReport(args.repo !== undefined, "invalid_args", "replay requires --repo");
    assertReport(args.runs.length > 0, "invalid_args", "replay requires at least one --run");
    const rows: ReplayRow[] = [];
    const failures: ReportFailure[] = [];
    for (const run of args.runs) {
      try {
        const row = await replayOne(path.resolve(args.repo), path.resolve(run));
        rows.push(row);
        failures.push(...row.failures.map((entry) => ({ ...entry, context: { run: path.basename(run), ...entry.context } })));
      } catch (error) {
        const entries = error instanceof PacketPackingReportError
          ? error.failures
          : [failure("replay_error", error instanceof Error ? error.message : String(error))];
        failures.push(...entries.map((entry) => ({ ...entry, context: { run: path.basename(run), ...entry.context } })));
      }
    }
    const report: ReplayReport = {
      schemaVersion: 1,
      mode: "replay",
      noModelCalls: rows.length === args.runs.length && rows.every((row) => row.modelCallsObserved === 0),
      repo: path.resolve(args.repo),
      rows,
      failures
    };
    await writeReport(args.output, report);
    return failures.length === 0 && rows.length === args.runs.length ? 0 : 1;
  }

  assertReport(args.expectedRepeats !== undefined, "invalid_args", `${args.mode} requires --expected-repeats`);
  if (args.mode === "eval") {
    assertReport(args.logs !== undefined, "invalid_args", "eval requires --logs");
    try {
      const cohort = selectExplicitCohort(await loadEvalRuns(path.resolve(args.logs), args.cohort), args.cohort);
      const report = analyzeEvalCohort(cohort, args.expectedRepeats, {
        ...(args.actualValidationCostUSD === undefined ? {} : { actualValidationCostUSD: args.actualValidationCostUSD })
      });
      await writeReport(args.output, report);
      return report.failures.length === 0 ? 0 : 1;
    } catch (error) {
      await writeReport(args.output, { schemaVersion: 1, mode: "eval", failures: failuresForError(error, "eval_report_error") });
      return 1;
    }
  }

  assertReport(args.baselineLogs !== undefined && args.selectedLogs !== undefined, "invalid_args", "regression requires --baseline-logs and --selected-logs");
  try {
    const baseline = selectExplicitCohort(await loadEvalRuns(path.resolve(args.baselineLogs), args.cohort), args.cohort);
    const selected = selectExplicitCohort(await loadEvalRuns(path.resolve(args.selectedLogs), args.cohort), args.cohort);
    const report = analyzeRegressionCohorts(baseline, selected, args.expectedRepeats);
    await writeReport(args.output, report);
    return report.failures.length === 0 ? 0 : 1;
  } catch (error) {
    await writeReport(args.output, { schemaVersion: 1, mode: "regression", failures: failuresForError(error, "regression_report_error") });
    return 1;
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  runPacketPackingReportCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(formatSafeReport({ schemaVersion: 1, mode: "unknown", failures: failuresForError(error, "packet_report_error") }));
    process.exitCode = 1;
  });
}
