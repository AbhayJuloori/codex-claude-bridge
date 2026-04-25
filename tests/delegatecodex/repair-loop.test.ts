import { describe, expect, jest, test } from "@jest/globals";
import { RepairLoop } from "../../src/delegatecodex/repair-loop.js";
import type { CodexAgent } from "../../src/delegatecodex/codex-agent.js";
import type { ClaudeJudge } from "../../src/delegatecodex/claude-judge.js";
import type { ExecutionPacket, ExecutionPlan, JudgmentVerdict } from "../../src/delegatecodex/types.js";
import { BUDGET_DEFAULTS } from "../../src/delegatecodex/config.js";

const PLAN: ExecutionPlan = {
  brain: "codex_leads", mode: "implement", model_tier: "standard",
  reasoning_effort: "medium", plugins_hint: [], session_mode: "stateless",
  subagent_strategy: "auto", write_policy: "workspace_write",
  claude_after: "judge_only", success_criteria: "tests pass", allow_takeover: false,
};

const GOOD_PACKET: ExecutionPacket = {
  status: "completed", summary: "Fixed the bug", files_changed: ["src/foo.ts"],
  commands_run: ["npm test"], risks: [], unresolved_items: [], confidence: 0.9,
};

const ACCEPT: JudgmentVerdict = {
  verdict: "accept", score: 9,
  criteria: { plan_satisfied: true, architecture_preserved: true, tests_meaningful: true, implementation_clean: true, ui_needs_polish: false },
};

const REPAIR: JudgmentVerdict = {
  verdict: "repair", score: 4,
  criteria: { plan_satisfied: false, architecture_preserved: true, tests_meaningful: false, implementation_clean: true, ui_needs_polish: false },
  repair_instructions: "Add error handling to the catch block.",
};

function mockAgent(): CodexAgent {
  return { run: jest.fn<() => Promise<ExecutionPacket>>().mockResolvedValue(GOOD_PACKET) } as unknown as CodexAgent;
}

function mockJudge(verdict: JudgmentVerdict): ClaudeJudge {
  return { judge: jest.fn<() => Promise<JudgmentVerdict>>().mockResolvedValue(verdict) } as unknown as ClaudeJudge;
}

describe("RepairLoop", () => {
  test("returns accepted when judge says accept after repairs", async () => {
    const agent = mockAgent();
    const judge = mockJudge(ACCEPT);
    const loop = new RepairLoop(agent, judge);
    const budget = { ...BUDGET_DEFAULTS, claude_calls_used: 2, repair_rounds_used: 0 };
    const result = await loop.run("fix bug", PLAN, GOOD_PACKET, REPAIR, "k1", [], budget);
    expect(result.status).toBe("accepted");
    expect(budget.claude_calls_used).toBe(3);
  });

  test("returns needs_user_or_manual_review when budget exhausted", async () => {
    const agent = mockAgent();
    const judge = mockJudge(ACCEPT);
    const loop = new RepairLoop(agent, judge);
    const budget = { ...BUDGET_DEFAULTS, claude_calls_used: 3, repair_rounds_used: 0 };
    const result = await loop.run("fix bug", PLAN, GOOD_PACKET, REPAIR, "k1", [], budget);
    expect(result.status).toBe("needs_user_or_manual_review");
    expect(budget.claude_calls_used).toBe(3);
  });

  test("runs up to max_repair_rounds before calling judge", async () => {
    const agent = mockAgent();
    const judge = mockJudge(ACCEPT);
    const loop = new RepairLoop(agent, judge);
    const budget = { ...BUDGET_DEFAULTS, claude_calls_used: 2, repair_rounds_used: 0 };
    await loop.run("fix bug", PLAN, GOOD_PACKET, REPAIR, "k1", [], budget);
    expect((agent.run as jest.Mock).mock.calls).toHaveLength(2);
    expect((judge.judge as jest.Mock).mock.calls).toHaveLength(1);
  });
});
