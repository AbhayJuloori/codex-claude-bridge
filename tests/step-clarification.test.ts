import { describe, expect, jest, test } from "@jest/globals";

import type { CodexAdapter } from "../src/adapters/base.js";
import type { ClarificationResult, HaikuClarifier } from "../src/pipeline/haiku-clarifier.js";
import type { InternalTask } from "../src/types/internal.js";
import { StepExecutor } from "../src/pipeline/step-executor.js";

describe("StepExecutor clarification loop", () => {
  const baseTask = {
    requestId: "req-1",
    sessionId: "session-1",
    prompt: "base"
  } as InternalTask;

  test("re-runs the step with Haiku's answer when Codex asks a question", async () => {
    const prompts: string[] = [];
    const adapter: CodexAdapter = {
      name: "test-adapter",
      async probe() {
        return {
          name: "test-adapter",
          available: true,
          authenticated: true,
          accountType: null,
          detail: "ok"
        };
      },
      async *execute(task) {
        prompts.push(task.prompt);

        if (prompts.length === 1) {
          yield { type: "completed", finalText: "Should I update src/a.ts or src/b.ts?" };
          return;
        }

        yield { type: "completed", finalText: "Updated src/a.ts." };
      }
    };

    const clarify = jest.fn<() => Promise<ClarificationResult>>();
    clarify.mockResolvedValueOnce({ type: "answered", answer: "Update src/a.ts." });
    clarify.mockResolvedValueOnce({ type: "not_question" });
    const clarifier: Pick<HaikuClarifier, "clarify"> = { clarify };

    const executor = new StepExecutor(adapter, baseTask, clarifier as HaikuClarifier);
    const result = await executor.execute({
      id: "step-1",
      description: "Update the file",
      prompt: "Apply the requested fix",
      success_criteria: "Finish"
    });

    expect(result).toEqual({
      step_id: "step-1",
      output: "Updated src/a.ts.",
      status: "success"
    });
    expect(clarify).toHaveBeenCalledWith(
      "Apply the requested fix",
      "Should I update src/a.ts or src/b.ts?"
    );
    expect(prompts[1]).toContain("Codex clarification (answer to your question):");
    expect(prompts[1]).toContain("Update src/a.ts.");
  });

  test("surfaces the question when Haiku cannot answer it", async () => {
    const adapter: CodexAdapter = {
      name: "test-adapter",
      async probe() {
        return {
          name: "test-adapter",
          available: true,
          authenticated: true,
          accountType: null,
          detail: "ok"
        };
      },
      async *execute() {
        yield { type: "completed", finalText: "Which production URL should I use?" };
      }
    };

    const clarify = jest.fn<() => Promise<ClarificationResult>>();
    clarify.mockResolvedValue({
      type: "needs_user",
      question: "Which production URL should I use?"
    });
    const clarifier: Pick<HaikuClarifier, "clarify"> = { clarify };

    const executor = new StepExecutor(adapter, baseTask, clarifier as HaikuClarifier);
    const result = await executor.execute({
      id: "step-1",
      description: "Ship the change",
      prompt: "Complete the deployment update",
      success_criteria: "Finish"
    });

    expect(result).toEqual({
      step_id: "step-1",
      output: "Which production URL should I use?",
      status: "needs_clarification"
    });
  });
});
