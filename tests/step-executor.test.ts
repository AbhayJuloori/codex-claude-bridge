import { afterEach, describe, expect, jest, test } from "@jest/globals";

import type { CodexAdapter } from "../src/adapters/base.js";
import type { InternalTask } from "../src/types/internal.js";
import { StepExecutor } from "../src/pipeline/step-executor.js";

describe("StepExecutor", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("returns failure when a step exceeds the 60 second timeout", async () => {
    jest.useFakeTimers();

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
        await new Promise(() => {});
      }
    };
    const baseTask = {
      requestId: "req-1",
      sessionId: "session-1",
      prompt: "base"
    } as InternalTask;

    const executor = new StepExecutor(adapter, baseTask);
    const resultPromise = executor.execute({
      id: "step-1",
      description: "Wait forever",
      prompt: "Do the thing",
      success_criteria: "Finish"
    });

    await jest.advanceTimersByTimeAsync(60_000);

    await expect(resultPromise).resolves.toEqual({
      step_id: "step-1",
      output: "Step timed out after 60s",
      status: "failure"
    });
  }, 10_000);
});
