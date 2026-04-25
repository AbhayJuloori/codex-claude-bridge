import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { CompatibilityContextLoader } from "../src/config/compatibility-loader.js";
import { mapAnthropicRequestToTask } from "../src/services/message-mapper.js";
import { BridgeToolExecutor } from "../src/tools/executor.js";
import { CodexExecAdapter } from "../src/adapters/codex-exec.js";
import { ToolLoopCodexAdapter } from "../src/tools/loop.js";
import type { AdapterEvent } from "../src/types/internal.js";

async function collectEvents(adapter: ToolLoopCodexAdapter, task: ReturnType<typeof mapAnthropicRequestToTask>) {
  const events: AdapterEvent[] = [];
  for await (const event of adapter.execute(task)) {
    events.push(event);
  }
  return events;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config);
  const compatibilityContext = new CompatibilityContextLoader(config).load();
  const baseTask = mapAnthropicRequestToTask(
    {
      model: "bridge-test",
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: "Run the bridge tool smoke tests."
        }
      ],
      stream: false
    },
    "smoke-tools",
    "smoke-tools",
    compatibilityContext
  );

  const executor = new BridgeToolExecutor(config, logger);
  const tempDir = path.join(config.codex.cwd, ".tmp", "tool-smoke");
  fs.mkdirSync(tempDir, { recursive: true });

  const pwdResult = await executor.execute(
    {
      type: "tool_call",
      id: "bash-pwd",
      tool: "bash",
      args: { command: "pwd" }
    },
    baseTask
  );
  assert.equal(pwdResult.ok, true);
  assert.equal((pwdResult.result as { exitCode: number }).exitCode, 0);

  const lsResult = await executor.execute(
    {
      type: "tool_call",
      id: "bash-ls",
      tool: "bash",
      args: { command: "ls" }
    },
    baseTask
  );
  assert.equal(lsResult.ok, true);
  assert.equal((lsResult.result as { exitCode: number }).exitCode, 0);

  const failingResult = await executor.execute(
    {
      type: "tool_call",
      id: "bash-fail",
      tool: "bash",
      args: { command: "ls definitely-missing-file" }
    },
    baseTask
  );
  assert.equal(failingResult.ok, true);
  assert.notEqual((failingResult.result as { exitCode: number }).exitCode, 0);

  const readExisting = await executor.execute(
    {
      type: "tool_call",
      id: "read-existing",
      tool: "read_file",
      args: { path: "src/index.ts" }
    },
    baseTask
  );
  assert.equal(readExisting.ok, true);
  assert.match(String((readExisting.result as { content: string }).content), /createServer/);

  const readMissing = await executor.execute(
    {
      type: "tool_call",
      id: "read-missing",
      tool: "read_file",
      args: { path: ".tmp/tool-smoke/missing.txt" }
    },
    baseTask
  );
  assert.equal(readMissing.ok, false);

  const writePath = path.join(".tmp", "tool-smoke", "write.txt");
  const writeCreate = await executor.execute(
    {
      type: "tool_call",
      id: "write-create",
      tool: "write_file",
      args: { path: writePath, content: "WRITE_ONE" }
    },
    baseTask
  );
  assert.equal(writeCreate.ok, true);
  assert.equal(fs.readFileSync(path.join(config.codex.cwd, writePath), "utf8"), "WRITE_ONE");

  const writeOverwrite = await executor.execute(
    {
      type: "tool_call",
      id: "write-overwrite",
      tool: "write_file",
      args: { path: writePath, content: "WRITE_TWO" }
    },
    baseTask
  );
  assert.equal(writeOverwrite.ok, true);
  assert.equal(fs.readFileSync(path.join(config.codex.cwd, writePath), "utf8"), "WRITE_TWO");

  const editSuccess = await executor.execute(
    {
      type: "tool_call",
      id: "edit-success",
      tool: "edit_file",
      args: { path: writePath, oldText: "WRITE_TWO", newText: "EDIT_DONE" }
    },
    baseTask
  );
  assert.equal(editSuccess.ok, true);
  assert.equal(fs.readFileSync(path.join(config.codex.cwd, writePath), "utf8"), "EDIT_DONE");

  const editMissing = await executor.execute(
    {
      type: "tool_call",
      id: "edit-missing",
      tool: "edit_file",
      args: { path: writePath, oldText: "NOT_PRESENT", newText: "NOPE" }
    },
    baseTask
  );
  assert.equal(editMissing.ok, false);

  const loopAdapter = new ToolLoopCodexAdapter(config, logger, new CodexExecAdapter(config, logger));
  const loopPath = path.join(".tmp", "tool-smoke", "loop.txt");
  const loopTask = mapAnthropicRequestToTask(
    {
      model: "bridge-test",
      max_tokens: 768,
      messages: [
        {
          role: "user",
          content: [
            "Using the bridge-native tools, and not by guessing, do all of the following in order:",
            "1. Read package.json and determine the package name.",
            "2. Run `pwd`.",
            `3. Write ${loopPath} with the exact text ROUNDTRIP_START.`,
            `4. Edit ${loopPath} replacing ROUNDTRIP_START with ROUNDTRIP_DONE.`,
            "5. Return a final answer in exactly this format:",
            "name=<package name>",
            "pwd=<absolute working directory>",
            "file=ROUNDTRIP_DONE",
            "You must actually use the tools before returning the final answer."
          ].join("\n")
        }
      ],
      stream: false
    },
    "smoke-tools-loop",
    "smoke-tools-loop",
    compatibilityContext
  );

  const loopEvents = await collectEvents(loopAdapter, loopTask);
  const toolCalls = loopEvents.filter((event) => event.type === "tool-call");
  const finalEvent = [...loopEvents]
    .reverse()
    .find(
      (event): event is Extract<AdapterEvent, { type: "completed" }> => event.type === "completed"
    );

  assert.ok(finalEvent, "expected final completed event from tool loop");
  assert.ok(toolCalls.length >= 3, "expected multiple real tool calls");
  assert.match(finalEvent.finalText, /name=codex-claude-bridge/);
  assert.match(finalEvent.finalText, /file=ROUNDTRIP_DONE/);
  assert.equal(fs.readFileSync(path.join(config.codex.cwd, loopPath), "utf8"), "ROUNDTRIP_DONE");

  console.log("BASH_TOOL_OK");
  console.log("READ_FILE_TOOL_OK");
  console.log("WRITE_FILE_TOOL_OK");
  console.log("EDIT_FILE_TOOL_OK");
  console.log("MULTI_STEP_TOOL_LOOP_OK");
  console.log(finalEvent.finalText);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
