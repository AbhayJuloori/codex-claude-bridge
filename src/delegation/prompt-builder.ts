import type { DelegateTask, DomainTag } from "./manifest.js";
import type { SkillRegistry } from "../skills/registry.js";

const UI_REWRITE_NOTE = `NOTE: This is a UI task. Build a functional skeleton only.
Focus on correct structure and component hierarchy. Visual quality will be refined
by Claude in a subsequent pass. Do not spend effort on styling details.`;

export class CodexPromptBuilder {
  constructor(private readonly skills: SkillRegistry) {}

  build(task: DelegateTask, memory: string): string {
    const isUI = task.domain.includes("ui") || task.domain.includes("frontend");
    const skillContent = this.skills.renderForPrompt(task.domain as DomainTag[]);
    const acceptanceList = task.acceptance.map((a) => `- ${a}`).join("\n");

    const sections: string[] = [
      `You are a precise implementation engine inside a Claude-managed delegation system.`,
      `Follow all skills and acceptance criteria exactly. Do the work directly.`,
      `Return a compressed implementation packet at the end — no raw transcript.`
    ];

    if (skillContent) {
      sections.push(`---\n\n# SKILLS\n\n${skillContent}`);
    }

    if (memory.trim()) {
      sections.push(`---\n\n# PROJECT CONTEXT (from prior phases)\n\n${memory.trim()}`);
    }

    sections.push(`---\n\n# TASK:\n\n${task.prompt}`);

    if (isUI) {
      sections.push(UI_REWRITE_NOTE);
    }

    sections.push(
      `# ACCEPTANCE CRITERIA:\n${acceptanceList}\n- No placeholder code or TODOs\n- All tests must pass before marking complete`
    );

    sections.push(
      `# OUTPUT FORMAT:\n` +
      `Return ONLY a single fenced \`\`\`bridge-packet block with this JSON shape:\n` +
      `{"type":"implementation_result","mode":"implement","task":"${task.id}","status":"completed|partial|failed",` +
      `"filesChanged":["..."],"summary":["..."],"commandsRun":["..."],"keyDecisions":["..."],` +
      `"warnings":["..."],"suggestedNextStep":null,"diffSummary":["..."],"confidence":0.0}`
    );

    return sections.join("\n\n");
  }

  buildUIRewrite(baselineOutput: string, originalTask: DelegateTask, memory: string): string {
    const skillContent = this.skills.renderForPrompt(["ui", "frontend"]);

    return [
      `You are Claude performing a UI quality rewrite of a Codex-generated baseline.`,
      `The baseline is functionally correct but visually rough. Rewrite it to production quality.`,
      `Preserve all logic and data flow. Focus on: layout, spacing, typography, component design, accessibility.`,
      skillContent ? `---\n\n# UI/UX SKILLS\n\n${skillContent}` : null,
      memory ? `---\n\n# PROJECT CONTEXT\n\n${memory}` : null,
      `---\n\n# ORIGINAL TASK:\n${originalTask.prompt}`,
      `---\n\n# BASELINE OUTPUT TO REWRITE:\n${baselineOutput}`,
      `# OUTPUT:\nReturn the complete rewritten implementation. Production-quality. No placeholders.`
    ].filter(Boolean).join("\n\n");
  }
}
