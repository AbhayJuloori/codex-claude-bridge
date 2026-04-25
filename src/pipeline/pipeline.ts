import type { CodexAdapter } from "../adapters/base.js";
import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import type { InternalTask } from "../types/internal.js";
import type { PipelineProgressEvent, PipelineResult, StepSpec } from "./types.js";
import { HaikuClassifier, HaikuClassifierError } from "./haiku-classifier.js";
import { HaikuClarifier } from "./haiku-clarifier.js";
import { ContextDistiller } from "./context-distiller.js";
import { SonnetPlanner } from "./sonnet-planner.js";
import { SonnetTakeover } from "./sonnet-takeover.js";
import { StepExecutor } from "./step-executor.js";
import { Gate } from "./gate.js";
import { PipelineController } from "./controller.js";

export interface PipelineOptions {
  max_retries_per_step?: number;
  onProgress?: (event: PipelineProgressEvent) => void;
}

export async function runPipeline(
  task: InternalTask,
  claude: ClaudeSubprocessManager,
  adapter: CodexAdapter,
  opts: PipelineOptions = {}
): Promise<PipelineResult> {
  const classifier = new HaikuClassifier(claude);
  const clarifier = new HaikuClarifier(claude);
  const distiller = new ContextDistiller(claude);
  const planner = new SonnetPlanner(claude);
  const takeover = new SonnetTakeover(claude);
  const executor = new StepExecutor(adapter, task, clarifier);
  const gate = new Gate();
  const controller = new PipelineController({
    max_retries_per_step: opts.max_retries_per_step ?? 2,
    max_total_steps: 99
  });

  const warnings: string[] = [];

  // ── Layer 1: classify ────────────────────────────────────────────────────
  // Fix #1: HaikuClassifierError means the system failed, not the task is ambiguous.
  // Surface it as "failed" rather than silently routing to surface_to_user.
  let classification;
  try {
    classification = await classifier.classify(task.prompt);
  } catch (err) {
    if (err instanceof HaikuClassifierError) {
      return {
        status: "failed",
        output: err.message,
        steps_executed: 0,
        sonnet_invocations: 0,
        escalation_summary: "Classification unavailable — retry later"
      };
    }
    throw err;
  }
  opts.onProgress?.({ type: "classification", classification });

  // ── Layer 2: distill spec ────────────────────────────────────────────────
  // Fix #7: Classifier and distiller share the same Haiku subprocess path.
  // They are already sequential here, and withRetry inside each adds backoff,
  // so rapid back-to-back calls naturally space out on transient failures.
  //
  // Fix #5: DistillResult surfaces compression failure rather than silently truncating.
  const distillResult = await distiller.distill(classification.compressed_spec || task.prompt);
  if (distillResult.compressionError) {
    warnings.push(`context_distillation: ${distillResult.compressionError}`);
  }
  const compressedSpec = distillResult.content;

  // ── External routing ─────────────────────────────────────────────────────
  const route = controller.getRoute(classification);

  if (route === "surface_to_user") {
    const question = classification.ambiguity_question ?? "Task is ambiguous — please clarify.";
    return { status: "ambiguous", output: question, steps_executed: 0, sonnet_invocations: 0 };
  }

  // ── Layer 3: optionally plan with Sonnet ─────────────────────────────────
  let steps: StepSpec[] = [
    {
      id: "step-direct",
      description: "execute task directly",
      prompt:
        `Follow these 4 guidelines:
1. Think before coding: state assumptions explicitly, ask if ambiguous, surface tradeoffs before writing code
2. Simplicity first: minimum code that solves the problem — no speculative features, no unnecessary abstractions
3. Surgical changes: touch only what the task requires, match existing style, do not refactor adjacent code
4. Goal-driven: define verifiable success criteria before implementing; for bugs, reproduce first then fix

${task.prompt}

[Classification: type=${classification.task_type} confidence=${classification.confidence} summary=${classification.compressed_spec}]` +
        (
          classification.is_ui
            ? "\nThis task involves UI — produce production-quality output."
            : ""
        ),
      success_criteria:
        (() => {
          const successCriteria = classification.success_criteria;
          return typeof successCriteria === "string" && successCriteria.trim()
            ? successCriteria
            : "non-empty output";
        })()
    }
  ];
  let escalationTriggers: string[] = [];

  if (route === "sonnet_plan") {
    try {
      const plan = await planner.plan(task.prompt, compressedSpec);
      steps = plan.steps;
      escalationTriggers = plan.escalation_triggers;
    } catch (err) {
      // Fix #2: subprocess failure (not invocation limit) — invocation count was NOT
      // incremented. Fall back to single-step with the compressed spec.
      const isLimitError = err instanceof Error && err.message.includes("invocation limit");
      if (isLimitError) throw err; // architectural violation — bubble up
      warnings.push(`sonnet_planner: subprocess failed, using single-step fallback`);
    }
  }

  const plan = { steps, escalation_triggers: escalationTriggers };

  // ── Codex execution loop (controlled externally) ─────────────────────────
  let totalSteps = 0;
  let takeoverCount = 0;
  const outputs: string[] = [];

  for (const step of steps) {
    let retries = 0;

    while (true) {
      totalSteps++;

      if (controller.shouldEscalate({ retry_count: retries, total_steps: totalSteps, plan })) {
        const escalationSummary = `Escalated after ${retries} retries on step "${step.description}".`;
        opts.onProgress?.({
          type: "escalating",
          step,
          retry_count: retries,
          steps_executed: totalSteps,
          reason: escalationSummary
        });

        const takeoverResult = await takeover.execute(step, task.prompt, outputs);
        takeoverCount++;
        opts.onProgress?.({
          type: "takeover",
          step,
          succeeded: takeoverResult.succeeded,
          output: takeoverResult.output
        });
        if (takeoverResult.succeeded) {
          outputs.push(takeoverResult.output);
          break;
        }

        return {
          status: "escalated",
          output: outputs.join("\n\n"),
          steps_executed: totalSteps,
          sonnet_invocations: planner.invocationCount + takeoverCount,
          escalation_summary: escalationSummary + (warnings.length ? ` Warnings: ${warnings.join("; ")}` : "")
        };
      }

      const result = await executor.execute(step);
      if (result.status === "needs_clarification") {
        return {
          status: "needs_user_input",
          output: result.output,
          steps_executed: totalSteps,
          sonnet_invocations: planner.invocationCount + takeoverCount
        };
      }

      const gateResult = gate.check(step, result);

      if (gateResult.pass) {
        outputs.push(result.output);
        opts.onProgress?.({
          type: "step_complete",
          step,
          output: result.output,
          steps_executed: totalSteps
        });
        break;
      }

      retries++;
    }
  }

  return {
    status: "completed",
    output: outputs.join("\n\n"),
    steps_executed: totalSteps,
    sonnet_invocations: planner.invocationCount + takeoverCount,
    ...(warnings.length && { escalation_summary: `Warnings: ${warnings.join("; ")}` })
  };
}
