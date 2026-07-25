import { z } from "zod";
import type { CodegenieConfig } from "../types.js";

export const reviewDepthSchema = z.enum(["light", "normal", "deep"]);
export const reasoningLevelSchema = z.enum(["low", "medium", "high", "xhigh"]);
export const severitySchema = z.enum(["critical", "high", "medium", "low"]);
export const confidenceSchema = z.enum(["high", "medium", "low"]);
export const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);

const positiveIntSchema = z.number().int().positive();
const nonNegativeIntSchema = z.number().int().nonnegative();
const positiveFiniteNumberSchema = z.number().positive().finite();
export const MAX_REVIEW_TIME_MINUTES = Number.MAX_SAFE_INTEGER / 120_000;
export const MAX_REVIEW_TIME_MS = MAX_REVIEW_TIME_MINUTES * 60_000;
export const reviewMaxTimeMinutesSchema = positiveFiniteNumberSchema.max(MAX_REVIEW_TIME_MINUTES);
// Plan 84 guardrail: ensemble cost scales linearly with passes × deep
// packets; beyond 3 the marginal recall of another draw is negligible while
// cost keeps climbing. Hard cap, not a default.
export const MAX_DEEP_ENSEMBLE_PASSES = 3;
// Plan 103 (experiment-only): upper bound for review.packMaxHunks. Must equal
// MAX_HUNKS_PER_PACKET in packet-builder.ts — duplicated rather than imported
// so the config schema stays free of pipeline dependencies; a focused test
// asserts the two agree. The recall curve varies packMaxHunks below this
// bound; nothing may raise packing above today's shipped cap.
export const MAX_PACK_HUNKS = 5;

export const pathRuleSchema = z
  .object({
    pattern: z.string().min(1),
    processingMode: z.enum(["per-hunk", "whole-file", "skip"]).optional(),
    reviewPriority: z.enum(["critical", "high", "normal", "low"]).optional(),
    labels: z.array(z.string().min(1)).optional(),
    reason: z.string().min(1)
  })
  .strict();

export const rawConfigSchema = z
  .object({
    lenses: z
      .object({
        enabled: z.array(z.string().min(1)).optional(),
        disabled: z.array(z.string().min(1)).optional(),
        extraSkillPaths: z.array(z.string().min(1)).optional()
      })
      .strict()
      .optional(),
    review: z
      .object({
        depth: reviewDepthSchema.optional(),
        verify: z.boolean().optional(),
        minSeverity: severitySchema.optional(),
        maxFindings: positiveIntSchema.optional(),
        softCommentCap: positiveIntSchema.optional(),
        minConfidence: confidenceSchema.optional(),
        minInlineConfidence: confidenceSchema.optional(),
        concurrency: positiveIntSchema.optional(),
        maxTime: reviewMaxTimeMinutesSchema.optional(),
        perPassTimeoutMs: positiveIntSchema.optional(),
        budgetBoost: positiveFiniteNumberSchema.optional(),
        maxBudgetTokens: positiveIntSchema.optional(),
        maxModelCalls: positiveIntSchema.optional(),
        deepEnsemblePasses: positiveIntSchema.max(MAX_DEEP_ENSEMBLE_PASSES).optional(),
        adaptiveSecondPass: z.boolean().optional()
      })
      .strict()
      .optional(),
    github: z
      .object({
        summaryWhenNoFindings: z.boolean().optional()
      })
      .strict()
      .optional(),
    git: z
      .object({
        baseBranch: z.string().min(1).optional()
      })
      .strict()
      .optional(),
    classification: z
      .object({
        pathRules: z.array(pathRuleSchema).optional()
      })
      .strict()
      .optional(),
    llm: z
      .object({
        provider: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        reasoning: reasoningLevelSchema.optional(),
        maxConcurrentCalls: positiveIntSchema.optional(),
        forceSubmitToolChoice: z.boolean().optional()
      })
      .strict()
      .optional(),
    cache: z
      .object({
        enabled: z.boolean().optional(),
        dir: z.string().min(1).optional()
      })
      .strict()
      .optional(),
    telemetry: z
      .object({
        enabled: z.boolean().optional(),
        logLevel: logLevelSchema.optional(),
        debugTrace: z.boolean().optional(),
        runDir: z.string().min(1).optional(),
        retainRuns: nonNegativeIntSchema.optional()
      })
      .strict()
      .optional(),
    eval: z
      .object({
        defaultEvalDir: z.string().min(1).optional(),
        logsDir: z.string().min(1).optional()
      })
      .strict()
      .optional()
  })
  .strict();

export type RawCodegenieConfig = z.infer<typeof rawConfigSchema>;

export const codegenieConfigSchema = z
  .object({
    lenses: z
      .object({
        enabled: z.array(z.string().min(1)),
        disabled: z.array(z.string().min(1)),
        extraSkillPaths: z.array(z.string().min(1)),
        restrictTo: z.array(z.string().min(1)).optional()
      })
      .strict(),
    review: z
      .object({
        depth: reviewDepthSchema,
        verify: z.boolean(),
        minSeverity: severitySchema.optional(),
        maxFindings: positiveIntSchema,
        softCommentCap: positiveIntSchema,
        minConfidence: confidenceSchema,
        minInlineConfidence: confidenceSchema,
        concurrency: positiveIntSchema,
        maxTimeMs: positiveFiniteNumberSchema.max(MAX_REVIEW_TIME_MS),
        perPassTimeoutMs: positiveIntSchema,
        budgetBoost: positiveFiniteNumberSchema,
        maxBudgetTokens: positiveIntSchema.optional(),
        maxModelCalls: positiveIntSchema.optional(),
        deepEnsemblePasses: positiveIntSchema.max(MAX_DEEP_ENSEMBLE_PASSES).optional(),
        adaptiveSecondPass: z.boolean().optional(),
        packCompatibleAtoms: z.boolean(),
        packMaxHunks: positiveIntSchema.max(MAX_PACK_HUNKS),
        pinnedPlanPath: z.string().min(1).optional()
      })
      .strict(),
    github: z
      .object({
        summaryWhenNoFindings: z.boolean()
      })
      .strict(),
    git: z
      .object({
        baseBranch: z.string().min(1).optional()
      })
      .strict(),
    classification: z
      .object({
        pathRules: z.array(pathRuleSchema)
      })
      .strict(),
    llm: z
      .object({
        provider: z.string().min(1).optional(),
        model: z.string().min(1).optional(),
        reasoning: reasoningLevelSchema.optional(),
        maxConcurrentCalls: positiveIntSchema,
        forceSubmitToolChoice: z.boolean().optional()
      })
      .strict(),
    cache: z
      .object({
        enabled: z.boolean(),
        dir: z.string().min(1)
      })
      .strict(),
    telemetry: z
      .object({
        enabled: z.boolean(),
        logLevel: logLevelSchema,
        debugTrace: z.boolean(),
        runDir: z.string().min(1),
        retainRuns: nonNegativeIntSchema
      })
      .strict(),
    eval: z
      .object({
        defaultEvalDir: z.string().min(1).optional(),
        logsDir: z.string().min(1)
      })
      .strict()
  })
  .strict();

export const defaultConfig: CodegenieConfig = {
  lenses: {
    enabled: [],
    disabled: [],
    extraSkillPaths: []
  },
  review: {
    depth: "normal",
    verify: true,
    maxFindings: 25,
    softCommentCap: 7,
    minConfidence: "medium",
    minInlineConfidence: "medium",
    concurrency: 6,
    maxTimeMs: 30 * 60 * 1000,
    perPassTimeoutMs: 8 * 60 * 1000,
    budgetBoost: 1,
    // Primary coverage budget (plan 90): work-denominated so provider latency
    // can never shrink a review. Re-derived 2026-07-04 after run 0c4d5213/53
    // (5,921,791 tokens of legitimate work — planner-deep + escalator
    // ensembles + capped adaptive passes — grazed the 7M cap's 5.95M
    // soft-stop and went partial); 8M puts the soft-stop at 6.8M, ~15% above
    // the largest observed legitimate run. A protective ceiling, not a
    // target.
    maxBudgetTokens: 8_000_000,
    // Plan 103: dark until the packet-size recall curve clears its gate.
    packCompatibleAtoms: false,
    packMaxHunks: MAX_PACK_HUNKS
  },
  github: {
    summaryWhenNoFindings: false
  },
  git: {},
  classification: {
    pathRules: []
  },
  llm: {
    maxConcurrentCalls: 6,
    forceSubmitToolChoice: true
  },
  cache: {
    enabled: false,
    dir: ".codegenie/cache"
  },
  telemetry: {
    enabled: false,
    logLevel: "warn",
    debugTrace: false,
    runDir: ".codegenie/runs",
    retainRuns: 20
  },
  eval: {
    logsDir: "logs"
  }
};
