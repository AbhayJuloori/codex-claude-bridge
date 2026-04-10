import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { DomainTag } from "../delegation/manifest.js";

export interface LoadedSkill {
  id: string;
  name: string;
  domains: DomainTag[];
  content: string;
}

const ALL_DOMAINS: DomainTag[] = [
  "backend", "frontend", "ui", "ml", "data", "test", "infrastructure", "architecture"
];

export class SkillRegistry {
  private skills: LoadedSkill[] = [];

  constructor(private readonly skillsRoot: string) {}

  load(): void {
    this.skills = [];
    if (!fs.existsSync(this.skillsRoot)) {
      return;
    }

    const entries = fs.readdirSync(this.skillsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(this.skillsRoot, entry.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;

      const raw = fs.readFileSync(skillFile, "utf8");
      const parsed = matter(raw);
      const name = (parsed.data.name as string | undefined) ?? entry.name;
      const rawDomains = (parsed.data.domains as string[] | undefined) ?? [];
      const domains = rawDomains.filter(
        (d): d is DomainTag => (ALL_DOMAINS as string[]).includes(d)
      );

      this.skills.push({
        id: `codex:${entry.name}`,
        name,
        domains,
        content: parsed.content.trim()
      });
    }
  }

  count(): number {
    return this.skills.length;
  }

  selectForDomains(domains: DomainTag[]): LoadedSkill[] {
    if (domains.length === 0) {
      return this.skills;
    }

    const domainSet = new Set(domains);
    const exact = this.skills.filter(
      (skill) => skill.domains.some((d) => domainSet.has(d))
    );

    const implementationDomains: DomainTag[] = ["backend", "frontend", "ui", "ml", "data"];
    const hasImpl = domains.some((d) => implementationDomains.includes(d));
    if (hasImpl) {
      const universal = this.skills.filter(
        (s) => s.id === "codex:testing" || s.id === "codex:code-quality"
      );
      const merged = new Map<string, LoadedSkill>();
      for (const s of [...exact, ...universal]) {
        merged.set(s.id, s);
      }
      return Array.from(merged.values());
    }

    return exact;
  }

  getContent(skillId: string): string | null {
    return this.skills.find((s) => s.id === skillId)?.content ?? null;
  }

  renderForPrompt(domains: DomainTag[]): string {
    const selected = this.selectForDomains(domains);
    if (selected.length === 0) return "";

    return selected
      .map((skill) => `## Skill: ${skill.name}\n\n${skill.content}`)
      .join("\n\n---\n\n");
  }
}
