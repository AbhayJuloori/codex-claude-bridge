import { z } from "zod";

// ─── ExecutionPlan ──────────────────────────────────────────────────────────

export const executionPlanSchema = z.object({
  brain: z.enum(["codex_leads", "claude_leads"]),
  mode: z.enum([
    "implement",
    "review",
    "adversarial_review",
    "debug",
    "test_generation",
    "ui_build",
    "ui_refine",
    "architecture",
  ]),
  model_tier: z.enum(["mini", "standard", "full", "reasoning"]),
  reasoning_effort: z.enum(["low", "medium", "high", "xhigh"]),
  plugins_hint: z.array(z.string()),
  session_mode: z.enum(["stateless", "stateful"]),
  subagent_strategy: z.enum(["sequential", "parallel", "auto"]).default("auto"),
  write_policy: z.enum(["read_only", "workspace_write", "patch_only"]),
  claude_after: z.enum([
    "none",
    "judge_only",
    "ui_polish",
    "final_refine",
    "takeover_if_needed",
  ]),
  success_criteria: z.string(),
  architecture_notes: z.string().optional(),
  max_codex_turns: z.number().int().positive().optional(),
  max_wall_time_ms: z.number().int().positive().optional(),
  allow_takeover: z.boolean().default(false),
});

export type ExecutionPlan = z.infer<typeof executionPlanSchema>;

// ─── ExecutionPacket ────────────────────────────────────────────────────────

export const executionPacketSchema = z.object({
  status: z.enum(["completed", "partial", "failed", "needs_clarification"]),
  summary: z.string(),
  files_changed: z.array(z.string()),
  commands_run: z.array(z.string()),
  tests_run: z
    .object({
      passed: z.number().int().min(0),
      failed: z.number().int().min(0),
      skipped: z.number().int().min(0),
      output: z.string().optional(),
    })
    .optional(),
  diff_summary: z.string().optional(),
  risks: z.array(z.string()),
  unresolved_items: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export type ExecutionPacket = z.infer<typeof executionPacketSchema>;

// ─── JudgmentVerdict ────────────────────────────────────────────────────────

export const judgmentVerdictSchema = z.object({
  verdict: z.enum(["accept", "repair", "takeover"]),
  score: z.number().min(1).max(10),
  criteria: z.object({
    plan_satisfied: z.boolean(),
    architecture_preserved: z.boolean(),
    tests_meaningful: z.boolean(),
    implementation_clean: z.boolean(),
    ui_needs_polish: z.boolean(),
  }),
  repair_instructions: z.string().optional(),
  takeover_reason: z.string().optional(),
  polish_notes: z.string().optional(),
});

export type JudgmentVerdict = z.infer<typeof judgmentVerdictSchema>;

// ─── BudgetState ────────────────────────────────────────────────────────────

export interface BudgetState {
  max_claude_calls: number;
  max_repair_rounds: number;
  claude_calls_used: number;
  repair_rounds_used: number;
}

// ─── DelegatecodexResult ────────────────────────────────────────────────────

export type DelegatecodexStatus =
  | "accepted"
  | "repaired"
  | "takeover_complete"
  | "needs_user_or_manual_review";

export interface DelegatecodexResult {
  status: DelegatecodexStatus;
  output: string;
  plan: ExecutionPlan;
  packet: ExecutionPacket;
  verdict?: JudgmentVerdict;
  budget_used: BudgetState;
}
