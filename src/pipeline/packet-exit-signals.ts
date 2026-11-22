import type { DiffFile, DiffLine, HunkSymbolFacts, StaticSignal } from "../types.js";

const LOOP_CONTROL = /^\s*(?:break|continue)(?:\s+\w+)?\s*;?\s*$/u;
const FUNCTION_EXIT = /^(?:return|throw)(?:\s+[^{}]+?)?\s*;?$/u;
const IDENTIFIER_EXIT = /^(return|throw)\s+([\w$]+)$/u;
const IDENTIFIER_ASSIGNMENT = /^\s*([\w$]+)\s*=\s*([\w$]+)\s*;?\s*$/u;
const AWAITED_WORK = /^\s*(?:(?:const|let|var)\s+[^=]+?=\s*)?await\s+\S/u;
const MAX_INTERVENING_LINES = 400;

type ExitSite = { hunkId: string; line: number };

export async function packetExitSignals(
  file: DiffFile,
  facts: HunkSymbolFacts[],
  readHeadRange: (start: number, end: number) => Promise<string>
): Promise<Map<string, StaticSignal[]>> {
  const signals = new Map<string, StaticSignal[]>();
  if (!["typescript", "javascript", "tsx", "jsx", "go", "rust", "python", "solidity"].includes(file.language)) {
    return signals;
  }
  const removed = new Map<string, ExitSite[]>();
  const added = new Map<string, ExitSite[]>();
  const assignments = new Map<string, Set<string>>();
  const headAwaitLines: number[] = [];
  const hasAwait = ["typescript", "javascript", "tsx", "jsx", "python"].includes(file.language);
  for (const hunk of file.hunks) {
    let nextHeadLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.kind === "add" && line.newLineNumber !== undefined && LOOP_CONTROL.test(line.content)) {
        addSignal(hunk.id, line.newLineNumber, "added-loop-control",
          "New break or continue may skip pending work. Check its enclosing control flow and what still needs to happen on this path.");
      }
      if (hasAwait) {
        const exit = exitStatement(line);
        if (exit !== undefined && line.kind === "delete") {
          rememberExit(removed, exit, { hunkId: hunk.id, line: nextHeadLine });
        } else if (exit !== undefined && line.kind === "add" && line.newLineNumber !== undefined) {
          rememberExit(added, exit, { hunkId: hunk.id, line: line.newLineNumber });
        }
        if (line.kind === "add") {
          const assignment = IDENTIFIER_ASSIGNMENT.exec(line.content);
          if (assignment !== null) {
            const target = assignment[1]!;
            const original = assignment[2]!;
            const key = `${hunk.id}\n${original}`;
            const targets = assignments.get(key) ?? new Set<string>();
            targets.add(target);
            assignments.set(key, targets);
          }
        }
        if (line.newLineNumber !== undefined && AWAITED_WORK.test(line.content)) {
          headAwaitLines.push(line.newLineNumber);
        }
      }
      if (line.newLineNumber !== undefined) nextHeadLine = line.newLineNumber + 1;
    }
  }
  let readInterveningSource = false;
  for (const [statement, before] of removed) {
    const [old] = before;
    if (before.length !== 1 || old === undefined) continue;
    const identifier = IDENTIFIER_EXIT.exec(statement);
    const deferredStatements = new Set([statement]);
    if (identifier !== null) {
      for (const alias of assignments.get(`${old.hunkId}\n${identifier[2]}`) ?? []) {
        deferredStatements.add(`${identifier[1]} ${alias}`);
      }
    }
    const after = [...deferredStatements].flatMap(exit => added.get(exit) ?? []);
    if (after.length !== 1) continue;
    const [next] = after;
    if (next === undefined || next.line <= old.line || !sameEnclosingSymbol(old, next, facts)) continue;
    let crossesAwait = headAwaitLines.some(line => line >= old.line && line < next.line);
    const crossesHunks = old.hunkId !== next.hunkId;
    if (!crossesAwait && crossesHunks && !readInterveningSource && next.line - old.line <= MAX_INTERVENING_LINES) {
      readInterveningSource = true;
      const intervening = await readHeadRange(Math.max(1, old.line), next.line - 1);
      crossesAwait = intervening.split("\n").some(line => AWAITED_WORK.test(line));
    }
    if (crossesAwait) {
      addSignal(next.hunkId, next.line, "exit-moved-past-await",
        "A matching removed exit appears later after awaited work. Check which result or obligations survive if an intervening step fails.");
    }
  }
  return signals;

  function addSignal(hunkId: string, line: number, rule: string, explanation: string): void {
    const ruleId = `correctness/${rule}`;
    const prior = signals.get(hunkId) ?? [];
    if (prior.some(signal => signal.ruleId === ruleId)) return;
    signals.set(hunkId, [...prior, { ruleId, path: file.path, line, side: "RIGHT", category: "correctness", confidence: "medium", explanation }]);
  }
}

function exitStatement(line: DiffLine): string | undefined {
  const text = line.content.trim();
  return FUNCTION_EXIT.test(text) ? text.replace(/;$/u, "").trimEnd() : undefined;
}

function rememberExit(exits: Map<string, ExitSite[]>, statement: string, site: ExitSite): void {
  const sites = exits.get(statement);
  if (sites === undefined) exits.set(statement, [site]);
  else sites.push(site);
}

function sameEnclosingSymbol(old: ExitSite, next: ExitSite, facts: HunkSymbolFacts[]): boolean {
  if (old.hunkId === next.hunkId) return true;
  return facts.some(left => left.hunkId === old.hunkId && left.enclosingSymbol !== undefined &&
    facts.some(right => right.hunkId === next.hunkId && right.enclosingSymbol === left.enclosingSymbol &&
      left.symbolRange?.[0] === right.symbolRange?.[0] && left.symbolRange?.[1] === right.symbolRange?.[1]));
}
