import { z } from "zod";
import type { CodeninjaConfig } from "../types.js";

export const reviewDepthSchema = z.enum(["light", "normal", "deep"]);
export const reasoningLevelSchema = z.enum(["low", "medium", "high", "xhigh"]);
export const severitySchema = z.enum(["critical", "high", "medium", "low"]);
export const confidenceSchema = z.enum(["high", "medium", "low"]);
export const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);

const positiveIntSchema = z.number().int().positive();
const nonNegativeIntSchema = z.number().int().nonnegative();

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
        timeoutMs: positiveIntSchema.optional(),
        perPassTimeoutMs: positiveIntSchema.optional(),
        maxTotalTokens: positiveIntSchema.optional(),
        maxModelCalls: positiveIntSchema.optional()
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
        maxConcurrentCalls: positiveIntSchema.optional()
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

export type RawCodeninjaConfig = z.infer<typeof rawConfigSchema>;

export const codeninjaConfigSchema = z
  .object({
    lenses: z
      .object({
        enabled: z.array(z.string().min(1)),
        disabled: z.array(z.string().min(1)),
        extraSkillPaths: z.array(z.string().min(1))
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
        timeoutMs: positiveIntSchema,
        perPassTimeoutMs: positiveIntSchema,
        maxTotalTokens: positiveIntSchema.optional(),
        maxModelCalls: positiveIntSchema.optional()
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
        maxConcurrentCalls: positiveIntSchema
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

export const defaultConfig: CodeninjaConfig = {
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
    concurrency: 4,
    timeoutMs: 30 * 60 * 1000,
    perPassTimeoutMs: 5 * 60 * 1000
  },
  github: {
    summaryWhenNoFindings: false
  },
  git: {},
  classification: {
    pathRules: []
  },
  llm: {
    maxConcurrentCalls: 2
  },
  cache: {
    enabled: false,
    dir: ".codeninja/cache"
  },
  telemetry: {
    enabled: true,
    logLevel: "warn",
    debugTrace: false,
    runDir: ".codeninja/runs",
    retainRuns: 20
  },
  eval: {
    logsDir: "logs"
  }
};
