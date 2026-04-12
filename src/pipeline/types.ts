import { z } from "zod";

export const classificationResultSchema = z.object({
  task_type: z.enum(["mechanical", "multi_step", "judgment", "ambiguous"]),
  requires_plan: z.boolean(),
  requires_sonnet: z.boolean(),
  confidence: z.number().min(0).max(1),
  compressed_spec: z.string(),
  ambiguity_question: z.string().optional()
});

export type ClassificationResult = z.infer<typeof classificationResultSchema>;

export const stepSpecSchema = z.object({
  id: z.string(),
  description: z.string(),
  prompt: z.string(),
  success_criteria: z.string()
});

export type StepSpec = z.infer<typeof stepSpecSchema>;

export const planResultSchema = z.object({
  steps: z.array(stepSpecSchema).min(1),
  escalation_triggers: z.array(z.string())
});

export type PlanResult = z.infer<typeof planResultSchema>;

export const gateResultSchema = z.object({
  pass: z.boolean(),
  reason: z.string()
});

export type GateResult = z.infer<typeof gateResultSchema>;

export interface StepExecutionResult {
  step_id: string;
  output: string;
  status: "success" | "failure" | "empty";
}

export interface PipelineResult {
  status: "completed" | "escalated" | "failed" | "ambiguous";
  output: string;
  steps_executed: number;
  sonnet_invocations: number;
  escalation_summary?: string;
}

export interface ControllerBudget {
  max_retries_per_step: number;
  max_total_steps: number;
}
