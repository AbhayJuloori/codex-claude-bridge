import { describe, expect, jest, test } from "@jest/globals";
import { Dispatcher } from "../../src/delegatecodex/dispatcher.js";
import type { ClaudeSubprocessManager } from "../../src/claude/subprocess.js";

function makeMockClaude(response: string): ClaudeSubprocessManager {
  return {
    call: jest.fn<() => Promise<string>>().mockResolvedValue(response),
    stream: jest.fn(),
  } as unknown as ClaudeSubprocessManager;
}

const VALID_PLAN_JSON = JSON.stringify({
  brain: "codex_leads",
  mode: "implement",
  model_tier: "standard",
  reasoning_effort: "medium",
  plugins_hint: ["github"],
  session_mode: "stateless",
  write_policy: "workspace_write",
  claude_after: "judge_only",
  success_criteria: "TypeScript compiles without errors",
  architecture_notes: "Do not modify src/server.ts",
});

describe("Dispatcher", () => {
  test("returns ExecutionPlan from clean JSON response", async () => {
    const claude = makeMockClaude(VALID_PLAN_JSON);
    const dispatcher = new Dispatcher(claude);
    const plan = await dispatcher.dispatch("Add input validation to POST /users");
    expect(plan.brain).toBe("codex_leads");
    expect(plan.mode).toBe("implement");
    expect(plan.success_criteria).toBe("TypeScript compiles without errors");
  });

  test("strips markdown fences before parsing", async () => {
    const fenced = "```json\n" + VALID_PLAN_JSON + "\n```";
    const claude = makeMockClaude(fenced);
    const dispatcher = new Dispatcher(claude);
    const plan = await dispatcher.dispatch("some task");
    expect(plan.brain).toBe("codex_leads");
  });

  test("throws if Claude response is not valid JSON", async () => {
    const claude = makeMockClaude("Sorry, I cannot help with that.");
    const dispatcher = new Dispatcher(claude);
    await expect(dispatcher.dispatch("task")).rejects.toThrow(/parse/i);
  });

  test("throws if Claude response fails schema validation", async () => {
    const bad = JSON.stringify({ brain: "alien", mode: "implement" });
    const claude = makeMockClaude(bad);
    const dispatcher = new Dispatcher(claude);
    await expect(dispatcher.dispatch("task")).rejects.toThrow(/schema/i);
  });
});
