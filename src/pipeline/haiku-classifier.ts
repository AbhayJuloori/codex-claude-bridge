import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import { classificationResultSchema, type ClassificationResult } from "./types.js";

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

export class HaikuClassifier {
  constructor(private readonly claude: ClaudeSubprocessManager) {}

  async classify(task: string): Promise<ClassificationResult> {
    try {
      const raw = await this.claude.call(CLASSIFICATION_PROMPT(task), TIMEOUT_MS, HAIKU_MODEL);
      return parseResponse(raw);
    } catch {
      return ambiguousFallback();
    }
  }
}

function parseResponse(raw: string): ClassificationResult {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return ambiguousFallback();
  try {
    return classificationResultSchema.parse(JSON.parse(match[0]) as unknown);
  } catch {
    return ambiguousFallback();
  }
}

function ambiguousFallback(): ClassificationResult {
  return {
    task_type: "ambiguous",
    requires_plan: false,
    requires_sonnet: false,
    confidence: 0,
    compressed_spec: ""
  };
}
