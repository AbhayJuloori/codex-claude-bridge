import type { InternalTask } from "../types/internal.js";
import type { ExecutionStrategyMode } from "../orchestrator/types.js";

const VALID_MODES = [
  "claude_direct",
  "codex_delegate",
  "codex_then_claude_refine",
  "codex_review",
  "codex_adversarial_review",
  "codex_review_then_claude_judgment"
] as const;

export const VALID_ROUTING_MODES: readonly string[] = VALID_MODES;

export interface RoutingDecision {
  mode: ExecutionStrategyMode;
  rationale: string;
}

export interface PacketJudgment {
  verdict: "accept" | "refine" | "patch" | "reroute" | "escalate";
  rationale: string;
  risk_score: number;
}

/**
 * Tiny structured routing prompt. Asks Claude to classify the task into one of
 * the six execution modes and return a single JSON object.
 * Kept under 200 words to minimize token cost and latency.
 */
export function buildRoutingPrompt(taskText: string): string {
  return `You are a task router for a Claude-manager/Codex-worker system. Classify this task into exactly one execution mode.

Modes:
- claude_direct: architecture decisions, product strategy, UX judgment, open-ended explanation, anything requiring real reasoning without mechanical implementation
- codex_delegate: mechanical implementation, boilerplate, CRUD, scaffolding, straightforward edits, pure code generation
- codex_then_claude_refine: implementation that is complex enough to benefit from a quality review pass afterward
- codex_review: code review, regression check, findings summary
- codex_adversarial_review: adversarial or security-focused review, failure mode analysis, "try to break this"
- codex_review_then_claude_judgment: review that also needs a ship/no-ship or prioritization decision

Task:
${taskText.slice(0, 1200)}

Respond with JSON only, no other text:
{"mode": "<one of the six modes above>", "rationale": "<one sentence>"}`;
}

/**
 * Judges an implementation packet. Returns a verdict on what the manager should do next.
 */
export function buildPacketJudgmentPrompt(packet: unknown): string {
  const packetJson = JSON.stringify(packet, null, 2);
  return `You are a quality judge in a Claude-manager/Codex-worker system. A Codex worker has returned this implementation packet.

Decide what the manager should do next:
- accept: packet is complete, confident, no unresolved issues — return to user
- refine: packet is mostly complete but has rough edges, warnings, or low confidence — run a Codex refinement pass
- patch: packet has specific small fixable issues — run a targeted Codex patch
- reroute: wrong approach was taken — redirect to a different execution mode
- escalate: too complex or judgment-heavy for Codex — Claude should handle the final response directly

Packet:
${packetJson.slice(0, 2000)}

Respond with JSON only, no other text:
{"verdict": "<accept|refine|patch|reroute|escalate>", "rationale": "<one sentence>", "risk_score": <0.0-1.0>}`;
}

/**
 * Judges a review packet. Returns a verdict on what the manager should do next.
 */
export function buildReviewJudgmentPrompt(packet: unknown): string {
  const packetJson = JSON.stringify(packet, null, 2);
  return `You are a quality judge in a Claude-manager/Codex-worker system. A Codex reviewer has returned this review packet.

Decide the final judgment:
- accept: findings are complete, actionable, and well-prioritized — return to user
- refine: findings need deeper investigation or better prioritization — run another review pass
- reroute: this needs adversarial review instead of standard review
- escalate: findings require real reasoning to interpret — Claude should produce the final judgment

Packet:
${packetJson.slice(0, 2000)}

Respond with JSON only, no other text:
{"verdict": "<accept|refine|reroute|escalate>", "rationale": "<one sentence>", "risk_score": <0.0-1.0>}`;
}

/**
 * Flattens a task into a single Claude prompt for claude_direct full-response mode.
 * Includes system context and the last few turns of conversation.
 */
export function buildDirectResponsePrompt(task: InternalTask): string {
  const parts: string[] = [];

  if (task.systemPrompt) {
    parts.push(`System context:\n${task.systemPrompt.slice(0, 2000)}`);
  }

  // Include last 6 messages for context (3 turns)
  const recentMessages = task.messages.slice(-6);
  if (recentMessages.length > 0) {
    parts.push("Conversation:");
    for (const message of recentMessages) {
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
              .filter(Boolean)
              .join("\n");
      parts.push(`${message.role === "user" ? "User" : "Assistant"}: ${content.slice(0, 3000)}`);
    }
  } else {
    parts.push(`Task:\n${task.prompt.slice(0, 4000)}`);
  }

  return parts.join("\n\n");
}

/**
 * Parses a JSON routing decision from Claude's response.
 * Falls back to regex extraction if the response has extra whitespace or markdown.
 */
export function parseRoutingDecision(response: string): RoutingDecision | null {
  const cleaned = response.trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const mode = parsed.mode;
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "Claude routing decision";

    if (typeof mode !== "string" || !VALID_ROUTING_MODES.includes(mode)) {
      return null;
    }

    return {
      mode: mode as ExecutionStrategyMode,
      rationale
    };
  } catch {
    return null;
  }
}

/**
 * Parses a JSON packet judgment from Claude's response.
 */
export function parsePacketJudgment(response: string): PacketJudgment | null {
  const cleaned = response.trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const verdict = parsed.verdict;
    const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "Claude judgment";
    const risk_score = typeof parsed.risk_score === "number" ? parsed.risk_score : 0.5;

    const validVerdicts = ["accept", "refine", "patch", "reroute", "escalate"];
    if (typeof verdict !== "string" || !validVerdicts.includes(verdict)) {
      return null;
    }

    return {
      verdict: verdict as PacketJudgment["verdict"],
      rationale,
      risk_score
    };
  } catch {
    return null;
  }
}
