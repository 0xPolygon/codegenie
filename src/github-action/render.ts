import { STAGES, type ReviewStageNumber } from "../review-stages.js";

export type StageState = "pending" | "active" | "done";

export type StageChecklist = Map<ReviewStageNumber, StageState>;

// GitHub caps issue-comment bodies at 65,536 characters.
export const ISSUE_COMMENT_MAX_CHARS = 65_536;

export const TRUNCATION_DISCLOSURE =
  "> **Note:** this report was truncated to fit GitHub's comment size limit. " +
  "The full report is in the workflow run's step summary and artifacts.";

// Stage 0 is run bookkeeping, not review work; the checklist shows 1..11.
export const CHECKLIST_STAGES = STAGES.filter((stage) => stage.stage !== 0);

export function createStageChecklist(): StageChecklist {
  return new Map(CHECKLIST_STAGES.map((stage) => [stage.stage, "pending" as StageState]));
}

export function applyStageEvent(checklist: StageChecklist, message: string, stage: ReviewStageNumber): boolean {
  if (!checklist.has(stage)) {
    return false;
  }
  if (message === "stage_started") {
    checklist.set(stage, "active");
    // Stages run in order; a stage starting means everything before it is
    // done even if a completion event was never observed.
    for (const definition of CHECKLIST_STAGES) {
      if (definition.stage < stage && checklist.get(definition.stage) !== "done") {
        checklist.set(definition.stage, "done");
      }
    }
    return true;
  }
  if (message === "stage_completed") {
    checklist.set(stage, "done");
    return true;
  }
  return false;
}

export function renderProgressBody(checklist: StageChecklist, runUrl: string | undefined): string {
  const lines = CHECKLIST_STAGES.map((definition) => {
    const state = checklist.get(definition.stage) ?? "pending";
    const glyph = state === "done" ? "☑" : state === "active" ? "▸" : "☐";
    return `${glyph} ${definition.label}`;
  });
  return [
    "**🧞 Codegenie** is reviewing this pull request ...",
    "",
    ...lines,
    "",
    ...renderRunLinkFooter(runUrl)
  ].join("\n");
}

export function renderFailureBody(errorCode: string, runUrl: string | undefined): string {
  return [
    `**🧞 Codegenie** review failed (\`${errorCode}\`).`,
    "",
    ...renderRunLinkFooter(runUrl)
  ].join("\n");
}

export type CappedTerminalBody = {
  body: string;
  bodyBeforeCap: string;
  truncated: boolean;
};

// Caps the sanitized report so body + footer + marker fit the comment limit.
// Prefers a markdown heading boundary; falls back to the last newline.
export function capTerminalBody(report: string, runUrl: string | undefined, reservedChars: number): CappedTerminalBody {
  const footer = renderRunLinkFooter(runUrl).join("\n");
  const assemble = (text: string): string => footer.length > 0 ? `${text.trimEnd()}\n\n${footer}` : text.trimEnd();

  const full = assemble(report);
  const limit = ISSUE_COMMENT_MAX_CHARS - reservedChars;
  if (full.length <= limit) {
    return { body: full, bodyBeforeCap: full, truncated: false };
  }

  const overhead = footer.length + TRUNCATION_DISCLOSURE.length + 8;
  const cutLimit = Math.max(0, limit - overhead);
  const slice = report.slice(0, cutLimit);
  const headingCut = slice.lastIndexOf("\n#");
  const newlineCut = slice.lastIndexOf("\n");
  const cut = headingCut > cutLimit / 2 ? headingCut : Math.max(0, newlineCut);
  const truncatedReport = `${slice.slice(0, cut).trimEnd()}\n\n${TRUNCATION_DISCLOSURE}`;
  return { body: assemble(truncatedReport), bodyBeforeCap: full, truncated: true };
}

function renderRunLinkFooter(runUrl: string | undefined): string[] {
  if (runUrl === undefined || runUrl === "") {
    return [];
  }
  return [`— [View Workflow Run](${runUrl})`];
}
