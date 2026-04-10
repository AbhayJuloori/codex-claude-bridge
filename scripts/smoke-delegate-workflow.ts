/**
 * Smoke test: POST /delegate with a minimal 1-task manifest.
 * Run with: CODEX_ADAPTER=exec npm run dev (in another terminal), then npx tsx scripts/smoke-delegate-workflow.ts
 */
import http from "node:http";

const BRIDGE_URL = "http://127.0.0.1:8787";

const manifest = {
  project: "smoke-test",
  tech_stack: { runtime: "node" },
  constraints: [],
  phases: [
    {
      id: "phase-1",
      name: "Smoke Phase",
      parallel: true,
      claude_gate: false,
      tasks: [
        {
          id: "t1",
          prompt: "Write hello world to a file called hello.txt using Node.js fs module",
          domain: ["backend"],
          acceptance: ["file created"],
          skills: []
        }
      ]
    }
  ],
  domain_flags: ["backend"],
  memory_path: ".delegate-smoke/context.md"
};

async function run(): Promise<void> {
  console.log("Smoke: POST /delegate");
  const body = JSON.stringify(manifest);
  const events: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      `${BRIDGE_URL}/delegate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: "Bearer codex-bridge-local"
        }
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Expected 200, got ${res.statusCode}`));
          return;
        }
        let buf = "";
        res.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data === "[DONE]") { resolve(); return; }
            events.push(data);
            try {
              const p = JSON.parse(data) as { type: string };
              console.log(`  [${p.type}]`, data.slice(0, 120));
            } catch { /* skip */ }
          }
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
    setTimeout(() => reject(new Error("Timeout 120s")), 120_000);
  });

  const hasPhaseStart = events.some((e) => e.includes("phase-start"));
  const hasDone = events.some((e) => e.includes("delegate-complete") || e.includes('"completed"'));
  if (!hasPhaseStart) { console.error("FAIL: no phase-start event"); process.exit(1); }
  if (!hasDone) { console.error("FAIL: no completion event"); process.exit(1); }
  console.log(`\nPASS: /delegate works — ${events.length} events`);
}

run().catch((err) => { console.error("FAIL:", err instanceof Error ? err.message : String(err)); process.exit(1); });
