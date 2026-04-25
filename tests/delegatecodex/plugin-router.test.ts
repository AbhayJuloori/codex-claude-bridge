import { describe, expect, test } from "@jest/globals";
import { getPluginHints } from "../../src/delegatecodex/plugin-router.js";
import type { ExecutionPlan } from "../../src/delegatecodex/types.js";

function plan(mode: ExecutionPlan["mode"], task = ""): ExecutionPlan {
  return {
    brain: "codex_leads",
    mode,
    model_tier: "standard",
    reasoning_effort: "medium",
    plugins_hint: [],
    session_mode: "stateless",
    subagent_strategy: "auto",
    write_policy: "workspace_write",
    claude_after: "judge_only",
    success_criteria: "done",
    allow_takeover: false,
  };
}

describe("getPluginHints", () => {
  test("ui_build returns browser-use and build-web-apps", () => {
    const hints = getPluginHints(plan("ui_build"), "build a dashboard");
    expect(hints).toContain("browser-use");
    expect(hints).toContain("build-web-apps");
  });

  test("ui_refine returns browser-use and build-web-apps", () => {
    const hints = getPluginHints(plan("ui_refine"), "polish button styles");
    expect(hints).toContain("browser-use");
  });

  test("task mentioning github adds github plugin", () => {
    const hints = getPluginHints(plan("implement"), "open a PR on github for this change");
    expect(hints).toContain("github");
  });

  test("debug with UI mention adds computer-use", () => {
    const hints = getPluginHints(plan("debug"), "the button click handler is broken in the UI");
    expect(hints).toContain("computer-use");
    expect(hints).toContain("browser-use");
  });

  test("review mode returns empty hints", () => {
    const hints = getPluginHints(plan("review"), "review the auth module");
    expect(hints).toEqual([]);
  });

  test("deduplicates hints", () => {
    const hints = getPluginHints(plan("ui_build"), "fix github CI for this UI build");
    const unique = new Set(hints);
    expect(unique.size).toBe(hints.length);
  });
});
