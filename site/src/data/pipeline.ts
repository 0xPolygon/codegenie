export interface PipelineStage {
  /** 1-based position in the 11-stage pipeline. */
  n: number;
  name: string;
  /** True when the stage makes an LLM call (shaded amber on the README diagram). */
  isLlm: boolean;
}

/**
 * The eleven stages from the codegenie README. Five make LLM calls; the rest
 * are deterministic code that owns the guarantees (coverage, anchoring,
 * verification, dedup, budgets, telemetry).
 */
export const pipeline: PipelineStage[] = [
  { n: 1, name: "Resolve input", isLlm: false },
  { n: 2, name: "Parse & filter diff", isLlm: false },
  { n: 3, name: "Classify files", isLlm: false },
  { n: 4, name: "Index symbols (tree-sitter)", isLlm: false },
  { n: 5, name: "Plan", isLlm: true },
  { n: 6, name: "Build review packets", isLlm: false },
  { n: 7, name: "Review packets (parallel)", isLlm: true },
  { n: 8, name: "Follow-up", isLlm: true },
  { n: 9, name: "Verify (fresh context)", isLlm: true },
  { n: 10, name: "Compose", isLlm: true },
  { n: 11, name: "Publish", isLlm: false },
];