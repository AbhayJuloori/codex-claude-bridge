import type { CodexAdapter } from "../adapters/base.js";
import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import type { InternalTask } from "../types/internal.js";
import type { PipelineResult, StepSpec } from "./types.js";
import { HaikuClassifier } from "./haiku-classifier.js";
import { ContextDistiller } from "./context-distiller.js";
import { SonnetPlanner } from "./sonnet-planner.js";
import { StepExecutor } from "./step-executor.js";
import { Gate } from "./gate.js";
import { PipelineController } from "./controller.js";

export interface PipelineOptions {
  max_retries_per_step?: number;
}

export async function runPipeline(
  task: InternalTask,
  claude: ClaudeSubprocessManager,
  adapter: CodexAdapter,
  opts: PipelineOptions = {}
): Promise<PipelineResult> {
  const classifier = new HaikuClassifier(claude);
  const distiller = new ContextDistiller(claude);
  const planner = new SonnetPlanner(claude);
  const executor = new StepExecutor(adapter, task);
  const gate = new Gate();
  const controller = new PipelineController({
    max_retries_per_step: opts.max_retries_per_step ?? 2,
    max_total_steps: 99 // overridden by computeBudget after planning
  });

  // Layer 1: classify
  const classification = await classifier.classify(task.prompt);

  // Layer 2: distill spec
  let compressedSpec: string;
  try {
    compressedSpec = await distiller.distill(classification.compressed_spec || task.prompt);
  } catch {
    compressedSpec = task.prompt.slice(0, 800);
  }

  // External routing
  const route = controller.getRoute(classification);

  if (route === "surface_to_user") {
    const question = classification.ambiguity_question ?? "Task is ambiguous — please clarify.";
    return { status: "ambiguous", output: question, steps_executed: 0, sonnet_invocations: 0 };
  }

  // Layer 3: optionally plan with Sonnet
  let steps: StepSpec[] = [
    {
      id: "step-direct",
      description: "execute task directly",
      prompt: compressedSpec,
      success_criteria: "Codex produces non-empty output without error"
    }
  ];
  let escalationTriggers: string[] = [];

  if (route === "sonnet_plan") {
    const plan = await planner.plan(task.prompt, compressedSpec);
    steps = plan.steps;
    escalationTriggers = plan.escalation_triggers;
  }

  const plan = { steps, escalation_triggers: escalationTriggers };

  // Codex execution loop — controlled externally
  let totalSteps = 0;
  const outputs: string[] = [];

  for (const step of steps) {
    let retries = 0;

    while (true) {
      totalSteps++;

      if (controller.shouldEscalate({ retry_count: retries, total_steps: totalSteps, plan })) {
        // Escalate to Sonnet review (second invocation)
        const reviewPrompt =
          `Original task: ${task.prompt}\n` +
          `Completed steps: ${outputs.length}\n` +
          `Current step failed after ${retries} retries: "${step.description}"\n` +
          `Last output: ${outputs.at(-1)?.slice(0, 300) ?? "(none)"}\n` +
          `Provide a one-sentence diagnosis and revised prompt for this step.`;

        let escalationSummary = `Escalated after ${retries} retries on step "${step.description}".`;
        try {
          await planner.plan(reviewPrompt);
          escalationSummary += " Sonnet review complete.";
        } catch {
          escalationSummary += " Sonnet invocation limit reached — no further review.";
        }

        return {
          status: "escalated",
          output: outputs.join("\n\n"),
          steps_executed: totalSteps,
          sonnet_invocations: planner.invocationCount,
          escalation_summary: escalationSummary
        };
      }

      const result = await executor.execute(step);
      const gateResult = gate.check(step, result);

      if (gateResult.pass) {
        outputs.push(result.output);
        break;
      }

      retries++;
    }
  }

  return {
    status: "completed",
    output: outputs.join("\n\n"),
    steps_executed: totalSteps,
    sonnet_invocations: planner.invocationCount
  };
}
