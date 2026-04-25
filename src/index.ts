import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { createAdapter } from "./adapters/index.js";
import { createServer } from "./server.js";

const config = loadConfig();
const logger = new Logger(config);
const adapter = createAdapter(config, logger);
const app = createServer(config, logger, adapter);

app.listen(config.port, async () => {
  const probe = await adapter.probe();

  logger.info("startup", "codex-claude-bridge listening", {
    port: config.port,
    adapter: adapter.name,
    probe
  });
});
