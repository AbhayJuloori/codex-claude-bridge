import { describe, expect, test } from "@jest/globals";
import {
  executionPlanSchema,
  executionPacketSchema,
  judgmentVerdictSchema,
} from "../../src/delegatecodex/types.js";

describe("executionPlanSchema", () => {
  test("accepts valid plan", () => {
    const result = executionPlanSchema.safeParse({
      brain: "codex_leads",
      mode: "implement",
      model_tier: "standard",
      reasoning_effort: "medium",
      plugins_hint: ["github"],
      session_mode: "stateless",
      subagent_strategy: "auto",
      write_policy: "workspace_write",
      claude_after: "judge_only",
      success_criteria: "tests pass",
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown brain value", () => {
    const result = executionPlanSchema.safeParse({
      brain: "alien_leads",
      mode: "implement",
      model_tier: "standard",
      reasoning_effort: "medium",
      plugins_hint: [],
      session_mode: "stateless",
      write_policy: "workspace_write",
      claude_after: "judge_only",
      success_criteria: "ok",
    });
    expect(result.success).toBe(false);
  });

  test("defaults subagent_strategy to auto when omitted", () => {
    const result = executionPlanSchema.safeParse({
      brain: "codex_leads",
      mode: "review",
      model_tier: "mini",
      reasoning_effort: "low",
      plugins_hint: [],
      session_mode: "stateless",
      write_policy: "read_only",
      claude_after: "judge_only",
      success_criteria: "review complete",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subagent_strategy).toBe("auto");
    }
  });
});

describe("executionPacketSchema", () => {
  test("accepts valid packet", () => {
    const result = executionPacketSchema.safeParse({
      status: "completed",
      summary: "Renamed function",
      files_changed: ["src/foo.ts"],
      commands_run: ["npm test"],
      risks: [],
      unresolved_items: [],
      confidence: 0.95,
    });
    expect(result.success).toBe(true);
  });

  test("rejects confidence > 1", () => {
    const result = executionPacketSchema.safeParse({
      status: "completed",
      summary: "Done",
      files_changed: [],
      commands_run: [],
      risks: [],
      unresolved_items: [],
      confidence: 1.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("judgmentVerdictSchema", () => {
  test("accepts accept verdict", () => {
    const result = judgmentVerdictSchema.safeParse({
      verdict: "accept",
      score: 9,
      criteria: {
        plan_satisfied: true,
        architecture_preserved: true,
        tests_meaningful: true,
        implementation_clean: true,
        ui_needs_polish: false,
      },
    });
    expect(result.success).toBe(true);
  });

  test("accepts repair verdict with instructions", () => {
    const result = judgmentVerdictSchema.safeParse({
      verdict: "repair",
      score: 4,
      criteria: {
        plan_satisfied: false,
        architecture_preserved: true,
        tests_meaningful: false,
        implementation_clean: true,
        ui_needs_polish: false,
      },
      repair_instructions: "Add missing error handling to src/foo.ts",
    });
    expect(result.success).toBe(true);
  });
});
