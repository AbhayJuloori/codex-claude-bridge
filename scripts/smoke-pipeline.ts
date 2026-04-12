const BASE = process.env.BRIDGE_URL ?? "http://localhost:8787";
const TOKEN = process.env.BRIDGE_TOKEN ?? "codex-bridge-local";

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log("=== smoke: mechanical task ===");
  console.log(JSON.stringify(await post("/pipeline", {
    prompt: "rename the function calculateTotal to computeTotal in any TypeScript file"
  }), null, 2));

  console.log("\n=== smoke: multi-step task ===");
  console.log(JSON.stringify(await post("/pipeline", {
    prompt: "add a GET /health endpoint to the Express server and write a smoke test for it"
  }), null, 2));

  console.log("\n=== smoke: ambiguous task ===");
  console.log(JSON.stringify(await post("/pipeline", {
    prompt: "improve the code"
  }), null, 2));

  console.log("\nAll smoke tests completed.");
}

main().catch(err => { console.error(err); process.exit(1); });
