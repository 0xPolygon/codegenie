import type { ReviewStage } from "./types.js";

export type ReviewStageNumber = ReviewStage | 0;

export type ReviewStageDefinition = {
  stage: ReviewStageNumber;
  slug: string;
  label: string;
};

export const STAGES = [
  { stage: 0, slug: "00-run", label: "run" },
  { stage: 1, slug: "01-input", label: "resolving input" },
  { stage: 2, slug: "02-diff", label: "parsing diff" },
  { stage: 3, slug: "03-classify", label: "classifying files" },
  { stage: 4, slug: "04-index", label: "indexing symbols" },
  { stage: 5, slug: "05-planner", label: "planning review" },
  { stage: 6, slug: "06-packets", label: "building review packets" },
  { stage: 7, slug: "07-review", label: "reviewing hunks" },
  { stage: 8, slug: "08-followups", label: "checking follow-ups" },
  { stage: 9, slug: "09-verification", label: "verifying findings" },
  { stage: 10, slug: "10-composition", label: "composing review" },
  { stage: 11, slug: "11-github-posting", label: "github posting" }
] as const satisfies readonly ReviewStageDefinition[];

export const STAGE_LABELS: Record<ReviewStageNumber, string> = STAGES.reduce(
  (labels, stage) => {
    labels[stage.stage] = stage.label;
    return labels;
  },
  {} as Record<ReviewStageNumber, string>
);

export const STAGE_SLUGS: Record<ReviewStageNumber, string> = STAGES.reduce(
  (slugs, stage) => {
    slugs[stage.stage] = stage.slug;
    return slugs;
  },
  {} as Record<ReviewStageNumber, string>
);
