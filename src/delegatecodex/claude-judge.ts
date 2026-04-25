import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import { judgmentVerdictSchema, type ExecutionPacket, type ExecutionPlan, type JudgmentVerdict } from "./types.js";

const JUDGE_MODEL = "claude-sonnet-4-6";
const JUDGE_TIMEOUT_MS = 45_000;

function stripFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

function buildJudgePrompt(task: string, plan: ExecutionPlan, packet: ExecutionPacket, diffOutput?: string): string {
  return `You are Claude Judge. Evaluate whether Codex completed this task correctly.
Return ONLY a JSON object — no prose, no markdown fences.

## Original Task
${task}

## Execution Plan
Mode: ${plan.mode}
Success Criteria: ${plan.success_criteria}
${plan.architecture_notes ? `Architecture Constraints: ${plan.architecture_notes}` : ""}

## Execution Packet
Status: ${packet.status}
Summary: ${packet.summary}
Files changed: ${packet.files_changed.join(", ") || "none"}
Commands run: ${packet.commands_run.join(", ") || "none"}
${packet.tests_run ? `Tests: ${packet.tests_run.passed} passed, ${packet.tests_run.failed} failed, ${packet.tests_run.skipped} skipped` : "Tests: not run"}
${packet.diff_summary ? `Diff summary: ${packet.diff_summary}` : ""}
Risks flagged: ${packet.risks.join("; ") || "none"}
Unresolved items: ${packet.unresolved_items.join("; ") || "none"}
Codex confidence: ${packet.confidence}
${diffOutput ? `\n## Diff Output\n${diffOutput.slice(0, 2000)}` : ""}

## Judgment Criteria
1. plan_satisfied: Did Codex fully satisfy the success_criteria?
2. architecture_preserved: Were architecture constraints respected?
3. tests_meaningful: Are tests real (not trivially passing, not missing critical coverage)?
4. implementation_clean: Is the code clean, no shortcuts, no dead code, matches codebase style?
5. ui_needs_polish: Does UI output need Claude-level polish (only true for ui_build/ui_refine)?

## Verdict Rules
- accept: all critical criteria met, score >= 7
- repair: fixable gaps exist — provide specific repair_instructions Codex can act on
- takeover: fundamental misunderstanding, architectural violation, or score < 3

Return this JSON schema:
{
  "verdict": "accept" | "repair" | "takeover",
  "score": number (1-10),
  "criteria": { "plan_satisfied": boolean, "architecture_preserved": boolean, "tests_meaningful": boolean, "implementation_clean": boolean, "ui_needs_polish": boolean },
  "repair_instructions": string (required if verdict=repair),
  "takeover_reason": string (required if verdict=takeover),
  "polish_notes": string (optional)
}`;
}

export class ClaudeJudge {
  constructor(private readonly claude: ClaudeSubprocessManager) {}

  async judge(task: string, plan: ExecutionPlan, packet: ExecutionPacket, diffOutput?: string): Promise<JudgmentVerdict> {
    const raw = await this.claude.call(buildJudgePrompt(task, plan, packet, diffOutput), JUDGE_TIMEOUT_MS, JUDGE_MODEL);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFences(raw));
    } catch {
      throw new Error(`ClaudeJudge failed to parse response: ${raw.slice(0, 200)}`);
    }
    const result = judgmentVerdictSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`ClaudeJudge schema validation failed: ${result.error.message}`);
    }
    return result.data;
  }
}
