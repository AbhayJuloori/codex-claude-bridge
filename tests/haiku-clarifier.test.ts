import { describe, expect, jest, test } from "@jest/globals";

import type { ClaudeSubprocessManager } from "../src/claude/subprocess.js";
import { HaikuClarifier } from "../src/pipeline/haiku-clarifier.js";

describe("HaikuClarifier", () => {
  test("skips Claude when output does not look like a question", async () => {
    const call = jest.fn<() => Promise<string>>();
    const clarifier = new HaikuClarifier({ call } as unknown as ClaudeSubprocessManager);

    await expect(
      clarifier.clarify("Update the pipeline.", "Implemented the requested change.")
    ).resolves.toEqual({ type: "not_question" });

    expect(call).not.toHaveBeenCalled();
  });

  test("parses fenced JSON when user input is required", async () => {
    const call = jest.fn<() => Promise<string>>().mockResolvedValue(
      "```json\n{\"can_answer\": false, \"question\": \"Which base URL should I use?\"}\n```"
    );
    const clarifier = new HaikuClarifier({ call } as unknown as ClaudeSubprocessManager);

    await expect(
      clarifier.clarify("Use the URL from the task.", "Which base URL should I use?")
    ).resolves.toEqual({
      type: "needs_user",
      question: "Which base URL should I use?"
    });
  });
});
