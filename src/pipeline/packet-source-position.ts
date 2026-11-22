import { numberSourceLine, renderSourceBlockHeader } from "../llm/repository-tool-guidance.js";
import type { SourceSelector, ToolResultMeta } from "../types.js";

type ContextEdit = {
  start: number;
  end: number;
  render: (visibleChars: number) => string;
  plannerProse?: boolean;
  source?: boolean;
};

/** Keep the original text for packet selection, budgets and downstream stages. */
export type PacketSourceDraft = { text: string; edits?: ContextEdit[] };

export function joinSourceDrafts(parts: (string | PacketSourceDraft)[], separator: string): PacketSourceDraft {
  let text = "";
  const edits: ContextEdit[] = [];
  for (const [i, part] of parts.entries()) {
    if (i) text += separator;
    if (typeof part === "string") {
      text += part;
      continue;
    }
    for (const edit of part.edits ?? []) {
      edits.push({ ...edit, start: edit.start + text.length, end: edit.end + text.length });
    }
    text += part.text;
  }
  return { text, ...(edits.length ? { edits } : {}) };
}

/** The existing raw caps keep a prefix and may append a legacy notice. */
export function capSourceDraft(draft: PacketSourceDraft, cappedText: string): PacketSourceDraft {
  if (cappedText === draft.text) return draft;
  // A cap may replace the tail with a presentation marker. Only compare the
  // retained source prefix, even if that marker also occurs in the source.
  const marker = "\n[... content truncated to fit packet context budget ...]";
  const bound = cappedText.endsWith(marker) ? cappedText.length - marker.length : cappedText.length;
  let end = 0;
  while (end < bound && cappedText[end] === draft.text[end]) end++;
  const edits = draft.edits?.filter(edit => edit.start < end || (edit.source && edit.start === end)).map(edit =>
    edit.end > end ? { ...edit, end } : edit);
  return { text: cappedText, ...(edits?.length ? { edits } : {}) };
}

export function hideFromProjection(text: string, enabled: boolean, plannerProse = false): PacketSourceDraft {
  return { text, ...(enabled ? { edits: [{ start: 0, end: text.length, render: () => "", plannerProse }] } : {}) };
}

export function sourceDraft(
  text: string,
  position: { path: string; side: SourceSelector["kind"]; meta?: ToolResultMeta; first?: number | undefined;
    last?: number | undefined; totalLines?: number | undefined },
  enabled: boolean,
  rawSource = text
): PacketSourceDraft {
  if (!enabled || !text.length) return { text };
  return { text, edits: [{
    start: 0, end: text.length, source: true,
    render: visibleChars => {
      const { path, side, meta } = position;
      const first = meta?.deliveredLineRange?.[0] ?? position.first;
      const total = meta?.totalLines ?? position.totalLines;
      if (first === undefined || total === undefined) return `${path}@${side}: source positions unavailable`;

      const delivered = text.slice(0, visibleChars);
      const completeLine = visibleChars === text.length || text[visibleChars] === "\n";
      const count = delivered.split("\n").length - Number(!delivered || delivered.endsWith("\n") || !completeLine);
      const lines = rawSource.replace(/\n$/u, "").split("\n").slice(0, count);
      const last = first + lines.length - 1;
      const next = visibleChars < text.length || meta?.truncated ? last + 1 : undefined;
      const header = lines.length
        ? renderSourceBlockHeader(path, side, [first, last], total)
        : `${path}@${side}: ${total} lines; source omitted`;
      const resume = next !== undefined ? `[... source omitted; continue with read_range ${path}@${side} startLine=${next}${position.last === undefined ? "" : ` endLine=${position.last}`} ...]` : "";
      return [header, ...lines.map((line, i) => numberSourceLine(line, first + i)), resume].filter(Boolean).join("\n");
    }
  }] };
}

export function renderSourceDraft(draft: PacketSourceDraft): { text: string; withheldPlannerProse: boolean } {
  let text = "";
  let offset = 0;
  let withheldPlannerProse = false;
  for (const edit of draft.edits ?? []) {
    text += draft.text.slice(offset, edit.start) + edit.render(edit.end - edit.start);
    offset = edit.end;
    withheldPlannerProse ||= edit.plannerProse === true;
  }
  return { text: text + draft.text.slice(offset), withheldPlannerProse };
}
