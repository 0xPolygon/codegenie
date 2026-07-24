import type {
  DiffAnchor,
  DiffAnchorIndex,
  DiffAnchorValidation,
  DiffFile,
  DiffFileStatus,
  DiffHunk,
  DiffLine,
  UnifiedDiff
} from "../types.js";
import { CodegenieError } from "../util/errors.js";
import { sha256Hex } from "../util/hashing.js";

type MutableFile = {
  oldTokenPath: string;
  newTokenPath: string;
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  isBinary?: boolean;
  modeOnly?: boolean;
  isSymlink?: boolean;
  isSubmodule?: boolean;
  oldMode?: string;
  newMode?: string;
  sawModeOnlyHeader: boolean;
  hunks: DiffHunk[];
  renameFrom?: string;
  renameTo?: string;
  copyFrom?: string;
  copyTo?: string;
  inBinaryPatch?: boolean;
};

type MutableHunk = Omit<DiffHunk, "id" | "hunkHash"> & {
  oldConsumed: number;
  newConsumed: number;
};

type BuiltDiffAnchorIndex = DiffAnchorIndex & {
  right: Map<string, Map<number, string>>;
  left: Map<string, Map<number, string>>;
  hunkIds: Set<string>;
};

const HUNK_HEADER_PATTERN = /^@@ -(?<oldStart>\d+)(?:,(?<oldLines>\d+))? \+(?<newStart>\d+)(?:,(?<newLines>\d+))? @@(?<header>.*)$/u;

export function parseDiff(rawDiff: string): UnifiedDiff {
  if (rawDiff.trim().length === 0) {
    return { files: [] };
  }

  const lines = splitDiffLines(rawDiff);
  const files: DiffFile[] = [];
  let currentFile: MutableFile | undefined;
  let currentHunk: MutableHunk | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;

    if (line.startsWith("diff --git ")) {
      currentHunk = finishHunk(currentFile, currentHunk, lineNumber);
      finishFile(files, currentFile);
      currentFile = startFile(line, lineNumber);
      continue;
    }

    if (!currentFile) {
      if (line.trim().length === 0) {
        continue;
      }
      throw parseError(lineNumber, "expected git diff header");
    }

    const hunkMatch = HUNK_HEADER_PATTERN.exec(line);
    if (hunkMatch?.groups) {
      currentHunk = finishHunk(currentFile, currentHunk, lineNumber);
      currentHunk = startHunk(currentFile.path, hunkMatch.groups);
      continue;
    }

    if (currentHunk) {
      if (line.startsWith("\\ No newline at end of file")) {
        continue;
      }
      consumeHunkLine(currentHunk, line, lineNumber);
      continue;
    }

    consumeFileHeader(currentFile, line, lineNumber);
  }

  currentHunk = finishHunk(currentFile, currentHunk, lines.length + 1);
  void currentHunk;
  finishFile(files, currentFile);
  return allocateShortHunkIds({ files });
}

export function buildDiffAnchorIndex(diff: UnifiedDiff): DiffAnchorIndex {
  const right = new Map<string, Map<number, string>>();
  const left = new Map<string, Map<number, string>>();
  const hunkIds = new Set<string>();

  for (const file of diff.files) {
    const leftPath = file.oldPath ?? file.path;
    for (const hunk of file.hunks) {
      hunkIds.add(hunk.id);
      for (const line of hunk.lines) {
        if (line.kind === "add" && line.newLineNumber !== undefined) {
          setChangedLine(right, file.path, line.newLineNumber, hunk.id);
        }
        if (line.kind === "delete" && line.oldLineNumber !== undefined) {
          setChangedLine(left, leftPath, line.oldLineNumber, hunk.id);
        }
      }
    }
  }

  const index: BuiltDiffAnchorIndex = {
    right,
    left,
    hunkIds,
    isChangedLine(path: string, line: number, side: "RIGHT" | "LEFT"): boolean {
      return sideMap(index, side).get(path)?.has(line) ?? false;
    },
    hunkIdAt(path: string, line: number, side: "RIGHT" | "LEFT"): string | undefined {
      return sideMap(index, side).get(path)?.get(line);
    }
  };
  return index;
}

export function validateDiffAnchor(
  anchor: DiffAnchor,
  index: DiffAnchorIndex
): DiffAnchorValidation {
  const built = index as BuiltDiffAnchorIndex;
  const currentMap = sideMap(built, anchor.side);
  const otherMap = sideMap(built, anchor.side === "RIGHT" ? "LEFT" : "RIGHT");

  if (!currentMap.has(anchor.path)) {
    return { valid: false, reason: otherMap.has(anchor.path) ? "wrong_side_path" : "unknown_path" };
  }

  const owningHunk = currentMap.get(anchor.path)?.get(anchor.line);
  if (!owningHunk) {
    return { valid: false, reason: "line_not_changed" };
  }

  if (owningHunk !== anchor.hunkId) {
    return { valid: false, reason: built.hunkIds.has(anchor.hunkId) ? "line_not_in_hunk" : "unknown_hunk" };
  }

  if (anchor.startLine !== undefined) {
    const startSide = anchor.startSide ?? anchor.side;
    if (startSide !== anchor.side) {
      return { valid: false, reason: "side_mismatch" };
    }
    if (anchor.startLine >= anchor.line) {
      return { valid: false, reason: "multiline_invalid" };
    }
    const startHunk = currentMap.get(anchor.path)?.get(anchor.startLine);
    if (startHunk !== anchor.hunkId) {
      return { valid: false, reason: "multiline_invalid" };
    }
  }

  return { valid: true };
}

function startFile(line: string, lineNumber: number): MutableFile {
  const paths = parseDiffGitPaths(line.slice("diff --git ".length), lineNumber);
  const oldTokenPath = stripDiffPrefix(paths.oldPath, "a/");
  const newTokenPath = stripDiffPrefix(paths.newPath, "b/");
  return {
    oldTokenPath,
    newTokenPath,
    path: newTokenPath,
    status: "modified",
    sawModeOnlyHeader: false,
    hunks: []
  };
}

function consumeFileHeader(file: MutableFile, line: string, lineNumber: number): void {
  if (line.trim().length === 0) {
    return;
  }
  if (file.inBinaryPatch) {
    return;
  }
  if (line === "GIT binary patch") {
    file.isBinary = true;
    file.inBinaryPatch = true;
    return;
  }
  if (line.startsWith("Binary files ")) {
    file.isBinary = true;
    return;
  }
  if (line.startsWith("new file mode ")) {
    file.status = "added";
    file.newMode = line.slice("new file mode ".length).trim();
    markSpecialMode(file, file.newMode);
    return;
  }
  if (line.startsWith("deleted file mode ")) {
    file.status = "deleted";
    file.oldMode = line.slice("deleted file mode ".length).trim();
    markSpecialMode(file, file.oldMode);
    return;
  }
  if (line.startsWith("old mode ")) {
    file.oldMode = line.slice("old mode ".length).trim();
    file.sawModeOnlyHeader = true;
    markSpecialMode(file, file.oldMode);
    return;
  }
  if (line.startsWith("new mode ")) {
    file.newMode = line.slice("new mode ".length).trim();
    file.sawModeOnlyHeader = true;
    markSpecialMode(file, file.newMode);
    return;
  }
  if (line.startsWith("index ")) {
    const mode = line.trim().split(/\s+/u)[2];
    if (mode) {
      markSpecialMode(file, mode);
    }
    return;
  }
  if (line.startsWith("rename from ")) {
    file.status = "renamed";
    file.renameFrom = unquoteMaybe(line.slice("rename from ".length));
    return;
  }
  if (line.startsWith("rename to ")) {
    file.status = "renamed";
    file.renameTo = unquoteMaybe(line.slice("rename to ".length));
    return;
  }
  if (line.startsWith("copy from ")) {
    file.status = "copied";
    file.copyFrom = unquoteMaybe(line.slice("copy from ".length));
    return;
  }
  if (line.startsWith("copy to ")) {
    file.status = "copied";
    file.copyTo = unquoteMaybe(line.slice("copy to ".length));
    return;
  }
  if (
    line.startsWith("similarity index ") ||
    line.startsWith("dissimilarity index ") ||
    line.startsWith("--- ")
  ) {
    if (line.startsWith("--- ")) {
      file.oldTokenPath = parseFileHeaderPath(line.slice("--- ".length), "a/");
    }
    return;
  }
  if (line.startsWith("+++ ")) {
    const nextPath = parseFileHeaderPath(line.slice("+++ ".length), "b/");
    file.newTokenPath = nextPath;
    if (nextPath !== "/dev/null") {
      file.path = nextPath;
    }
    return;
  }
  throw parseError(lineNumber, `unexpected diff header line: ${line}`);
}

function startHunk(path: string, groups: Record<string, string>): MutableHunk {
  const oldStart = Number(groups.oldStart);
  const newStart = Number(groups.newStart);
  return {
    path,
    oldStart,
    oldLines: groups.oldLines === undefined ? 1 : Number(groups.oldLines),
    newStart,
    newLines: groups.newLines === undefined ? 1 : Number(groups.newLines),
    header: normalizeHunkHeader(groups.header ?? ""),
    lines: [],
    oldConsumed: 0,
    newConsumed: 0
  };
}

function consumeHunkLine(hunk: MutableHunk, line: string, lineNumber: number): void {
  const marker = line[0];
  const content = line.slice(1);

  if (marker === " ") {
    hunk.lines.push({
      kind: "context",
      content,
      oldLineNumber: hunk.oldStart + hunk.oldConsumed,
      newLineNumber: hunk.newStart + hunk.newConsumed
    });
    hunk.oldConsumed += 1;
    hunk.newConsumed += 1;
    return;
  }

  if (marker === "-") {
    hunk.lines.push({
      kind: "delete",
      content,
      oldLineNumber: hunk.oldStart + hunk.oldConsumed
    });
    hunk.oldConsumed += 1;
    return;
  }

  if (marker === "+") {
    hunk.lines.push({
      kind: "add",
      content,
      newLineNumber: hunk.newStart + hunk.newConsumed
    });
    hunk.newConsumed += 1;
    return;
  }

  throw parseError(lineNumber, "hunk line must start with space, '+', or '-'");
}

function finishHunk(
  file: MutableFile | undefined,
  hunk: MutableHunk | undefined,
  lineNumber: number
): undefined {
  if (!file || !hunk) {
    return undefined;
  }
  if (hunk.oldConsumed !== hunk.oldLines || hunk.newConsumed !== hunk.newLines) {
    throw parseError(
      lineNumber,
      `hunk line counts do not match header: expected -${hunk.oldLines} +${hunk.newLines}, got -${hunk.oldConsumed} +${hunk.newConsumed}`
    );
  }
  file.hunks.push({
    id: hunkId(hunk),
    hunkHash: hunkId(hunk),
    path: hunk.path,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    header: hunk.header,
    lines: hunk.lines
  });
  return undefined;
}

function finishFile(files: DiffFile[], file: MutableFile | undefined): void {
  if (!file) {
    return;
  }

  if (file.status === "renamed") {
    file.oldPath = file.renameFrom ?? file.oldTokenPath;
    file.path = file.renameTo ?? file.newTokenPath;
  } else if (file.status === "copied") {
    file.oldPath = file.copyFrom ?? file.oldTokenPath;
    file.path = file.copyTo ?? file.newTokenPath;
  } else if (file.status === "deleted") {
    file.path = file.oldTokenPath;
  } else if (file.status === "added") {
    file.path = file.newTokenPath;
  }

  // Mode-only means an existing file's permission bits changed with no content
  // diff. A rename/copy/add/delete that also carries a mode header is not
  // mode-only — its identity change is the reviewable fact.
  if (file.sawModeOnlyHeader && file.hunks.length === 0 && !file.isBinary && file.status === "modified") {
    file.modeOnly = true;
  }

  if (!file.isSubmodule && isSubmodulePointerHunks(file.hunks)) {
    file.isSubmodule = true;
  }

  const output: DiffFile = {
    path: file.path,
    status: file.status,
    language: languageFromPath(file.path),
    hunks: file.hunks.map((hunk) => {
      const hunkHash = hunkIdFor(file.path, hunk);
      return { ...hunk, path: file.path, id: hunkHash, hunkHash };
    })
  };
  if (file.oldPath !== undefined) {
    output.oldPath = file.oldPath;
  }
  if (file.isBinary) {
    output.isBinary = true;
  }
  if (file.modeOnly) {
    output.modeOnly = true;
  }
  if (file.isSymlink) {
    output.isSymlink = true;
  }
  if (file.isSubmodule) {
    output.isSubmodule = true;
  }
  files.push(output);
}

function hunkId(hunk: MutableHunk): string {
  return hunkIdFor(hunk.path, hunk);
}

function hunkIdFor(path: string, hunk: Pick<DiffHunk, "oldStart" | "newStart" | "header" | "lines">): string {
  const added = hunk.lines
    .filter((line): line is DiffLine & { newLineNumber: number } => line.kind === "add" && line.newLineNumber !== undefined)
    .map((line) => line.newLineNumber)
    .join(",");
  const deleted = hunk.lines
    .filter((line): line is DiffLine & { oldLineNumber: number } => line.kind === "delete" && line.oldLineNumber !== undefined)
    .map((line) => line.oldLineNumber)
    .join(",");
  return sha256Hex(
    `${path}\0${hunk.oldStart}\0${hunk.newStart}\0${hunk.header}\0add:${added};del:${deleted}`
  );
}

const HUNK_ID_PREFIX_LENGTHS = [8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64] as const;

export function allocateShortHunkIds(diff: UnifiedDiff): UnifiedDiff {
  const hunks = diff.files.flatMap((file) => file.hunks);
  const byHash = new Map<string, DiffHunk[]>();
  for (const hunk of hunks) {
    const group = byHash.get(hunk.hunkHash) ?? [];
    group.push(hunk);
    byHash.set(hunk.hunkHash, group);
  }
  const duplicate = [...byHash.entries()].find(([, group]) => group.length > 1);
  if (duplicate !== undefined) {
    throw new CodegenieError(
      "diff_parse_failed",
      `duplicate hunk digest produced while parsing diff: ${duplicate[0]}`,
      { context: { hunkHash: duplicate[0], occurrences: duplicate[1].length } }
    );
  }

  const prefixCounts = new Map<number, Map<string, number>>();
  for (const length of HUNK_ID_PREFIX_LENGTHS) {
    const counts = new Map<string, number>();
    for (const hunk of hunks) {
      const prefix = hunk.hunkHash.slice(0, length);
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    prefixCounts.set(length, counts);
  }

  return {
    files: diff.files.map((file) => ({
      ...file,
      hunks: file.hunks.map((hunk) => {
        const length = HUNK_ID_PREFIX_LENGTHS.find(
          (candidate) => prefixCounts.get(candidate)?.get(hunk.hunkHash.slice(0, candidate)) === 1
        ) ?? 64;
        return { ...hunk, id: hunk.hunkHash.slice(0, length) };
      })
    }))
  };
}

function setChangedLine(
  maps: Map<string, Map<number, string>>,
  filePath: string,
  line: number,
  hunkIdValue: string
): void {
  const existing = maps.get(filePath);
  if (existing) {
    existing.set(line, hunkIdValue);
    return;
  }
  maps.set(filePath, new Map([[line, hunkIdValue]]));
}

function sideMap(index: BuiltDiffAnchorIndex, side: "RIGHT" | "LEFT"): Map<string, Map<number, string>> {
  return side === "RIGHT" ? index.right : index.left;
}

function parseDiffGitPaths(rest: string, lineNumber: number): { oldPath: string; newPath: string } {
  const tokens = parseDiffTokens(rest);
  if (
    tokens.length === 2 &&
    (tokens[0]?.startsWith("a/") ?? false) &&
    (tokens[1]?.startsWith("b/") ?? false)
  ) {
    return { oldPath: tokens[0] ?? "", newPath: tokens[1] ?? "" };
  }

  const splits: Array<{ oldPath: string; newPath: string }> = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest.slice(index, index + 3) !== " b/") {
      continue;
    }
    const oldPath = rest.slice(0, index);
    const newPath = rest.slice(index + 1);
    if (oldPath.startsWith("a/") && newPath.startsWith("b/")) {
      splits.push({ oldPath, newPath });
    }
  }

  const equalPathSplit = splits.find(
    (split) => stripDiffPrefix(split.oldPath, "a/") === stripDiffPrefix(split.newPath, "b/")
  );
  if (equalPathSplit) {
    return equalPathSplit;
  }
  const lastSplit = splits.at(-1);
  if (lastSplit) {
    return lastSplit;
  }

  throw parseError(lineNumber, "diff --git header must contain old and new paths");
}

function parseDiffTokens(input: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < input.length) {
    while (input[index] === " ") {
      index += 1;
    }
    if (index >= input.length) {
      break;
    }
    if (input[index] === "\"") {
      const { value, nextIndex } = parseQuoted(input, index);
      tokens.push(value);
      index = nextIndex;
      continue;
    }
    let end = index;
    while (end < input.length && input[end] !== " ") {
      end += 1;
    }
    tokens.push(input.slice(index, end));
    index = end;
  }
  return tokens;
}

function unquoteMaybe(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("\"")) {
    return parseQuoted(trimmed, 0).value;
  }
  return trimmed;
}

function parseFileHeaderPath(input: string, prefix: "a/" | "b/"): string {
  const parsed = unquoteMaybe(input.trim());
  return stripDiffPrefix(parsed, prefix);
}

function parseQuoted(input: string, startIndex: number): { value: string; nextIndex: number } {
  const bytes: number[] = [];
  let index = startIndex + 1;
  while (index < input.length) {
    const char = input[index] ?? "";
    if (char === "\"") {
      return { value: Buffer.from(bytes).toString("utf8"), nextIndex: index + 1 };
    }
    if (char === "\\") {
      const next = input[index + 1] ?? "";
      const octal = /^[0-7]{1,3}/u.exec(input.slice(index + 1));
      if (octal) {
        bytes.push(Number.parseInt(octal[0], 8));
        index += 1 + octal[0].length;
        continue;
      }
      const escaped = decodeSimpleEscape(next);
      bytes.push(...Buffer.from(escaped, "utf8"));
      index += 2;
      continue;
    }
    bytes.push(...Buffer.from(char, "utf8"));
    index += 1;
  }
  throw new CodegenieError("diff_parse_failed", "unterminated quoted path in diff header");
}

function decodeSimpleEscape(char: string): string {
  switch (char) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    default:
      return char;
  }
}

function stripDiffPrefix(input: string, prefix: "a/" | "b/"): string {
  if (input === "/dev/null") {
    return input;
  }
  return input.startsWith(prefix) ? input.slice(prefix.length) : input;
}

function markSpecialMode(file: MutableFile, mode: string): void {
  if (mode === "120000") {
    file.isSymlink = true;
  }
  if (mode === "160000") {
    file.isSubmodule = true;
  }
}

function isSubmodulePointerHunks(hunks: DiffHunk[]): boolean {
  const changed = hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === "add" || line.kind === "delete"));
  return (
    changed.length > 0 &&
    changed.every((line) => /^Subproject commit [0-9a-f]{40,64}$/iu.test(line.content))
  );
}

function normalizeHunkHeader(header: string): string {
  return header.trim().replace(/\s+/gu, " ");
}

function languageFromPath(filePath: string): string {
  const basename = filePath.split("/").pop() ?? filePath;
  if (basename === "Dockerfile") {
    return "dockerfile";
  }
  if (basename === "Makefile") {
    return "make";
  }
  if (basename === "go.mod" || basename === "go.sum") {
    return "go";
  }
  if (filePath.endsWith(".go")) {
    return "go";
  }
  if (/\.(?:ts|tsx|mts|cts)$/u.test(filePath)) {
    return "typescript";
  }
  if (/\.(?:js|jsx|mjs|cjs)$/u.test(filePath)) {
    return "javascript";
  }
  if (filePath.endsWith(".rs")) {
    return "rust";
  }
  if (filePath.endsWith(".py")) {
    return "python";
  }
  if (filePath.endsWith(".sol")) {
    return "solidity";
  }
  if (filePath.endsWith(".json")) {
    return "json";
  }
  if (filePath.endsWith(".toml")) {
    return "toml";
  }
  if (/\.(?:yaml|yml)$/u.test(filePath)) {
    return "yaml";
  }
  if (filePath.endsWith(".md")) {
    return "markdown";
  }
  return "unknown";
}

function splitDiffLines(rawDiff: string): string[] {
  const normalized = rawDiff.replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function parseError(lineNumber: number, message: string): CodegenieError {
  return new CodegenieError("diff_parse_failed", `failed to parse diff at line ${lineNumber}: ${message}`);
}
