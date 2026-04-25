import type { ClaudeSubprocessManager } from "../claude/subprocess.js";
import type { StepSpec } from "./types.js";
import { withRetry } from "./retry.js";

const SONNET_MODEL = "claude-sonnet-4-6";
const TIMEOUT_MS = 60_000;

export interface SonnetTakeoverResult {
  output: string;
  succeeded: boolean;
}

export class SonnetTakeover {
  constructor(private readonly claude: ClaudeSubprocessManager) {}

  async execute(
    step: StepSpec,
    taskContext: string,
    priorOutputs: string[]
  ): Promise<SonnetTakeoverResult> {
    const prior = priorOutputs.length
      ? `Prior outputs:\n${priorOutputs.slice(-2).join("\n\n---\n\n")}\n\n`
      : "";
    const prompt =
      `You are taking over a step that Codex failed after retries.\n\n` +
      `Task context: ${taskContext}\n\n` +
      `${prior}` +
      `Step: ${step.description}\n` +
      `Prompt: ${step.prompt}\n\n` +
      `Execute this step directly. Return the implementation result.`;
    try {
      const output = await withRetry(() =>
        this.claude.call(prompt, TIMEOUT_MS, SONNET_MODEL)
      );
      return { output, succeeded: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Sonnet takeover failed: ${message}`, succeeded: false };
    }
  }
}
