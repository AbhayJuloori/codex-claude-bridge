import type { CodexAdapter } from "../adapters/base.js";
import type { InternalTask } from "../types/internal.js";
import type { StepSpec, StepExecutionResult } from "./types.js";

export class StepExecutor {
  constructor(
    private readonly adapter: CodexAdapter,
    private readonly baseTask: InternalTask
  ) {}

  async execute(step: StepSpec): Promise<StepExecutionResult> {
    const workerTask: InternalTask = {
      ...this.baseTask,
      prompt: step.prompt,
      inputItems: [{ type: "text", text: step.prompt }],
      messages: [{ role: "user", content: step.prompt }]
    };

    try {
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { step_id: step.id, output: message, status: "failure" };
    }
  }
}
