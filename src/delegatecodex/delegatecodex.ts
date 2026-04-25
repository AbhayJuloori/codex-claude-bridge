import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import { BUDGET_DEFAULTS } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { getPluginHints } from "./plugin-router.js";
import { SessionManager } from "./session-manager.js";
import { CodexAgent } from "./codex-agent.js";
import { ClaudeJudge } from "./claude-judge.js";
import { RepairLoop } from "./repair-loop.js";
import { ClaudeTakeover } from "./claude-takeover.js";
import type { BudgetState, DelegatecodexResult, ExecutionPlan } from "./types.js";

const sessionManager = new SessionManager();
setInterval(() => sessionManager.purgeExpired(), 5 * 60 * 1000);

export type ProgressEvent =
  | { type: "dispatched"; plan: ExecutionPlan }
  | { type: "codex_running"; model_tier: string; mode: string }
  | { type: "judging"; call_number: number }
  | { type: "repairing"; round: number; max_rounds: number }
  | { type: "takeover"; reason: string }
  | { type: "complete"; status: DelegatecodexResult["status"] };

export interface DelegatecodexOptions {
  onProgress?: (event: ProgressEvent) => void;
}

export async function runDelegatecodex(
  task: string,
  config: BridgeConfig,
  logger: Logger,
  claude: ClaudeSubprocessManager,
  options: DelegatecodexOptions = {}
): Promise<DelegatecodexResult> {
  const { onProgress } = options;
  const emit = (event: ProgressEvent) => onProgress?.(event);

  const budget: BudgetState = {
    max_claude_calls: BUDGET_DEFAULTS.max_claude_calls,
    max_repair_rounds: BUDGET_DEFAULTS.max_repair_rounds,
    claude_calls_used: 0,
    repair_rounds_used: 0,
  };

  // Call 1: Dispatcher
  const dispatcher = new Dispatcher(claude);
  budget.claude_calls_used++;
  const plan = await dispatcher.dispatch(task);
  emit({ type: "dispatched", plan });
  logger.info("delegatecodex", "plan dispatched", { brain: plan.brain, mode: plan.mode, model_tier: plan.model_tier });

  // claude_leads: hand off directly
  if (plan.brain === "claude_leads") {
    const takeover = new ClaudeTakeover(claude);
    const emptyPacket = { status: "completed" as const, summary: "Claude handled directly", files_changed: [], commands_run: [], risks: [], unresolved_items: [], confidence: 1 };
    const output = await takeover.run(task, plan, emptyPacket, undefined);
    emit({ type: "complete", status: "takeover_complete" });
    return { status: "takeover_complete", output, plan, packet: emptyPacket, budget_used: budget };
  }

  // codex_leads
  const plugins = getPluginHints(plan, task);
  const sessionKey = SessionManager.makeKey(`task-${Date.now()}`, task.slice(0, 40));
  const agent = new CodexAgent(config, logger, sessionManager);
  emit({ type: "codex_running", model_tier: plan.model_tier, mode: plan.mode });
  const packet = await agent.run(task, plan, plugins, sessionKey);

  // No judgment
  if (plan.claude_after === "none") {
    emit({ type: "complete", status: "accepted" });
    return { status: "accepted", output: packet.summary, plan, packet, budget_used: budget };
  }

  // Call 2: Judge
  budget.claude_calls_used++;
  emit({ type: "judging", call_number: 2 });
  const judge = new ClaudeJudge(claude);
  const verdict = await judge.judge(task, plan, packet);
  logger.info("delegatecodex", "judgment complete", { verdict: verdict.verdict, score: verdict.score });

  if (verdict.verdict === "accept") {
    let output = packet.summary;
    if (verdict.polish_notes && (plan.claude_after === "ui_polish" || plan.claude_after === "final_refine")) {
      if (budget.claude_calls_used < budget.max_claude_calls) {
        budget.claude_calls_used++;
        const takeover = new ClaudeTakeover(claude);
        output = await takeover.run(task, plan, packet, verdict);
      }
    }
    emit({ type: "complete", status: "accepted" });
    return { status: "accepted", output, plan, packet, verdict, budget_used: budget };
  }

  if (verdict.verdict === "takeover") {
    const canTakeover = plan.allow_takeover && budget.claude_calls_used < budget.max_claude_calls;
    if (!canTakeover) {
      emit({ type: "complete", status: "needs_user_or_manual_review" });
      return { status: "needs_user_or_manual_review", output: `Task needs manual review.\nJudge score: ${verdict.score}/10\nReason: ${verdict.takeover_reason ?? "see verdict"}`, plan, packet, verdict, budget_used: budget };
    }
    emit({ type: "takeover", reason: verdict.takeover_reason ?? "judge requested takeover" });
    if (budget.claude_calls_used < budget.max_claude_calls) budget.claude_calls_used++;
    const takeover = new ClaudeTakeover(claude);
    const output = await takeover.run(task, plan, packet, verdict);
    emit({ type: "complete", status: "takeover_complete" });
    return { status: "takeover_complete", output, plan, packet, verdict, budget_used: budget };
  }

  // repair
  emit({ type: "repairing", round: 1, max_rounds: budget.max_repair_rounds });
  const repairLoop = new RepairLoop(agent, judge);
  const repairResult = await repairLoop.run(task, plan, packet, verdict, sessionKey, plugins, budget);

  if (repairResult.status === "accepted") {
    emit({ type: "complete", status: "accepted" });
    return { status: "accepted", output: repairResult.packet.summary, plan, packet: repairResult.packet, verdict: repairResult.verdict, budget_used: budget };
  }

  if (repairResult.status === "needs_user_or_manual_review") {
    emit({ type: "complete", status: "needs_user_or_manual_review" });
    return { status: "needs_user_or_manual_review", output: `Budget exhausted. Latest Codex output:\n${repairResult.packet.summary}\n\nLast judge feedback:\n${repairResult.verdict?.repair_instructions ?? "none"}`, plan, packet: repairResult.packet, verdict: repairResult.verdict, budget_used: budget };
  }

  // takeover after repair
  const canTakeover = budget.claude_calls_used < budget.max_claude_calls || plan.allow_takeover;
  if (!canTakeover) {
    emit({ type: "complete", status: "needs_user_or_manual_review" });
    return { status: "needs_user_or_manual_review", output: `Repair failed and budget exhausted.\nLatest: ${repairResult.packet.summary}`, plan, packet: repairResult.packet, verdict: repairResult.verdict, budget_used: budget };
  }

  emit({ type: "takeover", reason: repairResult.verdict?.takeover_reason ?? "repair failed" });
  if (budget.claude_calls_used < budget.max_claude_calls) budget.claude_calls_used++;
  const finalTakeover = new ClaudeTakeover(claude);
  const output = await finalTakeover.run(task, plan, repairResult.packet, repairResult.verdict);
  emit({ type: "complete", status: "takeover_complete" });
  return { status: "takeover_complete", output, plan, packet: repairResult.packet, verdict: repairResult.verdict, budget_used: budget };
}
