import assert from "node:assert/strict";
import { createTask } from "./runtime-harness.js";
import { routeTask } from "../src/router/strategy-router.js";

// Fast-path cases: these are unambiguous enough to route without Claude.
const fastPathCases = [
  {
    name: "codex_review (fast-path)",
    prompt: "Review the code in src/server.ts for bugs, regressions, and missing tests.",
    expected: "codex_review"
  },
  {
    name: "codex_adversarial_review (fast-path)",
    prompt: "Do an adversarial review of src/server.ts and try to break assumptions or find hidden failure modes.",
    expected: "codex_adversarial_review"
  },
  {
    name: "codex_delegate (fast-path)",
    prompt: "Create a small utility file that exports a slugify helper.",
    expected: "codex_delegate"
  }
] as const;

// Ambiguous cases: in production these route through Claude.
// With null claude (smoke test), they use the conservative fallback.
// Expected values reflect fallback behavior, not ideal routing.
const ambiguousCases = [
  {
    name: "claude_direct (fallback)",
    prompt: "Think through the architecture tradeoffs for a local orchestration runtime and recommend the best design.",
    expected: "claude_direct"
  },
  {
    name: "codex_delegate (fallback from codex_then_claude_refine)",
    prompt: "Implement and polish a first-pass utility module, then refine the result for readability.",
    expected: "codex_delegate"
  },
  {
    name: "claude_direct (fallback from codex_review_then_claude_judgment)",
    prompt: "Review src/server.ts and give a merge or no-merge judgment after prioritizing the findings.",
    expected: "claude_direct"
  }
] as const;

async function run(): Promise<void> {
  console.log("--- Fast-path cases (no Claude required) ---");
  for (const testCase of fastPathCases) {
    const { task } = createTask(`router-${testCase.name}`, testCase.prompt);
    const decision = await routeTask(task, null);
    assert.equal(decision.mode, testCase.expected, `${testCase.name}: expected ${testCase.expected}, got ${decision.mode}`);
    console.log(`${testCase.name}=OK (${decision.rationale[0]})`);
  }

  console.log("\n--- Ambiguous cases (null claude → conservative fallback) ---");
  for (const testCase of ambiguousCases) {
    const { task } = createTask(`router-${testCase.name}`, testCase.prompt);
    const decision = await routeTask(task, null);
    assert.equal(decision.mode, testCase.expected, `${testCase.name}: expected ${testCase.expected}, got ${decision.mode}`);
    console.log(`${testCase.name}=OK (${decision.rationale[0]})`);
  }

  console.log("\nAll router smoke tests passed.");
  console.log("Note: ambiguous cases use fallback routing. In production, Claude subprocess routes these correctly.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
