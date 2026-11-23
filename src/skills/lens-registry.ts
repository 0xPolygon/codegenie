import type { CodegenieConfig, Logger } from "../types.js";
import type { TelemetryRecorder } from "../telemetry/telemetry-recorder.js";
import { sha256Hex } from "../util/hashing.js";
import { CodegenieError } from "../util/errors.js";
import type { Skill, SkillLoadFailure } from "./skill-loader.js";

export type LensDescriptor = {
  id: string;
  title: string;
  description: string;
  skillIds: string[];
  enabledByDefault: boolean;
  enabled: boolean;
  languages: string[];
  /** At least one skill on this lens is language-neutral. */
  languageNeutral?: boolean;
};

export interface LensRegistry {
  allLenses(): LensDescriptor[];
  enabledLenses(): LensDescriptor[];
  lens(id: string): LensDescriptor | undefined;
  skillsForLens(id: string): Skill[];
  skillsById(ids: string[]): Skill[];
  registryHash(): string;
}

export function skillsCompatibleWithLanguage(skills: Skill[], language?: string): Skill[] {
  return skills.filter((skill) => skill.languages.length === 0 ||
    (language !== undefined && skill.languages.includes(language)));
}

// Lenses declared only by skills that failed to load (no surviving skill
// declares them), so they cannot be registered and must be disclosed.
export function droppedLensesFromFailures(skills: Skill[], failures: SkillLoadFailure[]): string[] {
  const provided = new Set(skills.flatMap((skill) => skill.lenses));
  const dropped = new Set<string>();
  for (const failure of failures) {
    for (const lensId of failure.lenses ?? []) {
      if (!provided.has(lensId)) {
        dropped.add(lensId);
      }
    }
  }
  return [...dropped].sort();
}

export function buildLensRegistry(
  skills: Skill[],
  lensConfig: CodegenieConfig["lenses"],
  logger: Logger,
  telemetry: TelemetryRecorder,
  failures: SkillLoadFailure[] = []
): LensRegistry {
  const duplicateConfigIds = lensConfig.enabled.filter((id) => lensConfig.disabled.includes(id));
  if (duplicateConfigIds.length > 0) {
    throw new CodegenieError("config_error", "lens ids cannot be both enabled and disabled", {
      context: { lenses: duplicateConfigIds }
    });
  }

  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  const byLens = new Map<string, {
    firstSkill: Skill;
    skillIds: string[];
    enabledByDefault: boolean;
    languages: Set<string>;
    languageNeutral: boolean;
  }>();
  for (const skill of skills) {
    for (const lensId of skill.lenses) {
      const existing = byLens.get(lensId);
      if (existing) {
        existing.skillIds.push(skill.id);
        existing.enabledByDefault ||= skill.enabledByDefault;
        existing.languageNeutral ||= skill.languages.length === 0;
        for (const language of skill.languages) {
          existing.languages.add(language);
        }
      } else {
        byLens.set(lensId, {
          firstSkill: skill,
          skillIds: [skill.id],
          enabledByDefault: skill.enabledByDefault,
          languages: new Set(skill.languages),
          languageNeutral: skill.languages.length === 0
        });
      }
    }
  }

  const available = [...byLens.keys()].sort();
  if (lensConfig.restrictTo !== undefined) {
    const unknown = lensConfig.restrictTo.filter((id) => !byLens.has(id));
    if (unknown.length > 0) {
      throw new CodegenieError("invalid_args", `unknown lens ${unknown.join(", ")}; available lenses: ${available.join(", ")}`, {
        context: { unknown, available }
      });
    }
  }

  for (const lensId of [...lensConfig.enabled, ...lensConfig.disabled]) {
    if (!byLens.has(lensId)) {
      logger.warn({
        runId: telemetry.runId,
        stage: 0,
        event: "unknown_config_lens",
        message: `configured lens ${lensId} is not available and will be ignored`,
        lensId
      });
      telemetry.event({
        stage: 0,
        level: "warn",
        message: "unknown configured lens ignored",
        lensId,
        data: { lensId }
      });
    }
  }

  for (const lensId of droppedLensesFromFailures(skills, failures)) {
    logger.warn({
      runId: telemetry.runId,
      stage: 0,
      event: "lens_disabled_all_skills_failed",
      message: `lens ${lensId} is disabled because all skills declaring it failed to load`,
      lensId
    });
    telemetry.event({
      stage: 0,
      level: "warn",
      message: "lens disabled because all declaring skills failed to load",
      lensId,
      data: { lensId }
    });
  }

  const restrictedSet = lensConfig.restrictTo === undefined ? undefined : new Set(lensConfig.restrictTo);
  const enabledConfig = new Set(lensConfig.enabled);
  const disabledConfig = new Set(lensConfig.disabled);
  const descriptors = available.map((id) => {
    const entry = byLens.get(id);
    if (!entry) {
      throw new Error(`missing registered lens ${id}`);
    }
    const defaultEnabled = entry.enabledByDefault;
    const enabled = restrictedSet ? restrictedSet.has(id) : disabledConfig.has(id) ? false : enabledConfig.has(id) ? true : defaultEnabled;
    return {
      id,
      title: entry.firstSkill.title,
      description: truncate(entry.firstSkill.summaryLine, 200),
      skillIds: [...entry.skillIds],
      enabledByDefault: defaultEnabled,
      enabled,
      languages: [...entry.languages].sort(),
      languageNeutral: entry.languageNeutral
    };
  });

  return {
    allLenses: () => descriptors.map(cloneDescriptor),
    enabledLenses: () => descriptors.filter((lens) => lens.enabled).map(cloneDescriptor),
    lens: (id) => {
      const descriptor = descriptors.find((item) => item.id === id);
      return descriptor ? cloneDescriptor(descriptor) : undefined;
    },
    skillsForLens: (id) => {
      const descriptor = descriptors.find((item) => item.id === id);
      return descriptor ? descriptor.skillIds.map((skillId) => skillsById.get(skillId)).filter(isSkill) : [];
    },
    skillsById: (ids) => ids.map((id) => skillsById.get(id)).filter(isSkill),
    registryHash: () =>
      sha256Hex(
        JSON.stringify({
          skills: skills.map((skill) => ({ id: skill.id, contentSha: skill.contentSha })).sort((a, b) => a.id.localeCompare(b.id)),
          enabled: descriptors.filter((lens) => lens.enabled).map((lens) => lens.id).sort()
        })
      )
  };
}

function cloneDescriptor(descriptor: LensDescriptor): LensDescriptor {
  return {
    ...descriptor,
    skillIds: [...descriptor.skillIds],
    languages: [...descriptor.languages]
  };
}

function isSkill(skill: Skill | undefined): skill is Skill {
  return skill !== undefined;
}

function truncate(input: string, maxChars: number): string {
  return input.length <= maxChars ? input : input.slice(0, maxChars).trimEnd();
}
