/**
 * Smoke tests for the HaikuClarifier / needs_user_input path.
 *
 * Test 4: Haiku CAN answer mid-execution question
 *   Task is clear enough to pass Haiku classification, but scoped so
 *   Codex might ask "which file?" — Haiku should answer from context.
 *
 * Test 5: Haiku CANNOT answer mid-execution question
 *   Task is clear at classification time but requires an external secret
 *   (API key / URL) that is not in the task — Haiku should escalate
 *   with needs_user_input.
 */

const BASE = process.env.BRIDGE_URL ?? "http://localhost:8787";
const TOKEN = process.env.BRIDGE_TOKEN ?? "codex-bridge-local";

function ssePost(path: string, body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    })
      .then((res) => {
        if (!res.ok || !res.body)
          return reject(new Error(`${res.status} ${res.statusText}`));
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        function pump(): void {
          reader
            .read()
            .then(({ done, value }) => {
              if (done) return resolve(chunks.join(""));
              chunks.push(decoder.decode(value));
              pump();
            })
            .catch(reject);
        }
        pump();
      })
      .catch(reject);
  });
}

function parseResult(raw: string): Record<string, unknown> | null {
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload) as Record<string, unknown>;
      if (obj.type === "result") return obj;
    } catch {}
  }
  return null;
}

async function runTest(label: string, task: string): Promise<void> {
  console.log(`\n=== ${label} ===`);
  console.log("task:", task);
  const raw = await ssePost("/delegatecodex", { task });
  const result = parseResult(raw);
  if (!result) {
    console.log("RAW SSE (no result event found):\n", raw);
    return;
  }
  console.log("status      :", result.status);
  console.log("steps_exec  :", result.steps_executed);
  console.log("sonnet_inv  :", result.sonnet_invocations);
  if (result.clarification_question) {
    console.log("clarification_question:", result.clarification_question);
  }
  if (result.output) {
    console.log("output (first 300):", String(result.output).slice(0, 300));
  }
}

async function main(): Promise<void> {
  // Test 4 — clear task, Codex might ask "which file?" but Haiku can answer
  // from the task context (answer: "create a new file at /tmp/").
  await runTest(
    "Test 4 – needs_user_input (Haiku should ANSWER from context)",
    "Create a new TypeScript file at /tmp/smoke-clarify-4.ts with a single exported function called greet(name: string): string that returns 'Hello, <name>!'"
  );

  // Test 5 — task clear at classification, but execution needs external info
  // Codex cannot proceed without the actual endpoint URL — Haiku can't infer it.
  await runTest(
    "Test 5 – needs_user_input (Haiku should ESCALATE — no URL in context)",
    "Update the HTTP client in src/adapters/codex-exec.ts to call the new internal logging endpoint by appending a POST request after each Codex execution — use the production endpoint URL from the team wiki"
  );

  console.log("\nAll clarifier smoke tests completed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
