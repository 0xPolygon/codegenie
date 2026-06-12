import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../util/hashing.js";
import { CodeninjaError } from "../util/errors.js";
import type { Logger } from "../types.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";

export type SkillSectionName = "purpose" | "checks" | "falsePositives" | "safePatterns" | "examples";
export type SkillSource = "bundled" | "repo" | "extra";

export type Skill = {
  id: string;
  title: string;
  lenses: string[];
  languages: string[];
  categories: string[];
  enabledByDefault: boolean;
  source: SkillSource;
  filePath: string;
  contentSha: string;
  sections: Partial<Record<SkillSectionName, string>>;
  summaryLine: string;
};

export type SkillLoadFailure = {
  filePath: string;
  reason: string;
};

export type SkillLoadResult = {
  skills: Skill[];
  failures: SkillLoadFailure[];
};

export async function loadSkills(opts: {
  repoRoot: string;
  extraSkillPaths: string[];
  logger: Logger;
  telemetry: TelemetryRecorder;
}): Promise<SkillLoadResult> {
  const repoRoot = path.resolve(opts.repoRoot);
  const bundledRoot = bundledSkillsRoot();
  const repoSkillsRoot = path.join(repoRoot, ".codeninja", "skills");
  const failures: SkillLoadFailure[] = [];
  const skills: Skill[] = [];
  const seenIds = new Set<string>();

  const sources: Array<{ source: SkillSource; files: string[] }> = [
    { source: "bundled", files: discoverMarkdownFiles(bundledRoot) },
    { source: "repo", files: discoverMarkdownFiles(repoSkillsRoot) },
    { source: "extra", files: discoverExtraSkillFiles(opts.extraSkillPaths) }
  ];

  for (const group of sources) {
    for (const filePath of group.files) {
      const parsed = parseSkillFile(filePath, group.source, opts.logger);
      if ("failure" in parsed) {
        recordFailure(parsed.failure, opts.logger, opts.telemetry);
        failures.push(parsed.failure);
        continue;
      }
      if (seenIds.has(parsed.skill.id)) {
        const failure = {
          filePath,
          reason: `duplicate skill id ${parsed.skill.id}; earlier skill wins`
        };
        recordFailure(failure, opts.logger, opts.telemetry);
        failures.push(failure);
        continue;
      }
      seenIds.add(parsed.skill.id);
      skills.push(parsed.skill);
    }
  }

  return { skills, failures };
}

function bundledSkillsRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../bundled-skills"),
    path.resolve(here, "../../../bundled-skills")
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new CodeninjaError("config_error", "bundled skills directory is missing", {
    context: { candidates }
  });
}

function discoverExtraSkillFiles(paths: string[]): string[] {
  return paths.flatMap((input) => discoverMarkdownFiles(path.resolve(input))).sort(comparePaths);
}

function discoverMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const stat = statSync(root);
  if (stat.isFile()) {
    return root.endsWith(".md") ? [root] : [];
  }
  if (!stat.isDirectory()) {
    return [];
  }

  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(entryPath);
      }
    }
  };
  visit(root);
  return files.sort(comparePaths);
}

function parseSkillFile(
  filePath: string,
  source: SkillSource,
  logger: Logger
): { skill: Skill } | { failure: SkillLoadFailure } {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (cause) {
    return {
      failure: {
        filePath,
        reason: `failed to read skill file: ${cause instanceof Error ? cause.message : String(cause)}`
      }
    };
  }
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) {
    return { failure: { filePath, reason: "skill file exceeds 256KB" } };
  }

  const frontmatter = parseFrontmatter(raw);
  if (!frontmatter) {
    return { failure: { filePath, reason: "missing YAML frontmatter" } };
  }

  const metadata = validateFrontmatter(frontmatter.frontmatter, filePath, logger);
  if ("failure" in metadata) {
    return { failure: metadata.failure };
  }

  const sections = parseSections(frontmatter.body, filePath, logger);
  const guidanceSections: SkillSectionName[] = ["checks", "falsePositives", "safePatterns", "examples"];
  if (guidanceSections.every((section) => !sections[section]?.trim())) {
    return {
      failure: {
        filePath,
        reason: "at least one guidance section is required: Checks, False Positives, Safe Patterns, or Examples"
      }
    };
  }

  if (!sections.checks?.trim()) {
    logger.warn({
      runId: "startup",
      stage: 0,
      event: "skill_missing_checks",
      message: `skill ${metadata.value.id} has no Checks section`,
      data: { filePath }
    });
  }

  return {
    skill: {
      ...metadata.value,
      source,
      filePath: path.resolve(filePath),
      contentSha: sha256Hex(raw),
      sections,
      summaryLine: summarizeSkill(metadata.value.title, sections)
    }
  };
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } | undefined {
  if (!raw.startsWith("---\n")) {
    return undefined;
  }
  const end = raw.indexOf("\n---", 4);
  if (end === -1) {
    return undefined;
  }
  const frontmatterText = raw.slice(4, end).trim();
  const body = raw.slice(end + "\n---".length).replace(/^\r?\n/, "");
  return { frontmatter: parseSimpleYaml(frontmatterText), body };
}

function parseSimpleYaml(input: string): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const lines = input.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }
    const key = match[1] ?? "";
    const rawValue = match[2] ?? "";
    if (rawValue.trim() === "") {
      const block = readYamlBlockList(lines, index + 1);
      if (block) {
        output[key] = block.values;
        index = block.endIndex - 1;
        continue;
      }
    }
    output[key] = parseYamlScalar(rawValue.trim());
  }
  return output;
}

function readYamlBlockList(lines: string[], startIndex: number): { values: string[]; endIndex: number } | undefined {
  const values: string[] = [];
  let index = startIndex;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }
    if (!/^\s+-\s+/.test(line)) {
      break;
    }
    values.push(unquote(line.replace(/^\s+-\s+/, "").trim()));
  }
  return values.length > 0 ? { values, endIndex: index } : undefined;
}

function parseYamlScalar(raw: string): unknown {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return inner.split(",").map((part) => unquote(part.trim())).filter((part) => part.length > 0);
  }
  return unquote(raw);
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

type SkillFrontmatter = Pick<Skill, "id" | "title" | "lenses" | "languages" | "categories" | "enabledByDefault">;

function validateFrontmatter(
  raw: Record<string, unknown>,
  filePath: string,
  logger: Logger
): { value: SkillFrontmatter } | { failure: SkillLoadFailure } {
  for (const key of Object.keys(raw)) {
    if (!["id", "title", "lenses", "languages", "categories", "enabledByDefault"].includes(key)) {
      logger.warn({
        runId: "startup",
        stage: 0,
        event: "skill_unknown_frontmatter_key",
        message: `ignoring unknown skill frontmatter key ${key}`,
        data: { filePath, key }
      });
    }
  }

  const id = raw.id;
  if (!isSkillId(id)) {
    return { failure: { filePath, reason: "frontmatter id is required and must be a valid skill id" } };
  }
  const title = raw.title;
  if (typeof title !== "string" || title.trim().length === 0 || title.length > 120) {
    return { failure: { filePath, reason: "frontmatter title is required and must be 1-120 chars" } };
  }
  if (!isIdArray(raw.lenses) || raw.lenses.length === 0) {
    return { failure: { filePath, reason: "frontmatter lenses must be a non-empty array of valid ids" } };
  }
  if (raw.languages !== undefined && !isStringArray(raw.languages)) {
    return { failure: { filePath, reason: "frontmatter languages must be an array of strings" } };
  }
  if (raw.categories !== undefined && !isStringArray(raw.categories)) {
    return { failure: { filePath, reason: "frontmatter categories must be an array of strings" } };
  }
  if (raw.enabledByDefault !== undefined && typeof raw.enabledByDefault !== "boolean") {
    return { failure: { filePath, reason: "frontmatter enabledByDefault must be boolean when present" } };
  }

  return {
    value: {
      id,
      title: title.trim(),
      lenses: raw.lenses,
      languages: raw.languages ?? [],
      categories: raw.categories ?? [],
      enabledByDefault: raw.enabledByDefault ?? true
    }
  };
}

function parseSections(body: string, filePath: string, logger: Logger): Partial<Record<SkillSectionName, string>> {
  const sections: Partial<Record<SkillSectionName, string>> = {};
  const lines = body.split(/\r?\n/);
  let current: SkillSectionName | undefined;
  let currentLines: string[] = [];
  let sawHeading = false;

  const flush = (): void => {
    if (!current) {
      return;
    }
    const text = currentLines.join("\n").trim();
    if (sections[current]) {
      logger.warn({
        runId: "startup",
        stage: 0,
        event: "skill_duplicate_section",
        message: `skill has duplicate ${current} section; concatenating`,
        data: { filePath, section: current }
      });
      sections[current] = `${sections[current]}\n\n${text}`.trim();
    } else {
      sections[current] = text;
    }
  };

  for (const line of lines) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (!sawHeading && currentLines.some((entry) => entry.trim())) {
        logger.debug({
          runId: "startup",
          stage: 0,
          event: "skill_preamble_ignored",
          message: "ignoring content before first skill section",
          data: { filePath }
        });
      }
      sawHeading = true;
      flush();
      currentLines = [];
      const headingText = heading[1] ?? "";
      current = sectionNameFromHeading(headingText);
      if (!current) {
        logger.debug({
          runId: "startup",
          stage: 0,
          event: "skill_unknown_section_ignored",
          message: `ignoring unknown skill section ${headingText}`,
          data: { filePath }
        });
      }
      continue;
    }
    if (current) {
      currentLines.push(line);
    } else if (!sawHeading) {
      currentLines.push(line);
    }
  }
  flush();
  return sections;
}

function sectionNameFromHeading(heading: string): SkillSectionName | undefined {
  switch (heading.trim().toLowerCase()) {
    case "purpose":
      return "purpose";
    case "checks":
      return "checks";
    case "false positives":
      return "falsePositives";
    case "safe patterns":
      return "safePatterns";
    case "examples":
      return "examples";
    default:
      return undefined;
  }
}

function summarizeSkill(title: string, sections: Partial<Record<SkillSectionName, string>>): string {
  const firstLine = sections.purpose
    ?.split(/\r?\n/)
    .map((line) => stripMarkdown(line).trim())
    .find(Boolean);
  return truncate(firstLine ?? title, 200);
}

function stripMarkdown(input: string): string {
  return input
    .replace(/[`*_#[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function recordFailure(failure: SkillLoadFailure, logger: Logger, telemetry: TelemetryRecorder): void {
  logger.warn({
    runId: telemetry.runId,
    stage: 0,
    event: "skill_invalid",
    message: `invalid skill skipped: ${failure.reason}`,
    data: { filePath: failure.filePath, reason: failure.reason }
  });
  telemetry.event({
    stage: 0,
    level: "warn",
    message: "skill_invalid",
    data: { filePath: failure.filePath, reason: failure.reason }
  });
}

function isSkillId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(value);
}

function isIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isSkillId);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function comparePaths(a: string, b: string): number {
  return a.localeCompare(b);
}

function truncate(input: string, maxChars: number): string {
  return input.length <= maxChars ? input : input.slice(0, maxChars - 1).trimEnd();
}
