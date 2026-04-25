import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import { withRetry } from "./retry.js";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const TIMEOUT_MS = 15_000;

const QUESTION_PATTERNS = [
  /could you clarify/i,
  /do you want/i,
  /should i/i,
  /\bwhich\b/i,
  /please confirm/i,
  /can you provide/i
];

export type ClarificationResult =
  | { type: "not_question" }
  | { type: "answered"; answer: string }
  | { type: "needs_user"; question: string };

const CLARIFICATION_PROMPT = (originalTask: string, codexOutput: string) =>
  `You are a task clarification assistant. A Codex agent was given a task and responded with a question instead of completing the work.

Original task:
<task>
${originalTask}
</task>

Codex response (contains a question):
<codex_response>
${codexOutput}
</codex_response>

Can you answer the question Codex is asking using only the information in the original task? If yes, provide the answer. If no (requires external knowledge, credentials, APIs, URLs, or business rules not in the task), say you cannot answer.

Respond with JSON only:
{"can_answer": true, "answer": "..."}
or
{"can_answer": false, "question": "...verbatim question from Codex..."}`;

export class HaikuClarifier {
  constructor(private readonly claude: ClaudeSubprocessManager) {}

  async clarify(originalTask: string, codexOutput: string): Promise<ClarificationResult> {
    if (!looksLikeQuestion(codexOutput)) {
      return { type: "not_question" };
    }

    try {
      const raw = await withRetry(() =>
        this.claude.call(CLARIFICATION_PROMPT(originalTask, codexOutput), TIMEOUT_MS, HAIKU_MODEL)
      );
      const parsed = parseClarificationResponse(raw);

      if (!parsed) {
        return { type: "not_question" };
      }

      return parsed.can_answer
        ? { type: "answered", answer: parsed.answer }
        : { type: "needs_user", question: parsed.question };
    } catch (err) {
      console.error("[HaikuClarifier] Haiku call failed, treating as not_question:", err);
      return { type: "not_question" };
    }
  }
}

interface ClarificationPayloadAnswer {
  can_answer: true;
  answer: string;
}

interface ClarificationPayloadQuestion {
  can_answer: false;
  question: string;
}

type ClarificationPayload = ClarificationPayloadAnswer | ClarificationPayloadQuestion;

function looksLikeQuestion(codexOutput: string): boolean {
  const trimmed = codexOutput.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.endsWith("?")) {
    return true;
  }

  return QUESTION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function parseClarificationResponse(raw: string): ClarificationPayload | null {
  const candidate = stripMarkdownFences(raw);
  const match = candidate.match(/\{[\s\S]*\}/);

  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[0]) as unknown;

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "can_answer" in parsed &&
      typeof parsed.can_answer === "boolean"
    ) {
      if (
        parsed.can_answer === true &&
        "answer" in parsed &&
        typeof parsed.answer === "string"
      ) {
        return { can_answer: true, answer: parsed.answer };
      }

      if (
        parsed.can_answer === false &&
        "question" in parsed &&
        typeof parsed.question === "string"
      ) {
        return { can_answer: false, question: parsed.question };
      }
    }
  } catch {
    return null;
  }

  return null;
}

function stripMarkdownFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}
