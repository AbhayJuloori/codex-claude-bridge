import { loadConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { CodexExecAdapter } from "../src/adapters/codex-exec.js";
import { CompatibilityContextLoader } from "../src/config/compatibility-loader.js";
import { mapAnthropicRequestToTask } from "../src/services/message-mapper.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config);
  const adapter = new CodexExecAdapter(config, logger);
  const compatibilityLoader = new CompatibilityContextLoader(config);
  const probe = await adapter.probe();

  console.log("Probe:", JSON.stringify(probe, null, 2));

  const task = mapAnthropicRequestToTask(
    {
      model: "bridge-test",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: "Reply with exactly EXEC_BRIDGE_OK"
        }
      ],
      stream: false
    },
    "smoke-exec",
    "smoke-exec",
    compatibilityLoader.load()
  );

  for await (const event of adapter.execute(task)) {
    console.log(JSON.stringify(event, null, 2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
