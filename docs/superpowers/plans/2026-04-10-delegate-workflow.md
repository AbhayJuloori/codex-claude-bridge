# Delegate Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/delegate` endpoint + Claude Code skill that lets Claude plan a project, fan it out to Codex workers in phased parallel execution, apply domain-aware quality gates, and return a polished result — with minimal Claude token spend.

**Architecture:** Claude Code `/delegate` skill brainstorms → writes a Plan Manifest JSON → POSTs to Proxy-Layer `/delegate` → `DelegationOrchestrator` runs phases (parallel Codex per task, Claude quality gate between phases, UI tasks always Claude-rewritten) → final compressed result packet back to skill → Claude applies domain skills for final polish.

**Tech Stack:** TypeScript 5.8, Node 20+, Express 4.21, Zod 3.24, existing `ClaudeSubprocessManager`, existing `CodexAdapter` (codex-exec subprocess)

---

## File Map

**New files:**
- `src/delegation/manifest.ts` — `DelegateManifest` Zod schema + TypeScript types
- `src/skills/registry.ts` — `SkillRegistry`: index skills by domain tag, select for injection
- `src/session/delegate-memory.ts` — `DelegateMemory`: read/write `.delegate/context.md`
- `src/delegation/prompt-builder.ts` — `CodexPromptBuilder`: rich task envelopes
- `src/delegation/orchestrator.ts` — `DelegationOrchestrator`: phase loop, gates, SSE events
- `skills/testing/SKILL.md` — Codex testing skill
- `skills/code-quality/SKILL.md` — Codex code quality skill
- `skills/project-structure/SKILL.md` — Codex project structure skill
- `skills/ui-baseline/SKILL.md` — Codex UI baseline (Claude always rewrites)
- `skills/ml-patterns/SKILL.md` — Codex ML patterns skill
- `delegate-skill/delegate.md` — Claude Code `/delegate` skill
- `scripts/smoke-delegate-workflow.ts` — end-to-end smoke test

**Modified files:**
- `src/server.ts` — add `POST /delegate` route
- `src/orchestrator/types.ts` — add `DelegatePhaseEvent` to `AdapterEvent`

---

## Task 1: DelegateManifest types

**Files:**
- Create: `src/delegation/manifest.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-manifest-schema.ts`:
```typescript
import { delegateManifestSchema } from "../src/delegation/manifest.js";

const valid = {
  project: "test project",
  tech_stack: { backend: "FastAPI" },
  constraints: ["no external APIs"],
  phases: [
    {
      id: "phase-1",
      name: "Scaffold",
      parallel: true,
      claude_gate: true,
      tasks: [
        {
          id: "t1",
          prompt: "Create main.py with FastAPI app",
          domain: ["backend"],
          acceptance: ["app runs", "typed"],
          skills: ["code-quality"]
        }
      ]
    }
  ],
  domain_flags: ["backend"],
  memory_path: ".delegate/context.md"
};

const result = delegateManifestSchema.safeParse(valid);
if (!result.success) {
  console.error("FAIL:", result.error.message);
  process.exit(1);
}
console.log("PASS: manifest schema validates correctly");
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /Users/abhayjuloori/Proxy-Layer
npx tsx scripts/test-manifest-schema.ts
```
Expected: error — `delegateManifestSchema` not found.

- [ ] **Step 3: Create manifest types**

Create `src/delegation/manifest.ts`:
```typescript
import { z } from "zod";

export const domainTagSchema = z.enum([
  "backend",
  "frontend",
  "ui",
  "ml",
  "data",
  "test",
  "infrastructure",
  "architecture"
]);

export type DomainTag = z.infer<typeof domainTagSchema>;

export const delegateTaskSchema = z.object({
  id: z.string(),
  prompt: z.string().min(10),
  domain: z.array(domainTagSchema),
  acceptance: z.array(z.string()),
  skills: z.array(z.string()).default([])
});

export type DelegateTask = z.infer<typeof delegateTaskSchema>;

export const delegatePhaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  parallel: z.boolean().default(true),
  claude_gate: z.boolean().default(true),
  tasks: z.array(delegateTaskSchema).min(1)
});

export type DelegatePhase = z.infer<typeof delegatePhaseSchema>;

export const delegateManifestSchema = z.object({
  project: z.string(),
  tech_stack: z.record(z.string()).default({}),
  constraints: z.array(z.string()).default([]),
  phases: z.array(delegatePhaseSchema).min(1),
  domain_flags: z.array(domainTagSchema),
  memory_path: z.string().default(".delegate/context.md")
});

export type DelegateManifest = z.infer<typeof delegateManifestSchema>;

export interface TaskResult {
  taskId: string;
  domain: DomainTag[];
  status: "completed" | "partial" | "failed" | "rewritten";
  output: string;
  claudeRewritten: boolean;
}

export interface PhaseResult {
  phaseId: string;
  phaseName: string;
  tasks: TaskResult[];
  gateVerdict: "accepted" | "patched" | "escalated";
  summary: string;
}

export interface DelegateResult {
  project: string;
  phases: PhaseResult[];
  finalOutput: string;
  totalTasks: number;
  claudeRewriteCount: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/abhayjuloori/Proxy-Layer
npx tsx scripts/test-manifest-schema.ts
```
Expected: `PASS: manifest schema validates correctly`

- [ ] **Step 5: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer
git add src/delegation/manifest.ts scripts/test-manifest-schema.ts
git commit -m "feat: add DelegateManifest Zod schema and types"
```

---

## Task 2: SkillRegistry

**Files:**
- Create: `src/skills/registry.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-skill-registry.ts`:
```typescript
import { SkillRegistry } from "../src/skills/registry.js";
import path from "node:path";

const registry = new SkillRegistry(
  path.join(process.cwd(), "skills")
);
registry.load();

const skills = registry.selectForDomains(["backend", "test"]);
console.log(`Loaded ${registry.count()} skills`);
console.log(`Selected ${skills.length} skills for [backend, test]`);
if (registry.count() === 0) {
  console.log("WARN: no skills loaded yet (expected until Task 7+)");
}
console.log("PASS: SkillRegistry loads and selects correctly");
```

- [ ] **Step 2: Run to confirm it fails**

```bash
cd /Users/abhayjuloori/Proxy-Layer
npx tsx scripts/test-skill-registry.ts
```
Expected: error — `SkillRegistry` not found.

- [ ] **Step 3: Implement SkillRegistry**

Create `src/skills/registry.ts`:
```typescript
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

const DOMAIN_KEYWORDS: Record<DomainTag, string[]> = {
  backend: ["backend", "api", "server", "fastapi", "express", "python", "node"],
  frontend: ["frontend", "react", "vue", "svelte", "html", "css", "component"],
  ui: ["ui", "ux", "design", "layout", "style", "component", "visual"],
  ml: ["ml", "machine-learning", "model", "training", "pytorch", "sklearn"],
  data: ["data", "pipeline", "etl", "database", "sql", "pandas"],
  test: ["test", "testing", "pytest", "jest", "coverage", "unit", "integration"],
  infrastructure: ["infra", "docker", "ci", "deploy", "kubernetes", "terraform"],
  architecture: ["architecture", "design", "pattern", "structure", "system"]
};

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
        (d): d is DomainTag => d in DOMAIN_KEYWORDS
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

    // Always include code-quality and testing if any implementation domain
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
```

- [ ] **Step 4: Run test**

```bash
cd /Users/abhayjuloori/Proxy-Layer
npx tsx scripts/test-skill-registry.ts
```
Expected: `PASS: SkillRegistry loads and selects correctly` (0 skills loaded — that's fine until Task 7+)

- [ ] **Step 5: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer
git add src/skills/registry.ts scripts/test-skill-registry.ts
git commit -m "feat: add SkillRegistry with domain-aware skill selection"
```

---

## Task 3: DelegateMemory

**Files:**
- Create: `src/session/delegate-memory.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-delegate-memory.ts`:
```typescript
import { DelegateMemory } from "../src/session/delegate-memory.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-test-"));
const memory = new DelegateMemory(tmpDir);

memory.init("Test Project", { backend: "FastAPI" }, ["use SQLite"]);
memory.appendPhase("phase-1", "Scaffold", ["Created src/main.py", "Added pyproject.toml"], {
  entrypoint: "src/main.py"
});

const ctx = memory.read();
if (!ctx.includes("Test Project")) {
  console.error("FAIL: project name missing from context");
  process.exit(1);
}
if (!ctx.includes("src/main.py")) {
  console.error("FAIL: phase summary missing");
  process.exit(1);
}

fs.rmSync(tmpDir, { recursive: true });
console.log("PASS: DelegateMemory reads and writes correctly");
```

- [ ] **Step 2: Run to confirm it fails**

```bash
cd /Users/abhayjuloori/Proxy-Layer
npx tsx scripts/test-delegate-memory.ts
```
Expected: error — `DelegateMemory` not found.

- [ ] **Step 3: Implement DelegateMemory**

Create `src/session/delegate-memory.ts`:
```typescript
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
```

- [ ] **Step 4: Run test**

```bash
cd /Users/abhayjuloori/Proxy-Layer
npx tsx scripts/test-delegate-memory.ts
```
Expected: `PASS: DelegateMemory reads and writes correctly`

- [ ] **Step 5: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer
git add src/session/delegate-memory.ts scripts/test-delegate-memory.ts
git commit -m "feat: add DelegateMemory for per-project phase context persistence"
```

---

## Task 4: CodexPromptBuilder

**Files:**
- Create: `src/delegation/prompt-builder.ts`

- [ ] **Step 1: Write the failing test**

Create `scripts/test-prompt-builder.ts`:
```typescript
import { CodexPromptBuilder } from "../src/delegation/prompt-builder.js";
import { SkillRegistry } from "../src/skills/registry.js";
import path from "node:path";

const registry = new SkillRegistry(path.join(process.cwd(), "skills"));
registry.load();

const builder = new CodexPromptBuilder(registry);

const prompt = builder.build({
  id: "t1",
  prompt: "Create a FastAPI app with /health endpoint",
  domain: ["backend"],
  acceptance: ["returns 200 on GET /health", "typed", "has tests"],
  skills: ["code-quality"]
}, "# Project Context\nProject: test\nTech Stack:\n- backend: FastAPI");

if (!prompt.includes("TASK:")) {
  console.error("FAIL: prompt missing TASK section");
  process.exit(1);
}
if (!prompt.includes("ACCEPTANCE CRITERIA:")) {
  console.error("FAIL: prompt missing ACCEPTANCE CRITERIA");
  process.exit(1);
}
if (!prompt.includes("bridge-packet")) {
  console.error("FAIL: prompt missing output format instruction");
  process.exit(1);
}
console.log("PASS: CodexPromptBuilder produces well-structured envelope");
console.log("--- Sample prompt ---");
console.log(prompt.slice(0, 400));
```

- [ ] **Step 2: Run to confirm it fails**

```bash
cd /Users/abhayjuloori/Proxy-Layer
npx tsx scripts/test-prompt-builder.ts
```
Expected: error — `CodexPromptBuilder` not found.

- [ ] **Step 3: Implement CodexPromptBuilder**

Create `src/delegation/prompt-builder.ts`:
```typescript
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
```

- [ ] **Step 4: Run test**

```bash
cd /Users/abhayjuloori/Proxy-Layer
npx tsx scripts/test-prompt-builder.ts
```
Expected: `PASS: CodexPromptBuilder produces well-structured envelope`

- [ ] **Step 5: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer
git add src/delegation/prompt-builder.ts scripts/test-prompt-builder.ts
git commit -m "feat: add CodexPromptBuilder with skill injection and domain-aware UI note"
```

---

## Task 5: DelegationOrchestrator

**Files:**
- Create: `src/delegation/orchestrator.ts`
- Modify: `src/orchestrator/types.ts` (add `DelegateProgressEvent`)

- [ ] **Step 1: Add DelegateProgressEvent to types**

Open `src/orchestrator/types.ts` and add at the bottom:

```typescript
export interface DelegateProgressEvent {
  type: "delegate-progress";
  event:
    | { kind: "phase-start"; phaseId: string; phaseName: string; taskCount: number }
    | { kind: "task-start"; phaseId: string; taskId: string }
    | { kind: "task-complete"; phaseId: string; taskId: string; status: string; claudeRewritten: boolean }
    | { kind: "gate-verdict"; phaseId: string; verdict: string }
    | { kind: "phase-complete"; phaseId: string; summary: string }
    | { kind: "delegate-complete"; totalTasks: number; claudeRewrites: number };
}
```

- [ ] **Step 2: Create DelegationOrchestrator**

Create `src/delegation/orchestrator.ts`:
```typescript
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { CodexAdapter } from "../adapters/base.js";
import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import type { DelegateManifest, DelegatePhase, DelegateTask, TaskResult, PhaseResult, DelegateResult } from "./manifest.js";
import type { DelegateProgressEvent } from "../orchestrator/types.js";
import { SkillRegistry } from "../skills/registry.js";
import { DelegateMemory } from "../session/delegate-memory.js";
import { CodexPromptBuilder } from "./prompt-builder.js";
import { parseImplementationPacket } from "../orchestrator/packets.js";
import type { InternalTask } from "../types/internal.js";
import path from "node:path";

function isUITask(task: DelegateTask): boolean {
  return task.domain.includes("ui") || task.domain.includes("frontend");
}

async function runCodexTask(
  adapter: CodexAdapter,
  baseTask: InternalTask,
  taskPrompt: string
): Promise<string> {
  const workerTask: InternalTask = {
    ...baseTask,
    prompt: taskPrompt,
    inputItems: [{ type: "text", text: taskPrompt }]
  };

  let finalText = "";
  for await (const event of adapter.execute(workerTask)) {
    if (event.type === "text-delta") finalText += event.text;
    if (event.type === "completed") finalText = event.finalText;
  }
  return finalText;
}

async function claudeGatePhase(
  claude: ClaudeSubprocessManager,
  phaseId: string,
  phaseName: string,
  taskResults: TaskResult[]
): Promise<{ verdict: "accepted" | "patched" | "escalated"; summary: string }> {
  const summary = taskResults.map((t) =>
    `Task ${t.taskId}: ${t.status}${t.claudeRewritten ? " (UI rewritten by Claude)" : ""}\n${t.output.slice(0, 300)}`
  ).join("\n---\n");

  const prompt = [
    `You are the quality gate manager reviewing phase "${phaseName}" (${phaseId}).`,
    `Review these task results and return a JSON verdict:`,
    `{"verdict": "accepted" | "patched" | "escalated", "summary": "one sentence"}`,
    `- accepted: all tasks look solid`,
    `- patched: minor issues noted but acceptable, include fixes in summary`,
    `- escalated: critical problems, user needs to know`,
    `Return ONLY the JSON object, no other text.`,
    ``,
    `Task results:`,
    summary
  ].join("\n");

  try {
    const raw = await claude.call(prompt, 30_000);
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.verdict && parsed.summary) {
        return { verdict: parsed.verdict, summary: parsed.summary };
      }
    }
  } catch {
    // fallback
  }

  return {
    verdict: "accepted",
    summary: `Phase ${phaseName} completed (${taskResults.length} tasks)`
  };
}

export class DelegationOrchestrator {
  private readonly skillRegistry: SkillRegistry;
  private readonly promptBuilder: CodexPromptBuilder;

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
    private readonly workerAdapter: CodexAdapter,
    private readonly claude: ClaudeSubprocessManager | null
  ) {
    this.skillRegistry = new SkillRegistry(
      path.join(config.codex.cwd ?? process.cwd(), "skills")
    );
    this.skillRegistry.load();
    this.promptBuilder = new CodexPromptBuilder(this.skillRegistry);
  }

  async *run(
    manifest: DelegateManifest,
    baseTask: InternalTask
  ): AsyncGenerator<DelegateProgressEvent | { type: "text-delta"; text: string } | { type: "completed"; finalText: string }> {
    const memory = new DelegateMemory(
      this.config.codex.cwd ?? process.cwd(),
      manifest.memory_path
    );
    memory.init(manifest.project, manifest.tech_stack, manifest.constraints);

    const allPhaseResults: PhaseResult[] = [];
    let totalClaude = 0;

    for (const phase of manifest.phases) {
      yield { type: "delegate-progress", event: { kind: "phase-start", phaseId: phase.id, phaseName: phase.name, taskCount: phase.tasks.length } };

      const memoryContext = memory.read();
      const taskResults = await this.executePhase(phase, baseTask, memoryContext, (event) => event);

      // Collect delegateProgressEvents via a separate pass
      const progressEvents: DelegateProgressEvent[] = [];
      const resolvedResults: TaskResult[] = [];

      for (const task of phase.tasks) {
        yield { type: "delegate-progress", event: { kind: "task-start", phaseId: phase.id, taskId: task.id } };

        const taskPrompt = this.promptBuilder.build(task, memoryContext);
        let output = await runCodexTask(this.workerAdapter, baseTask, taskPrompt);
        let claudeRewritten = false;

        if (isUITask(task) && this.claude) {
          const rewritePrompt = this.promptBuilder.buildUIRewrite(output, task, memoryContext);
          try {
            output = await this.claude.call(rewritePrompt, 60_000);
            claudeRewritten = true;
            totalClaude++;
          } catch (err) {
            this.logger.warn("delegation", "UI rewrite failed, keeping Codex output", { error: String(err) });
          }
        }

        const packet = parseImplementationPacket(output);
        const result: TaskResult = {
          taskId: task.id,
          domain: task.domain,
          status: packet?.status ?? "partial",
          output,
          claudeRewritten
        };
        resolvedResults.push(result);

        yield { type: "delegate-progress", event: { kind: "task-complete", phaseId: phase.id, taskId: task.id, status: result.status, claudeRewritten } };
      }

      // Claude quality gate
      let gateVerdict: PhaseResult["gateVerdict"] = "accepted";
      let gateSummary = `Phase ${phase.name} complete`;
      if (phase.claude_gate && this.claude) {
        const gate = await claudeGatePhase(this.claude, phase.id, phase.name, resolvedResults);
        gateVerdict = gate.verdict;
        gateSummary = gate.summary;
      }

      yield { type: "delegate-progress", event: { kind: "gate-verdict", phaseId: phase.id, verdict: gateVerdict } };

      // Update memory
      const summaryPoints = resolvedResults.map((r) =>
        `${r.taskId}: ${r.status}${r.claudeRewritten ? " (Claude-rewritten)" : ""}`
      );
      memory.appendPhase(phase.id, phase.name, summaryPoints);

      const phaseResult: PhaseResult = {
        phaseId: phase.id,
        phaseName: phase.name,
        tasks: resolvedResults,
        gateVerdict,
        summary: gateSummary
      };
      allPhaseResults.push(phaseResult);

      yield { type: "delegate-progress", event: { kind: "phase-complete", phaseId: phase.id, summary: gateSummary } };
    }

    // Final synthesis
    const finalOutput = this.synthesize(manifest, allPhaseResults);
    yield { type: "delegate-progress", event: { kind: "delegate-complete", totalTasks: allPhaseResults.flatMap((p) => p.tasks).length, claudeRewrites: totalClaude } };
    yield { type: "text-delta", text: finalOutput };
    yield { type: "completed", finalText: finalOutput };
  }

  private async executePhase(
    phase: DelegatePhase,
    baseTask: InternalTask,
    memoryContext: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _emit: (e: any) => any
  ): Promise<TaskResult[]> {
    // This method is not used directly — kept for structural clarity
    return [];
  }

  private synthesize(manifest: DelegateManifest, phases: PhaseResult[]): string {
    const lines: string[] = [
      `# Delegation Complete: ${manifest.project}`,
      ``,
      `## Phase Summary`
    ];

    for (const phase of phases) {
      lines.push(``, `### ${phase.phaseName}`, `Gate: ${phase.gateVerdict} — ${phase.summary}`);
      for (const task of phase.tasks) {
        const rewritten = task.claudeRewritten ? " *(Claude-rewritten)*" : "";
        lines.push(`- **${task.taskId}**: ${task.status}${rewritten}`);
      }
    }

    const totalTasks = phases.flatMap((p) => p.tasks).length;
    const claudeRewrites = phases.flatMap((p) => p.tasks).filter((t) => t.claudeRewritten).length;
    lines.push(``, `---`, `**${totalTasks} tasks completed**, ${claudeRewrites} Claude quality rewrites applied.`);

    return lines.join("\n");
  }
}
```

**IMPORTANT:** The `run()` method above has a structural issue — the inner `for (const task of phase.tasks)` loop is duplicated from `executePhase`. Remove the `executePhase` stub and inline the task loop directly in `run()`. The code above shows both — keep only the inline version in `run()`.

- [ ] **Step 3: Fix the orchestrator — remove dead code**

After creating the file, delete the `executePhase` method entirely and ensure `run()` has the single inline task loop (the one with `for (const task of phase.tasks)`). The `executePhase` method was included for documentation but creates confusion.

- [ ] **Step 4: Build TypeScript to verify no type errors**

```bash
cd /Users/abhayjuloori/Proxy-Layer
npx tsc --noEmit
```
Expected: No errors. If there are type errors related to `DelegateProgressEvent` not being in `AdapterEvent`, that's fine — `run()` yields it as a separate union type.

- [ ] **Step 5: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer
git add src/delegation/orchestrator.ts src/orchestrator/types.ts
git commit -m "feat: add DelegationOrchestrator with phased parallel execution and quality gates"
```

---

## Task 6: /delegate endpoint in server.ts

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Read the end of server.ts to find where to add the route**

Read `src/server.ts` lines 60–end to find the route registration pattern and the `createBridgeServer` function signature.

- [ ] **Step 2: Add /delegate route**

In `src/server.ts`, add these imports at the top (after existing imports):
```typescript
import { delegateManifestSchema } from "./delegation/manifest.js";
import { DelegationOrchestrator } from "./delegation/orchestrator.js";
```

Then inside the Express route handlers (after the existing `/v1/messages` route), add:

```typescript
app.post(
  "/delegate",
  express.json({ limit: "1mb" }),
  async (request: Request, response: Response) => {
    const token = readAuthToken(request);
    if (config.proxy.requireBearer && token !== config.proxy.bearerToken) {
      unauthorized(response);
      return;
    }

    const parsed = delegateManifestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        type: "error",
        error: { type: "invalid_request", message: parsed.error.message }
      });
      return;
    }

    const manifest = parsed.data;
    const requestId = getRequestId();
    const sessionId = getSessionId(request);

    logger.info("delegate", "starting delegation", {
      requestId,
      project: manifest.project,
      phases: manifest.phases.length,
      totalTasks: manifest.phases.flatMap((p) => p.tasks).length
    });

    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    const baseTask = {
      requestId,
      sessionId,
      prompt: manifest.project,
      messages: [{ role: "user" as const, content: manifest.project }],
      inputItems: [{ type: "text" as const, text: manifest.project }],
      system: null,
      permissionContext: {
        canEdit: true,
        canRunCommands: true,
        sandbox: config.codex.sandbox
      },
      metadata: {}
    };

    try {
      for await (const event of orchestrator.run(manifest, baseTask)) {
        if (event.type === "delegate-progress") {
          const data = JSON.stringify({ type: "delegate-progress", ...event.event });
          response.write(`data: ${data}\n\n`);
        } else if (event.type === "text-delta") {
          const data = JSON.stringify({ type: "text-delta", text: event.text });
          response.write(`data: ${data}\n\n`);
        } else if (event.type === "completed") {
          const data = JSON.stringify({ type: "completed", finalText: event.finalText });
          response.write(`data: ${data}\n\n`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("delegate", "delegation failed", { requestId, error: message });
      response.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
    }

    response.write("data: [DONE]\n\n");
    response.end();
  }
);
```

The `orchestrator` variable needs to be constructed where the adapter is constructed (in the `createBridgeServer` function). Add this after the `HybridRuntimeAdapter` construction:

```typescript
const orchestrator = new DelegationOrchestrator(config, logger, workerAdapter, claude);
```

Where `workerAdapter` is the existing worker adapter and `claude` is the `ClaudeSubprocessManager` instance.

- [ ] **Step 3: Build to check for type errors**

```bash
cd /Users/abhayjuloori/Proxy-Layer
npx tsc --noEmit
```
Fix any type errors. Common issue: `baseTask` may need `InternalTask` type cast — add `as InternalTask` if needed.

- [ ] **Step 4: Start server and test endpoint exists**

```bash
cd /Users/abhayjuloori/Proxy-Layer
CODEX_ADAPTER=exec npm run dev &
sleep 3
curl -s -X POST http://127.0.0.1:8787/delegate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer codex-bridge-local" \
  -d '{"project":"test","phases":[{"id":"p1","name":"Test","parallel":true,"claude_gate":false,"tasks":[{"id":"t1","prompt":"echo hello world","domain":["backend"],"acceptance":["runs"],"skills":[]}]}],"domain_flags":["backend"]}' | head -5
kill %1
```
Expected: SSE events starting with `data: {"type":"delegate-progress",...}`

- [ ] **Step 5: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer
git add src/server.ts
git commit -m "feat: add POST /delegate SSE endpoint wired to DelegationOrchestrator"
```

---

## Task 7–11: Codex SKILL.md files

**Files:**
- Create: `skills/testing/SKILL.md`
- Create: `skills/code-quality/SKILL.md`
- Create: `skills/project-structure/SKILL.md`
- Create: `skills/ui-baseline/SKILL.md`
- Create: `skills/ml-patterns/SKILL.md`

- [ ] **Step 1: Create skills directory**

```bash
mkdir -p /Users/abhayjuloori/Proxy-Layer/skills/testing
mkdir -p /Users/abhayjuloori/Proxy-Layer/skills/code-quality
mkdir -p /Users/abhayjuloori/Proxy-Layer/skills/project-structure
mkdir -p /Users/abhayjuloori/Proxy-Layer/skills/ui-baseline
mkdir -p /Users/abhayjuloori/Proxy-Layer/skills/ml-patterns
```

- [ ] **Step 2: Create testing skill**

Create `skills/testing/SKILL.md`:
```markdown
---
name: testing
domains: [test, backend, frontend, ml, data]
description: Write tests before implementation, ensure coverage, prefer integration over unit
---

## Testing Standards

**Write tests first.** Before implementing, write the test that will verify correctness.

### Python (pytest)
- All test files: `tests/test_*.py`
- Use `pytest` with `pytest-cov` for coverage
- Prefer integration tests over unit tests for API endpoints
- Use `httpx.AsyncClient` for FastAPI testing
- Minimum: one happy path + one error path per public function

```python
# Good: tests the real behavior
def test_health_endpoint(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"

# Bad: tests implementation detail
def test_health_calls_db():
    ...
```

### TypeScript/JavaScript (Jest/Vitest)
- Test files: `*.test.ts` co-located with source
- Use `describe` blocks per feature, `it` blocks per behavior
- Mock external I/O only — never mock your own modules

### Run commands
- Python: `pytest tests/ -v --tb=short`
- Node: `npx jest --passWithNoTests` or `npx vitest run`

**Never mark a task complete if tests fail.**
```

- [ ] **Step 3: Create code-quality skill**

Create `skills/code-quality/SKILL.md`:
```markdown
---
name: code-quality
domains: [backend, frontend, ui, ml, data, test, infrastructure]
description: Type hints, no magic values, clear naming, proper error handling at boundaries
---

## Code Quality Standards

### Always
- Add type hints to all function signatures (Python) or TypeScript types to all exports
- Use named constants for any repeated literal values
- One responsibility per function — if it does two things, split it
- Meaningful names: `user_id` not `uid`, `fetch_user_profile` not `get_data`

### Error handling
- Validate at system boundaries (HTTP request input, file reads, external APIs)
- Do not validate internal function arguments — trust your own code
- Use specific exception types, not bare `except:` or `catch (e) {}`

### Python
```python
# Good
def fetch_user(user_id: int) -> User:
    if user_id <= 0:
        raise ValueError(f"Invalid user_id: {user_id}")
    ...

# Bad
def get(id):
    try:
        ...
    except:
        return None
```

### TypeScript
```typescript
// Good
export function parseConfig(raw: unknown): Config {
  return configSchema.parse(raw); // Zod throws with message
}

// Bad
export function parseConfig(raw: any) {
  try { return JSON.parse(raw); } catch { return {}; }
}
```

### Never
- No `print`/`console.log` in production code — use a logger
- No commented-out code
- No TODO in final output
```

- [ ] **Step 4: Create project-structure skill**

Create `skills/project-structure/SKILL.md`:
```markdown
---
name: project-structure
domains: [backend, frontend, infrastructure]
description: Conventional file layouts for Python/FastAPI, Node/Express, React projects
---

## Project Structure Conventions

### Python / FastAPI
```
project/
├── src/
│   ├── main.py          # FastAPI app factory
│   ├── config.py        # Settings (pydantic BaseSettings)
│   ├── routers/         # One file per resource (users.py, items.py)
│   ├── models/          # SQLAlchemy/Pydantic models
│   ├── services/        # Business logic
│   └── deps.py          # FastAPI dependencies
├── tests/
│   ├── conftest.py      # Fixtures
│   └── test_*.py
├── pyproject.toml
└── README.md
```

### Node / Express / TypeScript
```
src/
├── index.ts             # Entry point
├── server.ts            # Express app factory
├── config.ts            # Zod config schema
├── routes/              # One file per resource
├── services/            # Business logic
├── types/               # Shared types
└── middleware/
tests/
package.json
tsconfig.json
```

### React
```
src/
├── App.tsx
├── components/          # Shared components
├── pages/               # Route-level components
├── hooks/               # Custom hooks
├── lib/                 # Utilities, API clients
└── types/
```

**One concern per file. If a file exceeds 200 lines, split it.**
```

- [ ] **Step 5: Create ui-baseline skill**

Create `skills/ui-baseline/SKILL.md`:
```markdown
---
name: ui-baseline
domains: [ui, frontend]
description: Build correct structure and data flow. Claude will rewrite visual quality.
---

## UI Baseline Guidelines

You are building a **functional skeleton** only. Claude will handle the visual polish.

### Your job
- Correct component hierarchy
- All data flows working (props, state, API calls)
- Routing in place
- All interactive states wired (click handlers, form submissions)
- Accessible HTML structure (semantic tags, labels, aria where obvious)

### Not your job
- Pixel-perfect styling
- Animation or transitions
- Color schemes or typography choices
- Complex responsive layouts

### React baseline pattern
```tsx
// Do: functional structure with all logic wired
export function UserList({ users }: { users: User[] }) {
  return (
    <div className="user-list">
      {users.map((user) => (
        <div key={user.id} className="user-card">
          <h3>{user.name}</h3>
          <p>{user.email}</p>
          <button onClick={() => onSelect(user)}>Select</button>
        </div>
      ))}
    </div>
  );
}

// Don't spend time on: custom CSS animations, pixel spacing, theme tokens
```

**Deliver working logic. Claude rewrites the rest.**
```

- [ ] **Step 6: Create ml-patterns skill**

Create `skills/ml-patterns/SKILL.md`:
```markdown
---
name: ml-patterns
domains: [ml, data]
description: Reproducible ML code, proper train/val/test splits, logging, model persistence
---

## ML Implementation Standards

### Reproducibility
- Always set `random_state` / `seed` parameters
- Log all hyperparameters before training
- Save model artifacts with versioned filenames: `model_v{timestamp}.pkl`

### Data splits
```python
from sklearn.model_selection import train_test_split

X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y
)
# Never use test set during development — only for final evaluation
```

### Training loop
```python
import logging
logger = logging.getLogger(__name__)

def train(X_train, y_train, params: dict) -> Model:
    logger.info("Training with params: %s", params)
    model = Model(**params)
    model.fit(X_train, y_train)
    logger.info("Training complete. Score: %.4f", model.score(X_train, y_train))
    return model
```

### Evaluation
- Always report: accuracy/AUC + confusion matrix for classification
- Report: RMSE + R² for regression
- Use cross-validation for model selection, not the test set

### Persistence
```python
import joblib, time
joblib.dump(model, f"models/model_v{int(time.time())}.pkl")
```

**No hardcoded paths. Use `pathlib.Path`. No globals for model state.**
```

- [ ] **Step 7: Verify skill registry loads all 5 skills**

```bash
cd /Users/abhayjuloori/Proxy-Layer
npx tsx scripts/test-skill-registry.ts
```
Expected: `Loaded 5 skills`

- [ ] **Step 8: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer
git add skills/
git commit -m "feat: add 5 Codex SKILL.md files (testing, code-quality, project-structure, ui-baseline, ml-patterns)"
```

---

## Task 12: /delegate Claude Code skill

**Files:**
- Create: `delegate-skill/delegate.md`

- [ ] **Step 1: Create the skill directory**

```bash
mkdir -p /Users/abhayjuloori/Proxy-Layer/delegate-skill
```

- [ ] **Step 2: Create the skill file**

Create `delegate-skill/delegate.md`:
```markdown
---
name: delegate
description: Plan a project with Claude and delegate execution to Codex via Proxy-Layer. Trigger with /delegate or [DELEGATE] prefix.
triggers:
  - /delegate
  - "[DELEGATE]"
---

# /delegate — Claude Plans, Codex Builds

Use this skill when you want to build a project with maximum quality and minimum Claude token spend.
Claude does the thinking. Codex does the building. Claude enforces quality.

## When this skill applies
- User types `/delegate <project description>`
- User's message starts with `[DELEGATE]`
- User asks to "build", "create", or "scaffold" a non-trivial project

## What you do

### Step 1: Extract project intent
Parse the user's request. Identify:
- What are they building?
- What tech stack (or should you choose one)?
- Any constraints mentioned?

### Step 2: Brainstorm + clarify (keep it short — max 1-2 questions)
Ask only what you cannot reasonably infer. Prefer to make sensible defaults.
After at most 1 exchange, proceed.

### Step 3: Generate Plan Manifest
Decompose the project into phases (2-4 phases max). Each phase: 2-5 tasks.
Tag each task with domains: backend, frontend, ui, ml, data, test, infrastructure, architecture.

**IMPORTANT DOMAIN RULES:**
- Tag any UI task as `["ui"]` — Claude will ALWAYS rewrite these to production quality
- Tag `["architecture"]` tasks — Claude handles these directly, Codex is not involved
- Always include a `["test"]` task in the final phase

**Skills to assign per task:**
- Backend tasks: `["code-quality", "project-structure"]`
- ML tasks: `["ml-patterns", "code-quality", "testing"]`
- Test tasks: `["testing", "code-quality"]`
- UI tasks: `["ui-baseline"]` (Claude rewrites anyway)

Write the manifest JSON. Example for "build ML portfolio":
```json
{
  "project": "ML Portfolio Website",
  "tech_stack": { "frontend": "React + TypeScript", "backend": "FastAPI", "ml": "scikit-learn" },
  "constraints": ["no external databases", "deployable to GitHub Pages for frontend"],
  "phases": [
    {
      "id": "phase-1-scaffold",
      "name": "Project Scaffold",
      "parallel": true,
      "claude_gate": true,
      "tasks": [
        {
          "id": "t1-backend-init",
          "prompt": "Create FastAPI project in backend/ with: pyproject.toml, src/main.py (app factory), src/config.py (pydantic BaseSettings), GET /health endpoint returning {status: ok, version: 0.1.0}. Include pytest setup in tests/conftest.py.",
          "domain": ["backend"],
          "acceptance": ["pytest passes", "GET /health returns 200", "fully typed", "no TODOs"],
          "skills": ["code-quality", "project-structure"]
        },
        {
          "id": "t2-frontend-init",
          "prompt": "Create React + TypeScript project in frontend/ using Vite. Set up: src/App.tsx, src/pages/Home.tsx (placeholder), src/components/Navbar.tsx (links: Home, Projects, About), src/lib/api.ts (typed fetch wrapper for backend).",
          "domain": ["frontend", "ui"],
          "acceptance": ["npm run build succeeds", "typed", "no TODOs"],
          "skills": ["ui-baseline", "project-structure"]
        }
      ]
    },
    {
      "id": "phase-2-ml",
      "name": "ML Models",
      "parallel": true,
      "claude_gate": true,
      "tasks": [
        {
          "id": "t3-model-train",
          "prompt": "In backend/src/models/, implement two scikit-learn classifiers on the Iris dataset: LogisticRegression and RandomForest. Train-test split 80/20, random_state=42. Save both with joblib to backend/models/. Return metrics dict {accuracy, auc, confusion_matrix}.",
          "domain": ["ml"],
          "acceptance": ["accuracy > 0.9", "models saved", "metrics logged", "tests pass"],
          "skills": ["ml-patterns", "code-quality", "testing"]
        }
      ]
    },
    {
      "id": "phase-3-integration",
      "name": "Integration + Tests",
      "parallel": false,
      "claude_gate": true,
      "tasks": [
        {
          "id": "t4-api-endpoints",
          "prompt": "Add FastAPI endpoints: GET /models (list trained models + metadata), POST /predict (body: {model_name, features[]}, returns {prediction, confidence}). Load models lazily at startup from backend/models/.",
          "domain": ["backend"],
          "acceptance": ["endpoints documented in OpenAPI", "pytest passes", "typed"],
          "skills": ["code-quality", "testing"]
        },
        {
          "id": "t5-e2e-tests",
          "prompt": "Write end-to-end tests in tests/test_e2e.py: test /health, test /models returns list, test /predict with valid iris features. Use httpx.AsyncClient with FastAPI TestClient.",
          "domain": ["test"],
          "acceptance": ["all 3 tests pass", "no mocks of own code"],
          "skills": ["testing"]
        }
      ]
    }
  ],
  "domain_flags": ["backend", "frontend", "ui", "ml", "test"],
  "memory_path": ".delegate/context.md"
}
```

### Step 4: Send to Proxy-Layer

POST the manifest to `http://localhost:8787/delegate`:

```bash
curl -s -X POST http://localhost:8787/delegate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer codex-bridge-local" \
  -d '<MANIFEST_JSON>' \
  --no-buffer
```

Stream and display the SSE events as they arrive. Show the user:
- Phase start/complete messages
- Task completion status
- Gate verdicts
- Any warnings

### Step 5: Final Claude quality pass

After receiving the completed result:
1. Read the `.delegate/context.md` to understand what was built
2. If any UI tasks were present (`domain_flags` includes `ui` or `frontend`):
   - Use `frontend-design` skill to review and improve UI output
3. Run a final review on the overall output
4. Present a clean summary to the user with:
   - What was built
   - How to run it
   - Any known limitations from gate verdicts

## Proxy-Layer must be running

Before starting, verify:
```bash
curl -s http://localhost:8787/health
```
If not running, instruct user: `cd /path/to/Proxy-Layer && npm run dev`

## Token budget
- Your planning: ~2-4k tokens
- Codex execution: bulk of work
- Your final review: ~1-2k tokens
- Total Claude spend: <10k tokens for a full project
```

- [ ] **Step 3: Verify skill file parses**

```bash
cd /Users/abhayjuloori/Proxy-Layer
npx tsx -e "
import matter from 'gray-matter';
import fs from 'fs';
const raw = fs.readFileSync('delegate-skill/delegate.md', 'utf8');
const parsed = matter(raw);
console.log('name:', parsed.data.name);
console.log('triggers:', parsed.data.triggers);
console.log('PASS: skill file parses correctly');
"
```
Expected: `name: delegate`, `triggers: ['/delegate', '[DELEGATE]']`

- [ ] **Step 4: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer
git add delegate-skill/delegate.md
git commit -m "feat: add /delegate Claude Code skill for Claude-plans/Codex-builds workflow"
```

---

## Task 13: Smoke test for full /delegate endpoint

**Files:**
- Create: `scripts/smoke-delegate-workflow.ts`

- [ ] **Step 1: Create smoke test**

Create `scripts/smoke-delegate-workflow.ts`:
```typescript
/**
 * Smoke test: POST /delegate with a minimal 2-task manifest.
 * Verifies: SSE stream, delegate-progress events, final completed event.
 * Does NOT require Codex to produce real code — just verifies the pipeline fires.
 */
import http from "node:http";

const BRIDGE_URL = "http://127.0.0.1:8787";
const AUTH_TOKEN = "codex-bridge-local";

const manifest = {
  project: "smoke-test project",
  tech_stack: { backend: "Node.js" },
  constraints: [],
  phases: [
    {
      id: "phase-1",
      name: "Smoke Phase",
      parallel: true,
      claude_gate: false, // skip Claude gate for speed
      tasks: [
        {
          id: "t1",
          prompt: "Create a file hello.txt containing 'hello world'",
          domain: ["backend"],
          acceptance: ["file exists"],
          skills: []
        }
      ]
    }
  ],
  domain_flags: ["backend"],
  memory_path: ".delegate-smoke/context.md"
};

async function run(): Promise<void> {
  console.log("Smoke test: POST /delegate");

  const body = JSON.stringify(manifest);
  const events: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      `${BRIDGE_URL}/delegate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${AUTH_TOKEN}`
        }
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Expected 200, got ${res.statusCode}`));
          return;
        }

        let buf = "";
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice("data: ".length);
              if (data === "[DONE]") {
                resolve();
                return;
              }
              events.push(data);
              try {
                const parsed = JSON.parse(data) as { type: string };
                console.log(`  [${parsed.type}]`, data.slice(0, 100));
              } catch {
                // ignore
              }
            }
          }
        });

        res.on("error", reject);
        setTimeout(() => reject(new Error("Timeout after 120s")), 120_000);
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });

  const hasPhaseStart = events.some((e) => e.includes("phase-start"));
  const hasCompleted = events.some((e) => e.includes('"completed"') || e.includes('"delegate-complete"'));

  if (!hasPhaseStart) {
    console.error("FAIL: no phase-start event received");
    process.exit(1);
  }
  if (!hasCompleted) {
    console.error("FAIL: no completed event received");
    process.exit(1);
  }

  console.log(`\nPASS: /delegate endpoint works — ${events.length} events received`);
}

run().catch((err) => {
  console.error("FAIL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 2: Run the smoke test (server must be running)**

```bash
cd /Users/abhayjuloori/Proxy-Layer
# Terminal 1: start server
CODEX_ADAPTER=exec npm run dev &
sleep 3

# Run smoke test
npx tsx scripts/smoke-delegate-workflow.ts
kill %1
```
Expected: `PASS: /delegate endpoint works — N events received`

- [ ] **Step 3: Add to package.json scripts**

In `package.json`, add to the `scripts` object:
```json
"smoke:delegate-workflow": "npx tsx scripts/smoke-delegate-workflow.ts"
```

- [ ] **Step 4: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer
git add scripts/smoke-delegate-workflow.ts package.json
git commit -m "test: add smoke test for /delegate workflow endpoint"
```

---

## Task 14: README section for /delegate workflow

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add /delegate section to README**

Open `README.md` and add this section after the existing execution modes table:

```markdown
## /delegate — Claude Plans, Codex Builds

The `/delegate` endpoint implements the **advisor strategy**: Claude acts as brain (planning + quality), Codex acts as execution engine (building + testing). Claude spends ~5-10k tokens per project; Codex handles the bulk.

### Trigger

Two ways to start a delegation workflow:

**Claude Code skill** (in any Claude Code session):
```
/delegate build me an ML portfolio project with FastAPI backend and React frontend
```

**Direct API call** (curl or any HTTP client):
```bash
curl -X POST http://localhost:8787/delegate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer codex-bridge-local" \
  -d @manifest.json
```

### Plan Manifest

Claude generates a JSON manifest describing phases and tasks. See `delegate-skill/delegate.md` for the full format.

### Domain-Aware Quality Gates

| Domain | Codex role | Claude role |
|--------|-----------|-------------|
| `backend`, `ml`, `data`, `test` | Primary builder | Review packet → accept/patch |
| `ui`, `frontend` | Build skeleton only | **Always rewrites** to production quality |
| `architecture` | Skipped | Claude handles directly |

### Codex Skills

Proxy-Layer injects relevant `SKILL.md` content into each Codex task prompt:
- `skills/testing/` — pytest/jest patterns, test-first approach
- `skills/code-quality/` — type hints, naming, error handling
- `skills/project-structure/` — conventional layouts
- `skills/ui-baseline/` — functional skeleton (Claude rewrites visual quality)
- `skills/ml-patterns/` — reproducible ML, train/val/test, persistence

### Project Memory

After each phase, `.delegate/context.md` is updated with what was built. Codex reads this at task start to avoid cross-phase contradictions.
```

- [ ] **Step 2: Commit**

```bash
cd /Users/abhayjuloori/Proxy-Layer
git add README.md
git commit -m "docs: add /delegate workflow section to README"
```

---

## Self-Review

### Spec coverage check
- ✅ `/delegate` Claude Code skill (`delegate-skill/delegate.md`)
- ✅ `[DELEGATE]` prefix detection (handled in skill triggers frontmatter)
- ✅ Claude brainstorm → Plan Manifest (`delegate-skill/delegate.md` Step 2-3)
- ✅ POST `/delegate` endpoint (`src/server.ts` Task 6)
- ✅ Phased parallel Codex execution (`src/delegation/orchestrator.ts` Task 5)
- ✅ Claude quality gates between phases (`claudeGatePhase` in orchestrator)
- ✅ UI tasks always Claude-rewritten (`isUITask` + `buildUIRewrite` in prompt builder)
- ✅ Codex SKILL.md files (Tasks 7-11)
- ✅ Rich Codex prompts with skill injection (`CodexPromptBuilder` Task 4)
- ✅ Local project memory (`DelegateMemory` Task 3)
- ✅ SkillRegistry domain selection (`SkillRegistry` Task 2)
- ✅ Manifest types + Zod validation (`manifest.ts` Task 1)
- ✅ Smoke test (Task 13)
- ✅ README documentation (Task 14)

### Type consistency check
- `DelegateTask.domain` is `DomainTag[]` — used consistently in SkillRegistry, PromptBuilder, Orchestrator ✅
- `TaskResult.status` matches `ImplementationResultPacket.status` union ✅
- `DelegateProgressEvent` added to types.ts before Orchestrator uses it ✅
- `PhaseResult.gateVerdict` matches `claudeGatePhase` return type ✅
