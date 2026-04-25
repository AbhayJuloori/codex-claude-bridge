import { loadConfig } from "../src/config.js";
import { DiagnosticsService } from "../src/diagnostics/service.js";
import { Logger } from "../src/logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config);
  const diagnostics = new DiagnosticsService(config, logger);
  const report = await diagnostics.buildDiagnostics();

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
