import type { ReviewResult } from "../types.js";

export function renderJsonReview(result: ReviewResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}
