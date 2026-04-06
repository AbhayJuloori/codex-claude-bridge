import type { JudgmentPacket, ReviewResultPacket } from "../orchestrator/types.js";
import { buildJudgmentPacket } from "../orchestrator/packets.js";
import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import {
  buildReviewJudgmentPrompt,
  parsePacketJudgment
} from "../claude/prompts.js";

export type JudgmentVerdict = "accept" | "refine" | "reroute" | "escalate";

export interface JudgmentDecision {
  action: "claude_judgment" | "heuristic_judgment";
  verdict: JudgmentVerdict;
  rationale: string[];
  riskScore: number;
  packet: JudgmentPacket;
}

/**
 * Judges a review packet using real Claude judgment.
 * Falls back to heuristic severity-sort if Claude subprocess is unavailable or fails.
 */
export async function decideJudgment(
  packet: ReviewResultPacket,
  claude: ClaudeSubprocessManager | null
): Promise<JudgmentDecision> {
  const heuristicPacket = buildJudgmentPacket(packet);

  if (claude) {
    try {
      const prompt = buildReviewJudgmentPrompt(packet);
      const response = await claude.call(prompt);
      const judgment = parsePacketJudgment(response);

      if (judgment) {
        const verdict = judgment.verdict as JudgmentVerdict;
        return {
          action: "claude_judgment",
          verdict,
          rationale: [`Claude judgment: ${judgment.rationale}`],
          riskScore: judgment.risk_score,
          packet: heuristicPacket
        };
      }
    } catch {
      // fall through to heuristic
    }
  }

  // Heuristic fallback: severity-sort and count
  const severeCount = packet.findings.filter(
    (finding) => finding.severity === "critical" || finding.severity === "high"
  ).length;

  const verdict: JudgmentVerdict =
    severeCount > 0 ? "accept" : packet.findings.length > 0 ? "accept" : "accept";

  return {
    action: "heuristic_judgment",
    verdict,
    rationale: [
      "Heuristic fallback: Claude subprocess unavailable.",
      "Using bridge-side severity prioritization."
    ],
    riskScore: severeCount > 0 ? 0.8 : packet.findings.length > 0 ? 0.4 : 0.1,
    packet: heuristicPacket
  };
}
