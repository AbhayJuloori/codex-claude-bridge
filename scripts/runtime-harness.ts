import { loadConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { CompatibilityContextLoader } from "../src/config/compatibility-loader.js";
import { mapAnthropicRequestToTask } from "../src/services/message-mapper.js";
import { createAdapter } from "../src/adapters/index.js";
import type { AdapterEvent } from "../src/types/internal.js";

export function createRuntimeHarness() {
  process.env.CODEX_ADAPTER = process.env.CODEX_ADAPTER ?? "exec";
  const config = loadConfig();
  const logger = new Logger(config);
  const adapter = createAdapter(config, logger);
  const compatibilityContext = new CompatibilityContextLoader(config).load();

  return {
    config,
    logger,
    adapter,
    compatibilityContext
  };
}

export function createTask(requestId: string, prompt: string) {
  const harness = createRuntimeHarness();
  return {
    harness,
    task: mapAnthropicRequestToTask(
      {
        model: "bridge-test",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: prompt
          }
        ],
        stream: false
      },
      requestId,
      requestId,
      harness.compatibilityContext
    )
  };
}

export async function collectEvents(adapter: ReturnType<typeof createRuntimeHarness>["adapter"], task: ReturnType<typeof createTask>["task"]) {
  const events: AdapterEvent[] = [];
  for await (const event of adapter.execute(task)) {
    events.push(event);
  }
  return events;
}
