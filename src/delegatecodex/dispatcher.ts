import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import { executionPlanSchema, type ExecutionPlan } from "./types.js";
import { MODE_DEFAULTS } from "./config.js";

const DISPATCHER_MODEL = "claude-sonnet-4-6";
const DISPATCHER_TIMEOUT_MS = 45_000;

function buildPrompt(task: string): string {
  return `You are the Claude Dispatcher for a coding assistant pipeline.

Analyze this task and return ONLY a JSON object — no prose, no markdown fences.

Task: ${task}

The JSON must conform to this schema exactly:
{
  "brain": "codex_leads" | "claude_leads",
  "mode": "implement" | "review" | "adversarial_review" | "debug" | "test_generation" | "ui_build" | "ui_refine" | "architecture",
  "model_tier": "mini" | "standard" | "full" | "reasoning",
  "reasoning_effort": "low" | "medium" | "high" | "xhigh",
  "plugins_hint": string[],
  "session_mode": "stateless" | "stateful",
  "subagent_strategy": "sequential" | "parallel" | "auto",
  "write_policy": "read_only" | "workspace_write" | "patch_only",
  "claude_after": "none" | "judge_only" | "ui_polish" | "final_refine" | "takeover_if_needed",
  "success_criteria": string,
  "architecture_notes": string (optional),
  "allow_takeover": boolean
}

Rules:
- brain=claude_leads: architectural decisions, subtle multi-system debugging, design review needing taste
- brain=codex_leads: everything else — Codex handles with subagents and plugins
- model_tier: mini=rename/reformat, standard=single-feature, full=complex multi-file/UI, reasoning=deep debugging
- session_mode=stateful: multi-file refactors, ui_build, debug (needs context across repair rounds)
- plugins_hint: suggest from ["browser-use","build-web-apps","github","computer-use"] — Codex may extend
- write_policy=read_only for all review/architecture modes
- allow_takeover=true for debug and architecture modes
- success_criteria: concrete, verifiable (e.g. "npx tsc --noEmit exits 0 and npm test passes")`;
}

function stripFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

export class Dispatcher {
  constructor(private readonly claude: ClaudeSubprocessManager) {}

  async dispatch(task: string): Promise<ExecutionPlan> {
    const raw = await this.claude.call(
      buildPrompt(task),
      DISPATCHER_TIMEOUT_MS,
      DISPATCHER_MODEL
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFences(raw));
    } catch {
      throw new Error(`Dispatcher failed to parse Claude response: ${raw.slice(0, 200)}`);
    }

    const result = executionPlanSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Dispatcher schema validation failed: ${result.error.message}`
      );
    }

    // Fill in mode defaults for any fields the dispatcher may have omitted
    const defaults = MODE_DEFAULTS[result.data.mode];
    return {
      ...defaults,
      ...result.data,
    };
  }
}
