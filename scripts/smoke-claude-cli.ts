import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const baseUrl = process.env.BRIDGE_BASE_URL ?? "http://127.0.0.1:8787";
const token = process.env.BRIDGE_TOKEN ?? "codex-bridge-local";

async function main(): Promise<void> {
  const logDir = path.resolve(process.cwd(), ".logs");
  fs.mkdirSync(logDir, { recursive: true });
  const debugFile = path.join(logDir, "claude-smoke-debug.log");

  const child = spawn(
    "claude",
    ["-p", "Reply with exactly CLAUDE_PROXY_BRIDGE_OK", "--debug-file", debugFile],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: token
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });

  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const exitCode: number = await new Promise((resolve) => {
    child.once("close", resolve);
  });

  console.log(`exitCode=${exitCode}`);
  console.log("stdout:");
  console.log(stdout.trim());
  if (stderr.trim()) {
    console.log("stderr:");
    console.log(stderr.trim());
  }
  console.log(`debugFile=${debugFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
