import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import { withRetry } from "./retry.js";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const SOFT_TOKEN_LIMIT = 300;
const HARD_TOKEN_LIMIT = 1000;
const TIMEOUT_MS = 15_000;

export function estimateTokens(text: string): number {
  return Math.floor(text.length / 4);
}

export interface DistillResult {
  content: string;
  compressed: boolean;
  /** Set when compression was attempted but failed — content is raw truncation */
  compressionError?: string;
}

const COMPRESS_PROMPT = (content: string) =>
  `Summarize into bullet points. Preserve all file names, function names, error messages, and critical facts. Drop explanatory prose. Return ONLY the bullet points.

Content:
${content}`;

export class ContextDistiller {
  constructor(private readonly claude: ClaudeSubprocessManager) {}

  /**
   * Fix #5: Returns a DistillResult instead of throwing on hard-limit failure.
   * compressionError is set when Haiku subprocess fails — caller can include
   * this in pipeline metadata so the failure is visible rather than silent.
   *
   * Fix #7: Uses withRetry so transient rate limits don't cause immediate failure.
   */
  async distill(content: string): Promise<DistillResult> {
    const tokens = estimateTokens(content);

    if (tokens <= SOFT_TOKEN_LIMIT) {
      return { content, compressed: false };
    }

    try {
      const compressed = await withRetry(() =>
        this.claude.call(COMPRESS_PROMPT(content), TIMEOUT_MS, HAIKU_MODEL)
      );

      if (tokens > HARD_TOKEN_LIMIT && estimateTokens(compressed) > HARD_TOKEN_LIMIT) {
        // Compressed but still over limit — truncate with signal
        const truncated = compressed.slice(0, HARD_TOKEN_LIMIT * 4);
        return {
          content: truncated,
          compressed: true,
          compressionError: `Compressed output still exceeded ${HARD_TOKEN_LIMIT} tokens — truncated`
        };
      }

      return { content: compressed, compressed: true };
    } catch (err) {
      // Fix #5: Compression subprocess failed after retries.
      // Fall back to truncation but surface the error in the result.
      const message = err instanceof Error ? err.message : String(err);
      const truncated = content.slice(0, SOFT_TOKEN_LIMIT * 4); // ~300 tokens
      return {
        content: truncated,
        compressed: false,
        compressionError: `Haiku compression unavailable (${message}) — truncated to ${estimateTokens(truncated)} tokens`
      };
    }
  }
}
