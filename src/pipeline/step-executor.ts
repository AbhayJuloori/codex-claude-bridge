import type { CodexAdapter } from "../adapters/base.js";
import type { InternalTask } from "../types/internal.js";
import type { StepSpec, StepExecutionResult } from "./types.js";
import type { HaikuClarifier } from "./haiku-clarifier.js";

const MAX_CLARIFICATIONS = 2;

export class StepExecutor {
  constructor(
    private readonly adapter: CodexAdapter,
    private readonly baseTask: InternalTask,
    private readonly clarifier?: HaikuClarifier
  ) {}

  async execute(step: StepSpec): Promise<StepExecutionResult> {
    let result = await this.runStep(step, step.prompt);
    if (!this.clarifier || result.status === "failure") {
      return result;
    }

    const clarificationAnswers: string[] = [];

    for (let round = 0; round < MAX_CLARIFICATIONS; round++) {
      const clarification = await this.clarifier.clarify(step.prompt, result.output);

      if (clarification.type === "not_question") {
        return result;
      }

      if (clarification.type === "needs_user") {
        return {
          step_id: step.id,
          output: clarification.question,
          status: "needs_clarification"
        };
      }

      clarificationAnswers.push(clarification.answer);
      result = await this.runStep(step, buildClarifiedPrompt(step.prompt, clarificationAnswers));

      if (result.status === "failure") {
        return result;
      }
    }

    return result;
  }

  private async runStep(step: StepSpec, prompt: string): Promise<StepExecutionResult> {
    const workerTask: InternalTask = {
      ...this.baseTask,
      prompt,
      inputItems: [{ type: "text", text: prompt }],
      messages: [{ role: "user", content: prompt }]
    };

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const stepExecution = (async (): Promise<StepExecutionResult> => {
        let finalText = "";

        for await (const event of this.adapter.execute(workerTask)) {
          if (event.type === "text-delta") finalText += event.text;
          if (event.type === "completed") finalText = event.finalText;
        }

        const trimmed = finalText.trim();
        return {
          step_id: step.id,
          output: trimmed,
          status: trimmed.length === 0 ? "empty" : "success"
        };
      })();

      const timeout = new Promise<StepExecutionResult>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            step_id: step.id,
            output: "Step timed out after 60s",
            status: "failure"
          });
        }, 60_000);
      });

      return await Promise.race([stepExecution, timeout]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { step_id: step.id, output: message, status: "failure" };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}

function buildClarifiedPrompt(originalPrompt: string, answers: string[]): string {
  const clarificationBlock = answers
    .map((answer) => `Codex clarification (answer to your question):\n${answer}`)
    .join("\n\n");

  return `${originalPrompt}\n\n${clarificationBlock}\n\nNow complete the original task with this information.`;
}
