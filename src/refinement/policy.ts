import type { ImplementationResultPacket } from "../orchestrator/types.js";
import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import {
  buildPacketJudgmentPrompt,
  parsePacketJudgment
} from "../claude/prompts.js";

export type RefinementVerdict = "accept" | "refine" | "patch" | "reroute" | "escalate";

export interface RefinementDecision {
  action: "accept_packet" | "run_refinement_pass" | "run_patch_pass" | "reroute" | "escalate";
  verdict: RefinementVerdict;
  rationale: string[];
  riskScore: number;
}

/**
 * Evaluates an implementation packet using real Claude judgment.
 * Falls back to heuristic if Claude subprocess is unavailable or fails.
 */
export async function decideRefinement(
  packet: ImplementationResultPacket,
  claude: ClaudeSubprocessManager | null
): Promise<RefinementDecision> {
  if (claude) {
    try {
      const prompt = buildPacketJudgmentPrompt(packet);
      const response = await claude.call(prompt);
      const judgment = parsePacketJudgment(response);

      if (judgment) {
        return verdictToDecision(judgment.verdict, judgment.rationale, judgment.risk_score, "claude");
      }
    } catch {
      // fall through to heuristic
    }
  }

  return heuristicRefinement(packet);
}

function verdictToDecision(
  verdict: RefinementVerdict,
  rationale: string,
  riskScore: number,
  source: "claude" | "heuristic"
): RefinementDecision {
  const prefix = source === "claude" ? "Claude judgment" : "Heuristic fallback";
  const rationaleLines = [`${prefix}: ${rationale}`];

  switch (verdict) {
    case "accept":
      return { action: "accept_packet", verdict, rationale: rationaleLines, riskScore };
    case "refine":
      return { action: "run_refinement_pass", verdict, rationale: rationaleLines, riskScore };
    case "patch":
      return { action: "run_patch_pass", verdict, rationale: rationaleLines, riskScore };
    case "reroute":
      return { action: "reroute", verdict, rationale: rationaleLines, riskScore };
    case "escalate":
      return { action: "escalate", verdict, rationale: rationaleLines, riskScore };
  }
}

/**
 * Heuristic fallback — only used when Claude subprocess is unavailable or fails.
 */
function heuristicRefinement(packet: ImplementationResultPacket): RefinementDecision {
  if (packet.status === "failed") {
    return verdictToDecision("refine", "Implementation reported failure.", 0.9, "heuristic");
  }

  if (packet.status === "partial") {
    return verdictToDecision("refine", "Implementation is partial.", 0.7, "heuristic");
  }

  if (packet.warnings.length > 0) {
    return verdictToDecision("refine", "Implementation has warnings.", 0.6, "heuristic");
  }

  if (packet.confidence !== null && packet.confidence < 0.75) {
    return verdictToDecision("refine", "Implementation confidence is low.", 0.6, "heuristic");
  }

  return verdictToDecision("accept", "Implementation looks complete.", 0.1, "heuristic");
}
