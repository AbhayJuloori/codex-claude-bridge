import type { ClaudeSubprocessManager } from "../claude/subprocess.js";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const SOFT_TOKEN_LIMIT = 300;
const HARD_TOKEN_LIMIT = 1000;
const TIMEOUT_MS = 15_000;

export function estimateTokens(text: string): number {
  return Math.floor(text.length / 4);
}

const COMPRESS_PROMPT = (content: string) =>
  `Summarize into bullet points. Preserve all file names, function names, error messages, and critical facts. Drop explanatory prose. Return ONLY the bullet points.

Content:
${content}`;

export class ContextDistiller {
  constructor(private readonly claude: ClaudeSubprocessManager) {}

  /**
   * Returns content within token budget.
   * Under SOFT_TOKEN_LIMIT: pass-through.
   * Between SOFT and HARD: compress via Haiku.
   * Over HARD: compress, then enforce or throw.
   */
  async distill(content: string): Promise<string> {
    const tokens = estimateTokens(content);
    if (tokens <= SOFT_TOKEN_LIMIT) return content;

    const compressed = await this.compress(content);

    if (tokens > HARD_TOKEN_LIMIT && estimateTokens(compressed) > HARD_TOKEN_LIMIT) {
      throw new Error(
        `Context exceeds hard token limit (${estimateTokens(compressed)} > ${HARD_TOKEN_LIMIT} after compression)`
      );
    }

    return compressed;
  }

  private async compress(content: string): Promise<string> {
    return this.claude.call(COMPRESS_PROMPT(content), TIMEOUT_MS, HAIKU_MODEL);
  }
}
