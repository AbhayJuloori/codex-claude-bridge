import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import { classificationResultSchema, type ClassificationResult } from "./types.js";
import { withRetry } from "./retry.js";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const TIMEOUT_MS = 15_000;

const CLASSIFICATION_PROMPT = (task: string) =>
  `Classify this task for routing. Return ONLY a JSON object, no prose.

Task: ${task}

JSON schema:
{
  "task_type": "mechanical" | "multi_step" | "judgment" | "ambiguous",
  "requires_plan": boolean,
  "requires_sonnet": boolean,
  "confidence": number (0-1),
  "compressed_spec": string (≤200 chars, essential info only),
  "ambiguity_question": string (only if task_type is "ambiguous")
}

Rules:
- mechanical: single-file, deterministic, no semantic change (rename, reformat, move)
- multi_step: cross-file, sequential dependencies, or behavioral changes
- judgment: architecture, UI/UX, tradeoffs, design decisions
- ambiguous: cannot classify without more info
- requires_plan: true for multi_step and judgment
- requires_sonnet: true for judgment and multi_step, false for mechanical
- confidence: below 0.75 → set task_type to ambiguous`;

/**
 * Thrown when Haiku subprocess fails after all retries.
 * Distinct from returning task_type:"ambiguous" — that means the model
 * genuinely could not classify the task. This means the system failed.
 */
export class HaikuClassifierError extends Error {
  constructor(cause: unknown) {
    super(`Haiku classifier unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "HaikuClassifierError";
  }
}

export class HaikuClassifier {
  constructor(private readonly claude: ClaudeSubprocessManager) {}

  /**
   * Classify a task. Returns a ClassificationResult with task_type:"ambiguous"
   * only when the model genuinely cannot classify. Throws HaikuClassifierError
   * on subprocess failure (rate limit, auth, timeout) after retries.
   */
  async classify(task: string): Promise<ClassificationResult> {
    let raw: string;
    try {
      raw = await withRetry(() =>
        this.claude.call(CLASSIFICATION_PROMPT(task), TIMEOUT_MS, HAIKU_MODEL)
      );
    } catch (err) {
      throw new HaikuClassifierError(err);
    }

    return parseResponse(raw);
  }
}

function parseResponse(raw: string): ClassificationResult {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    // Model returned something unparseable — treat as genuine ambiguity
    return modelAmbiguousFallback();
  }
  try {
    return classificationResultSchema.parse(JSON.parse(match[0]) as unknown);
  } catch {
    return modelAmbiguousFallback();
  }
}

/** Used when the model responds but its output can't be parsed. */
function modelAmbiguousFallback(): ClassificationResult {
  return {
    task_type: "ambiguous",
    requires_plan: false,
    requires_sonnet: false,
    confidence: 0,
    compressed_spec: "",
    ambiguity_question: "Could not determine task type — please rephrase."
  };
}
