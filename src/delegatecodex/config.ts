import type { ExecutionPlan } from "./types.js";

// ─── Model tiers ─────────────────────────────────────────────────────────────

export const MODEL_TIERS = {
  mini:      process.env.CODEX_MODEL_MINI      ?? "gpt-5.4-mini",
  standard:  process.env.CODEX_MODEL_STANDARD  ?? "gpt-5.4",
  full:      process.env.CODEX_MODEL_FULL      ?? "gpt-5.5",
  reasoning: process.env.CODEX_MODEL_REASONING ?? "o4-mini",
} as const;

export type ModelTier = keyof typeof MODEL_TIERS;

export function resolveModel(tier: ModelTier): string {
  return MODEL_TIERS[tier];
}

// ─── Budget defaults ─────────────────────────────────────────────────────────

export const BUDGET_DEFAULTS = {
  max_claude_calls: 3,
  max_repair_rounds: 2,
} as const;

// ─── Mode defaults ───────────────────────────────────────────────────────────

type ModeDefaults = Pick<
  ExecutionPlan,
  "write_policy" | "claude_after" | "model_tier" | "reasoning_effort" | "session_mode" | "allow_takeover"
>;

export const MODE_DEFAULTS: Record<ExecutionPlan["mode"], ModeDefaults> = {
  implement: {
    write_policy: "workspace_write",
    claude_after: "judge_only",
    model_tier: "standard",
    reasoning_effort: "medium",
    session_mode: "stateless",
    allow_takeover: false,
  },
  review: {
    write_policy: "read_only",
    claude_after: "judge_only",
    model_tier: "mini",
    reasoning_effort: "low",
    session_mode: "stateless",
    allow_takeover: false,
  },
  adversarial_review: {
    write_policy: "read_only",
    claude_after: "judge_only",
    model_tier: "full",
    reasoning_effort: "high",
    session_mode: "stateless",
    allow_takeover: false,
  },
  debug: {
    write_policy: "workspace_write",
    claude_after: "judge_only",
    model_tier: "full",
    reasoning_effort: "high",
    session_mode: "stateful",
    allow_takeover: true,
  },
  test_generation: {
    write_policy: "workspace_write",
    claude_after: "judge_only",
    model_tier: "standard",
    reasoning_effort: "medium",
    session_mode: "stateless",
    allow_takeover: false,
  },
  ui_build: {
    write_policy: "workspace_write",
    claude_after: "ui_polish",
    model_tier: "full",
    reasoning_effort: "medium",
    session_mode: "stateful",
    allow_takeover: false,
  },
  ui_refine: {
    write_policy: "patch_only",
    claude_after: "ui_polish",
    model_tier: "full",
    reasoning_effort: "medium",
    session_mode: "stateless",
    allow_takeover: false,
  },
  architecture: {
    write_policy: "read_only",
    claude_after: "final_refine",
    model_tier: "full",
    reasoning_effort: "high",
    session_mode: "stateless",
    allow_takeover: true,
  },
};

// ─── Sandbox policy mapping ──────────────────────────────────────────────────

export function writePolicyToSandbox(
  policy: ExecutionPlan["write_policy"]
): "read-only" | "workspace-write" | "danger-full-access" {
  switch (policy) {
    case "read_only":
      return "read-only";
    case "workspace_write":
      return "workspace-write";
    case "patch_only":
      return "workspace-write";
  }
}
