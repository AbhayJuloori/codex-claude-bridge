import type { ClassificationResult, ControllerBudget, PlanResult } from "./types.js";

export type Route = "codex_direct" | "sonnet_plan" | "surface_to_user";

const CONFIDENCE_THRESHOLD = 0.85;

export class PipelineController {
  constructor(private readonly defaultBudget: ControllerBudget) {}

  getRoute(classification: ClassificationResult): Route {
    if (classification.task_type === "ambiguous") return "surface_to_user";
    if (classification.task_type === "judgment") return "sonnet_plan";

    if (
      classification.task_type === "mechanical" &&
      classification.confidence >= CONFIDENCE_THRESHOLD &&
      !classification.requires_plan
    ) {
      return "codex_direct";
    }

    return "sonnet_plan";
  }

  computeBudget(plan: PlanResult): ControllerBudget {
    return {
      max_retries_per_step: this.defaultBudget.max_retries_per_step,
      max_total_steps: Math.floor(plan.steps.length * 1.5)
    };
  }

  shouldEscalate(state: {
    retry_count: number;
    total_steps: number;
    plan: PlanResult;
  }): boolean {
    const budget = this.computeBudget(state.plan);
    if (state.retry_count > this.defaultBudget.max_retries_per_step) return true;
    if (state.total_steps > budget.max_total_steps) return true;
    return false;
  }
}
