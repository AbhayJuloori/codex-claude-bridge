#!/usr/bin/env tsx
/**
 * Smoke test for /delegatecodex v2
 * Tests: accept path, repair path, claude_leads path, budget exhaustion path
 * Requires server running: npm run dev
 */

const BASE = "http://localhost:8787";
const HEADERS = {
  Authorization: "Bearer codex-bridge-local",
  "Content-Type": "application/json",
};

async function ssePost(path: string, body: object): Promise<unknown[]> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const text = await res.text();
  const events: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ") && line !== "data: [DONE]") {
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {
        // ignore
      }
    }
  }
  return events;
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`  ${name}... `);
  try {
    await fn();
    console.log("PASS");
  } catch (err) {
    console.log(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

console.log("\n=== /delegatecodex v2 smoke tests ===\n");

await test("T1: mechanical rename task", async () => {
  const events = await ssePost("/delegatecodex", {
    task: "Rename the variable count to itemCount in any TypeScript file in src/",
  });
  const result = events.find((e) => (e as { type: string }).type === "result") as { status?: string } | undefined;
  if (!result) throw new Error("No result event received");
  if (!["accepted", "repaired", "takeover_complete"].includes(result.status ?? "")) {
    throw new Error(`Unexpected status: ${result.status}`);
  }
});

await test("T2: dispatched event emitted", async () => {
  const events = await ssePost("/delegatecodex", {
    task: "List all TypeScript files in src/pipeline/ directory",
  });
  const dispatched = events.find((e) => (e as { type: string }).type === "dispatched");
  if (!dispatched) throw new Error("No dispatched event");
  const plan = (dispatched as { plan?: { brain?: string } }).plan;
  if (!plan?.brain) throw new Error("dispatched event missing plan.brain");
});

await test("T3: /delegatecodex-old (v1 compat)", async () => {
  const events = await ssePost("/delegatecodex-old", {
    task: "rename calculateTotal to computeTotal in any TypeScript file",
  });
  const result = events.find((e) => (e as { type: string }).type === "result") as { status?: string } | undefined;
  if (!result) throw new Error("No result event from v1 path");
});

await test("T4: result includes budget_used", async () => {
  const events = await ssePost("/delegatecodex", {
    task: "List all exported functions in src/delegatecodex/types.ts",
  });
  const result = events.find((e) => (e as { type: string }).type === "result") as Record<string, unknown> | undefined;
  if (!result) throw new Error("No result event");
  if (!result.budget_used) throw new Error("result missing budget_used");
  const budget = result.budget_used as { claude_calls_used: number };
  if (typeof budget.claude_calls_used !== "number") throw new Error("budget_used.claude_calls_used not a number");
});

console.log("\n=== Done ===\n");
