import { loadConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config);
  const adapter = new CodexAppServerAdapter(config, logger);
  const probe = await adapter.probe();

  console.log(JSON.stringify(probe, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
