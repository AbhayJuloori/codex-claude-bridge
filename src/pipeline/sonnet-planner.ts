import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import { planResultSchema, type PlanResult, type StepSpec } from "./types.js";

const MAX_INVOCATIONS = 2;
const TIMEOUT_MS = 45_000;

const PLAN_PROMPT = (task: string, compressedSpec?: string) =>
  `You are a task planner. Decompose this task into atomic sequential steps for a Codex executor.

Task: ${task}
${compressedSpec ? `\nCompressed context:\n${compressedSpec}` : ""}

Return ONLY a JSON object — no prose, no markdown:
{
  "steps": [
    {
      "id": "step-N",
      "description": "one-line description",
      "prompt": "exact self-contained prompt for Codex",
      "success_criteria": "deterministic check: what must be true when this step passes"
    }
  ],
  "escalation_triggers": ["condition that should escalate back to Sonnet"]
}

Rules:
- Each step independently executable by Codex
- Prompts must be self-contained (no references to other steps)
- success_criteria checkable without running code`;

export class SonnetPlanner {
  private _invocationCount = 0;

  constructor(private readonly claude: ClaudeSubprocessManager) {}

  get invocationCount(): number {
    return this._invocationCount;
  }

  async plan(task: string, compressedSpec?: string): Promise<PlanResult> {
    if (this._invocationCount >= MAX_INVOCATIONS) {
      throw new Error(
        `SonnetPlanner invocation limit exceeded (max ${MAX_INVOCATIONS}). ` +
          `Controller must not call plan() more than twice per task.`
      );
    }

    this._invocationCount++;

    try {
      const raw = await this.claude.call(PLAN_PROMPT(task, compressedSpec), TIMEOUT_MS);
      return parsePlanResponse(raw, task);
    } catch (err) {
      if (err instanceof Error && err.message.includes("invocation limit")) throw err;
      return singleStepFallback(task, compressedSpec);
    }
  }
}

function parsePlanResponse(raw: string, task: string): PlanResult {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return singleStepFallback(task);
  try {
    return planResultSchema.parse(JSON.parse(match[0]) as unknown);
  } catch {
    return singleStepFallback(task);
  }
}

function singleStepFallback(task: string, compressedSpec?: string): PlanResult {
  const step: StepSpec = {
    id: "step-fallback",
    description: "execute task as single step",
    prompt: compressedSpec ?? task,
    success_criteria: "Codex produces non-empty output without error"
  };
  return { steps: [step], escalation_triggers: [] };
}
