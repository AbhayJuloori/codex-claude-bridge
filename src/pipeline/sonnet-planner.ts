import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import { planResultSchema, type PlanResult, type StepSpec } from "./types.js";
import { withRetry } from "./retry.js";

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
      "success_criteria": "use format: output contains 'X' where X is a string that must appear in Codex output"
    }
  ],
  "escalation_triggers": ["condition that should escalate back to Sonnet"]
}

Rules:
- Each step independently executable by Codex
- Prompts must be self-contained (no references to other steps)
- success_criteria MUST use format: output contains 'X'`;

export class SonnetPlanner {
  /** Counts calls where the subprocess actually responded (success or parse failure). */
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

    let raw: string;
    try {
      // Only increment AFTER a successful subprocess call.
      // A subprocess crash (rate limit, auth) does NOT count as a Sonnet touch —
      // the model never saw the task.
      raw = await withRetry(() =>
        this.claude.call(PLAN_PROMPT(task, compressedSpec), TIMEOUT_MS)
      );
    } catch (err) {
      // Subprocess failed after all retries. Propagate so caller can decide.
      throw err;
    }

    // Subprocess responded — count this invocation regardless of parse outcome.
    this._invocationCount++;
    return parsePlanResponse(raw, task);
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
    success_criteria: "output contains 'done'"
  };
  return { steps: [step], escalation_triggers: [] };
}
