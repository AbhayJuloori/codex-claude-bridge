import path from "node:path";
import matter from "gray-matter";
import { listFilesRecursive, readTextFileSafe } from "../config/fs-utils.js";
import type { ConfigScope, SkillDefinition } from "../config/types.js";

function buildSkillId(source: "claude" | "codex", skillPath: string): string {
  const parent = path.basename(path.dirname(skillPath));
  return `${source}:${parent}`;
}

function parseSkillFile(
  skillPath: string,
  scope: ConfigScope,
  source: "claude" | "codex"
): SkillDefinition | null {
  const raw = readTextFileSafe(skillPath);
  if (!raw) {
    return null;
  }

  const parsed = matter(raw);
  const fallbackName = path.basename(path.dirname(skillPath));

  return {
    id: buildSkillId(source, skillPath),
    name:
      (typeof parsed.data.name === "string" && parsed.data.name.trim()) || fallbackName,
    path: skillPath,
    source,
    scope,
    description:
      typeof parsed.data.description === "string" ? parsed.data.description : null,
    content: parsed.content.trim(),
    frontmatter: parsed.data as Record<string, unknown>
  };
}

export function loadSkillsFromRoots(
  roots: Array<{ root: string; scope: ConfigScope; source: "claude" | "codex" }>
): SkillDefinition[] {
  const skills: SkillDefinition[] = [];

  for (const root of roots) {
    const skillPaths = listFilesRecursive(
      root.root,
      (absolutePath) => absolutePath.endsWith(`${path.sep}SKILL.md`),
      8
    );

    for (const skillPath of skillPaths) {
      const parsed = parseSkillFile(skillPath, root.scope, root.source);
      if (parsed) {
        skills.push(parsed);
      }
    }
  }

  return skills;
}

export function findReferencedSkills(
  allSkills: SkillDefinition[],
  text: string
): SkillDefinition[] {
  const lowered = text.toLowerCase();

  return allSkills.filter((skill) => {
    const names = [skill.name, skill.id, path.basename(path.dirname(skill.path))]
      .filter(Boolean)
      .map((item) => item.toLowerCase());

    return names.some((name) => {
      return (
        lowered.includes(`$${name}`) ||
        lowered.includes(`/skill ${name}`) ||
        lowered.includes(`use skill ${name}`) ||
        lowered.includes(`run skill ${name}`)
      );
    });
  });
}
