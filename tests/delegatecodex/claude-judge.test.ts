import { describe, expect, jest, test } from "@jest/globals";
import { ClaudeJudge } from "../../src/delegatecodex/claude-judge.js";
import type { ClaudeSubprocessManager } from "../../src/claude/subprocess.js";
import type { ExecutionPlan, ExecutionPacket } from "../../src/delegatecodex/types.js";

function mockClaude(response: string): ClaudeSubprocessManager {
  return {
    call: jest.fn<() => Promise<string>>().mockResolvedValue(response),
    stream: jest.fn(),
  } as unknown as ClaudeSubprocessManager;
}

const PLAN: ExecutionPlan = {
  brain: "codex_leads", mode: "implement", model_tier: "standard",
  reasoning_effort: "medium", plugins_hint: [], session_mode: "stateless",
  subagent_strategy: "auto", write_policy: "workspace_write",
  claude_after: "judge_only", success_criteria: "npx tsc --noEmit exits 0",
  allow_takeover: false,
};

const GOOD_PACKET: ExecutionPacket = {
  status: "completed", summary: "Added input validation to POST /users",
  files_changed: ["src/routes/users.ts"], commands_run: ["npx tsc --noEmit", "npm test"],
  tests_run: { passed: 5, failed: 0, skipped: 0 }, diff_summary: "+12 lines in users.ts",
  risks: [], unresolved_items: [], confidence: 0.95,
};

const ACCEPT_VERDICT = JSON.stringify({
  verdict: "accept", score: 9,
  criteria: { plan_satisfied: true, architecture_preserved: true, tests_meaningful: true, implementation_clean: true, ui_needs_polish: false },
});

const REPAIR_VERDICT = JSON.stringify({
  verdict: "repair", score: 4,
  criteria: { plan_satisfied: false, architecture_preserved: true, tests_meaningful: false, implementation_clean: true, ui_needs_polish: false },
  repair_instructions: "The success_criteria requires tsc to pass. Run npx tsc --noEmit and fix any type errors.",
});

describe("ClaudeJudge", () => {
  test("returns accept verdict", async () => {
    const judge = new ClaudeJudge(mockClaude(ACCEPT_VERDICT));
    const verdict = await judge.judge("Add validation", PLAN, GOOD_PACKET);
    expect(verdict.verdict).toBe("accept");
    expect(verdict.score).toBe(9);
    expect(verdict.criteria.plan_satisfied).toBe(true);
  });

  test("returns repair verdict with instructions", async () => {
    const judge = new ClaudeJudge(mockClaude(REPAIR_VERDICT));
    const verdict = await judge.judge("Add validation", PLAN, GOOD_PACKET);
    expect(verdict.verdict).toBe("repair");
    expect(verdict.repair_instructions).toContain("tsc");
  });

  test("strips markdown fences before parsing", async () => {
    const fenced = "```json\n" + ACCEPT_VERDICT + "\n```";
    const judge = new ClaudeJudge(mockClaude(fenced));
    const verdict = await judge.judge("task", PLAN, GOOD_PACKET);
    expect(verdict.verdict).toBe("accept");
  });

  test("throws if response is not valid JSON", async () => {
    const judge = new ClaudeJudge(mockClaude("I cannot evaluate this."));
    await expect(judge.judge("task", PLAN, GOOD_PACKET)).rejects.toThrow(/parse/i);
  });
});
