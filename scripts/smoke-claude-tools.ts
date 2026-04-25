import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const baseUrl = process.env.BRIDGE_BASE_URL ?? "http://127.0.0.1:8787";
const token = process.env.BRIDGE_TOKEN ?? "codex-bridge-local";

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const cwd = process.cwd();
  const logDir = path.resolve(cwd, ".logs");
  const sessionsDir = path.resolve(cwd, ".state", "sessions");
  fs.mkdirSync(logDir, { recursive: true });
  const debugFile = path.join(logDir, "claude-tools-smoke-debug.log");

  const prompt = [
    "Use the available bridge-native tools to read package.json from the current repo.",
    "Do not guess.",
    "Reply with only the package name."
  ].join(" ");

  const child = spawn("claude", ["-p", prompt, "--debug-file", debugFile], {
    cwd,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: token
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

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

  assert.equal(exitCode, 0, `expected claude to exit 0, got ${exitCode}\n${stderr}`);
  assert.match(stdout.trim(), /^codex-claude-bridge$/);

  const recentEventFiles = fs
    .readdirSync(sessionsDir)
    .filter((name) => name.endsWith(".events.jsonl"))
    .map((name) => path.join(sessionsDir, name))
    .filter((filePath) => fs.statSync(filePath).mtimeMs >= startedAt - 1000);

  let toolCallCount = 0;
  for (const filePath of recentEventFiles) {
    const events = readJsonLines(filePath);
    toolCallCount += events.filter((event) => event.type === "request.tool_call").length;
  }

  assert.ok(toolCallCount >= 1, "expected at least one real tool round-trip in session events");

  console.log(`exitCode=${exitCode}`);
  console.log("stdout:");
  console.log(stdout.trim());
  console.log(`toolCallCount=${toolCallCount}`);
  console.log(`debugFile=${debugFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
