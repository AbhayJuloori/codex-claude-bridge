import type { CodexAgent } from "./codex-agent.js";
import type { ClaudeJudge } from "./claude-judge.js";
import type { BudgetState, ExecutionPacket, ExecutionPlan, JudgmentVerdict } from "./types.js";

export interface RepairResult {
  status: "accepted" | "takeover_needed" | "needs_user_or_manual_review";
  packet: ExecutionPacket;
  verdict?: JudgmentVerdict;
}

export class RepairLoop {
  constructor(private readonly agent: CodexAgent, private readonly judge: ClaudeJudge) {}

  async run(
    task: string,
    plan: ExecutionPlan,
    lastPacket: ExecutionPacket,
    repairVerdict: JudgmentVerdict,
    sessionKey: string,
    plugins: string[],
    budget: BudgetState
  ): Promise<RepairResult> {
    const repairInstructions = repairVerdict.repair_instructions ?? "Fix the issues identified by the Judge.";
    let currentPacket = lastPacket;

    for (let round = 0; round < budget.max_repair_rounds; round++) {
      budget.repair_rounds_used++;
      currentPacket = await this.agent.run(task, plan, plugins, sessionKey, true, repairInstructions);
    }

    if (budget.claude_calls_used >= budget.max_claude_calls) {
      return { status: "needs_user_or_manual_review", packet: currentPacket, verdict: repairVerdict };
    }

    budget.claude_calls_used++;
    const finalVerdict = await this.judge.judge(task, plan, currentPacket);

    if (finalVerdict.verdict === "accept") {
      return { status: "accepted", packet: currentPacket, verdict: finalVerdict };
    }

    return { status: "takeover_needed", packet: currentPacket, verdict: finalVerdict };
  }
}
