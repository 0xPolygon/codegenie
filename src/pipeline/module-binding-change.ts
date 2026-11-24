import type { DiffHunk, DiffLine } from "../types.js";

type ModuleBindingRule = "ecma_import" | "ecma_export" | "go_import" | "python_import";

const ECMASCRIPT_LANGUAGES = new Set(["typescript", "tsx", "javascript", "jsx"]);
const QUOTED_MODULE = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')`;
const MODULE_SOURCE = new RegExp(`(?:^|\\s|\\})from\\s*${QUOTED_MODULE}`, "u");
const DIRECT_IMPORT = new RegExp(`^import\\s*${QUOTED_MODULE}`, "u");
const IMPORT_REQUIRE = new RegExp(`^import\\s+[\\w$]+\\s*=\\s*require\\s*\\(\\s*${QUOTED_MODULE}`, "u");
const GO_SPEC = /^(?:(?:[\p{L}_][\p{L}\p{Nd}_]*|\.)\s+)?(?:"(?:\\.|[^"\\])+"|`[^`]+`)(?:\s*;)?$/u;
const GO_DISTINCT_IMPORT_SPEC = /^(?:[_.]\s+)?["`]/u;
const ECMA_LIST = /^(import|export)(?:\s+type)?\s*\{/u;
const ECMA_SPEC = /^(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?(?:\s*,\s*(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?)*\s*,?$/u;

type Declaration = { rule: ModuleBindingRule; key: string };

/** A diff-only test for static declarations on their pinned sides. */
export function changedModuleBinding(hunks: DiffHunk[], language: string): { hunkId: string; rule: ModuleBindingRule } | undefined {
  for (const hunk of hunks) {
    const old = declarations(hunk.lines.filter(line => line.kind !== "add"), language);
    const current = declarations(hunk.lines.filter(line => line.kind !== "delete"), language);
    const counts = new Map<string, number>();
    for (const declaration of old) counts.set(declaration.key, (counts.get(declaration.key) ?? 0) + 1);
    for (const declaration of current) {
      const remaining = counts.get(declaration.key) ?? 0;
      if (remaining === 0) return { hunkId: hunk.id, rule: declaration.rule };
      counts.set(declaration.key, remaining - 1);
    }
    const removed = old.find(declaration => (counts.get(declaration.key) ?? 0) > 0);
    if (removed) return { hunkId: hunk.id, rule: removed.rule };
  }
  return undefined;
}

function declarations(lines: DiffLine[], language: string): Declaration[] {
  const ecma = ECMASCRIPT_LANGUAGES.has(language);
  if (!ecma && language !== "go" && language !== "python") return [];
  const output: Declaration[] = [];
  const add = (rule: ModuleBindingRule, text: string) => {
    const tokens = text.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|[\w$]+|[^\s;,]/gu) ?? [];
    output.push({ rule, key: JSON.stringify(tokens.map(token => /^["'`]/u.test(token) ? token.slice(1, -1) : token)) });
  };
  let goGroupStart: number | undefined;
  const goRun: Array<{ text: string; changed: boolean }> = [];
  const flushGoRun = (closed = false) => {
    // A closing parenthesis or a bare, blank or dot import distinguishes
    // this run from adjacent embedded struct fields with tags.
    if (goRun.length >= 2 && goRun.some(spec => spec.changed)
      && (closed || goRun.some(spec => GO_DISTINCT_IMPORT_SPEC.test(spec.text)))) {
      for (const spec of goRun) add("go_import", spec.text);
    }
    goRun.length = 0;
  };
  let ecmaList: { rule: ModuleBindingRule; text: string } | undefined;
  let blockComment = false;
  for (const row of lines) {
    const trimmed = row.content.trim();
    if (blockComment || trimmed.startsWith("/*")) {
      blockComment = !trimmed.includes("*/");
      continue;
    }
    const line = trimmed.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|\/\/.*|\/\*.*?\*\/|#.*$/gu,
      token => /^(?:\/\/|\/\*|#)/u.test(token) ? "" : token).trim();
    if (line.length === 0 || line.startsWith("*")) continue;

    if (language === "go") {
      const singleImport = line.replace(/^import\s+/u, "");
      if (singleImport !== line && GO_SPEC.test(singleImport)) {
        flushGoRun();
        add("go_import", singleImport);
        goGroupStart = undefined;
        continue;
      }
      if (GO_SPEC.test(line)) {
        if (goGroupStart !== undefined) add("go_import", line);
        else goRun.push({ text: line, changed: row.kind !== "context" });
        continue;
      }
      const closesGroup = /^\)\s*;?$/u.test(line);
      flushGoRun(closesGroup);
      if (/^import\s*\($/u.test(line)) goGroupStart = output.length;
      else if (closesGroup && goGroupStart !== undefined) {
        if (goGroupStart === output.length) add("go_import", "import (");
        goGroupStart = undefined;
      } else goGroupStart = undefined;
      continue;
    }

    if (language === "python") {
      if (/^(?:import\s+[\w]+|from\s+[\w.]+\s+import\b)/u.test(line)) add("python_import", line);
      continue;
    }

    if (ecmaList) {
      if (line.startsWith("}") || ECMA_SPEC.test(line)) {
        ecmaList.text += " " + line;
        if (!line.startsWith("}")) continue;
        add(ecmaList.rule, ecmaList.text);
        ecmaList = undefined;
        continue;
      }
      add(ecmaList.rule, ecmaList.text);
      ecmaList = undefined;
    }

    const list = ECMA_LIST.exec(line);
    if (list) {
      const rule = list[1] === "import" ? "ecma_import" : "ecma_export";
      if (line.includes("}")) add(rule, line);
      else ecmaList = { rule, text: line };
    } else if (DIRECT_IMPORT.test(line) || IMPORT_REQUIRE.test(line)
      || /^import(?!\s*\()\s+/u.test(line) && MODULE_SOURCE.test(line)) {
      add("ecma_import", line);
    } else if (/^export(?:\s+type)?\s*\*/u.test(line) && MODULE_SOURCE.test(line)) {
      add("ecma_export", line);
    }
  }
  flushGoRun();
  if (goGroupStart !== undefined && goGroupStart === output.length) add("go_import", "import (");
  if (ecmaList) add(ecmaList.rule, ecmaList.text);
  return output;
}
