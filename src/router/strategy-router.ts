import type { InternalTask } from "../types/internal.js";
import type { StrategyDecision } from "../orchestrator/types.js";
import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import {
  buildRoutingPrompt,
  parseRoutingDecision
} from "../claude/prompts.js";

function latestUserText(task: InternalTask): string {
  const reversed = [...task.messages].reverse();
  const latest = reversed.find((message) => message.role === "user");
  if (!latest) {
    return task.prompt;
  }

  if (typeof latest.content === "string") {
    return latest.content;
  }

  const text = latest.content
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();

  return text || task.prompt;
}

/**
 * Extremely conservative fast-path router.
 *
 * Returns a StrategyDecision ONLY when the task is unambiguously classifiable:
 *   1. ALL signals point to the same mode.
 *   2. ZERO conflicting signals exist.
 *   3. The pattern matches one of exactly three allowed fast-path cases.
 *
 * Returns null for everything else — caller must route via Claude.
 */
function routeTaskFastPath(task: InternalTask): StrategyDecision | null {
  const text = latestUserText(task).toLowerCase();

  const hasReview = /\breview\b|\bfindings\b|\bregression\b|\bcode review\b/.test(text);
  const hasAdversarial =
    /\badversarial\b|\btry to break\b|\bhidden risk\b|\bfailure mode\b|\bsecurity audit\b/.test(
      text
    );
  const hasJudgment =
    /\bmerge\b|\bno-merge\b|\bjudgment\b|\bshould we ship\b|\bprioritize findings\b/.test(text);
  const hasArchitecture =
    /\barchitecture\b|\btradeoff\b|\bproduct\b|\bstrategy\b|\broadmap\b|\bux\b|\bui\/ux\b|\bdesign\b|\bexplain\b|\bwhy\b|\bhow does\b/.test(
      text
    );
  const hasImplementation =
    /\bimplement\b|\bscaffold\b|\brefactor\b|\bedit\b|\bchange\b|\bwrite\b|\bcreate\b|\badd\b|\bfix\b|\bgenerate\b/.test(
      text
    );
  const hasRefinement =
    /\bpolish\b|\brefine\b|\bcleanup\b|\bdraft\b|\bfirst pass\b|\bthen improve\b/.test(text);

  // Fast-path 1: Pure adversarial review
  // ALL of: adversarial + review. NONE of: implementation, judgment, architecture.
  if (
    hasAdversarial &&
    hasReview &&
    !hasImplementation &&
    !hasJudgment &&
    !hasArchitecture
  ) {
    return {
      mode: "codex_adversarial_review",
      rationale: [
        "Fast-path: unambiguous adversarial review — all signals aligned, zero conflicts."
      ]
    };
  }

  // Fast-path 2: Pure code review
  // ONLY: review. NONE of: adversarial, implementation, judgment, architecture, refinement.
  if (
    hasReview &&
    !hasAdversarial &&
    !hasImplementation &&
    !hasJudgment &&
    !hasArchitecture &&
    !hasRefinement
  ) {
    return {
      mode: "codex_review",
      rationale: [
        "Fast-path: unambiguous code review — all signals aligned, zero conflicts."
      ]
    };
  }

  // Fast-path 3: Pure mechanical implementation
  // ONLY: implementation signals. NONE of: review, adversarial, judgment, architecture, refinement.
  // Also: prompt must be short (< 2000 chars) to rule out complex multi-part requests.
  if (
    hasImplementation &&
    !hasReview &&
    !hasAdversarial &&
    !hasJudgment &&
    !hasArchitecture &&
    !hasRefinement &&
    task.prompt.length < 2000
  ) {
    return {
      mode: "codex_delegate",
      rationale: [
        "Fast-path: unambiguous mechanical implementation — all signals aligned, zero conflicts."
      ]
    };
  }

  // Everything else is ambiguous — require Claude routing
  return null;
}

/**
 * Routes a task to an execution strategy.
 *
 * Fast-path is attempted first (extremely conservative — only 3 unambiguous patterns).
 * Any ambiguity routes through a real Claude subprocess call.
 * If Claude call fails, falls back to a conservative default that preserves quality.
 */
export async function routeTask(
  task: InternalTask,
  claude: ClaudeSubprocessManager | null
): Promise<StrategyDecision> {
  const fastPath = routeTaskFastPath(task);
  if (fastPath) {
    return fastPath;
  }

  if (claude) {
    try {
      const taskText = latestUserText(task);
      const prompt = buildRoutingPrompt(taskText);
      const response = await claude.call(prompt);
      const decision = parseRoutingDecision(response);

      if (decision) {
        return {
          mode: decision.mode,
          rationale: [`Claude routing: ${decision.rationale}`]
        };
      }

      return claudeFailureRoute(
        "Claude routing response could not be parsed — defaulting to claude_direct"
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return claudeFailureRoute(`Claude routing failed: ${message}`);
    }
  }

  return heuristicFallbackRoute(
    task,
    "No Claude subprocess available — using conservative heuristic fallback"
  );
}

/**
 * Conservative fallback used only when Claude routing is unavailable.
 */
function heuristicFallbackRoute(task: InternalTask, reason: string): StrategyDecision {
  const text = latestUserText(task).toLowerCase();
  const hasImplementation =
    /\bimplement\b|\bscaffold\b|\brefactor\b|\bedit\b|\bchange\b|\bwrite\b|\bcreate\b|\badd\b|\bfix\b/.test(
      text
    );

  if (hasImplementation) {
    return {
      mode: "codex_delegate",
      rationale: [`Fallback: implementation signals present. (${reason})`]
    };
  }

  return {
    mode: "claude_direct",
    rationale: [`Fallback: defaulting to claude_direct to preserve quality. (${reason})`]
  };
}

function claudeFailureRoute(reason: string): StrategyDecision {
  return {
    mode: "claude_direct",
    rationale: [`Fallback: defaulting to claude_direct after Claude routing failure. (${reason})`]
  };
}
