import fs from "node:fs";
import path from "node:path";

export class DelegateMemory {
  private readonly memoryFile: string;

  constructor(private readonly workingDir: string, memoryPath = ".delegate/context.md") {
    this.memoryFile = path.join(workingDir, memoryPath);
  }

  init(
    project: string,
    techStack: Record<string, string>,
    constraints: string[]
  ): void {
    const dir = path.dirname(this.memoryFile);
    fs.mkdirSync(dir, { recursive: true });

    const stackLines = Object.entries(techStack)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join("\n");
    const constraintLines = constraints.map((c) => `- ${c}`).join("\n");

    const content = [
      `# Project Context`,
      ``,
      `**Project:** ${project}`,
      ``,
      `## Tech Stack`,
      stackLines || "- (not specified)",
      ``,
      `## Constraints`,
      constraintLines || "- (none)",
      ``,
      `## Completed Phases`,
      `(none yet)`,
      ``,
      `## File Map`,
      `(populated as phases complete)`
    ].join("\n");

    fs.writeFileSync(this.memoryFile, content, "utf8");
  }

  appendPhase(
    phaseId: string,
    phaseName: string,
    summaryPoints: string[],
    fileMap?: Record<string, string>
  ): void {
    if (!fs.existsSync(this.memoryFile)) return;

    let content = fs.readFileSync(this.memoryFile, "utf8");

    const phaseSection = [
      ``,
      `### ${phaseName} (${phaseId})`,
      summaryPoints.map((p) => `- ${p}`).join("\n")
    ].join("\n");

    content = content.replace("(none yet)", "").trimEnd();
    content += "\n" + phaseSection;

    if (fileMap && Object.keys(fileMap).length > 0) {
      const mapLines = Object.entries(fileMap)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n");
      content = content.replace("(populated as phases complete)", "").trimEnd();
      content += "\n" + mapLines;
    }

    fs.writeFileSync(this.memoryFile, content, "utf8");
  }

  read(): string {
    if (!fs.existsSync(this.memoryFile)) return "";
    return fs.readFileSync(this.memoryFile, "utf8");
  }

  exists(): boolean {
    return fs.existsSync(this.memoryFile);
  }
}
