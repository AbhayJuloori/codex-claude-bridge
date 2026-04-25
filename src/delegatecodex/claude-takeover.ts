import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import type { ExecutionPacket, ExecutionPlan, JudgmentVerdict } from "./types.js";

const TAKEOVER_TIMEOUT_MS = 120_000;

function buildTakeoverPrompt(task: string, plan: ExecutionPlan, packet: ExecutionPacket, verdict: JudgmentVerdict | undefined): string {
  const verdictContext = verdict?.takeover_reason
    ? `\nCodex attempted this task but was taken over because: ${verdict.takeover_reason}`
    : verdict?.repair_instructions
    ? `\nCodex repair attempts failed. Last repair instructions were:\n${verdict.repair_instructions}`
    : "";
  const priorWork = packet.files_changed.length > 0
    ? `\nCodex changed these files (review and fix as needed): ${packet.files_changed.join(", ")}`
    : "";
  return `${task}\n${verdictContext}\n${priorWork}\n\nSuccess criteria: ${plan.success_criteria}\n${plan.architecture_notes ? `Architecture constraints: ${plan.architecture_notes}` : ""}\n\nComplete this task to the highest standard.`;
}

export class ClaudeTakeover {
  constructor(private readonly claude: ClaudeSubprocessManager) {}

  async run(task: string, plan: ExecutionPlan, packet: ExecutionPacket, verdict: JudgmentVerdict | undefined): Promise<string> {
    const prompt = buildTakeoverPrompt(task, plan, packet, verdict);
    return this.claude.call(prompt, TAKEOVER_TIMEOUT_MS);
  }

  async *stream(task: string, plan: ExecutionPlan, packet: ExecutionPacket, verdict: JudgmentVerdict | undefined): AsyncGenerator<string> {
    const prompt = buildTakeoverPrompt(task, plan, packet, verdict);
    yield* this.claude.stream(prompt, undefined, TAKEOVER_TIMEOUT_MS);
  }
}
