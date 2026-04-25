import type { Logger } from "../logger.js";
import type { CompatibilityContext } from "../config/types.js";
import type { AdapterEvent, InternalTask } from "../types/internal.js";
import type { CodexAdapter } from "../adapters/base.js";

export interface TaskGraphNode {
  id: string;
  parentId: string | null;
  kind: "planner" | "worker" | "summary" | "direct";
  title: string;
  status: "pending" | "running" | "completed" | "failed";
  output?: string;
}

export interface OrchestrationResult {
  finalText: string;
  events: AdapterEvent[];
  taskGraph: TaskGraphNode[];
}

interface PlanShape {
  strategy: "direct" | "planner-worker";
  subtasks: Array<{ id: string; title: string; prompt: string }>;
}

function stripCodeFences(text: string): string {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function parsePlan(text: string): PlanShape | null {
  try {
    const parsed = JSON.parse(stripCodeFences(text)) as PlanShape;
    if (!Array.isArray(parsed.subtasks)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function collectFinalText(
  adapter: CodexAdapter,
  task: InternalTask,
  signal?: AbortSignal
): Promise<{ finalText: string; events: AdapterEvent[] }> {
  let finalText = "";
  const events: AdapterEvent[] = [];

  for await (const event of adapter.execute(task, { signal })) {
    events.push(event);
    if (event.type === "text-delta") {
      finalText += event.text;
    }
    if (event.type === "completed") {
      finalText = event.finalText;
    }
  }

  return { finalText, events };
}

export class AgentOrchestrator {
  constructor(private readonly logger: Logger) {}

  async run(
    adapter: CodexAdapter,
    task: InternalTask,
    context: CompatibilityContext,
    signal?: AbortSignal
  ): Promise<OrchestrationResult> {
    const taskGraph: TaskGraphNode[] = [];
    const explicitPlanner = task.sourceRequest.metadata?.bridge_execution === "planner-worker";
    const shouldPlan =
      explicitPlanner ||
      task.prompt.length > 2500 ||
      /parallel|research|investigate|compare|analyze separately/i.test(task.prompt);

    if (!shouldPlan) {
      const directNode: TaskGraphNode = {
        id: "direct",
        parentId: null,
        kind: "direct",
        title: "Direct execution",
        status: "running"
      };
      taskGraph.push(directNode);
      const result = await collectFinalText(adapter, task, signal);
      directNode.status = "completed";
      directNode.output = result.finalText;
      return {
        finalText: result.finalText,
        events: result.events,
        taskGraph
      };
    }

    const plannerNode: TaskGraphNode = {
      id: "planner",
      parentId: null,
      kind: "planner",
      title: "Planner",
      status: "running"
    };
    taskGraph.push(plannerNode);

    const plannerTask: InternalTask = {
      ...task,
      requestId: `${task.requestId}:planner`,
      prompt: [
        "Create a short execution plan in JSON.",
        'Return JSON only with this shape: {"strategy":"planner-worker","subtasks":[{"id":"1","title":"...","prompt":"..."}]}.',
        "Use at most 3 subtasks.",
        "Each subtask prompt must be self-contained and focused.",
        `Original task:\n${task.prompt}`
      ].join("\n\n")
    };

    const plannerResult = await collectFinalText(adapter, plannerTask, signal);
    plannerNode.status = "completed";
    plannerNode.output = plannerResult.finalText;

    const parsedPlan = parsePlan(plannerResult.finalText);
    if (!parsedPlan || parsedPlan.subtasks.length === 0) {
      this.logger.warn("agents", "planner output was not parseable, falling back to direct mode", {
        requestId: task.requestId
      });

      const fallbackNode: TaskGraphNode = {
        id: "direct-fallback",
        parentId: null,
        kind: "direct",
        title: "Direct fallback",
        status: "running"
      };
      taskGraph.push(fallbackNode);
      const fallbackResult = await collectFinalText(adapter, task, signal);
      fallbackNode.status = "completed";
      fallbackNode.output = fallbackResult.finalText;

      return {
        finalText: fallbackResult.finalText,
        events: [...plannerResult.events, ...fallbackResult.events],
        taskGraph
      };
    }

    const workerResults = await Promise.all(
      parsedPlan.subtasks.slice(0, 3).map(async (subtask, index) => {
        const node: TaskGraphNode = {
          id: subtask.id || `worker-${index + 1}`,
          parentId: "planner",
          kind: "worker",
          title: subtask.title,
          status: "running"
        };
        taskGraph.push(node);

        const selectedAgentPrompt = task.selectedAgent
          ? `Selected agent\nName: ${task.selectedAgent.name}\nDescription: ${task.selectedAgent.description ?? "n/a"}\n\n${task.selectedAgent.prompt}`
          : null;

        const workerTask: InternalTask = {
          ...task,
          requestId: `${task.requestId}:worker:${node.id}`,
          sessionId: `${task.sessionId}:worker:${node.id}`,
          prompt: [
            selectedAgentPrompt,
            `Subtask title: ${subtask.title}`,
            subtask.prompt,
            context.claude.instructionFiles.length
              ? `Relevant CLAUDE instructions\n${context.claude.instructionFiles
                  .map((file) => `File: ${file.path}\n${file.content}`)
                  .join("\n\n")}`
              : null
          ]
            .filter(Boolean)
            .join("\n\n")
        };

        const result = await collectFinalText(adapter, workerTask, signal);
        node.status = "completed";
        node.output = result.finalText;

        return {
          node,
          result
        };
      })
    );

    const summaryNode: TaskGraphNode = {
      id: "summary",
      parentId: "planner",
      kind: "summary",
      title: "Synthesis",
      status: "running"
    };
    taskGraph.push(summaryNode);

    const summaryTask: InternalTask = {
      ...task,
      requestId: `${task.requestId}:summary`,
      prompt: [
        "Synthesize the worker results into the final assistant reply.",
        "Keep the tone and scope appropriate for the original user request.",
        `Original request:\n${task.prompt}`,
        workerResults
          .map(
            ({ node, result }) =>
              `Worker ${node.id} (${node.title}) output:\n${result.finalText}`
          )
          .join("\n\n")
      ].join("\n\n")
    };

    const summaryResult = await collectFinalText(adapter, summaryTask, signal);
    summaryNode.status = "completed";
    summaryNode.output = summaryResult.finalText;

    return {
      finalText: summaryResult.finalText,
      events: [
        ...plannerResult.events,
        ...workerResults.flatMap((item) => item.result.events),
        ...summaryResult.events
      ],
      taskGraph
    };
  }
}
