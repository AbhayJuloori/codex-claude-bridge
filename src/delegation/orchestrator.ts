import fs from "node:fs";
import path from "node:path";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { CodexAdapter } from "../adapters/base.js";
import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import type {
  DelegateManifest,
  DelegateTask,
  TaskResult,
  PhaseResult
} from "./manifest.js";
import type { DelegateProgressEvent } from "../orchestrator/types.js";
import { SkillRegistry } from "../skills/registry.js";
import { DelegateMemory } from "../session/delegate-memory.js";
import { CodexPromptBuilder } from "./prompt-builder.js";
import { parseImplementationPacket } from "../orchestrator/packets.js";
import type { InternalTask } from "../types/internal.js";

function isUITask(task: DelegateTask): boolean {
  return task.domain.includes("ui") || task.domain.includes("frontend");
}

async function runCodexTask(
  adapter: CodexAdapter,
  baseTask: InternalTask,
  taskPrompt: string,
  signal?: AbortSignal
): Promise<string> {
  const workerTask: InternalTask = {
    ...baseTask,
    prompt: taskPrompt,
    inputItems: [{ type: "text", text: taskPrompt }],
    messages: [{ role: "user", content: taskPrompt }]
  };

  let finalText = "";
  for await (const event of adapter.execute(workerTask, { signal })) {
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
  const resultSummary = taskResults
    .map(
      (t) =>
        `Task ${t.taskId}: ${t.status}${t.claudeRewritten ? " (UI rewritten by Claude)" : ""}\n${t.output.slice(0, 300)}`
    )
    .join("\n---\n");

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
    resultSummary
  ].join("\n");

  try {
    const raw = await claude.call(prompt, 30_000);
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as { verdict?: string; summary?: string };
      if (
        (parsed.verdict === "accepted" ||
          parsed.verdict === "patched" ||
          parsed.verdict === "escalated") &&
        typeof parsed.summary === "string"
      ) {
        return { verdict: parsed.verdict, summary: parsed.summary };
      }
    }
  } catch (err) {
    return {
      verdict: "escalated",
      summary: `Gate review failed: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  return {
    verdict: "accepted",
    summary: `Phase ${phaseName} completed (${taskResults.length} tasks)`
  };
}

type DelegateYield =
  | DelegateProgressEvent
  | { type: "text-delta"; text: string }
  | { type: "completed"; finalText: string };

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
  ): AsyncGenerator<DelegateYield> {
    const memory = new DelegateMemory(
      this.config.codex.cwd ?? process.cwd(),
      manifest.memory_path
    );
    memory.init(manifest.project, manifest.tech_stack, manifest.constraints);

    const allPhaseResults: PhaseResult[] = [];
    let totalClaudeRewrites = 0;

    for (const phase of manifest.phases) {
      yield {
        type: "delegate-progress",
        event: {
          kind: "phase-start",
          phaseId: phase.id,
          phaseName: phase.name,
          taskCount: phase.tasks.length
        }
      };

      const memoryContext = memory.read();
      const resolvedResults: TaskResult[] = [];

      // Execute tasks — parallel if phase.parallel, sequential otherwise
      const executeTask = async (
        task: DelegateTask,
        signal?: AbortSignal
      ): Promise<TaskResult> => {
        const taskPrompt = this.promptBuilder.build(task, memoryContext);
        let output = await runCodexTask(
          this.workerAdapter,
          baseTask,
          taskPrompt,
          signal
        );
        let claudeRewritten = false;

        if (isUITask(task) && this.claude) {
          const rewritePrompt = this.promptBuilder.buildUIRewrite(output, task, memoryContext);
          try {
            output = await this.claude.call(rewritePrompt, 60_000);
            claudeRewritten = true;
            totalClaudeRewrites++;
          } catch (err) {
            this.logger.warn("delegation", "UI rewrite failed, keeping Codex output", {
              taskId: task.id,
              error: String(err)
            });
          }
        }

        const packet = parseImplementationPacket(output);
        return {
          taskId: task.id,
          domain: task.domain,
          status: packet?.status ?? "failed",
          output: packet ? output : `${output}${output ? "\n" : ""}[packet parse failed]`,
          claudeRewritten
        };
      };

      // Emit task-start events then execute
      for (const task of phase.tasks) {
        yield {
          type: "delegate-progress",
          event: { kind: "task-start", phaseId: phase.id, taskId: task.id }
        };
      }

      const results = phase.parallel
        ? await (async () => {
            const phaseAbortController = new AbortController();
            try {
              return await Promise.all(
                phase.tasks.map((task) =>
                  executeTask(task, phaseAbortController.signal)
                )
              );
            } catch (err) {
              phaseAbortController.abort();
              throw err;
            }
          })()
        : await (async () => {
            const seq: TaskResult[] = [];
            for (const task of phase.tasks) {
              seq.push(await executeTask(task));
            }
            return seq;
          })();

      for (const result of results) {
        resolvedResults.push(result);
        yield {
          type: "delegate-progress",
          event: {
            kind: "task-complete",
            phaseId: phase.id,
            taskId: result.taskId,
            status: result.status,
            claudeRewritten: result.claudeRewritten
          }
        };
      }

      // Claude quality gate
      let gateVerdict: PhaseResult["gateVerdict"] = "accepted";
      let gateSummary = `Phase ${phase.name} complete`;

      if (phase.claude_gate && this.claude) {
        const gate = await claudeGatePhase(
          this.claude,
          phase.id,
          phase.name,
          resolvedResults
        );
        gateVerdict = gate.verdict;
        gateSummary = gate.summary;
      }

      yield {
        type: "delegate-progress",
        event: { kind: "gate-verdict", phaseId: phase.id, verdict: gateVerdict }
      };

      // Update project memory
      const summaryPoints = resolvedResults.map(
        (r) =>
          `${r.taskId}: ${r.status}${r.claudeRewritten ? " (Claude-rewritten)" : ""}`
      );
      memory.appendPhase(phase.id, phase.name, summaryPoints);

      allPhaseResults.push({
        phaseId: phase.id,
        phaseName: phase.name,
        tasks: resolvedResults,
        gateVerdict,
        summary: gateSummary
      });

      yield {
        type: "delegate-progress",
        event: { kind: "phase-complete", phaseId: phase.id, summary: gateSummary }
      };
    }

    const totalTasks = allPhaseResults.flatMap((p) => p.tasks).length;
    yield {
      type: "delegate-progress",
      event: {
        kind: "delegate-complete",
        totalTasks,
        claudeRewrites: totalClaudeRewrites
      }
    };

    const finalOutput = this.synthesize(manifest, allPhaseResults);
    yield { type: "text-delta", text: finalOutput };
    yield { type: "completed", finalText: finalOutput };
  }

  private synthesize(manifest: DelegateManifest, phases: PhaseResult[]): string {
    const lines: string[] = [
      `# Delegation Complete: ${manifest.project}`,
      ``,
      `## Phase Summary`
    ];

    for (const phase of phases) {
      lines.push(
        ``,
        `### ${phase.phaseName}`,
        `Gate: ${phase.gateVerdict} — ${phase.summary}`
      );
      for (const task of phase.tasks) {
        const rewritten = task.claudeRewritten ? " *(Claude-rewritten)*" : "";
        lines.push(`- **${task.taskId}**: ${task.status}${rewritten}`);
      }
    }

    const totalTasks = phases.flatMap((p) => p.tasks).length;
    const claudeRewrites = phases.flatMap((p) => p.tasks).filter((t) => t.claudeRewritten).length;
    lines.push(
      ``,
      `---`,
      `**${totalTasks} tasks completed**, ${claudeRewrites} Claude quality rewrites applied.`
    );

    return lines.join("\n");
  }
}
